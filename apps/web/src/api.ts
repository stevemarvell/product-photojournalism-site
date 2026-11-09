/**
 * Base URL of the API, fixed at build time from VITE_API_URL. Deployed, it is
 * `/api`: the web app's own origin, which vercel.json rewrites to the API, so
 * the session cookie is first-party. Under `npm run dev` it defaults to the
 * same `/api`, which vite.config.ts proxies to the local API. A production
 * build without it has no API address, and says so rather than calling the
 * visitor's own machine.
 */
export function apiUrl(): string | undefined {
  const configured = import.meta.env.VITE_API_URL as string | undefined;
  if (configured) return configured;
  return import.meta.env.DEV ? '/api' : undefined;
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

/** The API base, or throws ApiNotConfiguredError. */
export function base(): string {
  const url = apiUrl();
  if (!url) throw new ApiNotConfiguredError();
  return url;
}

/** Fetches /health; rejects on a network failure or a non-2xx answer. */
export async function fetchHealth(): Promise<Health> {
  const response = await fetch(`${base()}/health`);
  if (!response.ok) throw new Error(`API answered ${response.status}`);
  return (await response.json()) as Health;
}

/** Where the Sign in with Vercel flow starts. */
export function loginUrl(): string {
  return `${apiUrl() ?? '/api'}/auth/login`;
}

export type Session =
  | { state: 'signed-in'; name: string }
  | { state: 'signed-out' }
  | { state: 'unconfigured' };

/**
 * Who is signed in, from /auth/me. Anything but a clear "signed in" counts as
 * signed out, so a failure can never show the editor; only a 503 from the API
 * ("sign-in not configured") is told apart, so the page can say so.
 */
export async function fetchSession(): Promise<Session> {
  try {
    const response = await fetch(`${base()}/auth/me`);
    if (response.status === 503) return { state: 'unconfigured' };
    if (!response.ok) return { state: 'signed-out' };
    const body = (await response.json()) as {
      signedIn?: unknown;
      user?: { name?: unknown; isOwner?: unknown } | null;
    };
    if (body.signedIn === true && body.user?.isOwner === true) {
      return { state: 'signed-in', name: String(body.user.name ?? 'Owner') };
    }
    return { state: 'signed-out' };
  } catch {
    return { state: 'signed-out' };
  }
}

/** Ends the session. Resolves whether or not the API answered: the caller then re-asks /auth/me. */
export async function signOut(): Promise<void> {
  try {
    await fetch(`${base()}/auth/logout`, { method: 'POST' });
  } catch {
    // The next fetchSession decides what the page shows.
  }
}
