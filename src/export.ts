/**
 * Builds the completed PDF with pdf-lib. The original bytes are never
 * modified; a new file is produced containing:
 *  - the values typed into the PDF's own form fields (with appearance
 *    streams, so every viewer shows them),
 *  - free text and checkmarks placed on the page,
 *  - signatures as transparent images,
 * all drawn in page content at the exact display-space rectangles the editor
 * used. Text, vectors, links and other annotations of the original stay.
 */
import {
  concatTransformationMatrix,
  degrees,
  LineCapStyle,
  LineJoinStyle,
  lineTo,
  moveTo,
  PDFCheckBox,
  PDFDict,
  PDFDocument,
  PDFDropdown,
  PDFName,
  PDFOptionList,
  PDFRadioGroup,
  PDFTextField,
  popGraphicsState,
  pushGraphicsState,
  rgb,
  setLineCap,
  setLineJoin,
  setLineWidth,
  setStrokingRgbColor,
  StandardFonts,
  stroke,
  type PDFField,
  type PDFFont,
  type PDFImage,
  type PDFPage,
} from 'pdf-lib';
import { clampRect, localFrameToPdf, placementToPdf, type PageGeom, type Rect } from './geometry';
import { loadForEditing } from './inspect';
import { isEncodable, LINE_HEIGHT, TEXT_PAD } from './text';
import { CHECK_PATH, CHECK_STROKE } from './placements';

export interface ImageItem {
  kind?: 'image';
  pageIndex: number;
  rect: Rect; // display space, see geometry.ts
  imageId: string;
}
export interface TextItem {
  kind: 'text';
  pageIndex: number;
  rect: Rect;
  text: string;
}
export interface CheckItem {
  kind: 'check';
  pageIndex: number;
  rect: Rect;
}
export type ExportPlacement = ImageItem | TextItem | CheckItem;

export interface ExportImage {
  id: string;
  png: Uint8Array;
}

export interface FieldFill {
  name: string;
  kind: 'text' | 'checkbox' | 'radio' | 'choice';
  value: string;
  /** Text fields: font size the editor showed (0 = leave the field's own). */
  fontSize?: number;
}

export interface ExportOptions {
  fields?: FieldFill[];
  /** Baseline position inside a text box, as a multiple of the font size (from text.ts). */
  baselineRatio?: number;
}

export class ExportError extends Error {}

export async function exportSignedPdf(
  original: Uint8Array,
  geoms: PageGeom[],
  placements: ExportPlacement[],
  images: ExportImage[],
  opts: ExportOptions = {},
): Promise<Uint8Array> {
  const fields = opts.fields ?? [];
  if (placements.length === 0 && fields.length === 0) throw new ExportError('Add your signature to the document first.');
  let doc: PDFDocument;
  try {
    doc = await loadForEditing(original);
  } catch (err) {
    throw new ExportError(`The PDF couldn’t be prepared for saving: ${(err as Error).message}`);
  }
  const pages = doc.getPages();
  if (pages.length !== geoms.length) {
    throw new ExportError('Page count mismatch between preview and export. No file was saved.');
  }

  stripUsageRights(doc);
  const needsFont = fields.some((f) => f.kind === 'text' || f.kind === 'choice') || placements.some((p) => p.kind === 'text');
  const helvetica = needsFont ? await doc.embedFont(StandardFonts.Helvetica) : null;
  fillFields(doc, fields, helvetica);

  const embedded = new Map<string, PDFImage>();
  for (const img of images) {
    if (!placements.some((p) => p.kind !== 'text' && p.kind !== 'check' && p.imageId === img.id)) continue;
    embedded.set(img.id, await doc.embedPng(img.png));
  }

  const ratio = opts.baselineRatio ?? 1.0;
  for (const p of placements) {
    const page = pages[p.pageIndex];
    const geom = geoms[p.pageIndex];
    if (!page || !geom) throw new ExportError('An item refers to a page that doesn’t exist.');
    if (p.kind === 'text') {
      if (p.text.trim()) drawTextItem(page, geom, p, helvetica!, ratio);
    } else if (p.kind === 'check') {
      drawCheck(page, geom, clampRect(geom, p.rect, 1));
    } else {
      const image = embedded.get(p.imageId);
      if (!image) throw new ExportError('A signature placement refers to a missing image.');
      const where = placementToPdf(geom, clampRect(geom, p.rect));
      page.drawImage(image, {
        x: where.x,
        y: where.y,
        width: where.width,
        height: where.height,
        rotate: degrees(where.rotateDegrees),
      });
    }
  }

  const out = await doc.save();

  // Sanity check: the result must parse and keep every page.
  const check = await PDFDocument.load(out, { updateMetadata: false });
  if (check.getPageCount() !== pages.length) {
    throw new ExportError('The saved PDF failed a final check (page count changed). No file was saved.');
  }
  return out;
}

/**
 * Adobe "Reader extensions" (/Perms /UR, /UR3) are signed by Adobe over the
 * original bytes. Any edited copy breaks them and Acrobat Reader then shows a
 * scary "this document has been changed" banner, so drop them. A
 * certification signature (/DocMDP) is the author's and is left alone.
 */
