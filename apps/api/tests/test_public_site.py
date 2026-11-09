"""Scenarios of issue #16 through the HTTP API: the public reads of live, published text.

Stories are made the way the owner makes them (stub sign-in, draft, publish). Images are
seeded as ready rows in the in-memory image repository, each with an original URL that
carries a marker, so a leak of the original is found by searching every public answer.
"""

import json
from dataclasses import replace
from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient

from api.adapters.filesystem import UnconfiguredOriginalUploads
from api.adapters.memory import InMemoryImageRepository
from api.application import ImageService, PublicSite
from api.composition import Container, build_container
from api.domain import (
    MVP_ORGANISATION_ID,
    ImageRecord,
    ImageStatus,
    WebVersion,
    new_story,
    unescape_attr,
)
from api.main import create_app

ENV = {"IDENTITY_PROVIDER": "stub", "API_ENVIRONMENT": "development", "STORY_REPOSITORY": "memory"}
ORIGINAL_MARKER = "ORIGINAL-SECRET-PATH"
DRAFT_MARKER = "DRAFT-ONLY-WORDS"
T0 = datetime(2026, 11, 9, 12, 0, tzinfo=UTC)


class TickingClock:
    def __init__(self) -> None:
        self.t = T0

    def now(self) -> datetime:
        self.t += timedelta(minutes=1)
        return self.t


class NeverProcessor:
    def enqueue(self, organisation_id: str, image_id: str) -> None:  # pragma: no cover
        pass


def seed_image(
    repo: InMemoryImageRepository,
    image_id: str,
    *,
    status: ImageStatus = ImageStatus.READY,
    org: str = MVP_ORGANISATION_ID,
) -> None:
    ready = status is ImageStatus.READY
    repo.create(
        ImageRecord(
            id=image_id,
            organisation_id=org,
            status=status,
            original_url=f"local://orig-{ORIGINAL_MARKER}-{image_id}",
            byte_size=1000,
            created_at=T0,
            web_versions=tuple(
                WebVersion(w, f"/public/images/{image_id}-{w}.jpg") for w in (480, 960)
            )
            if ready
            else (),
            width=960 if ready else None,
            height=640 if ready else None,
        )
    )


def make_container() -> tuple[Container, InMemoryImageRepository]:
    images = InMemoryImageRepository()
    clock = TickingClock()
    service = ImageService(
        images,
        UnconfiguredOriginalUploads(),
        NeverProcessor(),
        clock,
        max_bytes=10_000,
        timeout=timedelta(hours=1),
    )
    for n in (1, 2, 3):
        seed_image(images, f"img-{n}")
    container = replace(
        build_container(ENV), clock=clock, image_service=service, image_status=service
    )
    return container, images


@pytest.fixture
def world() -> tuple[Container, InMemoryImageRepository, TestClient, TestClient]:
    """The container, its image repository, an owner's client and an anonymous client."""
    container, images = make_container()
    app = create_app(container=container)
    owner = TestClient(app)
    assert owner.get("/auth/callback", follow_redirects=False).status_code == 303
    return container, images, owner, TestClient(app)


def photo(image: str, alt: str = "A street", caption: str = "", credit: str = "") -> str:
    return f'<Photo image="{image}" alt="{alt}" caption="{caption}" credit="{credit}" />'


DUSK_PHOTO = photo("img-1", "A street at dusk", "Evening", "A. Photographer")


def draft_body(**fields: object) -> dict:
    return {
        "title": "Dusk",
        "description": "A walk at dusk",
        "location": "Lisbon",
        "date": "2026-10-31",
        "content": f"First words.\n\n{DUSK_PHOTO}\n",
        **fields,
    }


def make_piece(owner: TestClient, publish: bool = True, **fields: object) -> str:
    story = owner.post("/stories").json()
    saved = owner.put(
        f"/stories/{story['id']}/draft",
        json={**draft_body(**fields), "updated_at": story["updated_at"]},
    )
    assert saved.status_code == 200, saved.text
    if publish:
        r = owner.post(f"/stories/{story['id']}/publish")
        assert r.status_code == 200, r.text
    return story["id"]


