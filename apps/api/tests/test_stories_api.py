"""Scenarios of issue #13 through the HTTP API, on the in-memory adapters and stub sign-in.

The images are faked by an InMemoryImageStatusLookup that marks chosen ids ready (the real
lookup arrives with the image pipeline, #15).
"""

from dataclasses import replace
from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient

from api.adapters.memory import InMemoryImageStatusLookup, InMemoryStoryRepository
from api.composition import Container, build_container
from api.domain import OWNER, ImageStatus, User, new_story
from api.main import create_app

ENV = {"IDENTITY_PROVIDER": "stub", "API_ENVIRONMENT": "development", "STORY_REPOSITORY": "memory"}
PHOTO = '<Photo image="img-1" alt="A street at dusk" caption="Evening" />'
COMPLETE = {
    "title": "Dusk",
    "description": "A walk",
    "location": "Lisbon",
    "date": "2026-10-31",
    "content": f"Words.\n\n{PHOTO}\n",
}


class TickingClock:
    """Each reading is a minute later, so successive saves have distinct times."""

    def __init__(self) -> None:
        self.t = datetime(2026, 11, 9, 12, 0, tzinfo=UTC)

    def now(self) -> datetime:
        self.t += timedelta(minutes=1)
        return self.t


def make_container(ready: tuple[str, ...] = ("img-1",)) -> Container:
    return replace(
        build_container(ENV),
        clock=TickingClock(),
        image_status=InMemoryImageStatusLookup({i: ImageStatus.READY for i in ready}),
    )


def signed_in_client(container: Container | None = None) -> TestClient:
    client = TestClient(create_app(container=container or make_container()))
    assert client.get("/auth/callback", follow_redirects=False).status_code == 303
    return client


def create(client: TestClient) -> dict:
    r = client.post("/stories")
    assert r.status_code == 201
    return r.json()


def save(client: TestClient, story: dict, **fields: object):
    body = {**COMPLETE, **fields, "updated_at": fields.pop("updated_at", story["updated_at"])}
    return client.put(f"/stories/{story['id']}/draft", json=body)


# --- Scenario: create a story --------------------------------------------------


def test_create_a_story_gives_an_empty_unpublished_draft() -> None:
    client = signed_in_client()
    story = create(client)
    assert story["draft"] == {
        "title": "",
        "description": "",
        "location": "",
        "date": None,
        "content": "",
    }
    assert story["published"] is None
    assert story["live"] is False
    assert story["first_published_at"] is None
    assert story["last_published_at"] is None
    assert client.get(f"/stories/{story['id']}").json() == story


def test_creating_without_signing_in_is_401_and_creates_nothing() -> None:
    container = make_container()
    client = TestClient(create_app(container=container))
    assert client.post("/stories").status_code == 401
    assert container.stories.list(OWNER.organisation_id) == []


# --- Scenario: autosave the draft ----------------------------------------------


def test_autosave_stores_the_draft_leaves_published_alone_and_returns_a_new_updated_at() -> None:
    client = signed_in_client()
    story = create(client)
    r = save(client, story)
    assert r.status_code == 200
    saved = r.json()
    assert saved["draft"] == COMPLETE
    assert saved["published"] is None
    assert saved["updated_at"] != story["updated_at"]
    assert client.get(f"/stories/{story['id']}").json() == saved


def test_consecutive_autosaves_each_using_the_returned_updated_at_succeed() -> None:
    client = signed_in_client()
    story = create(client)
    for n in range(3):
        story = save(client, story, title=f"v{n}").json()
    assert story["draft"]["title"] == "v2"


# --- Scenario: autosave conflict -----------------------------------------------


def test_autosave_with_an_old_updated_at_is_409_and_overwrites_nothing() -> None:
    client = signed_in_client()
    story = create(client)
    other_tab = save(client, story, title="from the other tab")
    assert other_tab.status_code == 200

    stale = save(client, story, title="from this tab")  # still holds the first updated_at
    assert stale.status_code == 409
    assert client.get(f"/stories/{story['id']}").json() == other_tab.json()


def test_a_malformed_updated_at_or_oversized_field_is_422() -> None:
    client = signed_in_client()
    story = create(client)
    assert save(client, story, updated_at="yesterday").status_code == 422
    assert save(client, story, title="x" * 301).status_code == 422
    assert client.get(f"/stories/{story['id']}").json() == story


