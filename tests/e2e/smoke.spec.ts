// Cross-browser smoke test (WebKit desktop + iPhone emulation).
import { expect, test } from '@playwright/test';
import { downloadSigned, expectBoxMatches, gotoApp, openAndWait, placements, renderExported, typeSignature, uploadSignature } from './helpers';

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
