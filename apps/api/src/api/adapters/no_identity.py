"""IdentityProvider that signs nobody in: the default, so nothing fails open.

Also what a deployment runs, with a logged reason, when IDENTITY_PROVIDER=vercel
but its settings are missing: the site stays up, owner routes answer 401 and
/auth/* answers 503.
"""

from collections.abc import Mapping, MutableMapping
from typing import Any

from api.application import SignInNotConfiguredError
from api.domain import User


class NoIdentityProvider:
    def sign_in_available(self) -> bool:
        return False

    def current_user(self, session: MutableMapping[str, Any]) -> User | None:
        return None

    def begin_sign_in(self, session: MutableMapping[str, Any], redirect_uri: str) -> str:
        raise SignInNotConfiguredError

    def complete_sign_in(
        self, session: MutableMapping[str, Any], redirect_uri: str, params: Mapping[str, str]
    ) -> User:
        raise SignInNotConfiguredError

    def sign_out(self, session: MutableMapping[str, Any]) -> None:
        session.clear()
