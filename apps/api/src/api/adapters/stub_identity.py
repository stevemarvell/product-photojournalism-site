"""Stub IdentityProvider: always signs in as the owner.

Local development only. The composition root refuses to build it when
VERCEL_ENV is set.
"""

from api.domain import User


class StubIdentityProvider:
    def current_user(self) -> User:
        return User(id="owner", name="Owner", is_owner=True)
