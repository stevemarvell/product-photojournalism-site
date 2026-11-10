"""Postgres adapters: the story repository and the session store.

Both share a `PostgresDatabase`, which opens a short-lived connection per operation (right
for serverless, and for a pooled Neon URL) and makes sure the schema is migrated before the
first query of the process. If the migration fails nothing is queried: the operation raises
StorageUnavailableError (the API answers 503), the failure is logged without any detail that
could carry the connection string, and the next operation tries the migration again.

StorageUnavailableError means exactly one thing here: the database could not be reached or
prepared. Anything else (a constraint violation, a bug) is an ordinary exception.
"""

import logging
import secrets
import threading
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta

import psycopg
from psycopg import errors as pg_errors

from api.adapters.migrate import migrate
from api.application.sessions import SESSION_MAX_AGE
from api.domain import (
    SessionRecord,
    StorageUnavailableError,
    Story,
    StoryConflictError,
    StoryNotFoundError,
)

log = logging.getLogger(__name__)

TIMEOUT_S = 2
CONNECT_TIMEOUT_S = 5
UNAVAILABLE = "story storage is not available"


class PostgresDatabase:
    def __init__(self, database_url: str, run_migrations: Callable[[str], None] = migrate) -> None:
        self._database_url = database_url
        self._run_migrations = run_migrations
        self._migrated = False
        self._lock = threading.Lock()

    def ensure_migrated(self) -> None:
        """Migrate once per process, before the first query. Raises StorageUnavailableError."""
        if self._migrated:
            return
        with self._lock:
            if self._migrated:
                return
            failure: str | None = None
            try:
                self._run_migrations(self._database_url)
            except Exception as exc:
                failure = type(exc).__name__  # its text can contain the connection string
            if failure is not None:
                # Raised outside the except block: the original is not in __context__ either.
                log.error("database migration failed (%s); refusing to serve", failure)
                raise StorageUnavailableError(UNAVAILABLE)
            self._migrated = True

    @contextmanager
    def connection(self) -> Iterator[psycopg.Connection]:
        """A connection inside a transaction (committed on success, rolled back on error)."""
        self.ensure_migrated()
        try:
            conn = psycopg.connect(self._database_url, connect_timeout=CONNECT_TIMEOUT_S)
        except (psycopg.Error, ValueError, TypeError) as exc:
            # A refused connection, or a URL libpq cannot parse. The text can hold the
            # password, so only the type is logged.
            failure = type(exc).__name__
        else:
            failure = None
        if failure is not None:
            # Raised outside the except block, so the original (and its text) is not even
            # in this exception's __context__.
            log.error("database connection failed (%s)", failure)
            raise StorageUnavailableError(UNAVAILABLE)
        lost: str | None = None
        try:
            try:
                with conn:
                    yield conn
            except psycopg.Error as exc:
                if not (isinstance(exc, psycopg.errors.ConnectionException) or conn.broken):
                    # Anything else (QueryCanceled, LockNotAvailable, DeadlockDetected, a
                    # constraint) is not an outage: it propagates as an ordinary 500.
                    log.error("database error (%s)", type(exc).__name__)
                    raise
                lost = type(exc).__name__  # SQLSTATE class 08, or the connection died
            if lost is not None:
                log.error("database connection lost (%s)", lost)
                raise StorageUnavailableError(UNAVAILABLE)
        finally:
            conn.close()

    def ping(self) -> bool:
        # Any failure is just "unreachable": the exception text can contain the
        # connection string, so it is neither returned nor logged. A database whose
        # migration fails is not healthy either.
        try:
            self.ensure_migrated()
            with (
                psycopg.connect(self._database_url, connect_timeout=TIMEOUT_S) as conn,
                conn.cursor() as cur,
            ):
                cur.execute("select 1")
                return cur.fetchone() == (1,)
        except Exception:
            return False


_STORY_COLUMNS = (
    "id, organisation_id, live, first_published_at, last_published_at, "
    "draft_title, draft_description, draft_location, draft_date, draft_content, "
    "published_title, published_description, published_location, published_date, "
    "published_content, created_at, updated_at, last_saved_by, previous_updated_at, "
    "last_saved_seq"
)
_COLUMN_NAMES = [c.strip() for c in _STORY_COLUMNS.split(",")]
_SET_CLAUSE = ", ".join(
    f"{c} = %({c})s" for c in _COLUMN_NAMES if c not in ("id", "organisation_id")
)


def _row_to_story(row: tuple) -> Story:
    return Story(*row)


def _story_params(story: Story) -> dict[str, object]:
    return {c: getattr(story, c) for c in _COLUMN_NAMES}


