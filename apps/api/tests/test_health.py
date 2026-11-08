"""Tests for /health, which smoke reads to tell a current deployment from a stale one."""

import importlib

from fastapi.testclient import TestClient

import api.main


def test_health_is_ok_without_a_commit_locally(monkeypatch) -> None:
    monkeypatch.delenv("VERCEL_GIT_COMMIT_SHA", raising=False)
    module = importlib.reload(api.main)
    assert TestClient(module.create_app()).get("/health").json() == {"ok": True, "commit": None}


def test_health_reports_the_deployed_commit(monkeypatch) -> None:
    monkeypatch.setenv("VERCEL_GIT_COMMIT_SHA", "abc123")
    module = importlib.reload(api.main)
    assert TestClient(module.create_app()).get("/health").json() == {"ok": True, "commit": "abc123"}
