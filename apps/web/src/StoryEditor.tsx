import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';

import { publishBlockers } from './content';
import { getStory, publishStory, type DraftText, type StoryDetail } from './stories-api';
import { useAutosave, type SaveStatus } from './useAutosave';

const BodyEditor = lazy(() => import('./BodyEditor').then((m) => ({ default: m.BodyEditor })));

const STATUS_TEXT: Record<SaveStatus, string> = {
  idle: '',
  saving: 'Saving…',
  saved: 'Saved',
  conflict: 'Changed elsewhere, reload',
  error: 'Could not save, will retry on the next change',
};

/** The drafting screen at /editor/:id. */
export function StoryEditor({ id }: { id: string }) {
  const [story, setStory] = useState<StoryDetail | 'loading' | 'failed'>('loading');
  useEffect(() => {
    let live = true;
    getStory(id).then(
      (s) => live && setStory(s),
      () => live && setStory('failed'),
    );
    return () => {
      live = false;
    };
  }, [id]);

  if (story === 'loading') return <p role="status">Loading…</p>;
  if (story === 'failed') {
    return (
      <p role="alert" data-testid="story-failed">
        That story could not be loaded. <a href="/editor">Back to the list</a>
      </p>
    );
  }
  return <Drafting story={story} />;
}

/**
 * The seam for the confirm-before-overwrite step (issue #17, spec section 5):
 * Publish asks this first and goes ahead only on true. Today it never asks.
 * #17 replaces it with a dialog shown when published text already exists.
 */
export type ConfirmPublish = (story: StoryDetail) => Promise<boolean>;
const publishWithoutAsking: ConfirmPublish = () => Promise.resolve(true);

export function Drafting({
  story,
  confirmPublish = publishWithoutAsking,
  navigate = (url: string) => window.location.assign(url),
}: {
  story: StoryDetail;
  confirmPublish?: ConfirmPublish;
  navigate?: (url: string) => void;
}) {
  const [draft, setDraft] = useState<DraftText>(story.draft);
  const [live, setLive] = useState(story.live);
  const [message, setMessage] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const autosave = useAutosave(story.id, story.updated_at);
  const { change } = autosave;
  const latest = useRef(draft);

  const edit = useCallback(
    (patch: Partial<DraftText>) => {
      const next = { ...latest.current, ...patch };
      latest.current = next;
      setDraft(next);
      setMessage([]);
      change(next);
    },
    [change],
  );
  const editContent = useCallback((content: string) => edit({ content }), [edit]);

  const blockers = publishBlockers(draft);
  const conflict = autosave.status === 'conflict';

  const publish = async () => {
    setBusy(true);
    setMessage([]);
    try {
      if (!(await confirmPublish(story))) return;
      if ((await autosave.flush()) !== 'saved') {
        setMessage(['The draft could not be saved first.']);
        return;
      }
      const result = await publishStory(story.id);
      if (result.kind === 'published') {
        autosave.adopt(result.story.updated_at);
        setLive(true);
        setMessage(['Published.']);
      } else if (result.kind === 'refused') {
        setMessage(result.reasons.length ? result.reasons : ['The draft does not pass the publish rule.']);
      } else if (result.kind === 'conflict') {
        setMessage(['Changed elsewhere, reload']);
      } else {
        setMessage(['Publishing failed. Try again.']);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-testid="drafting" className="drafting">
      <p>
        <a
          href="/editor"
          data-testid="all-stories"
          onClick={(e) => {
            // Save any edit still inside the pause before leaving the page.
            e.preventDefault();
            void autosave.flush().then((result) => {
              // On a failed save stay, so the edit is not lost; a conflict has nothing to save.
              if (result !== 'error') navigate('/editor');
            });
          }}
        >
          All stories
        </a>{' '}
        · {live ? 'Live' : 'Not live'}
      </p>
      <label>
        Title
        <input data-testid="field-title" value={draft.title} onChange={(e) => edit({ title: e.target.value })} />
      </label>
      <label>
        Description
        <textarea
          data-testid="field-description"
          value={draft.description}
          onChange={(e) => edit({ description: e.target.value })}
        />
      </label>
      <label>
        Date
        <input
          data-testid="field-date"
          type="date"
          value={draft.date ?? ''}
          onChange={(e) => edit({ date: e.target.value || null })}
        />
      </label>
      <label>
        Location
        <input data-testid="field-location" value={draft.location} onChange={(e) => edit({ location: e.target.value })} />
      </label>

      <Suspense fallback={<p role="status">Loading editor…</p>}>
        <BodyEditor initial={story.draft.content} onChange={editContent} />
      </Suspense>

      <p data-testid="save-indicator" role="status" aria-live="polite">
        {STATUS_TEXT[autosave.status]}
      </p>
      {conflict && (
        <p data-testid="conflict" role="alert">
          Changed elsewhere, reload
        </p>
      )}

      <button
        type="button"
        data-testid="publish"
        disabled={busy || conflict || blockers.length > 0}
        onClick={() => void publish()}
      >
        Publish
      </button>
      {blockers.length > 0 && (
        <span data-testid="publish-reason"> Cannot publish yet: {blockers.join('; ')}.</span>
      )}
      {message.length > 0 && (
        <ul data-testid="publish-message" role="status">
          {message.map((m) => (
            <li key={m}>{m}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
