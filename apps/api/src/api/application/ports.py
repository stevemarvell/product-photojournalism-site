"""The ports: what the application needs from the outside world.

Only what the skeleton needs. Use cases and richer methods arrive with the
slices that use them.
"""

from datetime import datetime
from typing import Protocol

from api.domain import User


class StoryRepository(Protocol):
    def ping(self) -> bool:
        """True if the backing store can be reached. Never raises, never leaks."""
        ...


class ImageStore(Protocol):
    def put(self, image_id: str, data: bytes) -> None: ...

    def get(self, image_id: str) -> bytes | None: ...


class IdentityProvider(Protocol):
    def current_user(self) -> User | None: ...


class Clock(Protocol):
    def now(self) -> datetime: ...
