"""The site's core records. Plain dataclasses: nothing here imports a framework."""

from dataclasses import dataclass
from enum import StrEnum


@dataclass(frozen=True)
class User:
    id: str
    name: str
    is_owner: bool = False
    # Every record is organisation-aware from the start (spec section 10); the
    # one seeded owner belongs to the one organisation there is.
    organisation_id: str = "default"


# The one organisation there is (spec section 4: organisation_id is a constant in the
# MVP). Signed-in reads take their organisation from the user, which is this; anonymous
# reads (the public site) have no user, so they take it from here, and nowhere else.
MVP_ORGANISATION_ID = "owner-org"

# The single user row: the owner, in the one organisation there is. Every
# identity provider that signs the owner in builds from this, so there is one
# definition of who the owner is and which organisation they belong to.
OWNER = User(id="owner", name="Owner", is_owner=True, organisation_id=MVP_ORGANISATION_ID)


@dataclass(frozen=True)
class Image:
    id: str
    content_type: str


class ImageStatus(StrEnum):
    """Processing state of an image (spec section 4). Web versions exist only once ready."""

    PROCESSING = "processing"
    READY = "ready"
    FAILED = "failed"


@dataclass(frozen=True)
class SessionRecord:
    """A signed-in session as the server remembers it (the cookie carries only `id`).

    `epoch` is the user's current session epoch: a cookie whose own epoch differs
    was issued before a revoke-all and is refused.
    """

    id: str
    user_id: str
    epoch: int
