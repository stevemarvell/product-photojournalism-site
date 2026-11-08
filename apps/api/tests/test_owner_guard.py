"""Every route is either public or behind the owner guard, so later issues cannot forget it.

`unguarded_routes` is the enumeration. It lists routes that are not public by
declaration (api.guard.PUBLIC_*) and do not answer 401 to a visitor with no
session. The control test proves it can fail: add an unguarded write path and
it is reported.
"""

from collections.abc import Mapping, MutableMapping
from typing import Any

from fastapi import Depends, FastAPI
from fastapi.routing import APIRoute
from fastapi.testclient import TestClient

from api.domain import User
from api.guard import is_public_path, require_owner
from api.main import create_app

# The owner endpoints of spec section 11, which later issues will build. When one
# is built it appears in app.routes and the enumeration covers it; until then
# this list says what the enumeration is for.
OWNER_ENDPOINTS = [
    ("GET", "/stories"),
    ("POST", "/stories"),
    ("GET", "/stories/{id}"),
    ("PUT", "/stories/{id}/draft"),
    ("POST", "/stories/{id}/publish"),
    ("POST", "/stories/{id}/unpublish"),
    ("POST", "/stories/{id}/republish"),
    ("POST", "/stories/{id}/revert"),
    ("POST", "/images"),
    ("GET", "/images/{id}"),
]
PUBLIC_ENDPOINTS = [("GET", "/public/stories"), ("GET", "/public/stories/{id}")]


def concrete(path: str) -> str:
    return path.replace("{id}", "x").replace("{story_id}", "x").replace("{image_id}", "x")


def unguarded_routes(app: FastAPI) -> list[str]:
    """Every non-public route that answers a no-session request with anything but 401."""
    client = TestClient(app, raise_server_exceptions=False)
    bad: list[str] = []
    for route in app.routes:
        if not isinstance(route, APIRoute) or is_public_path(route.path):
            continue
        for method in sorted(route.methods - {"HEAD", "OPTIONS"}):
            status = client.request(method, concrete(route.path)).status_code
            if status != 401:
                bad.append(f"{method} {route.path} -> {status}")
    return bad


def test_every_non_public_route_answers_401_without_a_session() -> None:
    assert unguarded_routes(create_app(env={})) == []


def test_every_non_public_route_also_answers_401_when_sign_in_is_not_configured() -> None:
    app = create_app(env={"VERCEL_ENV": "production", "STORY_REPOSITORY": "memory"})
    assert unguarded_routes(app) == []


def test_the_enumeration_can_fail_an_unguarded_write_path_is_reported() -> None:
    # Control: without this the test above could pass by looking at nothing.
    app = create_app(env={})

    @app.post("/stories")
    def forgot_the_guard() -> dict[str, str]:
        return {"created": "oops"}

    @app.put("/stories/{story_id}/draft", dependencies=[Depends(require_owner)])
    def remembered_the_guard(story_id: str) -> dict[str, str]:
        return {"saved": story_id}

    assert unguarded_routes(app) == ["POST /stories -> 200"]


def test_public_reads_and_auth_routes_are_declared_public_and_owner_endpoints_are_not() -> None:
    for _, path in PUBLIC_ENDPOINTS:
        assert is_public_path(path), path
    for path in ("/health", "/version", "/auth/login", "/auth/callback", "/auth/me"):
        assert is_public_path(path), path
    for _, path in OWNER_ENDPOINTS:
        assert not is_public_path(path), path


def test_public_endpoints_answer_without_a_session() -> None:
    client = TestClient(create_app(env={}))
    assert client.get("/health").status_code == 200
    assert client.get("/version").status_code == 200
    me = client.get("/auth/me")
    assert me.status_code == 503  # no provider here; and not a request for sign-in
    env = {"VERCEL_ENV": "production", "STORY_REPOSITORY": "memory"}
    deployed = TestClient(create_app(env=env))
    assert deployed.get("/health").status_code == 200


class FakeIdentity:
    """A fake IdentityProvider whose signed-in user a test chooses."""

    def __init__(self, user: User | None) -> None:
        self.user = user

    def sign_in_available(self) -> bool:
        return True

    def current_user(self, session: MutableMapping[str, Any]) -> User | None:
        return self.user

    def begin_sign_in(self, session: MutableMapping[str, Any], redirect_uri: str) -> str:
        return "/"

    def complete_sign_in(
        self, session: MutableMapping[str, Any], redirect_uri: str, params: Mapping[str, str]
    ) -> User:
        raise NotImplementedError

    def sign_out(self, session: MutableMapping[str, Any]) -> None:
        session.clear()


def guarded_app(user: User | None) -> TestClient:
    from dataclasses import replace

    from api.composition import build_container

    container = replace(build_container({}), identity=FakeIdentity(user))
    app = create_app(container=container)
    state: dict[str, int] = {"writes": 0}

    @app.post("/stories", dependencies=[Depends(require_owner)])
    def create_story() -> dict[str, int]:
        state["writes"] += 1
        return state

    return TestClient(app)


def test_no_session_is_401_and_changes_nothing() -> None:
    client = guarded_app(None)
    assert client.post("/stories").status_code == 401
    assert client.post("/stories").status_code == 401


def test_a_signed_in_user_who_is_not_the_owner_is_403_and_changes_nothing() -> None:
    client = guarded_app(User(id="u2", name="Editor", is_owner=False))
    assert client.post("/stories").status_code == 403


def test_the_owner_passes_the_guard() -> None:
    client = guarded_app(User(id="owner", name="Owner", is_owner=True))
    r = client.post("/stories")
    assert (r.status_code, r.json()) == (200, {"writes": 1})
