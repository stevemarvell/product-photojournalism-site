"""The Postgres gate in conftest: skip locally, fail in CI, run when a database is given.

Each case runs a real pytest in a subprocess against a copy of conftest.py, so the hook is
exercised as pytest loads it, not by calling the function that decides.
"""

import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from conftest import missing_database_outcome

HERE = Path(__file__).parent
SRC = HERE.parent / "src"


def run_gate(tmp_path: Path, **env: str) -> subprocess.CompletedProcess[str]:
    shutil.copy(HERE / "conftest.py", tmp_path / "conftest.py")
    (tmp_path / "test_gate.py").write_text(
        "from conftest import needs_postgres\n\n\n"
        "@needs_postgres\ndef test_postgres_case() -> None:\n    pass\n"
    )
    base = {k: v for k, v in os.environ.items() if k not in ("CI", "TEST_DATABASE_URL")}
    base["PYTHONPATH"] = str(SRC)
    return subprocess.run(
        [sys.executable, "-m", "pytest", "-q", "-rs", "-p", "no:cacheprovider", str(tmp_path)],
        capture_output=True,
        text=True,
        env={**base, **env},
        cwd=tmp_path,
        check=False,
    )


def test_without_ci_the_postgres_case_skips_with_a_stated_reason(tmp_path: Path) -> None:
    result = run_gate(tmp_path)
    assert result.returncode == 0, result.stdout
    assert "1 skipped" in result.stdout and "no TEST_DATABASE_URL" in result.stdout


def test_in_ci_without_a_database_the_postgres_case_fails_naming_services(tmp_path: Path) -> None:
    result = run_gate(tmp_path, CI="true")
    assert result.returncode == 1, result.stdout
    assert "1 error" in result.stdout and "skipped" not in result.stdout
    assert '"services": ["postgres"]' in result.stdout and "project.json" in result.stdout


def test_a_database_url_lets_the_case_run_in_ci_and_out(tmp_path: Path) -> None:
    for env in ({"CI": "true"}, {}):
        result = run_gate(tmp_path, TEST_DATABASE_URL="postgresql://x@localhost/none", **env)
        assert result.returncode == 0 and "1 passed" in result.stdout, result.stdout


@pytest.mark.parametrize(
    ("url", "ci", "expected"),
    [
        (None, None, "skip"),
        ("", "", "skip"),
        (None, "false", "skip"),
        (None, "true", "fail"),
        ("u", "true", None),
    ],
)
def test_the_decision_table(url: str | None, ci: str | None, expected: str | None) -> None:
    assert missing_database_outcome(url, ci) == expected
