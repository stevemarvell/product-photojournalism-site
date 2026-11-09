import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Editor } from './Editor';

// Same teardown discipline as App.test.tsx: flush Ionic's timers before unmount.
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv('VITE_API_URL', '/api');
});

afterEach(async () => {
  await vi.runAllTimersAsync();
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** Stubs fetch so /auth/me answers `me` and /auth/logout flips it to signed out. */
function stubApi(me: { status: number; body?: unknown }) {
  const state = { me };
  const fetchSpy = vi.fn((url: string, init?: RequestInit) => {
    if (url === '/api/auth/logout' && init?.method === 'POST') {
      state.me = { status: 200, body: { signedIn: false, user: null } };
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    if (url === '/api/auth/me') {
      return Promise.resolve(new Response(JSON.stringify(state.me.body ?? {}), { status: state.me.status }));
    }
    if (url === '/api/stories') return Promise.resolve(new Response('[]', { status: 200 }));
    return Promise.reject(new Error(`unexpected ${url}`));
  });
  vi.stubGlobal('fetch', fetchSpy);
  return fetchSpy;
}

const OWNER = { signedIn: true, user: { name: 'Owner', isOwner: true } };

describe('the editor route guard', () => {
  it('sends a signed-out visitor to sign in and renders no editor content', async () => {
    stubApi({ status: 200, body: { signedIn: false, user: null } });
    const navigate = vi.fn();
    render(<Editor navigate={navigate} />);
    expect(screen.queryByTestId('editor-content')).toBeNull(); // not even while checking
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith('/api/auth/login'));
    expect(screen.queryByTestId('editor-content')).toBeNull();
  });

  it.each([
    ['a 401', { status: 401 }],
    ['a server error', { status: 500 }],
    ['a signed-in user who is not the owner', { status: 200, body: { signedIn: true, user: { name: 'x', isOwner: false } } }],
    ['a malformed body', { status: 200, body: 'nonsense' }],
  ])('treats %s as signed out', async (_name, me) => {
    stubApi(me);
    const navigate = vi.fn();
    render(<Editor navigate={navigate} />);
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith('/api/auth/login'));
    expect(screen.queryByTestId('editor-content')).toBeNull();
  });

  it('treats an unreachable API as signed out', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    const navigate = vi.fn();
    render(<Editor navigate={navigate} />);
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith('/api/auth/login'));
    expect(screen.queryByTestId('editor-content')).toBeNull();
  });

  it('says sign-in is not configured, and shows no editor, on a 503', async () => {
    stubApi({ status: 503, body: { detail: 'sign-in not configured' } });
    const navigate = vi.fn();
    render(<Editor navigate={navigate} />);
    await vi.waitFor(() => expect(screen.getByTestId('editor-unconfigured')).toBeTruthy());
    expect(screen.getByTestId('editor-unconfigured').textContent).toContain('not configured');
    expect(screen.queryByTestId('editor-content')).toBeNull();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('shows the editor to the signed-in owner, without redirecting', async () => {
    stubApi({ status: 200, body: OWNER });
    const navigate = vi.fn();
    render(<Editor navigate={navigate} />);
    await vi.waitFor(() => expect(screen.getByTestId('editor-content')).toBeTruthy());
    expect(navigate).not.toHaveBeenCalled();
  });

  it('signs out: posts to the API, then the editor is gone', async () => {
    const fetchSpy = stubApi({ status: 200, body: OWNER });
    const navigate = vi.fn();
    render(<Editor navigate={navigate} />);
    await vi.waitFor(() => expect(screen.getByTestId('sign-out')).toBeTruthy());
    fireEvent.click(screen.getByTestId('sign-out'));
    await vi.waitFor(() => expect(screen.queryByTestId('editor-content')).toBeNull());
    expect(fetchSpy).toHaveBeenCalledWith('/api/auth/logout', { method: 'POST' });
    expect(screen.queryByTestId('editor-content')).toBeNull();
  });
});
