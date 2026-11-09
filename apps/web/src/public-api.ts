import { base } from './api';

/** A Photo resolved by the API to its web versions (never the original). */
export interface PublicPhoto {
  width: number;
  height: number;
  versions: { width: number; url: string }[];
}

export interface PieceSummary {
  id: string;
  title: string;
  description: string;
  location: string;
  date: string | null;
  first_published_at: string;
  hero: (PublicPhoto & { image_id: string; alt: string }) | null;
}

export interface Piece extends PieceSummary {
  content: string;
  photos: Record<string, PublicPhoto>;
}

/** The API answered, but not with the data: `status` says how (501 = storage not built yet). */
export class PublicApiError extends Error {
  constructor(readonly status: number) {
    super(`API answered ${status}`);
  }
}

/**
 * Always asks the server afresh (`no-store`, which the API also sends), so a Publish,
 * Unpublish or Republish shows on the next load rather than after a cache expires.
 */
async function get(path: string): Promise<Response> {
  return fetch(`${base()}/public/pieces${path}`, { cache: 'no-store' });
}

/** Live pieces, newest first by first published date, as the API orders them. */
export async function fetchPieces(): Promise<PieceSummary[]> {
  const response = await get('');
  if (!response.ok) throw new PublicApiError(response.status);
  return (await response.json()) as PieceSummary[];
}

/** One live piece's published text, or null when there is no such live piece. */
export async function fetchPiece(id: string): Promise<Piece | null> {
  const response = await get(`/${encodeURIComponent(id)}`);
  if (response.status === 404) return null;
  if (!response.ok) throw new PublicApiError(response.status);
  return (await response.json()) as Piece;
}
