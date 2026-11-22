"""Issue #40's scenarios from "direct upload in production" onward, on the real `vercel-blob`
package talking to a fake Blob HTTP layer (tests/fake_blob.py).

The fake checks the client token the way Blob does (signature, expiry, pathname, size cap), so
a target the adapter hands out is only as good as what Blob would accept. Nothing here can
show Blob itself accepts it: that is confirmed on the deployed site (see the pull request).
"""

import io
import os
import time
from collections.abc import Callable
from dataclasses import replace
from datetime import timedelta
from urllib.parse import parse_qs, unquote, urlsplit

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from api.adapters.blob import BlobImageStore, BlobOriginalUploads, BlobStore, client_token
from api.adapters.memory import InMemoryImageRepository
from api.adapters.pillow_images import InlineImageProcessor, PillowImageRenderer
from api.adapters.postgres_images import PostgresImageRepository
from api.application import ImageService, process_image
from api.composition import ConfigError, Container, build_container
from api.domain import MVP_ORGANISATION_ID
from api.main import create_app
from fake_blob import HOST, RW_TOKEN, FakeBlob
from test_images import FakeClock, exif_of, jpeg

ENV = {
    "IDENTITY_PROVIDER": "stub",
    "API_ENVIRONMENT": "development",
    "STORY_REPOSITORY": "memory",
    "BLOB_READ_WRITE_TOKEN": RW_TOKEN,
    "IMAGE_UPLOADS": "blob",
    "IMAGE_STORE": "blob",
    "IMAGE_PROCESSING": "inline",
}


def world(fake: FakeBlob, **extra: str) -> tuple[Container, TestClient]:
    container = build_container({**ENV, **extra}, blob_http=fake.client)
    client = TestClient(create_app(container=container))
    assert client.get("/auth/callback", follow_redirects=False).status_code == 303
    return container, client


def browser_upload(client: TestClient, fake: FakeBlob, data: bytes) -> tuple[dict, dict]:
    """The browser's three steps. Returns the registered row and the target it was given."""
    target = client.post("/images/upload-target", json={"size": len(data)})
    assert target.status_code == 200, target.text
    t = target.json()
    assert fake.browser_put(t, data) == 200  # straight to Blob: our app never sees the bytes
    registered = client.post("/images", json={"original_url": t["original_url"]})
    assert registered.status_code == 201, registered.text
    return registered.json(), t


# --- the client token ------------------------------------------------------------------------


def test_the_client_token_is_what_the_vercel_blob_javascript_sdk_makes() -> None:
    """The expected value was produced with the algorithm of @vercel/blob 2.9.0's
    `generateClientTokenFromReadWriteToken` (client.js: JSON payload to base64, hex HMAC-SHA256
    keyed by the read-write token, `vercel_blob_client_<store id>_<base64(sig.payload)>`),
    run in Node on this fixed input, not computed by this code."""
    token = client_token(
        "vercel_blob_rw_AbC123xyz_FAKEsecret0123456789",
        {
            "pathname": "originals/abcdefghijklmnopqrstuvwx",
            "maximumSizeInBytes": 26214400,
            "addRandomSuffix": False,
            "allowOverwrite": False,
            "validUntil": 1794600000000,
        },
    )
    assert token == (
        "vercel_blob_client_AbC123xyz_N2MzNTcwN2EwODJiNDgwZTg0ZDZjNDlmMzZkZTY3ZjRmODk1MzdkZmFiYzI"
        "2YmUzY2U4NTAyMjI2YjI0ZmU1Yy5leUp3WVhSb2JtRnRaU0k2SW05eWFXZHBibUZzY3k5aFltTmtaV1puYUdscWE"
        "yeHRibTl3Y1hKemRIVjJkM2dpTENKdFlYaHBiWFZ0VTJsNlpVbHVRbmwwWlhNaU9qSTJNakUwTkRBd0xDSmhaR1J"
        "TWVc1a2IyMVRkV1ptYVhnaU9tWmhiSE5sTENKaGJHeHZkMDkyWlhKM2NtbDBaU0k2Wm1Gc2MyVXNJblpoYkdsa1Z"
        "XNTBhV3dpT2pFM09UUTJNREF3TURBd01EQjk="
    )


# --- Scenario: direct upload in production ---------------------------------------------------


