"""In-memory adapters: the local default, needing no services.

Nothing here survives a restart (or, on a serverless host, a cold start).
"""

import secrets
import threading
from collections.abc import Callable, Mapping
from datetime import UTC, datetime, timedelta

from api.application.sessions import SESSION_MAX_AGE
from api.domain import (
    ImageRecord,
    ImageStatus,
    PublicStory,
    SessionRecord,
    Story,
    StoryConflictError,
    StoryNotFoundError,
)


class InMemoryStoryRepository:
    def __init__(self) -> None:
        # Keyed by (organisation_id, story id): a lookup cannot cross organisations.
        self._stories: dict[tuple[str, str], Story] = {}
        self._lock = threading.Lock()

    def ping(self) -> bool:
        return True

    def create(self, story: Story) -> None:
        with self._lock:
            key = (story.organisation_id, story.id)
            if key in self._stories:
                raise ValueError(f"story {story.id} already exists")
            self._stories[key] = story

    def get(self, organisation_id: str, story_id: str) -> Story | None:
        return self._stories.get((organisation_id, story_id))

    def list_live(self, organisation_id: str) -> list[PublicStory]:
        with self._lock:
            live = [
                s
                for (org, _), s in self._stories.items()
                if org == organisation_id and s.live and s.first_published_at is not None
            ]
        live.sort(key=lambda s: (s.first_published_at, s.id), reverse=True)  # type: ignore[arg-type,return-value]
        return [s.public for s in live]

    def list(self, organisation_id: str) -> list[Story]:
        with self._lock:
            return [s for (org, _), s in self._stories.items() if org == organisation_id]

    def replace(
        self,
        organisation_id: str,
        story: Story,
        expected_updated_at: datetime,
        client_id: str | None = None,
        seq: int | None = None,
    ) -> Story:
        with self._lock:  # the compare and the write are one step
            key = (organisation_id, story.id)
            stored = self._stories.get(key)
            if stored is None or story.organisation_id != organisation_id:
                raise StoryNotFoundError(story.id)
            current = stored.updated_at == expected_updated_at
            # The same tab superseding its own last save, made from this same base.
            own = (
                client_id is not None
                and stored.last_saved_by == client_id
                and stored.previous_updated_at == expected_updated_at
                and seq is not None
                and stored.last_saved_seq is not None
                and seq > stored.last_saved_seq
            )
            if not (current or own):
                raise StoryConflictError(story.id)
            self._stories[key] = story
            return story


class InMemoryImageRepository:
    def __init__(self) -> None:
        # Keyed by (organisation_id, image id): a lookup cannot cross organisations.
        self._images: dict[tuple[str, str], ImageRecord] = {}
        self._uploads: dict[str, str] = {}  # original_url -> the organisation it was issued to
        self._claimed: set[str] = set()
        self._lock = threading.Lock()

    def bind_upload(self, organisation_id: str, original_url: str) -> None:
        with self._lock:
            self._uploads[original_url] = organisation_id

    def upload_issued_to(self, organisation_id: str, original_url: str) -> bool:
        with self._lock:
            return self._uploads.get(original_url) == organisation_id

    def create_claiming(self, image: ImageRecord) -> bool:
        with self._lock:  # the claim and the row are one step
            url = image.original_url
            if self._uploads.get(url) != image.organisation_id or url in self._claimed:
                return False
            key = (image.organisation_id, image.id)
            if key in self._images:
                raise ValueError(f"image {image.id} already exists")
            self._claimed.add(url)
            self._images[key] = image
            return True

    def create(self, image: ImageRecord) -> None:
        with self._lock:
            key = (image.organisation_id, image.id)
            if key in self._images:
                raise ValueError(f"image {image.id} already exists")
            self._images[key] = image

    def get(self, organisation_id: str, image_id: str) -> ImageRecord | None:
        with self._lock:
            return self._images.get((organisation_id, image_id))

    def replace_if_status(
        self, organisation_id: str, image: ImageRecord, expected: ImageStatus
    ) -> bool:
        with self._lock:  # the compare and the write are one step
            key = (organisation_id, image.id)
            stored = self._images.get(key)
            if stored is None or image.organisation_id != organisation_id:
                return False
            if stored.status is not expected:
                return False
            self._images[key] = image
            return True


class InMemoryImageStatusLookup:
    """A fake ImageStatusLookup: statuses a test states up front. Any other id is unknown
    (None), which fails the publish rule. The real one is `ImageService.status`; both meet
    tests/test_image_status_lookup_contract.py."""

    def __init__(self, statuses: Mapping[str, ImageStatus] | None = None) -> None:
        self._statuses = dict(statuses or {})

    def status(self, organisation_id: str, image_id: str) -> ImageStatus | None:
        return self._statuses.get(image_id)


class InMemorySessionStore:
    def __init__(
        self,
        max_age: timedelta = timedelta(seconds=SESSION_MAX_AGE),
        now: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        self._max_age = max_age
        self._now = now
        self._sessions: dict[str, tuple[str, datetime]] = {}  # id -> (user id, created_at)
        self._epochs: dict[str, int] = {}  # user id -> current epoch
        self._lock = threading.Lock()

    def create(self, user_id: str) -> SessionRecord:
        with self._lock:
            session_id = secrets.token_urlsafe(32)
            epoch = self._epochs.get(user_id, 0)
            self._sessions[session_id] = (user_id, self._now())
            return SessionRecord(session_id, user_id, epoch)

    def get(self, session_id: str) -> SessionRecord | None:
        with self._lock:
            found = self._sessions.get(session_id)
            if found is None:
                return None
            user_id, created_at = found
            if self._now() - created_at >= self._max_age:
                del self._sessions[session_id]  # expired: the cookie's own max age has passed
                return None
            # A session issued before a revoke-all reports the new epoch, so the
            # (older) epoch in its cookie no longer matches.
            return SessionRecord(session_id, user_id, self._epochs.get(user_id, 0))

    def delete(self, session_id: str) -> None:
        with self._lock:
            self._sessions.pop(session_id, None)

    def revoke_all(self, user_id: str) -> None:
        with self._lock:
            self._epochs[user_id] = self._epochs.get(user_id, 0) + 1
            for sid in [sid for sid, (u, _) in self._sessions.items() if u == user_id]:
                del self._sessions[sid]
