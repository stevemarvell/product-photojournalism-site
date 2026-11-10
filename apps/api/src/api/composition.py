"""Composition root: the one place that picks adapters, from environment variables.

STORY_REPOSITORY   memory | postgres (needs DATABASE_URL, or POSTGRES_URL, which the
                   Vercel/Neon integration injects). The default is postgres only where
                   VERCEL_ENV=production, so a deployment never silently runs on memory
                   and a preview never gets the database unless it is asked for.
SESSIONS           follow STORY_REPOSITORY: postgres uses the same database (so sign-out and
                   revoke-all hold across serverless instances), memory is per process.
                   The schema is migrated (yoyo, under an advisory lock) before the first
                   query of the process, not at import, so an unreachable database still
                   lets /health answer 503. Image rows are in-memory for now (#40).
IMAGE_STORE        filesystem (default); IMAGE_DIR sets where (default .data/images,
                   /tmp/images where VERCEL_ENV is set: the bundle is read-only there)
IMAGE_UPLOADS      local | off. local: originals are uploaded to this API's owner-only
                   PUT /images/uploads/{token} and kept in the image store. The default is
                   local only with API_ENVIRONMENT=development and no VERCEL_ENV, else off
                   (no upload target: uploads answer 503 until Vercel Blob is provisioned).
                   local with VERCEL_ENV set is refused at startup.
IMAGE_MAX_BYTES    largest original accepted (default 26214400, 25 MB)
IMAGE_MAX_PIXELS   most pixels an original may declare (default 64000000); more fails it
IMAGE_PROCESSING_TIMEOUT_SECONDS  an image still processing after this is failed when next
                   read (default 120)
IDENTITY_PROVIDER  none | stub (only with API_ENVIRONMENT=development; refused when
                   VERCEL_ENV is set) | vercel (Sign in with Vercel; needs
                   VERCEL_OAUTH_CLIENT_ID, VERCEL_OAUTH_CLIENT_SECRET, OWNER_VERCEL_ID,
                   SESSION_SECRET). Default: vercel where VERCEL_ENV is set, else none.
                   With vercel and any setting missing the API still starts: the
                   provider is then "none" (owner routes 401, /auth/* 503).
PUBLIC_WEB_ORIGIN  the origin visitors use (the OAuth redirect is <it>/api/auth/callback);
                   default the deployed web app where VERCEL_ENV is set, else localhost:5173
CORS_ALLOWED_ORIGINS  comma-separated origins (default: the local Vite dev server;
                   where VERCEL_ENV is set, the deployed web app)
"""

import logging
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import timedelta
from pathlib import Path

from api.adapters.clock import SystemClock
from api.adapters.filesystem import (
    FilesystemImageStore,
    LocalOriginalUploads,
    UnconfiguredOriginalUploads,
)
from api.adapters.memory import (
    InMemoryImageRepository,
    InMemorySessionStore,
    InMemoryStoryRepository,
)
from api.adapters.no_identity import NoIdentityProvider
from api.adapters.pillow_images import (
    DEFAULT_MAX_PIXELS,
    InProcessImageProcessor,
    PillowImageRenderer,
)
from api.adapters.postgres import PostgresDatabase, PostgresSessionStore, PostgresStoryRepository
from api.adapters.stub_identity import StubIdentityProvider
from api.adapters.vercel_identity import VercelIdentityProvider
from api.application import (
    Clock,
    IdentityProvider,
    ImageService,
    ImageStatusLookup,
    ImageStore,
    OriginalUploads,
    SessionStore,
    StoryRepository,
    process_image,
)

log = logging.getLogger(__name__)

MIN_SESSION_SECRET_LENGTH = 32
DEFAULT_IMAGE_MAX_BYTES = 25 * 1024 * 1024
DEFAULT_IMAGE_TIMEOUT_SECONDS = 120
VERCEL_SETTINGS = ("VERCEL_OAUTH_CLIENT_ID", "VERCEL_OAUTH_CLIENT_SECRET", "OWNER_VERCEL_ID")
DEFAULT_WEB_ORIGIN = "http://localhost:5173"
DEFAULT_CORS_ORIGINS = ("http://localhost:5173", "http://127.0.0.1:5173")
# Committed here because Vercel offers no committed place for runtime variables;
# it is the web project's production URL (project.json, apps.web.deploy.url).
DEPLOYED_CORS_ORIGINS = ("https://photojournalism-site-stevemarvell-team.vercel.app",)


class ConfigError(RuntimeError):
    """The configuration cannot be run; the app must not start."""


@dataclass(frozen=True)
class Container:
    stories: StoryRepository
    story_repository_name: str
    images: ImageStore
    image_service: ImageService
    # The publish rule's lookup: the image service itself, unless a test swaps it.
    image_status: ImageStatusLookup
    # Set only when the local upload endpoint is enabled (never where VERCEL_ENV is set).
    local_uploads: LocalOriginalUploads | None
    sessions: SessionStore
    identity: IdentityProvider
    identity_name: str
    clock: Clock
    cors_origins: tuple[str, ...]
    # Where visitors reach the site; the OAuth callback is public_origin + /api/auth/callback.
    public_origin: str
    # None means "no usable secret": the app signs sessions with a throwaway key,
    # which authenticates nobody because the provider is then not signing anyone in.
    session_secret: str | None


