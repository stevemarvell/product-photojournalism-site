"""The ImageRepository contract, run against every adapter: organisation scoping, the
conditional replace, upload bindings and the claim that is one step with the row.

The Postgres run needs TEST_DATABASE_URL (it fails rather than skips when CI is set), so a
green verify means the Postgres adapter met exactly these tests.
"""

from collections.abc import Iterator
from datetime import UTC, datetime

import psycopg
import pytest

from api.adapters.memory import InMemoryImageRepository
from api.adapters.postgres import PostgresDatabase
from api.adapters.postgres_images import PostgresImageRepository
from api.application import ImageRepository
from api.domain import ImageStatus, WebVersion, failed, new_image, ready
from conftest import needs_postgres

T0 = datetime(2026, 11, 9, 12, 0, tzinfo=UTC)
URL = "https://store.public.blob.vercel-storage.com/originals/abc"


@pytest.fixture(
    params=[
        pytest.param("memory", id="memory"),
        pytest.param("postgres", id="postgres", marks=needs_postgres),
    ]
)
def repo(request: pytest.FixtureRequest) -> Iterator[ImageRepository]:
    if request.param == "memory":
        yield InMemoryImageRepository()
    else:
        yield PostgresImageRepository(PostgresDatabase(request.getfixturevalue("pg_url")))


def bound(repo: ImageRepository, org: str = "org-a", url: str = URL):  # noqa: ANN201
    repo.bind_upload(org, url)
    return new_image("i1", org, url, 5, T0)


def test_a_created_image_is_read_back_and_scoped_to_its_organisation(repo: ImageRepository) -> None:
    image = new_image("i1", "org-a", "local:orig-x", 5, T0)
    repo.create(image)
    assert repo.get("org-a", "i1") == image
    assert repo.get("org-b", "i1") is None
    assert repo.get("org-a", "other") is None


def test_replace_if_status_only_changes_a_row_in_the_expected_status(repo: ImageRepository) -> None:
    image = new_image("i1", "org-a", "local:orig-x", 5, T0)
    repo.create(image)
    done = ready(image, 10, 5, (WebVersion(480, "https://x/a-480.jpg"), WebVersion(960, "u2")))
    assert repo.replace_if_status("org-a", done, ImageStatus.PROCESSING) is True
    assert repo.get("org-a", "i1") == done  # versions, size and status all round-trip
    # A second writer that still believes it is processing loses.
    assert repo.replace_if_status("org-a", failed(image), ImageStatus.PROCESSING) is False
    assert repo.get("org-a", "i1") == done


def test_replace_if_status_cannot_reach_another_organisations_image(repo: ImageRepository) -> None:
    image = new_image("i1", "org-a", "local:orig-x", 5, T0)
    repo.create(image)
    assert repo.replace_if_status("org-b", failed(image), ImageStatus.PROCESSING) is False
    assert repo.replace_if_status("org-a", failed(image), ImageStatus.READY) is False
    assert repo.get("org-a", "i1") == image


def test_an_upload_is_bound_to_the_organisation_it_was_issued_to(repo: ImageRepository) -> None:
    assert repo.upload_issued_to("org-a", URL) is False  # nothing issued yet
    repo.bind_upload("org-a", URL)
    assert repo.upload_issued_to("org-a", URL) is True
    assert repo.upload_issued_to("org-b", URL) is False
    assert repo.upload_issued_to("org-a", URL + "x") is False


def test_create_claiming_stores_the_row_and_claims_the_upload_once(repo: ImageRepository) -> None:
    image = bound(repo)
    assert repo.create_claiming(image) is True
    assert repo.get("org-a", "i1") == image
    again = new_image("i2", "org-a", URL, 5, T0)
    assert repo.create_claiming(again) is False  # an upload backs exactly one row
    assert repo.get("org-a", "i2") is None


def test_create_claiming_refuses_an_upload_bound_to_another_organisation(
    repo: ImageRepository,
) -> None:
    bound(repo, "org-a")
    assert repo.create_claiming(new_image("i1", "org-b", URL, 5, T0)) is False
    assert repo.get("org-b", "i1") is None
    # org-a's claim was not used up by org-b's attempt.
    assert repo.create_claiming(new_image("i1", "org-a", URL, 5, T0)) is True


def test_create_claiming_refuses_a_url_that_was_never_issued(repo: ImageRepository) -> None:
    assert repo.create_claiming(new_image("i1", "org-a", URL, 5, T0)) is False
    assert repo.get("org-a", "i1") is None


def test_a_row_that_cannot_be_stored_does_not_burn_the_claim(repo: ImageRepository) -> None:
    """The claim and the row are one step: when the row fails, the upload is still claimable."""
    first = bound(repo)
    repo.create(new_image("i1", "org-a", "local:orig-other", 5, T0))  # takes the id "i1"
    with pytest.raises((ValueError, psycopg.errors.UniqueViolation)):  # each adapter's own
        repo.create_claiming(first)
    assert repo.create_claiming(new_image("i2", "org-a", URL, 5, T0)) is True


@needs_postgres
def test_rows_bindings_and_claims_survive_a_restart(pg_url: str) -> None:
    """A new process (a new adapter and connection pool over the same database) sees them."""
    before = PostgresImageRepository(PostgresDatabase(pg_url))
    image = bound(before)
    done = ready(image, 10, 5, (WebVersion(480, "https://x/a-480.jpg"),))
    before.bind_upload("org-a", URL + "-unclaimed")
    assert before.create_claiming(image)
    assert before.replace_if_status("org-a", done, ImageStatus.PROCESSING)

    after = PostgresImageRepository(PostgresDatabase(pg_url))
    assert after.get("org-a", "i1") == done  # the row, with its web versions
    assert after.upload_issued_to("org-a", URL + "-unclaimed")  # a binding not yet claimed
    assert after.upload_issued_to("org-b", URL + "-unclaimed") is False
    assert after.create_claiming(new_image("i9", "org-a", URL, 5, T0)) is False  # the claim stays
    assert after.create_claiming(new_image("i9", "org-a", URL + "-unclaimed", 5, T0)) is True
