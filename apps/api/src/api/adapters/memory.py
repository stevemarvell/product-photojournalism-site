"""In-memory StoryRepository: the local default, needing no services."""

from api.domain import Story


class InMemoryStoryRepository:
    def __init__(self) -> None:
        self._stories: dict[str, Story] = {}

    def ping(self) -> bool:
        return True