def test_the_browser_uploads_straight_to_blob_and_the_api_receives_only_the_stored_url() -> None:
    fake = FakeBlob()
    _, client = world(fake)
    data = jpeg(1200, 800)

    target = client.post("/images/upload-target", json={"size": len(data)}).json()
    assert target["upload_url"].startswith("https://vercel.com/api/blob/?pathname=originals%2F")
    assert target["original_url"].startswith(f"https://{HOST}/originals/")
    assert target["headers"]["authorization"].startswith("Bearer vercel_blob_client_")
    assert RW_TOKEN not in str(target)  # the read-write token never leaves the API

    assert fake.browser_put(target, data) == 200
    puts_before_register = [r for r in fake.requests if r.method == "PUT"]
    assert len(puts_before_register) == 1  # the browser's, with a client token
    assert fake.objects[unquote(target["upload_url"].split("pathname=")[1])] == data

    registered = client.post("/images", json={"original_url": target["original_url"]})
    assert registered.status_code == 201
    # The registration carried a URL and the API never PUT the original anywhere.
    assert fake.objects[unquote(target["upload_url"].split("pathname=")[1])] == data
    image = client.get(f"/images/{registered.json()['id']}").json()
    assert image["status"] == "ready"  # processed by the time the register call returned
    assert image["byte_size"] == len(data)  # size came from Blob (HEAD), not from the browser


def test_blob_refuses_what_the_target_does_not_allow() -> None:
    fake = FakeBlob()
    _, client = world(fake, IMAGE_MAX_BYTES="1000")
    t = client.post("/images/upload-target", json={"size": 500}).json()
    assert fake.browser_put(t, b"x" * 2000) == 400  # over the cap in the token
    assert fake.browser_put(t, b"x" * 500) == 200
    assert fake.browser_put(t, b"y" * 500) == 400  # the pathname is not overwritable
    other = client.post("/images/upload-target", json={"size": 500}).json()
    swapped = {**t, "headers": other["headers"]}  # a token for a different pathname
    assert fake.browser_put(swapped, b"z" * 10) == 400
    forged = {**t, "headers": {**t["headers"], "authorization": "Bearer vercel_blob_client_x_AAAA"}}
    assert fake.browser_put(forged, b"z") == 403


def test_a_target_over_the_limit_is_refused_before_any_token_is_made() -> None:
    fake = FakeBlob()
    _, client = world(fake, IMAGE_MAX_BYTES="1000")
    r = client.post("/images/upload-target", json={"size": 1001})
    assert r.status_code == 413 and r.json()["detail"]["limit"] == 1000
    assert fake.requests == []


def test_only_urls_this_api_issued_to_this_organisation_can_be_registered() -> None:
    fake = FakeBlob()
    _, client = world(fake)
    # An object that is in the store but whose URL was never issued as a target.
    fake.objects["originals/" + "a" * 32] = jpeg(100, 100)
    for url in (
        f"https://{HOST}/originals/{'a' * 32}",  # in the store, never issued
        "https://evil.example/originals/" + "a" * 32,  # another host
        f"https://{HOST}/web/x-480.jpg",  # not an original
        f"https://{HOST}/originals/../web/x.jpg",
        "http://" + HOST + "/originals/" + "a" * 32,  # not https
    ):
        r = client.post("/images", json={"original_url": url})
        assert r.status_code == 422, (url, r.text)
    # Nothing was read from outside the store.
    assert all(r.url.host in (HOST, "vercel.com") for r in fake.requests)


def test_an_original_refused_for_size_is_deleted_from_blob() -> None:
    fake = FakeBlob()
    _, client = world(fake, IMAGE_MAX_BYTES="1000")
    t = client.post("/images/upload-target", json={"size": 10}).json()
    pathname = t["original_url"].removeprefix(f"https://{HOST}/")
    # Blob's own cap should stop this; if it ever did not, the object must not be kept.
    fake.objects[pathname] = b"x" * 1001
    r = client.post("/images", json={"original_url": t["original_url"]})
    assert r.status_code == 413
    assert pathname not in fake.objects


def test_a_failed_delete_during_a_too_large_refusal_still_answers_413(
    caplog: pytest.LogCaptureFixture,
) -> None:
    fake = FakeBlob()
    _, client = world(fake, IMAGE_MAX_BYTES="1000")
    t = client.post("/images/upload-target", json={"size": 10}).json()
    pathname = t["original_url"].removeprefix(f"https://{HOST}/")
    fake.objects[pathname] = b"x" * 1001
    fake.fail_delete = True
    with caplog.at_level("WARNING"):
        r = client.post("/images", json={"original_url": t["original_url"]})
    assert r.status_code == 413
    assert r.json()["detail"]["limit"] == 1000
    assert any(pathname in m for m in caplog.messages)
    assert RW_TOKEN not in caplog.text and RW_TOKEN not in r.text
    assert "delete failed" not in caplog.text  # the error's message is not logged, its class is


