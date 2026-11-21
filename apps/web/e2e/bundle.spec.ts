import { expect, test } from '@playwright/test';

// The public pages download only the public site's code: no Ionic, no editor chunk. Run
// against the built bundle; the API is not needed (an unreachable one shows the error note).
const ID = '3f2b8c1e-5a4d-4e6f-9b0a-1c2d3e4f5a6b';

for (const path of ['/', `/${ID}`]) {
  test(`${path} loads no Ionic and no editor chunk`, async ({ page }) => {
    const scripts: string[] = [];
    page.on('response', (r) => {
      if (/\.m?js(\?|$)/.test(new URL(r.url()).pathname)) scripts.push(r.url());
    });
    await page.route('**/public/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '[]' }));
    await page.goto(path);
    await page.waitForLoadState('networkidle');
    expect(scripts.length).toBeGreaterThan(0);
    for (const url of scripts) {
      expect(url).not.toMatch(/EditorShell|BodyEditor/);
      const body = await (await page.request.get(url)).text();
      expect(body, url).not.toContain('ion-app');
    }
  });
}

test('/editor loads its chunk on demand and shows Loading… meanwhile', async ({ page }) => {
  await page.route('**/assets/EditorShell*.js', async (route) => {
    await new Promise((r) => setTimeout(r, 1500));
    await route.continue();
  });
  await page.route('**/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ signedIn: true, user: { name: 'Owner', isOwner: true } }) }));
  await page.goto('/editor');
  await expect(page.getByText('Loading…')).toBeVisible();
  await expect(page.getByTestId('editor-content')).toBeVisible();
});
