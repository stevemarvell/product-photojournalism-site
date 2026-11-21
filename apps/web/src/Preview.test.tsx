import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DraftPreview } from './Preview';
import { PublicSite } from './PublicSite';
import { ImageStatusContext } from './useImageStatuses';
import type { ImageState } from './images-api';

const ID = '3f2b8c1e-5a4d-4e6f-9b0a-1c2d3e4f5a6b';
const BODY = '**bold with *italic* inside** and a \\*literal\\* star and &lt;b&gt;';

beforeEach(() => vi.stubEnv('VITE_API_URL', '/api'));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

/** The first body paragraph's text and its strong/em runs, as the reader would see them. */
function shape(p: Element) {
  return {
    text: p.textContent,
    runs: [...p.querySelectorAll('strong, em')].map((e) => `${e.tagName}:${e.textContent}`),
  };
}

describe('the preview parses a draft as the public page does', () => {
  it('shows the same text and the same bold and italic runs', async () => {
    const draft = { title: 'T', description: '', location: '', date: null, content: BODY };
    render(
      <ImageStatusContext.Provider value={new Map()}>
        <DraftPreview draft={draft} imageIds={[]} />
      </ImageStatusContext.Provider>,
    );
    fireEvent.click(screen.getByTestId('preview-button'));
    const previewShape = shape(screen.getByTestId('preview').querySelectorAll('p')[0]!);
    cleanup();

    const piece = {
      id: ID,
      title: 'T',
      description: '',
      location: '',
      date: null,
      first_published_at: '2026-11-09T12:00:00Z',
      hero: null,
      content: BODY,
      photos: {},
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(piece), { status: 200 })));
    render(<PublicSite path={`/${ID}`} />);
    const article = await screen.findByTestId('piece');
    await waitFor(() => expect(article.querySelector('.public-text p')).not.toBeNull());
    const publicShape = shape(article.querySelector('.public-text p')!);

    expect(publicShape.text).toBe('bold with italic inside and a *literal* star and <b>');
    expect(previewShape).toEqual(publicShape);
    expect(previewShape.runs).toEqual(['STRONG:bold with ', 'STRONG:italic', 'EM:italic', 'STRONG: inside']);
  });

  it('draws a ready photo with srcset, alt, caption and credit', () => {
    const states = new Map<string, ImageState>([
      ['a', { id: 'a', status: 'ready', web_versions: [{ width: 480, url: '/public/images/a-480.jpg' }, { width: 960, url: '/public/images/a-960.jpg' }], width: 960, height: 640, byte_size: 1 } as ImageState],
    ]);
    const content = '<Photo image="a" alt="A street" caption="Dusk" credit="Me" />';
    render(
      <ImageStatusContext.Provider value={states}>
        <DraftPreview draft={{ title: 'T', description: '', location: '', date: null, content }} imageIds={['a']} />
      </ImageStatusContext.Provider>,
    );
    fireEvent.click(screen.getByTestId('preview-button'));
    const fig = screen.getByTestId('preview-photo');
    const img = fig.querySelector('img')!;
    expect(img.getAttribute('alt')).toBe('A street');
    expect(img.getAttribute('srcset')).toContain('480w');
    expect(img.getAttribute('srcset')).toContain('960w');
    expect(fig.textContent).toContain('Dusk');
    expect(fig.textContent).toContain('Me');
  });

  it('stays disabled while a photo is processing', () => {
    const states = new Map<string, ImageState>([['a', { id: 'a', status: 'processing' } as ImageState]]);
    render(
      <ImageStatusContext.Provider value={states}>
        <DraftPreview draft={{ title: 'T', description: '', location: '', date: null, content: '' }} imageIds={['a']} />
      </ImageStatusContext.Provider>,
    );
    expect((screen.getByTestId('preview-button') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('preview-reason').textContent).toContain('Preview is unavailable: photos are still processing.');
  });
});
