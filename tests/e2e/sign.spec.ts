import { expect, test } from '@playwright/test';
import {
  downloadSigned,
  drawSignature,
  expectBoxMatches,
  expectInkInside,
  goToPage,
  gotoApp,
  openAndWait,
  openFixture,
  placements,
  renderExported,
  typeSignature,
  uploadSignature,
} from './helpers';

test.beforeEach(async ({ page }) => {
  await gotoApp(page);
});

test('draw a signature, sign two pages, download and verify the exported PDF', async ({ page, browser }) => {
  await openAndWait(page, 'mixed-sizes.pdf');
  await drawSignature(page, 'Blue');
  await expect(page.locator('.placement')).toHaveCount(1);

  await goToPage(page, 3);
  await page.locator('#sign-btn').click(); // "Place signature" re-uses it
  await expect(page.locator('.placement')).toHaveCount(2);

  const placed = await placements(page);
  expect(placed.map((p) => p.page)).toEqual([0, 2]);

  const { name, bytes } = await downloadSigned(page);
  expect(name).toBe('mixed-sizes-signed.pdf');

  const pages = await renderExported(browser, bytes);
  expect(pages).toHaveLength(3);
  // mixed sizes preserved
  expect(pages.map((p) => [Math.round(p.width), Math.round(p.height)])).toEqual([[612, 792], [595, 842], [792, 612]]);
  expectInkInside(pages[0].blue, placed[0]);
  expect(pages[1].blueCount).toBe(0);
  expectInkInside(pages[2].blue, placed[1]);
  // searchable text preserved
  pages.forEach((p, i) => expect(p.text).toContain(`SIGNPDF-TEXT-${i + 1}`));
});

test('typed signature with bundled font; keyboard move and resize', async ({ page, browser }) => {
  await openAndWait(page, 'mixed-sizes.pdf');
  await typeSignature(page, 'Alex Example', 'Blue');
  const el = page.locator('.placement').first();
  await expect(el).toBeFocused();
  const [before] = await placements(page);

  for (let i = 0; i < 5; i++) await el.press('ArrowRight');
  await el.press('Shift+ArrowDown');
  let [after] = await placements(page);
  expect(after.x).toBeCloseTo(before.x + 5, 2);
  expect(after.y).toBeCloseTo(before.y + 10, 2);

  await el.press('+');
  [after] = await placements(page);
  expect(after.width).toBeCloseTo(before.width * 1.05, 1);
  expect(after.width / after.height).toBeCloseTo(before.width / before.height, 3);

  const { bytes } = await downloadSigned(page);
  const pages = await renderExported(browser, bytes);
  expectInkInside(pages[0].blue, after);
});

test('imported image lands exactly on 0°, 90°, 180° and 270° pages', async ({ page, browser }) => {
  await openAndWait(page, 'rotated.pdf');
  await uploadSignature(page);
  // Drag the first placement towards the top-left so it is clearly off-centre.
  for (let n = 1; n <= 4; n++) {
    if (n > 1) {
      await goToPage(page, n);
      await page.locator('#sign-btn').click();
    }
    const el = page.locator(`.placement[data-page="${n - 1}"]`);
    const box = (await el.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 - 60 - n * 10, box.y + box.height / 2 - 40 - n * 5, { steps: 8 });
    await page.mouse.up();
  }
  const placed = await placements(page);
  expect(placed).toHaveLength(4);

  const { bytes } = await downloadSigned(page);
  const pages = await renderExported(browser, bytes);
  // display sizes: 90/270 swap width and height
  expect(pages.map((p) => [Math.round(p.width), Math.round(p.height)])).toEqual([[612, 792], [792, 612], [612, 792], [792, 612]]);
  placed.forEach((r) => expectBoxMatches(pages[r.page].red, r));
});

test('cropped, negative-origin, dirty-CTM and UserUnit pages export exactly', async ({ page, browser }) => {
  await openAndWait(page, 'tricky.pdf');
  await uploadSignature(page);
  for (let n = 2; n <= 5; n++) {
    await goToPage(page, n);
    await page.locator('#sign-btn').click();
  }
  // push one placement against the bottom-right edge with the keyboard
  const last = page.locator('.placement[data-page="4"]');
  await last.focus();
  for (let i = 0; i < 60; i++) await last.press('Shift+ArrowRight');
  for (let i = 0; i < 60; i++) await last.press('Shift+ArrowDown');

  const placed = await placements(page);
  expect(placed.map((p) => p.page)).toEqual([0, 1, 2, 3, 4]);
  const { bytes } = await downloadSigned(page);
  const pages = await renderExported(browser, bytes);
  placed.forEach((r) => expectBoxMatches(pages[r.page].red, r));
  // the edge placement stayed inside the visible page
  const edge = placed[4];
  expect(edge.x + edge.width).toBeCloseTo(pages[4].width, 1);
  expect(edge.y + edge.height).toBeCloseTo(pages[4].height, 1);
  pages.forEach((p, i) => expect(p.text).toContain(`SIGNPDF-TEXT-${i + 1}`));
});