def test_saving_or_reading_a_story_that_does_not_exist_is_404() -> None:
    client = signed_in_client()
    story = create(client)
    assert client.get("/stories/nope").status_code == 404
    assert (
        client.put(
            "/stories/nope/draft", json={**COMPLETE, "updated_at": story["updated_at"]}
        ).status_code
        == 404
    )
    assert client.post("/stories/nope/publish").status_code == 404


# --- Scenario: publish ---------------------------------------------------------


def test_publish_copies_the_draft_sets_live_and_both_dates() -> None:
    client = signed_in_client()
    story = create(client)
    saved = save(client, story).json()

    r = client.post(f"/stories/{story['id']}/publish")
    assert r.status_code == 200
    out = r.json()
    assert out["live"] is True
    assert out["published"] == COMPLETE == out["draft"]
    assert out["first_published_at"] is not None
    assert out["last_published_at"] == out["first_published_at"]
    assert out["updated_at"] != saved["updated_at"]
    assert client.get(f"/stories/{story['id']}").json() == out


def test_republishing_keeps_first_published_at_and_moves_last_published_at() -> None:
    client = signed_in_client()
    story = create(client)
    save(client, story)
    first = client.post(f"/stories/{story['id']}/publish").json()
    edited = save(client, first, title="Dusk, revised").json()
    second = client.post(f"/stories/{story['id']}/publish").json()
    assert edited["published"]["title"] == "Dusk"
    assert second["published"]["title"] == "Dusk, revised"
    assert second["first_published_at"] == first["first_published_at"]
    assert second["last_published_at"] > first["last_published_at"]


# --- Scenario: publish refused -------------------------------------------------


@pytest.mark.parametrize(
    ("fields", "reason"),
    [
        ({"title": ""}, "title is required"),
        ({"description": ""}, "description is required"),
        ({"content": "No photo here."}, "at least one Photo block is required"),
        ({"content": '<Photo image="img-1" alt="" />'}, "Photo 1 has no alt text"),
        ({"content": '<Photo image="img-2" alt="x" />'}, "Photo 1: image img-2 is not ready"),
    ],
)
def test_a_draft_that_fails_the_rule_is_422_with_the_reason_and_nothing_changes(
    fields: dict[str, str], reason: str
) -> None:
    client = signed_in_client()
    story = create(client)
    saved = save(client, story, **fields).json()

    r = client.post(f"/stories/{story['id']}/publish")
    assert r.status_code == 422
    assert reason in r.json()["detail"]["reasons"]
    assert client.get(f"/stories/{story['id']}").json() == saved
    assert saved["live"] is False and saved["published"] is None


def test_an_image_the_lookup_does_not_know_fails_the_rule() -> None:
    # The default lookup (no pipeline yet) knows no image: nothing can be published.
    client = signed_in_client(replace(make_container(), image_status=InMemoryImageStatusLookup()))
    story = create(client)
    save(client, story)
    r = client.post(f"/stories/{story['id']}/publish")
    assert r.status_code == 422
    assert r.json()["detail"]["reasons"] == ["Photo 1: image img-1 is not ready"]


def test_a_failed_republish_leaves_the_live_story_as_it_was() -> None:
    client = signed_in_client()
    story = create(client)
    save(client, story)
    live = client.post(f"/stories/{story['id']}/publish").json()
    broken = save(client, live, title="").json()
    assert client.post(f"/stories/{story['id']}/publish").status_code == 422
    after = client.get(f"/stories/{story['id']}").json()
    assert after == broken
    assert after["live"] is True and after["published"]["title"] == "Dusk"


# --- Scenario: editing a live story --------------------------------------------


def test_autosaving_a_live_story_leaves_published_text_and_live_until_publish() -> None:
    client = signed_in_client()
    story = create(client)
    save(client, story)
    live = client.post(f"/stories/{story['id']}/publish").json()

    edited = save(client, live, title="Half-written", content="Only words now.").json()
    assert edited["live"] is True
    assert edited["published"] == live["published"]
    assert edited["draft"]["title"] == "Half-written"
    assert edited["first_published_at"] == live["first_published_at"]
    assert edited["last_published_at"] == live["last_published_at"]


# --- Scenario: every query is filtered by organisation -------------------------


