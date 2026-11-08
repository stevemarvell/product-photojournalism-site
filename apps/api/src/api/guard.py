"""The owner guard, and the list of paths that are allowed not to use it.

Every route that is not public must depend on `require_owner`. A test
(tests/test_owner_guard.py) enumerates the app's routes and calls each one that
is not listed here without a session, expecting 401, so a later slice that adds
an unguarded write path fails the build.
"""

from fastapi import Depends, HTTPException, Request

from api.composition import Container
from api.domain import User

# Anonymous by design. `/auth/` is the sign-in flow; the rest are health, the
# deployed-commit probe and the public reads (spec section 11). The last three
# exist in development only (Swagger UI, ReDoc, the schema).
PUBLIC_EXACT = frozenset(
    {"/health", "/version", "/docs", "/docs/oauth2-redirect", "/redoc", "/openapi.json"}
)
PUBLIC_PREFIXES = ("/auth/", "/public/")


def is_public_path(path: str) -> bool:
    # A mount's path has no trailing slash ("/public"), so it is compared with one.
    return path in PUBLIC_EXACT or (path.rstrip("/") + "/").startswith(PUBLIC_PREFIXES)


def container_of(request: Request) -> Container:
    container: Container = request.app.state.container
    return container


def current_user(request: Request) -> User | None:
    return container_of(request).identity.current_user(request.session)


def require_owner(request: Request) -> User:
    """401 with no signed-in user, 403 for a signed-in user who is not the owner.

    Today only the owner can sign in; checking `is_owner` here is what lets
    roles be added later without touching the routes.
    """
    user = current_user(request)
    if user is None:
        raise HTTPException(status_code=401, detail="sign in required")
    if not user.is_owner:
        raise HTTPException(status_code=403, detail="owner only")
    return user


OwnerOnly = Depends(require_owner)
