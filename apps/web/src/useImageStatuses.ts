import { createContext, useEffect, useRef, useState } from 'react';

import { getImage, type ImageState } from './images-api';

export const POLL_MS = 1500;

/** The state of every image the draft names, by id. */
export const ImageStatusContext = createContext<ReadonlyMap<string, ImageState>>(new Map());

const settled = (s: ImageState | undefined) => s?.status === 'ready' || s?.status === 'failed' || s?.status === 'missing';

/**
 * Follows the images a draft names: asks the API for each until it is ready, failed or
 * not found, every POLL_MS. The API marks a stuck image failed when it is read past the
 * timeout, so polling is also what makes a timeout show up here.
 */
export function useImageStatuses(ids: readonly string[]) {
  const [states, setStates] = useState<ReadonlyMap<string, ImageState>>(new Map());
  const key = [...new Set(ids)].sort().join('\n');
  const latest = useRef(states);
  useEffect(() => {
    latest.current = states;
  }, [states]);

  useEffect(() => {
    const wanted = key ? key.split('\n') : [];
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const round = async () => {
      const pending = wanted.filter((id) => !settled(latest.current.get(id)));
      if (pending.length === 0) return;
      const answers = await Promise.all(pending.map(async (id) => [id, await getImage(id)] as const));
      if (stopped) return;
      setStates((prev) => {
        const next = new Map(prev);
        for (const [id, answer] of answers) if (answer) next.set(id, answer);
        return next;
      });
      timer = setTimeout(() => void round(), POLL_MS);
    };
    void round();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [key]);

  const view = new Map<string, ImageState>();
  for (const id of ids) view.set(id, states.get(id) ?? { status: 'loading' });
  return view;
}
