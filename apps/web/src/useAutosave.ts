import { useCallback, useEffect, useRef, useState } from 'react';

import { saveDraft, type DraftText } from './stories-api';

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'conflict' | 'error';

export const AUTOSAVE_DELAY_MS = 800;

/**
 * Debounced autosave of a story's draft (spec section 5). `change` records the
 * newest draft and restarts the pause; one save runs at a time, each sending
 * the `updated_at` the last save returned. A 409 stops autosaving for good
 * ("changed elsewhere, reload"). `flush` saves any pending change now and
 * says whether it all saved, hit a conflict, or failed: Publish and leaving wait on it.
 */
export function useAutosave(storyId: string, initialUpdatedAt: string, delay = AUTOSAVE_DELAY_MS) {
  const [status, setStatus] = useState<SaveStatus>('idle');
  const updatedAt = useRef(initialUpdatedAt);
  const pending = useRef<DraftText | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef<Promise<void> | null>(null);
  const stopped = useRef(false);
  const mounted = useRef(true);

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

  useEffect(() => {
    mounted.current = true;
    // Leaving the page (close, reload, a full navigation) cannot wait for the
    // pause or for a response: send what is pending now, with keepalive so the
    // browser finishes the request after the page is gone.
    const onPageHide = () => {
      const draft = pending.current;
      if (!draft || stopped.current || inFlight.current) return;
      pending.current = null;
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      void saveDraft(storyId, draft, updatedAt.current, true);
    };
    window.addEventListener('pagehide', onPageHide);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      mounted.current = false;
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      // Unmounted inside the pause (an in-app navigation): save now, not never.
      if (pending.current && !stopped.current) void run();
    };
  }, [storyId, run]);


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

  const flush = useCallback(async (): Promise<'saved' | 'conflict' | 'error'> => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    await run();
    if (stopped.current) return 'conflict';
    return pending.current === null ? 'saved' : 'error';
  }, [run]);

  /** The server's newer `updated_at` after Publish, so the next autosave is not a false conflict. */
  const adopt = useCallback((next: string) => {
    updatedAt.current = next;
  }, []);

  return { status, change, flush, adopt };
}