test('zoom and window size do not move signatures relative to the page', async ({ page, browser }) => {
  await openAndWait(page, 'mixed-sizes.pdf');
  await uploadSignature(page);
  const el = page.locator('.placement').first();
  const pageEl = page.locator('.page').first();
  const relative = async () => {
    const a = (await el.boundingBox())!;
    const p = (await pageEl.boundingBox())!;
    return [(a.x - p.x) / p.width, (a.y - p.y) / p.height, a.width / p.width, a.height / p.height];
  };
  const start = await relative();
  const [rectBefore] = await placements(page);
  for (const action of [
    () => page.locator('#zoom-in').click(),
    () => page.locator('#zoom-in').click(),
    () => page.locator('#zoom-out').click(),
    () => page.setViewportSize({ width: 900, height: 700 }),
    () => page.locator('#zoom-fit').click(),
  ]) {
    await action();
    await page.waitForTimeout(100);
    const now = await relative();
    now.forEach((v, i) => expect(v).toBeCloseTo(start[i], 2));
  }
  const [rectAfter] = await placements(page);
  expect(rectAfter).toEqual(rectBefore);
  const { bytes } = await downloadSigned(page);
  expectBoxMatches((await renderExported(browser, bytes))[0].red, rectAfter);
});

test('duplicate and delete placements; only remaining ones are exported', async ({ page, browser }) => {
  await openAndWait(page, 'mixed-sizes.pdf');
  await uploadSignature(page);
  const first = page.locator('.placement').first();
  await first.click();
  await page.getByRole('button', { name: 'Duplicate signature' }).click();
  await expect(page.locator('.placement')).toHaveCount(2);
  await page.locator('.placement').nth(1).press('d');
  await expect(page.locator('.placement')).toHaveCount(3);
  // delete via button, then via keyboard
  await page.locator('.placement').nth(0).click();
  await page.locator('.placement.selected').getByRole('button', { name: 'Delete signature' }).click();
  await expect(page.locator('.placement')).toHaveCount(2);
  await page.locator('.placement').nth(0).press('Delete');
  await expect(page.locator('.placement')).toHaveCount(1);
  const [remaining] = await placements(page);
  const { bytes } = await downloadSigned(page);
  const pages = await renderExported(browser, bytes);
  expectBoxMatches(pages[0].red, remaining);
  // exactly one signature's worth of red pixels
  const expectedPixels = remaining.width * remaining.height * 4; // scale 2 → ×4
  expect(pages[0].redCount).toBeLessThan(expectedPixels * 1.1);
});

test('blank signatures are rejected', async ({ page }) => {
  await openAndWait(page, 'mixed-sizes.pdf');
  await page.locator('#sign-btn').click();
  await page.getByRole('button', { name: 'Use signature' }).click();
  await expect(page.locator('#sig-error')).toHaveText(/Draw your signature/);
  // a tiny dot is too small
  const box = (await page.locator('#pad').boundingBox())!;
  await page.mouse.click(box.x + 50, box.y + 50);
  await page.getByRole('button', { name: 'Use signature' }).click();
  await expect(page.locator('#sig-error')).toHaveText(/too small/);
  await page.getByRole('tab', { name: 'Type' }).click();
  await page.getByRole('textbox', { name: 'Your name' }).fill('   ');
  await page.getByRole('button', { name: 'Use signature' }).click();
  await expect(page.locator('#sig-error')).toHaveText(/Type your name/);
  await page.getByRole('tab', { name: 'Upload' }).click();
  await page.getByRole('button', { name: 'Use signature' }).click();
  await expect(page.locator('#sig-error')).toHaveText(/Choose an image/);
  await expect(page.locator('.placement')).toHaveCount(0);
});

test('download without a signature explains what to do', async ({ page }) => {
  await openAndWait(page, 'mixed-sizes.pdf');
  // aria-disabled (not disabled) so it stays focusable and can explain itself
  await expect(page.locator('#download-btn')).toHaveAttribute('aria-disabled', 'true');
  await page.locator('#download-btn').click({ force: true });
  await expect(page.locator('#toast')).toHaveText(/Add your signature first/);
});

