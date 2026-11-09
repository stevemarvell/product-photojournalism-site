"""Filesystem ImageStore and local original uploads: the local default, needing no services."""

import re
import secrets
import threading
from pathlib import Path

from api.application import UploadTarget
from api.domain import ImageUploadsUnavailableError

# Keys become file names, so anything that could climb out of root is refused: no slash,
# no leading dot.
_SAFE_KEY = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}")

# Where the API serves web versions from (api.image_routes). Originals have no such path.
PUBLIC_IMAGE_PATH = "/public/images/"
ORIGINAL_PREFIX = "orig-"
LOCAL_SCHEME = "local:"
UPLOAD_PATH = "/images/uploads/"


class FilesystemImageStore:
    def __init__(self, root: Path) -> None:
        self._root = root

    @property
    def root(self) -> Path:
        return self._root

    def _path(self, key: str) -> Path:
        if not _SAFE_KEY.fullmatch(key):
            raise ValueError("invalid image key")
        return self._root / key

    def put(self, key: str, data: bytes) -> str:
        path = self._path(key)
        self._root.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return f"{PUBLIC_IMAGE_PATH}{key}"

    def get(self, key: str) -> bytes | None:
        path = self._path(key)
        return path.read_bytes() if path.is_file() else None


class LocalOriginalUploads:
    """Stands in for Vercel Blob client uploads on a developer's machine.

    `issue` mints an unguessable token and names the owner-only endpoint the browser PUTs
    the file to (`accept` is what that endpoint calls). The original's URL is
    `local:orig-<token>`: it is not a path the API serves, so it is reachable by nothing
    public, and only a token this process issued can be registered.
    """

    def __init__(self, store: FilesystemImageStore) -> None:
        self._store = store
        self._issued: set[str] = set()  # tokens handed out and not yet uploaded to
        self._lock = threading.Lock()

    def issue(self, organisation_id: str) -> UploadTarget:
        token = secrets.token_urlsafe(24).replace("_", "x").replace("-", "y")
        with self._lock:
            self._issued.add(token)
        return UploadTarget(upload_url=f"{UPLOAD_PATH}{token}", original_url=_url(token))

    def accept(self, token: str, data: bytes) -> bool:
        """Store the upload for a token that was issued, once. False for any other token."""
        with self._lock:
            if token not in self._issued:
                return False
            self._issued.discard(token)
        self._store.put(f"{ORIGINAL_PREFIX}{token}", data)
        return True

    def _key(self, original_url: str) -> str | None:
        if not original_url.startswith(LOCAL_SCHEME + ORIGINAL_PREFIX):
            return None
        key = original_url[len(LOCAL_SCHEME) :]
        return key if _SAFE_KEY.fullmatch(key) else None

    def read(self, original_url: str) -> bytes | None:
        key = self._key(original_url)
        return self._store.get(key) if key else None

    def size(self, original_url: str) -> int | None:
        data = self.read(original_url)
        return None if data is None else len(data)


def _url(token: str) -> str:
    return f"{LOCAL_SCHEME}{ORIGINAL_PREFIX}{token}"


class UnconfiguredOriginalUploads:
    """No upload target configured (a deployment before Vercel Blob is provisioned): it
    issues nothing and recognises no URL, so nothing can be registered."""

    def issue(self, organisation_id: str) -> UploadTarget:
        raise ImageUploadsUnavailableError("no image upload target is configured")

    def size(self, original_url: str) -> int | None:
        return None

    def read(self, original_url: str) -> bytes | None:
        return None
