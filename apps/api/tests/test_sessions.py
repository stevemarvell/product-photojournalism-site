"""Server-side sessions: sign-out and revoke-all refuse a copied cookie (issue #13).

The proof that matters is a cookie copied out of one client and replayed from another:
a signed cookie that is still validly signed, checked against the stored record.
"""

from dataclasses import replace
from datetime import UTC, datetime, timedelta

from fastapi.testclient import TestClient

from api.adapters.memory import InMemorySessionStore
from api.application import SESSION_MAX_AGE, session_is_valid
from api.composition import Container, build_container
from api.main import create_app

ENV = {"IDENTITY_PROVIDER": "stub", "API_ENVIRONMENT": "development", "STORY_REPOSITORY": "memory"}


def new_client(container: Container) -> TestClient:
    return TestClient(create_app(container=container))


def sign_in(client: TestClient) -> None:
    assert client.get("/auth/callback", follow_redirects=False).status_code == 303


def copy_cookie(client: TestClient, to: TestClient) -> None:
    to.cookies.set("session", client.cookies["session"])


def owner_status(client: TestClient) -> int:
    return client.get("/stories").status_code


def test_signing_in_opens_a_session_and_the_owner_reaches_owner_endpoints() -> None:
    c = new_client(build_container(ENV))
    assert owner_status(c) == 401
    sign_in(c)
    assert owner_status(c) == 200
    assert c.get("/auth/me").json()["signedIn"] is True


def test_the_stub_provider_alone_is_not_enough_without_a_session_record() -> None:
    c = new_client(build_container(ENV))
    assert c.get("/auth/me").json() == {"signedIn": False, "user": None}


# --- Scenario: sign-out revokes the session server-side -------------------------


def test_after_sign_out_a_copied_cookie_no_longer_reaches_any_owner_endpoint() -> None:
    app = create_app(container=build_container(ENV))  # one app: one cookie-signing key
    owner, elsewhere = TestClient(app), TestClient(app)
    sign_in(owner)
    copy_cookie(owner, elsewhere)
    assert owner_status(elsewhere) == 200  # the copy genuinely works before sign-out

    assert owner.post("/auth/logout").status_code == 204

    assert owner_status(elsewhere) == 401
    assert elsewhere.post("/stories").status_code == 401
    assert elsewhere.get("/auth/me").json()["signedIn"] is False
    assert owner_status(owner) == 401


def test_signing_out_ends_only_that_session() -> None:
    container = build_container(ENV)
    a, b = new_client(container), new_client(container)
    sign_in(a)
    sign_in(b)
    a.post("/auth/logout")
    assert owner_status(a) == 401
    assert owner_status(b) == 200


# --- Scenario: revoke every session ----------------------------------------------


def test_revoke_all_refuses_every_existing_session_on_its_next_request() -> None:
    container = build_container(ENV)
    clients = [new_client(container) for _ in range(3)]
    for c in clients:
        sign_in(c)
    assert [owner_status(c) for c in clients] == [200, 200, 200]

    assert clients[0].post("/auth/revoke-all").status_code == 204

    assert [owner_status(c) for c in clients] == [401, 401, 401]


def test_a_fresh_sign_in_after_revoke_all_works() -> None:
    container = build_container(ENV)
    c = new_client(container)
    sign_in(c)
    c.post("/auth/revoke-all")
    assert owner_status(c) == 401
    sign_in(c)
    assert owner_status(c) == 200


def test_revoke_all_needs_the_owner() -> None:
    container = build_container(ENV)
    c = new_client(container)
    assert c.post("/auth/revoke-all").status_code == 401
    assert c.get("/auth/revoke-all").status_code == 405
    # ...and with no sign-in configured at all it is still 401, not 503.
    assert TestClient(create_app(env={})).post("/auth/revoke-all").status_code == 401


def test_a_cookie_carrying_an_older_epoch_than_the_stored_one_is_refused() -> None:
    # Isolates the epoch comparison from the record check: the record exists.
    store = InMemorySessionStore()
    store.revoke_all("owner")  # epoch is now 1
    record = store.create("owner")
    assert session_is_valid(store, "owner", record.id, record.epoch) is True
    assert session_is_valid(store, "owner", record.id, record.epoch - 1) is False
    assert session_is_valid(store, "someone-else", record.id, record.epoch) is False


def test_revoke_all_also_deletes_the_users_records() -> None:
    store = InMemorySessionStore()
    a, b = store.create("owner"), store.create("owner")
    other = store.create("other")
    store.revoke_all("owner")
    assert store.get(a.id) is None and store.get(b.id) is None
    assert store.get(other.id) is not None


def test_a_session_record_expires_after_the_session_max_age() -> None:
    clock = [datetime(2026, 11, 9, 12, 0, tzinfo=UTC)]
    store = InMemorySessionStore(now=lambda: clock[0])
    record = store.create("owner")
    clock[0] += timedelta(seconds=SESSION_MAX_AGE - 1)
    assert store.get(record.id) is not None
    clock[0] += timedelta(seconds=1)
    assert store.get(record.id) is None
    assert store._sessions == {}  # dropped, not just hidden


def test_an_expired_record_refuses_the_still_signed_cookie() -> None:
    clock = [datetime(2026, 11, 9, 12, 0, tzinfo=UTC)]
    store = InMemorySessionStore(now=lambda: clock[0])
    c = new_client(replace(build_container(ENV), sessions=store))
    sign_in(c)
    assert owner_status(c) == 200
    clock[0] += timedelta(seconds=SESSION_MAX_AGE)
    assert owner_status(c) == 401


def test_a_validly_signed_cookie_whose_session_record_is_gone_is_refused() -> None:
    container = build_container(ENV)
    c = new_client(container)
    sign_in(c)
    (session_id,) = list(container.sessions._sessions)  # type: ignore[attr-defined]
    assert owner_status(c) == 200
    container.sessions.delete(session_id)  # the cookie's signature is untouched
    assert owner_status(c) == 401
