"""The public site's reads (spec section 11), anonymous: only the published text of live
stories. Thin: call PublicSite, shape the answer.

The paths say `pieces`, not `stories`: the browser calls them as `/api/public/pieces`, and
the public site never carries the word "story" in anything a visitor can see (spec
section 8). No answer holds a draft field or an original's URL.

Every answer is `Cache-Control: no-store` (`NoStorePublic`): the pages are rendered in the
browser from a fresh fetch, so Publish, Unpublish and Republish show on the next load.
"""

import logging
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse
from starlette.datastructures import MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from api.application import PublicPhoto, PublicSite, PublicSummary
from api.domain import MVP_ORGANISATION_ID, StoryNotFoundError
from api.guard import container_of

log = logging.getLogger(__name__)

PREFIX = "/public/pieces"

router = APIRouter(prefix=PREFIX)


class NoStorePublic:
    """`Cache-Control: no-store` on every /public/pieces response, whatever produced it
    (a page, a 404, the 503 of unreachable storage, and an unhandled error: the
    500 is made here, inside the outer error handler, so that it carries the header too)."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        path = scope.get("path", "")
        if scope["type"] != "http" or not (path == PREFIX or path.startswith(PREFIX + "/")):
            await self.app(scope, receive, send)
            return

        async def send_no_store(message: Message) -> None:
            if message["type"] == "http.response.start":
                MutableHeaders(scope=message)["cache-control"] = "no-store"
            await send(message)

        started = False

        async def tracked(message: Message) -> None:
            nonlocal started
            started = started or message["type"] == "http.response.start"
            await send_no_store(message)

        try:
            await self.app(scope, receive, tracked)
        except Exception:
            log.exception("unhandled error under %s", PREFIX)
            if started:
                raise
            response = JSONResponse({"detail": "internal error"}, status_code=500)
            await response(scope, receive, send_no_store)


def site_of(request: Request) -> PublicSite:
    c = container_of(request)
    return PublicSite(c.stories, c.image_service)


def _photo(photo: PublicPhoto) -> dict[str, Any]:
    # Web versions only: `PublicPhoto` has no field that could hold an original's URL.
    return {
        "image_id": photo.image_id,
        "alt": photo.alt,
        "caption": photo.caption,
        "credit": photo.credit,
        "width": photo.width,
        "height": photo.height,
        "versions": [{"width": v.width, "url": v.url} for v in photo.versions],
    }


def _summary(s: PublicSummary) -> dict[str, Any]:
    return {
        "id": s.id,
        "title": s.title,
        "description": s.description,
        "location": s.location,
        "date": s.date.isoformat() if s.date else None,
        "first_published_at": s.first_published_at,
        "hero": _photo(s.hero) if s.hero else None,
    }


@router.get("")
def list_pieces(request: Request) -> list[dict[str, Any]]:
    # Anonymous, so no user to take an organisation from: the one the MVP has.
    return [_summary(s) for s in site_of(request).list_live(MVP_ORGANISATION_ID)]


@router.get("/{piece_id}")
def get_piece(piece_id: str, request: Request) -> dict[str, Any]:
    try:
        piece = site_of(request).get_live(MVP_ORGANISATION_ID, piece_id)
    except StoryNotFoundError:
        raise HTTPException(status_code=404, detail="not found") from None
    return {
        **_summary(piece.summary),
        "content": piece.content,
        "photos": {
            image_id: {k: v for k, v in _photo(p).items() if k != "image_id"}
            for image_id, p in piece.photos.items()
        },
    }
