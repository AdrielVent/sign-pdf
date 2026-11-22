import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, type Browser, type Page } from '@playwright/test';
import { FIXTURE_DIR } from '../fixtures/fixtures';

export const fixture = (name: string) => join(FIXTURE_DIR, name);
const PDFJS = join(import.meta.dirname, '..', '..', 'node_modules', 'pdfjs-dist');

export async function gotoApp(page: Page) {
  await page.goto('./');
  await expect(page.getByRole('button', { name: 'Open PDF' })).toBeVisible();
}

export async function openFixture(page: Page, name: string) {
  const chooser = page.waitForEvent('filechooser');
  const btn = page.locator('#workspace').isVisible().then((v) => (v ? page.locator('#other-btn') : page.locator('#open-btn')));
  await (await btn).click();
  await (await chooser).setFiles(fixture(name));
}

export async function openAndWait(page: Page, name: string) {
  await openFixture(page, name);
  await expect(page.locator('#workspace')).toBeVisible();
  await expect(page.locator('.page.rendered').first()).toBeVisible();
}

export async function openSignatureDialog(page: Page) {
  const change = page.locator('#change-sig');
  if (await change.isVisible()) await change.click();
  else await page.locator('#sign-btn').click();
  await expect(page.locator('#sig-dialog')).toBeVisible();
}

export async function chooseInk(page: Page, label: 'Black' | 'Blue') {
  await page.locator('#ink-field').getByLabel(label).check();
}

export async function typeSignature(page: Page, name: string, ink: 'Black' | 'Blue' = 'Blue') {
  await openSignatureDialog(page);
  await page.getByRole('tab', { name: 'Type' }).click();
  await chooseInk(page, ink);
  await page.getByRole('textbox', { name: 'Your name' }).fill(name);
  await expect(page.locator('#sig-preview')).toBeVisible();
  await page.getByRole('button', { name: 'Use signature' }).click();
  await expect(page.locator('#sig-dialog')).toBeHidden();
}

/** Draw a wavy signature with the mouse. */
export async function drawSignature(page: Page, ink: 'Black' | 'Blue' = 'Blue') {
  await openSignatureDialog(page);
  await page.getByRole('tab', { name: 'Draw' }).click();
  await chooseInk(page, ink);
  const pad = page.locator('#pad');
  await expect(pad).toBeVisible();
  // Switching tabs re-lays out the dialog; wait until the pad stops moving
  // before measuring it, or strokes can land outside it on slow machines.
  let box = (await pad.boundingBox())!;
  await expect
    .poll(async () => {
      const prev = box;
      box = (await pad.boundingBox())!;
      return prev.x === box.x && prev.y === box.y && prev.width === box.width && box.width > 0;
    })
    .toBe(true);
  const y0 = box.y + box.height * 0.55;
  await page.mouse.move(box.x + 30, y0);
  await page.mouse.down();
  for (let i = 0; i <= 40; i++) {
    const x = box.x + 30 + (box.width - 80) * (i / 40);
    await page.mouse.move(x, y0 + Math.sin(i / 3) * 30);
  }
  await page.mouse.up();
  await expect(page.locator('#pad-hint'), 'strokes should have landed on the pad').toBeHidden();
  await page.getByRole('button', { name: 'Use signature' }).click();
  await expect(page.locator('#sig-error'), 'signature dialog reported an error').toBeHidden();
  await expect(page.locator('#sig-dialog')).toBeHidden();
}

export async function uploadSignature(page: Page, file = fixture('red-signature.png')) {
  await openSignatureDialog(page);
  await page.getByRole('tab', { name: 'Upload' }).click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Choose image' }).click();
  await (await chooser).setFiles(file);
  await expect(page.locator('#sig-preview')).toBeVisible();
  await page.getByRole('button', { name: 'Use signature' }).click();
  await expect(page.locator('#sig-dialog')).toBeHidden();
}

