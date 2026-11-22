import { expect, test } from '@playwright/test';
import { clickOnPage, downloadSigned, drawSignature, expectBoxMatches, expectInkInside, gotoApp, openAndWait, placements, renderExported, typeSignature, uploadSignature } from './helpers';

test('works offline after load, sends nothing, stores nothing', async ({ page, context, browser, baseURL }) => {
  const requests: { url: string; method: string; body: string | null; afterOffline: boolean }[] = [];
  let offline = false;
  page.on('request', (r) => requests.push({ url: r.url(), method: r.method(), body: r.postData(), afterOffline: offline }));

  await gotoApp(page);
  await page.waitForLoadState('networkidle');
  // CSP is present in the production build and forbids talking to other origins.
  const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
  expect(csp).toContain("connect-src 'self'");
  expect(csp).toContain("default-src 'self'");

  offline = true;
  await context.setOffline(true);

  await openAndWait(page, 'mixed-sizes.pdf');
  await typeSignature(page, 'Offline Person', 'Blue'); // bundled font, preloaded
  await drawSignature(page, 'Blue');
  await uploadSignature(page);
  const placed = await placements(page);
  expect(placed).toHaveLength(3);
  const { bytes } = await downloadSigned(page);

  // Nothing persisted anywhere.
  const storage = await page.evaluate(async () => ({
    local: localStorage.length,
    session: sessionStorage.length,
    cookie: document.cookie,
    idb: 'databases' in indexedDB ? (await indexedDB.databases()).length : 0,
    caches: 'caches' in window ? (await caches.keys()).length : 0,
    sw: 'serviceWorker' in navigator ? (await navigator.serviceWorker.getRegistrations()).length : 0,
  }));
  expect(storage).toEqual({ local: 0, session: 0, cookie: '', idb: 0, caches: 0, sw: 0 });
  const state = await context.storageState();
  expect(state.cookies).toEqual([]);
  expect(state.origins).toEqual([]);

  // Every request was a plain GET for a static file under the project subpath; no bodies.
  for (const r of requests) {
    if (r.url.startsWith('blob:') || r.url.startsWith('data:')) continue;
    expect(r.url.startsWith(baseURL!), `unexpected request ${r.url}`).toBe(true);
    expect(r.method).toBe('GET');
    expect(r.body).toBeNull();
  }

  await context.setOffline(false);
  const pages = await renderExported(browser, bytes);
  // three signatures on page 1: typed (blue), drawn (blue), image (red)
  expect(pages[0].blueCount).toBeGreaterThan(50);
  expectBoxMatches(pages[0].red, placed[2]);
  expectInkInside(pages[0].blue, {
    x: Math.min(placed[0].x, placed[1].x),
    y: Math.min(placed[0].y, placed[1].y),
    width: Math.max(placed[0].x + placed[0].width, placed[1].x + placed[1].width) - Math.min(placed[0].x, placed[1].x),
    height: Math.max(placed[0].y + placed[0].height, placed[1].y + placed[1].height) - Math.min(placed[0].y, placed[1].y),
  });
});

test('filling a form offline: nothing sent, stored, or logged', async ({ page, context, browser, baseURL }) => {
  const SECRET = { name: 'Zelda Q. Privatename', ssn: ['987', '65', '4321'], note: 'Private note 42' };
  const requests: string[] = [];
  const logs: string[] = [];
  page.on('console', (m) => logs.push(m.text()));
  page.on('pageerror', (e) => logs.push(e.message));
  await gotoApp(page);
  await page.waitForLoadState('networkidle');
  await context.setOffline(true);
  page.on('request', (r) => requests.push(`${r.method()} ${r.url()} ${r.postData() ?? ''}`));

  await openAndWait(page, 'fw9.pdf');
  const f = (n: string) => page.locator(`.pdf-field[data-field="topmostSubform[0].Page1[0].${n}[0]"]`);
  await f('f1_01').fill(SECRET.name);
  await f('f1_11').fill(SECRET.ssn[0]);
  await f('f1_12').fill(SECRET.ssn[1]);
  await f('f1_13').fill(SECRET.ssn[2]);
  await page.locator('#tool-text').click();
  await clickOnPage(page, 0, 300, 700);
  await page.keyboard.type(SECRET.note);
  await page.keyboard.press('Enter');
  await typeSignature(page, SECRET.name, 'Blue');
  const { bytes } = await downloadSigned(page);

  // No request carried anything; every request stayed on the site.
  for (const r of requests) {
    if (r.includes(' blob:') || r.includes(' data:')) continue;
    expect(r.startsWith(`GET ${baseURL}`), r).toBe(true);
    for (const v of [SECRET.name, SECRET.note, ...SECRET.ssn]) expect(r).not.toContain(v);
  }
  // Nothing logged that contains what was typed.
  for (const l of logs) for (const v of [SECRET.name, SECRET.note, SECRET.ssn.join('')]) expect(l).not.toContain(v);
  // Nothing stored.
  const stored = await page.evaluate(async () => ({
    local: localStorage.length,
    session: sessionStorage.length,
    cookie: document.cookie,
    idb: 'databases' in indexedDB ? (await indexedDB.databases()).length : 0,
    caches: 'caches' in window ? (await caches.keys()).length : 0,
  }));
  expect(stored).toEqual({ local: 0, session: 0, cookie: '', idb: 0, caches: 0 });

  await context.setOffline(false);
  const pages = await renderExported(browser, bytes);
  expect(pages[0].fields['topmostSubform[0].Page1[0].f1_01[0]']).toBe(SECRET.name);
  expect(pages[0].texts.some((t) => t.str === SECRET.note)).toBe(true);
});
