"""Scenarios: local config, adapters by configuration, stub sign-in refused when deployed."""

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from api.adapters.clock import SystemClock
from api.adapters.filesystem import FilesystemImageStore
from api.adapters.memory import InMemoryStoryRepository
from api.adapters.no_identity import NoIdentityProvider
from api.adapters.postgres import PostgresStoryRepository
from api.adapters.stub_identity import StubIdentityProvider
from api.composition import (
    DEFAULT_CORS_ORIGINS,
    DEPLOYED_CORS_ORIGINS,
    ConfigError,
    build_container,
)
from api.main import create_app

UNREACHABLE = "postgresql://photo:s3cret-pw@127.0.0.1:1/photos"


def test_local_defaults_use_memory_filesystem_and_stub() -> None:
    c = build_container({})
    assert isinstance(c.stories, InMemoryStoryRepository)
    assert isinstance(c.images, FilesystemImageStore)
    assert isinstance(c.identity, NoIdentityProvider)
    assert c.identity.current_user() is None
    assert isinstance(c.clock, SystemClock)


def test_stub_needs_explicit_choice_and_development() -> None:
    dev = {"IDENTITY_PROVIDER": "stub", "API_ENVIRONMENT": "development"}
    c = build_container(dev)
    assert isinstance(c.identity, StubIdentityProvider)
    assert c.identity.current_user().is_owner
    with pytest.raises(ConfigError):
        build_container({"IDENTITY_PROVIDER": "stub"})
    with pytest.raises(ConfigError):
        build_container({"IDENTITY_PROVIDER": "stub", "API_ENVIRONMENT": "production"})
    with pytest.raises(ConfigError):
        build_container({**dev, "VERCEL_ENV": "preview"})


def test_local_health_is_healthy() -> None:
    r = TestClient(create_app(env={})).get("/health")
    assert r.status_code == 200
    assert r.json()["ok"] is True


def test_postgres_is_chosen_by_configuration() -> None:
    c = build_container({"STORY_REPOSITORY": "postgres", "DATABASE_URL": UNREACHABLE})
    assert isinstance(c.stories, PostgresStoryRepository)


def test_postgres_health_reports_reachable_when_the_database_answers(monkeypatch) -> None:
    # No live Postgres in CI: the driver call is replaced, so this covers wiring only.
    monkeypatch.setattr(PostgresStoryRepository, "ping", lambda self: True)
    app = create_app(env={"STORY_REPOSITORY": "postgres", "DATABASE_URL": UNREACHABLE})
    r = TestClient(app).get("/health")
    assert r.status_code == 200
    assert r.json()["database"] == {"adapter": "postgres", "reachable": True}


def test_unreachable_database_is_non_200_and_leaks_nothing() -> None:
    app = create_app(env={"STORY_REPOSITORY": "postgres", "DATABASE_URL": UNREACHABLE})
    r = TestClient(app).get("/health")
    assert r.status_code == 503
    assert r.json()["database"] == {"adapter": "postgres", "reachable": False}
    for secret in ("s3cret-pw", "photo", "127.0.0.1", "postgresql://"):
        assert secret not in r.text


def test_postgres_without_a_url_refuses_to_start() -> None:
    with pytest.raises(ConfigError):
        build_container({"STORY_REPOSITORY": "postgres"})


@pytest.mark.parametrize("key", ["STORY_REPOSITORY", "IMAGE_STORE", "IDENTITY_PROVIDER"])
def test_unknown_adapter_names_refuse_to_start(key: str) -> None:
    with pytest.raises(ConfigError):
        build_container({key: "nonsense"})


@pytest.mark.parametrize("vercel_env", ["production", "preview", "development"])
def test_stub_identity_refuses_to_start_when_deployed(vercel_env: str) -> None:
    deployed = {"VERCEL_ENV": vercel_env, "IDENTITY_PROVIDER": "stub"}
    with pytest.raises(ConfigError):
        create_app(env=deployed)
    with pytest.raises(ConfigError):
        create_app(env={**deployed, "API_ENVIRONMENT": "development"})


def test_deployed_default_starts_with_no_identity() -> None:
    env = {"VERCEL_ENV": "production", "DATABASE_URL": UNREACHABLE}
    assert isinstance(build_container(env).identity, NoIdentityProvider)
    assert create_app(env=env) is not None


def test_deployed_defaults_to_postgres_and_refuses_without_a_url() -> None:
    c = build_container({"VERCEL_ENV": "preview", "POSTGRES_URL": UNREACHABLE})
    assert isinstance(c.stories, PostgresStoryRepository)
    with pytest.raises(ConfigError):
        build_container({"VERCEL_ENV": "preview"})


def test_deployed_defaults_to_a_writable_image_dir_and_the_web_origin() -> None:
    c = build_container({"VERCEL_ENV": "production", "DATABASE_URL": UNREACHABLE})
    assert isinstance(c.images, FilesystemImageStore)
    assert c.images._root == Path("/tmp/images")
    assert c.cors_origins == DEPLOYED_CORS_ORIGINS
    assert build_container({}).cors_origins == DEFAULT_CORS_ORIGINS


def test_filesystem_image_store_round_trips_and_refuses_path_traversal(tmp_path) -> None:
    store = FilesystemImageStore(tmp_path / "images")
    store.put("a1", b"bytes")
    assert store.get("a1") == b"bytes"
    assert store.get("missing") is None
    with pytest.raises(ValueError):
        store.put("../escape", b"x")
