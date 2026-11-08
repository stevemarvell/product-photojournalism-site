"""Filesystem ImageStore: the local default, needing no services."""

import re
from pathlib import Path

_SAFE_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,127}")


class FilesystemImageStore:
    def __init__(self, root: Path) -> None:
        self._root = root

    @property
    def root(self) -> Path:
        return self._root

    def _path(self, image_id: str) -> Path:
        # Ids become file names, so anything that could climb out of root is refused.
        if not _SAFE_ID.fullmatch(image_id):
            raise ValueError("invalid image id")
        return self._root / image_id

    def put(self, image_id: str, data: bytes) -> None:
        path = self._path(image_id)
        self._root.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)

    def get(self, image_id: str) -> bytes | None:
        path = self._path(image_id)
        return path.read_bytes() if path.is_file() else None