def build_container(env: Mapping[str, str]) -> Container:
    identity_name = env.get("IDENTITY_PROVIDER") or ("vercel" if env.get("VERCEL_ENV") else "none")
    identity: IdentityProvider
    session_secret: str | None = None
    if identity_name == "none":
        identity = NoIdentityProvider()
    elif identity_name == "stub":
        # Signs in as the owner, so it must be asked for twice over: explicitly,
        # and in development, and never where Vercel has set VERCEL_ENV.
        if env.get("VERCEL_ENV"):
            raise ConfigError("IDENTITY_PROVIDER=stub is not allowed when VERCEL_ENV is set")
        if env.get("API_ENVIRONMENT") != "development":
            raise ConfigError("IDENTITY_PROVIDER=stub needs API_ENVIRONMENT=development")
        identity = StubIdentityProvider()
    elif identity_name == "vercel":
        secret = env.get("SESSION_SECRET", "")
        missing = [k for k in VERCEL_SETTINGS if not env.get(k)]
        if len(secret) < MIN_SESSION_SECRET_LENGTH:
            missing.append(f"SESSION_SECRET (at least {MIN_SESSION_SECRET_LENGTH} characters)")
        if missing:
            # Deliberately not a ConfigError: the deployed site must stay up
            # while the owner has yet to create the OAuth app.
            log.warning("sign-in not configured; missing: %s", ", ".join(missing))
            identity = NoIdentityProvider()
            identity_name = "vercel (not configured)"
        else:
            session_secret = secret
            identity = VercelIdentityProvider(
                client_id=env["VERCEL_OAUTH_CLIENT_ID"],
                client_secret=env["VERCEL_OAUTH_CLIENT_SECRET"],
                owner_vercel_id=env["OWNER_VERCEL_ID"],
                session_secret=secret,
            )
    else:
        raise ConfigError(f"unknown IDENTITY_PROVIDER {identity_name!r}")

    deployed = bool(env.get("VERCEL_ENV"))
    # Only production reaches the database by default: a preview runs branch
    # code, so it gets the database only when STORY_REPOSITORY asks for it.
    production = env.get("VERCEL_ENV") == "production"
    repo_name = env.get("STORY_REPOSITORY", "postgres" if production else "memory")
    stories: StoryRepository
    sessions: SessionStore
    if repo_name == "memory":
        stories = InMemoryStoryRepository()
        sessions = InMemorySessionStore()
    elif repo_name == "postgres":
        url = env.get("DATABASE_URL") or env.get("POSTGRES_URL")
        if not url:
            raise ConfigError("STORY_REPOSITORY=postgres needs DATABASE_URL (or POSTGRES_URL)")
        database = PostgresDatabase(url)
        stories = PostgresStoryRepository(database)
        sessions = PostgresSessionStore(database)
    else:
        raise ConfigError(f"unknown STORY_REPOSITORY {repo_name!r}")

    image_name = env.get("IMAGE_STORE", "filesystem")
    if image_name != "filesystem":
        raise ConfigError(f"unknown IMAGE_STORE {image_name!r}")
    images = FilesystemImageStore(
        Path(env.get("IMAGE_DIR", "/tmp/images" if deployed else ".data/images"))
    )

    uploads_name = env.get("IMAGE_UPLOADS") or (
        "local" if env.get("API_ENVIRONMENT") == "development" and not deployed else "off"
    )
    local_uploads: LocalOriginalUploads | None = None
    uploads: OriginalUploads
    if uploads_name == "local":
        # The endpoint writes whatever the owner sends to disk of the host; on Vercel the
        # real target is Blob, so it is refused rather than quietly mounted.
        if deployed:
            raise ConfigError("IMAGE_UPLOADS=local is not allowed when VERCEL_ENV is set")
        local_uploads = LocalOriginalUploads(images)
        uploads = local_uploads
    elif uploads_name == "off":
        uploads = UnconfiguredOriginalUploads()
    else:
        raise ConfigError(f"unknown IMAGE_UPLOADS {uploads_name!r}")
    image_repository = InMemoryImageRepository()
    clock = SystemClock()
    renderer = PillowImageRenderer(
        max_pixels=_positive_int(env, "IMAGE_MAX_PIXELS", DEFAULT_MAX_PIXELS)
    )
    processor = InProcessImageProcessor(
        lambda org, image_id: process_image(
            org, image_id, images=image_repository, uploads=uploads, store=images, renderer=renderer
        )
    )
    image_service = ImageService(
        image_repository,
        uploads,
        processor,
        clock,
        max_bytes=_positive_int(env, "IMAGE_MAX_BYTES", DEFAULT_IMAGE_MAX_BYTES),
        timeout=timedelta(
            seconds=_positive_int(
                env, "IMAGE_PROCESSING_TIMEOUT_SECONDS", DEFAULT_IMAGE_TIMEOUT_SECONDS
            )
        ),
    )

    raw = env.get("CORS_ALLOWED_ORIGINS")
    origins = (
        tuple(o.strip() for o in raw.split(",") if o.strip())
        if raw
        else (DEPLOYED_CORS_ORIGINS if deployed else DEFAULT_CORS_ORIGINS)
    )
    if "*" in origins:
        raise ConfigError("CORS_ALLOWED_ORIGINS must list origins, not '*'")

    default_origin = DEPLOYED_CORS_ORIGINS[0] if deployed else DEFAULT_WEB_ORIGIN
    return Container(
        stories=stories,
        story_repository_name=repo_name,
        images=images,
        image_service=image_service,
        image_status=image_service,
        local_uploads=local_uploads,
        sessions=sessions,
        identity=identity,
        identity_name=identity_name,
        clock=clock,
        cors_origins=origins,
        public_origin=(env.get("PUBLIC_WEB_ORIGIN") or default_origin).rstrip("/"),
        session_secret=session_secret,
    )


def _positive_int(env: Mapping[str, str], name: str, default: int) -> int:
    raw = env.get(name)
    if raw is None or raw == "":
        return default
    try:
        value = int(raw)
    except ValueError:
        raise ConfigError(f"{name} must be a whole number, not {raw!r}") from None
    if value <= 0:
        raise ConfigError(f"{name} must be greater than zero")
    return value
