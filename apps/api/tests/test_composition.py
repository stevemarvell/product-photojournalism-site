"""Scenarios: local config, adapters by configuration, stub sign-in refused when deployed."""

import pytest
from fastapi.testclient import TestClient

from api.adapters.clock import SystemClock
from api.adapters.filesystem import FilesystemImageStore
from api.adapters.memory import InMemoryStoryRepository
from api.adapters.postgres import PostgresStoryRepository
from api.adapters.stub_identity import StubIdentityProvider
from api.composition import ConfigError, build_container
from api.main import create_app

UNREACHABLE = "postgresql://photo:s3cret-pw@127.0.0.1:1/photos"


def test_local_defaults_use_memory_filesystem_and_stub() -> None:
    c = build_container({})
    assert isinstance(c.stories, InMemoryStoryRepository)
    assert isinstance(c.images, FilesystemImageStore)
    assert isinstance(c.identity, StubIdentityProvider)
    assert isinstance(c.clock, SystemClock)
    assert c.identity.current_user().is_owner


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
    with pytest.raises(ConfigError):
        create_app(env={"VERCEL_ENV": vercel_env})
    with pytest.raises(ConfigError):
        create_app(env={"VERCEL_ENV": vercel_env, "IDENTITY_PROVIDER": "stub"})


def test_filesystem_image_store_round_trips_and_refuses_path_traversal(tmp_path) -> None:
    store = FilesystemImageStore(tmp_path / "images")
    store.put("a1", b"bytes")
    assert store.get("a1") == b"bytes"
    assert store.get("missing") is None
    with pytest.raises(ValueError):
        store.put("../escape", b"x")
