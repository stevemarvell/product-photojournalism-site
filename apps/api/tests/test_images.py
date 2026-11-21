"""Scenarios of issue #15 through the HTTP API, on the local adapters and stub sign-in.

The fixture JPEG is generated here with Pillow, carrying GPS and other EXIF. Where a test
needs processing that never finishes, or time to pass, it swaps in a processor that does
nothing and a clock the test moves.
"""

import io
import time
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import ExifTags, Image

from api.adapters.memory import InMemoryImageRepository
from api.adapters.pillow_images import PillowImageRenderer
from api.application import ImageService, process_image
from api.composition import Container, build_container
from api.domain import ImageStatus
from api.main import create_app

T0 = datetime(2026, 11, 9, 12, 0, tzinfo=UTC)


class FakeClock:
    def __init__(self) -> None:
        self.t = T0

    def now(self) -> datetime:
        return self.t


class InlineProcessor:
    """Processes in the request's own thread, so a test need not wait."""

    def __init__(self, work) -> None:  # noqa: ANN001
        self.work = work

    def enqueue(self, organisation_id: str, image_id: str) -> None:
        self.work(organisation_id, image_id)


class NeverProcessor:
    """Accepts the job and never does it: an image stuck in processing."""

    def __init__(self) -> None:
        self.jobs: list[tuple[str, str]] = []

    def enqueue(self, organisation_id: str, image_id: str) -> None:
        self.jobs.append((organisation_id, image_id))


def env(tmp_path: Path, **extra: str) -> dict[str, str]:
    return {
        "IDENTITY_PROVIDER": "stub",
        "API_ENVIRONMENT": "development",
        "STORY_REPOSITORY": "memory",
        "IMAGE_DIR": str(tmp_path / "images"),
        **extra,
    }


def jpeg(width: int = 3000, height: int = 2000, orientation: int | None = None) -> bytes:
    """A JPEG carrying GPS, camera make and a comment: what a phone puts in a photo."""
    pixels = Image.linear_gradient("L").resize((width, height)).convert("RGB")
    exif = Image.Exif()
    exif[0x010F] = "Acme Cameras"
    if orientation:
        exif[0x0112] = orientation
    exif[ExifTags.IFD.GPSInfo] = {1: "N", 2: (51.0, 30.0, 0.0), 3: "W", 4: (0.0, 7.0, 0.0)}
    out = io.BytesIO()
    pixels.save(out, "JPEG", exif=exif, comment=b"shot at the secret place")
    return out.getvalue()


def wired(
    tmp_path: Path,
    *,
    processor: str = "inline",
    clock: FakeClock | None = None,
    **extra: str,
) -> tuple[Container, ImageService]:
    """A container whose image service has the chosen processor and clock."""
    container = build_container(env(tmp_path, **extra))
    repo = InMemoryImageRepository()
    uploads = container.local_uploads
    assert uploads is not None
    renderer = PillowImageRenderer()
    queue: InlineProcessor | NeverProcessor
    if processor == "never":
        queue = NeverProcessor()
    else:
        queue = InlineProcessor(
            lambda org, i: process_image(
                org, i, images=repo, uploads=uploads, store=container.images, renderer=renderer
            )
        )
    service = ImageService(
        repo,
        uploads,
        queue,
        clock or FakeClock(),
        max_bytes=container.image_service.max_bytes,
        timeout=timedelta(seconds=120),
    )
    return replace(container, image_service=service, image_status=service), service


def signed_in(container: Container) -> TestClient:
    client = TestClient(create_app(container=container))
    assert client.get("/auth/callback", follow_redirects=False).status_code == 303
    return client


def upload(client: TestClient, data: bytes) -> dict:
    """The browser's three steps: ask for a target, PUT the file there, register the URL."""
    target = client.post("/images/upload-target", json={"size": len(data)})
    assert target.status_code == 200, target.text
    t = target.json()
    put = client.request(t["method"], t["upload_url"], content=data)
    assert put.status_code == 204, put.text
    registered = client.post("/images", json={"original_url": t["original_url"]})
    assert registered.status_code == 201, registered.text
    return {**registered.json(), "original_url": t["original_url"], "target": t}


