"""Vercel Blob adapters: original uploads (client-upload tokens) and the web-version store.

One public Blob store holds both (owner decision, issue #40): originals at unguessable
pathnames (`originals/<24 random bytes>`), web versions under `web/`. The browser uploads an
original straight to Blob with a short-lived, single-pathname, size-capped client token the
API signs here; the API then only ever sees the stored URL. Every Blob call goes through the
official `vercel-blob` package, inside a session whose HTTP client a test can replace.

The token value is read by composition and handed in; it is never logged or put in an error.
"""

import base64
import hashlib
import hmac
import json
import re
import secrets
import time
from collections.abc import Callable
from typing import Any
from urllib.parse import quote

import httpx
from vercel.api import session
from vercel.blob.sync import (
    BlobCredentials,
    BlobNotFoundError,
    SyncBlobServiceOptions,
    delete_blob,
    get_blob,
    head_blob,
    put_blob,
)

from api.application import UploadTarget
from api.domain import ImageUploadsUnavailableError

API_URL = "https://vercel.com/api/blob"
API_VERSION = "12"
ORIGINALS_PREFIX = "originals/"
WEB_PREFIX = "web/"
TARGET_LIFETIME_SECONDS = 3600
WEB_CACHE_SECONDS = 31536000  # web version keys are unique per image: cache for a year

_RW_PREFIX = "vercel_blob_rw_"
_TOKEN = re.compile(r"[A-Za-z0-9]{20,64}")
_KEY = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}")

HttpClientFactory = Callable[[], httpx.Client]


def store_id_of(read_write_token: str) -> str:
    """The store id inside a read-write token (`vercel_blob_rw_<store id>_<secret>`)."""
    if not read_write_token.startswith(_RW_PREFIX):
        raise ValueError("BLOB_READ_WRITE_TOKEN is not a read-write token")
    store_id, sep, secret = read_write_token[len(_RW_PREFIX) :].partition("_")
    if not store_id or not sep or not secret:
        raise ValueError("BLOB_READ_WRITE_TOKEN is not a read-write token")
    return store_id


def client_token(read_write_token: str, payload: dict[str, Any]) -> str:
    """A client token, the way `@vercel/blob`'s `generateClientTokenFromReadWriteToken` makes
    it: `vercel_blob_client_<store id>_<base64("<hmac-sha256 hex>.<base64(payload json)>")>`,
    the HMAC keyed by the read-write token. Blob checks the signature, the expiry, the
    pathname and the size cap itself."""
    body = base64.b64encode(json.dumps(payload, separators=(",", ":")).encode()).decode()
    signature = hmac.new(read_write_token.encode(), body.encode(), hashlib.sha256).hexdigest()
    wrapped = base64.b64encode(f"{signature}.{body}".encode()).decode()
    return f"vercel_blob_client_{store_id_of(read_write_token)}_{wrapped}"


