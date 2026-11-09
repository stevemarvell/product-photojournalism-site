import { expect, test, type Page } from '@playwright/test';

// The API is mocked at the network layer, as in editor.spec.ts: the bundle is built with
// VITE_API_URL=http://api.e2e.invalid, so every call is a cross-origin fetch the browser
// answers from here. The built bundle is what is under test.
const API = 'http://api.e2e.invalid';
const CORS = { 'access-control-allow-origin': '*' };
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64');

const ID_A = '3f2b8c1e-5a4d-4e6f-9b0a-1c2d3e4f5a6b';
const ID_B = '8d0e7a52-1c3b-4f9a-a6d4-0b5e2c7f9a10';

const photo = (id: string) => ({
  width: 1600,
  height: 1000,
  versions: [
    { width: 480, url: `/public/images/${id}-480.jpg` },
    { width: 960, url: `/public/images/${id}-960.jpg` },
    { width: 1600, url: `/public/images/${id}-1600.jpg` },
  ],
});

const summary = (id: string, title: string, published: string, image: string) => ({
  id,
  title,
  description: `About ${title}`,
  location: 'Lisbon',
  date: '2026-10-31',
  first_published_at: published,
  hero: { image_id: image, alt: `${title} hero`, ...photo(image) },
});

const A = summary(ID_A, 'Dusk', '2026-11-01T10:00:00Z', 'img-a');
const B = summary(ID_B, 'Dawn', '2026-11-08T10:00:00Z', 'img-b');

const json = (body: unknown, status = 200) => ({
  status,
  contentType: 'application/json',
  headers: { ...CORS, 'cache-control': 'no-store' },
  body: JSON.stringify(body),
});

/** Answers the public API from `state`; returns the URLs the page asked for. */
async function mockApi(page: Page, state: { list: unknown[]; pieces: Record<string, unknown>; status?: number }) {
  const asked: string[] = [];
  page.on('request', (r) => asked.push(r.url()));
  await page.route(`${API}/public/images/*`, (route) =>
    route.fulfill({ status: 200, contentType: 'image/png', headers: CORS, body: PNG }),
  );
  await page.route(`${API}/public/pieces`, (route) =>
    route.fulfill(state.status ? json({ detail: 'x' }, state.status) : json(state.list)),
  );
  await page.route(`${API}/public/pieces/*`, (route) => {
    const id = route.request().url().split('/').pop() ?? '';
    const piece = state.pieces[id];
    return route.fulfill(state.status ? json({ detail: 'x' }, state.status) : piece ? json(piece) : json({ detail: 'not found' }, 404));
  });
  return asked;
}

const detail = (s: ReturnType<typeof summary>, content: string) => ({
  ...s,
  content,
  photos: { [s.hero.image_id]: photo(s.hero.image_id) },
});

const BODY = (image: string) =>
  `Opening words with **bold** and *italic*.\n\n<Photo image="${image}" alt="A street at dusk" caption="Evening light" credit="A. Photographer" />\n\nClosing words.`;

