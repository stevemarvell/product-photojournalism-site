"""Composition root: the one place that picks adapters, from environment variables.

STORY_REPOSITORY   memory (default) | postgres (needs DATABASE_URL)
IMAGE_STORE        filesystem (default); IMAGE_DIR sets where (default .data/images)
IDENTITY_PROVIDER  stub (default; refused when VERCEL_ENV is set)
CORS_ALLOWED_ORIGINS  comma-separated origins (default: the local Vite dev server)
"""

from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

from api.adapters.clock import SystemClock
from api.adapters.filesystem import FilesystemImageStore
from api.adapters.memory import InMemoryStoryRepository
from api.adapters.postgres import PostgresStoryRepository
from api.adapters.stub_identity import StubIdentityProvider
from api.application import Clock, IdentityProvider, ImageStore, StoryRepository

DEFAULT_CORS_ORIGINS = ("http://localhost:5173", "http://127.0.0.1:5173")


class ConfigError(RuntimeError):
    """The configuration cannot be run; the app must not start."""


@dataclass(frozen=True)
class Container:
    stories: StoryRepository
    story_repository_name: str
    images: ImageStore
    identity: IdentityProvider
    clock: Clock
    cors_origins: tuple[str, ...]


def build_container(env: Mapping[str, str]) -> Container:
    identity_name = env.get("IDENTITY_PROVIDER", "stub")
    if identity_name == "stub":
        if env.get("VERCEL_ENV"):
            raise ConfigError("IDENTITY_PROVIDER=stub is not allowed when VERCEL_ENV is set")
        identity: IdentityProvider = StubIdentityProvider()
    else:
        raise ConfigError(f"unknown IDENTITY_PROVIDER {identity_name!r}")

    repo_name = env.get("STORY_REPOSITORY", "memory")
    stories: StoryRepository
    if repo_name == "memory":
        stories = InMemoryStoryRepository()
    elif repo_name == "postgres":
        url = env.get("DATABASE_URL")
        if not url:
            raise ConfigError("STORY_REPOSITORY=postgres needs DATABASE_URL")
        stories = PostgresStoryRepository(url)
    else:
        raise ConfigError(f"unknown STORY_REPOSITORY {repo_name!r}")

    image_name = env.get("IMAGE_STORE", "filesystem")
    if image_name != "filesystem":
        raise ConfigError(f"unknown IMAGE_STORE {image_name!r}")
    images = FilesystemImageStore(Path(env.get("IMAGE_DIR", ".data/images")))

    raw = env.get("CORS_ALLOWED_ORIGINS")
    origins = tuple(o.strip() for o in raw.split(",") if o.strip()) if raw else DEFAULT_CORS_ORIGINS
    if "*" in origins:
        raise ConfigError("CORS_ALLOWED_ORIGINS must list origins, not '*'")

    return Container(
        stories=stories,
        story_repository_name=repo_name,
        images=images,
        identity=identity,
        clock=SystemClock(),
        cors_origins=origins,
    )
