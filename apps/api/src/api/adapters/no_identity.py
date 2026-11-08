"""IdentityProvider that signs nobody in: the default, so nothing fails open."""

from api.domain import User


class NoIdentityProvider:
    def current_user(self) -> User | None:
        return None
