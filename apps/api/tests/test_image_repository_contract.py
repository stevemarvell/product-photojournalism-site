"""The ImageRepository contract: organisation scoping and the conditional replace."""

from datetime import UTC, datetime

from api.adapters.memory import InMemoryImageRepository
from api.domain import ImageStatus, failed, new_image, ready

T0 = datetime(2026, 11, 9, 12, 0, tzinfo=UTC)


def test_a_created_image_is_read_back_and_scoped_to_its_organisation() -> None:
    repo = InMemoryImageRepository()
    image = new_image("i1", "org-a", "local:orig-x", 5, T0)
    repo.create(image)
    assert repo.get("org-a", "i1") == image
    assert repo.get("org-b", "i1") is None
    assert repo.get("org-a", "other") is None


def test_replace_if_status_only_changes_a_row_in_the_expected_status() -> None:
    repo = InMemoryImageRepository()
    image = new_image("i1", "org-a", "local:orig-x", 5, T0)
    repo.create(image)
    done = ready(image, 10, 5, ())
    assert repo.replace_if_status("org-a", done, ImageStatus.PROCESSING) is True
    assert repo.get("org-a", "i1") == done
    # A second writer that still believes it is processing loses.
    assert repo.replace_if_status("org-a", failed(image), ImageStatus.PROCESSING) is False
    assert repo.get("org-a", "i1") == done


def test_replace_if_status_cannot_reach_another_organisations_image() -> None:
    repo = InMemoryImageRepository()
    image = new_image("i1", "org-a", "local:orig-x", 5, T0)
    repo.create(image)
    assert repo.replace_if_status("org-b", failed(image), ImageStatus.PROCESSING) is False
    assert repo.get("org-a", "i1") == image
