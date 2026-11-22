// Fill & sign: click fields / lines in the preview, type, sign, export, and
// verify the exported file independently (PDF.js in an isolated context).
import { expect, test, type Page } from '@playwright/test';
import { FLAT_FORM } from '../fixtures/fixtures';
import {
  analyzeExported,
  baselineRatio,
  clickOnPage,
  downloadSigned,
  expectInkInside,
  openAndWait,
  gotoApp,
  pagePoint,
  placementsOf,
  relativeBox,
  typeSignature,
} from './helpers';

const NAME = 'topmostSubform[0].Page1[0].f1_01[0]';
const BUSINESS = 'topmostSubform[0].Page1[0].f1_02[0]';
const INDIVIDUAL = 'topmostSubform[0].Page1[0].Boxes3a-b_ReadOrder[0].c1_1[0]';
const ADDRESS = 'topmostSubform[0].Page1[0].Address_ReadOrder[0].f1_07[0]';
const CITY = 'topmostSubform[0].Page1[0].Address_ReadOrder[0].f1_08[0]';
const SSN = ['topmostSubform[0].Page1[0].f1_11[0]', 'topmostSubform[0].Page1[0].f1_12[0]', 'topmostSubform[0].Page1[0].f1_13[0]'];
const field = (page: Page, name: string) => page.locator(`.pdf-field[data-field="${name}"]`);
const rectOf = async (page: Page, name: string) => {
  const [x, y, width, height] = (await field(page, name).getAttribute('data-rect'))!.split(',').map(Number);
  return { x, y, width, height };
};

/** Drag an element's centre to a display-space point on a page. */
async function dragTo(page: Page, selector: string, pageIndex: number, x: number, y: number) {
  const target = await pagePoint(page, pageIndex, x, y);
  const box = (await page.locator(selector).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x, target.y, { steps: 12 });
  await page.mouse.up();
}

