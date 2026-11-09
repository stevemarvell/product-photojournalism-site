"""What a story body may contain, and that the API enforces it on autosave."""

import pytest

from api.domain import content_problems
from test_stories_api import create, save, signed_in_client

PHOTO = '<Photo image="img-1" alt="A harbour" caption="" credit="" />'


@pytest.mark.parametrize(
    "content",
    [
        "",
        "Plain prose with **bold** and *italic*.",
        f"Intro\n\n{PHOTO}\n\nOutro",
        '<Photo image="a" alt="He said &quot;go&quot; &amp;amp; left" caption="x" credit="y" />',
        '<Photo credit="y" caption="" alt="a" image="b" />',
        "A less-than written safely: \\<b> and a brace \\{x}.",
        "importantly, exports rose",
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
        "text\nexport const a = 1",
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
