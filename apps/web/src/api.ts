/** Base URL of the API, fixed at build time from VITE_API_URL. */
export const API_URL: string =
  (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:8000';

export interface Health {
  ok: boolean;
  commit: string | null;
  database: { adapter: string; reachable: boolean };
}

/** Fetches /health; rejects on a network failure or a non-2xx answer. */
export async function fetchHealth(): Promise<Health> {
  const response = await fetch(`${API_URL}/health`);
  if (!response.ok) throw new Error(`API answered ${response.status}`);
  return (await response.json()) as Health;
}
