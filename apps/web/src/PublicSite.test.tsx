import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PublicSite, routeOf } from './PublicSite';
import type { Piece, PieceSummary } from './public-api';

const ID = '3f2b8c1e-5a4d-4e6f-9b0a-1c2d3e4f5a6b';
const PHOTO = {
  width: 960,
  height: 640,
  versions: [
    { width: 480, url: '/public/images/i-1-480.jpg' },
    { width: 960, url: '/public/images/i-1-960.jpg' },
  ],
};

const summary: PieceSummary = {
  id: ID,
  title: 'Dusk',
  description: 'A walk',
  location: 'Lisbon',
  date: '2026-10-31',
  first_published_at: '2026-11-09T12:00:00Z',
  hero: { ...PHOTO, image_id: 'i-1', alt: 'A street' },
};

function piece(content: string): Piece {
  return { ...summary, content, photos: { 'i-1': PHOTO } };
}

function answer(status: number, body: unknown) {
  return vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));
}

beforeEach(() => {
  vi.stubEnv('VITE_API_URL', '/api');
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  document.head.querySelectorAll('meta[name="description"]').forEach((m) => m.remove());
});

describe('routeOf', () => {
  it('knows the home page, a /<uuid> page, and nothing else', () => {
    expect(routeOf('/')).toEqual({ page: 'home' });
    expect(routeOf(`/${ID}`)).toEqual({ page: 'piece', id: ID });
    expect(routeOf(`/${ID}/`)).toEqual({ page: 'piece', id: ID });
    for (const path of ['/nope', `/${ID}/extra`, '/123', '/stories/' + ID]) expect(routeOf(path)).toEqual({ page: 'not-found' });
  });
});

