"""Scenarios: the layers exist, the domain imports no framework, ports are declared."""

import ast
from pathlib import Path

import api.application
import api.application.ports
import api.domain

SRC = Path(api.domain.__file__).parent.parent
FORBIDDEN_ROOTS = {"fastapi", "starlette", "psycopg"}


def forbidden_imports(source: str) -> list[str]:
    found: list[str] = []
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.Import):
            names = [a.name for a in node.names]
        elif isinstance(node, ast.ImportFrom):
            base = node.module or ""
            names = [base] + [f"{base}.{a.name}" for a in node.names]
        else:
            continue
        for name in names:
            if name.split(".")[0] in FORBIDDEN_ROOTS or name.startswith("api.adapters"):
                found.append(name)
    return found


def test_the_checker_sees_forbidden_imports() -> None:
    # Control: the scan below is only evidence if it can fail.
    assert forbidden_imports("import fastapi") == ["fastapi"]
    assert forbidden_imports("from psycopg import connect")
    assert forbidden_imports("from api.adapters.memory import X")
    assert forbidden_imports("from api import adapters") == ["api.adapters"]
    assert forbidden_imports("import json\nfrom api.domain import User") == []


def test_domain_and_application_import_no_framework_driver_or_adapter() -> None:
    files = [*(SRC / "domain").glob("*.py"), *(SRC / "application").glob("*.py")]
    assert len(files) >= 4
    for f in files:
        assert forbidden_imports(f.read_text()) == [], f.name


def test_the_ports_are_declared() -> None:
    for name in (
        "StoryRepository",
        "ImageStore",
        "IdentityProvider",
        "Clock",
        "ImageStatusLookup",
        "SessionStore",
    ):
        assert getattr(api.application.ports, name) is getattr(api.application, name)
