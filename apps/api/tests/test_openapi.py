"""Tests for the gate on Swagger UI, ReDoc and the OpenAPI document.

FastAPI serves all three by default. `/docs` is an interactive console and
`/openapi.json` a published schema of every route, so production withholds
them. See create_app() in api.main.

The checks go both ways on purpose. Asserting only the 404s would pass just as
well if the gate turned the schema off everywhere, which would take the
documentation away from development for no gain.
"""

from fastapi.testclient import TestClient

from api.main import app, create_app

# The module-level app: no explicit environment, so it is the deployed one.
client = TestClient(app)
production = TestClient(create_app(environment="production"))
development = TestClient(create_app(environment="development"))

SCHEMA_PATHS = ("/docs", "/redoc", "/openapi.json")


def test_the_default_app_serves_no_schema_surface() -> None:
    """A plain create_app() is what the deployed service runs -- API_ENVIRONMENT is unset there."""
    for path in SCHEMA_PATHS:
        assert client.get(path).status_code == 404, path


def test_production_serves_no_schema_surface() -> None:
    for path in SCHEMA_PATHS:
        assert production.get(path).status_code == 404, path


def test_development_serves_every_schema_surface() -> None:
    for path in SCHEMA_PATHS:
        assert development.get(path).status_code == 200, path


def test_development_swagger_ui_is_the_interactive_console() -> None:
    """The thing being gated: Swagger UI, not merely a path that answers 200."""
    assert "swagger-ui" in development.get("/docs").text


def test_development_publishes_the_health_route() -> None:
    assert "/health" in development.get("/openapi.json").json()["paths"]


def test_production_still_serves_health() -> None:
    """Gating the schema off must not cost the route that shares the app."""
    assert production.get("/health").status_code == 200
