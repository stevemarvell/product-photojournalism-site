"""CORS: the web app's origin may read /health; others may not; never '*'."""

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from api.composition import ConfigError, build_container
from api.main import create_app

ORIGIN = "http://localhost:5173"


def test_default_origin_is_allowed() -> None:
    r = TestClient(create_app(env={})).get("/health", headers={"Origin": ORIGIN})
    assert r.headers["access-control-allow-origin"] == ORIGIN
    assert "access-control-allow-credentials" not in r.headers


def test_other_origins_get_no_cors_header() -> None:
    r = TestClient(create_app(env={})).get("/health", headers={"Origin": "http://evil.example"})
    assert "access-control-allow-origin" not in r.headers


def test_origins_come_from_the_environment() -> None:
    app = create_app(env={"CORS_ALLOWED_ORIGINS": "https://web.example, https://b.example"})
    r = TestClient(app).get("/health", headers={"Origin": "https://b.example"})
    assert r.headers["access-control-allow-origin"] == "https://b.example"


def test_wildcard_origin_refuses_to_start() -> None:
    with pytest.raises(ConfigError):
        build_container({"CORS_ALLOWED_ORIGINS": "*"})


def test_the_deployed_web_origin_is_the_one_project_json_names() -> None:
    root = Path(__file__).resolve().parents[3]
    web_url = json.loads((root / "project.json").read_text())["apps"]["web"]["deploy"]["url"]
    app = create_app(env={"VERCEL_ENV": "production", "STORY_REPOSITORY": "memory"})
    r = TestClient(app).get("/health", headers={"Origin": web_url})
    assert r.headers["access-control-allow-origin"] == web_url
    other = TestClient(app).get("/health", headers={"Origin": ORIGIN})
    assert "access-control-allow-origin" not in other.headers