def test_one_organisations_owner_never_sees_anothers_stories() -> None:
    container = make_container()
    foreign = new_story("foreign-1", "someone-elses-org", datetime(2026, 1, 1, tzinfo=UTC))
    container.stories.create(foreign)
    client = signed_in_client(container)
    mine = create(client)

    listed = client.get("/stories").json()
    assert [s["id"] for s in listed] == [mine["id"]]
    assert client.get("/stories/foreign-1").status_code == 404
    body = {**COMPLETE, "updated_at": foreign.updated_at.isoformat()}
    assert client.put("/stories/foreign-1/draft", json=body).status_code == 404
    assert client.post("/stories/foreign-1/publish").status_code == 404
    assert container.stories.get("someone-elses-org", "foreign-1") == foreign


# --- Owner list order -----------------------------------------------------------


def test_the_list_puts_never_published_first_then_first_published_newest_first() -> None:
    client = signed_in_client()
    ids = []
    for _ in range(4):
        ids.append(create(client)["id"])
    # Publish 0, then 2 (so 2 was first published later); 1 and 3 stay drafts.
    for n in (0, 2):
        story = client.get(f"/stories/{ids[n]}").json()
        save(client, story)
        assert client.post(f"/stories/{ids[n]}/publish").status_code == 200
    # Republishing 0 must not move it: ordering is by FIRST publication.
    story0 = client.get(f"/stories/{ids[0]}").json()
    save(client, story0, title="again")
    client.post(f"/stories/{ids[0]}/publish")

    listed = client.get("/stories").json()
    assert [s["id"] for s in listed] == [ids[3], ids[1], ids[2], ids[0]]
    assert {"id", "live", "title", "first_published_at", "last_published_at"} <= set(listed[0])


# --- Not-built storage and non-owners ------------------------------------------


def test_an_unrelated_not_implemented_error_is_a_500_not_a_501() -> None:
    class Broken(InMemoryStoryRepository):
        def list(self, organisation_id: str):
            raise NotImplementedError("some other bug")

    client = TestClient(
        create_app(container=replace(make_container(), stories=Broken())),
        raise_server_exceptions=False,
    )
    client.get("/auth/callback", follow_redirects=False)
    assert client.get("/stories").status_code == 500


def test_an_adapter_that_cannot_store_stories_yet_answers_501_not_a_crash() -> None:
    from api.adapters.postgres import PostgresStoryRepository

    container = replace(
        make_container(), stories=PostgresStoryRepository("postgresql://x@127.0.0.1:1/y")
    )
    client = signed_in_client(container)
    assert client.get("/stories").status_code == 501
    assert client.post("/stories").status_code == 501


def test_a_signed_in_user_who_is_not_the_owner_cannot_use_story_endpoints() -> None:
    class Editor:
        def sign_in_available(self) -> bool:
            return True

        def current_user(self, session):
            return User(id="e", name="Editor", is_owner=False, organisation_id="owner-org")

        def begin_sign_in(self, session, redirect_uri):
            return redirect_uri

        def complete_sign_in(self, session, redirect_uri, params):
            return self.current_user(session)

        def sign_out(self, session):
            session.clear()

    container = replace(make_container(), identity=Editor(), stories=InMemoryStoryRepository())
    client = signed_in_client(container)
    assert client.post("/stories").status_code == 403
    assert client.get("/stories").status_code == 403
    assert container.stories.list("owner-org") == []


def test_a_tab_may_supersede_its_own_in_flight_save_from_the_same_base() -> None:
    client = signed_in_client()
    story = create(client)
    a = save(client, story, title="A", client_id="tab-1")
    assert a.status_code == 200
    b = save(client, story, title="B", client_id="tab-1")  # same base as A, same tab
    assert b.status_code == 200
    assert client.get(f"/stories/{story['id']}").json()["draft"]["title"] == "B"


def test_another_client_with_the_old_base_is_refused_and_the_text_is_kept() -> None:
    client = signed_in_client()
    story = create(client)
    assert save(client, story, title="A", client_id="tab-1").status_code == 200
    other = save(client, story, title="B", client_id="tab-2")
    assert other.status_code == 409
    no_id = save(client, story, title="C")
    assert no_id.status_code == 409
    assert client.get(f"/stories/{story['id']}").json()["draft"]["title"] == "A"