def exif_of(data: bytes) -> tuple[dict, dict, set[str]]:
    with Image.open(io.BytesIO(data)) as im:
        return dict(im.getexif()), dict(im.getexif().get_ifd(ExifTags.IFD.GPSInfo)), set(im.info)


# --- Scenario: direct upload (the API half; the browser half is the web tests) ------------


def test_the_browser_flow_asks_for_a_target_puts_the_file_there_and_registers(
    tmp_path: Path,
) -> None:
    container = build_container(env(tmp_path))  # the real thread processor
    client = signed_in(container)
    data = jpeg(1200, 800)
    sent = upload(client, data)
    assert sent["target"]["upload_url"].startswith("/images/uploads/")
    assert sent["target"]["method"] == "PUT"
    assert sent["status"] == "processing"
    # The original went to storage unchanged, by the target's PUT, not through POST /images.
    assert container.local_uploads is not None
    assert container.local_uploads.read(sent["original_url"]) == data
    # It is processed on the in-process worker; poll the way the editor does.
    deadline = time.time() + 20
    body = client.get(f"/images/{sent['id']}").json()
    while body["status"] == "processing" and time.time() < deadline:
        time.sleep(0.05)
        body = client.get(f"/images/{sent['id']}").json()
    assert body["status"] == "ready"
    assert body["web_versions"]


def test_an_upload_target_works_once_and_only_for_an_issued_token(tmp_path: Path) -> None:
    client = signed_in(wired(tmp_path)[0])
    t = client.post("/images/upload-target", json={"size": 10}).json()
    assert client.put("/images/uploads/never-issued", content=b"x").status_code == 404
    assert client.put(t["upload_url"], content=b"x").status_code == 204
    assert client.put(t["upload_url"], content=b"y").status_code == 404  # used


def test_registering_something_that_was_not_uploaded_is_refused(tmp_path: Path) -> None:
    client = signed_in(wired(tmp_path)[0])
    for url in ("https://example.test/a.jpg", "local:orig-nothing", "local:../../etc/passwd"):
        assert client.post("/images", json={"original_url": url}).status_code == 422, url
    # Asked for, but not yet uploaded to.
    t = client.post("/images/upload-target", json={"size": 10}).json()
    assert client.post("/images", json={"original_url": t["original_url"]}).status_code == 422


# --- Scenario: register and process ---------------------------------------------------------


def test_registering_creates_a_processing_row_then_web_versions_at_several_widths(
    tmp_path: Path,
) -> None:
    container, _ = wired(tmp_path, processor="never")
    client = signed_in(container)
    sent = upload(client, jpeg(3000, 2000))
    assert sent["status"] == "processing"
    assert sent["web_versions"] == []
    assert client.get(f"/images/{sent['id']}").json()["status"] == "processing"

    container, _ = wired(tmp_path)  # a processor that runs
    client = signed_in(container)
    sent = upload(client, jpeg(3000, 2000))
    body = client.get(f"/images/{sent['id']}").json()
    assert body["status"] == "ready"
    assert [v["width"] for v in body["web_versions"]] == [480, 960, 1600, 2400]
    assert (body["width"], body["height"]) == (3000, 2000)
    assert body["byte_size"] == len(jpeg(3000, 2000))
    for v in body["web_versions"]:
        served = client.get(v["url"])
        assert served.status_code == 200
        assert served.headers["content-type"] == "image/jpeg"
        with Image.open(io.BytesIO(served.content)) as im:
            assert im.size == (v["width"], round(2000 * v["width"] / 3000))


def test_a_small_original_is_never_upscaled(tmp_path: Path) -> None:
    client = signed_in(wired(tmp_path)[0])
    body = client.get(f"/images/{upload(client, jpeg(1000, 500))['id']}").json()
    assert [v["width"] for v in body["web_versions"]] == [480, 960]
    body = client.get(f"/images/{upload(client, jpeg(300, 200))['id']}").json()
    assert [v["width"] for v in body["web_versions"]] == [300]  # its own size, not larger


