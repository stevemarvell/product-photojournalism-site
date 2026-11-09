"""The API's shell: a health check behind security headers.

A placeholder, serving no application data, kept live until a real
application replaces it.
"""

import os
import secrets
from collections.abc import Mapping
from datetime import datetime, timedelta

from fastapi import FastAPI, Response
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.sessions import SessionMiddleware

from api.auth_routes import NoStoreAuth
from api.auth_routes import owner_router as auth_owner_router
from api.auth_routes import router as auth_router
from api.composition import Container, build_container
from api.security_headers import install_security_headers
from api.story_routes import not_implemented_handler
from api.story_routes import router as story_router

# Defaults to "production", the safe setting, so a forgotten variable fails
# closed. API_ENVIRONMENT=development turns on the OpenAPI surface below.
API_ENVIRONMENT = os.environ.get("API_ENVIRONMENT", "production")

# Reported by /health so smoke can tell a current deployment from a stale one.
# Vercel sets it at runtime; it is absent locally, where None is right.
DEPLOYED_COMMIT = os.environ.get("VERCEL_GIT_COMMIT_SHA")


# How long a sign-in lasts. The cookie is signed and also names a server-side
# session record (api.guard.current_user), so signing out or revoking all
# sessions refuses a copied cookie at once, before this runs out.
SESSION_MAX_AGE = 12 * 60 * 60

# How long /health reuses a database ping.
HEALTH_CACHE_TTL = timedelta(seconds=10)


def create_app(
    *,
    environment: str | None = None,
    env: Mapping[str, str] | None = None,
    container: Container | None = None,
) -> FastAPI:
    """Build the app; `environment` defaults to API_ENVIRONMENT, `env` to os.environ.

    Raises ConfigError, so refuses to start, on a configuration that cannot run
    (such as the stub identity provider when deployed).
    """
    container = container or build_container(os.environ if env is None else env)
    is_development = (environment or API_ENVIRONMENT) == "development"

    # Swagger UI is an unauthenticated console and openapi.json a published
    # schema. FastAPI turns both on by default; production passes None.
    app = FastAPI(
        title="api",
        docs_url="/docs" if is_development else None,
        redoc_url="/redoc" if is_development else None,
        openapi_url="/openapi.json" if is_development else None,
    )

    app.state.container = container
    app.include_router(auth_router)
    app.include_router(auth_owner_router)
    app.include_router(story_router)
    app.add_exception_handler(NotImplementedError, not_implemented_handler)

    # The session: a signed cookie (itsdangerous via Starlette), always HttpOnly,
    # SameSite=Lax so the redirect back from Vercel carries it, and Secure
    # wherever the site is served over https. Without a usable SESSION_SECRET the
    # provider signs nobody in, so a throwaway key costs nothing.
    app.add_middleware(
        SessionMiddleware,
        secret_key=container.session_secret or secrets.token_urlsafe(32),
        session_cookie="session",
        max_age=SESSION_MAX_AGE,
        same_site="lax",
        https_only=container.public_origin.startswith("https://"),
    )

    app.add_middleware(NoStoreAuth)

    # Credentials are not used, so a fixed origin list is safe; never "*" here.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(container.cors_origins),
        allow_credentials=False,
        allow_methods=["GET"],
        allow_headers=[],
    )

    # /health is public, so a probe flood must not become a connection flood:
    # the ping result is reused for a short time.
    cached: list[tuple[datetime, bool]] = []

    def ping_cached() -> bool:
        now = container.clock.now()
        if cached and now - cached[0][0] < HEALTH_CACHE_TTL:
            return cached[0][1]
        result = container.stories.ping()
        cached[:] = [(now, result)]
        return result

    @app.get("/health")
    def health(response: Response) -> dict[str, object]:
        reachable = ping_cached()
        if not reachable:
            response.status_code = 503
        # Deliberately only a name and a boolean: never the connection string.
        return {
            "ok": reachable,
            "commit": DEPLOYED_COMMIT,
            "database": {"adapter": container.story_repository_name, "reachable": reachable},
        }

    @app.get("/version")
    def version() -> dict[str, str | None]:
        # The freshness gate's endpoint (project.json commitEndpoint). It never
        # touches the database, so an outage reads as an outage, not a stale build.
        return {"commit": DEPLOYED_COMMIT}

    install_security_headers(app, is_development=is_development)
    return app


app = create_app()
