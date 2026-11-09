"""The sign-in flow: public by design (GET /auth/*), 503 until sign-in is configured."""

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import RedirectResponse
from starlette.datastructures import MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from api.application import SignInRefusedError
from api.domain import User
from api.guard import (
    SESSION_EPOCH_KEY,
    SESSION_ID_KEY,
    container_of,
    current_user,
    require_owner,
)

# Reached by visitors as /api/auth/... through the web app's rewrite (apps/web/vercel.json).
CALLBACK_PATH = "/api/auth/callback"


class NoStoreAuth:
    """`Cache-Control: no-store` on every /auth/* response, whatever produced it
    (a redirect, a 503, the session answer): none may be kept by a cache."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or not scope["path"].startswith("/auth/"):
            await self.app(scope, receive, send)
            return

        async def send_no_store(message: Message) -> None:
            if message["type"] == "http.response.start":
                MutableHeaders(scope=message)["cache-control"] = "no-store"
            await send(message)

        await self.app(scope, receive, send_no_store)


def require_sign_in_configured(request: Request) -> None:
    if not container_of(request).identity.sign_in_available():
        raise HTTPException(status_code=503, detail="sign-in not configured")


router = APIRouter(prefix="/auth", dependencies=[Depends(require_sign_in_configured)])


def _redirect_uri(request: Request) -> str:
    return container_of(request).public_origin + CALLBACK_PATH


@router.get("/login")
def login(request: Request) -> RedirectResponse:
    url = container_of(request).identity.begin_sign_in(request.session, _redirect_uri(request))
    return RedirectResponse(url, status_code=303)


@router.get("/callback")
def callback(request: Request) -> RedirectResponse:
    container = container_of(request)
    try:
        user = container.identity.complete_sign_in(
            request.session, _redirect_uri(request), dict(request.query_params)
        )
    except SignInRefusedError:
        return RedirectResponse("/?signin=refused", status_code=303)
    # A fresh server-side record for every sign-in; whatever the browser held before is retired.
    previous = request.session.get(SESSION_ID_KEY)
    if isinstance(previous, str):
        container.sessions.delete(previous)
    record = container.sessions.create(user.id)
    request.session[SESSION_ID_KEY] = record.id
    request.session[SESSION_EPOCH_KEY] = record.epoch
    return RedirectResponse("/editor", status_code=303)


@router.get("/me")
def me(request: Request) -> dict[str, object]:
    user = current_user(request)
    if user is None:
        return {"signedIn": False, "user": None}
    return {
        "signedIn": True,
        "user": {"name": user.name, "isOwner": user.is_owner},
    }


@router.post("/logout", status_code=204)
def logout(request: Request) -> Response:
    container = container_of(request)
    # Delete the stored record first: that is what makes a copy of the cookie useless.
    session_id = request.session.get(SESSION_ID_KEY)
    if isinstance(session_id, str):
        container.sessions.delete(session_id)
    container.identity.sign_out(request.session)
    return Response(status_code=204)


# Under the public /auth prefix, so it names its guard itself (guard.OWNER_ONLY_UNDER_PUBLIC
# makes the owner-guard audit probe it). A separate router: the sign-in-configured check on
# the one above would answer 503 before the guard could answer 401.
owner_router = APIRouter(prefix="/auth")


@owner_router.post("/revoke-all", status_code=204)
def revoke_all(request: Request, user: Annotated[User, Depends(require_owner)]) -> Response:
    """Sign out everywhere: every session so far, this one included, is refused from now on."""
    container_of(request).sessions.revoke_all(user.id)
    request.session.clear()
    return Response(status_code=204)
