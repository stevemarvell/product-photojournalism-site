"""Domain errors, raised by the domain and by repositories implementing the ports."""


class StoryNotFoundError(Exception):
    """No such story in this organisation (another organisation's story is also 'not found')."""


class StoryConflictError(Exception):
    """The story changed since the caller last saw it (its `updated_at` no longer matches)."""


class StorageUnavailableError(Exception):
    """This adapter does not store the data yet (the Postgres story adapter, until built)."""


class PublishRefusedError(Exception):
    """The draft does not pass the publish rule; `reasons` says why, one per failure."""

    def __init__(self, reasons: list[str]) -> None:
        super().__init__("; ".join(reasons))
        self.reasons = reasons


class InvalidContentError(Exception):
    """The draft body uses markup a story may not contain; `reasons` says what."""

    def __init__(self, reasons: list[str]) -> None:
        super().__init__("; ".join(reasons))
        self.reasons = reasons


class ImageNotFoundError(Exception):
    """No such image in this organisation."""


class ImageTooLargeError(Exception):
    """The file is over the configured maximum size."""

    def __init__(self, limit: int) -> None:
        super().__init__(f"file is over the {limit}-byte limit")
        self.limit = limit


class ImageRefusedError(Exception):
    """The image cannot be registered: an unknown or unreadable upload."""


class ImageProcessingError(Exception):
    """The original could not be turned into web versions (not an image, corrupt, too big)."""


class ImageUploadsUnavailableError(Exception):
    """No place to upload originals is configured (Vercel Blob is not set up yet)."""
