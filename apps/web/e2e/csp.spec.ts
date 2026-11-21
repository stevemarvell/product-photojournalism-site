import { expect, test, type Page } from '@playwright/test';

// The built bundle is served by `vite preview` with the deployment's security
// headers (security-headers.mjs). A blocked load is a console error naming the
// policy; none may appear on the pages that matter.
const API = 'http://api.e2e.invalid';
const CORS = { 'access-control-allow-origin': '*' };
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64');
const ID = '3f2b8c1e-5a4d-4e6f-9b0a-1c2d3e4f5a6b';
const versions = [480, 960, 1600].map((width) => ({ width, url: `/public/images/img-a-${width}.jpg` }));
const hero = { image_id: 'img-a', alt: 'hero', width: 1600, height: 1000, versions };
const summary = { id: ID, title: 'Dusk', description: 'About Dusk', location: 'Lisbon', date: '2026-10-31', first_published_at: '2026-11-01T10:00:00Z', hero };
const json = (body: unknown) => ({ status: 200, contentType: 'application/json', headers: CORS, body: JSON.stringify(body) });

async function mock(page: Page) {
  await page.route(`${API}/public/images/*`, (r) => r.fulfill({ status: 200, contentType: 'image/png', headers: CORS, body: PNG }));
  await page.route(`${API}/public/pieces`, (r) => r.fulfill(json([summary])));
  await page.route(`${API}/public/pieces/*`, (r) =>
    r.fulfill(
      json({
        ...summary,
        content: 'Hello **world**.\n\n<Photo image="img-a" alt="hero" />',
        photos: { 'img-a': { width: 1600, height: 1000, versions } },
      }),
    ),
  );
  await page.route(`${API}/auth/me`, (r) => r.fulfill(json({ signedIn: true, user: { name: 'Owner', isOwner: true } })));
  await page.route(`${API}/stories`, (r) => r.fulfill(json([])));
}

test.describe('security headers', () => {
  test('every page response carries the five headers', async ({ request }) => {
    for (const path of ['/', '/editor']) {
      const h = (await request.get(path)).headers();
      expect(h['content-security-policy']).toContain("default-src 'self'");
      expect(h['x-frame-options']).toBe('DENY');
      expect(h['x-content-type-options']).toBe('nosniff');
      expect(h['referrer-policy']).toBe('strict-origin-when-cross-origin');
      expect(h['permissions-policy']).toBe('camera=(), microphone=(), geolocation=()');
    }
  });

  test('home, a piece page and the editor load with no CSP violation', async ({ page }) => {
    await mock(page);
    const messages: string[] = [];
    page.on('console', (m) => messages.push(m.text()));
    page.on('pageerror', (e) => messages.push(e.message));
    await page.goto('/');
    await expect(page.getByText('Dusk').first()).toBeVisible();
    await page.goto(`/${ID}`);
    await expect(page.getByText('Hello').first()).toBeVisible();
    await page.goto('/editor');
    await expect(page.getByTestId('editor-content')).toBeVisible();
    await page.waitForLoadState('networkidle');
    expect(messages.filter((m) => /content security policy|violates/i.test(m))).toEqual([]);
  });

  test('the policy does block what it should: an injected inline script does not run', async ({ page }) => {
    await mock(page);
    const messages: string[] = [];
    page.on('console', (m) => messages.push(m.text()));
    await page.goto('/');
    const ran = await page.evaluate(() => {
      const s = document.createElement('script');
      s.textContent = 'window.__ran = true';
      document.head.appendChild(s);
      return (window as unknown as { __ran?: boolean }).__ran === true;
    });
    expect(ran).toBe(false);
    expect(messages.some((m) => /content security policy/i.test(m))).toBe(true);
  });
});