test('fillable PDF (fw9.pdf): click fields in the preview, Tab between them, tick a box, sign, zoom, export', async ({ page, browser }) => {
  await gotoApp(page);
  await openAndWait(page, 'fw9.pdf');
  await expect(page).toHaveTitle('fw9.pdf · vnua-signature');
  await expect(page.locator('#brand-name')).toHaveText('fw9.pdf · vnua-signature');
  await expect(page.locator('.pdf-field')).toHaveCount(23);
  await expect(page.locator('#fill-hint')).toContainText('23 fillable fields');
  await expect(page.locator('#notices')).toBeEmpty(); // no false "digitally signed" / XFA warnings

  // Click straight into line 1 in the preview and type.
  await field(page, NAME).click();
  await expect(field(page, NAME)).toBeFocused();
  await page.keyboard.type('Jane Q. Example');
  // Tab moves to line 2, Shift+Tab back to line 1.
  await page.keyboard.press('Tab');
  await expect(field(page, BUSINESS)).toBeFocused();
  await page.keyboard.type('Example Consulting LLC');
  await page.keyboard.press('Shift+Tab');
  await expect(field(page, NAME)).toBeFocused();
  await expect(field(page, NAME)).toHaveValue('Jane Q. Example');

  // A checkbox: click it.
  await page.getByRole('checkbox', { name: 'Individual/sole proprietor' }).click();
  await expect(field(page, INDIVIDUAL)).toBeChecked();

  // Address lines, found by their printed captions.
  await page.getByRole('textbox', { name: /^5 Address/ }).click();
  await page.keyboard.type('123 Sample Street, Apt 4');
  await page.keyboard.press('Tab');
  await expect(field(page, CITY)).toBeFocused();
  await page.keyboard.type('Springfield, IL 62701');

  // SSN: three comb fields with max lengths; extra digits are refused.
  await field(page, SSN[0]).click();
  await page.keyboard.type('1234'); // 4th digit ignored (max 3)
  await expect(field(page, SSN[0])).toHaveValue('123');
  await field(page, SSN[1]).click();
  await page.keyboard.type('45');
  await field(page, SSN[2]).click();
  await page.keyboard.type('6789');
  // A full comb field shows every digit (it must not scroll sideways).
  expect(await field(page, SSN[2]).evaluate((e) => e.scrollLeft)).toBe(0);

  // Sign on the "Signature of U.S. person" line (page 1, around y = 588).
  await pagePoint(page, 0, 250, 588);
  await typeSignature(page, 'Jane Q. Example', 'Blue');
  const sig = '.placement[data-kind="image"]';
  for (let i = 0; i < 9; i++) await page.locator(sig).press('-'); // smaller, by keyboard
  await dragTo(page, sig, 0, 250, 586);
  const [sigRect] = await placementsOf(page, 'image');
  expect(sigRect.page).toBe(0);
  expect(sigRect.y).toBeGreaterThan(565);
  expect(sigRect.y + sigRect.height).toBeLessThan(606);

  // Zoom in and out: fields and the signature stay put relative to the page.
  const before = { name: await relativeBox(page, `.pdf-field[data-field="${NAME}"]`), sig: await relativeBox(page, sig) };
  for (const b of ['#zoom-in', '#zoom-in', '#zoom-out', '#zoom-out', '#zoom-out', '#zoom-fit']) {
    await page.locator(b).click();
    const now = { name: await relativeBox(page, `.pdf-field[data-field="${NAME}"]`), sig: await relativeBox(page, sig) };
    for (const k of ['name', 'sig'] as const) {
      for (const d of ['x', 'y', 'w', 'h'] as const) expect(Math.abs(now[k][d] - before[k][d])).toBeLessThan(0.002);
    }
  }
  expect((await placementsOf(page, 'image'))[0]).toEqual(sigRect);
  await page.setViewportSize({ width: 900, height: 700 });
  for (const d of ['x', 'y', 'w', 'h'] as const) expect(Math.abs((await relativeBox(page, sig))[d] - before.sig[d])).toBeLessThan(0.002);

  // Download one PDF and check it independently.
  const nameRect = await rectOf(page, NAME);
  const ssnRect = await rectOf(page, SSN[2]);
  const boxRect = await rectOf(page, INDIVIDUAL);
  const otherBox = await rectOf(page, 'topmostSubform[0].Page1[0].Boxes3a-b_ReadOrder[0].c1_1[1]');
  const { name, bytes } = await downloadSigned(page);
  expect(name).toBe('fw9-signed.pdf');
  const inset = (r: { x: number; y: number; width: number; height: number }, d: number) => ({ x: r.x + d, y: r.y + d, width: r.width - 2 * d, height: r.height - 2 * d });
  const { pages, dark } = await analyzeExported(browser, bytes, [
    { page: 0, ...inset(nameRect, 1) },
    { page: 0, ...inset(ssnRect, 2) },
    { page: 0, ...inset(boxRect, 1.5) },
    { page: 0, ...inset(otherBox, 1.5) },
  ]);
  expect(pages).toHaveLength(6);
  const f = pages[0].fields;
  expect(f[NAME]).toBe('Jane Q. Example');
  expect(f[BUSINESS]).toBe('Example Consulting LLC');
  expect(f[ADDRESS]).toBe('123 Sample Street, Apt 4');
  expect(f[CITY]).toBe('Springfield, IL 62701');
  expect(SSN.map((n) => f[n])).toEqual(['123', '45', '6789']);
  expect(f[INDIVIDUAL]).toBe('1');
  // Visible, not just stored: ink inside the name field, the SSN boxes and the ticked box only.
  expect(dark[0]).toBeGreaterThan(80);
  expect(dark[1]).toBeGreaterThan(40);
  expect(dark[2]).toBeGreaterThan(8);
  expect(dark[3]).toBe(0);
  // Signature on page 1 only, where it was placed.
  expectInkInside(pages[0].blue, sigRect);
  for (const p of pages.slice(1)) expect(p.blueCount).toBe(0);
});

test('fillable PDF can still be signed without filling anything in', async ({ page, browser }) => {
  await gotoApp(page);
  await openAndWait(page, 'fw9.pdf');
  await typeSignature(page, 'Only Signing', 'Blue');
  const [sigRect] = await placementsOf(page, 'image');
  const { bytes } = await downloadSigned(page);
  const pages = await (await analyzeExported(browser, bytes, [])).pages;
  expect(pages).toHaveLength(6);
  expect(Object.keys(pages[0].fields)).toHaveLength(23);
  for (const v of Object.values(pages[0].fields)) expect(['', 'Off']).toContain(v);
  expectInkInside(pages[sigRect.page].blue, sigRect);
});

