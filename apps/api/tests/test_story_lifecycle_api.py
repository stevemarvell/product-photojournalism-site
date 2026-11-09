"""Issue #17 through the HTTP API: unpublish, republish and revert, and the refusals.

Refused transitions answer 422 (as a refused publish does) with `reasons`, and change nothing;
409 is kept for a save that landed in between. The public reads after each action are in
tests/test_public_site.py.
"""

from dataclasses import replace
from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient

from api.adapters.memory import InMemoryImageStatusLookup
from api.composition import Container, build_container
from api.domain import ImageStatus, StoryConflictError
from api.main import create_app

ENV = {"IDENTITY_PROVIDER": "stub", "API_ENVIRONMENT": "development", "STORY_REPOSITORY": "memory"}
BODY = {
    "title": "Dusk",
    "description": "A walk",
    "location": "Lisbon",
    "date": "2026-10-31",
    "content": 'Words.\n\n<Photo image="img-1" alt="A street" caption="" credit="" />\n',
}


class TickingClock:
    def __init__(self) -> None:
        self.t = datetime(2026, 11, 9, 12, 0, tzinfo=UTC)

    def now(self) -> datetime:
        self.t += timedelta(minutes=1)
        return self.t


@pytest.fixture
def owner() -> TestClient:
    container: Container = replace(
        build_container(ENV),
        clock=TickingClock(),
        image_status=InMemoryImageStatusLookup({"img-1": ImageStatus.READY}),
    )
    client = TestClient(create_app(container=container))
    assert client.get("/auth/callback", follow_redirects=False).status_code == 303
    return client


def save(client: TestClient, story: dict, **fields: object) -> dict:
    r = client.put(
        f"/stories/{story['id']}/draft", json={**BODY, **fields, "updated_at": story["updated_at"]}
    )
    assert r.status_code == 200, r.text
    return r.json()


def published_story(client: TestClient) -> dict:
    story = save(client, client.post("/stories").json())
    r = client.post(f"/stories/{story['id']}/publish")
    assert r.status_code == 200
    return r.json()


def act(client: TestClient, story: dict, action: str):
    return client.post(f"/stories/{story['id']}/{action}")


# --- Scenario: unpublish ---------------------------------------------------------------


def test_unpublish_a_live_story_keeps_the_published_and_draft_text(owner: TestClient) -> None:
    live = published_story(owner)
    edited = save(owner, live, title="Newer draft")
    r = act(owner, edited, "unpublish")
    assert r.status_code == 200
    out = r.json()
    assert out["live"] is False
    assert out["published"]["title"] == "Dusk" and out["draft"]["title"] == "Newer draft"
    assert out["first_published_at"] == live["first_published_at"]
    assert owner.get(f"/stories/{live['id']}").json() == out


# --- Scenario: republish -----------------------------------------------------------------


def test_republish_goes_live_with_the_published_text_not_the_draft(owner: TestClient) -> None:
    live = published_story(owner)
    edited = save(owner, live, title="Newer draft")
    down = act(owner, edited, "unpublish").json()
    r = act(owner, down, "republish")
    assert r.status_code == 200
    out = r.json()
    assert out["live"] is True
    assert out["published"]["title"] == "Dusk"
    assert out["draft"]["title"] == "Newer draft"
    assert out["first_published_at"] == live["first_published_at"]
    assert out["last_published_at"] == live["last_published_at"]


# --- Scenario: revert --------------------------------------------------------------------


def test_revert_copies_the_published_text_over_the_draft(owner: TestClient) -> None:
    live = published_story(owner)
    edited = save(owner, live, title="Changed", description="Other", location="Rome")
    r = act(owner, edited, "revert")
    assert r.status_code == 200
    out = r.json()
    assert out["draft"] == out["published"] == BODY
    assert out["live"] is True
    assert out["updated_at"] > edited["updated_at"]


def test_a_tab_still_holding_the_old_updated_at_conflicts_after_a_revert(owner: TestClient) -> None:
    live = published_story(owner)
    edited = save(owner, live, title="Changed")
    act(owner, edited, "revert")
    stale = owner.put(
        f"/stories/{live['id']}/draft",
        json={**BODY, "title": "From the old tab", "updated_at": edited["updated_at"]},
    )
    assert stale.status_code == 409
    assert owner.get(f"/stories/{live['id']}").json()["draft"]["title"] == "Dusk"


# --- Scenario: action not allowed ---------------------------------------------------------


def snapshot(client: TestClient, story: dict) -> dict:
    return client.get(f"/stories/{story['id']}").json()


def test_unpublish_is_refused_when_not_live_or_never_published(owner: TestClient) -> None:
    never = save(owner, owner.post("/stories").json())
    down = act(owner, published_story(owner), "unpublish").json()
    for story in (never, down):
        before = snapshot(owner, story)
        r = act(owner, story, "unpublish")
        assert r.status_code == 422
        assert r.json()["detail"]["reasons"]
        assert snapshot(owner, story) == before


def test_republish_is_refused_when_live_or_never_published(owner: TestClient) -> None:
    never = save(owner, owner.post("/stories").json())
    live = published_story(owner)
    for story in (never, live):
        before = snapshot(owner, story)
        r = act(owner, story, "republish")
        assert r.status_code == 422
        assert r.json()["detail"]["reasons"]
        assert snapshot(owner, story) == before


def test_revert_is_refused_when_never_published_or_the_draft_matches(owner: TestClient) -> None:
    never = save(owner, owner.post("/stories").json())
    live = published_story(owner)
    for story in (never, live):
        before = snapshot(owner, story)
        r = act(owner, story, "revert")
        assert r.status_code == 422
        assert snapshot(owner, story) == before


def test_an_unknown_story_is_404_for_each_action(owner: TestClient) -> None:
    for action in ("unpublish", "republish", "revert"):
        assert owner.post(f"/stories/nope/{action}").status_code == 404


# --- A save landing in between: the compare-and-set refuses -------------------------------


class _ConflictOnReplace:
    """The real repository, except that every `replace` loses the race."""

    def __init__(self, inner: object) -> None:
        self._inner = inner

    def __getattr__(self, name: str) -> object:
        return getattr(self._inner, name)

    def replace(self, *args: object, **kwargs: object) -> object:
        raise StoryConflictError("lost the race")


@pytest.mark.parametrize("action", ["unpublish", "republish", "revert"])
def test_a_save_landing_in_between_is_409_and_changes_nothing(action: str) -> None:
    base = build_container(ENV)
    container = replace(
        base,
        clock=TickingClock(),
        image_status=InMemoryImageStatusLookup({"img-1": ImageStatus.READY}),
    )
    client = TestClient(create_app(container=container))
    assert client.get("/auth/callback", follow_redirects=False).status_code == 303
    live = published_story(client)
    story = save(client, live, title="Edited")  # draft differs, so revert would be allowed
    if action == "republish":
        story = act(client, story, "unpublish").json()
    before = snapshot(client, story)

    racing = TestClient(
        create_app(container=replace(container, stories=_ConflictOnReplace(container.stories)))
    )  # type: ignore[arg-type]
    assert racing.get("/auth/callback", follow_redirects=False).status_code == 303
    # The racing app has its own session store; the story lives in the shared repository.
    r = act(racing, story, action)
    assert r.status_code == 409
    assert snapshot(client, story) == before