test.describe('file errors', () => {
  test('not a PDF', async ({ page }) => {
    await openFixture(page, 'not-a-pdf.pdf');
    await expect(page.locator('#open-error')).toContainText('isn’t a PDF');
    await expect(page.locator('#workspace')).toBeHidden();
  });
  test('corrupted PDF', async ({ page }) => {
    await openFixture(page, 'corrupt.pdf');
    await expect(page.locator('#open-error')).toContainText(/damaged|couldn’t be opened/);
  });
  test('password-protected PDF', async ({ page }) => {
    await openFixture(page, 'password.pdf');
    await expect(page.locator('#open-error')).toContainText('password-protected');
  });
  test('already digitally signed PDF shows a warning before signing', async ({ page }) => {
    await openAndWait(page, 'digitally-signed.pdf');
    await expect(page.locator('#notices')).toContainText('digital (certificate) signature');
  });
});

test('opening another PDF never silently discards placements', async ({ page }) => {
  await openAndWait(page, 'mixed-sizes.pdf');
  await uploadSignature(page);
  await openFixture(page, 'rotated.pdf');
  const dialog = page.locator('#confirm-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('1 signature placement');
  await page.locator('#confirm-cancel').click();
  await expect(page.locator('#file-name')).toHaveText('mixed-sizes.pdf');
  await expect(page.locator('.placement')).toHaveCount(1);

  await openFixture(page, 'rotated.pdf');
  await page.locator('#confirm-ok').click();
  await expect(page.locator('#file-name')).toHaveText('rotated.pdf');
  await expect(page.locator('.placement')).toHaveCount(0);
  // the signature itself is kept for the new document
  await expect(page.locator('#sign-label')).toHaveText('Place signature');
});

test('after downloading, opening another PDF does not ask again', async ({ page }) => {
  await openAndWait(page, 'mixed-sizes.pdf');
  await uploadSignature(page);
  await downloadSigned(page);
  await openFixture(page, 'rotated.pdf');
  await expect(page.locator('#file-name')).toHaveText('rotated.pdf');
});

test('start over clears the document and signature without reloading', async ({ page }) => {
  await openAndWait(page, 'mixed-sizes.pdf');
  await typeSignature(page, 'Alex Example');
  await page.evaluate(() => ((window as unknown as { __marker: number }).__marker = 42));
  await page.locator('#reset-btn').click();
  await expect(page.locator('#confirm-dialog')).toBeVisible();
  await page.locator('#confirm-ok').click();
  await expect(page.locator('#start')).toBeVisible();
  await expect(page.locator('#workspace')).toBeHidden();
  await expect(page.locator('.page')).toHaveCount(0);
  await expect(page.locator('.placement')).toHaveCount(0);
  // same page instance (no reload)
  expect(await page.evaluate(() => (window as unknown as { __marker: number }).__marker)).toBe(42);
  // signature gone: opening again asks to create one
  await openAndWait(page, 'mixed-sizes.pdf');
  await expect(page.locator('#sign-label')).toHaveText('Add signature');
  await page.locator('#sign-btn').click();
  await page.getByRole('tab', { name: 'Type' }).click();
  await expect(page.getByRole('textbox', { name: 'Your name' })).toHaveValue('');
});

test('long documents render lazily and page navigation works', async ({ page }) => {
  await openAndWait(page, 'many-pages.pdf');
  await expect(page.locator('#page-count')).toHaveText('of 60');
  await page.waitForTimeout(500);
  const rendered = await page.evaluate(() => (window as unknown as { __vnuaSignature: { renderedPages(): number } }).__vnuaSignature.renderedPages());
  expect(rendered).toBeLessThan(10);
  await goToPage(page, 50);
  await expect(page.locator('.page[data-page="49"]')).toHaveClass(/rendered/);
  await page.locator('#prev-page').click();
  await expect(page.locator('#page-num')).toHaveValue('49');
  await page.locator('#next-page').click();
  await expect(page.locator('#page-num')).toHaveValue('50');
});

test('signature dialog is an accessible modal with keyboard tabs', async ({ page }) => {
  await openAndWait(page, 'mixed-sizes.pdf');
  await page.locator('#sign-btn').click();
  const draw = page.getByRole('tab', { name: 'Draw' });
  await expect(draw).toBeFocused();
  await draw.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Type' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('textbox', { name: 'Your name' })).toBeFocused();
  await page.getByRole('textbox', { name: 'Your name' }).fill('Keyboard User');
  await page.getByRole('textbox', { name: 'Your name' }).press('Enter');
  await expect(page.locator('#sig-dialog')).toBeHidden();
  await expect(page.locator('.placement')).toHaveCount(1);
  await page.locator('#change-sig').click();
  await page.keyboard.press('Escape');
  await expect(page.locator('#sig-dialog')).toBeHidden();
});