def test_bytes_that_are_not_an_image_end_as_failed(tmp_path: Path) -> None:
    client = signed_in(wired(tmp_path)[0])
    body = client.get(f"/images/{upload(client, b'this is not a picture')['id']}").json()
    assert body["status"] == "failed"
    assert body["web_versions"] == []


def test_an_unknown_image_is_a_404_and_another_organisations_image_is_invisible(
    tmp_path: Path,
) -> None:
    container, service = wired(tmp_path)
    client = signed_in(container)
    sent = upload(client, jpeg(600, 400))
    assert client.get("/images/nope").status_code == 404
    from api.domain import ImageNotFoundError

    with pytest.raises(ImageNotFoundError):
        service.get("another-org", sent["id"])
    assert service.status("another-org", sent["id"]) is None


# --- Scenario: metadata stripped ------------------------------------------------------------


@pytest.mark.parametrize("orientation", [None, 6])
def test_no_web_version_carries_gps_or_any_exif(tmp_path: Path, orientation: int | None) -> None:
    original = jpeg(2600, 1800, orientation)
    # Control: the fixture really carries what must be stripped.
    exif, gps, info = exif_of(original)
    assert gps.get(2) == (51.0, 30.0, 0.0)
    assert exif[0x010F] == "Acme Cameras"
    assert b"secret place" in original

    client = signed_in(wired(tmp_path)[0])
    body = client.get(f"/images/{upload(client, original)['id']}").json()
    assert len(body["web_versions"]) >= 3
    for v in body["web_versions"]:
        data = client.get(v["url"]).content
        exif, gps, info = exif_of(data)
        assert exif == {} and gps == {}, v
        assert not {"exif", "icc_profile", "xmp", "comment", "photoshop"} & info, (v, info)
        # And not merely hidden from Pillow: the bytes hold no Exif/XMP block or the comment.
        assert b"Exif" not in data and b"http://ns.adobe.com" not in data
        assert b"secret place" not in data and b"Acme" not in data


def test_orientation_is_applied_to_the_pixels_since_the_tag_is_dropped(tmp_path: Path) -> None:
    client = signed_in(wired(tmp_path)[0])
    body = client.get(f"/images/{upload(client, jpeg(2000, 1000, orientation=6))['id']}").json()
    # Orientation 6 means "rotate to view": the stored 2000x1000 is shown 1000x2000.
    assert (body["width"], body["height"]) == (1000, 2000)
    with Image.open(io.BytesIO(client.get(body["web_versions"][0]["url"]).content)) as im:
        assert im.height > im.width


# --- Scenario: originals never public -------------------------------------------------------


def test_the_original_url_appears_in_no_public_response_and_no_owner_response_either(
    tmp_path: Path,
) -> None:
    container, _ = wired(tmp_path)
    owner = signed_in(container)
    sent = upload(owner, jpeg(1200, 800))
    token = sent["original_url"].removeprefix("local:orig-")
    original_url = sent["original_url"]
    body = owner.get(f"/images/{sent['id']}").json()
    # Decision: no owner response after the upload target carries original_url either.
    assert "original_url" not in body and "original_url" not in sent.get("id", "")
    assert original_url not in owner.get(f"/images/{sent['id']}").text

    anonymous = TestClient(create_app(container=container))
    seen: list[str] = []
    for v in body["web_versions"]:
        r = anonymous.get(v["url"])
        assert r.status_code == 200
        seen.append(r.headers.get("content-type", "") + str(dict(r.headers)))
    for path in (
        f"/public/images/orig-{token}",
        f"/public/images/orig-{token}.jpg",
        f"/public/images/{sent['id']}",
        f"/public/images/{sent['id']}-9999.jpg",
        "/public/images/..%2F..%2Fetc%2Fpasswd",
        f"/images/{sent['id']}",
        f"/images/uploads/{token}",
    ):
        r = anonymous.get(path)
        assert r.status_code in (401, 404, 405), (path, r.status_code)
        seen.append(r.text)
    assert not any(original_url in s or token in s for s in seen)
    # And the original's bytes are not what any web version holds.
    assert container.local_uploads is not None
    original = container.local_uploads.read(original_url)
    assert original is not None
    for v in body["web_versions"]:
        assert anonymous.get(v["url"]).content != original