def test_a_refused_registration_of_someone_elses_original_deletes_nothing() -> None:
    fake = FakeBlob()
    _, client = world(fake)
    _, t = browser_upload(client, fake, jpeg(300, 200))
    assert client.post("/images", json={"original_url": t["original_url"]}).status_code == 409
    assert fake.objects[t["original_url"].removeprefix(f"https://{HOST}/")]


def test_the_upload_url_encodes_the_pathname() -> None:
    store = BlobStore(RW_TOKEN)
    pathname = "originals/a b&c=d?e#f%g+h"
    target = store.upload_target(pathname, 1000)
    query = urlsplit(target.upload_url).query
    assert parse_qs(query, strict_parsing=True) == {"pathname": [pathname]}
    assert " " not in query and "&" not in query and "#" not in target.upload_url


def test_an_upload_that_has_not_been_made_yet_cannot_be_registered() -> None:
    fake = FakeBlob()
    _, client = world(fake)
    t = client.post("/images/upload-target", json={"size": 10}).json()
    assert client.post("/images", json={"original_url": t["original_url"]}).status_code == 422


def test_an_upload_is_registered_once() -> None:
    fake = FakeBlob()
    _, client = world(fake)
    _, t = browser_upload(client, fake, jpeg(300, 200))
    again = client.post("/images", json={"original_url": t["original_url"]})
    assert again.status_code == 409


def test_blob_being_down_is_not_mistaken_for_a_missing_upload() -> None:
    fake = FakeBlob()
    _, client = world(fake)
    t = client.post("/images/upload-target", json={"size": 10}).json()
    fake.down = True
    # An outage is an error, not a 422 "that is not an uploaded original".
    with pytest.raises(Exception):  # noqa: B017, PT011 - the TestClient re-raises the server error
        client.post("/images", json={"original_url": t["original_url"]})


# --- Scenario: originals stay at unguessable URLs --------------------------------------------


def test_originals_are_at_unguessable_pathnames() -> None:
    fake = FakeBlob()
    _, client = world(fake)
    paths = {
        client.post("/images/upload-target", json={"size": 10}).json()["original_url"]
        for _ in range(20)
    }
    assert len(paths) == 20
    for url in paths:
        token = url.rsplit("/", 1)[1]
        assert len(token) >= 32 and url.startswith(f"https://{HOST}/originals/")


def test_the_original_url_appears_in_no_public_or_owner_response_only_web_versions() -> None:
    fake = FakeBlob()
    container, owner = world(fake)
    image, target = browser_upload(owner, fake, jpeg(1200, 800))
    original = target["original_url"]
    token = original.rsplit("/", 1)[1]

    story = owner.post("/stories").json()
    photo = f'<Photo image="{image["id"]}" alt="A street" caption="" credit="" />'
    saved = owner.put(
        f"/stories/{story['id']}/draft",
        json={
            "title": "Dusk",
            "description": "d",
            "location": "Lisbon",
            "date": "2026-10-31",
            "content": f"Words.\n\n{photo}\n",
            "updated_at": story["updated_at"],
        },  # fmt: skip
    )
    assert saved.status_code == 200, saved.text
    assert owner.post(f"/stories/{story['id']}/publish").status_code == 200

    anon = TestClient(create_app(container=container))
    answers = [
        anon.get("/public/pieces"),
        anon.get(f"/public/pieces/{story['id']}"),
        owner.get(f"/images/{image['id']}"),
        owner.get(f"/stories/{story['id']}"),
    ]
    for r in answers:
        assert r.status_code == 200
        assert original not in r.text and token not in r.text and "originals/" not in r.text
        assert RW_TOKEN not in r.text
    piece = anon.get("/public/pieces").json()[0]["hero"]["versions"]
    assert piece and all(v["url"].startswith(f"https://{HOST}/web/") for v in piece)
    # The anonymous visitor cannot read an original through this API either.
    assert anon.get(f"/public/images/orig-{token}").status_code == 404
    assert anon.get(f"/images/{image['id']}").status_code == 401


