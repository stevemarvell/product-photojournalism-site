"""Schema migrations, run with yoyo-migrations under a Postgres advisory lock.

Why yoyo: a small, maintained runner for plain SQL files with its own applied-migrations
table, transactional per migration, and psycopg 3 support, so no ORM or second driver is
needed (alembic would mean adding SQLAlchemy for tables we never map).

Why an advisory lock around it: on Vercel there is no shell and several instances can cold
start at once. They all call `migrate`; one holds the lock and applies, the rest wait and
then find nothing to do. It is a transaction-level lock (`pg_advisory_xact_lock`) held on
its own connection for the whole run, so it also behaves behind a transaction pooler such
as Neon's, where a session-level lock could be released on a different backend. yoyo's own
lock table is deliberately not used: a killed serverless instance would leave its row behind
and wedge every later start.

Nothing here logs or raises the connection string.
"""

import logging
from pathlib import Path

import psycopg
from yoyo import get_backend, read_migrations

log = logging.getLogger(__name__)

MIGRATIONS_DIR = Path(__file__).resolve().parent.parent / "migrations"
# Arbitrary constant naming "the schema migration" among this database's advisory locks.
ADVISORY_LOCK_KEY = 0x70686F746F6A  # "photoj"
LOCK_WAIT = "60s"
CONNECT_TIMEOUT_S = 10


def _yoyo_uri(database_url: str) -> str:
    # yoyo picks the driver from the scheme; psycopg 3 is "postgresql+psycopg".
    for prefix in ("postgresql://", "postgres://"):
        if database_url.startswith(prefix):
            return "postgresql+psycopg://" + database_url[len(prefix) :]
    return database_url


def migrate(database_url: str) -> None:
    """Bring the schema up to date. Safe to run repeatedly and concurrently."""
    migrations = read_migrations(str(MIGRATIONS_DIR))
    with (
        psycopg.connect(database_url, connect_timeout=CONNECT_TIMEOUT_S) as lock_conn,
        lock_conn.transaction(),
        lock_conn.cursor() as cur,
    ):
        cur.execute(f"set local lock_timeout = '{LOCK_WAIT}'")
        cur.execute("select pg_advisory_xact_lock(%s)", (ADVISORY_LOCK_KEY,))
        backend = get_backend(_yoyo_uri(database_url))
        try:
            pending = backend.to_apply(migrations)
            if pending:
                log.info("applying %d database migration(s)", len(pending))
                backend.apply_migrations(pending)
        finally:
            backend.connection.close()