function stripUsageRights(doc: PDFDocument): void {
  const Perms = PDFName.of('Perms');
  const perms = doc.catalog.lookupMaybe(Perms, PDFDict);
  if (!perms) return;
  perms.delete(PDFName.of('UR'));
  perms.delete(PDFName.of('UR3'));
  if (perms.keys().length === 0) doc.catalog.delete(Perms);
}

function fieldLabel(name: string): string {
  return name.replace(/\[\d+\]/g, '').split('.').pop() || name;
}

function fillFields(doc: PDFDocument, fills: FieldFill[], font: PDFFont | null): void {
  const acro = doc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
  if (!acro) {
    if (fills.length) throw new ExportError('This PDF has no form fields to fill.');
    return;
  }
  // getForm() also removes any XFA form data, so every viewer shows the AcroForm
  // fields (and the values typed here) instead of a stale XFA copy.
  const form = doc.getForm();
  for (const f of fills) {
    const field: PDFField | undefined = form.getFieldMaybe(f.name);
    if (!field) throw new ExportError(`A form field (${fieldLabel(f.name)}) couldn’t be found in the PDF.`);
    try {
      if (f.kind === 'text' && field instanceof PDFTextField) {
        const bad = [...f.value].filter((c) => c !== '\n' && !isEncodable(c));
        if (bad.length) throw new Error(`it contains characters the PDF’s standard font can’t show (${[...new Set(bad)].join(' ')})`);
        const max = field.getMaxLength();
        field.setText(f.value === '' ? undefined : max !== undefined ? f.value.slice(0, max) : f.value);
        if (f.fontSize && f.fontSize > 0) field.setFontSize(Math.round(f.fontSize * 100) / 100);
      } else if ((f.kind === 'checkbox' || f.kind === 'radio') && (field instanceof PDFCheckBox || field instanceof PDFRadioGroup)) {
        setButtonValue(field, f.value);
      } else if (f.kind === 'choice' && (field instanceof PDFDropdown || field instanceof PDFOptionList)) {
        if (f.value) field.select(f.value);
        else field.clear();
      } else {
        throw new Error('its type in the file doesn’t match what was shown');
      }
    } catch (err) {
      if (err instanceof ExportError) throw err;
      throw new ExportError(`The field “${fieldLabel(f.name)}” couldn’t be saved: ${(err as Error).message}.`);
    }
  }
  if (font && fills.some((f) => f.kind === 'text' || f.kind === 'choice')) {
    try {
      form.updateFieldAppearances(font);
    } catch (err) {
      throw new ExportError(`The form’s appearance couldn’t be updated: ${(err as Error).message}.`);
    }
  }
}

/**
 * Turn a checkbox / radio field on (value = a widget's on-state name) or off.
 * Works for checkboxes whose widgets have different on-values too.
 */
function setButtonValue(field: PDFCheckBox | PDFRadioGroup, value: string): void {
  const on = value && value !== 'Off' ? PDFName.of(value) : PDFName.of('Off');
  const widgets = field.acroField.getWidgets();
  let matched = on === PDFName.of('Off');
  for (const w of widgets) {
    const state = w.getOnValue();
    const isOn = !!state && state === on;
    if (isOn) matched = true;
    w.setAppearanceState(isOn ? state! : PDFName.of('Off'));
  }
  if (!matched) throw new Error(`no box has the value “${value}”`);
  field.acroField.dict.set(PDFName.of('V'), on);
}

/** Free text: Helvetica, black, its baseline exactly where the editor showed it. */
function drawTextItem(page: PDFPage, g: PageGeom, item: TextItem, font: PDFFont, baselineRatio: number): void {
  const bad = [...item.text].filter((c) => !isEncodable(c));
  if (bad.length) throw new ExportError(`Some text contains characters the PDF’s standard font can’t show (${[...new Set(bad)].join(' ')}).`);
  const rect = clampRect(g, item.rect, 1);
  const size = rect.height / LINE_HEIGHT;
  page.pushOperators(pushGraphicsState(), concatTransformationMatrix(...localFrameToPdf(g, rect)));
  page.drawText(item.text, {
    x: TEXT_PAD * size,
    y: rect.height - baselineRatio * size,
    size,
    font,
    color: rgb(0, 0, 0),
  });
  page.pushOperators(popGraphicsState());
}

function drawCheck(page: PDFPage, g: PageGeom, rect: Rect): void {
  const k = rect.width / 100; // check path is in a 100-unit box, y down
  const pt = ([x, y]: [number, number]): [number, number] => [x * k, rect.height - y * (rect.height / 100)];
  const [first, ...rest] = CHECK_PATH.map(pt);
  page.pushOperators(
    pushGraphicsState(),
    concatTransformationMatrix(...localFrameToPdf(g, rect)),
    setStrokingRgbColor(0, 0, 0),
    setLineWidth(CHECK_STROKE * k),
    setLineCap(LineCapStyle.Round),
    setLineJoin(LineJoinStyle.Round),
    moveTo(...first),
    ...rest.map((q) => lineTo(...q)),
    stroke(),
    popGraphicsState(),
  );
}

export function signedFileName(original: string): string {
  const base = original.replace(/\.pdf$/i, '').trim() || 'document';
  // Strip characters that are invalid in file names on common systems.
  const safe = base.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_');
  return `${safe}-signed.pdf`;
}
