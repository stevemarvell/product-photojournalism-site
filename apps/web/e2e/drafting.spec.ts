import { expect, test, type Page, type Route } from '@playwright/test';

// The API is mocked at the network layer; the bundle is built with
// VITE_API_URL=http://api.e2e.invalid, so every call is cross-origin and the
// browser sends a preflight for the JSON PUT, which the mock answers too.
const API = 'http://api.e2e.invalid';
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type',
  'access-control-allow-methods': 'GET,POST,PUT,OPTIONS',
};

const photo = (image: string, alt = `alt ${image}`) =>
  `<Photo image="${image}" alt="${alt}" caption="" credit="" />`;

interface Mock {
  saves: { body: Record<string, unknown> }[];
  publishes: number;
}

interface Options {
  content?: string;
  title?: string;
  description?: string;
  saveStatus?: number;
  saveDelayMs?: number;
  publish?: { status: number; body: unknown };
}

async function mockApi(page: Page, o: Options = {}): Promise<Mock> {
  const mock: Mock = { saves: [], publishes: 0 };
  let version = 0;
  const detail = () => ({
    id: 's1',
    live: false,
    updated_at: `2026-11-09T10:00:0${version}Z`,
    published: null,
    draft: {
      title: o.title ?? '',
      description: o.description ?? '',
      location: '',
      date: null,
      content: o.content ?? '',
    },
  });
  const json = (route: Route, status: number, body: unknown) =>
    route.fulfill({ status, contentType: 'application/json', headers: CORS, body: JSON.stringify(body) });

  await page.route(`${API}/**`, async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    if (path === '/auth/me') return json(route, 200, { signedIn: true, user: { name: 'Owner', isOwner: true } });
    if (path === '/stories' && req.method() === 'GET')
      return json(route, 200, [
        { id: 'n1', live: false, title: '', description: '', first_published_at: null },
        { id: 'l1', live: true, title: 'Harbour', description: 'd', first_published_at: '2026-11-01T00:00:00Z' },
      ]);
    if (path === '/stories' && req.method() === 'POST') return json(route, 201, { ...detail(), id: 'created1' });
    if (path === '/stories/s1' || path === '/stories/created1') return json(route, 200, detail());
    if (path === '/stories/s1/draft') {
      mock.saves.push({ body: req.postDataJSON() as Record<string, unknown> });
      if (o.saveDelayMs) await new Promise((r) => setTimeout(r, o.saveDelayMs));
      if (o.saveStatus && o.saveStatus !== 200) return json(route, o.saveStatus, { detail: 'changed' });
      version += 1;
      return json(route, 200, detail());
    }
    if (path === '/stories/s1/publish') {
      mock.publishes += 1;
      const p = o.publish ?? { status: 200, body: { ...detail(), live: true } };
      return json(route, p.status, p.body);
    }
    return json(route, 404, {});
  });
  return mock;
}

const body = (page: Page) => page.getByTestId('body-editor');

test.describe('the owner story list', () => {
  test('lists every story with its live flag, filters by live, and opens a new story', async ({ page }) => {
    await mockApi(page);
    await page.goto('/editor');
    await expect(page.getByTestId('story-row')).toHaveText(['Untitled Not live', 'Harbour Live']);
    await page.getByTestId('filter-live').check();
    await expect(page.getByTestId('story-row')).toHaveText(['Harbour Live']);
    await page.getByTestId('new-story').click();
    await expect(page).toHaveURL(/\/editor\/created1$/);
    await expect(page.getByTestId('drafting')).toBeVisible();
  });
});

