"""Tests for the security headers, on every kind of response.

Asserting the middleware is installed would pass just as well if it were
inert on the paths that matter, so these assert the headers themselves --
on a route, on a 404 no route produced, and in both environments.

Literal tests rather than parametrize: scripts/test-census.mjs counts tests
statically, and a table-driven file is a blind spot it has to name.
"""

import re

from fastapi.openapi.docs import get_redoc_html, get_swagger_ui_html
from fastapi.responses import HTMLResponse
from fastapi.testclient import TestClient

from api.main import create_app
from api.security_headers import DEVELOPMENT_CSP_DIRECTIVES, build_csp, security_headers

production = TestClient(create_app(environment="production"))
development = TestClient(create_app(environment="development"))

# Literal, not computed by security_headers(): a regression in the function
# under test has to be caught by something that does not call it.
EXPECTED = {
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "x-frame-options": "DENY",
    "content-security-policy": (
        "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
    ),
}


def test_the_function_returns_exactly_the_expected_set() -> None:
    assert security_headers(is_development=False) == EXPECTED


def _assert_headers(path: str) -> None:
    response = production.get(path)
    for name, value in EXPECTED.items():
        assert response.headers[name] == value, (path, name)


def test_a_route_carries_the_headers() -> None:
    _assert_headers("/health")


def test_a_404_no_route_produced_carries_the_headers() -> None:
    _assert_headers("/no-such-route")


def test_production_csp_permits_nothing() -> None:
    csp = build_csp(is_development=False)
    assert csp.startswith("default-src 'none'")
    assert "unsafe-inline" not in csp
    assert "https://" not in csp


def test_development_docs_carry_the_development_policy() -> None:
    response = development.get("/docs")
    assert response.headers["content-security-policy"] == build_csp(is_development=True)


def _unpermitted_hosts(page: HTMLResponse) -> set[str]:
    """External hosts the page loads that the development policy does not permit."""
    hosts = set(re.findall(r"https?://[^/\"']+", page.body.decode()))
    assert hosts, "the doc page loads nothing external; this check would pass vacuously"
    permitted = {value for values in DEVELOPMENT_CSP_DIRECTIVES.values() for value in values}
    return hosts - permitted


def test_development_policy_permits_every_host_swagger_ui_loads() -> None:
    """An upgrade that moves Swagger UI to another CDN should fail here, not in a browser."""
    page = get_swagger_ui_html(openapi_url="/openapi.json", title="t")
    assert _unpermitted_hosts(page) == set()


def test_development_policy_permits_every_host_redoc_loads() -> None:
    page = get_redoc_html(openapi_url="/openapi.json", title="t")
    assert _unpermitted_hosts(page) == set()
