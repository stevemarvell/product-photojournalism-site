"""Composition root: the one place that picks adapters, from environment variables.

STORY_REPOSITORY   memory | postgres (needs DATABASE_URL, or POSTGRES_URL, which the
                   Vercel/Neon integration injects). The default is postgres only where
                   VERCEL_ENV=production, so a deployment never silently runs on memory
                   and a preview never gets the database unless it is asked for.
SESSIONS           follow STORY_REPOSITORY: postgres uses the same database (so sign-out and
                   revoke-all hold across serverless instances), memory is per process.
                   The schema is migrated (yoyo, under an advisory lock) before the first
                   query of the process, not at import, so an unreachable database still
                   lets /health answer 503. Image rows, upload bindings and claims follow
                   STORY_REPOSITORY too (postgres: they survive a restart).
BLOB_READ_WRITE_TOKEN  the Vercel Blob store's token (set by Vercel). Never logged.
IMAGE_STORE        filesystem | blob. Default blob only where VERCEL_ENV=production and
                   BLOB_READ_WRITE_TOKEN is set, else filesystem; IMAGE_DIR sets where
                   (default .data/images, /tmp/images where VERCEL_ENV is set: the bundle is
                   read-only there). blob needs the token.
IMAGE_UPLOADS      local | blob | off. local: originals are uploaded to this API's owner-only
                   PUT /images/uploads/{token} and kept in the image store. blob: the browser
                   uploads straight to Blob with a client token (needs the token). The default
                   is blob where VERCEL_ENV=production and the token is set, local only with
                   API_ENVIRONMENT=development and no VERCEL_ENV, else off (uploads answer
                   503). local with VERCEL_ENV set is refused at startup. A preview never
                   writes to the Blob store unless it is asked to.
IMAGE_PROCESSING   thread | inline. inline runs the work inside POST /images (a serverless
                   function may be frozen once it has responded): the default where
                   VERCEL_ENV is set; thread otherwise.
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
PUBLIC_LIST_TTL_SECONDS  how long GET /public/pieces is answered from a per-process cache
                   (default 5, at most 60; 0 turns the cache off)
CORS_ALLOWED_ORIGINS  comma-separated origins (default: the local Vite dev server;
                   where VERCEL_ENV is set, the deployed web app)
"""

import logging
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import timedelta
from pathlib import Path

import httpx

