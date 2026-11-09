import { base } from './api';

export interface StorySummary {
  id: string;
  live: boolean;
  title: string;
  description: string;
  first_published_at: string | null;
}

export interface DraftText {
  title: string;
  description: string;
  location: string;
  date: string | null;
  content: string;
}

export interface StoryDetail {
  id: string;
  live: boolean;
  updated_at: string;
  draft: DraftText;
  published: DraftText | null;
}

const JSON_HEADERS = { 'content-type': 'application/json' };

async function ok<T>(response: Response): Promise<T> {
  if (!response.ok) throw new Error(`API answered ${response.status}`);
  return (await response.json()) as T;
}

/** All stories, in the order the API returns them (spec section 7). */
export async function listStories(): Promise<StorySummary[]> {
  return ok(await fetch(`${base()}/stories`));
}

export async function createStory(): Promise<StoryDetail> {
  return ok(await fetch(`${base()}/stories`, { method: 'POST' }));
}

export async function getStory(id: string): Promise<StoryDetail> {
  return ok(await fetch(`${base()}/stories/${encodeURIComponent(id)}`));
}

export type SaveResult =
  | { kind: 'saved'; story: StoryDetail }
  | { kind: 'conflict' }
  | { kind: 'invalid'; reasons: string[] }
  | { kind: 'error' };

/** The `reasons` of a 422 answer, or none when the body is not in that shape. */
async function reasonsOf(response: Response): Promise<string[]> {
  try {
    const body = (await response.json()) as { detail?: { reasons?: unknown } };
    return Array.isArray(body.detail?.reasons) ? body.detail.reasons.map(String) : [];
  } catch {
    return [];
  }
}

/** Autosave: sends the `updated_at` last seen; a 409 means the draft changed elsewhere. */
export async function saveDraft(
  id: string,
  draft: DraftText,
  updatedAt: string,
  keepalive = false,
): Promise<SaveResult> {
  try {
    const response = await fetch(`${base()}/stories/${encodeURIComponent(id)}/draft`, {
      method: 'PUT',
      headers: JSON_HEADERS,
      body: JSON.stringify({ ...draft, updated_at: updatedAt }),
      ...(keepalive ? { keepalive: true } : {}),
    });
    if (response.status === 409) return { kind: 'conflict' };
    if (response.status === 422) return { kind: 'invalid', reasons: await reasonsOf(response) };
    if (!response.ok) return { kind: 'error' };
    return { kind: 'saved', story: (await response.json()) as StoryDetail };
  } catch {
    return { kind: 'error' };
  }
}

export type PublishResult =
  | { kind: 'published'; story: StoryDetail }
  | { kind: 'refused'; reasons: string[] }
  | { kind: 'conflict' }
  | { kind: 'error' };

/** Publish: a 422 carries the server's reasons (image readiness is only known there). */
export async function publishStory(id: string): Promise<PublishResult> {
  try {
    const response = await fetch(`${base()}/stories/${encodeURIComponent(id)}/publish`, { method: 'POST' });
    if (response.status === 409) return { kind: 'conflict' };
    if (response.status === 422) return { kind: 'refused', reasons: await reasonsOf(response) };
    if (!response.ok) return { kind: 'error' };
    return { kind: 'published', story: (await response.json()) as StoryDetail };
  } catch {
    return { kind: 'error' };
  }
}
