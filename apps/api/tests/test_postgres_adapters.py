"""Postgres-only behaviour: migrations, the publish transaction, the compare-and-set under
real concurrency, and failure handling. Needs TEST_DATABASE_URL (skipped locally with the
reason, a failure in CI, without it) except the tests that need no database at all."""

import logging
import threading
from dataclasses import replace
from datetime import UTC, datetime, timedelta

import psycopg
import pytest

from api.adapters.migrate import migrate
from api.adapters.postgres import PostgresDatabase, PostgresSessionStore, PostgresStoryRepository
from api.domain import (
    DraftFields,
    StorageUnavailableError,
    StoryConflictError,
    new_story,
    published,
    with_draft,
)
from conftest import needs_postgres, reset_database

T0 = datetime(2026, 11, 9, 12, 0, tzinfo=UTC)
DEAD = "postgresql://photo:s3cret-pw@127.0.0.1:1/photos"


def _tables(url: str) -> set[str]:
    with psycopg.connect(url) as conn:
        rows = conn.execute(
            "select table_name from information_schema.tables where table_schema = 'public'"
        ).fetchall()
    return {r[0] for r in rows}


def _applied(url: str) -> list[str]:
    with psycopg.connect(url) as conn:
        return [r[0] for r in conn.execute("select migration_id from _yoyo_migration").fetchall()]


@needs_postgres
def test_migrations_create_the_tables_and_a_second_run_changes_nothing(pg_url: str) -> None:
    assert {"story", "session", "session_epoch"} <= _tables(pg_url)
    before = (_tables(pg_url), _applied(pg_url))
    migrate(pg_url)
    assert (_tables(pg_url), _applied(pg_url)) == before
    assert len(before[1]) == 1


@needs_postgres
def test_migrations_converge_on_a_database_that_has_the_tables_but_no_record(pg_url: str) -> None:
    with psycopg.connect(pg_url, autocommit=True) as conn:
        conn.execute("drop table _yoyo_migration, _yoyo_log, _yoyo_version cascade")
    migrate(pg_url)  # the if-not-exists statements make the re-run harmless
    assert len(_applied(pg_url)) == 1


