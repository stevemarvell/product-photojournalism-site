"""The story record and its rules (spec sections 4 and 5). Pure: no I/O, no framework.

A story holds its draft and its published text as two sets of fields, so
publishing is one copy. Every function here returns a new Story; storing it is
the repository's job.
"""

import datetime as dt
import re
from collections.abc import Callable
from dataclasses import dataclass, replace
from datetime import datetime, timedelta

from api.domain.models import ImageStatus


@dataclass(frozen=True)
class DraftFields:
    """What the editor autosaves: all draft fields together."""

    title: str = ""
    description: str = ""
    location: str = ""
    date: dt.date | None = None
    content: str = ""


@dataclass(frozen=True)
class Story:
    id: str
    organisation_id: str
    live: bool
    first_published_at: datetime | None
    last_published_at: datetime | None
    draft_title: str
    draft_description: str
    draft_location: str
    draft_date: dt.date | None
    draft_content: str
    published_title: str
    published_description: str
    published_location: str
    published_date: dt.date | None
    published_content: str
    created_at: datetime
    updated_at: datetime
    # Which editor tab produced this version, and the `updated_at` that save was based on:
    # the same tab may overwrite its own last save from that same base (a keepalive save
    # sent on pagehide while the previous one was still in flight).
    last_saved_by: str | None = None
    previous_updated_at: datetime | None = None
    # That tab's save counter at the time: an older save of the same tab cannot overwrite a newer.
    last_saved_seq: int | None = None

    @property
    def draft(self) -> DraftFields:
        return DraftFields(
            self.draft_title,
            self.draft_description,
            self.draft_location,
            self.draft_date,
            self.draft_content,
        )

    @property
    def has_been_published(self) -> bool:
        return self.first_published_at is not None


def new_story(story_id: str, organisation_id: str, now: datetime) -> Story:
    """An empty draft, nothing published, not live."""
    return Story(
        id=story_id,
        organisation_id=organisation_id,
        live=False,
        first_published_at=None,
        last_published_at=None,
        draft_title="",
        draft_description="",
        draft_location="",
        draft_date=None,
        draft_content="",
        published_title="",
        published_description="",
        published_location="",
        published_date=None,
        published_content="",
        created_at=now,
        updated_at=now,
    )


def _touched(story: Story, now: datetime) -> datetime:
    # Strictly increasing, so two saves in one clock tick still differ and the
    # conflict check cannot mistake a newer version for the one the editor saw.
    return max(now, story.updated_at + timedelta(microseconds=1))


def with_draft(
    story: Story,
    draft: DraftFields,
    now: datetime,
    client_id: str | None = None,
    base: datetime | None = None,
    seq: int | None = None,
) -> Story:
    """Autosave: replace the draft fields. The published text and `live` are untouched.
    `client_id` and `base` (the `updated_at` the caller saw) record who saved from what."""
    return replace(
        story,
        draft_title=draft.title,
        draft_description=draft.description,
        draft_location=draft.location,
        draft_date=draft.date,
        draft_content=draft.content,
        updated_at=_touched(story, now),
        last_saved_by=client_id,
        previous_updated_at=base if base is not None else story.updated_at,
        last_saved_seq=seq,
    )


def published(story: Story, now: datetime) -> Story:
    """Copy the draft over the published text; live; first_published_at if empty."""
    return replace(
        story,
        live=True,
        first_published_at=story.first_published_at or now,
        last_published_at=now,
        published_title=story.draft_title,
        published_description=story.draft_description,
        published_location=story.draft_location,
        published_date=story.draft_date,
        published_content=story.draft_content,
        updated_at=_touched(story, now),
        last_saved_by=None,
        previous_updated_at=None,
        last_saved_seq=None,
    )


# --- Photo blocks and the publish rule ---------------------------------------

_ATTR = r"""[A-Za-z_][\w-]*\s*=\s*(?:"[^"]*"|'[^']*')"""
_PHOTO = re.compile(rf"<Photo((?:\s+{_ATTR})*)\s*/>")
_ATTR_PARTS = re.compile(r"""([A-Za-z_][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')""")


@dataclass(frozen=True)
class PhotoBlock:
    image_id: str
    alt: str


def parse_photo_blocks(content: str) -> tuple[list[PhotoBlock], int]:
    """The well-formed `<Photo image="…" alt="…" … />` blocks, and how many
    `<Photo` openings there were in all (the difference is malformed blocks)."""
    blocks: list[PhotoBlock] = []
    for match in _PHOTO.finditer(content):
        attrs = {
            m.group(1): m.group(2) if m.group(2) is not None else m.group(3)
            for m in _ATTR_PARTS.finditer(match.group(1))
        }
        blocks.append(PhotoBlock(attrs.get("image", "").strip(), attrs.get("alt", "").strip()))
    return blocks, len(re.findall(r"<Photo\b", content))


def publish_problems(
    draft: DraftFields, image_status: Callable[[str], ImageStatus | None]
) -> list[str]:
    """Why this draft cannot be published (spec section 5); empty when it can.

    `image_status` answers for an image id; None (unknown) fails like not-ready.
    """
    problems: list[str] = []
    if not draft.title.strip():
        problems.append("title is required")
    if not draft.description.strip():
        problems.append("description is required")
    blocks, openings = parse_photo_blocks(draft.content)
    if openings > len(blocks):
        problems.append("a Photo block is malformed")
    if not blocks and openings == 0:
        problems.append("at least one Photo block is required")
    for n, block in enumerate(blocks, start=1):
        if not block.alt:
            problems.append(f"Photo {n} has no alt text")
        if not block.image_id:
            problems.append(f"Photo {n} has no image")
        elif image_status(block.image_id) is not ImageStatus.READY:
            problems.append(f"Photo {n}: image {block.image_id} is not ready")
    return problems


def owner_order(stories: list[Story]) -> list[Story]:
    """The owner's list (spec section 7): never-published stories first, newest created
    first (they are the work in hand); then published ones by first_published_at, newest
    first. Ties break on id so the order is stable."""
    unpublished = sorted(
        (s for s in stories if s.first_published_at is None),
        key=lambda s: (s.created_at, s.id),
        reverse=True,
    )
    ever_published = sorted(
        ((s.first_published_at, s.id, s) for s in stories if s.first_published_at is not None),
        key=lambda t: (t[0], t[1]),
        reverse=True,
    )
    return unpublished + [s for _, _, s in ever_published]
