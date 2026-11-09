"""The image record (spec section 4) and the rules about its life."""

from dataclasses import dataclass, replace
from datetime import datetime, timedelta

from api.domain.models import ImageStatus

# The widths of the web versions, smallest first. A version is never wider than the
# original: an original narrower than a width gets no version of that width.
WEB_WIDTHS = (480, 960, 1600, 2400)


@dataclass(frozen=True)
class WebVersion:
    width: int
    url: str


@dataclass(frozen=True)
class ImageRecord:
    """One image row. `original_url` is private: it appears in no public response.
    `web_versions`, `width` and `height` are set only once the status is ready."""

    id: str
    organisation_id: str
    status: ImageStatus
    original_url: str
    byte_size: int
    created_at: datetime
    web_versions: tuple[WebVersion, ...] = ()
    width: int | None = None
    height: int | None = None


def new_image(
    image_id: str, organisation_id: str, original_url: str, byte_size: int, now: datetime
) -> ImageRecord:
    return ImageRecord(
        image_id, organisation_id, ImageStatus.PROCESSING, original_url, byte_size, now
    )


def ready(
    image: ImageRecord, width: int, height: int, versions: tuple[WebVersion, ...]
) -> ImageRecord:
    return replace(
        image, status=ImageStatus.READY, width=width, height=height, web_versions=versions
    )


def failed(image: ImageRecord) -> ImageRecord:
    return replace(image, status=ImageStatus.FAILED, web_versions=(), width=None, height=None)


def timed_out(image: ImageRecord, now: datetime, timeout: timedelta) -> bool:
    """True for an image still processing after `timeout` (spec section 9, step 3)."""
    return image.status is ImageStatus.PROCESSING and now - image.created_at > timeout
