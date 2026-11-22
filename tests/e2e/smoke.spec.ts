// Cross-browser smoke test (WebKit desktop + iPhone emulation).
import { expect, test } from '@playwright/test';
import { FLAT_FORM } from '../fixtures/fixtures';
import { analyzeExported, clickOnPage, downloadSigned, expectBoxMatches, gotoApp, openAndWait, placements, renderExported, typeSignature, uploadSignature } from './helpers';

test('open, sign, download and verify', async ({ page, browser }) => {
  await gotoApp(page);
  await openAndWait(page, 'rotated.pdf');
  await typeSignature(page, 'Safari Tester', 'Blue');
  await uploadSignature(page);
  const placed = await placements(page);
  const { name, bytes } = await downloadSigned(page);
  expect(name).toBe('rotated-signed.pdf');
  const pages = await renderExported(browser, bytes);
  expect(pages).toHaveLength(4);
  expect(pages[0].blueCount).toBeGreaterThan(50);
  expectBoxMatches(pages[0].red, placed[1]);
});

test('fill a form field and add text, then export', async ({ page, browser, isMobile }) => {
  await gotoApp(page);
  await openAndWait(page, 'fw9.pdf');
  const name = page.locator('.pdf-field[data-field="topmostSubform[0].Page1[0].f1_01[0]"]');
  if (isMobile) await name.tap();
  else await name.click();
  await page.keyboard.type('Safari Filler');
  await expect(name).toHaveValue('Safari Filler');
  await page.getByRole('checkbox', { name: 'Individual/sole proprietor' }).check();
  await page.locator('#tool-text').click();
  await clickOnPage(page, 0, 300, 700);
  await page.keyboard.type('Free text');
  await page.keyboard.press('Enter');
  await typeSignature(page, 'Safari Filler', 'Blue');
  const { bytes } = await downloadSigned(page);
  const { pages } = await analyzeExported(browser, bytes, []);
  expect(pages[0].fields['topmostSubform[0].Page1[0].f1_01[0]']).toBe('Safari Filler');
  expect(pages[0].fields['topmostSubform[0].Page1[0].Boxes3a-b_ReadOrder[0].c1_1[0]']).toBe('1');
  expect(pages[0].texts.some((t) => t.str === 'Free text')).toBe(true);
  expect(pages[0].blueCount).toBeGreaterThan(50);
});

test('flat form: Add Text on a line', async ({ page, browser }) => {
  await gotoApp(page);
  await openAndWait(page, 'flat-form.pdf');
  await page.locator('#tool-text').click();
  await clickOnPage(page, 0, FLAT_FORM.name.x + 2, FLAT_FORM.name.y);
  await page.keyboard.type('On the line');
  await page.keyboard.press('Enter');
  await typeSignature(page, 'Safari Filler', 'Blue');
  const { bytes } = await downloadSigned(page);
  const pages = await renderExported(browser, bytes);
  const t = pages[0].texts.find((x) => x.str === 'On the line')!;
  expect(t).toBeTruthy();
  expect(t.y).toBeGreaterThan(FLAT_FORM.name.y - 3);
  expect(t.y).toBeLessThanOrEqual(FLAT_FORM.name.y + 0.5);
});
