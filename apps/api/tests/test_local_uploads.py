"""The local upload endpoint writes the owner's bytes to the host's disk, so it exists only
in local/development configuration and never where VERCEL_ENV is set."""

import pytest
from fastapi.testclient import TestClient

from api.composition import ConfigError, build_container
from api.guard import is_public_path
from api.main import create_app

DEV = {"API_ENVIRONMENT": "development", "STORY_REPOSITORY": "memory"}


def upload_paths(env: dict[str, str]) -> list[str]:
    app = create_app(env=env)
    return [
        p for r in app.routes if isinstance(p := getattr(r, "path", None), str) and "uploads" in p
    ] + [
        f"{getattr(getattr(r, 'include_context', None), 'prefix', '')}{p.path}"
        for r in app.routes
        for p in getattr(getattr(r, "original_router", None), "routes", [])
        if "uploads" in getattr(p, "path", "")
    ]


def test_development_enables_it_by_default() -> None:
    assert build_container(DEV).local_uploads is not None
    assert upload_paths(DEV)


@pytest.mark.parametrize(
    "env",
    [
        {"STORY_REPOSITORY": "memory"},  # not development
        {"API_ENVIRONMENT": "production", "STORY_REPOSITORY": "memory"},
        {**DEV, "IMAGE_UPLOADS": "off"},
        {**DEV, "VERCEL_ENV": "preview"},  # development flag set, but deployed
        {**DEV, "VERCEL_ENV": "production"},
        {"VERCEL_ENV": "preview", "STORY_REPOSITORY": "memory"},
    ],
)
def test_everywhere_else_the_endpoint_is_not_mounted(env: dict[str, str]) -> None:
    assert build_container(env).local_uploads is None
    assert upload_paths(env) == []
    client = TestClient(create_app(env=env))
    # Not 401 (a route that refuses strangers) but 404: there is no such route to find.
    assert client.put("/images/uploads/anything", content=b"x").status_code == 404


@pytest.mark.parametrize("vercel_env", ["production", "preview", "development"])
def test_asking_for_it_on_vercel_stops_the_app_starting(vercel_env: str) -> None:
    env = {**DEV, "VERCEL_ENV": vercel_env, "IMAGE_UPLOADS": "local"}
    with pytest.raises(ConfigError, match="VERCEL_ENV"):
        build_container(env)
    with pytest.raises(ConfigError):
        create_app(env=env)


def test_an_unknown_setting_is_refused() -> None:
    with pytest.raises(ConfigError, match="IMAGE_UPLOADS"):
        build_container({**DEV, "IMAGE_UPLOADS": "carrier-pigeon"})


@pytest.mark.parametrize("name", ["IMAGE_MAX_BYTES", "IMAGE_PROCESSING_TIMEOUT_SECONDS"])
@pytest.mark.parametrize("value", ["0", "-5", "lots"])
def test_limits_must_be_positive_whole_numbers(name: str, value: str) -> None:
    with pytest.raises(ConfigError, match=name):
        build_container({**DEV, name: value})


def test_without_an_upload_target_asking_for_one_is_a_503_not_a_crash() -> None:
    env = {**DEV, "IDENTITY_PROVIDER": "stub", "IMAGE_UPLOADS": "off"}
    client = TestClient(create_app(env=env))
    assert client.get("/auth/callback", follow_redirects=False).status_code == 303
    assert client.post("/images/upload-target", json={"size": 5}).status_code == 503
    assert client.post("/images", json={"original_url": "local:orig-x"}).status_code == 422


def test_the_upload_endpoint_is_never_public() -> None:
    assert not is_public_path("/images/uploads/abc")


def test_a_signed_out_visitor_cannot_upload() -> None:
    client = TestClient(create_app(env=DEV))
    assert client.put("/images/uploads/abc", content=b"x").status_code == 401
    assert client.post("/images/upload-target", json={"size": 1}).status_code == 401
    assert client.post("/images", json={"original_url": "x"}).status_code == 401
