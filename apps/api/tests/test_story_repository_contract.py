"""One contract every StoryRepository adapter must meet, run against each adapter.

The Postgres parametrisation is skipped, with its reason stated, until the Postgres story
adapter exists: it must never pass silently by not running.
"""

from collections.abc import Callable
from datetime import UTC, datetime, timedelta

import pytest

from api.adapters.memory import InMemoryStoryRepository
from api.adapters.postgres import PostgresStoryRepository
from api.application import StoryRepository
from api.domain import (
    DraftFields,
    StorageUnavailableError,
    StoryConflictError,
    StoryNotFoundError,
    new_story,
    with_draft,
)

T0 = datetime(2026, 11, 9, 12, 0, tzinfo=UTC)

ADAPTERS = [
    pytest.param(InMemoryStoryRepository, id="memory"),
    pytest.param(
        None,
        id="postgres",
        marks=pytest.mark.skip(reason="Postgres story adapter: follow-up issue"),
    ),
]


@pytest.fixture(params=ADAPTERS)
def repo(request: pytest.FixtureRequest) -> StoryRepository:
    make: Callable[[], StoryRepository] = request.param
    return make()


def test_a_created_story_is_read_back_unchanged(repo: StoryRepository) -> None:
    story = new_story("s1", "org-a", T0)
    repo.create(story)
    assert repo.get("org-a", "s1") == story


def test_an_unknown_id_reads_as_none(repo: StoryRepository) -> None:
    assert repo.get("org-a", "missing") is None


def test_creating_the_same_id_twice_is_refused(repo: StoryRepository) -> None:
    repo.create(new_story("s1", "org-a", T0))
    with pytest.raises(ValueError, match="already exists"):
        repo.create(new_story("s1", "org-a", T0))


def test_listing_and_reading_never_cross_organisations(repo: StoryRepository) -> None:
    repo.create(new_story("a1", "org-a", T0))
    repo.create(new_story("a2", "org-a", T0))
    repo.create(new_story("b1", "org-b", T0))

    assert {s.id for s in repo.list("org-a")} == {"a1", "a2"}
    assert {s.id for s in repo.list("org-b")} == {"b1"}
    assert repo.list("org-c") == []
    assert repo.get("org-a", "b1") is None
    assert repo.get("org-b", "a1") is None


def test_the_same_id_in_two_organisations_is_two_stories(repo: StoryRepository) -> None:
    repo.create(new_story("same", "org-a", T0))
    repo.create(new_story("same", "org-b", T0 + timedelta(days=1)))
    a, b = repo.get("org-a", "same"), repo.get("org-b", "same")
    assert a is not None and b is not None
    assert a.created_at != b.created_at


def test_replace_stores_the_new_version_when_updated_at_matches(repo: StoryRepository) -> None:
    story = new_story("s1", "org-a", T0)
    repo.create(story)
    edited = with_draft(story, DraftFields(title="T"), T0 + timedelta(minutes=1))
    assert repo.replace("org-a", edited, expected_updated_at=story.updated_at) == edited
    assert repo.get("org-a", "s1") == edited


def test_replace_with_a_stale_updated_at_conflicts_and_changes_nothing(
    repo: StoryRepository,
) -> None:
    story = new_story("s1", "org-a", T0)
    repo.create(story)
    other_tab = with_draft(story, DraftFields(title="other tab"), T0 + timedelta(minutes=1))
    repo.replace("org-a", other_tab, expected_updated_at=story.updated_at)

    mine = with_draft(story, DraftFields(title="mine"), T0 + timedelta(minutes=2))
    with pytest.raises(StoryConflictError):
        repo.replace("org-a", mine, expected_updated_at=story.updated_at)
    assert repo.get("org-a", "s1") == other_tab


def test_replace_of_a_missing_story_or_another_organisations_is_not_found(
    repo: StoryRepository,
) -> None:
    story = new_story("s1", "org-a", T0)
    repo.create(story)
    edited = with_draft(story, DraftFields(title="x"), T0 + timedelta(minutes=1))
    with pytest.raises(StoryNotFoundError):
        repo.replace("org-b", edited, expected_updated_at=story.updated_at)
    with pytest.raises(StoryNotFoundError):
        repo.replace("org-a", new_story("ghost", "org-a", T0), expected_updated_at=T0)
    assert repo.get("org-a", "s1") == story


def test_the_postgres_adapter_does_not_pretend_to_store_stories_yet() -> None:
    # Not skipped: until the follow-up lands, a deployed default must fail loudly, not quietly.
    postgres = PostgresStoryRepository("postgresql://x:y@127.0.0.1:1/z")
    with pytest.raises(StorageUnavailableError, match="Postgres story adapter: follow-up issue"):
        postgres.list("org-a")
    with pytest.raises(StorageUnavailableError):
        postgres.get("org-a", "s1")
    with pytest.raises(StorageUnavailableError):
        postgres.create(new_story("s1", "org-a", T0))
    with pytest.raises(StorageUnavailableError):
        postgres.replace("org-a", new_story("s1", "org-a", T0), expected_updated_at=T0)


def test_the_same_client_may_supersede_its_own_last_save_from_the_same_base(
    repo: StoryRepository,
) -> None:
    story = new_story("s1", "org-a", T0)
    repo.create(story)
    base = story.updated_at
    a = with_draft(story, DraftFields(title="A"), T0 + timedelta(minutes=1), "tab-1", base, 1)
    repo.replace("org-a", a, expected_updated_at=base, client_id="tab-1", seq=1)
    b = with_draft(a, DraftFields(title="B"), T0 + timedelta(minutes=2), "tab-1", base, 2)
    assert repo.replace("org-a", b, expected_updated_at=base, client_id="tab-1", seq=2) == b
    assert repo.get("org-a", "s1") == b
    assert b.last_saved_by == "tab-1" and b.previous_updated_at == base


def test_another_client_with_the_old_base_still_conflicts(repo: StoryRepository) -> None:
    story = new_story("s1", "org-a", T0)
    repo.create(story)
    base = story.updated_at
    a = with_draft(story, DraftFields(title="A"), T0 + timedelta(minutes=1), "tab-1", base, 1)
    repo.replace("org-a", a, expected_updated_at=base, client_id="tab-1", seq=1)
    b = with_draft(a, DraftFields(title="B"), T0 + timedelta(minutes=2), "tab-2", base, 2)
    with pytest.raises(StoryConflictError):
        repo.replace("org-a", b, expected_updated_at=base, client_id="tab-2", seq=2)
    with pytest.raises(StoryConflictError):
        repo.replace("org-a", b, expected_updated_at=base)
    assert repo.get("org-a", "s1") == a


def test_an_older_save_of_the_same_client_does_not_overwrite_a_newer_one(
    repo: StoryRepository,
) -> None:
    story = new_story("s1", "org-a", T0)
    repo.create(story)
    base = story.updated_at
    b = with_draft(story, DraftFields(title="B"), T0 + timedelta(minutes=1), "tab-1", base, 2)
    repo.replace("org-a", b, expected_updated_at=base, client_id="tab-1", seq=2)
    a = with_draft(b, DraftFields(title="A"), T0 + timedelta(minutes=2), "tab-1", base, 1)
    with pytest.raises(StoryConflictError):
        repo.replace("org-a", a, expected_updated_at=base, client_id="tab-1", seq=1)
    assert repo.get("org-a", "s1") == b
