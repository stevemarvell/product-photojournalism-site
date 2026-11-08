"""Postgres StoryRepository. For now its only behaviour is a connectivity check.

No tables or migrations yet. It connects lazily, so constructing it with an
unreachable database does not fail the app's startup.
"""

import psycopg

TIMEOUT_S = 2


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
