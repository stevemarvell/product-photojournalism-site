import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { parsePhoto, photoTags, publishBlockers } from './content';
import { DraftPreview } from './Preview';
import { ImageStatusContext, useImageStatuses } from './useImageStatuses';
import { getStory, lifecycle, publishStory, type DraftText, type StoryDetail } from './stories-api';
import { useAutosave, type SaveStatus } from './useAutosave';

const BodyEditor = lazy(() => import('./BodyEditor').then((m) => ({ default: m.BodyEditor })));

const STATUS_TEXT: Record<SaveStatus, string> = {
  idle: '',
  saving: 'Saving…',
  saved: 'Saved',
  conflict: 'Changed elsewhere, reload',
  invalid: 'Not saved',
  error: 'Could not save, will retry on the next change',
};

function failureText(result: { kind: 'refused'; reasons: string[] } | { kind: 'conflict' } | { kind: 'error' }): string[] {
  if (result.kind === 'refused') return result.reasons.length ? result.reasons : ['That action is not available now. Reload.'];
  if (result.kind === 'conflict') return ['Changed elsewhere, reload'];
  return ['That did not work. Try again.'];
}

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
 * The seams for the confirm-before-overwrite step (spec section 5). Publish asks
 * `confirmPublish` and Revert asks `confirmRevert`, and each goes ahead only on true.
 * Left out, they show the screen's own confirmation: Publish only when published text
 * already exists, Revert always.
 */
export type ConfirmPublish = (story: StoryDetail) => Promise<boolean>;
export type ConfirmRevert = (story: StoryDetail) => Promise<boolean>;

interface Question {
  text: string;
  ok: string;
  resolve: (yes: boolean) => void;
}

const sameText = (a: DraftText, b: DraftText) =>
  a.title === b.title &&
  a.description === b.description &&
  a.location === b.location &&
  (a.date ?? null) === (b.date ?? null) &&
  a.content === b.content;

