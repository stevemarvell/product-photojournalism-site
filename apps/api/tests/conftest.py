"""Shared fixtures for the tests that need a real Postgres.

They run only when TEST_DATABASE_URL names a throwaway database (its tables are dropped
and recreated); CI has no Postgres service yet, so there they skip, with the reason below.
"""

import os

import psycopg
import pytest

from api.adapters.migrate import migrate

TEST_DATABASE_URL = os.environ.get("TEST_DATABASE_URL")
SKIP_REASON = "no TEST_DATABASE_URL (CI has no Postgres service yet)"
needs_postgres = pytest.mark.skipif(not TEST_DATABASE_URL, reason=SKIP_REASON)

OUR_TABLES = "story, session, session_epoch, _yoyo_migration, _yoyo_log, _yoyo_version, yoyo_lock"


def reset_database(url: str) -> None:
    with psycopg.connect(url, autocommit=True) as conn:
        conn.execute(f"drop table if exists {OUR_TABLES} cascade")


@pytest.fixture
def pg_url() -> str:
    """A freshly migrated, empty database."""
    assert TEST_DATABASE_URL
    reset_database(TEST_DATABASE_URL)
    migrate(TEST_DATABASE_URL)
    return TEST_DATABASE_URL