test('flat PDF: Add Text on the lines, edit, drag, resize, nudge, delete, undo, checkmark, rotated page, sign, export', async ({ page, browser }) => {
  await gotoApp(page);
  await openAndWait(page, 'flat-form.pdf');
  await expect(page.locator('.pdf-field')).toHaveCount(0);
  await expect(page.locator('#fill-hint')).toContainText('use Add Text');
  const ratio = await baselineRatio(page);

  // Add Text, click on the "Full name" line, type straight away.
  await page.locator('#tool-text').click();
  await expect(page.locator('#tool-text')).toHaveAttribute('aria-pressed', 'true');
  await clickOnPage(page, 0, FLAT_FORM.name.x + 2, FLAT_FORM.name.y);
  await page.keyboard.type('Jane Q. Example');
  // The tool stays on: click the Date line and type.
  await clickOnPage(page, 0, FLAT_FORM.date.x + 2, FLAT_FORM.date.y);
  await page.keyboard.type('11/22/2026');
  await page.keyboard.press('Enter'); // done typing; the box stays selected
  let texts = await placementsOf(page, 'text');
  expect(texts).toHaveLength(2);
  const textBox = (i: number) => page.locator('.placement[data-kind="text"]').nth(i);
  await expect(textBox(0).locator('input')).toHaveValue('Jane Q. Example');
  // Text sits on the line: baseline just above it.
  const baseline0 = texts[0].y + ratio * (texts[0].height / 1.3);
  expect(baseline0).toBeGreaterThan(FLAT_FORM.name.y - 2.5);
  expect(baseline0).toBeLessThanOrEqual(FLAT_FORM.name.y);

  // Edit: click into the date, fix the year.
  await textBox(1).click();
  await expect(textBox(1).locator('input')).toBeFocused();
  await page.keyboard.press('Backspace');
  await page.keyboard.type('7');
  await expect(textBox(1).locator('input')).toHaveValue('11/22/2027');
  await page.keyboard.press('Escape');
  await expect(textBox(1)).toBeFocused();

  // Arrow-key nudge (1 pt per press) for precise alignment.
  const beforeNudge = (await placementsOf(page, 'text'))[1];
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowUp');
  const nudged = (await placementsOf(page, 'text'))[1];
  expect(nudged.x - beforeNudge.x).toBeCloseTo(2, 3);
  expect(nudged.y - beforeNudge.y).toBeCloseTo(-1, 3);

  // Drag it (select tool), and resize with the toolbar.
  await page.locator('#tool-text').click(); // back to select
  await dragTo(page, '.placement[data-kind="text"] >> nth=1', 0, FLAT_FORM.date.x + 60, FLAT_FORM.date.y - 6);
  const dragged = (await placementsOf(page, 'text'))[1];
  expect(dragged.x).toBeGreaterThan(nudged.x + 20);
  const h0 = dragged.height;
  await textBox(1).click();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Make text larger' }).click();
  expect((await placementsOf(page, 'text'))[1].height).toBeGreaterThan(h0 * 1.1);

  // Undo the resize, then the drag: back to the nudged position.
  await page.locator('#undo-btn').click();
  expect((await placementsOf(page, 'text'))[1].height).toBeCloseTo(h0, 3);
  await page.locator('#undo-btn').click();
  const undone = (await placementsOf(page, 'text'))[1];
  expect(undone.x).toBeCloseTo(nudged.x, 3);

  // Delete a text box by accident, undo brings it back with its text.
  await page.locator('#tool-text').click();
  await clickOnPage(page, 0, 400, 330);
  await page.keyboard.type('Temporary');
  await page.keyboard.press('Enter');
  await expect(page.locator('.placement[data-kind="text"]')).toHaveCount(3);
  await page.keyboard.press('Delete');
  await expect(page.locator('.placement[data-kind="text"]')).toHaveCount(2);
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  await expect(page.locator('.placement[data-kind="text"]')).toHaveCount(3);
  await expect(textBox(2).locator('input')).toHaveValue('Temporary');
  await textBox(2).click();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Delete text' }).click();
  await expect(page.locator('.placement[data-kind="text"]')).toHaveCount(2);

  // Checkmark in "Option A".
  await page.locator('#tool-check').click();
  const A = FLAT_FORM.boxA, B = FLAT_FORM.boxB;
  await clickOnPage(page, 0, A.x + A.size / 2, A.y + A.size / 2);
  await expect(page.locator('.placement[data-kind="check"]')).toHaveCount(1);

  // Page 2 is rotated 90°: Add Text on its line.
  await page.locator('#tool-text').click();
  const N = FLAT_FORM.notes;
  await clickOnPage(page, 1, N.x + 2, N.y);
  await page.keyboard.type('Rotated page note');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape'); // leave the tool

  // Sign on page 1.
  await pagePoint(page, 0, 300, 420);
  await typeSignature(page, 'Jane Q. Example', 'Blue');

  // Zoom around: nothing moves relative to the pages.
  texts = await placementsOf(page, 'text');
  const checks = await placementsOf(page, 'check');
  const sigs = await placementsOf(page, 'image');
  const rel0 = await relativeBox(page, '.placement[data-kind="text"] >> nth=0');
  for (const b of ['#zoom-in', '#zoom-in', '#zoom-out', '#zoom-out', '#zoom-out', '#zoom-fit']) {
    await page.locator(b).click();
    const rel = await relativeBox(page, '.placement[data-kind="text"] >> nth=0');
    for (const d of ['x', 'y', 'w', 'h'] as const) expect(Math.abs(rel[d] - rel0[d])).toBeLessThan(0.002);
  }
  expect(await placementsOf(page, 'text')).toEqual(texts);

  const { bytes } = await downloadSigned(page);
  const inner = (b: { x: number; y: number; size: number }) => ({ page: 0, x: b.x + 1.5, y: b.y + 1.5, width: b.size - 3, height: b.size - 3 });
  const { pages, dark } = await analyzeExported(browser, bytes, [inner(A), inner(B)]);
  expect(pages).toHaveLength(2);

  // Each typed string is real text, on the right page, upright, at the right baseline.
  const expectText = (str: string, r: { page: number; x: number; y: number; height: number }) => {
    const t = pages[r.page].texts.find((x) => x.str === str);
    expect(t, `"${str}" on page ${r.page + 1}`).toBeTruthy();
    const size = r.height / 1.3;
    expect(t!.upright).toBe(true);
    expect(Math.abs(t!.x - (r.x + 0.15 * size))).toBeLessThan(0.5);
    expect(Math.abs(t!.y - (r.y + ratio * size))).toBeLessThan(0.5);
    expect(Math.abs(t!.size - size)).toBeLessThan(0.05);
  };
  expectText('Jane Q. Example', texts[0]);
  expectText('11/22/2027', texts[1]);
  expectText('Rotated page note', texts[2]);
  expect(texts[2].page).toBe(1);
  expect(pages[0].text).not.toContain('Temporary');
  // Checkmark inside A, nothing in B.
  expect(checks[0].page).toBe(0);
  expect(dark[0]).toBeGreaterThan(15);
  expect(dark[1]).toBe(0);
  // Signature where it was placed.
  expectInkInside(pages[sigs[0].page].blue, sigs[0]);
});

