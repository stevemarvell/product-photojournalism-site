"""Security headers on every response the API returns.

Production serves JSON and nothing else, so its Content-Security-Policy is
`default-src 'none'`: no page served here should load, run or frame anything.

Development also serves FastAPI's Swagger UI and ReDoc (see api.main), which
load their scripts, styles and fonts from third-party CDNs. The development
policy adds exactly those hosts. `test_security_headers.py` reads FastAPI's
own doc pages and asserts every external host in them is permitted, so an
upgrade that moves them to a different CDN fails a test instead of a browser.
"""

from collections.abc import Mapping

from fastapi import FastAPI
from starlette.datastructures import MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

PRODUCTION_CSP_DIRECTIVES: Mapping[str, tuple[str, ...]] = {
    "default-src": ("'none'",),
    "base-uri": ("'none'",),
    "form-action": ("'none'",),
    "frame-ancestors": ("'none'",),
}

DOCS_CDN = "https://cdn.jsdelivr.net"
DOCS_FAVICON = "https://fastapi.tiangolo.com"
DOCS_FONTS_CSS = "https://fonts.googleapis.com"
DOCS_FONTS = "https://fonts.gstatic.com"

# Swagger UI boots from an inline <script>; ReDoc styles itself inline. Both
# fetch /openapi.json from this origin, hence connect-src 'self'.
DEVELOPMENT_CSP_DIRECTIVES: Mapping[str, tuple[str, ...]] = {
    **PRODUCTION_CSP_DIRECTIVES,
    "script-src": ("'unsafe-inline'", DOCS_CDN),
    "style-src": ("'unsafe-inline'", DOCS_CDN, DOCS_FONTS_CSS),
    "img-src": ("data:", DOCS_CDN, DOCS_FAVICON),
    "font-src": (DOCS_FONTS,),
    "connect-src": ("'self'",),
}


def build_csp(*, is_development: bool) -> str:
    """Render the policy for this environment into a header value."""
    directives = DEVELOPMENT_CSP_DIRECTIVES if is_development else PRODUCTION_CSP_DIRECTIVES
    return "; ".join(f"{name} {' '.join(values)}" for name, values in directives.items())


def security_headers(*, is_development: bool) -> dict[str, str]:
    """The full set of headers to set, for the given environment."""
    return {
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
        "x-frame-options": "DENY",
        "content-security-policy": build_csp(is_development=is_development),
    }


class SecurityHeadersMiddleware:
    """Sets the headers on every response, whatever produced it.

    Raw ASGI, touching only `http.response.start`, so it also covers responses
    no route produced, such as the router's 404. Existing values are never
    overwritten.

    One response is out of reach: Starlette's ServerErrorMiddleware sits
    outside every user middleware, so its bare "Internal Server Error" carries
    none of these headers. It is text/plain with no attacker-controlled content.
    """

    def __init__(self, app: ASGIApp, *, headers: Mapping[str, str]) -> None:
        self.app = app
        self.headers: tuple[tuple[str, str], ...] = tuple(headers.items())

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def send_with_headers(message: Message) -> None:
            if message["type"] == "http.response.start":
                response_headers = MutableHeaders(scope=message)
                for name, value in self.headers:
                    response_headers.setdefault(name, value)
            await send(message)

        await self.app(scope, receive, send_with_headers)


def install_security_headers(app: FastAPI, *, is_development: bool) -> dict[str, str]:
    """Add the middleware to `app` and return the headers it will set.

    Call this after every other `add_middleware`, so it ends up outermost and
    sees every response the layers inside it return.
    """
    headers = security_headers(is_development=is_development)
    app.add_middleware(SecurityHeadersMiddleware, headers=headers)
    return headers
