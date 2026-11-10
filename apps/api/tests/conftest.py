"""Shared fixtures for the tests that need a real Postgres.

They run only when TEST_DATABASE_URL names a throwaway database (its tables are dropped
and recreated). Without it they skip with the reason below on a developer's machine, but
FAIL when CI is set: CI gets its Postgres from the `services` declaration on this app in
project.json, and a skip there would let a green verify hide an unexercised adapter.
"""

import os

import psycopg
import pytest

from api.adapters.migrate import migrate

TEST_DATABASE_URL = os.environ.get("TEST_DATABASE_URL")
SKIP_REASON = "no TEST_DATABASE_URL (set it to a throwaway Postgres to run these)"
MISSING_IN_CI = (
    "TEST_DATABASE_URL is not set but CI is: the Postgres tests must run in CI, not skip. "
    'The api app in project.json needs `"services": ["postgres"]`, which makes verify.yml '
    "start a Postgres and export TEST_DATABASE_URL."
)
needs_postgres = pytest.mark.needs_postgres


def missing_database_outcome(url: str | None, ci: str | None) -> str | None:
    """What a Postgres test does: None to run, else "skip" (locally) or "fail" (in CI)."""
    if url:
        return None
    return "fail" if ci and ci.strip().lower() not in ("0", "false") else "skip"


def pytest_configure(config: pytest.Config) -> None:
    config.addinivalue_line("markers", "needs_postgres: needs TEST_DATABASE_URL")


def pytest_runtest_setup(item: pytest.Item) -> None:
    if item.get_closest_marker("needs_postgres") is None:
        return
    outcome = missing_database_outcome(os.environ.get("TEST_DATABASE_URL"), os.environ.get("CI"))
    if outcome == "fail":
        pytest.fail(MISSING_IN_CI, pytrace=False)
    if outcome == "skip":
        pytest.skip(SKIP_REASON)


OUR_TABLES = "story, session, session_epoch, _yoyo_migration, _yoyo_log, _yoyo_version, yoyo_lock"


def reset_database(url: str) -> None:
    with psycopg.connect(url, autocommit=True) as conn:
        conn.execute(f"drop table if exists {OUR_TABLES} cascade")


@pytest.fixture
def pg_url() -> str:
    """A freshly migrated, empty database."""
    url = os.environ.get("TEST_DATABASE_URL")
    assert url
    reset_database(url)
    migrate(url)
    return url
