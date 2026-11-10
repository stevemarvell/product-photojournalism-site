"""One contract for every SessionStore adapter, memory and Postgres (TEST_DATABASE_URL)."""

from datetime import UTC, datetime, timedelta

import pytest

from api.adapters.memory import InMemorySessionStore
from api.adapters.postgres import PostgresDatabase, PostgresSessionStore
from api.application import SessionStore
from conftest import needs_postgres

T0 = datetime(2026, 11, 9, 12, 0, tzinfo=UTC)
MAX_AGE = timedelta(hours=12)


class Clock:
    def __init__(self) -> None:
        self.t = T0

    def __call__(self) -> datetime:
        return self.t


@pytest.fixture(
    params=[
        pytest.param("memory", id="memory"),
        pytest.param("postgres", id="postgres", marks=needs_postgres),
    ]
)
def make(request: pytest.FixtureRequest):
    """A factory of stores that share one backing (memory: one object; postgres: one database,
    so two stores are two serverless instances)."""
    clock = Clock()
    if request.param == "memory":
        store = InMemorySessionStore(MAX_AGE, clock)
        return clock, lambda: store
    db = PostgresDatabase(request.getfixturevalue("pg_url"))
    return clock, lambda: PostgresSessionStore(db, MAX_AGE, clock)


def test_a_created_session_is_read_back_at_epoch_zero(make) -> None:
    _, new = make
    store: SessionStore = new()
    rec = store.create("owner")
    assert rec.user_id == "owner" and rec.epoch == 0
    assert store.get(rec.id) == rec
    assert store.get("nonsense") is None


def test_delete_removes_only_that_session(make) -> None:
    _, new = make
    store = new()
    a, b = store.create("owner"), store.create("owner")
    store.delete(a.id)
    assert store.get(a.id) is None and store.get(b.id) == b
    store.delete(a.id)  # deleting again is harmless


def test_revoke_all_deletes_the_users_sessions_and_bumps_the_epoch(make) -> None:
    _, new = make
    store = new()
    a, other = store.create("owner"), store.create("someone")
    store.revoke_all("owner")
    assert store.get(a.id) is None
    assert store.get(other.id) == other  # another user's session is untouched
    assert store.create("owner").epoch == 1
    store.revoke_all("owner")
    assert store.create("owner").epoch == 2


def test_a_session_expires_by_created_at(make) -> None:
    clock, new = make
    store = new()
    rec = store.create("owner")
    clock.t = T0 + MAX_AGE - timedelta(seconds=1)
    assert store.get(rec.id) == rec
    clock.t = T0 + MAX_AGE
    assert store.get(rec.id) is None
    assert store.get(rec.id) is None


def test_sign_out_and_revoke_all_on_one_instance_are_seen_by_another(make) -> None:
    _, new = make
    one, two = new(), new()
    a, b = one.create("owner"), one.create("owner")
    assert two.get(a.id) == a
    two.delete(a.id)
    assert one.get(a.id) is None  # sign-out on "two" refused on "one"
    one.revoke_all("owner")
    assert two.get(b.id) is None
    assert two.create("owner").epoch == 1