test.describe('the drafting screen', () => {
  test('the toolbar offers bold, italic and photo only, and pasted markdown is flattened', async ({ page }) => {
    const mock = await mockApi(page);
    await page.goto('/editor/s1');
    const toolbar = body(page).getByRole('toolbar');
    await expect(toolbar).toBeVisible();
    const labels = (await toolbar.locator('button').evaluateAll((els) =>
      els.map((e) => (e.getAttribute('title') ?? e.getAttribute('aria-label') ?? e.textContent ?? '').toLowerCase()),
    ));
    for (const banned of ['link', 'heading', 'list', 'quote', 'block type', 'underline', 'table', 'image']) {
      expect(labels.filter((l) => l.includes(banned)), banned).toEqual([]);
    }
    expect(labels.some((l) => l.includes('bold'))).toBe(true);
    expect(labels.some((l) => l.includes('italic'))).toBe(true);

    const editable = body(page).locator('[contenteditable="true"]').first();
    await editable.click();
    await editable.evaluate((el) => {
      const data = new DataTransfer();
      data.setData('text/plain', '# Big heading\n\n- item one\n\n> a quote\n\n[a link](http://example.test)');
      data.setData('text/html', '<h1>Big heading</h1><ul><li>item one</li></ul><blockquote>a quote</blockquote><a href="http://example.test">a link</a>');
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    });
    await expect(editable).toContainText('item one');
    await expect(editable.locator('h1,h2,h3,ul,ol,li,blockquote,a')).toHaveCount(0);
    // And what is saved is flat too.
    await expect(page.getByTestId('save-indicator')).toHaveText('Saved');
    const saved = String(mock.saves.at(-1)?.body['content']);
    expect(saved).toContain('item one');
    expect(saved).not.toMatch(/^\s*(#|-|>|\d+\.)/m);
    expect(saved).not.toContain('](');
  });

  test('typing autosaves after a pause: saving, then saved, sending the updated_at last seen', async ({ page }) => {
    const mock = await mockApi(page, { saveDelayMs: 400 });
    await page.goto('/editor/s1');
    await page.getByTestId('field-title').fill('Harbour at dawn');
    await expect(page.getByTestId('save-indicator')).toHaveText('Saving…');
    await expect(page.getByTestId('save-indicator')).toHaveText('Saved');
    expect(mock.saves).toHaveLength(1);
    expect(mock.saves[0]?.body).toMatchObject({ title: 'Harbour at dawn', updated_at: '2026-11-09T10:00:00Z' });
    await page.getByTestId('field-location').fill('Falmouth');
    await expect(page.getByTestId('save-indicator')).toHaveText('Saved');
    expect(mock.saves[1]?.body).toMatchObject({ location: 'Falmouth', updated_at: '2026-11-09T10:00:01Z' });
  });

  test('typing in the body saves the content, with bold kept', async ({ page }) => {
    const mock = await mockApi(page);
    await page.goto('/editor/s1');
    const editable = body(page).locator('[contenteditable="true"]').first();
    await editable.click();
    await page.keyboard.press('Control+b');
    await page.keyboard.type('strong');
    await page.keyboard.press('Control+b');
    await page.keyboard.type(' plain');
    await expect(page.getByTestId('save-indicator')).toHaveText('Saved');
    expect(String(mock.saves.at(-1)?.body['content'])).toContain('**strong** plain');
  });

  test('a conflict stops autosaving and says it changed elsewhere', async ({ page }) => {
    const mock = await mockApi(page, { saveStatus: 409 });
    await page.goto('/editor/s1');
    await page.getByTestId('field-title').fill('one');
    await expect(page.getByTestId('conflict')).toHaveText('Changed elsewhere, reload');
    await page.getByTestId('field-title').fill('two');
    await page.waitForTimeout(1500);
    expect(mock.saves).toHaveLength(1);
    await expect(page.getByTestId('publish')).toBeDisabled();
  });

  test('photo blocks move up and down; the first has no up and the last no down', async ({ page }) => {
    const mock = await mockApi(page, {
      content: `Intro\n\n${photo('a')}\n\n${photo('b')}\n\n${photo('c')}`,
    });
    await page.goto('/editor/s1');
    const blocks = page.getByTestId('photo-block');
    await expect(blocks).toHaveCount(3);
    const ids = () => page.getByTestId('photo-image').allTextContents();
    expect(await ids()).toEqual(['a', 'b', 'c']);
    await expect(blocks.nth(0).getByTestId('photo-up')).toHaveCount(0);
    await expect(blocks.nth(0).getByTestId('photo-down')).toHaveCount(1);
    await expect(blocks.nth(2).getByTestId('photo-down')).toHaveCount(0);
    await expect(blocks.nth(2).getByTestId('photo-up')).toHaveCount(1);

    await blocks.nth(2).getByTestId('photo-up').click();
    await expect.poll(ids).toEqual(['a', 'c', 'b']);
    await expect(blocks.nth(2).getByTestId('photo-down')).toHaveCount(0);
    await blocks.nth(0).getByTestId('photo-down').click();
    await expect.poll(ids).toEqual(['c', 'a', 'b']);
    await expect(blocks.nth(0).getByTestId('photo-up')).toHaveCount(0);

    await expect(page.getByTestId('save-indicator')).toHaveText('Saved');
    const saved = String(mock.saves.at(-1)?.body['content']);
    expect(saved.indexOf('image="c"')).toBeLessThan(saved.indexOf('image="a"'));
    expect(saved.indexOf('image="a"')).toBeLessThan(saved.indexOf('image="b"'));
    expect(saved).toContain('Intro');
  });

  test('the photo button inserts a block; alt, caption and credit are edited in place', async ({ page }) => {
    const mock = await mockApi(page);
    await page.goto('/editor/s1');
    await page.getByTestId('photo-button').click();
    await page.getByPlaceholder('Image id').fill('img-42');
    await page.getByRole('button', { name: 'Insert photo' }).last().click();
    await expect(page.getByTestId('photo-block')).toHaveCount(1);
    await page.getByTestId('photo-alt').fill('A "boat" & more');
    await page.getByTestId('photo-caption').fill('Moored');
    await page.getByTestId('photo-credit').fill('S. Marvell');
    await expect(page.getByTestId('save-indicator')).toHaveText('Saved');
    expect(String(mock.saves.at(-1)?.body['content'])).toContain(
      '<Photo image="img-42" alt="A &quot;boat&quot; &amp; more" caption="Moored" credit="S. Marvell" />',
    );
  });

  test('source view shows the Photo tag as written and returns to the same blocks', async ({ page }) => {
    const tag = '<Photo image="a" alt="A boat" caption="Moored" credit="S. Marvell" />';
    await mockApi(page, { content: `Intro **bold**\n\n${tag}` });
    await page.goto('/editor/s1');
    await expect(page.getByTestId('photo-block')).toHaveCount(1);
    await page.getByTestId('source-toggle').click();
    await expect(body(page).locator('.cm-content')).toContainText(tag);
    await page.getByTestId('source-toggle').click();
    await expect(page.getByTestId('photo-alt')).toHaveValue('A boat');
    await expect(page.getByTestId('photo-caption')).toHaveValue('Moored');
    await expect(page.getByTestId('photo-credit')).toHaveValue('S. Marvell');
  });

  test('publish is disabled with a reason until the draft passes, then calls the API', async ({ page }) => {
    const mock = await mockApi(page, { title: 'T', description: '', content: photo('a', '') });
    await page.goto('/editor/s1');
    await expect(page.getByTestId('publish')).toBeDisabled();
    await expect(page.getByTestId('publish-reason')).toContainText('add a description');
    await expect(page.getByTestId('publish-reason')).toContainText('add alt text to photo 1');
    await page.getByTestId('field-description').fill('Dawn');
    await page.getByTestId('photo-alt').fill('A boat');
    await expect(page.getByTestId('publish')).toBeEnabled();
    await page.getByTestId('publish').click();
    await expect(page.getByTestId('publish-message')).toContainText('Published');
    expect(mock.publishes).toBe(1);
    expect(mock.saves.length).toBeGreaterThan(0); // the draft was saved before publishing
  });

  test('a 422 on publish shows the server reasons', async ({ page }) => {
    await mockApi(page, {
      title: 'T',
      description: 'D',
      content: photo('a'),
      publish: { status: 422, body: { detail: { message: 'publish refused', reasons: ['Photo 1: image a is not ready'] } } },
    });
    await page.goto('/editor/s1');
    await page.getByTestId('publish').click();
    await expect(page.getByTestId('publish-message')).toContainText('image a is not ready');
  });
});
