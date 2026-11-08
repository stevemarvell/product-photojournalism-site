"""Tests for /health, which smoke reads to tell a current deployment from a stale one."""

import importlib

from fastapi.testclient import TestClient

import api.main


def test_health_is_ok_without_a_commit_locally(monkeypatch) -> None:
    monkeypatch.delenv("VERCEL_GIT_COMMIT_SHA", raising=False)
    module = importlib.reload(api.main)
    assert TestClient(module.create_app()).get("/health").json() == {
        "ok": True,
        "commit": None,
        "database": {"adapter": "memory", "reachable": True},
    }


def test_health_reports_the_deployed_commit(monkeypatch) -> None:
    monkeypatch.setenv("VERCEL_GIT_COMMIT_SHA", "abc123")
    module = importlib.reload(api.main)
    assert TestClient(module.create_app()).get("/health").json() == {
        "ok": True,
        "commit": "abc123",
        "database": {"adapter": "memory", "reachable": True},
    }


def test_version_reports_the_deployed_commit(monkeypatch) -> None:
    monkeypatch.setenv("VERCEL_GIT_COMMIT_SHA", "abc123")
    module = importlib.reload(api.main)
    r = TestClient(module.create_app(env={})).get("/version")
    assert r.status_code == 200
    assert r.json() == {"commit": "abc123"}


def test_version_is_200_with_the_commit_while_the_database_is_unreachable(monkeypatch) -> None:
    monkeypatch.setenv("VERCEL_GIT_COMMIT_SHA", "abc123")
    module = importlib.reload(api.main)
    env = {
        "STORY_REPOSITORY": "postgres",
        "DATABASE_URL": "postgresql://photo:pw@127.0.0.1:1/photos",
    }
    client = TestClient(module.create_app(env=env))
    assert client.get("/health").status_code == 503
    r = client.get("/version")
    assert r.status_code == 200
    assert r.json() == {"commit": "abc123"}