class BlobStore:
    """One Blob store: its read-write token, where it is delivered from, and the calls."""

    def __init__(
        self,
        read_write_token: str,
        *,
        api_url: str = API_URL,
        http_client_factory: HttpClientFactory | None = None,
        now: Callable[[], float] = time.time,
    ) -> None:
        self._token = read_write_token.strip()
        self._store_id = store_id_of(self._token)
        self._api_url = api_url.rstrip("/")
        self._http = http_client_factory
        self._now = now
        # Blob serves a public store from <store id, lower case>.public.blob.vercel-storage.com
        self.host = f"{self._store_id.lower()}.public.blob.vercel-storage.com"

    def url_of(self, pathname: str) -> str:
        return f"https://{self.host}/{pathname}"

    def pathname_of(self, url: str) -> str | None:
        """The pathname of a URL on this store's host (https, no port or userinfo), else None."""
        prefix = f"https://{self.host}/"
        if not url.startswith(prefix) or "?" in url or "#" in url or "\\" in url:
            return None
        pathname = url[len(prefix) :]
        if not pathname or "//" in pathname or any(p in (".", "..") for p in pathname.split("/")):
            return None
        return pathname

    def upload_target(self, pathname: str, max_bytes: int) -> UploadTarget:
        token = client_token(
            self._token,
            {
                "pathname": pathname,
                "maximumSizeInBytes": max_bytes,
                "addRandomSuffix": False,
                "allowOverwrite": False,
                "validUntil": int((self._now() + TARGET_LIFETIME_SECONDS) * 1000),
            },
        )
        return UploadTarget(
            upload_url=f"{self._api_url}/?pathname={quote(pathname, safe='')}",
            original_url=self.url_of(pathname),
            method="PUT",
            headers={
                "authorization": f"Bearer {token}",
                "x-api-version": API_VERSION,
                "x-vercel-blob-access": "public",
            },
        )

    def _session(self):  # noqa: ANN202 - the SDK's context manager
        options = SyncBlobServiceOptions(
            base_url=self._api_url,
            credentials_factory=lambda: BlobCredentials(self._token, self._store_id),
        )
        if self._http is None:
            return session(service_options=[options])
        return session(service_options=[options], httpx_client_factory=self._http)

    def size(self, url: str) -> int | None:
        try:
            with self._session():
                return head_blob(url).size
        except BlobNotFoundError:
            return None

    def delete(self, url: str) -> None:
        with self._session():
            delete_blob(url)

    def read(self, url: str) -> bytes | None:
        try:
            with self._session():
                return get_blob(url, access="public").body
        except BlobNotFoundError:
            return None

    def put_web(self, pathname: str, data: bytes) -> str:
        with self._session():
            return put_blob(
                pathname,
                data,
                access="public",
                content_type="image/jpeg",
                allow_overwrite=True,  # a retried write of the same version is harmless
                cache_control_max_age=WEB_CACHE_SECONDS,
            ).url


class BlobOriginalUploads:
    """OriginalUploads on Blob: `issue` is a client token, `size` a HEAD, `read` a download.
    Only URLs on this store's host, under `originals/`, are ever looked up."""

    def __init__(self, store: BlobStore, max_bytes: int) -> None:
        self._store = store
        self._max_bytes = max_bytes

    def issue(self, organisation_id: str) -> UploadTarget:
        token = secrets.token_urlsafe(24).replace("_", "x").replace("-", "y")
        try:
            return self._store.upload_target(f"{ORIGINALS_PREFIX}{token}", self._max_bytes)
        except ValueError:
            raise ImageUploadsUnavailableError("the Blob token is unusable") from None

    def _original(self, original_url: str) -> str | None:
        pathname = self._store.pathname_of(original_url)
        if pathname is None or not pathname.startswith(ORIGINALS_PREFIX):
            return None
        return original_url if _TOKEN.fullmatch(pathname[len(ORIGINALS_PREFIX) :]) else None

    def size(self, original_url: str) -> int | None:
        url = self._original(original_url)
        if url is None:
            return None
        return self._store.size(url)

    def read(self, original_url: str) -> bytes | None:
        url = self._original(original_url)
        return None if url is None else self._store.read(url)

    def discard(self, original_url: str) -> None:
        url = self._original(original_url)
        if url is not None:
            self._store.delete(url)


class BlobImageStore:
    """ImageStore on Blob: web versions are public objects under `web/`, and `put` returns the
    absolute Blob URL the public site then serves them from."""

    def __init__(self, store: BlobStore) -> None:
        self._store = store

    def put(self, key: str, data: bytes) -> str:
        if not _KEY.fullmatch(key):
            raise ValueError("invalid image key")
        return self._store.put_web(f"{WEB_PREFIX}{key}", data)

    def get(self, key: str) -> bytes | None:
        if not _KEY.fullmatch(key):
            return None
        return self._store.read(self._store.url_of(f"{WEB_PREFIX}{key}"))
