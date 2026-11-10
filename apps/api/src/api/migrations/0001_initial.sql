-- depends:
-- Tables from spec section 4 that this adapter needs: story, session, session_epoch.
-- Written to be re-runnable (if not exists) as well as tracked by yoyo, so a half-applied
-- or hand-repaired database converges instead of failing.
-- There is no user table: the one owner is a constant in the application (domain.OWNER) and
-- a session names its user by id. Image rows are a later migration (#40).

CREATE TABLE IF NOT EXISTS story (
    id                    text        NOT NULL,
    organisation_id       text        NOT NULL,
    live                  boolean     NOT NULL DEFAULT false,
    first_published_at    timestamptz,
    last_published_at     timestamptz,
    draft_title           text        NOT NULL DEFAULT '',
    draft_description     text        NOT NULL DEFAULT '',
    draft_location        text        NOT NULL DEFAULT '',
    draft_date            date,
    draft_content         text        NOT NULL DEFAULT '',
    published_title       text        NOT NULL DEFAULT '',
    published_description text        NOT NULL DEFAULT '',
    published_location    text        NOT NULL DEFAULT '',
    published_date        date,
    published_content     text        NOT NULL DEFAULT '',
    created_at            timestamptz NOT NULL,
    updated_at            timestamptz NOT NULL,
    last_saved_by         text,
    previous_updated_at   timestamptz,
    last_saved_seq        bigint,
    -- The same id may exist in two organisations; every query filters on organisation_id.
    PRIMARY KEY (organisation_id, id),
    -- A live story has been published: a write that says otherwise changes nothing.
    CONSTRAINT story_live_was_published CHECK (NOT live OR first_published_at IS NOT NULL)
);

-- The public site reads live stories of one organisation in first-published order.
CREATE INDEX IF NOT EXISTS story_live_by_first_published
    ON story (organisation_id, first_published_at DESC) WHERE live;

CREATE TABLE IF NOT EXISTS session (
    id         text        PRIMARY KEY,
    user_id    text        NOT NULL,
    created_at timestamptz NOT NULL
);

-- revoke-all deletes by user; sign-in sweeps expired rows by age.
CREATE INDEX IF NOT EXISTS session_by_user ON session (user_id);
CREATE INDEX IF NOT EXISTS session_by_created ON session (created_at);

-- The user's current epoch: bumped by revoke-all, so a cookie issued before it is refused.
CREATE TABLE IF NOT EXISTS session_epoch (
    user_id text    PRIMARY KEY,
    epoch   integer NOT NULL DEFAULT 0
);