def edit_draft(owner: TestClient, story_id: str, **fields: object) -> None:
    current = owner.get(f"/stories/{story_id}").json()
    body = {**draft_body(), **current["draft"], **fields, "updated_at": current["updated_at"]}
    r = owner.put(f"/stories/{story_id}/draft", json=body)
    assert r.status_code == 200, r.text


def set_live(container: Container, story_id: str, live: bool) -> None:
    """Unpublish / republish: no endpoint yet, so the row is changed as those would."""
    story = container.stories.get(MVP_ORGANISATION_ID, story_id)
    assert story is not None
    container.stories.replace(
        MVP_ORGANISATION_ID,
        replace(story, live=live, updated_at=story.updated_at + timedelta(seconds=1)),
        expected_updated_at=story.updated_at,
    )


# --- Scenario: home page ---------------------------------------------------------------


def test_the_home_list_has_only_live_pieces_newest_first_each_with_its_hero(world) -> None:  # noqa: ANN001
    container, _, owner, anon = world
    first = make_piece(owner, title="First", description="One", content=photo("img-1", "One alt"))
    second = make_piece(owner, title="Second", description="Two", content=photo("img-2", "Two alt"))
    make_piece(owner, publish=False, title="Never published")
    hidden = make_piece(owner, title="Unpublished")
    set_live(container, hidden, False)

    r = anon.get("/public/pieces")
    assert r.status_code == 200
    rows = r.json()
    assert [row["id"] for row in rows] == [second, first]
    top = rows[0]
    assert top["title"] == "Second"
    assert top["description"] == "Two"
    assert top["first_published_at"]
    assert top["hero"]["alt"] == "Two alt"
    assert top["hero"]["versions"] == [
        {"width": 480, "url": "/public/images/img-2-480.jpg"},
        {"width": 960, "url": "/public/images/img-2-960.jpg"},
    ]
    assert set(top) == {
        "id", "title", "description", "location", "date", "first_published_at", "hero",
    }  # fmt: skip


def test_the_hero_is_the_first_photo_block(world) -> None:  # noqa: ANN001
    _, _, owner, anon = world
    make_piece(owner, content=f"{photo('img-3', 'third')}\n\n{photo('img-1', 'first')}\n")
    assert anon.get("/public/pieces").json()[0]["hero"]["image_id"] == "img-3"


def test_an_empty_site_is_an_empty_list(world) -> None:  # noqa: ANN001
    _, _, _, anon = world
    assert anon.get("/public/pieces").json() == []


# --- Scenario: republishing does not reorder ----------------------------------------------


def test_unpublish_and_republish_keep_the_place_by_first_published_date(world) -> None:  # noqa: ANN001
    container, _, owner, anon = world
    older = make_piece(owner, title="Older")
    newer = make_piece(owner, title="Newer")
    set_live(container, older, False)
    assert [r["id"] for r in anon.get("/public/pieces").json()] == [newer]
    set_live(container, older, True)
    assert [r["id"] for r in anon.get("/public/pieces").json()] == [newer, older]
    # A second Publish moves last_published_at, not first_published_at.
    assert owner.post(f"/stories/{older}/publish").status_code == 200
    assert [r["id"] for r in anon.get("/public/pieces").json()] == [newer, older]


# --- Scenario: piece page -----------------------------------------------------------------


def test_a_piece_has_its_published_text_and_each_photo_resolved_to_web_versions(world) -> None:  # noqa: ANN001
    _, _, owner, anon = world
    pid = make_piece(owner)
    r = anon.get(f"/public/pieces/{pid}")
    assert r.status_code == 200
    body = r.json()
    assert (body["title"], body["description"], body["location"], body["date"]) == (
        "Dusk", "A walk at dusk", "Lisbon", "2026-10-31",
    )  # fmt: skip
    assert "First words." in body["content"]
    assert body["photos"]["img-1"] == {
        "alt": "A street at dusk",
        "caption": "Evening",
        "credit": "A. Photographer",
        "width": 960,
        "height": 640,
        "versions": [
            {"width": 480, "url": "/public/images/img-1-480.jpg"},
            {"width": 960, "url": "/public/images/img-1-960.jpg"},
        ],
    }