def test_the_public_image_route_serves_no_file_that_is_not_a_web_version(tmp_path: Path) -> None:
    container, _ = wired(tmp_path)
    container.images.put("orig-secret", b"private original")
    container.images.put("notes.txt", b"not an image")
    anonymous = TestClient(create_app(container=container))
    assert anonymous.get("/public/images/orig-secret").status_code == 404
    assert anonymous.get("/public/images/notes.txt").status_code == 404


# --- Scenario: file too large ---------------------------------------------------------------


def test_a_file_over_the_limit_is_refused_with_the_limit_before_any_target_is_issued(
    tmp_path: Path,
) -> None:
    client = signed_in(wired(tmp_path, IMAGE_MAX_BYTES="1000")[0])
    assert client.post("/images/upload-target", json={"size": 1000}).status_code == 200
    refused = client.post("/images/upload-target", json={"size": 1001})
    assert refused.status_code == 413
    assert refused.json()["detail"]["limit"] == 1000


def test_the_default_limit_is_25_megabytes(tmp_path: Path) -> None:
    assert build_container(env(tmp_path)).image_service.max_bytes == 25 * 1024 * 1024


def test_the_server_refuses_an_oversize_body_whatever_the_browser_claimed(tmp_path: Path) -> None:
    client = signed_in(wired(tmp_path, IMAGE_MAX_BYTES="1000")[0])
    # Asked for a target honestly small, then sent a large body: refused by Content-Length...
    t = client.post("/images/upload-target", json={"size": 10}).json()
    r = client.put(t["upload_url"], content=b"x" * 1001)
    assert r.status_code == 413
    assert r.json()["detail"]["limit"] == 1000
    # ...and with no length at all (chunked), it is counted as it arrives.
    t = client.post("/images/upload-target", json={"size": 10}).json()
    r = client.put(t["upload_url"], content=(b"x" * 400 for _ in range(4)))
    assert r.status_code == 413
    # Nothing was stored, so nothing can be registered.
    assert client.post("/images", json={"original_url": t["original_url"]}).status_code == 422


def test_register_checks_the_stored_size_not_the_browsers_word(tmp_path: Path) -> None:
    container, _ = wired(tmp_path, IMAGE_MAX_BYTES="1000")

    class BigStore:
        """An uploads adapter that holds a file over the limit (as a Blob upload might)."""

        def issue(self, organisation_id: str):  # noqa: ANN201
            raise AssertionError

        def size(self, organisation_id: str, original_url: str) -> int | None:
            return 5000

        def claim(self, organisation_id: str, original_url: str) -> bool:
            return True

        def read(self, original_url: str) -> bytes | None:
            return None

    service = ImageService(
        InMemoryImageRepository(),
        BigStore(),
        NeverProcessor(),
        FakeClock(),
        max_bytes=1000,
        timeout=timedelta(seconds=120),
    )
    client = signed_in(replace(container, image_service=service))
    r = client.post("/images", json={"original_url": "https://blob.test/x"})
    assert r.status_code == 413
    assert r.json()["detail"]["limit"] == 1000


# --- Registration is bound to the issuing organisation and single-use ---------------------------


def test_a_second_registration_of_the_same_upload_is_a_409_and_makes_no_second_row(
    tmp_path: Path,
) -> None:
    container, _ = wired(tmp_path, processor="never")
    client = signed_in(container)
    sent = upload(client, jpeg(600, 400))
    again = client.post("/images", json={"original_url": sent["original_url"]})
    assert again.status_code == 409
    assert "id" not in again.json()