@needs_postgres
def test_concurrent_cold_starts_migrate_once_under_the_lock(pg_url: str) -> None:
    reset_database(pg_url)
    errors: list[BaseException] = []
    barrier = threading.Barrier(6)

    def start() -> None:
        try:
            barrier.wait()
            migrate(pg_url)
        except BaseException as exc:  # noqa: BLE001
            errors.append(exc)

    threads = [threading.Thread(target=start) for _ in range(6)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert errors == []
    assert len(_applied(pg_url)) == 1


@needs_postgres
def test_the_advisory_lock_really_blocks_a_second_migration(pg_url: str) -> None:
    # Control for the test above: hold the lock by hand and watch migrate wait for it.
    from api.adapters.migrate import ADVISORY_LOCK_KEY

    done = threading.Event()
    with psycopg.connect(pg_url) as holder:
        holder.execute("select pg_advisory_xact_lock(%s)", (ADVISORY_LOCK_KEY,))
        t = threading.Thread(target=lambda: (migrate(pg_url), done.set()))
        t.start()
        assert not done.wait(1.5)  # blocked while the lock is held
        holder.rollback()  # releases it
        assert done.wait(10)
    t.join()


@needs_postgres
def test_the_repository_migrates_before_its_first_query(pg_url: str) -> None:
    reset_database(pg_url)  # no tables at all
    repo = PostgresStoryRepository(pg_url)
    assert repo.list("org-a") == []
    assert "story" in _tables(pg_url)


@needs_postgres
def test_publish_is_one_write_a_failure_part_way_changes_neither_text_nor_live(
    pg_url: str,
) -> None:
    repo = PostgresStoryRepository(pg_url)
    s = new_story("s1", "org-a", T0)
    repo.create(s)
    drafted = with_draft(
        s, DraftFields(title="T", description="D", content="body"), T0 + timedelta(minutes=1)
    )
    repo.replace("org-a", drafted, expected_updated_at=s.updated_at)

    # Publishes the draft text and flips live, but breaks the table's rule that a live story
    # was published: the statement fails after the SET list was computed, part-way.
    broken = published(drafted, T0 + timedelta(minutes=2))
    broken = replace(broken, first_published_at=None)
    with pytest.raises(psycopg.errors.CheckViolation):
        repo.replace("org-a", broken, expected_updated_at=drafted.updated_at)
    stored = repo.get("org-a", "s1")
    assert stored == drafted
    assert stored is not None and not stored.live and stored.published_title == ""

    ok = published(drafted, T0 + timedelta(minutes=2))
    repo.replace("org-a", ok, expected_updated_at=drafted.updated_at)
    assert repo.get("org-a", "s1") == ok


@needs_postgres
def test_two_concurrent_saves_from_the_same_base_exactly_one_wins(pg_url: str) -> None:
    repo = PostgresStoryRepository(pg_url)
    s = new_story("s1", "org-a", T0)
    repo.create(s)
    outcomes: list[str] = []
    barrier = threading.Barrier(8)

    def save(n: int) -> None:
        mine = with_draft(s, DraftFields(title=f"tab {n}"), T0 + timedelta(minutes=1, seconds=n))
        barrier.wait()
        try:
            repo.replace("org-a", mine, expected_updated_at=s.updated_at)
            outcomes.append("won")
        except StoryConflictError:
            outcomes.append("conflict")

    threads = [threading.Thread(target=save, args=(n,)) for n in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert sorted(outcomes) == ["conflict"] * 7 + ["won"]


@needs_postgres
def test_a_migration_that_fails_fails_closed_logs_no_secret_and_is_retried(
    pg_url: str, caplog: pytest.LogCaptureFixture
) -> None:
    calls: list[int] = []

    def failing(url: str) -> None:
        calls.append(1)
        raise RuntimeError(f"boom {url}")

    db = PostgresDatabase(pg_url, run_migrations=failing)
    repo = PostgresStoryRepository(db)
    with caplog.at_level(logging.DEBUG), pytest.raises(StorageUnavailableError):
        repo.list("org-a")
    with pytest.raises(StorageUnavailableError):
        repo.get("org-a", "x")
    assert len(calls) == 2  # not cached as done: the next request tries again
    assert db.ping() is False
    assert "database migration failed" in caplog.text
    with pytest.raises(StorageUnavailableError) as info:
        repo.list("org-a")
    assert info.value.__cause__ is None and info.value.__context__ is None
    assert pg_url not in caplog.text and "boom" not in caplog.text


def test_an_unreachable_database_is_storage_unavailable_and_leaks_nothing(
    caplog: pytest.LogCaptureFixture,
) -> None:
    repo = PostgresStoryRepository(DEAD)
    with caplog.at_level(logging.DEBUG), pytest.raises(StorageUnavailableError) as info:
        repo.list("org-a")
    assert "s3cret-pw" not in str(info.value) and "s3cret-pw" not in caplog.text
    with pytest.raises(StorageUnavailableError):
        PostgresSessionStore(DEAD).get("x")
    assert repo.ping() is False


@needs_postgres
def test_a_database_that_goes_away_after_migrating_is_storage_unavailable(pg_url: str) -> None:
    db = PostgresDatabase(pg_url)
    db.ensure_migrated()
    gone = pg_url.rsplit(":", 1)[0] + ":1/" + pg_url.rsplit("/", 1)[1]
    broken = PostgresDatabase(gone, run_migrations=lambda url: None)
    with pytest.raises(StorageUnavailableError):
        PostgresStoryRepository(broken).list("org-a")


@needs_postgres
def test_a_password_with_special_characters_survives_migration(pg_url: str) -> None:
    # yoyo parses the URL itself; the lock connection hands psycopg the raw one.
    with psycopg.connect(pg_url, autocommit=True) as conn:
        conn.execute("drop role if exists pwtest")
        conn.execute("create role pwtest login password 'p@ss/w:rd#1' superuser")
    host_part = pg_url.split("@", 1)[1] if "@" in pg_url else pg_url.split("://", 1)[1]
    url = "postgresql://pwtest:p%40ss%2Fw%3Ard%231@" + host_part
    reset_database(pg_url)
    migrate(url)
    assert "story" in _tables(pg_url)
    reset_database(pg_url)  # the role owns the tables until they are dropped
    with psycopg.connect(pg_url, autocommit=True) as conn:
        conn.execute("drop role pwtest")


@needs_postgres
def test_two_app_instances_on_one_database_share_stories_and_revocation(pg_url: str) -> None:
    from fastapi.testclient import TestClient

    from api.composition import build_container
    from api.main import create_app

    env = {
        "STORY_REPOSITORY": "postgres",
        "DATABASE_URL": pg_url,
        "IDENTITY_PROVIDER": "stub",
        "API_ENVIRONMENT": "development",
    }

    # Two instances: separate containers and apps, one database, one cookie-signing secret.
    def instance() -> TestClient:
        container = replace(build_container(env), session_secret="s" * 40)
        return TestClient(create_app(container=container))

    a, b = instance(), instance()
    assert a.get("/public/pieces").json() == []  # 200 [] on an empty, freshly migrated database
    assert a.get("/auth/callback", follow_redirects=False).status_code == 303
    b.cookies.set("session", a.cookies["session"])  # the same signed cookie, other instance
    assert b.get("/stories").status_code == 200
    created = a.post("/stories").json()
    assert [s["id"] for s in b.get("/stories").json()] == [created["id"]]

    assert a.post("/auth/revoke-all").status_code in (200, 204)
    assert b.get("/stories").status_code == 401  # refused on the other instance's next request


def test_a_malformed_database_url_is_storage_unavailable_and_leaks_no_password(
    caplog: pytest.LogCaptureFixture,
) -> None:
    db = PostgresDatabase("postgresql://u:hunter2pw@[bad", run_migrations=lambda url: None)
    with caplog.at_level(logging.DEBUG), pytest.raises(StorageUnavailableError) as info:
        PostgresStoryRepository(db).list("org-a")
    assert "hunter2pw" not in caplog.text and "hunter2pw" not in str(info.value)
    exc: BaseException | None = info.value
    while exc is not None:  # the whole chain, cause and context
        assert "hunter2pw" not in repr(exc) + str(exc)
        exc = exc.__cause__ or exc.__context__


@needs_postgres
def test_a_statement_timeout_is_not_an_outage_it_propagates_and_logs_the_type_only(
    pg_url: str, caplog: pytest.LogCaptureFixture
) -> None:
    sep = "&" if "?" in pg_url else "?"
    slow = PostgresDatabase(pg_url + sep + "options=-c%20statement_timeout%3D50")
    repo = PostgresStoryRepository(slow)
    repo.list("org-a")  # migrates and works at this timeout
    with (
        caplog.at_level(logging.DEBUG),
        pytest.raises(psycopg.errors.QueryCanceled),
        slow.connection() as conn,
    ):
        conn.execute("select pg_sleep(2)")
    assert "database error (QueryCanceled)" in caplog.text
    assert "pg_sleep" not in caplog.text and "statement" not in caplog.text.replace(
        "database error (QueryCanceled)", ""
    )


@needs_postgres
def test_a_connection_class_error_mid_statement_is_storage_unavailable(pg_url: str) -> None:
    db = PostgresDatabase(pg_url)
    with pytest.raises(StorageUnavailableError), db.connection() as conn:
        pid = conn.execute("select pg_backend_pid()").fetchone()[0]
        with psycopg.connect(pg_url, autocommit=True) as admin:
            admin.execute("select pg_terminate_backend(%s)", (pid,))
        conn.execute("select 1")


def test_list_live_sql_selects_public_columns_only_for_live_rows_in_order() -> None:
    seen: list[tuple[str, tuple]] = []

    class Conn:
        def execute(self, sql: str, params: tuple = ()):  # noqa: ANN202
            seen.append((" ".join(sql.split()), params))
            return self

        def fetchall(self) -> list:
            return []

    class Db:
        def connection(self):  # noqa: ANN202
            from contextlib import nullcontext

            return nullcontext(Conn())

    assert PostgresStoryRepository(Db()).list_live("org-a") == []  # type: ignore[arg-type]
    assert seen == [
        (
            "select id, organisation_id, first_published_at, last_published_at, "
            "published_title, published_description, published_location, published_date, "
            "published_content from story where organisation_id = %s and live "
            "order by first_published_at desc, id desc",
            ("org-a",),
        )
    ]
