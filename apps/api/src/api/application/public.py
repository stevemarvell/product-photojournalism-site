"""The public site's reads (spec sections 6, 8 and 11): the published text of live stories.

Nothing here reads a draft field: the only text that leaves is `published_*`, and only for
a story that is live. An image is shown by its web versions; the original is never read.
"""

import datetime as dt
from dataclasses import dataclass

from api.application.images import ImageService
from api.application.ports import StoryRepository
from api.domain import (
    ImageNotFoundError,
    ImageStatus,
    PublicStory,
    StoryNotFoundError,
    WebVersion,
    parse_photo_blocks,
    unescape_attr,
)


@dataclass(frozen=True)
class PublicPhoto:
    """A Photo block resolved to its image: text decoded, web versions only."""

    image_id: str
    alt: str
    caption: str
    credit: str
    width: int
    height: int
    versions: tuple[WebVersion, ...]


@dataclass(frozen=True)
class PublicSummary:
    id: str
    title: str
    description: str
    location: str
    date: dt.date | None
    first_published_at: dt.datetime
    hero: PublicPhoto | None


@dataclass(frozen=True)
class PublicPiece:
    summary: PublicSummary
    content: str
    # Every Photo block's image that has web versions, by image id.
    photos: dict[str, PublicPhoto]


class PublicSite:
    def __init__(self, stories: StoryRepository, images: ImageService) -> None:
        self._stories = stories
        self._images = images

    def list_live(self, organisation_id: str) -> list[PublicSummary]:
        return [self._summary(organisation_id, s) for s in self._stories.list_live(organisation_id)]

    def get_live(self, organisation_id: str, story_id: str) -> PublicPiece:
        """Raises StoryNotFoundError for an id that does not exist, is another organisation's,
        or is not live: the three are indistinguishable to the reader."""
        story = self._stories.get(organisation_id, story_id)
        if story is None or not story.live or story.first_published_at is None:
            raise StoryNotFoundError(story_id)
        public = story.public
        photos = self._photos(organisation_id, public)
        return PublicPiece(
            summary=self._summary(organisation_id, public, photos),
            content=story.published_content,
            photos={p.image_id: p for p in photos},
        )

    def _photos(
        self, organisation_id: str, story: PublicStory, *, first_only: bool = False
    ) -> list[PublicPhoto]:
        """The story's Photo blocks that resolve, in order. With `first_only` it stops at the
        first one that does: the home list needs only the hero."""
        blocks, _ = parse_photo_blocks(story.published_content)
        found: list[PublicPhoto] = []
        for block in blocks:
            try:
                image = self._images.get(organisation_id, block.image_id)
            except ImageNotFoundError:
                continue
            if image.status is not ImageStatus.READY or not image.web_versions:
                continue
            found.append(
                PublicPhoto(
                    image_id=image.id,
                    alt=unescape_attr(block.alt),
                    caption=unescape_attr(block.caption),
                    credit=unescape_attr(block.credit),
                    width=image.width or 0,
                    height=image.height or 0,
                    versions=image.web_versions,
                )
            )
            if first_only:
                break
        return found

    def _summary(
        self, organisation_id: str, story: PublicStory, photos: list[PublicPhoto] | None = None
    ) -> PublicSummary:
        if photos is None:
            photos = self._photos(organisation_id, story, first_only=True)
        assert story.first_published_at is not None
        return PublicSummary(
            id=story.id,
            title=story.published_title,
            description=story.published_description,
            location=story.published_location,
            date=story.published_date,
            first_published_at=story.first_published_at,
            # The hero is the first Photo block (spec section 4), derived on read.
            hero=photos[0] if photos else None,
        )
