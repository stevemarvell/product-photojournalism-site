import { expect, test } from '@playwright/test';

// The API is mocked at the network layer: the built bundle makes a real
// cross-origin fetch to VITE_API_URL's default, and the browser answers it from here.
const API = 'http://localhost:8000/health';

test.describe('the home page and the API', () => {
  test('shows the value fetched from the API', async ({ page }) => {
    await page.route(API, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify({
          ok: true,
          commit: null,
          database: { adapter: 'memory', reachable: true },
        }),
      }),
    );
    await page.goto('/');
    await expect(page.getByTestId('api-status')).toContainText('memory, reachable');
  });

  test('shows a plain error when the API is unreachable', async ({ page }) => {
    await page.route(API, (route) => route.abort('connectionrefused'));
    await page.goto('/');
    await expect(page.getByTestId('api-error')).toHaveText('The API could not be reached.');
  });
});