class PostgresStoryRepository:
    def __init__(self, database: "PostgresDatabase | str") -> None:
        self._db = PostgresDatabase(database) if isinstance(database, str) else database

    def ping(self) -> bool:
        return self._db.ping()

    def create(self, story: Story) -> None:
        placeholders = ", ".join(f"%({c})s" for c in _COLUMN_NAMES)
        with self._db.connection() as conn:
            try:
                conn.execute(
                    f"insert into story ({_STORY_COLUMNS}) values ({placeholders})",
                    _story_params(story),
                )
            except pg_errors.UniqueViolation:
                raise ValueError(f"story {story.id} already exists") from None

    def get(self, organisation_id: str, story_id: str) -> Story | None:
        with self._db.connection() as conn:
            row = conn.execute(
                f"select {_STORY_COLUMNS} from story where organisation_id = %s and id = %s",
                (organisation_id, story_id),
            ).fetchone()
        return _row_to_story(row) if row else None

    def list(self, organisation_id: str) -> list[Story]:
        with self._db.connection() as conn:
            rows = conn.execute(
                f"select {_STORY_COLUMNS} from story where organisation_id = %s",
                (organisation_id,),
            ).fetchall()
        return [_row_to_story(r) for r in rows]

    def replace(
        self,
        organisation_id: str,
        story: Story,
        expected_updated_at: datetime,
        client_id: str | None = None,
        seq: int | None = None,
    ) -> Story:
        if story.organisation_id != organisation_id:
            raise StoryNotFoundError(story.id)
        # One conditional UPDATE: the compare and the write cannot be separated by another
        # writer. The row is written (published columns, `live` and all) or not at all.
        sql = f"""
            update story set {_SET_CLAUSE}
            where id = %(id)s and organisation_id = %(organisation_id)s
              and (
                updated_at = %(expected)s
                or (
                  %(client)s::text is not null
                  and last_saved_by = %(client)s::text
                  and previous_updated_at = %(expected)s
                  and %(seq)s::bigint is not null
                  and last_saved_seq is not null
                  and %(seq)s::bigint > last_saved_seq
                )
              )
        """
        params = _story_params(story) | {
            "expected": expected_updated_at,
            "client": client_id,
            "seq": seq,
        }
        with self._db.connection() as conn:
            if conn.execute(sql, params).rowcount == 1:
                return story
            # Nothing changed. Say why (read only): no such story, or it moved on.
            exists = conn.execute(
                "select 1 from story where organisation_id = %s and id = %s",
                (organisation_id, story.id),
            ).fetchone()
        if exists is None:
            raise StoryNotFoundError(story.id)
        raise StoryConflictError(story.id)


class PostgresSessionStore:
    def __init__(
        self,
        database: "PostgresDatabase | str",
        max_age: timedelta = timedelta(seconds=SESSION_MAX_AGE),
        now: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        self._db = PostgresDatabase(database) if isinstance(database, str) else database
        self._max_age = max_age
        self._now = now

    def create(self, user_id: str) -> SessionRecord:
        session_id = secrets.token_urlsafe(32)
        now = self._now()
        with self._db.connection() as conn:
            # Sweep what has expired, so the table does not grow without bound.
            conn.execute("delete from session where created_at <= %s", (now - self._max_age,))
            # The epoch is read in the same statement as the insert. A revoke-all landing
            # after it leaves this record at a stale epoch, which the cookie then fails.
            row = conn.execute(
                """
                insert into session (id, user_id, created_at) values (%(id)s, %(user)s, %(now)s)
                returning coalesce(
                    (select epoch from session_epoch where user_id = %(user)s), 0)
                """,
                {"id": session_id, "user": user_id, "now": now},
            ).fetchone()
        assert row is not None
        return SessionRecord(session_id, user_id, row[0])

    def get(self, session_id: str) -> SessionRecord | None:
        with self._db.connection() as conn:
            row = conn.execute(
                """
                select s.user_id, s.created_at,
                       coalesce((select epoch from session_epoch where user_id = s.user_id), 0)
                from session s where s.id = %s
                """,
                (session_id,),
            ).fetchone()
            if row is None:
                return None
            user_id, created_at, epoch = row
            if self._now() - created_at >= self._max_age:
                conn.execute("delete from session where id = %s", (session_id,))
                return None
        return SessionRecord(session_id, user_id, epoch)

    def delete(self, session_id: str) -> None:
        with self._db.connection() as conn:
            conn.execute("delete from session where id = %s", (session_id,))

    def revoke_all(self, user_id: str) -> None:
        with self._db.connection() as conn:  # one transaction: the bump and the deletes
            conn.execute(
                """
                insert into session_epoch (user_id, epoch) values (%s, 1)
                on conflict (user_id) do update set epoch = session_epoch.epoch + 1
                """,
                (user_id,),
            )
            conn.execute("delete from session where user_id = %s", (user_id,))