export async function goToPage(page: Page, n: number) {
  await page.locator('#page-num').fill(String(n));
  await page.locator('#page-num').press('Enter');
  await expect(page.locator('#page-num')).toHaveValue(String(n));
}

export interface PlacedRect {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Signature placements (the original tests only deal with signatures). */
export async function placements(page: Page): Promise<PlacedRect[]> {
  return page.locator('.placement[data-kind="image"]').evaluateAll((els) =>
    els.map((el) => {
      const [x, y, width, height] = (el as HTMLElement).dataset.rect!.split(',').map(Number);
      return { page: Number((el as HTMLElement).dataset.page), x, y, width, height };
    }),
  );
}

export async function downloadSigned(page: Page) {
  const dl = page.waitForEvent('download');
  await page.locator('#download-btn').click();
  const download = await dl;
  const path = await download.path();
  const bytes = await readFile(path!);
  await expect(page.locator('#toast')).toContainText('Saved');
  // Opt-in: keep exports for checking in other viewers (e.g. Preview / PDFKit).
  if (process.env.SAVE_EXPORTS) {
    mkdirSync(process.env.SAVE_EXPORTS, { recursive: true });
    writeFileSync(join(process.env.SAVE_EXPORTS, `${download.suggestedFilename().replace(/\.pdf$/, '')}-${randomUUID().slice(0, 8)}.pdf`), bytes);
  }
  return { name: download.suggestedFilename(), bytes };
}

export interface RenderedText {
  str: string;
  /** Baseline origin in display units (top-left origin). */
  x: number;
  y: number;
  size: number;
  /** True if the text runs left-to-right on screen (upright). */
  upright: boolean;
}
export interface RenderedPage {
  width: number;
  height: number;
  text: string;
  texts: RenderedText[];
  /** Form field values by fully-qualified name, as PDF.js reads them from the export. */
  fields: Record<string, string>;
  red: Box | null;
  blue: Box | null;
  redCount: number;
  blueCount: number;
}
/** Count dark (black-ish) pixels inside a display-space rectangle of a page. */
export interface Probe {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * Render a PDF with PDF.js in a fresh, isolated browser context (not the app)
 * and report where red / blue ink appears on each page, in display units.
 */
export async function renderExported(browser: Browser, bytes: Buffer, scale = 2): Promise<RenderedPage[]> {
  return (await analyzeExported(browser, bytes, [], scale)).pages;
}

/**
 * Like renderExported, plus dark-pixel counts for each probe rectangle.
 * Pages are painted as for printing (annotation appearances included), so
 * form-field values must have real appearance streams to be counted.
 */
export async function analyzeExported(browser: Browser, bytes: Buffer, probes: Probe[], scale = 2): Promise<{ pages: RenderedPage[]; dark: number[] }> {
  const ctx = await browser.newContext();
  await ctx.route('http://verify.test/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>verify</title>' });
    const map: Record<string, string> = {
      '/pdfjs/pdf.mjs': join(PDFJS, 'legacy/build/pdf.mjs'),
      '/pdfjs/pdf.worker.mjs': join(PDFJS, 'legacy/build/pdf.worker.mjs'),
    };
    let file = map[url.pathname];
    if (!file && url.pathname.startsWith('/standard_fonts/')) file = join(PDFJS, url.pathname);
    if (!file && url.pathname.startsWith('/wasm/')) file = join(PDFJS, url.pathname);
    if (!file) return route.fulfill({ status: 404 });
    const type = file.endsWith('.mjs') ? 'application/javascript' : file.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream';
    return route.fulfill({ body: await readFile(file), contentType: type });
  });
  const page = await ctx.newPage();
  await page.goto('http://verify.test/');
  const result = await page.evaluate(
    async ({ b64, scale, probes }) => {
      const pdfjs = await import('http://verify.test/pdfjs/pdf.mjs' as string);
      pdfjs.GlobalWorkerOptions.workerSrc = 'http://verify.test/pdfjs/pdf.worker.mjs';
      const data = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const pdf = await pdfjs.getDocument({ data, standardFontDataUrl: 'http://verify.test/standard_fonts/', wasmUrl: 'http://verify.test/wasm/' }).promise;
      const out = [];
      const dark: number[] = probes.map(() => 0);
      for (let n = 1; n <= pdf.numPages; n++) {
        const pg = await pdf.getPage(n);
        const vp = pg.getViewport({ scale });
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(vp.width);
        canvas.height = Math.round(vp.height);
        // Create the context first, transparent and CPU-backed: Chromium on Linux
        // otherwise uses LCD (subpixel) text on opaque canvases, and the colored
        // fringes on black text look like "blue ink" to the classifier below.
        // PDF.js's later getContext() call returns this same context.
        const ctx2d = canvas.getContext('2d', { alpha: true, willReadFrequently: true })!;
        await pg.render({ canvas, viewport: vp }).promise;
        const img = ctx2d.getImageData(0, 0, canvas.width, canvas.height).data;
        const red = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
        const blue = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
        let redCount = 0, blueCount = 0;
        for (let y = 0; y < canvas.height; y++) {
          for (let x = 0; x < canvas.width; x++) {
            const i = (y * canvas.width + x) * 4;
            const r = img[i], g = img[i + 1], b = img[i + 2];
            const grow = (bx: typeof red) => {
              bx.x0 = Math.min(bx.x0, x); bx.y0 = Math.min(bx.y0, y);
              bx.x1 = Math.max(bx.x1, x + 1); bx.y1 = Math.max(bx.y1, y + 1);
            };
            if (r > 200 && g < 90 && b < 90) { redCount++; grow(red); }
            else if (b > 110 && b - r > 50 && b - g > 30) { blueCount++; grow(blue); }
          }
        }
        probes.forEach((pr, k) => {
          if (pr.page !== n - 1) return;
          const x0 = Math.max(0, Math.floor(pr.x * scale)), y0 = Math.max(0, Math.floor(pr.y * scale));
          const x1 = Math.min(canvas.width, Math.ceil((pr.x + pr.width) * scale)), y1 = Math.min(canvas.height, Math.ceil((pr.y + pr.height) * scale));
          for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
            const i = (y * canvas.width + x) * 4;
            if (img[i] < 110 && img[i + 1] < 110 && img[i + 2] < 110) dark[k]++;
          }
        });
        const norm = (bx: typeof red, count: number) => (count ? { x0: bx.x0 / scale, y0: bx.y0 / scale, x1: bx.x1 / scale, y1: bx.y1 / scale } : null);
        const tc = await pg.getTextContent();
        const texts = [];
        for (const it of tc.items as { str?: string; transform?: number[] }[]) {
          if (!it.str || !it.transform) continue;
          const t = pdfjs.Util.transform(vp.transform, it.transform) as number[];
          texts.push({ str: it.str, x: t[4] / scale, y: t[5] / scale, size: Math.hypot(t[2], t[3]) / scale, upright: t[0] > 0 && Math.abs(t[1]) < 1e-6 * Math.abs(t[0]) + 1e-9 });
        }
        const fields: Record<string, string> = {};
        for (const a of (await pg.getAnnotations()) as { fieldName?: string; fieldValue?: unknown }[]) {
          if (a.fieldName) fields[a.fieldName] = Array.isArray(a.fieldValue) ? String(a.fieldValue[0] ?? '') : String(a.fieldValue ?? '');
        }
        out.push({
          width: vp.width / scale,
          height: vp.height / scale,
          text: tc.items.map((i: { str?: string }) => i.str ?? '').join(' '),
          texts,
          fields,
          red: norm(red, redCount),
          blue: norm(blue, blueCount),
          redCount,
          blueCount,
        });
      }
      return { pages: out, dark };
    },
    { b64: bytes.toString('base64'), scale, probes },
  );
  await ctx.close();
  return result;
}

