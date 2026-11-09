"""Scenarios of issue #12 against Sign in with Vercel, with Vercel's side faked.

The fake is an httpx.MockTransport standing in for vercel.com and api.vercel.com:
no network is touched. It answers the way Vercel's documented endpoints do, and
it records what it was asked so the PKCE and client-secret handling is checked
against what was actually sent, not against the code under test.
"""

import base64
import hashlib
import json
import time
from collections.abc import Callable
from dataclasses import replace
from typing import Annotated
from urllib.parse import parse_qs, urlparse

import httpx
import pytest
from fastapi import Depends
from fastapi.testclient import TestClient

from api.adapters import stub_identity, vercel_identity
from api.adapters.no_identity import NoIdentityProvider
from api.adapters.vercel_identity import (
    AUTHORIZE_URL,
    TOKEN_URL,
    USERINFO_URL,
    VercelIdentityProvider,
)
from api.application import SignInRefusedError
from api.composition import build_container
from api.domain import OWNER, User
from api.guard import require_owner
from api.main import create_app

OWNER_SUB = "345e869043f1e55f8bdc837c"
OTHER_SUB = "999999999999999999999999"
SECRET = "s" * 40
ORIGIN = "https://photojournalism-site-stevemarvell-team.vercel.app"
CALLBACK = f"{ORIGIN}/api/auth/callback"
CONFIG = {
    "VERCEL_ENV": "production",
    "STORY_REPOSITORY": "memory",
    "VERCEL_OAUTH_CLIENT_ID": "oac_test",
    "VERCEL_OAUTH_CLIENT_SECRET": "client-secret-value",
    "OWNER_VERCEL_ID": OWNER_SUB,
    "SESSION_SECRET": SECRET,
}


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


class FakeVercel:
    """Answers the token and userinfo endpoints for whichever `sub` it is told to."""

    def __init__(self, sub: str = OWNER_SUB, token_status: int = 200) -> None:
        self.sub = sub
        self.token_status = token_status
        self.requests: list[httpx.Request] = []
        self.nonce = ""  # set by the test from the authorize URL it was redirected to

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        url = str(request.url).split("?")[0]
        if url == TOKEN_URL and request.method == "POST":
            if self.token_status != 200:
                return httpx.Response(self.token_status, json={"error": "invalid_grant"})
            claims = b64url(json.dumps({"sub": self.sub, "nonce": self.nonce}).encode())
            return httpx.Response(
                200,
                json={
                    "access_token": "at-123",
                    "token_type": "Bearer",
                    "id_token": f"e30.{claims}.sig",
                    "expires_in": 3600,
                },
            )
        if url == USERINFO_URL and request.headers.get("authorization") == "Bearer at-123":
            return httpx.Response(200, json={"sub": self.sub, "name": "Timmy Triangle"})
        return httpx.Response(404)

    def token_form(self) -> dict[str, str]:
        (req,) = [r for r in self.requests if str(r.url) == TOKEN_URL]
        return {k: v[0] for k, v in parse_qs(req.content.decode()).items()}


def make_client(
    fake: FakeVercel, env: dict[str, str] | None = None, clock: Callable[[], float] = time.time
) -> TestClient:
    container = build_container({**CONFIG, **(env or {})})
    assert isinstance(container.identity, VercelIdentityProvider)
    provider = VercelIdentityProvider(
        client_id=CONFIG["VERCEL_OAUTH_CLIENT_ID"],
        client_secret=CONFIG["VERCEL_OAUTH_CLIENT_SECRET"],
        owner_vercel_id=(env or {}).get("OWNER_VERCEL_ID", OWNER_SUB),
        session_secret=(env or {}).get("SESSION_SECRET", SECRET),
        http=httpx.Client(transport=httpx.MockTransport(fake)),
        clock=clock,
    )
    app = create_app(container=replace(container, identity=provider))

    @app.get("/probe-owner-only")
    def probe(user: Annotated[User, Depends(require_owner)]) -> dict[str, str]:
        return {"user": user.id, "organisation": user.organisation_id}

    return TestClient(app, base_url="https://testserver", follow_redirects=False)


def start_login(client: TestClient, fake: FakeVercel) -> dict[str, str]:
    r = client.get("/auth/login")
    assert r.status_code == 303
    assert r.headers["location"].startswith(AUTHORIZE_URL + "?")
    query = {k: v[0] for k, v in parse_qs(urlparse(r.headers["location"]).query).items()}
    fake.nonce = query["nonce"]
    return query


def complete(client: TestClient, query: dict[str, str], **override: str) -> httpx.Response:
    params = {"code": "auth-code", "state": query["state"], **override}
    return client.get("/auth/callback", params=params)


