"""The site's core records. Plain dataclasses: nothing here imports a framework."""

from dataclasses import dataclass
from datetime import datetime


@dataclass(frozen=True)
class User:
    id: str
    name: str
    is_owner: bool = False
    # Every record is organisation-aware from the start (spec section 10); the
    # one seeded owner belongs to the one organisation there is.
    organisation_id: str = "default"


@dataclass(frozen=True)
class Image:
    id: str
    content_type: str


@dataclass(frozen=True)
class Story:
    id: str
    title: str
    created_at: datetime
