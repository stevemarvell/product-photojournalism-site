"""The ports: what the application needs from the outside world.

Only what the skeleton needs. Use cases and richer methods arrive with the
slices that use them.
"""

from collections.abc import Mapping, MutableMapping
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Protocol

from api.domain import ImageRecord, ImageStatus, PublicStory, SessionRecord, Story, User


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

    def list_live(self, organisation_id: str) -> list[PublicStory]:
        """The organisation's live stories, public columns only (no draft field is read),
        newest `first_published_at` first, ties broken by id descending."""
        ...

    def list(self, organisation_id: str) -> list[Story]:
        """Every story of the organisation, in no particular order."""
        ...

    def replace(
        self,
        organisation_id: str,
        story: Story,
        expected_updated_at: datetime,
        client_id: str | None = None,
        seq: int | None = None,
    ) -> Story:
        """Store `story` in place of the stored one, atomically (one transaction), but only if
        the stored `updated_at` is still `expected_updated_at`, or the stored version was saved by
        the same `client_id` from that same base with a higher `seq` (a tab superseding its own
        last save, never an older one).

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


class ImageRepository(Protocol):
    """Image rows (spec section 4), always scoped to an organisation: every method takes
    `organisation_id` and never returns or touches another organisation's image."""

    def create(self, image: ImageRecord) -> None:
        """Store a new image (under `image.organisation_id`)."""
        ...

    def get(self, organisation_id: str, image_id: str) -> ImageRecord | None: ...

    def replace_if_status(
        self, organisation_id: str, image: ImageRecord, expected: ImageStatus
    ) -> bool:
        """Store `image` in place of the stored row, atomically, but only if the stored status
        is still `expected`. False when it is not (or there is no such image): the row is
        left alone. This is what stops a late worker un-failing a timed-out image."""
        ...


class ImageStore(Protocol):
    """Bytes by key. Used for the web versions (public) and, locally, the originals."""

    def put(self, key: str, data: bytes) -> str:
        """Store `data` and return the URL it is reachable at."""
        ...

    def get(self, key: str) -> bytes | None: ...


@dataclass(frozen=True)
class UploadTarget:
    """Where the browser puts one original, and the URL it then registers (the Vercel Blob
    client-upload shape: ask for a target, PUT the file there, register the URL)."""

    upload_url: str
    original_url: str
    method: str = "PUT"


class OriginalUploads(Protocol):
    """Where originals are uploaded to and read back from. Never public.

    Locally the filesystem; in production Vercel Blob (a follow-up): `issue` becomes a
    client-upload token, `size` a HEAD request and `read` a download, without the
    browser's flow changing.
    """

    def issue(self, organisation_id: str) -> UploadTarget: ...

    def size(self, organisation_id: str, original_url: str) -> int | None:
        """Bytes stored at a URL this adapter issued **to this organisation**; None for
        anything else (not issued, issued to another organisation, or not uploaded yet)."""
        ...

    def claim(self, organisation_id: str, original_url: str) -> bool:
        """Mark the upload as registered, atomically. False when it already was: an upload
        backs exactly one image row."""
        ...

    def read(self, original_url: str) -> bytes | None:
        """The original's bytes; None when it is not one this adapter issued."""
        ...


@dataclass(frozen=True)
class RenderedImage:
    width: int
    height: int
    # (width, JPEG bytes) for each web version, smallest first.
    versions: tuple[tuple[int, bytes], ...]


class ImageRenderer(Protocol):
    def render(self, data: bytes) -> RenderedImage:
        """Web versions of an original, with all metadata dropped.

        Raises ImageProcessingError for bytes that are not a usable image.
        """
        ...


class ImageProcessor(Protocol):
    """Where processing runs (spec section 13 leaves that open): locally a thread in this
    process; in production a queue or a function, behind this same port."""

    def enqueue(self, organisation_id: str, image_id: str) -> None:
        """Start processing the image; the row's status carries the outcome."""
        ...


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