def test_an_upload_issued_to_one_organisation_cannot_be_registered_by_another(
    tmp_path: Path,
) -> None:
    container, service = wired(tmp_path)
    uploads = container.local_uploads
    assert uploads is not None
    target = uploads.issue("org-a")
    assert uploads.accept(target.upload_url.rsplit("/", 1)[1], jpeg(600, 400))
    from api.domain import ImageRefusedError

    with pytest.raises(ImageRefusedError):
        service.register("org-b", target.original_url)
    # Refusing org-b did not use the upload up: its own organisation still can.
    assert service.register("org-a", target.original_url).organisation_id == "org-a"


# --- Scenario: processing times out ---------------------------------------------------------


def test_an_image_still_processing_past_the_timeout_is_failed_when_next_read(
    tmp_path: Path,
) -> None:
    clock = FakeClock()
    container, service = wired(tmp_path, processor="never", clock=clock)
    client = signed_in(container)
    sent = upload(client, jpeg(600, 400))
    clock.t = T0 + timedelta(seconds=120)
    assert client.get(f"/images/{sent['id']}").json()["status"] == "processing"  # at, not past
    clock.t = T0 + timedelta(seconds=121)
    body = client.get(f"/images/{sent['id']}").json()
    assert body["status"] == "failed"
    assert body["web_versions"] == []
    # It stays failed on every later read.
    clock.t = T0 + timedelta(seconds=5)
    assert client.get(f"/images/{sent['id']}").json()["status"] == "failed"


def test_the_timeout_is_a_config_value(tmp_path: Path) -> None:
    clock = FakeClock()
    container = build_container(env(tmp_path, IMAGE_PROCESSING_TIMEOUT_SECONDS="5"))
    repo = InMemoryImageRepository()
    assert container.local_uploads is not None
    service = ImageService(
        repo,
        container.local_uploads,
        NeverProcessor(),
        clock,
        max_bytes=10_000_000,
        timeout=timedelta(seconds=5),
    )
    client = signed_in(replace(container, image_service=service, image_status=service))
    sent = upload(client, jpeg(600, 400))
    clock.t = T0 + timedelta(seconds=6)
    assert client.get(f"/images/{sent['id']}").json()["status"] == "failed"
    # The default is 120 s, read from config rather than written into the service.
    assert build_container(env(tmp_path)).image_service._timeout == timedelta(seconds=120)  # noqa: SLF001
    assert (
        build_container(env(tmp_path, IMAGE_PROCESSING_TIMEOUT_SECONDS="5")).image_service._timeout  # noqa: SLF001
        == timedelta(seconds=5)
    )


def test_a_worker_finishing_after_the_timeout_cannot_revive_a_failed_image(
    tmp_path: Path,
) -> None:
    clock = FakeClock()
    container, service = wired(tmp_path, processor="never", clock=clock)
    client = signed_in(container)
    sent = upload(client, jpeg(600, 400))
    clock.t = T0 + timedelta(seconds=500)
    assert client.get(f"/images/{sent['id']}").json()["status"] == "failed"
    uploads = container.local_uploads
    assert uploads is not None
    repo_of_service = service._images  # noqa: SLF001
    process_image(
        "owner-org",
        sent["id"],
        images=repo_of_service,
        uploads=uploads,
        store=container.images,
        renderer=PillowImageRenderer(),
    )
    assert client.get(f"/images/{sent['id']}").json()["status"] == "failed"


# --- The publish rule's image check, end to end (replaces #13's stub) ------------------------


def photo(image_id: str) -> str:
    return f'<Photo image="{image_id}" alt="A street" caption="" credit="" />'


def story_with(client: TestClient, image_id: str) -> str:
    story = client.post("/stories").json()
    r = client.put(
        f"/stories/{story['id']}/draft",
        json={
            "title": "T",
            "description": "D",
            "location": "",
            "date": None,
            "content": f"Words.\n\n{photo(image_id)}\n",
            "updated_at": story["updated_at"],
        },
    )
    assert r.status_code == 200, r.text
    return story["id"]


