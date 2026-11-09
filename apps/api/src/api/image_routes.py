"""Image endpoints (spec section 11), plus the public web-version file route.

Owner: ask for an upload target, register an uploaded original, read an image's status.
The local upload endpoint is only added to the app when the container enables it
(composition: never when VERCEL_ENV is set). Public: web versions only, by key.
"""

import re
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field

from api.application import ImageService
from api.domain import (
    ImageNotFoundError,
    ImageRecord,
    ImageRefusedError,
    ImageTooLargeError,
    ImageUploadsUnavailableError,
    User,
)
from api.guard import container_of, require_owner

# A web version's key: "<image uuid>-<width>.jpg". An original's key starts "orig-", so
# it can never match, and the route below has no other way to read a file.
WEB_KEY = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-\d{2,5}\.jpg")


class TargetBody(BaseModel):
    size: int = Field(ge=0)


class RegisterBody(BaseModel):
    original_url: str = Field(min_length=1, max_length=2000)


def service_of(request: Request) -> ImageService:
    return container_of(request).image_service


Service = Annotated[ImageService, Depends(service_of)]
Owner = Annotated[User, Depends(require_owner)]

router = APIRouter(prefix="/images", dependencies=[Depends(require_owner)])
public_router = APIRouter(prefix="/public/images")
local_upload_router = APIRouter(prefix="/images/uploads", dependencies=[Depends(require_owner)])


def owner_view(image: ImageRecord) -> dict[str, Any]:
    """What the editor sees. Deliberately without `original_url`: the browser has no use for
    it after registering, so it is not sent back, and no response can leak it by accident."""
    return {
        "id": image.id,
        "status": image.status.value,
        "web_versions": [{"width": v.width, "url": v.url} for v in image.web_versions],
        "width": image.width,
        "height": image.height,
        "byte_size": image.byte_size,
    }


def _too_large(limit: int) -> HTTPException:
    return HTTPException(
        status_code=413,
        detail={"message": f"file is over the {limit}-byte limit", "limit": limit},
    )


@router.post("/upload-target")
def upload_target(body: TargetBody, user: Owner, service: Service) -> dict[str, Any]:
    try:
        target = service.upload_target(user.organisation_id, body.size)
    except ImageTooLargeError as e:
        raise _too_large(e.limit) from None
    except ImageUploadsUnavailableError:
        raise HTTPException(status_code=503, detail="image uploads are not configured") from None
    return {
        "upload_url": target.upload_url,
        "original_url": target.original_url,
        "method": target.method,
        "max_bytes": service.max_bytes,
    }


@router.post("", status_code=201)
def register_image(body: RegisterBody, user: Owner, service: Service) -> dict[str, Any]:
    try:
        return owner_view(service.register(user.organisation_id, body.original_url))
    except ImageTooLargeError as e:
        raise _too_large(e.limit) from None
    except ImageRefusedError:
        raise HTTPException(status_code=422, detail="that is not an uploaded original") from None


@router.get("/{image_id}")
def get_image(image_id: str, user: Owner, service: Service) -> dict[str, Any]:
    try:
        return owner_view(service.get(user.organisation_id, image_id))
    except ImageNotFoundError:
        raise HTTPException(status_code=404, detail="image not found") from None


@local_upload_router.put("/{token}", status_code=204)
async def upload_original(token: str, request: Request, user: Owner) -> Response:
    """Local stand-in for the browser's direct upload to Blob. Owner only, and only mounted
    when composition enabled it; the second check is for a container built by hand."""
    container = container_of(request)
    uploads = container.local_uploads
    if uploads is None:
        raise HTTPException(status_code=404, detail="not found")
    limit = container.image_service.max_bytes
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > limit:
        raise _too_large(limit)
    received = bytearray()
    async for chunk in request.stream():
        received.extend(chunk)
        if len(received) > limit:  # a client may lie about, or omit, its length
            raise _too_large(limit)
    if not uploads.accept(token, bytes(received)):
        raise HTTPException(status_code=404, detail="unknown or used upload target")
    return Response(status_code=204)


@public_router.get("/{key}")
def web_version(key: str, request: Request) -> Response:
    """A web version's bytes. Only keys of the web-version form are served; an original's
    key (and anything else) is a plain 404."""
    if not WEB_KEY.fullmatch(key):
        raise HTTPException(status_code=404, detail="not found")
    data = container_of(request).images.get(key)
    if data is None:
        raise HTTPException(status_code=404, detail="not found")
    return Response(
        content=data,
        media_type="image/jpeg",
        headers={"Cache-Control": "public, max-age=31536000, immutable"},
    )
