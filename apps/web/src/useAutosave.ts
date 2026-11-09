import { useCallback, useEffect, useRef, useState } from 'react';

import { saveDraft, type DraftText } from './stories-api';

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'conflict' | 'invalid' | 'error';

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
  const [reasons, setReasons] = useState<string[]>([]);
  const leaving = useRef(false);
  const failure = useRef<'invalid' | 'error'>('error');
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
        if (mounted.current) setReasons([]);
        const result = await saveDraft(storyId, draft, updatedAt.current);
        if (result.kind === 'saved') {
          updatedAt.current = result.story.updated_at;
          if (!pending.current) set('saved');
        } else if (result.kind === 'invalid') {
          // The server refused this body (markup a story may not hold): say why, keep the
          // text, and try again on the next change.
          pending.current ??= draft;
          if (mounted.current) setReasons(result.reasons);
          failure.current = 'invalid';
          set('invalid');
          return;
        } else if (result.kind === 'conflict') {
          stopped.current = true;
          pending.current = null;
          set('conflict');
        } else {
          // Keep the newest text to retry on the next change or flush.
          pending.current ??= draft;
          failure.current = 'error';
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
    // browser finishes the request after the page is gone. A keepalive request
    // body is limited to 64 KB, so a longer draft may not get through; the
    // beforeunload prompt below is what covers that case. A save already in flight
    // does not hold this back: newer text is sent with the last known updated_at and this
    // tab's client_id, which the API accepts as the same tab superseding its own save even if
    // that save lands first. If another tab saved in between it is a 409 and the text is not
    // stored; the beforeunload prompt is what covers that.
    const onPageHide = () => {
      const draft = pending.current;
      if (!draft || stopped.current) return;
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


  // Text that is not saved yet (inside the pause, in flight, or refused) is lost if the
  // page closes: ask first. `allowLeave` is for a deliberate "leave anyway".
  const unsaved = status === 'saving' || status === 'error' || status === 'invalid';
  useEffect(() => {
    if (!unsaved) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (leaving.current) return;
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [unsaved]);

  const allowLeave = useCallback(() => {
    leaving.current = true;
  }, []);

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

  const flush = useCallback(async (): Promise<'saved' | 'conflict' | 'invalid' | 'error'> => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    await run();
    if (stopped.current) return 'conflict';
    if (pending.current === null) return 'saved';
    return failure.current;
  }, [run]);

  /** After Revert: the draft is the server's again, so there is nothing unsaved and the next save uses `next`. */
  const reset = useCallback((next: string) => {
    updatedAt.current = next;
    pending.current = null;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    failure.current = 'error';
    set('idle');
  }, []);

  /** The server's newer `updated_at` after Publish, so the next autosave is not a false conflict. */
  const adopt = useCallback((next: string) => {
    updatedAt.current = next;
  }, []);

  return { status, reasons, change, flush, adopt, reset, allowLeave };
}
