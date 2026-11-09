import { expect, test, type Page, type Route } from '@playwright/test';

// The API is mocked at the network layer, as in drafting.spec.ts, but it plays the local
// image store's part: an upload target, a PUT to it, registration, and status reads.
const API = 'http://api.e2e.invalid';
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type',
  'access-control-allow-methods': 'GET,POST,PUT,OPTIONS',
};
const LIMIT = 1000;

interface Mock {
  puts: string[];
  registered: string[];
  targetsAsked: number[];
  saves: { content: string }[];
  /** Image states by id, which a test may change while the page is up. */
  images: Record<string, { status: string }>;
}

async function mockApi(page: Page, delays: Record<string, number> = {}): Promise<Mock> {
  const mock: Mock = { puts: [], registered: [], targetsAsked: [], saves: [], images: {} };
  const json = (route: Route, status: number, body: unknown) =>
    route.fulfill({ status, contentType: 'application/json', headers: CORS, body: JSON.stringify(body) });
  let tokens = 0;
  const names = new Map<string, string>(); // upload token -> file name
  let version = 0;
  const detail = () => ({
    id: 's1',
    live: false,
    updated_at: `2026-11-09T10:00:0${version}Z`,
    published: null,
    draft: { title: 'T', description: 'D', location: '', date: null, content: '' },
  });

  await page.route(`${API}/**`, async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    if (path === '/auth/me') return json(route, 200, { signedIn: true, user: { name: 'Owner', isOwner: true } });
    if (path === '/stories/s1') return json(route, 200, detail());
    if (path === '/stories/s1/draft') {
      mock.saves.push({ content: (req.postDataJSON() as { content: string }).content });
      version += 1;
      return json(route, 200, detail());
    }
    if (path === '/images/upload-target') {
      const { size } = req.postDataJSON() as { size: number };
      mock.targetsAsked.push(size);
      if (size > LIMIT) return json(route, 413, { detail: { message: 'too large', limit: LIMIT } });
      const token = `t${++tokens}`;
      return json(route, 200, {
        upload_url: `/images/uploads/${token}`,
        original_url: `local:orig-${token}`,
        method: 'PUT',
        max_bytes: LIMIT,
      });
    }
    if (path.startsWith('/images/uploads/') && req.method() === 'PUT') {
      const token = path.split('/').pop() ?? '';
      names.set(`local:orig-${token}`, token);
      mock.puts.push(token);
      return route.fulfill({ status: 204, headers: CORS });
    }
    if (path === '/images' && req.method() === 'POST') {
      const { original_url } = req.postDataJSON() as { original_url: string };
      const token = names.get(original_url) ?? '';
      // The first file's registration is the slowest, so the uploads finish out of order.
      if (delays[token]) await new Promise((r) => setTimeout(r, delays[token]));
      const id = `img-${token}`;
      mock.registered.push(id);
      mock.images[id] = { status: 'processing' };
      return json(route, 201, { id, status: 'processing', web_versions: [], width: null, height: null, byte_size: 5 });
    }
    const image = /^\/images\/([^/]+)$/.exec(path);
    if (image && req.method() === 'GET') {
      const row = mock.images[image[1] ?? ''];
      if (!row) return json(route, 404, {});
      return json(route, 200, {
        id: image[1],
        ...row,
        web_versions: row.status === 'ready' ? [{ width: 480, url: `/public/images/${image[1]}-480.jpg` }] : [],
        width: 1000,
        height: 600,
        byte_size: 5,
      });
    }
    if (path.startsWith('/public/images/')) {
      // A 1x1 gif, so a ready thumbnail is a real image.
      return route.fulfill({
        status: 200,
        headers: { ...CORS, 'content-type': 'image/gif' },
        body: Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'),
      });
    }
    return json(route, 404, {});
  });
  return mock;
}

const file = (name: string, size = 5) => ({ name, mimeType: 'image/jpeg', buffer: Buffer.alloc(size, 1) });
const ids = (page: Page) => page.getByTestId('photo-image').allTextContents();

