/**
 * Builds the signed PDF with pdf-lib. The original file is loaded as-is and
 * each signature is drawn as an image XObject in the page content, so text,
 * vectors, links and form fields of the original stay untouched.
 */
import { degrees, PDFDocument, type PDFImage } from 'pdf-lib';
import { clampRect, placementToPdf, type PageGeom, type Rect } from './geometry';
import { loadForEditing } from './inspect';

export interface ExportPlacement {
  pageIndex: number;
  rect: Rect; // display space, see geometry.ts
  imageId: string;
}

export interface ExportImage {
  id: string;
  png: Uint8Array;
}

export class ExportError extends Error {}

export async function exportSignedPdf(
  original: Uint8Array,
  geoms: PageGeom[],
  placements: ExportPlacement[],
  images: ExportImage[],
): Promise<Uint8Array> {
  if (placements.length === 0) throw new ExportError('Add your signature to the document first.');
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

  const embedded = new Map<string, PDFImage>();
  for (const img of images) {
    if (!placements.some((p) => p.imageId === img.id)) continue;
    embedded.set(img.id, await doc.embedPng(img.png));
  }

  for (const p of placements) {
    const page = pages[p.pageIndex];
    const geom = geoms[p.pageIndex];
    const image = embedded.get(p.imageId);
    if (!page || !geom || !image) throw new ExportError('A signature placement refers to a missing page or image.');
    const where = placementToPdf(geom, clampRect(geom, p.rect));
    page.drawImage(image, {
      x: where.x,
      y: where.y,
      width: where.width,
      height: where.height,
      rotate: degrees(where.rotateDegrees),
    });
  }

  const out = await doc.save();

  // Sanity check: the result must parse and keep every page.
  const check = await PDFDocument.load(out, { updateMetadata: false });
  if (check.getPageCount() !== pages.length) {
    throw new ExportError('The saved PDF failed a final check (page count changed). No file was saved.');
  }
  return out;
}

export function signedFileName(original: string): string {
  const base = original.replace(/\.pdf$/i, '').trim() || 'document';
  // Strip characters that are invalid in file names on common systems.
  const safe = base.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_');
  return `${safe}-signed.pdf`;
}
