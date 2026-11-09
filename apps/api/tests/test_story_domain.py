"""The story rules, with no framework: publish rule, Photo parsing, the draft to published copy."""

from datetime import UTC, date, datetime, timedelta

import pytest

from api.domain import (
    DraftFields,
    ImageStatus,
    TransitionRefusedError,
    new_story,
    owner_order,
    parse_photo_blocks,
    publish_problems,
    published,
    republished,
    reverted,
    unpublished,
    with_draft,
)

T0 = datetime(2026, 11, 9, 12, 0, tzinfo=UTC)
PHOTO = '<Photo image="img-1" alt="A street at dusk" caption="Evening" credit="Me" />'


def ready(*ids: str):
    return lambda image_id: ImageStatus.READY if image_id in ids else None


def good_draft(**changes: object) -> DraftFields:
    base = DraftFields(title="Title", description="About", content=f"Words.\n\n{PHOTO}\n")
    return DraftFields(**{**base.__dict__, **changes})


def test_a_complete_draft_with_a_ready_photo_passes() -> None:
    assert publish_problems(good_draft(), ready("img-1")) == []


@pytest.mark.parametrize(
    ("changes", "reason"),
    [
        ({"title": ""}, "title is required"),
        ({"title": "   "}, "title is required"),
        ({"description": ""}, "description is required"),
        ({"content": "Just words."}, "at least one Photo block is required"),
        ({"content": ""}, "at least one Photo block is required"),
        ({"content": '<Photo image="img-1" alt="" />'}, "Photo 1 has no alt text"),
        ({"content": '<Photo image="img-1" alt="   " />'}, "Photo 1 has no alt text"),
        ({"content": '<Photo image="img-1" />'}, "Photo 1 has no alt text"),
        ({"content": '<Photo alt="Somewhere" />'}, "Photo 1 has no image"),
        ({"content": '<Photo image="img-1" alt="ok"'}, "a Photo block is malformed"),
        ({"content": '<Photo image="nope" alt="ok" />'}, "Photo 1: image nope is not ready"),
    ],
)
def test_each_publish_rule_failure_is_refused_with_its_reason(
    changes: dict[str, object], reason: str
) -> None:
    assert reason in publish_problems(good_draft(**changes), ready("img-1"))


def test_every_failure_is_reported_not_just_the_first() -> None:
    problems = publish_problems(DraftFields(), ready())
    assert problems == [
        "title is required",
        "description is required",
        "at least one Photo block is required",
    ]


def test_an_image_that_is_processing_failed_or_unknown_fails_the_rule() -> None:
    for status in (ImageStatus.PROCESSING, ImageStatus.FAILED, None):
        problems = publish_problems(good_draft(), lambda _id, s=status: s)
        assert problems == ["Photo 1: image img-1 is not ready"], status


def test_one_bad_photo_among_good_ones_fails_and_is_named_by_position() -> None:
    content = (
        '<Photo image="a" alt="x" />\n\n<Photo image="b" alt="" />\n\n<Photo image="c" alt="z" />'
    )
    problems = publish_problems(good_draft(content=content), ready("a", "b"))
    assert problems == ["Photo 2 has no alt text", "Photo 3: image c is not ready"]


def test_photo_parsing_reads_attributes_in_any_order_and_either_quote() -> None:
    blocks, openings = parse_photo_blocks(
        '<Photo alt=\'It"s a dog\' credit="c" image="i-1" caption="x > y" />'
    )
    assert openings == 1
    assert [(b.image_id, b.alt) for b in blocks] == [("i-1", 'It"s a dog')]


def test_a_photo_inside_prose_that_merely_mentions_the_word_is_not_a_block() -> None:
    blocks, openings = parse_photo_blocks("I took a Photo of it, and <b>more</b>.")
    assert (blocks, openings) == ([], 0)


def test_publishing_copies_the_draft_over_the_published_text_and_sets_dates() -> None:
    story = with_draft(
        new_story("s1", "org", T0),
        good_draft(location="Paris", date=date(2026, 1, 2)),
        T0 + timedelta(minutes=1),
    )
    now = T0 + timedelta(minutes=2)
    out = published(story, now)
    assert out.live is True
    assert out.first_published_at == now and out.last_published_at == now
    assert (out.published_title, out.published_description) == ("Title", "About")
    assert (out.published_location, out.published_date) == ("Paris", date(2026, 1, 2))
    assert out.published_content == story.draft_content
    assert out.draft == story.draft  # the draft stays


