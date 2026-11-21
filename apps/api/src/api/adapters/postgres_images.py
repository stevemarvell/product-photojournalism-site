"""The Postgres ImageRepository: image rows, the upload targets bound to organisations, and
the claims on them. Shares `PostgresDatabase` (and so the migration gate) with the stories."""

from collections.abc import Callable
from datetime import UTC, datetime

from psycopg.types.json import Jsonb

from api.adapters.postgres import PostgresDatabase
from api.domain import ImageRecord, ImageStatus, WebVersion

_COLUMNS = (
    "id, organisation_id, status, original_url, byte_size, created_at, web_versions, width, height"
)


def _to_image(row: tuple) -> ImageRecord:
    id_, org, status, original_url, byte_size, created_at, versions, width, height = row
    return ImageRecord(
        id_,
        org,
        ImageStatus(status),
        original_url,
        byte_size,
        created_at,
        tuple(WebVersion(v["width"], v["url"]) for v in versions),
        width,
        height,
    )


def _params(image: ImageRecord) -> dict[str, object]:
    return {
        "id": image.id,
        "org": image.organisation_id,
        "status": image.status.value,
        "url": image.original_url,
        "size": image.byte_size,
        "created": image.created_at,
        "versions": Jsonb([{"width": v.width, "url": v.url} for v in image.web_versions]),
        "width": image.width,
        "height": image.height,
    }


_INSERT = (
    f"insert into image ({_COLUMNS}) values "
    "(%(id)s, %(org)s, %(status)s, %(url)s, %(size)s, %(created)s, %(versions)s, "
    "%(width)s, %(height)s)"
)


class PostgresImageRepository:
    def __init__(
        self,
        database: PostgresDatabase,
        now: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        self._db = database
        self._now = now

    def create(self, image: ImageRecord) -> None:
        with self._db.connection() as conn:
            conn.execute(_INSERT, _params(image))

    def get(self, organisation_id: str, image_id: str) -> ImageRecord | None:
        with self._db.connection() as conn:
            row = conn.execute(
                f"select {_COLUMNS} from image where organisation_id = %s and id = %s",
                (organisation_id, image_id),
            ).fetchone()
        return _to_image(row) if row else None

    def bind_upload(self, organisation_id: str, original_url: str) -> None:
        with self._db.connection() as conn:
            conn.execute(
                "insert into image_upload (original_url, organisation_id, issued_at) "
                "values (%s, %s, %s)",
                (original_url, organisation_id, self._now()),
            )

    def upload_issued_to(self, organisation_id: str, original_url: str) -> bool:
        with self._db.connection() as conn:
            row = conn.execute(
                "select 1 from image_upload where original_url = %s and organisation_id = %s",
                (original_url, organisation_id),
            ).fetchone()
        return row is not None

    def create_claiming(self, image: ImageRecord) -> bool:
        # One transaction (the connection context commits or rolls back as a whole): if the
        # insert fails, the claim is undone and the upload can be registered again.
        with self._db.connection() as conn:
            claimed = conn.execute(
                "update image_upload set claimed_at = %s "
                "where original_url = %s and organisation_id = %s and claimed_at is null",
                (self._now(), image.original_url, image.organisation_id),
            ).rowcount
            if claimed != 1:
                return False
            conn.execute(_INSERT, _params(image))
        return True

    def replace_if_status(
        self, organisation_id: str, image: ImageRecord, expected: ImageStatus
    ) -> bool:
        if image.organisation_id != organisation_id:
            return False
        with self._db.connection() as conn:
            return (
                conn.execute(
                    "update image set status = %(status)s, web_versions = %(versions)s, "
                    "width = %(width)s, height = %(height)s "
                    "where organisation_id = %(org)s and id = %(id)s and status = %(expected)s",
                    _params(image) | {"expected": expected.value},
                ).rowcount
                == 1
            )
