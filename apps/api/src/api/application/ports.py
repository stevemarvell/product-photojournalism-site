"""The ports: what the application needs from the outside world.

Only what the skeleton needs. Use cases and richer methods arrive with the
slices that use them.
"""

from collections.abc import Mapping, MutableMapping
from datetime import datetime
from typing import Any, Protocol

from api.domain import ImageStatus, SessionRecord, Story, User


class StoryRepository(Protocol):
    """Stories, always scoped to an organisation: every method takes `organisation_id`
    and never returns or touches another organisation's story."""

    def ping(self) -> bool:
        """True if the backing store can be reached. Never raises, never leaks."""
        ...

    def create(self, story: Story) -> None:
        """Store a new story (under `story.organisation_id`)."""
        ...

    def get(self, organisation_id: str, story_id: str) -> Story | None: ...

    def list(self, organisation_id: str) -> list[Story]:
        """Every story of the organisation, in no particular order."""
        ...

    def replace(self, organisation_id: str, story: Story, expected_updated_at: datetime) -> Story:
        """Store `story` in place of the stored one, atomically (one transaction), but only if
        the stored `updated_at` is still `expected_updated_at`.

        Raises StoryNotFoundError, or StoryConflictError when it has changed since.
        """
        ...


class ImageStatusLookup(Protocol):
    """Where the publish rule learns whether an image is ready (the image pipeline, #15)."""

    def status(self, organisation_id: str, image_id: str) -> ImageStatus | None:
        """The image's status; None when there is no such image."""
        ...


class SessionStore(Protocol):
    """Server-side record of signed-in sessions, so a session can be revoked.

    The signed cookie carries a session id and the epoch it was issued under;
    it is honoured only while the store still has that id at that epoch.
    """

    def create(self, user_id: str) -> SessionRecord: ...

    def get(self, session_id: str) -> SessionRecord | None:
        """The record, with the user's current epoch; None if absent or deleted."""
        ...

    def delete(self, session_id: str) -> None: ...

    def revoke_all(self, user_id: str) -> None:
        """Bump the user's epoch: every cookie issued before is refused from now on."""
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