// ---------------------------------------------------------------- fill & sign helpers

/** Display-space size of a page (from the app's test hook: numbers only). */
export async function pageSize(page: Page, index: number): Promise<{ width: number; height: number }> {
  return page.evaluate((i) => (window as unknown as { __vnuaSignature: { pageSize(i: number): { width: number; height: number } } }).__vnuaSignature.pageSize(i), index);
}

/** Scroll so a display-space point of a page is in view; return its screen coordinates. */
export async function pagePoint(page: Page, index: number, x: number, y: number): Promise<{ x: number; y: number }> {
  const size = await pageSize(page, index);
  await page.evaluate(
    ({ index, y, h }) => {
      const scroller = document.getElementById('scroller')!;
      const el = document.querySelector<HTMLElement>(`.page[data-page="${index}"]`)!;
      scroller.scrollTop = el.offsetTop + (y / h) * el.offsetHeight - scroller.clientHeight / 2;
    },
    { index, y, h: size.height },
  );
  const box = (await page.locator(`.page[data-page="${index}"] .overlay`).boundingBox())!;
  const k = box.width / size.width;
  return { x: box.x + x * k, y: box.y + y * k };
}

export async function clickOnPage(page: Page, index: number, x: number, y: number) {
  const p = await pagePoint(page, index, x, y);
  await page.mouse.click(p.x, p.y);
}

