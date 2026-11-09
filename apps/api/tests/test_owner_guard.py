"""Every route is either public or behind the owner guard, so later issues cannot forget it.

`audit(app)` looks at EVERY entry in `app.routes`: API routes, plain Starlette
routes, websocket routes and mounted sub-apps. Each is classified:

- public: its path is declared public in api.guard (`PUBLIC_*`);
- guarded: an API route that answers a no-session request with 401;
- a problem: anything else, including a mount or websocket that is not public
  (a mounted sub-app has its own routing and cannot be probed from here).

The control tests prove the audit can fail, and that it observes the real app.
"""

from collections.abc import Iterable, Iterator, Mapping, MutableMapping
from dataclasses import dataclass, field, replace
from typing import Any

from fastapi import Depends, FastAPI
from fastapi.routing import APIRoute
from fastapi.testclient import TestClient
from starlette.routing import Mount

from api.composition import build_container
from api.domain import User
from api.guard import is_public_path, require_owner
from api.main import create_app

# The owner endpoints of spec section 11, which later issues will build. When one
# is built it appears in app.routes and the audit covers it.
OWNER_ENDPOINTS = [
    "/stories",
    "/stories/{id}",
    "/stories/{id}/draft",
    "/stories/{id}/publish",
    "/stories/{id}/unpublish",
    "/stories/{id}/republish",
    "/stories/{id}/revert",
    "/images",
    "/images/{id}",
]
PUBLIC_ENDPOINTS = ["/public/pieces", "/public/pieces/{id}"]


@dataclass
class Audit:
    public: list[str] = field(default_factory=list)
    guarded: list[str] = field(default_factory=list)
    problems: list[str] = field(default_factory=list)


def concrete(path: str) -> str:
    return path.replace("{id}", "x").replace("{story_id}", "x").replace("{image_id}", "x")


def flatten(routes: Iterable[Any], prefix: str = "") -> Iterator[tuple[Any, str | None]]:
    """Every route with its full path. This FastAPI keeps an `include_router` as one
    `_IncludedRouter` entry in app.routes, so those are opened up; anything else
    with no path is yielded with None so the audit reports it rather than skips it."""
    for route in routes:
        inner = getattr(route, "original_router", None)
        if inner is not None:
            extra = getattr(getattr(route, "include_context", None), "prefix", "") or ""
            yield from flatten(inner.routes, prefix + extra)
            continue
        path = getattr(route, "path", None)
        yield route, (prefix + path if isinstance(path, str) else None)


def audit(app: FastAPI) -> Audit:
    client = TestClient(app, raise_server_exceptions=False)
    result = Audit()
    for route, path in flatten(app.routes):
        kind = type(route).__name__
        if path is None:
            result.problems.append(f"{kind} has no path to classify")
        elif is_public_path(path):
            result.public.append(path)
        elif isinstance(route, Mount):
            result.problems.append(f"mounted sub-app at {path} is not public: it cannot be guarded")
        elif not isinstance(route, APIRoute):
            result.problems.append(f"{kind} at {path} is neither public nor an API route")
        else:
            for method in sorted(route.methods - {"HEAD", "OPTIONS"}):
                status = client.request(method, concrete(path)).status_code
                if status == 401:
                    result.guarded.append(f"{method} {path}")
                else:
                    result.problems.append(f"{method} {path} answered {status}, not 401")
    return result


def test_the_audit_observes_the_real_app_and_finds_no_unguarded_route() -> None:
    result = audit(create_app(env={}))
    # Non-vacuous: it saw the routes that exist today.
    assert {"/health", "/version", "/auth/login", "/auth/callback", "/auth/me", "/auth/logout"} <= (
        set(result.public)
    )
    assert result.problems == []
    # The story endpoints, and the one owner route under the public /auth prefix, were
    # probed without a session and answered 401 (not skipped as "public").
    assert {
        "POST /stories",
        "GET /stories",
        "GET /stories/{story_id}",
        "PUT /stories/{story_id}/draft",
        "POST /stories/{story_id}/publish",
        "POST /auth/revoke-all",
    } <= set(result.guarded)
    assert "/auth/revoke-all" not in result.public


def test_an_owner_route_under_a_public_prefix_that_forgets_its_guard_fails_the_audit() -> None:
    # Control for the revoke-all arrangement: listed as owner-only, but unguarded -> a problem.
    app = FastAPI()

    @app.post("/auth/revoke-all")
    def unguarded() -> dict[str, str]:
        return {"revoked": "everything, for anyone"}

    assert audit(app).problems == ["POST /auth/revoke-all answered 200, not 401"]


