import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PDFCheckBox, PDFDict, PDFDocument, PDFName, PDFTextField } from 'pdf-lib';
import { Util } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { ExportError, exportSignedPdf, type ExportPlacement, type FieldFill } from '../../src/export';
import { displaySize, displayToPdf, localFrameToPdf, normalizeBox, normalizeRotation, pdfToDisplay, placementToPdf, type PageGeom, type Rect } from '../../src/geometry';
import { DIGITAL_SIGNATURE_WARNING, inspectForEditing } from '../../src/inspect';
import { LINE_HEIGHT, TEXT_PAD, isEncodable, sanitizeText } from '../../src/text';
import { flatForm, fw9, rotated, solidPng, tricky } from '../fixtures/fixtures';
import { loadWithPdfjs } from './pdfjs-node';

const png = solidPng(30, 10, [255, 0, 0]);
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const RATIO = 0.97; // any value works: the test checks the exporter honours it

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

type M = [number, number, number, number, number, number];
const apply = (m: M, u: number, v: number): [number, number] => [m[0] * u + m[2] * v + m[4], m[1] * u + m[3] * v + m[5]];

describe('localFrameToPdf', () => {
  it('maps a box’s own corners onto the right page corners for every rotation, crop box and UserUnit', async () => {
    for (const make of [rotated, tricky]) {
      for (const g of await geomsOf(await make())) {
        const size = displaySize(g);
        const r: Rect = { x: size.width * 0.2, y: size.height * 0.3, width: 80, height: 20 };
        const m = localFrameToPdf(g, r);
        // local (0,0) is the bottom-left on screen, exactly where images are anchored
        const img = placementToPdf(g, r);
        expect(apply(m, 0, 0)[0]).toBeCloseTo(img.x, 6);
        expect(apply(m, 0, 0)[1]).toBeCloseTo(img.y, 6);
        // local (w, h) is the top-right on screen
        const [x, y] = apply(m, r.width, r.height);
        const [u, v] = pdfToDisplay(g, x, y);
        expect(u).toBeCloseTo(r.x + r.width, 6);
        expect(v).toBeCloseTo(r.y, 6);
        // and the frame is upright: +x on screen goes right, +y goes up
        const [rx, ry] = apply(m, 1, 0);
        expect(pdfToDisplay(g, rx, ry)[0] - pdfToDisplay(g, ...displayToPdf(g, r.x, r.y + r.height))[0]).toBeCloseTo(1, 6);
      }
    }
  });
});

describe('free text and checkmarks (flat PDFs)', () => {
  for (const [name, make] of [['rotated 0/90/180/270', rotated], ['cropped / negative origin / dirty CTM / UserUnit', tricky], ['flat form', flatForm]] as const) {
    it(`text baseline lands exactly where the editor showed it: ${name}`, async () => {
      const original = await make();
      const geoms = await geomsOf(original);
      const items: ExportPlacement[] = geoms.map((g, pageIndex) => {
        const size = 11;
        const { width, height } = displaySize(g);
        return { kind: 'text', pageIndex, text: `Typed ${pageIndex + 1}`, rect: { x: width * 0.3, y: height * 0.25, width: 60, height: LINE_HEIGHT * size } };
      });
      const out = await exportSignedPdf(original, geoms, items, [], { baselineRatio: RATIO });
      const pdf = await loadWithPdfjs(out);
      for (const [i, it] of items.entries()) {
        const page = await pdf.getPage(i + 1);
        const vp = page.getViewport({ scale: 1 });
        const tc = await page.getTextContent();
        const t = tc.items.find((x) => 'str' in x && x.str === `Typed ${i + 1}`);
        expect(t, `text on page ${i + 1}`).toBeTruthy();
        const m = Util.transform(vp.transform, (t as { transform: number[] }).transform);
        const size = it.rect.height / LINE_HEIGHT;
        expect(m[4]).toBeCloseTo(it.rect.x + TEXT_PAD * size, 3); // left edge
        expect(m[5]).toBeCloseTo(it.rect.y + RATIO * size, 3); // baseline
        expect(Math.hypot(m[2], m[3])).toBeCloseTo(size, 3); // font size
        expect(m[0]).toBeGreaterThan(0); // upright, left to right
        expect(Math.abs(m[1])).toBeLessThan(1e-6);
      }
      await pdf.loadingTask.destroy();
    });
  }

  it('rejects characters the standard font can’t encode instead of writing a broken PDF', async () => {
    const original = await flatForm();
    const geoms = await geomsOf(original);
    await expect(
      exportSignedPdf(original, geoms, [{ kind: 'text', pageIndex: 0, text: 'Hi 😀', rect: { x: 50, y: 50, width: 40, height: 13 } }], []),
    ).rejects.toBeInstanceOf(ExportError);
  });

  it('keeps Latin-1 letters and strips what can’t be saved', () => {
    expect(sanitizeText('José Müller – “quoted” €5')).toEqual({ text: 'José Müller – “quoted” €5', removed: '' });
    expect(sanitizeText('Łukasz 李 😀')).toEqual({ text: 'ukasz  ', removed: 'Ł李😀' });
    expect(sanitizeText('a\nb', true).text).toBe('a\nb');
    expect(isEncodable('\n')).toBe(false);
  });
});