from api.adapters.blob import BlobImageStore, BlobOriginalUploads, BlobStore
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
    InlineImageProcessor,
    InProcessImageProcessor,
    PillowImageRenderer,
)
from api.adapters.postgres import PostgresDatabase, PostgresSessionStore, PostgresStoryRepository
from api.adapters.postgres_images import PostgresImageRepository
from api.adapters.stub_identity import StubIdentityProvider
from api.adapters.vercel_identity import VercelIdentityProvider
from api.application import (
    Clock,
    IdentityProvider,
    ImageProcessor,
    ImageRepository,
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
DEFAULT_PUBLIC_LIST_TTL_SECONDS = 5
# An unpublished piece must leave the anonymous list within this long.
MAX_PUBLIC_LIST_TTL_SECONDS = 60
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
    # Set only when web versions are kept on the local filesystem: the one case where this
    # API serves them (GET /public/images/{key}). With Blob they are served from Blob.
    local_images: FilesystemImageStore | None
    # Set only when the local upload endpoint is enabled (never where VERCEL_ENV is set).
    local_uploads: LocalOriginalUploads | None
    sessions: SessionStore
    identity: IdentityProvider
    identity_name: str
    clock: Clock
    # How long the public list is answered from memory; zero means every request reads.
    public_list_ttl: timedelta
    cors_origins: tuple[str, ...]
    # Where visitors reach the site; the OAuth callback is public_origin + /api/auth/callback.
    public_origin: str
    # None means "no usable secret": the app signs sessions with a throwaway key,
    # which authenticates nobody because the provider is then not signing anyone in.
    session_secret: str | None


def build_container(
    env: Mapping[str, str], *, blob_http: Callable[[], httpx.Client] | None = None
) -> Container:
    """`blob_http` replaces the HTTP client the Blob adapters use: a test's fake Blob."""
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
    image_repository: ImageRepository
    if repo_name == "memory":
        stories = InMemoryStoryRepository()
        sessions = InMemorySessionStore()
        image_repository = InMemoryImageRepository()
    elif repo_name == "postgres":
        url = env.get("DATABASE_URL") or env.get("POSTGRES_URL")
        if not url:
            raise ConfigError("STORY_REPOSITORY=postgres needs DATABASE_URL (or POSTGRES_URL)")
        database = PostgresDatabase(url)
        stories = PostgresStoryRepository(database)
        sessions = PostgresSessionStore(database)
        image_repository = PostgresImageRepository(database)
    else:
        raise ConfigError(f"unknown STORY_REPOSITORY {repo_name!r}")

    blob_token = (env.get("BLOB_READ_WRITE_TOKEN") or "").strip()
    blob_by_default = production and bool(blob_token)
    blob: BlobStore | None = None

    def blob_store() -> BlobStore:
        nonlocal blob
        if blob is None:
            if not blob_token:
                raise ConfigError("Vercel Blob needs BLOB_READ_WRITE_TOKEN")
            try:
                blob = BlobStore(blob_token, http_client_factory=blob_http)
            except ValueError as e:
                raise ConfigError(str(e)) from None
        return blob

    image_name = env.get("IMAGE_STORE") or ("blob" if blob_by_default else "filesystem")
    local_images: FilesystemImageStore | None = None
    images: ImageStore
    if image_name == "filesystem":
        local_images = FilesystemImageStore(
            Path(env.get("IMAGE_DIR", "/tmp/images" if deployed else ".data/images"))
        )
        images = local_images
    elif image_name == "blob":
        images = BlobImageStore(blob_store())
    else:
        raise ConfigError(f"unknown IMAGE_STORE {image_name!r}")

    uploads_name = env.get("IMAGE_UPLOADS") or (
        "blob"
        if blob_by_default
        else "local"
        if env.get("API_ENVIRONMENT") == "development" and not deployed
        else "off"
    )
    max_bytes = _positive_int(env, "IMAGE_MAX_BYTES", DEFAULT_IMAGE_MAX_BYTES)
    local_uploads: LocalOriginalUploads | None = None
    uploads: OriginalUploads
    if uploads_name == "local":
        # The endpoint writes whatever the owner sends to disk of the host; on Vercel the
        # real target is Blob, so it is refused rather than quietly mounted.
        if deployed:
            raise ConfigError("IMAGE_UPLOADS=local is not allowed when VERCEL_ENV is set")
        if local_images is None:
            raise ConfigError("IMAGE_UPLOADS=local needs IMAGE_STORE=filesystem")
        local_uploads = LocalOriginalUploads(local_images)
        uploads = local_uploads
    elif uploads_name == "blob":
        uploads = BlobOriginalUploads(blob_store(), max_bytes)
    elif uploads_name == "off":
        uploads = UnconfiguredOriginalUploads()
    else:
        raise ConfigError(f"unknown IMAGE_UPLOADS {uploads_name!r}")
    clock = SystemClock()
    renderer = PillowImageRenderer(
        max_pixels=_positive_int(env, "IMAGE_MAX_PIXELS", DEFAULT_MAX_PIXELS)
    )
    processing_name = env.get("IMAGE_PROCESSING") or ("inline" if deployed else "thread")

    def work(org: str, image_id: str) -> None:
        process_image(
            org, image_id, images=image_repository, uploads=uploads, store=images, renderer=renderer
        )

    processor: ImageProcessor
    if processing_name == "inline":
        processor = InlineImageProcessor(work)
    elif processing_name == "thread":
        processor = InProcessImageProcessor(work)
    else:
        raise ConfigError(f"unknown IMAGE_PROCESSING {processing_name!r}")
    image_service = ImageService(
        image_repository,
        uploads,
        processor,
        clock,
        max_bytes=max_bytes,
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
        local_images=local_images,
        local_uploads=local_uploads,
        sessions=sessions,
        identity=identity,
        identity_name=identity_name,
        clock=clock,
        public_list_ttl=timedelta(
            seconds=_non_negative_int(
                env,
                "PUBLIC_LIST_TTL_SECONDS",
                DEFAULT_PUBLIC_LIST_TTL_SECONDS,
                maximum=MAX_PUBLIC_LIST_TTL_SECONDS,
            )
        ),
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


def _non_negative_int(
    env: Mapping[str, str], name: str, default: int, maximum: int | None = None
) -> int:
    raw = env.get(name)
    if raw is None or raw == "":
        return default
    try:
        value = int(raw)
    except ValueError:
        raise ConfigError(f"{name} must be a whole number, not {raw!r}") from None
    if value < 0:
        raise ConfigError(f"{name} must not be negative")
    if maximum is not None and value > maximum:
        raise ConfigError(f"{name} must be at most {maximum} (the ceiling), not {value}")
    return value