test.describe('adding photos', () => {
  test('several files insert one Photo block each, in selection order, however the uploads finish', async ({ page }) => {
    // First file's register call is the slowest; the others finish well before it.
    const mock = await mockApi(page, { t1: 700, t2: 100 });
    await page.goto('/editor/s1');
    await page.getByTestId('photo-button').waitFor();
    await page.getByTestId('photo-input').setInputFiles([file('one.jpg'), file('two.jpg'), file('three.jpg')]);

    await expect(page.getByTestId('photo-block')).toHaveCount(3, { timeout: 15_000 });
    expect(await ids(page)).toEqual(['img-t1', 'img-t2', 'img-t3']);
    // The files themselves went to the upload target (the stand-in for Blob), three PUTs.
    expect(mock.puts.sort()).toEqual(['t1', 't2', 't3']);
    // Registration happened out of order (the slow one last): the blocks still follow the selection.
    expect(mock.registered.at(-1)).toBe('img-t1');
    await expect(page.getByTestId('save-indicator')).toHaveText('Saved');
    const saved = mock.saves.at(-1)?.content ?? '';
    expect(saved.indexOf('img-t1')).toBeLessThan(saved.indexOf('img-t2'));
    expect(saved.indexOf('img-t2')).toBeLessThan(saved.indexOf('img-t3'));
    await expect(page.getByTestId('upload-row')).toHaveCount(3);
    await expect(page.getByTestId('upload-row').first()).toHaveAttribute('data-state', 'done');
  });

  test('a file over the limit is refused before upload, with the limit shown, and the rest still go in', async ({ page }) => {
    const mock = await mockApi(page);
    await page.goto('/editor/s1');
    await page.getByTestId('photo-button').waitFor();
    await page.getByTestId('photo-input').setInputFiles([file('ok.jpg'), file('huge.jpg', LIMIT + 1), file('also.jpg')]);

    await expect(page.getByTestId('photo-block')).toHaveCount(2, { timeout: 15_000 });
    await expect(page.getByRole('alert').filter({ hasText: 'huge.jpg' })).toContainText('the limit is');
    expect(mock.targetsAsked).toEqual([5, LIMIT + 1, 5]);
    // The refused file's bytes never left the browser: only two PUTs.
    expect(mock.puts).toHaveLength(2);
    expect(await ids(page)).toEqual(['img-t1', 'img-t2']);
  });

  test('a photo shows processing, then ready; and an image the API fails shows an error on its block', async ({ page }) => {
    const mock = await mockApi(page);
    await page.goto('/editor/s1');
    await page.getByTestId('photo-button').waitFor();
    await page.getByTestId('photo-input').setInputFiles([file('a.jpg'), file('b.jpg')]);
    await expect(page.getByTestId('photo-block')).toHaveCount(2, { timeout: 15_000 });
    await expect(page.getByTestId('photo-status')).toHaveCount(2);
    // The preview is greyed out, with the reason, while they process.
    await expect(page.getByTestId('preview-button')).toBeDisabled();
    await expect(page.getByTestId('preview-reason')).toContainText('photos are still processing');

    mock.images['img-t1'] = { status: 'ready' };
    mock.images['img-t2'] = { status: 'failed' }; // what a timeout does
    await expect(page.getByTestId('photo-thumb')).toHaveCount(1, { timeout: 10_000 });
    await expect(page.getByTestId('photo-error')).toHaveCount(1);
    await expect(page.getByTestId('photo-error')).toContainText('could not be processed');
    await expect(page.getByTestId('preview-reason')).toContainText('failed to process');
    await expect(page.getByTestId('preview-button')).toBeDisabled();
  });

  test('the preview opens once every photo is ready', async ({ page }) => {
    const mock = await mockApi(page);
    await page.goto('/editor/s1');
    await page.getByTestId('photo-button').waitFor();
    await page.getByTestId('photo-input').setInputFiles([file('a.jpg')]);
    await expect(page.getByTestId('photo-block')).toHaveCount(1, { timeout: 15_000 });
    await expect(page.getByTestId('preview-button')).toBeDisabled();
    mock.images['img-t1'] = { status: 'ready' };
    await expect(page.getByTestId('preview-button')).toBeEnabled({ timeout: 10_000 });
    await page.getByTestId('preview-button').click();
    await expect(page.getByTestId('preview-photo')).toHaveCount(1);
  });
});
