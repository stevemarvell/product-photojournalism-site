"""Owner story endpoints (spec section 11), all behind `require_owner`.

Thin: parse the request, call StoryService with the signed-in user's organisation,
map the domain's errors to statuses.
"""

import datetime as dt
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from api.application import StoryService
from api.domain import (
    DraftFields,
    InvalidContentError,
    PublishRefusedError,
    Story,
    StoryConflictError,
    StoryNotFoundError,
    TransitionRefusedError,
    User,
)
from api.guard import container_of, require_owner


class DraftBody(BaseModel):
    """The editor's autosave: every draft field, plus the `updated_at` it last saw."""

    title: str = Field(max_length=300)
    description: str = Field(max_length=2000)
    location: str = Field(default="", max_length=300)
    date: dt.date | None = None
    content: str = Field(max_length=200_000)
    updated_at: dt.datetime
    client_id: str | None = Field(default=None, min_length=1, max_length=64)
    seq: int | None = Field(default=None, ge=0)


def _text(title: str, description: str, location: str, when: dt.date | None, content: str) -> dict:
    return {
        "title": title,
        "description": description,
        "location": location,
        "date": when.isoformat() if when else None,
        "content": content,
    }


def detail(story: Story) -> dict[str, Any]:
    return {
        "id": story.id,
        "live": story.live,
        "first_published_at": story.first_published_at,
        "last_published_at": story.last_published_at,
        "created_at": story.created_at,
        "updated_at": story.updated_at,
        "draft": _text(
            story.draft_title,
            story.draft_description,
            story.draft_location,
            story.draft_date,
            story.draft_content,
        ),
        # Never published: there is no published text, not an empty one.
        "published": _text(
            story.published_title,
            story.published_description,
            story.published_location,
            story.published_date,
            story.published_content,
        )
        if story.has_been_published
        else None,
    }


def summary(story: Story) -> dict[str, Any]:
    return {
        "id": story.id,
        "live": story.live,
        "title": story.draft_title,
        "description": story.draft_description,
        "first_published_at": story.first_published_at,
        "last_published_at": story.last_published_at,
        "created_at": story.created_at,
        "updated_at": story.updated_at,
    }


def service_of(request: Request) -> StoryService:
    c = container_of(request)
    return StoryService(c.stories, c.image_status, c.clock)


Service = Annotated[StoryService, Depends(service_of)]
Owner = Annotated[User, Depends(require_owner)]

router = APIRouter(prefix="/stories", dependencies=[Depends(require_owner)])


@router.post("", status_code=201)
def create_story(user: Owner, service: Service) -> dict[str, Any]:
    return detail(service.create(user.organisation_id))


@router.get("")
def list_stories(user: Owner, service: Service) -> list[dict[str, Any]]:
    return [summary(s) for s in service.list(user.organisation_id)]


@router.get("/{story_id}")
def get_story(story_id: str, user: Owner, service: Service) -> dict[str, Any]:
    return detail(_found(lambda: service.get(user.organisation_id, story_id)))


@router.put("/{story_id}/draft")
def save_draft(story_id: str, body: DraftBody, user: Owner, service: Service) -> dict[str, Any]:
    draft = DraftFields(body.title, body.description, body.location, body.date, body.content)
    try:
        return detail(
            service.save_draft(
                user.organisation_id, story_id, draft, body.updated_at, body.client_id, body.seq
            )
        )
    except StoryNotFoundError:
        raise HTTPException(status_code=404, detail="story not found") from None
    except InvalidContentError as invalid:
        raise HTTPException(
            status_code=422, detail={"message": "content not allowed", "reasons": invalid.reasons}
        ) from None
    except StoryConflictError:
        raise HTTPException(status_code=409, detail="the draft changed elsewhere; reload") from None


@router.post("/{story_id}/publish")
def publish_story(story_id: str, user: Owner, service: Service) -> dict[str, Any]:
    try:
        return detail(service.publish(user.organisation_id, story_id))
    except StoryNotFoundError:
        raise HTTPException(status_code=404, detail="story not found") from None
    except StoryConflictError:
        raise HTTPException(status_code=409, detail="the draft changed elsewhere; retry") from None
    except PublishRefusedError as refused:
        raise HTTPException(
            status_code=422, detail={"message": "publish refused", "reasons": refused.reasons}
        ) from None


def _lifecycle(story_id: str, user: User, run: Any) -> dict[str, Any]:
    """Unpublish, republish and revert. 422 when the story's state does not allow the action
    (the same status publish uses for a refusal, with `reasons`), 409 only when a save or a
    revert landed in between (unpublish and republish keep `updated_at`, so the compare-and-set
    catches only those); either way nothing changed."""
    try:
        return detail(run(user.organisation_id, story_id))
    except StoryNotFoundError:
        raise HTTPException(status_code=404, detail="story not found") from None
    except StoryConflictError:
        raise HTTPException(status_code=409, detail="the draft changed elsewhere; retry") from None
    except TransitionRefusedError as refused:
        raise HTTPException(
            status_code=422, detail={"message": "action not allowed", "reasons": refused.reasons}
        ) from None


@router.post("/{story_id}/unpublish")
def unpublish_story(story_id: str, user: Owner, service: Service) -> dict[str, Any]:
    return _lifecycle(story_id, user, service.unpublish)


@router.post("/{story_id}/republish")
def republish_story(story_id: str, user: Owner, service: Service) -> dict[str, Any]:
    return _lifecycle(story_id, user, service.republish)


@router.post("/{story_id}/revert")
def revert_story(story_id: str, user: Owner, service: Service) -> dict[str, Any]:
    return _lifecycle(story_id, user, service.revert)


def _found(read: Any) -> Story:
    try:
        story: Story = read()
        return story
    except StoryNotFoundError:
        raise HTTPException(status_code=404, detail="story not found") from None


def storage_unavailable_handler(request: Request, exc: Exception) -> JSONResponse:
    """An adapter that does not store stories yet (Postgres, until its follow-up lands).
    Only StorageUnavailableError maps here; any other exception is an ordinary 500."""
    return JSONResponse(status_code=501, content={"detail": "story storage is not available"})