/** Placements of one kind ('image' = signature, 'text', 'check'). */
export async function placementsOf(page: Page, kind: 'image' | 'text' | 'check'): Promise<PlacedRect[]> {
  return (await page.locator(`.placement[data-kind="${kind}"]`).evaluateAll((els) =>
    els.map((el) => {
      const [x, y, width, height] = (el as HTMLElement).dataset.rect!.split(',').map(Number);
      return { page: Number((el as HTMLElement).dataset.page), x, y, width, height };
    }),
  )) as PlacedRect[];
}

export async function baselineRatio(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { __vnuaSignature: { baselineRatio(): number } }).__vnuaSignature.baselineRatio());
}

/**
 * Where an on-screen box sits relative to its page, as fractions of the page
 * size. Zoom or window size must never change this.
 */
export async function relativeBox(page: Page, selector: string) {
  return page.locator(selector).evaluate((el) => {
    const pageEl = el.closest('.page')!.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    return {
      x: (r.left - pageEl.left) / pageEl.width,
      y: (r.top - pageEl.top) / pageEl.height,
      w: r.width / pageEl.width,
      h: r.height / pageEl.height,
    };
  });
}

/** The rendered red box must match the placement rect to within `tol` display units. */
export function expectBoxMatches(box: Box | null, r: { x: number; y: number; width: number; height: number }, tol = 1.5) {
  expect(box, 'signature ink should be present on this page').not.toBeNull();
  expect(Math.abs(box!.x0 - r.x)).toBeLessThanOrEqual(tol);
  expect(Math.abs(box!.y0 - r.y)).toBeLessThanOrEqual(tol);
  expect(Math.abs(box!.x1 - (r.x + r.width))).toBeLessThanOrEqual(tol);
  expect(Math.abs(box!.y1 - (r.y + r.height))).toBeLessThanOrEqual(tol);
}

/** Ink (drawn/typed) must lie inside the placement and fill a decent part of it. */
export function expectInkInside(box: Box | null, r: { x: number; y: number; width: number; height: number }, tol = 2) {
  expect(box, 'signature ink should be present on this page').not.toBeNull();
  expect(box!.x0).toBeGreaterThanOrEqual(r.x - tol);
  expect(box!.y0).toBeGreaterThanOrEqual(r.y - tol);
  expect(box!.x1).toBeLessThanOrEqual(r.x + r.width + tol);
  expect(box!.y1).toBeLessThanOrEqual(r.y + r.height + tol);
  expect(box!.x1 - box!.x0).toBeGreaterThan(r.width * 0.8);
}
