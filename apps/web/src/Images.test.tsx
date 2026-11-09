import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BodyEditor } from './BodyEditor';
import { Drafting } from './StoryEditor';
import type { StoryDetail } from './stories-api';

beforeEach(() => vi.stubEnv('VITE_API_URL', '/api'));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const PHOTO = (id: string) => `<Photo image="${id}" alt="alt" caption="" credit="" />`;
const info = (id: string, status: string, extra: object = {}) => ({
  id,
  status,
  web_versions: [],
  width: null,
  height: null,
  byte_size: 1,
  ...extra,
});

function story(content: string): StoryDetail {
  return {
    id: 's1',
    live: false,
    updated_at: '2026-11-09T10:00:00Z',
    published: null,
    draft: { title: 'T', description: 'D', location: '', date: null, content },
  };
}

/** Serves GET /images/:id from a table the test changes while the screen is up. */
function imageApi(table: Record<string, object | number>) {
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    const m = /\/images\/([^/]+)$/.exec(url);
    if (m && !init?.method) {
      const row = table[m[1] ?? ''];
      if (typeof row === 'number') return Promise.resolve(json({}, row));
      return Promise.resolve(row ? json(row) : json({}, 404));
    }
    return Promise.resolve(json(story('')));
  });
}

describe('the photo block shows its image', () => {
  it('says processing, then shows a thumbnail once ready', async () => {
    const table: Record<string, object> = { a: info('a', 'processing') };
    imageApi(table);
    render(<Drafting story={story(PHOTO('a'))} />);
    expect((await screen.findByTestId('photo-status')).textContent).toContain('Processing');
    table['a'] = info('a', 'ready', { web_versions: [{ width: 480, url: '/public/images/a-480.jpg' }] });
    const thumb = await screen.findByTestId('photo-thumb', {}, { timeout: 4000 });
    expect(thumb.getAttribute('src')).toBe('/api/public/images/a-480.jpg');
    expect(screen.queryByTestId('photo-status')).toBeNull();
  });

  it('shows an error on a failed image, and that the owner should remove the block', async () => {
    imageApi({ a: info('a', 'failed') });
    render(<Drafting story={story(`${PHOTO('a')}\n\n${PHOTO('b')}`)} />);
    const errors = await screen.findAllByTestId('photo-error');
    // Only the failed block carries it: b is unknown to the API (404) and says so separately.
    expect(errors[0]?.textContent).toContain('could not be processed');
    expect(errors[0]?.textContent).toContain('Remove this block');
    expect(screen.getAllByTestId('photo-block')).toHaveLength(2);
  });

  it('turns a processing image into an error when the API later reports it failed (the timeout)', async () => {
    const table: Record<string, object> = { a: info('a', 'processing') };
    imageApi(table);
    render(<Drafting story={story(PHOTO('a'))} />);
    await screen.findByTestId('photo-status');
    table['a'] = info('a', 'failed');
    expect((await screen.findByTestId('photo-error', {}, { timeout: 4000 })).textContent).toContain('could not be processed');
  });
});

describe('the draft preview waits for the photos', () => {
  it('is greyed out with a message while any photo is processing, then opens when all are ready', async () => {
    const table: Record<string, object> = {
      a: info('a', 'ready', { web_versions: [{ width: 480, url: '/public/images/a-480.jpg' }] }),
      b: info('b', 'processing'),
    };
    imageApi(table);
    render(<Drafting story={story(`Words.\n\n${PHOTO('a')}\n\n${PHOTO('b')}`)} />);
    const button = (await screen.findByTestId('preview-button')) as HTMLButtonElement;
    await waitFor(() => expect(screen.getByTestId('preview-reason').textContent).toContain('photos are still processing'));
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.className).toContain('greyed');
    fireEvent.click(button);
    expect(screen.queryByTestId('preview')).toBeNull();

    table['b'] = info('b', 'ready', { web_versions: [{ width: 480, url: '/public/images/b-480.jpg' }] });
    await waitFor(() => expect((screen.getByTestId('preview-button') as HTMLButtonElement).disabled).toBe(false), {
      timeout: 4000,
    });
    expect(screen.queryByTestId('preview-reason')).toBeNull();
    fireEvent.click(screen.getByTestId('preview-button'));
    const preview = screen.getByTestId('preview');
    expect(preview.textContent).toContain('Words.');
    expect(screen.getAllByTestId('preview-photo')).toHaveLength(2);
  });

  it('stays unavailable, with its own message, when a photo failed', async () => {
    imageApi({ a: info('a', 'failed') });
    render(<Drafting story={story(PHOTO('a'))} />);
    await waitFor(() => expect(screen.getByTestId('preview-reason').textContent).toContain('failed to process'));
    expect((screen.getByTestId('preview-button') as HTMLButtonElement).disabled).toBe(true);
  });

  it('is open to a draft with no photos at all', async () => {
    imageApi({});
    render(<Drafting story={story('Just words.')} />);
    expect((screen.getByTestId('preview-button') as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('choosing photos', () => {
  it('shows a refused file with its message and a progress row for the others', async () => {
    let bodyOf: Record<string, string> = {};
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      if (url.endsWith('/upload-target')) {
        const size = JSON.parse(init?.body as string).size as number;
        return Promise.resolve(
          size === 1
            ? json({ upload_url: '/images/uploads/t', original_url: 'local:orig-t', method: 'PUT', max_bytes: 9 })
            : json({ detail: { limit: 9 } }, 413),
        );
      }
      bodyOf = { sent: String(init?.body) };
      return Promise.resolve(json(info('img-ok', 'processing'), 201));
    });
    class Xhr {
      status = 204;
      upload = { onprogress: null as null | ((e: object) => void) };
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      open() {}
      send() {
        queueMicrotask(() => this.onload?.());
      }
    }
    vi.stubGlobal('XMLHttpRequest', Xhr);

    render(<BodyEditor initial="" onChange={() => {}} />);
    await screen.findByTestId('photo-input');
    fireEvent.change(screen.getByTestId('photo-input'), {
      target: {
        files: [
          new File(['x'], 'ok.jpg', { type: 'image/jpeg' }),
          new File(['xxxxxxxxxxxx'], 'huge.jpg', { type: 'image/jpeg' }),
        ],
      },
    });
    const refused = await screen.findByRole('alert');
    expect(refused.textContent).toContain('huge.jpg');
    expect(refused.textContent).toContain('the limit is');
    await waitFor(() => expect(screen.getAllByTestId('upload-row').map((r) => r.getAttribute('data-state'))).toEqual(['done', 'refused']));
    expect(bodyOf['sent']).toContain('local:orig-t');
  });
});