test.describe('the home page', () => {
  test('lists live pieces newest first, each with hero, title, description and published date, linking to /<uuid>', async ({ page }) => {
    // The API orders them; the page keeps that order (newest first by first published date).
    await mockApi(page, { list: [B, A], pieces: {} });
    const heroLoaded = page.waitForResponse((r) => /img-b-\d+\.jpg$/.test(r.url()) && r.status() === 200);
    await page.goto('/');
    const links = page.getByTestId('piece-link');
    await expect(links).toHaveCount(2);
    await expect(page.getByRole('heading', { level: 2 })).toHaveText(['Dawn', 'Dusk']);
    await expect(links.nth(0)).toHaveAttribute('href', `/${ID_B}`);
    await expect(links.nth(1)).toHaveAttribute('href', `/${ID_A}`);
    await expect(links.nth(0).locator('img')).toHaveAttribute('alt', 'Dawn hero');
    await expect(links.nth(0).locator('img')).toHaveAttribute('srcset', /img-b-480\.jpg 480w.*img-b-1600\.jpg 1600w/);
    await expect(page.getByText('About Dawn')).toBeVisible();
    await expect(page.getByText('8 November 2026')).toBeVisible();
    // The browser fetched a web version of the hero, from the API.
    expect((await heroLoaded).url()).toMatch(/^http:\/\/api\.e2e\.invalid\/public\/images\/img-b-/);
  });

  test('says nothing has been published when there are no live pieces', async ({ page }) => {
    await mockApi(page, { list: [], pieces: {} });
    await page.goto('/');
    await expect(page.getByTestId('empty')).toHaveText('Nothing has been published yet.');
  });

  test('shows "No application here yet." instead of crashing where the API storage is not built (501)', async ({ page }) => {
    await mockApi(page, { list: [], pieces: {}, status: 501 });
    await page.goto('/');
    await expect(page.getByTestId('empty')).toHaveText('No application here yet.');
  });

  test('shows a plain error where the API cannot be reached', async ({ page }) => {
    await page.route(`${API}/public/pieces`, (route) => route.abort('connectionrefused'));
    await page.goto('/');
    await expect(page.getByTestId('load-error')).toHaveText('The pieces could not be loaded.');
  });

  test('clicking an entry opens its page', async ({ page }) => {
    await mockApi(page, { list: [A], pieces: { [ID_A]: detail(A, BODY('img-a')) } });
    await page.goto('/');
    await page.getByTestId('piece-link').click();
    await expect(page).toHaveURL(`/${ID_A}`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Dusk');
  });
});

test.describe('a piece page', () => {
  test('shows title, date and location, paragraphs and full-width photos with srcset, alt, caption and credit', async ({ page }) => {
    await mockApi(page, { list: [A], pieces: { [ID_A]: detail(A, BODY('img-a')) } });
    await page.goto(`/${ID_A}`);
    const article = page.getByTestId('piece');
    await expect(article.getByRole('heading', { level: 1 })).toHaveText('Dusk');
    await expect(article).toContainText('31 October 2026 · Lisbon');
    await expect(article.locator('strong')).toHaveText('bold');
    await expect(article.locator('em')).toHaveText('italic');
    await expect(article).toContainText('Closing words.');
    const img = article.locator('figure img');
    await expect(img).toHaveAttribute('alt', 'A street at dusk');
    await expect(img).toHaveAttribute('srcset', /img-a-480\.jpg 480w, .*img-a-960\.jpg 960w, .*img-a-1600\.jpg 1600w/);
    await expect(article.locator('figcaption')).toHaveText('Evening light');
    await expect(article).toContainText('A. Photographer');
    // Full width: the photo is as wide as the page, wider than the text column.
    const widths = await page.evaluate(() => ({
      page: document.documentElement.clientWidth,
      photo: document.querySelector('figure img')?.getBoundingClientRect().width ?? 0,
      column: document.querySelector('.public-column')?.getBoundingClientRect().width ?? 0,
    }));
    expect(Math.round(widths.photo)).toBe(widths.page);
    expect(widths.column).toBeLessThan(widths.page);
    await expect(page).toHaveTitle('Dusk');
    await expect(page.locator('meta[name="description"]')).toHaveAttribute('content', 'About Dusk');
  });

  test('scrolls to the end of a long piece and fits a phone with no sideways scroll', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    const long = Array.from({ length: 30 }, (_, i) => `Paragraph ${i + 1} ${'words '.repeat(40)}`).join('\n\n') + '\n\n' + BODY('img-a');
    await mockApi(page, { list: [A], pieces: { [ID_A]: detail(A, long) } });
    await page.goto(`/${ID_A}`);
    await expect(page.getByText('Closing words.')).toBeAttached();
    await page.getByText('Closing words.').scrollIntoViewIfNeeded();
    await expect(page.getByText('Closing words.')).toBeInViewport();
    const overflow = await page.evaluate(() => {
      const root = document.querySelector('.public') as HTMLElement;
      return { x: root.scrollWidth - root.clientWidth, scrolled: root.scrollTop };
    });
    expect(overflow.x).toBeLessThanOrEqual(0);
    expect(overflow.scrolled).toBeGreaterThan(0);
  });

  test('shows a normal not-found page for an id that does not exist or is not live (API 404)', async ({ page }) => {
    await mockApi(page, { list: [], pieces: {} });
    await page.goto(`/${ID_B}`);
    await expect(page.getByTestId('not-found')).toHaveText('Page not found');
    await expect(page).toHaveTitle('Page not found');
    await expect(page.getByRole('link', { name: 'Back to the front page' })).toHaveAttribute('href', '/');
  });

  test('shows the not-found page for a path that is not a page id', async ({ page }) => {
    await mockApi(page, { list: [], pieces: {} });
    await page.goto('/no-such-page');
    await expect(page.getByTestId('not-found')).toBeVisible();
  });

  test('changes show straight away: a reload shows what was published, unpublished or republished', async ({ page }) => {
    const state = { list: [A] as unknown[], pieces: { [ID_A]: detail(A, BODY('img-a')) } as Record<string, unknown> };
    await mockApi(page, state);
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 2 })).toHaveText(['Dusk']);

    // Publish a new piece and republish the first with new text.
    state.list = [B, A];
    state.pieces = { [ID_A]: { ...detail(A, BODY('img-a')), title: 'Dusk, revised' }, [ID_B]: detail(B, BODY('img-b')) };
    await page.reload();
    await expect(page.getByRole('heading', { level: 2 })).toHaveText(['Dawn', 'Dusk']);
    await page.goto(`/${ID_A}`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Dusk, revised');

    // Unpublish it.
    state.list = [B];
    state.pieces = { [ID_B]: detail(B, BODY('img-b')) };
    await page.reload();
    await expect(page.getByTestId('not-found')).toBeVisible();
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 2 })).toHaveText(['Dawn']);
  });

  test('renders stored import/export/markup as plain text, evaluating nothing', async ({ page }) => {
    const hostile = [
      'import a from "x"',
      'export const a = 1',
      '&lt;script&gt;window.__pwned = 1&lt;/script&gt;',
      '<script>window.__pwned = 1</script>',
      '<img src=x onerror="window.__pwned = 1">',
      '{window.__pwned = 1}',
      BODY('img-a'),
    ].join('\n\n');
    await mockApi(page, { list: [A], pieces: { [ID_A]: detail(A, hostile) } });
    await page.goto(`/${ID_A}`);
    const article = page.getByTestId('piece');
    await expect(article).toContainText('import a from "x"');
    await expect(article).toContainText('export const a = 1');
    await expect(article).toContainText('<script>window.__pwned = 1</script>');
    await expect(article).toContainText('{window.__pwned = 1}');
    await expect(article).toContainText('<img src=x onerror="window.__pwned = 1">');
    expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
    expect(await article.locator('script, [onerror]').count()).toBe(0);
    expect(await article.locator('img').count()).toBe(1); // the Photo, and no img from stored text
  });
});

