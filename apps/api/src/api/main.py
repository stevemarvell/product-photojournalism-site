"""The API's shell: a health check behind security headers.

A placeholder, serving no application data, kept live until a real
application replaces it.
"""

import os

from fastapi import FastAPI

from api.security_headers import install_security_headers

# Defaults to "production", the safe setting, so a forgotten variable fails
# closed. API_ENVIRONMENT=development turns on the OpenAPI surface below.
API_ENVIRONMENT = os.environ.get("API_ENVIRONMENT", "production")

# Reported by /health so smoke can tell a current deployment from a stale one.
# Vercel sets it at runtime; it is absent locally, where None is right.
DEPLOYED_COMMIT = os.environ.get("VERCEL_GIT_COMMIT_SHA")


def create_app(*, environment: str | None = None) -> FastAPI:
    """Build the app; `environment` defaults to API_ENVIRONMENT."""
    is_development = (environment or API_ENVIRONMENT) == "development"

    # Swagger UI is an unauthenticated console and openapi.json a published
    # schema. FastAPI turns both on by default; production passes None.
    app = FastAPI(
        title="api",
        docs_url="/docs" if is_development else None,
        redoc_url="/redoc" if is_development else None,
        openapi_url="/openapi.json" if is_development else None,
    )

    @app.get("/health")
    def health() -> dict[str, bool | str | None]:
        return {"ok": True, "commit": DEPLOYED_COMMIT}

    install_security_headers(app, is_development=is_development)
    return app


app = create_app()