def signed_in(client: TestClient) -> bool:
    return bool(client.get("/auth/me").json()["signedIn"])


# --- Scenario: owner signs in -------------------------------------------------


def test_owner_signs_in_and_is_mapped_to_the_seeded_user_row() -> None:
    fake = FakeVercel()
    client = make_client(fake)
    query = start_login(client, fake)

    assert query["client_id"] == "oac_test"
    assert query["redirect_uri"] == CALLBACK
    assert query["response_type"] == "code"
    assert query["code_challenge_method"] == "S256"
    assert "openid" in query["scope"].split()

    r = complete(client, query)
    assert (r.status_code, r.headers["location"]) == (303, "/editor")
    assert client.get("/auth/me").json() == {
        "signedIn": True,
        "user": {"name": "Owner", "isOwner": True},
    }
    # The seeded row, with its organisation, is what the guard hands to routes.
    assert client.get("/probe-owner-only").json() == {"user": "owner", "organisation": "owner-org"}


def test_the_code_exchange_proves_pkce_and_carries_the_client_secret() -> None:
    fake = FakeVercel()
    client = make_client(fake)
    query = start_login(client, fake)
    complete(client, query)

    form = fake.token_form()
    assert form["grant_type"] == "authorization_code"
    assert form["code"] == "auth-code"
    assert form["redirect_uri"] == CALLBACK
    assert form["client_id"] == "oac_test"
    assert form["client_secret"] == "client-secret-value"
    # The verifier sent to the token endpoint must hash to the challenge sent
    # to the authorize endpoint: checked here with hashlib, independently.
    digest = hashlib.sha256(form["code_verifier"].encode()).digest()
    assert b64url(digest) == query["code_challenge"]


def test_the_session_cookie_is_httponly_secure_and_samesite_lax() -> None:
    client = make_client(FakeVercel())
    login_cookie = client.get("/auth/login").headers["set-cookie"].lower()
    assert "httponly" in login_cookie
    assert "secure" in login_cookie
    assert "samesite=lax" in login_cookie
    assert "client-secret-value" not in login_cookie


# --- Scenario: another Vercel account is refused -----------------------------


def test_another_vercel_account_gets_no_session_and_no_editor_access() -> None:
    fake = FakeVercel(sub=OTHER_SUB)
    client = make_client(fake)
    r = complete(client, start_login(client, fake))
    assert (r.status_code, r.headers["location"]) == (303, "/?signin=refused")
    assert not signed_in(client)
    assert client.get("/probe-owner-only").status_code == 401


def test_a_session_signed_in_as_someone_else_stops_working_if_the_owner_id_changes() -> None:
    fake = FakeVercel()
    client = make_client(fake)
    complete(client, start_login(client, fake))
    assert signed_in(client)
    # Same cookie jar, app rebuilt with a different owner.
    other = make_client(fake, {"OWNER_VERCEL_ID": OTHER_SUB})
    other.cookies.update(client.cookies)
    assert not signed_in(other)
    assert other.get("/probe-owner-only").status_code == 401


# --- The callback is refused when it does not belong to a sign-in we started --


def test_a_callback_with_the_wrong_state_is_refused_before_anything_is_exchanged() -> None:
    fake = FakeVercel()
    client = make_client(fake)
    query = start_login(client, fake)
    r = complete(client, query, state="not-the-state")
    assert r.headers["location"] == "/?signin=refused"
    assert not signed_in(client)
    assert fake.requests == []  # the code was never sent to Vercel


def test_a_callback_without_a_sign_in_in_progress_is_refused() -> None:
    fake = FakeVercel()
    client = make_client(fake)
    r = client.get("/auth/callback", params={"code": "x", "state": "y"})
    assert r.headers["location"] == "/?signin=refused"
    assert not signed_in(client)
    assert fake.requests == []


def test_a_callback_cannot_be_replayed() -> None:
    fake = FakeVercel()
    client = make_client(fake)
    query = start_login(client, fake)
    assert complete(client, query).headers["location"] == "/editor"
    client.post("/auth/logout")
    assert complete(client, query).headers["location"] == "/?signin=refused"
    assert not signed_in(client)


def test_a_callback_whose_id_token_nonce_differs_is_refused() -> None:
    fake = FakeVercel()
    client = make_client(fake)
    query = start_login(client, fake)
    fake.nonce = "a-different-nonce"
    assert complete(client, query).headers["location"] == "/?signin=refused"
    assert not signed_in(client)


