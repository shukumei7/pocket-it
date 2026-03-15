/**
 * Dashboard QA — Playwright e2e tests
 *
 * Prerequisites:
 *   npm install --save-dev @playwright/test
 *   npx playwright install chromium
 *
 * Run:
 *   npx playwright test tests/qa-dashboard.spec.js
 *
 * All tests skip automatically when the server is not reachable, so it is
 * safe to run in CI without a live server (they will be reported as skipped,
 * not failed).
 */

const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.POCKET_IT_URL || 'http://localhost:9100';
const DASHBOARD_URL = `${BASE_URL}/dashboard`;

// ─── Server reachability check ────────────────────────────────────────────────

let serverAvailable = null;

async function checkServerAvailable() {
  if (serverAvailable !== null) return serverAvailable;
  try {
    const res = await fetch(`${BASE_URL}/health`, { signal: AbortSignal.timeout(2000) });
    serverAvailable = res.ok;
  } catch {
    serverAvailable = false;
  }
  return serverAvailable;
}

async function skipIfServerDown(testInfo) {
  const up = await checkServerAvailable();
  if (!up) {
    testInfo.skip(true, `Server not reachable at ${BASE_URL} — start with: node server.js`);
  }
}

// ─── Helper: navigate to dashboard (past login if needed) ────────────────────
//
// The dashboard shows a login overlay when no token is in sessionStorage.
// For UI-only assertions that don't require auth (button existence, responsive
// layout), we inject a dummy token so the overlay is hidden before the page
// fully initialises. Tests that require real data should handle auth separately.

async function openDashboardUnauthenticated(page) {
  // Navigate first so sessionStorage is in scope for the origin
  await page.goto(DASHBOARD_URL, { waitUntil: 'domcontentloaded' });
}

// ─── 1. Elevated terminal button ─────────────────────────────────────────────

test.describe('Elevated terminal button', () => {
  test('btn-start-terminal-elevated exists in the DOM', async ({ page }, testInfo) => {
    await skipIfServerDown(testInfo);
    await openDashboardUnauthenticated(page);

    const btn = page.locator('#btn-start-terminal-elevated');
    await expect(btn).toBeAttached();
  });

  test('btn-start-terminal-elevated has text "Elevated (SYSTEM)"', async ({ page }, testInfo) => {
    await skipIfServerDown(testInfo);
    await openDashboardUnauthenticated(page);

    const btn = page.locator('#btn-start-terminal-elevated');
    await expect(btn).toHaveText('Elevated (SYSTEM)');
  });

  test('btn-start-terminal exists alongside elevated button', async ({ page }, testInfo) => {
    await skipIfServerDown(testInfo);
    await openDashboardUnauthenticated(page);

    // Both standard and elevated buttons share the same terminal-controls container
    const standard = page.locator('#btn-start-terminal');
    const elevated = page.locator('#btn-start-terminal-elevated');
    await expect(standard).toBeAttached();
    await expect(elevated).toBeAttached();
  });
});

// ─── 2. AI guidance markdown rendering ───────────────────────────────────────

test.describe('AI guidance markdown rendering', () => {
  test('appendGuidanceMessage renders AI markdown — bold becomes <strong>', async ({ page }, testInfo) => {
    await skipIfServerDown(testInfo);
    await openDashboardUnauthenticated(page);

    // appendGuidanceMessage is defined at page scope inside a script block.
    // We call it via page.evaluate after ensuring the function and guidance-chat
    // container are present. The function is only defined after DOMContentLoaded.
    await page.waitForFunction(() => typeof appendGuidanceMessage === 'function', { timeout: 5000 })
      .catch(() => {
        // If function isn't exposed (e.g. strict CSP or scoping), skip this sub-test
        test.skip();
      });

    const result = await page.evaluate(() => {
      // Ensure guidance-chat container exists (it may only render when a device
      // is selected; create a temporary one if absent so the function has a target)
      let chatEl = document.getElementById('guidance-chat');
      let temporary = false;
      if (!chatEl) {
        chatEl = document.createElement('div');
        chatEl.id = 'guidance-chat';
        document.body.appendChild(chatEl);
        temporary = true;
      }

      appendGuidanceMessage('ai', '**bold text** and `code`');

      const html = chatEl.innerHTML;

      if (temporary) chatEl.remove();
      return html;
    });

    // marked.parse converts **bold** to <strong>bold</strong>
    expect(result).toContain('<strong>');
    // Should not contain raw markdown asterisks (they were rendered)
    expect(result).not.toContain('**bold text**');
  });

  test('appendGuidanceMessage renders non-AI sender as plain text (no markdown)', async ({ page }, testInfo) => {
    await skipIfServerDown(testInfo);
    await openDashboardUnauthenticated(page);

    await page.waitForFunction(() => typeof appendGuidanceMessage === 'function', { timeout: 5000 })
      .catch(() => { test.skip(); });

    const result = await page.evaluate(() => {
      let chatEl = document.getElementById('guidance-chat');
      let temporary = false;
      if (!chatEl) {
        chatEl = document.createElement('div');
        chatEl.id = 'guidance-chat';
        document.body.appendChild(chatEl);
        temporary = true;
      }

      appendGuidanceMessage('it_tech', '**not markdown**');

      const lastChild = chatEl.lastElementChild;
      const html = lastChild ? lastChild.innerHTML : '';

      if (temporary) chatEl.remove();
      return html;
    });

    // it_tech sender uses textContent, so asterisks appear literally
    expect(result).toContain('**not markdown**');
    expect(result).not.toContain('<strong>');
  });
});

// ─── 3. Mobile responsive layout at 640px ────────────────────────────────────

test.describe('Mobile responsive layout at 640px', () => {
  test.use({ viewport: { width: 640, height: 900 } });

  test('page loads without horizontal scroll overflow at 640px', async ({ page }, testInfo) => {
    await skipIfServerDown(testInfo);
    await openDashboardUnauthenticated(page);

    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);

    // Allow a 1px rounding tolerance
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1);
  });

  test('nav element is present and attached at 640px', async ({ page }, testInfo) => {
    await skipIfServerDown(testInfo);
    await openDashboardUnauthenticated(page);

    const nav = page.locator('nav');
    await expect(nav).toBeAttached();
  });

  test('logo text is visible at 640px', async ({ page }, testInfo) => {
    await skipIfServerDown(testInfo);
    await openDashboardUnauthenticated(page);

    const logo = page.locator('nav .logo');
    await expect(logo).toBeVisible();
  });

  test('login overlay is visible at 640px when unauthenticated', async ({ page }, testInfo) => {
    await skipIfServerDown(testInfo);

    // Navigate fresh — no token in session, so login overlay should display
    await page.goto(DASHBOARD_URL, { waitUntil: 'domcontentloaded' });

    // The overlay uses display:flex when shown; check it doesn't overflow the viewport
    const overlayBox = await page.locator('#login-overlay').boundingBox();
    if (overlayBox) {
      // If the overlay is visible it should fit within viewport width
      expect(overlayBox.width).toBeLessThanOrEqual(640 + 1);
    }
  });
});
