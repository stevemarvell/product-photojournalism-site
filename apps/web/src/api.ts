/**
 * Base URL of the API, fixed at build time from VITE_API_URL. The localhost
 * default exists for `npm run dev` only: a production build without it has no
 * API address, and says so rather than calling the visitor's own machine.
 */
export function apiUrl(): string | undefined {
  const configured = import.meta.env.VITE_API_URL as string | undefined;
  if (configured) return configured;
  return import.meta.env.DEV ? 'http://localhost:8000' : undefined;
}

export interface Health {
  ok: boolean;
  commit: string | null;
  database: { adapter: string; reachable: boolean };
}

/** Thrown, with no fetch made, when no API address was configured at build time. */
export class ApiNotConfiguredError extends Error {
  constructor() {
    super('API address not configured.');
  }
}

/** Fetches /health; rejects on a network failure or a non-2xx answer. */
export async function fetchHealth(): Promise<Health> {
  const base = apiUrl();
  if (!base) throw new ApiNotConfiguredError();
  const response = await fetch(`${base}/health`);
  if (!response.ok) throw new Error(`API answered ${response.status}`);
  return (await response.json()) as Health;
}
