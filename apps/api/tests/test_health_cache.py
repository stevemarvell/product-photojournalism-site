"""/health reuses a database ping for a short time, so probes cannot flood Postgres."""

from dataclasses import replace
from datetime import UTC, datetime, timedelta

from fastapi.testclient import TestClient

from api.composition import build_container
from api.main import HEALTH_CACHE_TTL, create_app


class FakeClock:
    def __init__(self) -> None:
        self.t = datetime(2026, 1, 1, tzinfo=UTC)

    def now(self) -> datetime:
        return self.t


class CountingRepo:
    def __init__(self) -> None:
        self.pings = 0

    def ping(self) -> bool:
        self.pings += 1
        return True


def test_pings_once_within_ttl_and_again_after_it() -> None:
    clock, repo = FakeClock(), CountingRepo()
    container = replace(build_container({}), clock=clock, stories=repo)
    client = TestClient(create_app(container=container))

    assert client.get("/health").status_code == 200
    clock.t += HEALTH_CACHE_TTL - timedelta(seconds=1)
    assert client.get("/health").status_code == 200
    assert repo.pings == 1

    clock.t += timedelta(seconds=2)
    client.get("/health")
    assert repo.pings == 2
