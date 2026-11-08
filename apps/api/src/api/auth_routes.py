"""The sign-in flow: public by design (GET /auth/*), 503 until sign-in is configured."""

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import RedirectResponse

from api.application import SignInRefusedError
from api.guard import container_of, current_user

# Reached by visitors as /api/auth/... through the web app's rewrite (apps/web/vercel.json).
CALLBACK_PATH = "/api/auth/callback"


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
    try:
        container_of(request).identity.complete_sign_in(
            request.session, _redirect_uri(request), dict(request.query_params)
        )
    except SignInRefusedError:
        return RedirectResponse("/?signin=refused", status_code=303)
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
    container_of(request).identity.sign_out(request.session)
    return Response(status_code=204)
