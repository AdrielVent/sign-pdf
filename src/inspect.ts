/**
 * Checks, with the same library used for export (pdf-lib), whether a signed
 * copy of this PDF can be saved, and collects warnings worth showing first.
 */
import { PDFDict, PDFDocument, PDFName } from 'pdf-lib';

export type Inspection =
  | { ok: true; pageCount: number; warnings: string[]; hasDigitalSignature: boolean }
  | { ok: false; kind: 'encrypted' | 'not-exportable'; message: string };

export const DIGITAL_SIGNATURE_WARNING =
  'This PDF appears to contain a digital (certificate) signature. Saving a copy with your signature added will make that existing signature show as invalid or modified. If that matters, ask the sender how they want it signed.';

export const XFA_WARNING =
  'This PDF contains an XFA form. Some viewers, including this one, may not show those form fields as the author intended.';

/** True if any object in the file is a signature dictionary (/Type /Sig, /DocTimeStamp, or has /ByteRange). */
export function hasDigitalSignature(doc: PDFDocument): boolean {
  const Sig = PDFName.of('Sig');
  const DocTimeStamp = PDFName.of('DocTimeStamp');
  const Type = PDFName.of('Type');
  const ByteRange = PDFName.of('ByteRange');
  if (doc.catalog.get(PDFName.of('Perms'))) return true;
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFDict)) continue;
    const type = obj.get(Type);
    if (type === Sig || type === DocTimeStamp) return true;
    if (obj.has(ByteRange)) return true;
  }
  return false;
}

function hasXfa(doc: PDFDocument): boolean {
  const acro = doc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
  return !!acro?.get(PDFName.of('XFA'));
}

export async function loadForEditing(bytes: Uint8Array): Promise<PDFDocument> {
  return PDFDocument.load(bytes, { updateMetadata: false });
}

export async function inspectForEditing(bytes: Uint8Array): Promise<Inspection> {
  let doc: PDFDocument;
  try {
    // Load even if encrypted so we can tell the user exactly why we can't save it.
    doc = await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true });
  } catch (err) {
    return {
      ok: false,
      kind: 'not-exportable',
      message: `This PDF can be previewed, but its internal structure couldn’t be read well enough to save a signed copy (${(err as Error)?.message ?? 'unknown error'}). No changes were made.`,
    };
  }
  if (doc.isEncrypted) {
    return {
      ok: false,
      kind: 'encrypted',
      message:
        'This PDF is encrypted (it has usage restrictions or a password set by its author). It can be viewed, but this tool can’t save a signed copy of an encrypted file. Save or print it to a new unrestricted PDF in your usual PDF app, then try again.',
    };
  }
  const warnings: string[] = [];
  const signed = hasDigitalSignature(doc);
  if (signed) warnings.push(DIGITAL_SIGNATURE_WARNING);
  if (hasXfa(doc)) warnings.push(XFA_WARNING);
  return { ok: true, pageCount: doc.getPageCount(), warnings, hasDigitalSignature: signed };
}
