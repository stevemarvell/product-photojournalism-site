"""Stub IdentityProvider: always signs in as the owner.

Local development only. The composition root refuses to build it when
VERCEL_ENV is set.
"""

from collections.abc import Mapping, MutableMapping
from typing import Any

from api.domain import OWNER, User


class StubIdentityProvider:
    def sign_in_available(self) -> bool:
        return True

    def current_user(self, session: MutableMapping[str, Any]) -> User:
        return OWNER

    def begin_sign_in(self, session: MutableMapping[str, Any], redirect_uri: str) -> str:
        # Straight on to the callback, which opens a server-side session as it does
        # for a real sign-in: owner routes need that session, not just this provider.
        return redirect_uri

    def complete_sign_in(
        self, session: MutableMapping[str, Any], redirect_uri: str, params: Mapping[str, str]
    ) -> User:
        return OWNER

    def sign_out(self, session: MutableMapping[str, Any]) -> None:
        session.clear()
