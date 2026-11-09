import { useCallback, useEffect, useRef, useState } from 'react';

import { saveDraft, type DraftText } from './stories-api';

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'conflict' | 'error';

export const AUTOSAVE_DELAY_MS = 800;

/**
 * Debounced autosave of a story's draft (spec section 5). `change` records the
 * newest draft and restarts the pause; one save runs at a time, each sending
 * the `updated_at` the last save returned. A 409 stops autosaving for good
 * ("changed elsewhere, reload"). `flush` saves any pending change now and
 * resolves true when nothing is left unsaved: Publish waits on it.
 */
export function useAutosave(storyId: string, initialUpdatedAt: string, delay = AUTOSAVE_DELAY_MS) {
  const [status, setStatus] = useState<SaveStatus>('idle');
  const updatedAt = useRef(initialUpdatedAt);
  const pending = useRef<DraftText | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef<Promise<void> | null>(null);
  const stopped = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const set = (s: SaveStatus) => {
    if (mounted.current) setStatus(s);
  };

  const run = useCallback((): Promise<void> => {
    if (inFlight.current) return inFlight.current;
    const loop = async () => {
      while (pending.current && !stopped.current) {
        const draft = pending.current;
        pending.current = null;
        set('saving');
        const result = await saveDraft(storyId, draft, updatedAt.current);
        if (result.kind === 'saved') {
          updatedAt.current = result.story.updated_at;
          if (!pending.current) set('saved');
        } else if (result.kind === 'conflict') {
          stopped.current = true;
          pending.current = null;
          set('conflict');
        } else {
          // Keep the newest text to retry on the next change or flush.
          pending.current ??= draft;
          set('error');
          return;
        }
      }
    };
    inFlight.current = loop().finally(() => {
      inFlight.current = null;
    });
    return inFlight.current;
  }, [storyId]);

  const change = useCallback(
    (draft: DraftText) => {
      if (stopped.current) return;
      pending.current = draft;
      set('saving');
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = null;
        void run();
      }, delay);
    },
    [run, delay],
  );

  const flush = useCallback(async (): Promise<boolean> => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    await run();
    return !stopped.current && pending.current === null;
  }, [run]);

  /** The server's newer `updated_at` after Publish, so the next autosave is not a false conflict. */
  const adopt = useCallback((next: string) => {
    updatedAt.current = next;
  }, []);

  return { status, change, flush, adopt };
}
