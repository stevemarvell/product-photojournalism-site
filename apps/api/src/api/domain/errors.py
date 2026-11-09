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