def test_publish_waits_for_the_real_image_status(tmp_path: Path) -> None:
    clock = FakeClock()
    container, _ = wired(tmp_path, processor="never", clock=clock)
    client = signed_in(container)
    stuck = upload(client, jpeg(600, 400))["id"]
    story_id = story_with(client, stuck)
    refused = client.post(f"/stories/{story_id}/publish")
    assert refused.status_code == 422
    assert any("not ready" in r for r in refused.json()["detail"]["reasons"])
    # Past the timeout the image is failed, and publish is still refused.
    clock.t = T0 + timedelta(seconds=999)
    assert client.get(f"/images/{stuck}").json()["status"] == "failed"
    assert client.post(f"/stories/{story_id}/publish").status_code == 422

    # A ready image publishes.
    container, _ = wired(tmp_path)
    client = signed_in(container)
    ready_id = upload(client, jpeg(600, 400))["id"]
    assert client.post(f"/stories/{story_with(client, ready_id)}/publish").status_code == 200
    # And an id that is no image at all does not.
    assert client.post(f"/stories/{story_with(client, 'no-such-image')}/publish").status_code == 422


def test_the_container_wires_the_real_lookup_not_the_stub(tmp_path: Path) -> None:
    container = build_container(env(tmp_path))
    assert container.image_status is container.image_service
    assert container.image_service.status("owner-org", "anything") is None
    assert ImageStatus.READY.value == "ready"


# --- A small file declaring far too many pixels fails, rather than being decoded --------------


def test_an_image_declaring_more_pixels_than_the_limit_fails_without_being_decoded() -> None:
    from api.application import RenderedImage  # noqa: F401
    from api.domain import ImageProcessingError

    bomb = io.BytesIO()
    # 9000 x 9000 = 81 million pixels of one colour: a few KB as a PNG.
    Image.new("L", (9000, 9000)).save(bomb, "PNG", optimize=True)
    assert len(bomb.getvalue()) < 1_000_000
    with pytest.raises(ImageProcessingError, match="too many pixels"):
        PillowImageRenderer().render(bomb.getvalue())  # default limit 64 million
    # Under the limit the same kind of file is fine, so the check is the limit and not the format.
    small = io.BytesIO()
    Image.new("L", (3000, 3000)).save(small, "PNG")
    assert PillowImageRenderer().render(small.getvalue()).width == 3000


def test_the_pixel_limit_is_a_config_value_and_a_bomb_ends_as_failed(tmp_path: Path) -> None:
    container = build_container(env(tmp_path, IMAGE_MAX_PIXELS="1000000"))
    client = signed_in(container)
    png = io.BytesIO()
    Image.new("L", (1500, 1500)).save(png, "PNG")  # 2.25 MP, over the 1 MP limit
    sent = upload(client, png.getvalue())
    deadline = time.time() + 20
    body = client.get(f"/images/{sent['id']}").json()
    while body["status"] == "processing" and time.time() < deadline:
        time.sleep(0.05)
        body = client.get(f"/images/{sent['id']}").json()
    assert body["status"] == "failed"


def _encoded(fmt: str, mode: str = "RGB") -> bytes:
    buf = io.BytesIO()
    Image.new(mode, (64, 48), "red").save(buf, fmt)
    return buf.getvalue()


@pytest.mark.parametrize("fmt", ["JPEG", "PNG", "WEBP", "TIFF"])
def test_photograph_formats_are_rendered(fmt: str) -> None:
    rendered = PillowImageRenderer().render(_encoded(fmt))
    assert (rendered.width, rendered.height) == (64, 48)
    assert rendered.versions


@pytest.mark.parametrize(("fmt", "mode"), [("GIF", "P"), ("BMP", "RGB"), ("ICO", "RGBA")])
def test_other_formats_are_refused(fmt: str, mode: str) -> None:
    from api.domain import ImageProcessingError

    data = _encoded(fmt, mode)
    with pytest.raises(ImageProcessingError):
        PillowImageRenderer().render(data)


def test_an_image_in_a_refused_format_ends_as_failed(tmp_path: Path) -> None:
    client = signed_in(wired(tmp_path)[0])
    body = client.get(f"/images/{upload(client, _encoded('GIF', 'P'))['id']}").json()
    assert body["status"] == "failed"
