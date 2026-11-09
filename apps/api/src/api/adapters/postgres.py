"""Postgres StoryRepository. For now its only behaviour is a connectivity check.

No tables or migrations yet: the story methods raise StorageUnavailableError until the
Postgres story adapter follow-up lands (the in-memory adapter implements them). It
connects lazily, so constructing it with an unreachable database does not fail startup.
"""

from datetime import datetime

import psycopg

from api.domain import StorageUnavailableError, Story

TIMEOUT_S = 2
NOT_BUILT = (
    "Postgres story adapter: follow-up issue (stories table and migrations are not built yet)"
)


class PostgresStoryRepository:
    def __init__(self, database_url: str) -> None:
        self._database_url = database_url

    def ping(self) -> bool:
        # Any failure is just "unreachable": the exception text can contain the
        # connection string, so it is neither returned nor logged.
        try:
            with (
                psycopg.connect(self._database_url, connect_timeout=TIMEOUT_S) as conn,
                conn.cursor() as cur,
            ):
                cur.execute("select 1")
                return cur.fetchone() == (1,)
        except Exception:
            return False

    def create(self, story: Story) -> None:
        raise StorageUnavailableError(NOT_BUILT)

    def get(self, organisation_id: str, story_id: str) -> Story | None:
        raise StorageUnavailableError(NOT_BUILT)

    def list(self, organisation_id: str) -> list[Story]:
        raise StorageUnavailableError(NOT_BUILT)

    def replace(self, organisation_id: str, story: Story, expected_updated_at: datetime) -> Story:
        raise StorageUnavailableError(NOT_BUILT)
