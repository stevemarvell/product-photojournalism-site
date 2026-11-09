import { expect, test, type Page, type Route } from '@playwright/test';

// Issue #17 against the built bundle, the API mocked at the network layer with a small
// stateful story, so the buttons are checked against what the "server" really did.
const API = 'http://api.e2e.invalid';
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type',
  'access-control-allow-methods': 'GET,POST,PUT,OPTIONS',
};
const PHOTO = '<Photo image="img-1" alt="A harbour" caption="" credit="" />';
const text = (title: string) => ({ title, description: 'D', location: '', date: null, content: PHOTO });

interface Mock {
  calls: string[]; // "PUT draft", "POST revert", ... in arrival order
  releaseSave: () => void;
}

async function mockApi(page: Page, o: { live: boolean; draftTitle: string; holdSaves?: boolean }): Promise<Mock> {
  let version = 0;
  const state = { live: o.live, published: text('Published title'), draft: text(o.draftTitle) };
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const mock: Mock = { calls: [], releaseSave: () => release() };
  const detail = () => ({
    id: 's1',
    live: state.live,
    updated_at: `2026-11-09T10:00:0${version}Z`,
    published: state.published,
    draft: state.draft,
  });
  const json = (route: Route, status: number, body: unknown) =>
    route.fulfill({ status, contentType: 'application/json', headers: CORS, body: JSON.stringify(body) });

  await page.route(`${API}/**`, async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    if (path === '/auth/me') return json(route, 200, { signedIn: true, user: { name: 'Owner', isOwner: true } });
    if (path.startsWith('/images/')) return json(route, 200, { id: 'img-1', status: 'ready', web_versions: [], width: 1, height: 1, byte_size: 1 });
    if (path === '/stories/s1') return json(route, 200, detail());
    if (path === '/stories/s1/draft') {
      mock.calls.push('PUT draft');
      const sent = req.postDataJSON() as typeof state.draft;
      if (o.holdSaves) await gate;
      state.draft = { title: sent.title, description: sent.description, location: sent.location, date: sent.date, content: sent.content };
      version += 1;
      return json(route, 200, detail());
    }
    const action = /^\/stories\/s1\/(publish|unpublish|republish|revert)$/.exec(path)?.[1];
    if (action) {
      mock.calls.push(`POST ${action}`);
      if (action === 'publish') {
        state.published = state.draft;
        state.live = true;
      }
      if (action === 'unpublish') state.live = false;
      if (action === 'republish') state.live = true;
      if (action === 'revert') state.draft = state.published;
      version += 1;
      return json(route, 200, detail());
    }
    return json(route, 404, {});
  });
  return mock;
}

test.describe('lifecycle actions', () => {
  test('buttons follow the table: live shows Unpublish; not live shows Republish; Revert needs a differing draft', async ({ page }) => {
    const mock = await mockApi(page, { live: true, draftTitle: 'Published title' });
    await page.goto('/editor/s1');
    await expect(page.getByTestId('unpublish')).toBeVisible();
    await expect(page.getByTestId('republish')).toHaveCount(0);
    await expect(page.getByTestId('revert')).toBeDisabled();
    await expect(page.getByTestId('update-live-note')).toHaveCount(0);

    await page.getByTestId('field-title').fill('Newer draft');
    await expect(page.getByTestId('revert')).toBeEnabled();
    await expect(page.getByTestId('update-live-note')).toHaveText('Publish will update the live version.');
    await expect(page.getByTestId('save-indicator')).toHaveText('Saved');

    await page.getByTestId('unpublish').click();
    await expect(page.getByTestId('republish')).toBeVisible();
    await expect(page.getByTestId('unpublish')).toHaveCount(0);
    await expect(page.getByTestId('update-live-note')).toHaveCount(0);
    await page.getByTestId('republish').click();
    await expect(page.getByTestId('unpublish')).toBeVisible();
    expect(mock.calls.filter((c) => c !== 'PUT draft')).toEqual(['POST unpublish', 'POST republish']);
  });

  test('Publish over published text asks first: cancel publishes nothing, accept publishes', async ({ page }) => {
    const mock = await mockApi(page, { live: true, draftTitle: 'Newer draft' });
    await page.goto('/editor/s1');
    await page.getByTestId('publish').click();
    await expect(page.getByTestId('confirm')).toContainText('replace the live text');
    await page.getByTestId('confirm-cancel').click();
    await expect(page.getByTestId('confirm')).toHaveCount(0);
    await page.waitForTimeout(300);
    expect(mock.calls).toEqual([]);

    await page.getByTestId('publish').click();
    await page.getByTestId('confirm-ok').click();
    await expect(page.getByTestId('publish-message')).toContainText('Published');
    expect(mock.calls).toContain('POST publish');
    await expect(page.getByTestId('revert')).toBeDisabled(); // draft now matches the published text
  });

  test('Revert always asks: cancel changes nothing, accept copies the published text over the draft', async ({ page }) => {
    const mock = await mockApi(page, { live: true, draftTitle: 'Newer draft' });
    await page.goto('/editor/s1');
    await page.getByTestId('revert').click();
    await expect(page.getByTestId('confirm')).toBeVisible();
    await page.getByTestId('confirm-cancel').click();
    await page.waitForTimeout(300);
    expect(mock.calls).toEqual([]);
    await expect(page.getByTestId('field-title')).toHaveValue('Newer draft');

    await page.getByTestId('revert').click();
    await page.getByTestId('confirm-ok').click();
    await expect(page.getByTestId('field-title')).toHaveValue('Published title');
    expect(mock.calls).toEqual(['POST revert']);
    await expect(page.getByTestId('revert')).toBeDisabled();

    // The editor adopted the reverted version: the next save is not a stale one.
    await page.getByTestId('field-title').fill('Edited again');
    await expect(page.getByTestId('save-indicator')).toHaveText('Saved');
    expect(mock.calls).toEqual(['POST revert', 'PUT draft']);
  });

  test('Revert with an autosave pending waits for the one in flight and cancels the rest', async ({ page }) => {
    const mock = await mockApi(page, { live: true, draftTitle: 'Published title', holdSaves: true });
    await page.goto('/editor/s1');
    await page.getByTestId('field-title').fill('First edit');
    await expect.poll(() => mock.calls).toEqual(['PUT draft']); // in flight, held by the "server"
    await page.getByTestId('field-title').fill('Second edit'); // pending behind it

    await page.getByTestId('revert').click();
    await page.getByTestId('confirm-ok').click();
    await page.waitForTimeout(1500); // past the autosave pause
    expect(mock.calls).toEqual(['PUT draft']); // no revert yet, and the pending save was dropped

    mock.releaseSave();
    await expect(page.getByTestId('field-title')).toHaveValue('Published title');
    expect(mock.calls).toEqual(['PUT draft', 'POST revert']);
    await page.waitForTimeout(1200);
    expect(mock.calls).toEqual(['PUT draft', 'POST revert']);
  });
});