def test_photo_text_is_served_decoded(world) -> None:  # noqa: ANN001
    _, _, owner, anon = world
    pid = make_piece(
        owner, content=photo("img-1", "Tom &amp; Jerry &quot;live&quot;", "a &lt;b&gt;", "x")
    )
    p = anon.get(f"/public/pieces/{pid}").json()["photos"]["img-1"]
    assert p["alt"] == 'Tom & Jerry "live"'
    assert p["caption"] == "a <b>"
    assert unescape_attr("&amp;amp;") == "&amp;"


def test_a_photo_whose_image_is_not_ready_is_left_out_not_leaked(world) -> None:  # noqa: ANN001
    container, images, owner, anon = world
    pid = make_piece(owner, content=f"{photo('img-1')}\n\n{photo('img-2')}\n")
    seed_image(images, "img-9", status=ImageStatus.FAILED)
    story = container.stories.get(MVP_ORGANISATION_ID, pid)
    assert story is not None
    container.stories.replace(
        MVP_ORGANISATION_ID,
        replace(
            story,
            published_content=story.published_content + "\n\n" + photo("img-9") + photo("nope"),
            updated_at=story.updated_at + timedelta(seconds=1),
        ),
        expected_updated_at=story.updated_at,
    )
    assert set(anon.get(f"/public/pieces/{pid}").json()["photos"]) == {"img-1", "img-2"}


# --- Scenario: draft never shown ----------------------------------------------------------


def test_only_the_published_text_is_shown_when_the_draft_differs(world) -> None:  # noqa: ANN001
    _, _, owner, anon = world
    pid = make_piece(owner, title="Published title", description="Published description")
    edit_draft(
        owner,
        pid,
        title=f"{DRAFT_MARKER} title",
        description=f"{DRAFT_MARKER} description",
        location=f"{DRAFT_MARKER} place",
        content=f"{DRAFT_MARKER} body\n\n{photo('img-2', DRAFT_MARKER)}\n",
    )
    for path in ("/public/pieces", f"/public/pieces/{pid}"):
        r = anon.get(path)
        assert DRAFT_MARKER not in r.text, path
    body = anon.get(f"/public/pieces/{pid}").json()
    assert body["title"] == "Published title"
    assert body["description"] == "Published description"
    assert "img-2" not in body["photos"]


# --- Scenario: not live -------------------------------------------------------------------


def test_unknown_unpublished_and_never_published_ids_are_404(world) -> None:  # noqa: ANN001
    container, _, owner, anon = world
    live = make_piece(owner)
    unpublished = make_piece(owner)
    set_live(container, unpublished, False)
    never = make_piece(owner, publish=False)
    assert anon.get(f"/public/pieces/{live}").status_code == 200
    for pid in (unpublished, never, "no-such-id", "00000000-0000-0000-0000-000000000000"):
        r = anon.get(f"/public/pieces/{pid}")
        assert r.status_code == 404, pid
        assert r.json() == {"detail": "not found"}


# --- Organisation filter ------------------------------------------------------------------


def test_another_organisations_live_piece_is_neither_listed_nor_served(world) -> None:  # noqa: ANN001
    container, _, owner, anon = world
    mine = make_piece(owner)
    foreign = replace(
        new_story("foreign-1", "other-org", T0),
        live=True,
        first_published_at=T0,
        last_published_at=T0,
        published_title="Foreign",
        published_content=photo("img-1"),
    )
    container.stories.create(foreign)
    assert [r["id"] for r in anon.get("/public/pieces").json()] == [mine]
    assert anon.get("/public/pieces/foreign-1").status_code == 404


