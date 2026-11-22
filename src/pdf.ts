/**
 * PDF.js setup and document opening. Everything here runs locally; the worker
 * and its data files are served from this site (see scripts/copy-pdfjs-assets.mjs).
 */
import {
  getDocument,
  GlobalWorkerOptions,
  InvalidPDFException,
  PasswordException,
  type PDFDocumentProxy,
} from 'pdfjs-dist/legacy/build/pdf.mjs';
import { inspectForEditing } from './inspect';
import { normalizeBox, normalizeRotation, type PageGeom } from './geometry';

const assetBase = new URL('pdfjs/', document.baseURI);

let workerReady = false;
/**
 * Start the PDF.js worker as soon as the app loads, so opening and rendering a
 * document keeps working even if the network goes away afterwards.
 */
export function startPdfWorker(): void {
  if (workerReady) return;
  try {
    GlobalWorkerOptions.workerPort = new Worker(new URL('pdf.worker.min.js', assetBase), {
      type: 'module',
    });
  } catch {
    GlobalWorkerOptions.workerSrc = new URL('pdf.worker.min.js', assetBase).href;
  }
  workerReady = true;
}

export class OpenError extends Error {
  constructor(
    message: string,
    readonly kind: 'not-pdf' | 'corrupt' | 'password' | 'encrypted' | 'not-exportable' | 'empty',
  ) {
    super(message);
  }
}

export interface LoadedDocument {
  name: string;
  /** Untouched original bytes (never transferred to the worker). */
  bytes: Uint8Array;
  pdf: PDFDocumentProxy;
  geoms: PageGeom[];
  warnings: string[];
}

function looksLikePdf(bytes: Uint8Array): boolean {
  // The header may be preceded by junk; readers accept it within the first 1 KB.
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 1024));
  return head.includes('%PDF-');
}

export async function openPdf(file: File): Promise<LoadedDocument> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length === 0) throw new OpenError('This file is empty.', 'empty');
  if (!looksLikePdf(bytes)) {
    throw new OpenError(
      `“${file.name}” isn’t a PDF. Choose a file that ends in .pdf.`,
      'not-pdf',
    );
  }

  let pdf: PDFDocumentProxy;
  try {
    pdf = await getDocument({
      // PDF.js transfers its buffer to the worker, so give it a copy.
      data: bytes.slice(),
      cMapUrl: new URL('cmaps/', assetBase).href,
      cMapPacked: true,
      standardFontDataUrl: new URL('standard_fonts/', assetBase).href,
      wasmUrl: new URL('wasm/', assetBase).href,
      iccUrl: new URL('iccs/', assetBase).href,
      enableXfa: false,
      disableWorkerRendering: true,
    }).promise;
  } catch (err) {
    if (err instanceof PasswordException) {
      throw new OpenError(
        'This PDF is password-protected. Open it in your usual PDF app, save a copy without a password, then open that copy here.',
        'password',
      );
    }
    if (err instanceof InvalidPDFException) {
      throw new OpenError(
        'This PDF is damaged or incomplete, so it can’t be opened. Try downloading it again.',
        'corrupt',
      );
    }
    throw new OpenError(
      `This PDF couldn’t be opened (${(err as Error)?.message ?? 'unknown error'}).`,
      'corrupt',
    );
  }

  // Before the user signs anything, make sure we can actually save a copy.
  const inspection = await inspectForEditing(bytes);
  if (!inspection.ok) {
    await pdf.loadingTask.destroy();
    throw new OpenError(inspection.message, inspection.kind);
  }
  if (inspection.pageCount !== pdf.numPages) {
    await pdf.loadingTask.destroy();
    throw new OpenError(
      'This PDF can be previewed, but its page structure is unusual and a signed copy couldn’t be saved reliably. No changes were made.',
      'not-exportable',
    );
  }

  const geoms: PageGeom[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    geoms.push({
      view: normalizeBox(page.view),
      rotation: normalizeRotation(page.rotate),
      userUnit: page.userUnit || 1,
    });
  }

  return { name: file.name, bytes, pdf, geoms, warnings: inspection.warnings };
}
