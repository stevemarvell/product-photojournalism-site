"""Is a session cookie still honoured? Checked against the stored record, on every request."""

from api.application.ports import SessionStore

# How long a sign-in lasts: the cookie's max age, and how long a stored record is honoured.
SESSION_MAX_AGE = 12 * 60 * 60


def session_is_valid(store: SessionStore, user_id: str, session_id: object, epoch: object) -> bool:
    """True only when the store has this session, for this user, at the cookie's epoch."""
    if not isinstance(session_id, str) or not isinstance(epoch, int) or isinstance(epoch, bool):
        return False
    record = store.get(session_id)
    return record is not None and record.user_id == user_id and record.epoch == epoch