def test_an_image_of_another_organisation_is_not_resolved(world) -> None:  # noqa: ANN001
    _, images, owner, anon = world
    seed_image(images, "img-x", org="other-org")
    pid = make_piece(owner, content=photo("img-1"))
    story = world[0].stories.get(MVP_ORGANISATION_ID, pid)
    assert story is not None
    world[0].stories.replace(
        MVP_ORGANISATION_ID,
        replace(
            story,
            published_content=photo("img-x"),
            updated_at=story.updated_at + timedelta(seconds=1),
        ),
        expected_updated_at=story.updated_at,
    )
    assert anon.get(f"/public/pieces/{pid}").json()["photos"] == {}


# --- No draft text, no original URL, anywhere ---------------------------------------------


def test_no_public_response_holds_draft_text_or_an_original_url(world) -> None:  # noqa: ANN001
    container, _, owner, anon = world
    a = make_piece(owner, title="A", content=f"{photo('img-1')}\n\n{photo('img-2')}\n")
    b = make_piece(owner, title="B", content=photo("img-3"))
    for pid in (a, b):
        edit_draft(owner, pid, title=DRAFT_MARKER, description=DRAFT_MARKER, location=DRAFT_MARKER,
                   content=f"{DRAFT_MARKER}\n\n{photo('img-3', DRAFT_MARKER)}\n")  # fmt: skip
    hidden = make_piece(owner, title="Hidden")
    set_live(container, hidden, False)

    paths = ["/public/pieces", *(f"/public/pieces/{p}" for p in (a, b, hidden, "nope"))]
    # Everything the API serves publicly: the pieces, and each web version listed in them.
    seen: list[str] = []
    for row in anon.get("/public/pieces").json():
        seen += [v["url"] for v in row["hero"]["versions"]]
    paths += seen
    assert len(paths) >= 6
    for path in paths:
        r = anon.get(path)
        text = r.text + json.dumps(dict(r.headers))
        assert DRAFT_MARKER not in text, path
        assert ORIGINAL_MARKER not in text, path
        assert "local://" not in text, path
        assert "original" not in text.lower(), path
        assert "story" not in text.lower() and "stories" not in text.lower(), path


def test_the_word_story_is_in_no_public_path_or_key(world) -> None:  # noqa: ANN001
    _, _, owner, anon = world
    pid = make_piece(owner)

    def keys(value: object) -> list[str]:
        if isinstance(value, dict):
            return [str(k) for k in value] + [k for v in value.values() for k in keys(v)]
        if isinstance(value, list):
            return [k for v in value for k in keys(v)]
        return []

    for path in ("/public/pieces", f"/public/pieces/{pid}"):
        assert "stor" not in path
        assert not [k for k in keys(anon.get(path).json()) if "stor" in k.lower()]


# --- Scenario: changes show straight away ---------------------------------------------------


def test_public_answers_are_never_cached(world) -> None:  # noqa: ANN001
    container, _, owner, anon = world
    pid = make_piece(owner)
    never = make_piece(owner, publish=False)
    for path in ("/public/pieces", f"/public/pieces/{pid}", f"/public/pieces/{never}",
                 "/public/pieces/nope"):  # fmt: skip
        assert anon.get(path).headers["cache-control"] == "no-store", path


def test_publish_unpublish_and_republish_show_on_the_next_read(world) -> None:  # noqa: ANN001
    container, _, owner, anon = world
    pid = make_piece(owner, publish=False)
    assert anon.get(f"/public/pieces/{pid}").status_code == 404
    assert anon.get("/public/pieces").json() == []

    assert owner.post(f"/stories/{pid}/publish").status_code == 200
    assert anon.get(f"/public/pieces/{pid}").json()["title"] == "Dusk"
    assert [r["id"] for r in anon.get("/public/pieces").json()] == [pid]

    edit_draft(owner, pid, title="Changed")
    assert anon.get(f"/public/pieces/{pid}").json()["title"] == "Dusk"  # draft: not yet
    assert owner.post(f"/stories/{pid}/publish").status_code == 200
    assert anon.get(f"/public/pieces/{pid}").json()["title"] == "Changed"
    assert anon.get("/public/pieces").json()[0]["title"] == "Changed"

    set_live(container, pid, False)
    assert anon.get(f"/public/pieces/{pid}").status_code == 404
    assert anon.get("/public/pieces").json() == []
    set_live(container, pid, True)
    assert anon.get(f"/public/pieces/{pid}").json()["title"] == "Changed"


