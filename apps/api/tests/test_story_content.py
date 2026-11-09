"""What a story body may contain, and that the API enforces it on autosave."""

from dataclasses import replace

import pytest

from api.domain import content_problems
from test_stories_api import create, make_container, save, signed_in_client

PHOTO = '<Photo image="img-1" alt="A harbour" caption="" credit="" />'


@pytest.mark.parametrize(
    "content",
    [
        "",
        "Plain prose with **bold** and *italic*.",
        f"Intro\n\n{PHOTO}\n\nOutro",
        '<Photo image="a" alt="He said &quot;go&quot; &amp;amp; left" caption="x" credit="y" />',
        '<Photo credit="y" caption="" alt="a" image="b" />',
        "A less-than written as an entity: &lt;b&gt; and a brace &#123;x}.",
        "importantly, exports rose",
        "import duties rose sharply last year.",
        "Export of goods fell.\nimport from the east grew.",
    ],
)
def test_allowed_bodies(content: str) -> None:
    assert content_problems(content) == []


@pytest.mark.parametrize(
    "content",
    [
        '<Photo image="x" alt="" caption="" credit="" /><script>',
        "<iframe src='http://evil.test'></iframe>",
        "<iframe>",
        "<script>alert(1)</script>",
        "<b>bold</b>",
        '<Photo image="x" alt="" caption="" credit=""><b>x</b></Photo>',
        '<Photo image="x" alt="" caption="" credit="" />trailing<div>',
        '<Photo image="x" />',
        '<Photo image="x" alt="" caption="" credit="" onload="x()" />',
        '<Photo image="x" alt="" caption="" credit="" image="y" />',
        '<Photo image="x" alt="a "b"" caption="" credit="" />',
        '<Photo image="x" alt="a<b" caption="" credit="" />',
        '<Photo image="x" alt="a & b" caption="" credit="" />',
        '<Photo image={evil} alt="" caption="" credit="" />',
        "import x from 'y'\n\ntext",
        'import {a, b} from "y"',
        "import 'side-effect'",
        "text\nexport const a = 1",
        "export default function X() {}",
        "export { a }",
        'export*from"x"',
        'a\rimport a from "b"',
        "\\<script>alert(1)</script>",
        "\\\\<script>alert(1)</script>",
        "\\\\\\<script>",
        "\\{process.env.X}",
        "\\\\{process.env.X}",
        "Hello {process.env.SECRET}",
    ],
)
def test_refused_bodies(content: str) -> None:
    assert content_problems(content) != []


def test_autosave_refuses_disallowed_markup_with_the_reason_and_stores_nothing() -> None:
    client = signed_in_client()
    story = create(client)
    r = save(client, story, content=f"{PHOTO}<script>alert(1)</script>")
    assert r.status_code == 422
    assert r.json()["detail"]["reasons"]
    assert client.get(f"/stories/{story['id']}").json() == story


def test_autosave_accepts_a_valid_photo_with_prose() -> None:
    client = signed_in_client()
    story = create(client)
    assert save(client, story, content=f"Words **here**.\n\n{PHOTO}").status_code == 200


def test_publish_rechecks_the_body_so_a_draft_stored_around_save_draft_is_refused() -> None:
    container = make_container()
    client = signed_in_client(container)
    story = create(client)
    assert save(client, story, content=PHOTO).status_code == 200
    # Written straight to the repository, as a future code path or a bad migration might.
    org, story_id = next(iter(container.stories._stories))  # type: ignore[attr-defined]
    stored = container.stories.get(org, story_id)
    assert stored is not None
    evil = replace(stored, draft_content=f"{PHOTO}<script>alert(1)</script>")
    container.stories.replace(org, evil, stored.updated_at)

    r = client.post(f"/stories/{story_id}/publish")
    assert r.status_code == 422
    assert any("Photo" in reason or "tags" in reason for reason in r.json()["detail"]["reasons"])
    assert client.get(f"/stories/{story_id}").json()["published"] is None
