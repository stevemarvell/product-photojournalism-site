"""The ports: what the application needs from the outside world.

Only what the skeleton needs. Use cases and richer methods arrive with the
slices that use them.
"""

from collections.abc import Mapping, MutableMapping
from datetime import datetime
from typing import Any, Protocol

from api.domain import User


class StoryRepository(Protocol):
    def ping(self) -> bool:
        """True if the backing store can be reached. Never raises, never leaks."""
        ...


class ImageStore(Protocol):
    def put(self, image_id: str, data: bytes) -> None: ...

    def get(self, image_id: str) -> bytes | None: ...


class SignInNotConfiguredError(Exception):
    """This provider cannot sign anybody in (it is off, or its settings are missing)."""


class SignInRefusedError(Exception):
    """A sign-in attempt was refused: bad state, a failed exchange, or not the owner."""


class IdentityProvider(Protocol):
    """Who is signing in, and who is signed in.

    `session` is the visitor's server-signed session: a mutable mapping the
    web layer owns and the provider reads and writes, so that nothing here
    knows about cookies or a framework. A general login provider can replace
    the Vercel one by implementing this.
    """

    def sign_in_available(self) -> bool:
        """False when no one can sign in (the routes then answer 503)."""
        ...

    def current_user(self, session: MutableMapping[str, Any]) -> User | None: ...

    def begin_sign_in(self, session: MutableMapping[str, Any], redirect_uri: str) -> str:
        """Record what the callback must check in `session`; return where to send the browser.

        Raises SignInNotConfiguredError.
        """
        ...

    def complete_sign_in(
        self,
        session: MutableMapping[str, Any],
        redirect_uri: str,
        params: Mapping[str, str],
    ) -> User:
        """Finish a sign-in from the callback's query `params`; the session then holds the user.

        Raises SignInRefusedError (the session is left signed out) or SignInNotConfiguredError.
        """
        ...

    def sign_out(self, session: MutableMapping[str, Any]) -> None: ...


class Clock(Protocol):
    def now(self) -> datetime: ...