# --- Scenario: stored markup is never evaluated -----------------------------------------------


def test_stored_import_export_and_entity_text_is_served_as_inert_text(world) -> None:  # noqa: ANN001
    _, _, owner, anon = world
    content = (
        'import a from "x"\n\nexport const a = 1\n\n&lt;script&gt;alert(1)&lt;/script&gt;\n\n'
        + photo("img-1")
    )
    pid = make_piece(owner, content=content)
    r = anon.get(f"/public/pieces/{pid}")
    assert r.headers["content-type"].startswith("application/json")
    assert r.json()["content"] == content  # data, byte for byte; the renderer decides what it is


# --- Storage that is not built (Postgres, until #34) -----------------------------------------


def test_the_public_reads_answer_501_where_storage_is_not_built() -> None:
    env = {"STORY_REPOSITORY": "postgres", "DATABASE_URL": "postgresql://u:p@127.0.0.1:1/db"}
    client = TestClient(create_app(env=env, environment="production"))
    for path in ("/public/pieces", "/public/pieces/anything"):
        r = client.get(path)
        assert r.status_code == 501, path
        assert r.headers["cache-control"] == "no-store"


# --- The list resolves only the hero; a 500 is also no-store ----------------------------------


class CountingImages:
    """Wraps the real ImageService and counts `get` calls."""

    def __init__(self, inner: ImageService) -> None:
        self.inner = inner
        self.calls = 0

    def get(self, organisation_id: str, image_id: str) -> ImageRecord:
        self.calls += 1
        return self.inner.get(organisation_id, image_id)


def test_the_list_does_one_image_lookup_per_piece_but_a_page_resolves_every_photo(world) -> None:  # noqa: ANN001
    container, _, owner, _ = world
    three = f"{photo('img-1')}\n\n{photo('img-2')}\n\n{photo('img-3')}\n"
    make_piece(owner, content=three)
    make_piece(owner, content=three)
    counting = CountingImages(container.image_service)
    site = PublicSite(container.stories, counting)  # type: ignore[arg-type]
    listed = site.list_live(MVP_ORGANISATION_ID)
    assert len(listed) == 2
    assert all(s.hero is not None for s in listed)
    assert counting.calls == 2
    counting.calls = 0
    site.get_live(MVP_ORGANISATION_ID, listed[0].id)
    assert counting.calls == 3


def test_the_list_skips_an_unresolvable_first_photo_for_the_next(world) -> None:  # noqa: ANN001
    container, images, owner, anon = world
    pid = make_piece(owner, content=photo("img-1"))
    story = container.stories.get(MVP_ORGANISATION_ID, pid)
    assert story is not None
    container.stories.replace(
        MVP_ORGANISATION_ID,
        replace(
            story,
            published_content=photo("nope") + photo("img-2"),
            updated_at=story.updated_at + timedelta(seconds=1),
        ),
        expected_updated_at=story.updated_at,
    )
    assert anon.get("/public/pieces").json()[0]["hero"]["image_id"] == "img-2"


def test_an_unhandled_error_under_public_pieces_is_a_500_with_no_store(world) -> None:  # noqa: ANN001
    container, _, _, _ = world

    class Exploding:
        def __getattr__(self, name: str):  # noqa: ANN204
            raise RuntimeError("boom")

    app = create_app(container=replace(container, stories=Exploding()))  # type: ignore[arg-type]
    client = TestClient(app, raise_server_exceptions=False)
    for path in ("/public/pieces", "/public/pieces/x"):
        r = client.get(path)
        assert r.status_code == 500, path
        assert r.headers["cache-control"] == "no-store", path
        assert "boom" not in r.text
