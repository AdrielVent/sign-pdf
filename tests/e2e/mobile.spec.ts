import { expect, test, type CDPSession, type Page } from '@playwright/test';
import { FLAT_FORM } from '../fixtures/fixtures';
import { downloadSigned, expectInkInside, gotoApp, openAndWait, openFixture, pagePoint, placements, renderExported } from './helpers';

// Real touch input via the Chrome DevTools Protocol, so touch-action and
// native scrolling behave exactly as on a phone.
async function touchDrag(cdp: CDPSession, points: [number, number][]) {
  const [x0, y0] = points[0];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y: y0 }] });
  for (const [x, y] of points.slice(1)) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

const scrollState = (page: Page) =>
  page.evaluate(() => ({
    win: window.scrollY,
    viewer: document.getElementById('scroller')!.scrollTop,
    dialog: (document.querySelector('#sig-dialog') as HTMLElement).scrollTop,
  }));

test('phone: scroll the document, draw with a finger, drag the signature, download', async ({ page, browser }) => {
  const cdp = await page.context().newCDPSession(page);
  await gotoApp(page);
  await openAndWait(page, 'many-pages.pdf');

  // The action bar sits at the bottom on phones.
  const bar = (await page.locator('.actions').boundingBox())!;
  const vp = page.viewportSize()!;
  expect(bar.y + bar.height).toBeGreaterThan(vp.height - 4);

  // Swiping on the document scrolls it.
  const sc = (await page.locator('#scroller').boundingBox())!;
  const before = await scrollState(page);
  const cx = sc.x + sc.width / 2;
  await touchDrag(cdp, Array.from({ length: 12 }, (_, i) => [cx, sc.y + sc.height * 0.8 - i * 30] as [number, number]));
  await expect.poll(async () => (await scrollState(page)).viewer).toBeGreaterThan(before.viewer + 100);
  await page.locator('#page-num').fill('1');
  await page.locator('#page-num').press('Enter');

  // Drawing on the pad does not scroll anything.
  await page.locator('#sign-btn').tap();
  await page.locator('#ink-field').getByLabel('Blue').tap();
  const pad = (await page.locator('#pad').boundingBox())!;
  const s0 = await scrollState(page);
  await touchDrag(
    cdp,
    Array.from({ length: 30 }, (_, i) => [pad.x + 20 + i * ((pad.width - 40) / 30), pad.y + pad.height / 2 + Math.sin(i / 2) * 25] as [number, number]),
  );
  await touchDrag(cdp, Array.from({ length: 10 }, (_, i) => [pad.x + 40 + i * 8, pad.y + 30 + i * 9] as [number, number]));
  expect(await scrollState(page)).toEqual(s0);
  await page.getByRole('button', { name: 'Use signature' }).tap();
  await expect(page.locator('#sig-dialog')).toBeHidden();
  await expect(page.locator('.placement')).toHaveCount(1);

  // Dragging the placement with a finger moves it and doesn't scroll the page.
  const [r0] = await placements(page);
  const el = (await page.locator('.placement').boundingBox())!;
  const v0 = (await scrollState(page)).viewer;
  const ex = el.x + el.width / 2, ey = el.y + el.height / 2;
  await touchDrag(cdp, Array.from({ length: 10 }, (_, i) => [ex - i * 6, ey + i * 8] as [number, number]));
  const [r1] = await placements(page);
  expect(r1.y).toBeGreaterThan(r0.y + 20);
  expect(r1.x).toBeLessThan(r0.x - 10);
  expect((await scrollState(page)).viewer).toBe(v0);

  // Toolbar buttons are big enough to hit.
  for (const b of await page.locator('.placement-bar button').all()) {
    const bb = (await b.boundingBox())!;
    expect(bb.height).toBeGreaterThanOrEqual(40);
  }

  const { bytes } = await downloadSigned(page);
  const pages = await renderExported(browser, bytes);
  expectInkInside(pages[0].blue, r1);
});

test('phone: tap a form field and type; Add Text by tapping a line', async ({ page, browser }) => {
  await gotoApp(page);
  await openAndWait(page, 'fw9.pdf');
  const name = page.locator('.pdf-field[data-field="topmostSubform[0].Page1[0].f1_01[0]"]');
  await name.tap();
  await expect(name).toBeFocused();
  await page.keyboard.type('Jane Q. Example');
  await expect(name).toHaveValue('Jane Q. Example');
  await page.getByRole('checkbox', { name: 'Individual/sole proprietor' }).tap();
  await expect(page.getByRole('checkbox', { name: 'Individual/sole proprietor' })).toBeChecked();

  // Flat form: Add Text, tap the line, type.
  // Opening another PDF asks first, because the W-9 has unsaved entries.
  await openFixture(page, 'flat-form.pdf');
  await expect(page.locator('#confirm-dialog')).toBeVisible();
  await page.locator('#confirm-ok').tap();
  await expect(page.locator('#file-name')).toHaveText('flat-form.pdf');
  await page.locator('#tool-text').tap();
  const p = await pagePoint(page, 0, FLAT_FORM.name.x + 2, FLAT_FORM.name.y);
  await page.touchscreen.tap(p.x, p.y);
  await page.keyboard.type('Tapped text');
  await expect(page.locator('.placement[data-kind="text"] input')).toHaveValue('Tapped text');
  await page.locator('.pdf-field, #scroller').first().evaluate(() => (document.activeElement as HTMLElement)?.blur());
  const { bytes } = await downloadSigned(page);
  const pages = await renderExported(browser, bytes);
  expect(pages[0].text).toContain('Tapped text');
});
