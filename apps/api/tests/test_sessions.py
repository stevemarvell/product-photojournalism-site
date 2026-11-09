"""Server-side sessions: sign-out and revoke-all refuse a copied cookie (issue #13).

The proof that matters is a cookie copied out of one client and replayed from another:
a signed cookie that is still validly signed, checked against the stored record.
"""

from dataclasses import replace

from fastapi.testclient import TestClient

from api.adapters.memory import InMemorySessionStore
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


def test_bumping_the_stored_epoch_alone_refuses_a_session_whose_record_still_exists() -> None:
    # Isolates the epoch check from the record check: the record is not deleted here.
    store = InMemorySessionStore()
    container = replace(build_container(ENV), sessions=store)
    c = new_client(container)
    sign_in(c)
    (session_id,) = list(store._sessions)  # the one record
    store.revoke_all("owner")
    assert store.get(session_id) is not None  # still stored...
    assert owner_status(c) == 401  # ...but its epoch no longer matches the cookie's


def test_a_validly_signed_cookie_whose_session_record_is_gone_is_refused() -> None:
    container = build_container(ENV)
    c = new_client(container)
    sign_in(c)
    (session_id,) = list(container.sessions._sessions)  # type: ignore[attr-defined]
    assert owner_status(c) == 200
    container.sessions.delete(session_id)  # the cookie's signature is untouched
    assert owner_status(c) == 401
