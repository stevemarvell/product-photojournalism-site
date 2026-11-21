-- depends: 0001_initial
-- Image rows (spec section 4) and the upload targets they come from. Re-runnable, like 0001.

CREATE TABLE IF NOT EXISTS image (
    id              text        NOT NULL,
    organisation_id text        NOT NULL,
    status          text        NOT NULL CHECK (status IN ('processing', 'ready', 'failed')),
    -- Private: no public response carries it.
    original_url    text        NOT NULL,
    byte_size       bigint      NOT NULL,
    created_at      timestamptz NOT NULL,
    -- [{"width": 480, "url": "..."}, ...], only once ready.
    web_versions    jsonb       NOT NULL DEFAULT '[]',
    width           integer,
    height          integer,
    PRIMARY KEY (organisation_id, id),
    -- An upload backs exactly one image row, whatever the application does.
    CONSTRAINT image_one_row_per_upload UNIQUE (original_url)
);

-- An upload target issued to an organisation, and whether it is registered yet. Kept here,
-- not in the process, so a restart (or another serverless instance) still knows both.
CREATE TABLE IF NOT EXISTS image_upload (
    original_url    text        PRIMARY KEY,
    organisation_id text        NOT NULL,
    issued_at       timestamptz NOT NULL,
    claimed_at      timestamptz
);