test('typing emoji or unsupported letters gives a notice instead of a broken PDF', async ({ page }) => {
  await gotoApp(page);
  await openAndWait(page, 'fw9.pdf');
  await field(page, NAME).click();
  await page.keyboard.insertText('Zoë 😀');
  await expect(field(page, NAME)).toHaveValue('Zoë ');
  await expect(page.locator('#toast')).toContainText('can’t be saved');
});

test('undo takes back typing in a field and ticking a box', async ({ page }) => {
  await gotoApp(page);
  await openAndWait(page, 'fw9.pdf');
  await field(page, NAME).click();
  await page.keyboard.type('Right Name');
  await page.keyboard.press('Tab');
  await field(page, NAME).click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Mistake');
  await page.keyboard.press('Tab');
  await page.getByRole('checkbox', { name: 'C corporation', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: 'C corporation', exact: true })).toBeChecked();
  await page.locator('#undo-btn').click();
  await expect(page.getByRole('checkbox', { name: 'C corporation', exact: true })).not.toBeChecked();
  await expect(field(page, NAME)).toHaveValue('Right Name Mistake');
  await page.locator('#undo-btn').click();
  await expect(field(page, NAME)).toHaveValue('Right Name');
  await page.locator('#undo-btn').click();
  await expect(field(page, NAME)).toHaveValue('');
});
