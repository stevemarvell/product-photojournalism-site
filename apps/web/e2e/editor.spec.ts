import { expect, test } from '@playwright/test';

// The API is mocked at the network layer (see api.spec.ts): the bundle is built
// with VITE_API_URL=http://api.e2e.invalid, so /auth/me is a cross-origin fetch
// the browser answers from here.
const ME = 'http://api.e2e.invalid/auth/me';
const LOGIN = 'http://api.e2e.invalid/auth/login';
const CORS = { 'access-control-allow-origin': '*' };

test.describe('the editor route', () => {
  test('redirects a signed-out visitor to sign in and shows no editor', async ({ page }) => {
    await page.route(ME, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: CORS,
        body: JSON.stringify({ signedIn: false, user: null }),
      }),
    );
    // Stand-in for Vercel's sign-in: the redirect target answers a plain page.
    await page.route(LOGIN, (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: '<p>sign-in page</p>' }),
    );
    await page.goto('/editor');
    await expect(page).toHaveURL(LOGIN);
    await expect(page.getByTestId('editor-content')).toHaveCount(0);
  });

  test('shows the editor to a signed-in owner', async ({ page }) => {
    await page.route(ME, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: CORS,
        body: JSON.stringify({ signedIn: true, user: { name: 'Owner', isOwner: true } }),
      }),
    );
    await page.goto('/editor');
    await expect(page.getByTestId('editor-content')).toBeVisible();
  });
});