def test_vercel_refusing_the_exchange_or_the_user_denying_consent_signs_nobody_in() -> None:
    fake = FakeVercel(token_status=400)
    client = make_client(fake)
    assert complete(client, start_login(client, fake)).headers["location"] == "/?signin=refused"
    assert not signed_in(client)

    client = make_client(FakeVercel())
    query = start_login(client, fake)
    r = client.get("/auth/callback", params={"error": "access_denied", "state": query["state"]})
    assert r.headers["location"] == "/?signin=refused"
    assert not signed_in(client)


def test_a_forged_session_cookie_is_signed_out() -> None:
    fake = FakeVercel()
    client = make_client(fake)
    payload = b64url(json.dumps({"vercel_sub": OWNER_SUB}).encode())
    client.cookies.set("session", f"{payload}.forged.signature")
    assert not signed_in(client)
    assert client.get("/probe-owner-only").status_code == 401


# --- Scenario: sign out -------------------------------------------------------


def test_signing_out_ends_the_session_and_the_editor_is_unreachable_again() -> None:
    fake = FakeVercel()
    client = make_client(fake)
    complete(client, start_login(client, fake))
    assert client.get("/probe-owner-only").status_code == 200

    assert client.post("/auth/logout").status_code == 204
    assert not signed_in(client)
    assert client.get("/probe-owner-only").status_code == 401


def test_a_copied_vercel_session_cookie_is_dead_once_the_owner_signs_out() -> None:
    fake = FakeVercel()
    client = make_client(fake)
    complete(client, start_login(client, fake))
    copy = TestClient(client.app, base_url="https://testserver")
    copy.cookies.set("session", client.cookies["session"])
    assert copy.get("/probe-owner-only").status_code == 200

    client.post("/auth/logout")

    assert copy.get("/probe-owner-only").status_code == 401
    assert not signed_in(copy)


def test_the_vercel_cookie_alone_is_not_a_session_without_the_stored_record() -> None:
    fake = FakeVercel()
    client = make_client(fake)
    complete(client, start_login(client, fake))
    client.app.state.container.sessions.revoke_all("owner")
    assert client.get("/probe-owner-only").status_code == 401


# --- Sign-in not configured: the site stays up --------------------------------


@pytest.mark.parametrize(
    "missing",
    ["VERCEL_OAUTH_CLIENT_ID", "VERCEL_OAUTH_CLIENT_SECRET", "OWNER_VERCEL_ID", "SESSION_SECRET"],
)
def test_missing_settings_leave_the_site_up_with_auth_503_and_owner_routes_401(
    missing: str,
) -> None:
    env = {k: v for k, v in CONFIG.items() if k != missing}
    app = create_app(env=env)

    @app.get("/probe-owner-only")
    def probe(user: Annotated[User, Depends(require_owner)]) -> dict[str, str]:
        return {"user": user.id}

    client = TestClient(app, follow_redirects=False)
    assert client.get("/health").status_code == 200
    for path in ("/auth/login", "/auth/callback", "/auth/me"):
        r = client.get(path)
        assert (r.status_code, r.json()["detail"]) == (503, "sign-in not configured"), path
    assert client.post("/auth/logout").status_code == 503
    assert client.get("/probe-owner-only").status_code == 401


def test_a_short_session_secret_counts_as_missing() -> None:
    c = build_container({**CONFIG, "SESSION_SECRET": "short"})
    assert isinstance(c.identity, NoIdentityProvider)
    assert c.session_secret is None


# --- Selection ----------------------------------------------------------------


def test_deployed_defaults_to_vercel_and_local_defaults_to_none() -> None:
    assert isinstance(build_container(CONFIG).identity, VercelIdentityProvider)
    assert build_container(CONFIG).session_secret == SECRET
    preview = build_container({"VERCEL_ENV": "preview", "STORY_REPOSITORY": "memory"})
    assert preview.identity_name == "vercel (not configured)"
    assert build_container({}).identity_name == "none"


def test_explicit_none_wins_over_the_deployed_default() -> None:
    c = build_container({**CONFIG, "IDENTITY_PROVIDER": "none"})
    assert isinstance(c.identity, NoIdentityProvider)


def test_starting_another_sign_in_does_not_log_the_owner_out() -> None:
    fake = FakeVercel()
    client = make_client(fake)
    complete(client, start_login(client, fake))
    assert signed_in(client)
    client.get("/auth/login")  # e.g. a cross-site <img src=/api/auth/login>
    assert signed_in(client)
    assert client.get("/probe-owner-only").status_code == 200


def test_a_refused_callback_does_not_log_the_owner_out_either() -> None:
    fake = FakeVercel()
    client = make_client(fake)
    complete(client, start_login(client, fake))
    query = start_login(client, fake)
    assert complete(client, query, state="wrong").headers["location"] == "/?signin=refused"
    assert signed_in(client)


