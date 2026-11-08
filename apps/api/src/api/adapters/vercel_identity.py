"""IdentityProvider for Sign in with Vercel (OAuth 2.0 authorization code + PKCE, OIDC).

Endpoints, scopes and claims are those of
https://vercel.com/docs/sign-in-with-vercel (getting-started and
authorization-server-api pages):

  authorize  GET  https://vercel.com/oauth/authorize
  token      POST https://api.vercel.com/login/oauth/token (form-encoded)
  userinfo   GET  https://api.vercel.com/login/oauth/userinfo (Bearer access token)

The user is identified by the userinfo `sub` claim. Only that owner is let in.
The access token is used once, for userinfo, and never stored.
"""

import base64
import hashlib
import json
import logging
import secrets
import time
from collections.abc import Callable, Mapping, MutableMapping
from typing import Any
from urllib.parse import urlencode

import httpx
from cryptography.fernet import Fernet, InvalidToken
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from api.application import SignInRefusedError
from api.domain import OWNER, User

AUTHORIZE_URL = "https://vercel.com/oauth/authorize"
TOKEN_URL = "https://api.vercel.com/login/oauth/token"
USERINFO_URL = "https://api.vercel.com/login/oauth/userinfo"
# `openid` is required; `profile` yields the name. No `offline_access`: no refresh token is wanted.
SCOPE = "openid profile"

# How long a sign-in may take between /auth/login and the callback.
PENDING_TTL_SECONDS = 600

# Session keys. The pending-flow values are single use, popped on the callback.
_PENDING = "oauth_pending"
_SUB = "vercel_sub"

log = logging.getLogger(__name__)


def _same(a: object, b: str) -> bool:
    """Constant-time equality on bytes: compare_digest raises on non-ASCII str."""
    return isinstance(a, str) and secrets.compare_digest(
        a.encode("utf-8", "surrogatepass"), b.encode("utf-8", "surrogatepass")
    )


def _fernet(session_secret: str) -> Fernet:
    """A key derived from SESSION_SECRET (HKDF-SHA256), not the secret itself."""
    key = HKDF(
        algorithm=hashes.SHA256(), length=32, salt=None, info=b"vercel-sign-in-pending"
    ).derive(session_secret.encode())
    return Fernet(base64.urlsafe_b64encode(key))


class VercelIdentityProvider:
    def __init__(
        self,
        *,
        client_id: str,
        client_secret: str,
        owner_vercel_id: str,
        session_secret: str,
        http: httpx.Client | None = None,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self._client_id = client_id
        self._client_secret = client_secret
        self._owner_vercel_id = owner_vercel_id
        self._http = http or httpx.Client(timeout=10.0)
        self._owner = OWNER
        # The pending sign-in (PKCE verifier, nonce, state) rides in the session
        # cookie, which is signed but readable: so it is encrypted and time-bound.
        self._fernet = _fernet(session_secret)
        self._clock = clock

    def sign_in_available(self) -> bool:
        return True

    def current_user(self, session: MutableMapping[str, Any]) -> User | None:
        # Compared against configuration on every request, so changing
        # OWNER_VERCEL_ID locks out a session signed in as someone else.
        sub = session.get(_SUB)
        if _same(sub, self._owner_vercel_id):
            return self._owner
        return None

    def begin_sign_in(self, session: MutableMapping[str, Any], redirect_uri: str) -> str:
        state = secrets.token_urlsafe(32)
        nonce = secrets.token_urlsafe(32)
        verifier = secrets.token_urlsafe(48)
        challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest())
        # An existing sign-in is left alone: only a successful callback replaces it.
        pending = json.dumps({"state": state, "nonce": nonce, "verifier": verifier})
        session[_PENDING] = self._fernet.encrypt_at_time(
            pending.encode(), int(self._clock())
        ).decode()
        query = urlencode(
            {
                "client_id": self._client_id,
                "redirect_uri": redirect_uri,
                "response_type": "code",
                "scope": SCOPE,
                "state": state,
                "nonce": nonce,
                "code_challenge": challenge.rstrip(b"=").decode(),
                "code_challenge_method": "S256",
            }
        )
        return f"{AUTHORIZE_URL}?{query}"

    def complete_sign_in(
        self,
        session: MutableMapping[str, Any],
        redirect_uri: str,
        params: Mapping[str, str],
    ) -> User:
        sealed = session.pop(_PENDING, None)  # single use, whatever happens next
        pending = self._open(sealed)
        if "error" in params:
            raise SignInRefusedError(f"Vercel returned {params['error']!r}")
        state, code = params.get("state"), params.get("code")
        if not state or not _same(state, str(pending.get("state", ""))):
            raise SignInRefusedError("state mismatch")
        if not code:
            raise SignInRefusedError("no authorization code")

        try:
            token = self._http.post(
                TOKEN_URL,
                data={
                    "grant_type": "authorization_code",
                    "code": code,
                    "redirect_uri": redirect_uri,
                    "client_id": self._client_id,
                    "client_secret": self._client_secret,
                    "code_verifier": pending["verifier"],
                },
            )
            token.raise_for_status()
            tokens = token.json()
            if not _nonce_matches(tokens.get("id_token"), str(pending.get("nonce", ""))):
                raise SignInRefusedError("nonce mismatch")
            info = self._http.get(
                USERINFO_URL, headers={"Authorization": f"Bearer {tokens['access_token']}"}
            )
            info.raise_for_status()
            sub = info.json().get("sub")
        except (httpx.HTTPError, ValueError, KeyError, AttributeError) as exc:
            raise SignInRefusedError(f"exchange with Vercel failed: {type(exc).__name__}") from exc

        if not _same(sub, self._owner_vercel_id):
            # The sub is an identifier, not a secret; logging it is how the owner
            # finds the value OWNER_VERCEL_ID needs.
            log.warning("sign-in refused for Vercel sub %r: not the configured owner", sub)
            raise SignInRefusedError("not the owner")
        session[_SUB] = sub
        return self._owner

    def sign_out(self, session: MutableMapping[str, Any]) -> None:
        session.clear()

    def _open(self, sealed: object) -> dict[str, Any]:
        if not isinstance(sealed, str):
            raise SignInRefusedError("no sign-in in progress")
        try:
            raw = self._fernet.decrypt_at_time(
                sealed.encode(), PENDING_TTL_SECONDS, int(self._clock())
            )
            pending = json.loads(raw)
        except (InvalidToken, ValueError) as exc:
            raise SignInRefusedError("sign-in expired or unreadable") from exc
        if not isinstance(pending, dict):
            raise SignInRefusedError("sign-in unreadable")
        return pending


def _nonce_matches(id_token: object, expected: str) -> bool:
    """The id_token came straight from Vercel's token endpoint over TLS, so its
    nonce is read without verifying a signature, as Vercel's own example does."""
    if not isinstance(id_token, str) or not expected:
        return False
    try:
        payload = id_token.split(".")[1]
        claims = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
    except (IndexError, ValueError):
        return False
    return _same(claims.get("nonce"), expected)