def test_this_api_serves_no_image_file_once_blob_serves_the_web_versions() -> None:
    fake = FakeBlob()
    container, owner = world(fake)
    image, _ = browser_upload(owner, fake, jpeg(1200, 800))
    web = owner.get(f"/images/{image['id']}").json()["web_versions"][0]["url"]
    key = web.rsplit("/", 1)[1]
    assert container.local_images is None
    anon = TestClient(create_app(container=container))
    assert anon.get(f"/public/images/{key}").status_code == 404
    # The route is not there at all, rather than there and empty.
    # Even a file that is in the store is not proxied through this API.
    fake.objects[f"web/{key}"] = b"bytes"
    assert anon.get(f"/public/images/{key}").status_code == 404


def test_the_local_route_is_still_served_on_the_local_store(tmp_path) -> None:  # noqa: ANN001
    container = build_container(
        {
            "IDENTITY_PROVIDER": "stub",
            "API_ENVIRONMENT": "development",
            "STORY_REPOSITORY": "memory",
            "IMAGE_DIR": str(tmp_path),
        }  # fmt: skip
    )
    assert container.local_images is not None
    key = "0b7f3c9e-1111-4222-8333-444455556666-480.jpg"
    container.local_images.put(key, b"jpegbytes")
    r = TestClient(create_app(container=container)).get(f"/public/images/{key}")
    assert r.status_code == 200 and r.content == b"jpegbytes"


# --- Scenario: processing in production ------------------------------------------------------


def test_web_versions_are_written_to_blob_with_no_exif() -> None:
    fake = FakeBlob()
    _, client = world(fake)
    image, _ = browser_upload(client, fake, jpeg(3000, 2000))
    body = client.get(f"/images/{image['id']}").json()
    assert body["status"] == "ready"
    assert [v["width"] for v in body["web_versions"]] == [480, 960, 1600, 2400]
    for v in body["web_versions"]:
        assert v["url"] == f"https://{HOST}/web/{image['id']}-{v['width']}.jpg"
        data = fake.objects[f"web/{image['id']}-{v['width']}.jpg"]
        exif, gps, info = exif_of(data)
        assert exif == {} and gps == {} and not (info - {"jfif", "jfif_version", "jfif_unit",
                                                         "jfif_density", "dpi"})  # fmt: skip
    # The API wrote them with its read-write token; the browser's client token is for originals.
    web_puts = [
        r
        for r in fake.requests
        if r.method == "PUT" and r.url.params.get("pathname", "").startswith("web/")
    ]
    assert len(web_puts) == 4
    assert all(r.headers["authorization"] == f"Bearer {RW_TOKEN}" for r in web_puts)


def test_a_25_mb_original_is_processed_and_written_to_blob_within_the_timeout() -> None:
    """Measured, not assumed: a ~24 MB, 13 MP original of the least compressible kind (noise)
    goes through the whole production path, the real clock timing it against the 120 s limit
    the image is failed at."""
    side = (4200, 3100)
    pixels = Image.frombytes("RGB", side, os.urandom(side[0] * side[1] * 3))
    out = io.BytesIO()
    pixels.save(out, "JPEG", quality=100)
    original = out.getvalue()
    assert 22 * 1024 * 1024 <= len(original) <= 25 * 1024 * 1024

    fake = FakeBlob()
    _, client = world(fake)
    started = time.monotonic()
    image, _ = browser_upload(client, fake, original)  # inline: ready when register returns
    elapsed = time.monotonic() - started
    body = client.get(f"/images/{image['id']}").json()
    assert body["status"] == "ready", body
    assert elapsed < 120
    assert len([k for k in fake.objects if k.startswith("web/")]) == 4
    print(f"25 MB original: uploaded, processed and written in {elapsed:.1f} s")  # noqa: T201


def test_the_inline_processor_has_finished_when_enqueue_returns() -> None:
    done: list[tuple[str, str]] = []
    InlineImageProcessor(lambda org, i: done.append((org, i))).enqueue("o", "i")
    assert done == [("o", "i")]


def test_production_runs_processing_inline_and_local_runs_a_thread() -> None:
    prod = build_container(
        {"VERCEL_ENV": "production", "STORY_REPOSITORY": "memory"}, blob_http=None
    )
    assert type(prod.image_service._processor).__name__ == "InlineImageProcessor"  # noqa: SLF001
    local = build_container({"STORY_REPOSITORY": "memory"})
    assert type(local.image_service._processor).__name__ == "InProcessImageProcessor"  # noqa: SLF001


# --- Composition: production picks Blob and Postgres when the environment is present ---------


