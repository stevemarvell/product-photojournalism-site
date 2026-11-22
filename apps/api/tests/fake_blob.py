"""A fake Vercel Blob HTTP layer: just enough of the service to test the adapters against.

It is an `httpx.MockTransport`, so the real `vercel-blob` package makes real requests of the
shape it sends in production and this answers them. It enforces what Blob enforces for client
uploads, checked independently of the adapter's own code: the client token's HMAC (keyed by
the read-write token), its expiry, its pathname and its size cap, and that an existing
pathname is not overwritten. Reads of the API need the read-write token.
"""

import base64
import hashlib
import hmac
import json
import time
from datetime import UTC, datetime

import httpx

RW_TOKEN = "vercel_blob_rw_AbC123xyz_FAKEsecret0123456789"
STORE_ID = "AbC123xyz"
HOST = "abc123xyz.public.blob.vercel-storage.com"


def error(status: int, code: str, message: str) -> httpx.Response:
    return httpx.Response(status, json={"error": {"code": code, "message": message}})


class FakeBlob:
    def __init__(self, rw_token: str = RW_TOKEN) -> None:
        self.rw_token = rw_token
        self.objects: dict[str, bytes] = {}
        self.requests: list[httpx.Request] = []
        self.down = False  # True: every call answers 503
        self.fail_delete = False  # True: only delete calls answer 500

    def client(self) -> httpx.Client:
        return httpx.Client(transport=httpx.MockTransport(self.handle))

    # --- what a browser does with a target, without any of our code in between -----------------

    def browser_put(self, target: dict, data: bytes, content_type: str = "image/jpeg") -> int:
        """PUT `data` to an upload target the way the browser does: the target's URL and its
        headers, nothing else. Returns the status Blob answered."""
        headers = {**target["headers"], "x-content-type": content_type}
        return self.handle(
            httpx.Request(target["method"], target["upload_url"], headers=headers, content=data)
        ).status_code

    # --- the service -------------------------------------------------------------------------

    def handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if self.down:
            return error(503, "service_unavailable", "Blob is down")
        if request.url.host == HOST:
            return self._download(request)
        api_paths = ("/api/blob", "/api/blob/delete")
        if request.url.host == "vercel.com" and request.url.path.rstrip("/") in api_paths:
            return self._api(request)
        return error(404, "not_found", f"unexpected request to {request.url}")

    def _download(self, request: httpx.Request) -> httpx.Response:
        data = self.objects.get(request.url.path.lstrip("/"))
        if data is None:
            return error(404, "not_found", "This blob does not exist.")
        return httpx.Response(
            200, content=data, headers={"content-type": "application/octet-stream"}
        )

    def _api(self, request: httpx.Request) -> httpx.Response:
        auth = request.headers.get("authorization", "")
        if not auth.startswith("Bearer "):
            return error(403, "forbidden", "No token")
        token = auth[len("Bearer ") :]
        if request.method == "PUT":
            return self._put(request, token)
        if request.method == "POST" and request.url.path.rstrip("/") == "/api/blob/delete":
            if token != self.rw_token:
                return error(403, "forbidden", "Not allowed")
            if self.fail_delete:
                return error(500, "internal_server_error", f"delete failed for {token}")
            for url in json.loads(request.content)["urls"]:
                self.objects.pop(url.removeprefix(f"https://{HOST}/"), None)
            return httpx.Response(200, json={})
        if request.method == "GET" and token == self.rw_token:
            return self._head(request)
        return error(403, "forbidden", "Not allowed")

    def _put(self, request: httpx.Request, token: str) -> httpx.Response:
        pathname = request.url.params.get("pathname", "")
        body = request.content
        if token != self.rw_token:
            problem = self._client_token_problem(token, pathname, len(body))
            if problem is not None:
                return problem
            if pathname in self.objects:  # the token says allowOverwrite: false
                return error(400, "bad_request", "This blob already exists.")
        self.objects[pathname] = body
        url = f"https://{HOST}/{pathname}"
        return httpx.Response(
            200,
            json={
                "url": url,
                "downloadUrl": url + "?download=1",
                "pathname": pathname,
                "contentType": request.headers.get("x-content-type", "application/octet-stream"),
                "contentDisposition": "inline",
                "etag": '"e"',
            },
        )

    def _client_token_problem(self, token: str, pathname: str, size: int) -> httpx.Response | None:
        prefix = f"vercel_blob_client_{STORE_ID}_"
        if not token.startswith(prefix):
            return error(403, "forbidden", "Invalid token")
        signature, _, payload = base64.b64decode(token[len(prefix) :]).decode().partition(".")
        expected = hmac.new(self.rw_token.encode(), payload.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(signature, expected):
            return error(403, "forbidden", "Invalid client token signature")
        claims = json.loads(base64.b64decode(payload))
        if claims["validUntil"] < time.time() * 1000:
            return error(403, "forbidden", "The client token has expired")
        if claims["pathname"] != pathname:
            return error(
                400, "bad_request", f'The "pathname" {pathname} does not match the token payload'
            )
        if size > claims["maximumSizeInBytes"]:
            return error(400, "bad_request", "the file length cannot be greater than the limit")
        if claims.get("allowOverwrite") is not False:
            return error(400, "bad_request", "this fake only issues tokens that forbid overwrite")
        return None

    def _head(self, request: httpx.Request) -> httpx.Response:
        url = request.url.params.get("url", "")
        data = self.objects.get(url.removeprefix(f"https://{HOST}/"))
        if data is None:
            return error(404, "not_found", "This blob does not exist.")
        return httpx.Response(
            200,
            json={
                "url": url,
                "downloadUrl": url + "?download=1",
                "pathname": url.removeprefix(f"https://{HOST}/"),
                "size": len(data),
                "etag": '"e"',
                "uploadedAt": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
                "contentType": "image/jpeg",
                "contentDisposition": "inline",
                "cacheControl": "max-age=31536000",
            },
        )