def test_republishing_keeps_first_published_at_and_moves_last_published_at() -> None:
    first = published(with_draft(new_story("s1", "org", T0), good_draft(), T0), T0)
    later = T0 + timedelta(days=1)
    second = published(with_draft(first, good_draft(title="Newer"), later), later)
    assert second.first_published_at == T0
    assert second.last_published_at == later
    assert second.published_title == "Newer"


def test_saving_a_draft_never_touches_published_text_or_live() -> None:
    live = published(with_draft(new_story("s1", "org", T0), good_draft(), T0), T0)
    edited = with_draft(live, good_draft(title="Work in progress"), T0 + timedelta(hours=1))
    assert edited.draft_title == "Work in progress"
    assert edited.published_title == "Title"
    assert edited.live is True
    assert edited.first_published_at == live.first_published_at


def test_updated_at_always_moves_forward_even_within_one_clock_tick() -> None:
    story = new_story("s1", "org", T0)
    a = with_draft(story, good_draft(title="a"), T0)
    b = with_draft(a, good_draft(title="b"), T0)
    assert story.updated_at < a.updated_at < b.updated_at


def test_a_new_story_is_an_empty_unpublished_draft() -> None:
    s = new_story("s1", "org", T0)
    assert s.draft == DraftFields()
    assert (s.published_title, s.published_content, s.published_date) == ("", "", None)
    assert (s.live, s.first_published_at, s.last_published_at) == (False, None, None)


def test_owner_order_puts_never_published_first_then_by_first_published_newest_first() -> None:
    def story(sid: str, created: int, first: int | None):
        s = new_story(sid, "org", T0 + timedelta(days=created))
        if first is None:
            return s
        return published(s, T0 + timedelta(days=first))

    stories = [
        story("old-pub", 1, 10),
        story("draft-old", 2, None),
        story("new-pub", 3, 20),
        story("draft-new", 9, None),
    ]
    assert [s.id for s in owner_order(stories)] == ["draft-new", "draft-old", "new-pub", "old-pub"]


# --- Lifecycle actions (issue #17, spec section 5) ------------------------------------------


def live_story():
    return published(with_draft(new_story("s1", "org", T0), good_draft(), T0), T0)


def test_unpublish_when_live_clears_live_and_keeps_both_texts() -> None:
    live = with_draft(live_story(), good_draft(title="Newer draft"), T0 + timedelta(hours=1))
    out = unpublished(live)
    assert out.live is False
    assert out.published_title == "Title" and out.draft_title == "Newer draft"
    assert out.first_published_at == live.first_published_at


@pytest.mark.parametrize("never_live", [False, True])
def test_unpublish_is_refused_unless_live(never_live: bool) -> None:
    story = new_story("s1", "org", T0) if never_live else unpublished(live_story())
    with pytest.raises(TransitionRefusedError):
        unpublished(story)


def test_republish_puts_the_published_text_back_without_copying_the_draft() -> None:
    down = unpublished(with_draft(live_story(), good_draft(title="Newer draft"), T0))
    out = republished(down)
    assert out.live is True
    assert out.published_title == "Title"  # not "Newer draft"
    assert out.draft_title == "Newer draft"
    assert out.first_published_at == down.first_published_at
    assert out.last_published_at == down.last_published_at


def test_republish_is_refused_when_already_live_or_never_published() -> None:
    for story in (live_story(), new_story("s1", "org", T0)):
        with pytest.raises(TransitionRefusedError):
            republished(story)


def test_revert_copies_every_published_field_over_the_draft_and_moves_updated_at() -> None:
    paris = good_draft(location="Paris", date=date(2026, 1, 2))
    first = published(with_draft(new_story("s1", "org", T0), paris, T0), T0)
    edited = with_draft(first, good_draft(title="X", location="Rome", date=None, content="x"), T0)
    out = reverted(edited, T0)  # same clock tick as the edit
    assert out.draft == first.draft == paris
    assert out.updated_at > edited.updated_at
    assert out.live is True and out.published_title == "Title"


def test_revert_is_refused_when_never_published_or_the_draft_matches() -> None:
    with pytest.raises(TransitionRefusedError):
        reverted(with_draft(new_story("s1", "org", T0), good_draft(), T0), T0)
    with pytest.raises(TransitionRefusedError):
        reverted(live_story(), T0)


def test_revert_works_while_not_live() -> None:
    down = unpublished(with_draft(live_story(), good_draft(title="Edited"), T0))
    assert reverted(down, T0).draft_title == "Title"