def test_every_auth_response_is_no_store() -> None:
    fake = FakeVercel()
    client = make_client(fake)
    unconfigured = TestClient(
        create_app(env={"VERCEL_ENV": "production", "STORY_REPOSITORY": "memory"})
    )
    responses = [
        client.get("/auth/login"),
        client.get("/auth/callback", params={"code": "x", "state": "y"}),  # refused redirect
        client.get("/auth/me"),
        client.post("/auth/logout"),
        client.get("/auth/nonexistent"),  # a 404 under /auth/
        unconfigured.get("/auth/login"),  # a 503
        unconfigured.get("/auth/me"),
    ]
    for r in responses:
        assert r.headers.get("cache-control") == "no-store", (r.request.url, r.status_code)
    assert client.get("/health").headers.get("cache-control") != "no-store"


def test_the_cookie_does_not_expose_the_pkce_verifier_nonce_or_state() -> None:
    fake = FakeVercel()
    client = make_client(fake)
    login = client.get("/auth/login")
    cookie = login.headers["set-cookie"].split(";")[0].split("=", 1)[1].strip('"')
    query = {k: v[0] for k, v in parse_qs(urlparse(login.headers["location"]).query).items()}
    fake.nonce = query["nonce"]
    complete(client, query)
    verifier = fake.token_form()["code_verifier"]  # learnt only from the token request

    # The session payload is the cookie's first dot-separated part, base64 JSON.
    first = cookie.split(".")[0]
    payload = base64.b64decode(first + "=" * (-len(first) % 4)).decode()
    assert "oauth_pending" in payload  # it is there, sealed
    for secret in (verifier, query["nonce"], query["state"]):
        raw = secret.encode()
        for form in (
            secret,
            base64.b64encode(raw).decode().rstrip("="),
            base64.urlsafe_b64encode(raw).decode().rstrip("="),
        ):
            assert form not in cookie, secret
            assert form not in payload, secret


def test_a_pending_sign_in_older_than_ten_minutes_is_refused() -> None:
    now = [1_000_000.0]
    fake = FakeVercel()
    client = make_client(fake, clock=lambda: now[0])
    query = start_login(client, fake)
    now[0] += 601
    assert complete(client, query).headers["location"] == "/?signin=refused"
    assert not signed_in(client)
    assert fake.requests == []


def test_a_pending_sign_in_inside_ten_minutes_still_completes() -> None:
    now = [1_000_000.0]
    fake = FakeVercel()
    client = make_client(fake, clock=lambda: now[0])
    query = start_login(client, fake)
    now[0] += 590
    assert complete(client, query).headers["location"] == "/editor"


def test_a_pending_entry_sealed_under_another_key_is_refused() -> None:
    def provider(secret: str) -> VercelIdentityProvider:
        return VercelIdentityProvider(
            client_id="c",
            client_secret="s",
            owner_vercel_id=OWNER_SUB,
            session_secret=secret,
            http=httpx.Client(transport=httpx.MockTransport(FakeVercel())),
        )

    session: dict[str, object] = {}
    url = provider("a" * 40).begin_sign_in(session, CALLBACK)
    state = parse_qs(urlparse(url).query)["state"][0]
    with pytest.raises(SignInRefusedError):
        provider("b" * 40).complete_sign_in(session, CALLBACK, {"code": "x", "state": state})


def test_a_non_ascii_state_is_a_refusal_not_a_500() -> None:
    fake = FakeVercel()
    client = make_client(fake)
    start_login(client, fake)
    r = client.get("/auth/callback", params={"code": "x", "state": "é"})
    assert (r.status_code, r.headers["location"]) == (303, "/?signin=refused")
    assert not signed_in(client)


def test_a_non_ascii_owner_sub_is_a_refusal_not_a_500() -> None:
    fake = FakeVercel(sub="é-not-the-owner")
    client = make_client(fake)
    assert complete(client, start_login(client, fake)).headers["location"] == "/?signin=refused"


def test_there_is_one_definition_of_the_owner() -> None:
    assert stub_identity.OWNER is OWNER
    assert vercel_identity.OWNER is OWNER
    assert OWNER.organisation_id == "owner-org"


def test_the_oauth_redirect_origin_defaults_to_the_deployed_web_app_and_is_overridable() -> None:
    assert build_container(CONFIG).public_origin == ORIGIN
    assert build_container({}).public_origin == "http://localhost:5173"
    assert build_container({"PUBLIC_WEB_ORIGIN": "https://x.example/"}).public_origin == (
        "https://x.example"
    )