test.describe('the wording rule', () => {
  const STORY = /stor(y|ies)/i;

  for (const [name, path] of [
    ['home', '/'],
    ['a piece', `/${ID_A}`],
    ['not found', `/${ID_B}`],
    ['an unknown path', '/nowhere'],
  ] as const) {
    test(`the word "story" is nowhere on ${name}: text, URL, title, metadata, requests`, async ({ page }) => {
      const asked = await mockApi(page, { list: [A, B], pieces: { [ID_A]: detail(A, BODY('img-a')) } });
      await page.goto(path);
      await expect(page.getByTestId('public')).toBeVisible();
      await expect(page.getByTestId('loading')).toHaveCount(0);

      expect(page.url()).not.toMatch(STORY);
      expect(await page.title()).not.toMatch(STORY);
      const visible = await page.evaluate(() => document.body.innerText);
      expect(visible).not.toMatch(STORY);
      const head = await page.evaluate(() => document.head.outerHTML.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<link[^>]*stylesheet[^>]*>/g, ''));
      expect(head).not.toMatch(STORY);
      // Alt text, image URLs and link targets are in attributes, not in innerText.
      const attributes = await page.evaluate(() =>
        [...document.body.querySelectorAll('*')].flatMap((e) => [...e.attributes].map((a) => `${a.name}=${a.value}`)).join('\n'),
      );
      expect(attributes).not.toMatch(STORY);
      // Nor does any URL the browser fetched while rendering (the API paths included).
      expect(asked.filter((u) => STORY.test(new URL(u).pathname + new URL(u).search))).toEqual([]);
    });
  }
});
