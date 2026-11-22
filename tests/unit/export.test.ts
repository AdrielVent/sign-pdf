import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { exportSignedPdf, ExportError, signedFileName } from '../../src/export';
import { displaySize, normalizeBox, normalizeRotation, type PageGeom, type Rect } from '../../src/geometry';
import { mixedSizes, rotated, solidPng, textMarker, tricky } from '../fixtures/fixtures';
import { imageRectsOnPage, loadWithPdfjs, pageText } from './pdfjs-node';

const png = solidPng(30, 10, [255, 0, 0]);

async function geomsOf(bytes: Uint8Array): Promise<PageGeom[]> {
  const pdf = await loadWithPdfjs(bytes);
  const out: PageGeom[] = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const p = await pdf.getPage(n);
    out.push({ view: normalizeBox(p.view), rotation: normalizeRotation(p.rotate), userUnit: p.userUnit });
  }
  await pdf.loadingTask.destroy();
  return out;
}

/** Placements at four distinct spots per page (corner-ish and centre). */
function samplePlacements(geoms: PageGeom[]) {
  const placements: { pageIndex: number; rect: Rect; imageId: string }[] = [];
  geoms.forEach((g, pageIndex) => {
    const { width, height } = displaySize(g);
    const w = Math.min(90, width / 4);
    const h = w / 3;
    for (const [fx, fy] of [[0.05, 0.05], [0.7, 0.1], [0.1, 0.8], [0.45, 0.5]]) {
      placements.push({ pageIndex, imageId: 'red', rect: { x: fx * width, y: fy * height, width: w, height: h } });
    }
  });
  return placements;
}

describe('exportSignedPdf', () => {
  for (const [name, make] of [['mixed sizes', mixedSizes], ['rotated 0/90/180/270', rotated], ['cropped / negative origin / dirty CTM / UserUnit', tricky]] as const) {
    it(`places images exactly where the editor shows them: ${name}`, async () => {
      const original = await make();
      const before = createHash('sha256').update(original).digest('hex');
      const geoms = await geomsOf(original);
      const placements = samplePlacements(geoms);
      const out = await exportSignedPdf(original, geoms, placements, [{ id: 'red', png }]);

      // original buffer untouched
      expect(createHash('sha256').update(original).digest('hex')).toBe(before);

      // independent check: PDF.js parses the output and we compute where it paints each image
      const pdf = await loadWithPdfjs(out);
      expect(pdf.numPages).toBe(geoms.length);
      for (let i = 0; i < geoms.length; i++) {
        const { rects } = await imageRectsOnPage(pdf, i + 1);
        const expected = placements.filter((p) => p.pageIndex === i).map((p) => p.rect);
        expect(rects).toHaveLength(expected.length);
        expected.forEach((e, k) => {
          const got = rects[k];
          expect(got.x).toBeCloseTo(e.x, 3);
          expect(got.y).toBeCloseTo(e.y, 3);
          expect(got.width).toBeCloseTo(e.width, 3);
          expect(got.height).toBeCloseTo(e.height, 3);
        });
        // searchable text preserved
        expect(await pageText(pdf, i + 1)).toContain(textMarker(i + 1));
      }
      await pdf.loadingTask.destroy();
    });
  }

  it('clamps placements that would fall outside the visible page', async () => {
    const original = await tricky();
    const geoms = await geomsOf(original);
    const out = await exportSignedPdf(original, geoms, [{ pageIndex: 0, imageId: 'red', rect: { x: -50, y: 9999, width: 60, height: 20 } }], [{ id: 'red', png }]);
    const pdf = await loadWithPdfjs(out);
    const { rects } = await imageRectsOnPage(pdf, 1);
    const size = displaySize(geoms[0]);
    expect(rects[0].x).toBeCloseTo(0, 3);
    expect(rects[0].y + rects[0].height).toBeCloseTo(size.height, 3);
  });

  it('refuses to export with no placements', async () => {
    const original = await mixedSizes();
    await expect(exportSignedPdf(original, await geomsOf(original), [], [])).rejects.toBeInstanceOf(ExportError);
  });
});

describe('signedFileName', () => {
  it('appends -signed and keeps the base name', () => {
    expect(signedFileName('lease.pdf')).toBe('lease-signed.pdf');
    expect(signedFileName('Lease Agreement.PDF')).toBe('Lease Agreement-signed.pdf');
    expect(signedFileName('report.v2.pdf')).toBe('report.v2-signed.pdf');
    expect(signedFileName('a/b:c.pdf')).toBe('a_b_c-signed.pdf');
    expect(signedFileName('.pdf')).toBe('document-signed.pdf');
  });
});
