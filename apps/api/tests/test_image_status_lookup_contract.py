"""One contract for every ImageStatusLookup, run against the test fake and the real lookup.

The publish rule asks `status(organisation_id, image_id)`; whatever answers must say None
for an image it does not know, and never reveal another organisation's image.
"""

from collections.abc import Callable
from datetime import UTC, datetime, timedelta

import pytest

from api.adapters.filesystem import UnconfiguredOriginalUploads
from api.adapters.memory import InMemoryImageRepository, InMemoryImageStatusLookup
from api.application import ImageService, ImageStatusLookup
from api.domain import ImageStatus, failed, new_image, ready

T0 = datetime(2026, 11, 9, 12, 0, tzinfo=UTC)


class Clock:
    def now(self) -> datetime:
        return T0


class Idle:
    def enqueue(self, organisation_id: str, image_id: str) -> None:
        pass


def fake(rows: dict[tuple[str, str], ImageStatus]) -> ImageStatusLookup:
    return InMemoryImageStatusLookup({i: s for (_, i), s in rows.items() if _ == "org-a"})


def real(rows: dict[tuple[str, str], ImageStatus]) -> ImageStatusLookup:
    repo = InMemoryImageRepository()
    for (org, image_id), status in rows.items():
        row = new_image(image_id, org, "local:orig-x", 10, T0)
        if status is ImageStatus.READY:
            row = ready(row, 10, 10, ())
        elif status is ImageStatus.FAILED:
            row = failed(row)
        repo.create(row)
    return ImageService(
        repo, UnconfiguredOriginalUploads(), Idle(), Clock(), max_bytes=1, timeout=timedelta(60)
    )


@pytest.fixture(params=[pytest.param(fake, id="fake"), pytest.param(real, id="real")])
def lookup(request: pytest.FixtureRequest) -> ImageStatusLookup:
    make: Callable[[dict], ImageStatusLookup] = request.param
    return make(
        {
            ("org-a", "r"): ImageStatus.READY,
            ("org-a", "p"): ImageStatus.PROCESSING,
            ("org-a", "f"): ImageStatus.FAILED,
            ("org-b", "theirs"): ImageStatus.READY,
        }
    )


def test_it_reports_each_status(lookup: ImageStatusLookup) -> None:
    assert lookup.status("org-a", "r") is ImageStatus.READY
    assert lookup.status("org-a", "p") is ImageStatus.PROCESSING
    assert lookup.status("org-a", "f") is ImageStatus.FAILED


def test_an_unknown_image_is_none(lookup: ImageStatusLookup) -> None:
    assert lookup.status("org-a", "missing") is None


def test_another_organisations_image_is_none(lookup: ImageStatusLookup) -> None:
    assert lookup.status("org-a", "theirs") is None