describe('IRS Form W-9 (fw9.pdf, AcroForm + XFA + usage rights)', () => {
  const NAME = 'topmostSubform[0].Page1[0].f1_01[0]';
  const BUSINESS = 'topmostSubform[0].Page1[0].f1_02[0]';
  const INDIVIDUAL = 'topmostSubform[0].Page1[0].Boxes3a-b_ReadOrder[0].c1_1[0]';
  const C_CORP = 'topmostSubform[0].Page1[0].Boxes3a-b_ReadOrder[0].c1_1[1]';
  const SSN1 = 'topmostSubform[0].Page1[0].f1_11[0]';
  const SSN3 = 'topmostSubform[0].Page1[0].f1_13[0]';

  it('opens without a false “digitally signed” or XFA warning', async () => {
    const r = await inspectForEditing(fw9());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.hasDigitalSignature).toBe(false);
      expect(r.warnings).not.toContain(DIGITAL_SIGNATURE_WARNING);
      expect(r.warnings).toEqual([]);
    }
  });

  it('writes field values, checkbox and signature into one PDF and leaves the original untouched', async () => {
    const original = fw9();
    const before = sha(original);
    const geoms = await geomsOf(original);
    const fields: FieldFill[] = [
      { name: NAME, kind: 'text', value: 'Jane Q. Example', fontSize: 9 },
      { name: BUSINESS, kind: 'text', value: 'Example Consulting LLC', fontSize: 9 },
      { name: INDIVIDUAL, kind: 'checkbox', value: '1' },
      { name: SSN1, kind: 'text', value: '123', fontSize: 9 },
      { name: SSN3, kind: 'text', value: '6789', fontSize: 9 },
    ];
    const sig: ExportPlacement = { pageIndex: 0, imageId: 'red', rect: { x: 130, y: 575, width: 120, height: 24 } };
    const out = await exportSignedPdf(original, geoms, [sig], [{ id: 'red', png }], { fields, baselineRatio: RATIO });
    expect(sha(original)).toBe(before);

    // pdf-lib reads the values back
    const doc = await PDFDocument.load(out);
    const form = doc.getForm();
    expect(form.getFields()).toHaveLength(23);
    expect((form.getField(NAME) as PDFTextField).getText()).toBe('Jane Q. Example');
    expect((form.getField(SSN3) as PDFTextField).getText()).toBe('6789');
    expect((form.getField(INDIVIDUAL) as PDFCheckBox).isChecked()).toBe(true);
    expect((form.getField(C_CORP) as PDFCheckBox).isChecked()).toBe(false);
    // the stale XFA copy and Adobe's usage-rights signature are gone
    expect(doc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict)?.get(PDFName.of('XFA'))).toBeUndefined();
    expect(doc.catalog.get(PDFName.of('Perms'))).toBeUndefined();

    // PDF.js (independent reader) sees the same values, and appearances exist
    const pdf = await loadWithPdfjs(out);
    const anns = await (await pdf.getPage(1)).getAnnotations();
    const byName = (n: string) => anns.find((a: { fieldName?: string }) => a.fieldName === n) as { fieldValue: string; hasAppearance: boolean };
    expect(byName(NAME).fieldValue).toBe('Jane Q. Example');
    expect(byName(NAME).hasAppearance).toBe(true);
    expect(byName(INDIVIDUAL).fieldValue).toBe('1');
    expect(byName(C_CORP).fieldValue).toBe('Off');
    await pdf.loadingTask.destroy();
  });

  it('can be signed without filling anything in', async () => {
    const original = fw9();
    const geoms = await geomsOf(original);
    const out = await exportSignedPdf(original, geoms, [{ pageIndex: 0, imageId: 'red', rect: { x: 130, y: 575, width: 120, height: 24 } }], [{ id: 'red', png }]);
    const doc = await PDFDocument.load(out);
    const fields = doc.getForm().getFields();
    expect(fields).toHaveLength(23);
    for (const f of fields) {
      if (f instanceof PDFTextField) expect(f.getText() ?? '').toBe('');
      if (f instanceof PDFCheckBox) expect(f.isChecked()).toBe(false);
    }
    expect(doc.catalog.get(PDFName.of('Perms'))).toBeUndefined();
    expect(doc.getPageCount()).toBe(6);
  });

  it('refuses a field value the standard font can’t show, naming the field', async () => {
    const original = fw9();
    await expect(
      exportSignedPdf(original, await geomsOf(original), [], [], { fields: [{ name: NAME, kind: 'text', value: '李', fontSize: 9 }] }),
    ).rejects.toThrow(/f1_01/);
  });
});
