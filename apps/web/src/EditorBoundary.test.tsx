import { cleanup, render, screen } from '@testing-library/react';
import { lazy, Suspense } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditorBoundary } from './EditorBoundary';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('EditorBoundary', () => {
  it('shows a message and a Reload button when the lazy import rejects, and Reload reloads', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload });
    const Broken = lazy(() => Promise.reject(new Error('Failed to fetch dynamically imported module')));
    render(
      <EditorBoundary>
        <Suspense fallback={<p>Loading…</p>}>
          <Broken />
        </Suspense>
      </EditorBoundary>,
    );
    expect(screen.getByText('Loading…')).toBeTruthy();
    await vi.waitFor(() => expect(screen.getByText('The editor could not load.')).toBeTruthy());
    screen.getByRole('button', { name: 'Reload' }).click();
    expect(reload).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });

  it('renders its children when nothing fails', () => {
    render(
      <EditorBoundary>
        <p>fine</p>
      </EditorBoundary>,
    );
    expect(screen.getByText('fine')).toBeTruthy();
    expect(screen.queryByText('The editor could not load.')).toBeNull();
  });
});