export function Drafting({
  story,
  confirmPublish,
  confirmRevert,
  navigate = (url: string) => window.location.assign(url),
}: {
  story: StoryDetail;
  confirmPublish?: ConfirmPublish;
  confirmRevert?: ConfirmRevert;
  navigate?: (url: string) => void;
}) {
  const [draft, setDraft] = useState<DraftText>(story.draft);
  const [live, setLive] = useState(story.live);
  const [published, setPublished] = useState<DraftText | null>(story.published);
  const [initialContent, setInitialContent] = useState(story.draft.content);
  const [editorKey, setEditorKey] = useState(0);
  const [question, setQuestion] = useState<Question | null>(null);
  const [message, setMessage] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [leaveBlocked, setLeaveBlocked] = useState(false);
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

  const imageIds = useMemo(
    () => photoTags(draft.content).map((t) => parsePhoto(t).image).filter(Boolean),
    [draft.content],
  );
  const imageStates = useImageStatuses(imageIds);
  const blockers = publishBlockers(draft);
  const conflict = autosave.status === 'conflict';

  const ask = (text: string, ok: string) =>
    new Promise<boolean>((resolve) => setQuestion({ text, ok, resolve }));
  const answer = (yes: boolean) => {
    question?.resolve(yes);
    setQuestion(null);
  };
  const detailNow = (): StoryDetail => ({ ...story, live, published, draft: latest.current });
  const differs = published !== null && !sameText(draft, published);

  /** Take the server's answer for the story as the new truth for the buttons and the next save. */
  const adoptStory = (next: StoryDetail) => {
    autosave.adopt(next.updated_at);
    setLive(next.live);
    setPublished(next.published);
  };

  const publish = async () => {
    setBusy(true);
    setMessage([]);
    try {
      const go = confirmPublish
        ? await confirmPublish(detailNow())
        : published
          ? await ask('Publish will replace the live text with this draft. Continue?', 'Publish')
          : true;
      if (!go) return;
      if ((await autosave.flush()) !== 'saved') {
        setMessage(['The draft could not be saved first.']);
        return;
      }
      const result = await publishStory(story.id);
      if (result.kind === 'published') {
        adoptStory(result.story);
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

  const DONE: Record<'unpublish' | 'republish', string> = {
    unpublish: 'Unpublished. The text is kept.',
    republish: 'Republished.',
  };

  /** Unpublish or Republish: the draft is not touched, so there is nothing to confirm. */
  const toggleLive = async (action: 'unpublish' | 'republish') => {
    setBusy(true);
    setMessage([]);
    try {
      await autosave.flush(); // let a save in flight land first, so this is not a false conflict
      const result = await lifecycle(story.id, action);
      if (result.kind === 'done') {
        adoptStory(result.story);
        setMessage([DONE[action]]);
      } else {
        setMessage(failureText(result));
      }
    } finally {
      setBusy(false);
    }
  };

  const revert = async () => {
    setBusy(true);
    setMessage([]);
    try {
      const go = confirmRevert
        ? await confirmRevert(detailNow())
        : await ask('Revert will replace this draft with the published text. Draft changes are lost. Continue?', 'Revert');
      if (!go) return;
      // Send what is still inside the pause and wait for it (and any save in flight), so the
      // server sees what the owner saw, nothing lands after the copy, and a refused revert
      // has lost no typing.
      const saved = await autosave.flush();
      if (saved === 'conflict') {
        setMessage(['Changed elsewhere, reload']);
        return;
      }
      if (saved !== 'saved') {
        setMessage(['The draft could not be saved first.']);
        return;
      }
      const result = await lifecycle(story.id, 'revert');
      if (result.kind === 'done') {
        const fresh = result.story;
        latest.current = fresh.draft;
        setDraft(fresh.draft);
        setInitialContent(fresh.draft.content);
        setEditorKey((k) => k + 1); // the body editor takes its text only when it mounts
        adoptStory(fresh);
        autosave.reset(fresh.updated_at);
        setMessage(['Reverted to the published text.']);
      } else {
        setMessage(failureText(result));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <ImageStatusContext.Provider value={imageStates}>
    <div data-testid="drafting" className="drafting">
      <p>
        <a
          href="/editor"
          data-testid="all-stories"
          onClick={(e) => {
            // Save any edit still inside the pause before leaving the page.
            e.preventDefault();
            void autosave.flush().then((result) => {
              // On a failed save stay, so the edit is not lost, and let the owner choose;
              // a conflict has nothing left to save.
              if (result === 'error' || result === 'invalid') setLeaveBlocked(true);
              else navigate('/editor');
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
        <BodyEditor key={editorKey} initial={initialContent} onChange={editContent} />
      </Suspense>

      <DraftPreview draft={draft} imageIds={imageIds} />

      <p data-testid="save-indicator" role="status" aria-live="polite">
        {STATUS_TEXT[autosave.status]}
      </p>
      {autosave.status === 'invalid' && (
        <div data-testid="save-refused" role="alert">
          <p>The server refused this text:</p>
          <ul>
            {autosave.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </div>
      )}
      {leaveBlocked && (
        <p data-testid="leave-blocked" role="alert">
          The latest changes are not saved.{' '}
          <button
            type="button"
            data-testid="leave-anyway"
            onClick={() => {
              autosave.allowLeave();
              navigate('/editor');
            }}
          >
            Leave anyway (unsaved changes will be lost)
          </button>
        </p>
      )}
      {conflict && (
        <p data-testid="conflict" role="alert">
          Changed elsewhere, reload
        </p>
      )}

      <button
        type="button"
        data-testid="publish"
        disabled={busy || conflict || blockers.length > 0 || question !== null}
        onClick={() => void publish()}
      >
        Publish
      </button>
      {live && (
        <button type="button" data-testid="unpublish" disabled={busy || conflict} onClick={() => void toggleLive('unpublish')}>
          Unpublish
        </button>
      )}
      {!live && published !== null && (
        <button type="button" data-testid="republish" disabled={busy || conflict} onClick={() => void toggleLive('republish')}>
          Republish
        </button>
      )}
      {published !== null && (
        <button
          type="button"
          data-testid="revert"
          disabled={busy || conflict || !differs || question !== null}
          onClick={() => void revert()}
        >
          Revert
        </button>
      )}
      {live && differs && (
        <p data-testid="update-live-note" role="status">
          Publish will update the live version.
        </p>
      )}
      {question && (
        <div data-testid="confirm" role="alertdialog" aria-modal="false" aria-label="Confirm" onKeyDown={(e) => e.key === 'Escape' && answer(false)}>
          <p>{question.text}</p>
          <button type="button" data-testid="confirm-ok" onClick={() => answer(true)}>
            {question.ok}
          </button>{' '}
          <button type="button" data-testid="confirm-cancel" autoFocus onClick={() => answer(false)}>
            Cancel
          </button>
        </div>
      )}
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
    </ImageStatusContext.Provider>
  );
}
