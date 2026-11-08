import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';

/**
 * <ion-app>'s own componentDidLoad schedules a real timer (ion-app.js's
 * `rIC` helper falls back to `setTimeout(fn, 32)` because jsdom has no
 * requestIdleCallback) from an async lifecycle that runs on a later frame,
 * not synchronously inside render(). `vi.runAllTimersAsync()` does not
 * cancel that timer — it runs it to completion right now, while the
 * element is still connected and jsdom is still alive, instead of leaving
 * it scheduled to fire later. Unmounting only after that flush means
 * componentDidLoad has already run its course before disconnectedCallback
 * gets a turn, so nothing is left pending for it to orphan. Unmount first
 * and the opposite happens: componentDidLoad fires *after* the element is
 * already disconnected and schedules a brand-new timer that nothing will
 * ever clear (disconnectedCallback only runs once per removal) — it then
 * fires later, possibly after Vitest has torn the jsdom environment down
 * for this file, raising "ReferenceError: window is not defined" from
 * Timeout._onTimeout (issue #217).
 */
async function settleThenUnmount(unmount: () => void): Promise<void> {
  await vi.runAllTimersAsync();
  unmount();
}

beforeEach(() => {
  vi.useFakeTimers();
  // Tests that do not care about the API get one that never answers.
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
});

afterEach(async () => {
  await settleThenUnmount(cleanup);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('App', () => {
  it('renders the shell', () => {
    render(<App />);
    expect(screen.getByTestId('shell')).toBeTruthy();
  });

  it('links to the documentation the deployment still serves', () => {
    render(<App />);
    const link = screen.getByRole('link', { name: 'The project documentation' });
    expect(link.getAttribute('href')).toBe('/docs/');
  });

  it("titles the toolbar from the project's own name, not a hardcoded one", () => {
    // Stubbed to a literal distinct from the real project name — asserting
    // against __APP_NAME__ itself would compare the component's value to
    // itself, which can't fail. If App.tsx ever hardcodes a string, the
    // stub has no effect on it and this fails.
    vi.stubGlobal('__APP_NAME__', 'stand-in-app');
    render(<App />);
    expect(screen.getByText('stand-in-app')).toBeTruthy();
  });

  it('shows the value fetched from the API', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ ok: true, commit: null, database: { adapter: 'memory', reachable: true } }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchSpy);
    render(<App />);
    await vi.runAllTimersAsync();
    expect(fetchSpy).toHaveBeenCalledWith('http://localhost:8000/health');
    expect(screen.getByTestId('api-status').textContent).toContain('memory, reachable');
  });

  it('shows a plain error when the API is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    render(<App />);
    await vi.runAllTimersAsync();
    expect(screen.getByTestId('api-error').textContent).toBe('The API could not be reached.');
  });

  it('shows the same error when the API answers with a failure status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 503 })));
    render(<App />);
    await vi.runAllTimersAsync();
    expect(screen.getByTestId('api-error')).toBeTruthy();
  });

  /**
   * Spies on the real setTimeout (captured before spying, so the spy still
   * delegates to whichever implementation is live — the fake-timers one
   * installed by beforeEach) to see whether anything schedules ion-app's
   * 32ms timer *after* a given unmount — that is exactly the issue #217
   * leak: a timer scheduled on a disconnected element, with nothing left
   * able to cancel it.
   */
  function spyOnSchedulingAfter(markUnmounted: () => boolean): {
    scheduledAfterUnmount: unknown[];
  } {
    const scheduledAfterUnmount: unknown[] = [];
    const realSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      handler: TimerHandler,
      timeout?: number,
      ...args: unknown[]
    ) => {
      if (markUnmounted() && timeout === 32) {
        scheduledAfterUnmount.push(timeout);
      }
      return realSetTimeout(handler as VoidFunction, timeout, ...args);
    }) as typeof setTimeout);
    return { scheduledAfterUnmount };
  }

  it('(control) unmounting without settling schedules the timer after unmount', async () => {
    // Proves the spy below can actually see the bug: unmounting with no
    // settle is the pre-fix behaviour, and it does schedule ion-app's 32ms
    // timer after the element is gone.
    let unmounted = false;
    const { scheduledAfterUnmount } = spyOnSchedulingAfter(() => unmounted);

    const { unmount } = render(<App />);
    unmount();
    unmounted = true;
    await vi.runAllTimersAsync();

    expect(scheduledAfterUnmount).toEqual([32]);
  });

  it('settling before unmount schedules nothing after unmount', async () => {
    let unmounted = false;
    const { scheduledAfterUnmount } = spyOnSchedulingAfter(() => unmounted);

    const { unmount } = render(<App />);
    await settleThenUnmount(() => {
      unmount();
      unmounted = true;
    });
    // Give anything still in flight a chance to (mis)schedule more work on
    // the disconnected element, so a regression here would be caught.
    await vi.runAllTimersAsync();

    expect(scheduledAfterUnmount).toEqual([]);
  });
});