def test_production_with_the_token_picks_blob_and_postgres() -> None:
    c = build_container(
        {
            "VERCEL_ENV": "production",
            "BLOB_READ_WRITE_TOKEN": RW_TOKEN,
            "DATABASE_URL": "postgresql://u:p@127.0.0.1:1/db",
        }  # fmt: skip
    )
    assert isinstance(c.images, BlobImageStore)
    assert isinstance(c.image_service._uploads, BlobOriginalUploads)  # noqa: SLF001
    assert isinstance(c.image_service._images, PostgresImageRepository)  # noqa: SLF001
    assert c.local_images is None and c.local_uploads is None


def test_production_without_the_token_has_no_upload_target() -> None:
    c = build_container({"VERCEL_ENV": "production", "DATABASE_URL": "postgresql://u:p@h/db"})
    assert not isinstance(c.images, BlobImageStore)
    with pytest.raises(Exception):  # noqa: B017, PT011 - ImageUploadsUnavailableError
        c.image_service.upload_target(MVP_ORGANISATION_ID, 10)


def test_a_preview_keeps_memory_and_never_writes_to_the_blob_store_unasked() -> None:
    c = build_container({"VERCEL_ENV": "preview", "BLOB_READ_WRITE_TOKEN": RW_TOKEN})
    assert isinstance(c.image_service._images, InMemoryImageRepository)  # noqa: SLF001
    assert not isinstance(c.images, BlobImageStore)
    with pytest.raises(Exception):  # noqa: B017, PT011
        c.image_service.upload_target(MVP_ORGANISATION_ID, 10)


@pytest.mark.parametrize(
    "extra",
    [{"BLOB_READ_WRITE_TOKEN": ""}, {"BLOB_READ_WRITE_TOKEN": "not-a-token"}],
)
def test_asking_for_blob_without_a_usable_token_stops_the_app_starting(extra: dict) -> None:
    with pytest.raises(ConfigError, match="BLOB_READ_WRITE_TOKEN|read-write"):
        build_container({**ENV, **extra})


def test_the_token_value_is_in_no_error_message() -> None:
    with pytest.raises(ConfigError) as e:
        build_container({**ENV, "BLOB_READ_WRITE_TOKEN": "vercel_blob_rw_secretvalue"})
    assert "secretvalue" not in str(e.value)


# --- Adapter details --------------------------------------------------------------------------


def test_the_image_store_puts_public_cacheable_jpegs_under_web() -> None:
    fake = FakeBlob()
    store = BlobImageStore(BlobStore(RW_TOKEN, http_client_factory=fake.client))
    url = store.put("abc-480.jpg", b"jpegbytes")
    assert url == f"https://{HOST}/web/abc-480.jpg"
    assert store.get("abc-480.jpg") == b"jpegbytes"
    assert store.get("missing.jpg") is None
    put = next(r for r in fake.requests if r.method == "PUT")
    assert put.headers["x-vercel-blob-access"] == "public"
    assert put.headers["x-cache-control-max-age"] == "31536000"
    assert put.headers["x-content-type"] == "image/jpeg"
    with pytest.raises(ValueError):
        store.put("../escape.jpg", b"x")


def test_a_late_worker_cannot_revive_a_timed_out_image_on_blob_either() -> None:
    fake = FakeBlob()
    container = build_container({**ENV, "IMAGE_PROCESSING": "thread"}, blob_http=fake.client)
    clock = FakeClock()
    repo = InMemoryImageRepository()
    jobs: list[Callable[[], None]] = []
    uploads = container.image_service._uploads  # noqa: SLF001

    class Later:
        def enqueue(self, organisation_id: str, image_id: str) -> None:
            jobs.append(
                lambda: process_image(
                    organisation_id,
                    image_id,
                    images=repo,
                    uploads=uploads,
                    store=container.images,
                    renderer=PillowImageRenderer(),
                )  # fmt: skip
            )

    service = ImageService(
        repo, uploads, Later(), clock,
        max_bytes=10_000_000, timeout=timedelta(seconds=120),
    )  # fmt: skip
    client = TestClient(
        create_app(container=replace(container, image_service=service, image_status=service))
    )
    assert client.get("/auth/callback", follow_redirects=False).status_code == 303
    t = client.post("/images/upload-target", json={"size": 100}).json()
    assert fake.browser_put(t, jpeg(600, 400)) == 200
    image = client.post("/images", json={"original_url": t["original_url"]}).json()
    clock.t += timedelta(seconds=500)
    assert client.get(f"/images/{image['id']}").json()["status"] == "failed"
    jobs[0]()  # the worker finishes late
    assert client.get(f"/images/{image['id']}").json()["status"] == "failed"