describe('the home page', () => {
  // Scenario: home leads with the newest piece
  it('shows the first piece as the lead block and the rest under "More" as cards, each linking to its page', async () => {
    const other = { ...summary, id: 'b'.repeat(8) + '-0000-4000-8000-' + 'b'.repeat(12), title: 'Older', description: 'Another walk', location: 'Porto', date: null, first_published_at: '2026-10-01T12:00:00Z' };
    const fetchSpy = answer(200, [summary, other]);
    vi.stubGlobal('fetch', fetchSpy);
    render(<PublicSite path="/" />);
    const links = await screen.findAllByTestId('piece-link');
    expect(fetchSpy).toHaveBeenCalledWith('/api/public/pieces', { cache: 'no-store' });
    expect(links).toHaveLength(2);
    const [lead, card] = links as [HTMLElement, HTMLElement];
    expect(lead.getAttribute('href')).toBe(`/${ID}`);
    expect(lead.className).toBe('public-lead');
    expect(lead.textContent).toContain('Lisbon \u00b7 31 October 2026');
    expect(lead.querySelector('h2')?.textContent).toBe('Dusk');
    expect(lead.textContent).toContain('A walk');
    const img = lead.querySelector('img');
    expect(img?.getAttribute('alt')).toBe('A street');
    expect(img?.getAttribute('srcset')).toBe('/api/public/images/i-1-480.jpg 480w, /api/public/images/i-1-960.jpg 960w');
    const more = screen.getByTestId('more');
    expect(more.querySelector('h2')?.textContent).toBe('More');
    expect(more.contains(card)).toBe(true);
    expect(more.contains(lead)).toBe(false);
    expect(card.getAttribute('href')).toBe(`/${other.id}`);
    expect(card.querySelector('h3')?.textContent).toBe('Older');
    expect(card.textContent).toContain('Another walk');
    expect(card.querySelector('img')).toBeTruthy();
  });

  // Scenario: one live piece
  it('shows a single piece as the lead block with no "More" section', async () => {
    vi.stubGlobal('fetch', answer(200, [summary]));
    render(<PublicSite path="/" />);
    await screen.findByTestId('piece-list');
    expect(screen.getAllByTestId('piece-link')).toHaveLength(1);
    expect(screen.queryByTestId('more')).toBeNull();
    expect(screen.queryByText('More')).toBeNull();
  });

  // Scenario: a piece without a hero photo
  it('shows a neutral placeholder box in the photo slot of a piece without a hero', async () => {
    vi.stubGlobal('fetch', answer(200, [{ ...summary, hero: null }]));
    render(<PublicSite path="/" />);
    const link = await screen.findByTestId('piece-link');
    expect(link.querySelector('img')).toBeNull();
    expect(link.querySelector('[data-testid="placeholder"]')).toBeTruthy();
    expect(link.textContent).toContain('Dusk');
    expect(link.textContent).toContain('A walk');
  });

  it('puts the location first and falls back to the first-published date when the piece has no date; either part may be absent', async () => {
    vi.stubGlobal('fetch', answer(200, [{ ...summary, date: null }, { ...summary, id: 'c'.repeat(8) + '-0000-4000-8000-' + 'c'.repeat(12), location: '', date: null }]));
    render(<PublicSite path="/" />);
    const links = await screen.findAllByTestId('piece-link');
    expect(links[0]?.querySelector('.public-line')?.textContent).toBe('Lisbon \u00b7 9 November 2026');
    expect(links[1]?.querySelector('.public-line')?.textContent).toBe('9 November 2026');
  });

  it('renders no empty location line when a piece has neither a location nor a readable date', async () => {
    vi.stubGlobal('fetch', answer(200, [{ ...summary, location: '', date: null, first_published_at: 'not a date' }]));
    render(<PublicSite path="/" />);
    const link = await screen.findByTestId('piece-link');
    expect(link.querySelector('.public-line')).toBeNull();
    expect(link.querySelector('time')).toBeNull();
  });

  it('wraps the date in a machine-readable <time> on the home blocks and the piece page', async () => {
    vi.stubGlobal('fetch', answer(200, [summary, { ...summary, id: 'e'.repeat(8) + '-0000-4000-8000-' + 'e'.repeat(12), date: null }]));
    const { unmount } = render(<PublicSite path="/" />);
    const links = await screen.findAllByTestId('piece-link');
    expect(links[0]?.querySelector('time')?.getAttribute('datetime')).toBe('2026-10-31');
    expect(links[0]?.querySelector('time')?.textContent).toBe('31 October 2026');
    expect(links[1]?.querySelector('time')?.getAttribute('datetime')).toBe('2026-11-09T12:00:00Z');
    unmount();
    vi.stubGlobal('fetch', answer(200, piece('Words.')));
    render(<PublicSite path={`/${ID}`} />);
    const article = await screen.findByTestId('piece');
    expect(article.querySelector('.public-line time')?.getAttribute('datetime')).toBe('2026-10-31');
  });

  it('keeps the masthead name and the tagline without the word "story"', async () => {
    vi.stubGlobal('fetch', answer(200, [summary, { ...summary, id: 'd'.repeat(8) + '-0000-4000-8000-' + 'd'.repeat(12) }]));
    render(<PublicSite path="/" />);
    await screen.findByTestId('piece-list');
    expect(screen.getByText('Photojournalism')).toBeTruthy();
    expect(screen.getByTestId('public').textContent).not.toMatch(/stor(y|ies)/i);
  });

  it('says plainly that nothing is published when the list is empty', async () => {
    vi.stubGlobal('fetch', answer(200, []));
    render(<PublicSite path="/" />);
    expect((await screen.findByTestId('empty')).textContent).toBe('Nothing has been published yet.');
  });

  it('shows "No application here yet." (and does not crash) where storage answers 501', async () => {
    vi.stubGlobal('fetch', answer(501, { detail: 'not available' }));
    render(<PublicSite path="/" />);
    expect((await screen.findByTestId('empty')).textContent).toBe('No application here yet.');
  });

  it.each([
    ['a 500', () => vi.fn().mockResolvedValue(new Response('{}', { status: 500 }))],
    ['a network failure', () => vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))],
  ])('shows a plain error on %s', async (_n, make) => {
    vi.stubGlobal('fetch', make());
    render(<PublicSite path="/" />);
    expect((await screen.findByTestId('load-error')).textContent).toBe('The pieces could not be loaded.');
  });

  it('says so, and makes no fetch, in a production build without VITE_API_URL', async () => {
    vi.stubEnv('DEV', false);
    vi.stubEnv('VITE_API_URL', '');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    render(<PublicSite path="/" />);
    expect((await screen.findByTestId('load-error')).textContent).toBe('The pieces could not be loaded.');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('a piece page', () => {
  const body = [
    'Opening **bold** and *italic*.',
    '<Photo image="i-1" alt="A street at dusk" caption="Evening, &amp; quiet" credit="A. Photographer" />',
    'Closing words.',
  ].join('\n\n');

  it('shows title, date and location, paragraphs, and a full-width photo with srcset, alt, caption and credit', async () => {
    const fetchSpy = answer(200, piece(body));
    vi.stubGlobal('fetch', fetchSpy);
    render(<PublicSite path={`/${ID}`} />);
    const article = await screen.findByTestId('piece');
    expect(fetchSpy).toHaveBeenCalledWith(`/api/public/pieces/${ID}`, { cache: 'no-store' });
    expect(article.querySelector('h1')?.textContent).toBe('Dusk');
    expect(article.textContent).toContain('Lisbon · 31 October 2026');
    expect(article.querySelector('strong')?.textContent).toBe('bold');
    expect(article.querySelector('em')?.textContent).toBe('italic');
    const img = article.querySelector('figure img');
    expect(img?.getAttribute('alt')).toBe('A street at dusk');
    expect(img?.getAttribute('srcset')).toContain('/api/public/images/i-1-960.jpg 960w');
    expect(img?.getAttribute('sizes')).toBe('100vw');
    expect(article.querySelector('.public-standfirst')?.textContent).toBe('A walk');
    expect(article.querySelector('figcaption .public-credit')?.textContent).toBe('A. Photographer');
    const back = screen.getByText('\u2190 All pieces');
    expect(back.getAttribute('href')).toBe('/');
    expect(article.querySelector('figcaption span')?.textContent).toBe('Evening, & quiet');
    expect(article.textContent).toContain('A. Photographer');
    expect(article.textContent).toContain('Closing words.');
  });

  it('sets the document title and description from the published text, and puts them back', async () => {
    vi.stubGlobal('fetch', answer(200, piece(body)));
    const before = document.title;
    const { unmount } = render(<PublicSite path={`/${ID}`} />);
    await screen.findByTestId('piece');
    await waitFor(() => expect(document.title).toBe('Dusk'));
    await waitFor(() =>
      expect(document.querySelector('meta[name="description"]')?.getAttribute('content')).toBe('A walk'),
    );
    unmount();
    await waitFor(() => expect(document.title).toBe(before));
    await waitFor(() => expect(document.querySelector('meta[name="description"]')).toBeNull());
  });

  it('shows a normal not-found page for an id the API does not know or has not live', async () => {
    vi.stubGlobal('fetch', answer(404, { detail: 'not found' }));
    render(<PublicSite path={`/${ID}`} />);
    expect((await screen.findByTestId('not-found')).textContent).toBe('Page not found');
    await waitFor(() => expect(document.title).toBe('Page not found'));
  });

  it('shows the not-found page, with no fetch, for a path that is not a /<uuid>', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    render(<PublicSite path="/whatever" />);
    expect(screen.getByTestId('not-found')).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('leaves out a photo the API could not resolve, rather than a broken image', async () => {
    vi.stubGlobal('fetch', answer(200, { ...piece(body), photos: {} }));
    render(<PublicSite path={`/${ID}`} />);
    await screen.findByTestId('piece');
    expect(screen.queryByTestId('photo')).toBeNull();
  });

  // Scenario: stored markup is never evaluated.
  it('renders stored import/export/markup as inert text: no element, script or HTML is created', async () => {
    const hostile = [
      'import a from "x"',
      'export const a = 1',
      '&lt;script&gt;window.__pwned = 1&lt;/script&gt;',
      '<script>window.__pwned = 1</script>',
      '<img src=x onerror="window.__pwned = 1">',
      '{window.__pwned = 1}',
      body,
    ].join('\n\n');
    vi.stubGlobal('fetch', answer(200, piece(hostile)));
    render(<PublicSite path={`/${ID}`} />);
    const article = await screen.findByTestId('piece');
    expect(article.querySelector('script')).toBeNull();
    expect(document.querySelector('script')).toBeNull();
    expect(article.querySelectorAll('img')).toHaveLength(1); // the one Photo, none from stored text
    expect(article.querySelector('[onerror]')).toBeNull();
    expect((window as unknown as Record<string, unknown>)['__pwned']).toBeUndefined();
    const text = article.textContent ?? '';
    expect(text).toContain('import a from "x"');
    expect(text).toContain('export const a = 1');
    expect(text).toContain('<script>window.__pwned = 1</script>'); // as characters
    expect(text).toContain('{window.__pwned = 1}');
    expect(text).toContain('<img src=x onerror="window.__pwned = 1">');
  });

  it('leaves out a Photo naming an inherited property (constructor, __proto__, toString) and still renders', async () => {
    const tags = ['constructor', '__proto__', 'toString', 'hasOwnProperty']
      .map((id) => `<Photo image="${id}" alt="x" />`)
      .join('\n\n');
    vi.stubGlobal('fetch', answer(200, piece(`Before.\n\n${tags}\n\nAfter.`)));
    render(<PublicSite path={`/${ID}`} />);
    const article = await screen.findByTestId('piece');
    expect(article.textContent).toContain('Before.');
    expect(article.textContent).toContain('After.');
    expect(screen.queryByTestId('photo')).toBeNull();
  });

  it('shows a plain error where the API cannot answer, and not a not-found page', async () => {
    vi.stubGlobal('fetch', answer(503, {}));
    render(<PublicSite path={`/${ID}`} />);
    expect((await screen.findByTestId('load-error')).textContent).toBe('This page can\u2019t be shown right now.');
  });

  it('on a 501 shows the plain error, not the home page\'s "No application here yet."', async () => {
    vi.stubGlobal('fetch', answer(501, { detail: 'x' }));
    render(<PublicSite path={`/${ID}`} />);
    expect((await screen.findByTestId('load-error')).textContent).toBe('This page can\u2019t be shown right now.');
    expect(screen.queryByText('No application here yet.')).toBeNull();
    expect(screen.queryByTestId('not-found')).toBeNull();
  });
});
