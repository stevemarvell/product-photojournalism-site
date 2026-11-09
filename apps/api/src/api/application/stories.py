"""Story use cases (spec sections 4, 5 and 11). Every call is for one organisation."""

import uuid
from datetime import datetime

from api.application.ports import Clock, ImageStatusLookup, StoryRepository
from api.domain import (
    DraftFields,
    InvalidContentError,
    PublishRefusedError,
    Story,
    StoryNotFoundError,
    content_problems,
    new_story,
    owner_order,
    publish_problems,
    published,
    with_draft,
)


class StoryService:
    def __init__(self, stories: StoryRepository, images: ImageStatusLookup, clock: Clock) -> None:
        self._stories = stories
        self._images = images
        self._clock = clock

    def create(self, organisation_id: str) -> Story:
        story = new_story(str(uuid.uuid4()), organisation_id, self._clock.now())
        self._stories.create(story)
        return story

    def list(self, organisation_id: str) -> list[Story]:
        return owner_order(self._stories.list(organisation_id))

    def get(self, organisation_id: str, story_id: str) -> Story:
        story = self._stories.get(organisation_id, story_id)
        if story is None:
            raise StoryNotFoundError(story_id)
        return story

    def save_draft(
        self, organisation_id: str, story_id: str, draft: DraftFields, seen_updated_at: datetime
    ) -> Story:
        """Autosave. Raises InvalidContentError for a body with disallowed markup, and
        StoryConflictError unless `seen_updated_at` is the stored one."""
        problems = content_problems(draft.content)
        if problems:
            raise InvalidContentError(problems)
        current = self.get(organisation_id, story_id)
        return self._stories.replace(
            organisation_id,
            with_draft(current, draft, self._clock.now()),
            expected_updated_at=seen_updated_at,
        )

    def publish(self, organisation_id: str, story_id: str) -> Story:
        """Raises PublishRefusedError (nothing changes) unless the draft passes the rule.

        The write is conditional on the draft being the one just checked, so an
        autosave landing in between is a conflict rather than an unchecked publish.
        """
        current = self.get(organisation_id, story_id)
        # The body is checked again here: publish copies it to the text the public
        # site serves, so it does not rest on save_draft having been the only way in.
        problems = content_problems(current.draft.content) + publish_problems(
            current.draft, lambda image_id: self._images.status(organisation_id, image_id)
        )
        if problems:
            raise PublishRefusedError(problems)
        return self._stories.replace(
            organisation_id,
            published(current, self._clock.now()),
            expected_updated_at=current.updated_at,
        )