def test_the_audit_also_passes_in_the_deployed_unconfigured_state() -> None:
    env = {"VERCEL_ENV": "production", "STORY_REPOSITORY": "memory"}
    result = audit(create_app(env=env))
    assert "/health" in result.public
    assert result.problems == []


def test_the_audit_reports_an_unguarded_write_path_and_counts_a_guarded_one() -> None:
    # Control: without this the audit could pass by looking at nothing.
    app = create_app(env={})

    @app.post("/notes")
    def forgot_the_guard() -> dict[str, str]:
        return {"created": "oops"}

    @app.put("/notes/{story_id}/draft", dependencies=[Depends(require_owner)])
    def remembered_the_guard(story_id: str) -> dict[str, str]:
        return {"saved": story_id}

    result = audit(app)
    assert result.problems == ["POST /notes answered 200, not 401"]
    assert "PUT /notes/{story_id}/draft" in result.guarded


def test_the_audit_fails_a_mounted_sub_app_and_a_websocket_unless_public() -> None:
    app = create_app(env={})
    app.mount("/admin", FastAPI())  # its own routing: not reachable by this audit
    app.mount("/public/static", FastAPI())  # explicitly public
    app.add_api_websocket_route("/ws/stories", lambda websocket: None)
    app.add_api_websocket_route("/public/ws", lambda websocket: None)

    problems = audit(app).problems
    assert any("mounted sub-app at /admin" in p for p in problems)
    assert any("/ws/stories" in p for p in problems)
    assert not any("/public/static" in p or "/public/ws" in p for p in problems)
    assert len(problems) == 2


def test_public_reads_and_auth_routes_are_declared_public_and_owner_endpoints_are_not() -> None:
    for path in PUBLIC_ENDPOINTS:
        assert is_public_path(path), path
    for path in ("/health", "/version", "/auth/login", "/auth/callback", "/auth/me"):
        assert is_public_path(path), path
    for path in OWNER_ENDPOINTS:
        assert not is_public_path(path), path
    assert not is_public_path("/authors")  # prefix match is on whole segments
    assert not is_public_path("/publicity")


def test_public_endpoints_answer_without_a_session() -> None:
    client = TestClient(create_app(env={}))
    assert client.get("/health").status_code == 200
    assert client.get("/version").status_code == 200
    assert client.get("/auth/me").status_code == 503  # no provider here; it did not ask for sign-in
    env = {"VERCEL_ENV": "production", "STORY_REPOSITORY": "memory"}
    assert TestClient(create_app(env=env)).get("/health").status_code == 200


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
        assert self.user is not None
        return self.user

    def sign_out(self, session: MutableMapping[str, Any]) -> None:
        session.clear()


def guarded_app(user: User | None) -> TestClient:
    container = replace(build_container({}), identity=FakeIdentity(user))
    app = create_app(container=container)
    state: dict[str, int] = {"writes": 0}

    @app.post("/notes", dependencies=[Depends(require_owner)])
    def create_story() -> dict[str, int]:
        state["writes"] += 1
        return state

    client = TestClient(app)
    if user is not None:
        client.get("/auth/callback")  # opens the server-side session the guard also requires
    return client


def test_no_session_is_401_and_changes_nothing() -> None:
    client = guarded_app(None)
    assert client.post("/notes").status_code == 401
    assert client.post("/notes").status_code == 401


def test_a_signed_in_user_who_is_not_the_owner_is_403_and_changes_nothing() -> None:
    client = guarded_app(User(id="u2", name="Editor", is_owner=False))
    assert client.post("/notes").status_code == 403


def test_the_owner_passes_the_guard() -> None:
    client = guarded_app(User(id="owner", name="Owner", is_owner=True))
    r = client.post("/notes")
    assert (r.status_code, r.json()) == (200, {"writes": 1})


def test_the_image_endpoints_and_the_local_upload_endpoint_are_probed_and_guarded() -> None:
    # The local upload endpoint exists only when development enables it, so the audit has to
    # be pointed at that configuration or it would never see the route.
    env = {"API_ENVIRONMENT": "development", "STORY_REPOSITORY": "memory"}
    result = audit(create_app(env=env))
    assert result.problems == []
    assert {
        "POST /images/upload-target",
        "POST /images",
        "GET /images/{image_id}",
        "PUT /images/uploads/{token}",
    } <= set(result.guarded)
    # The only image route that is public serves web versions, by key.
    assert "/public/images/{key}" in result.public
