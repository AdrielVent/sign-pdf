/**
 * Checks, with the same library used for export (pdf-lib), whether a signed
 * copy of this PDF can be saved, and collects warnings worth showing first.
 */
import { PDFArray, PDFBool, PDFDict, PDFDocument, PDFName, PDFRef } from 'pdf-lib';

export type Inspection =
  | { ok: true; pageCount: number; warnings: string[]; hasDigitalSignature: boolean }
  | { ok: false; kind: 'encrypted' | 'not-exportable'; message: string };

export const DIGITAL_SIGNATURE_WARNING =
  'This PDF appears to contain a digital (certificate) signature. Saving a copy with your signature added will make that existing signature show as invalid or modified. If that matters, ask the sender how they want it signed.';

export const XFA_WARNING =
  'This PDF uses an XFA (LiveCycle) form that only some viewers can show. Its form fields may not appear here; you can still add text and your signature on the page.';

/**
 * True if the file carries a certificate signature: any signature dictionary
 * (/Type /Sig, /DocTimeStamp, or with /ByteRange) or a certification (/DocMDP).
 * Adobe "Reader extensions" usage rights (/Perms /UR, /UR3) are not the
 * sender's signature; they only unlock features in old Acrobat Reader, and
 * are removed on export, so they don't count.
 */
export function hasDigitalSignature(doc: PDFDocument): boolean {
  const Sig = PDFName.of('Sig');
  const DocTimeStamp = PDFName.of('DocTimeStamp');
  const Type = PDFName.of('Type');
  const ByteRange = PDFName.of('ByteRange');
  const perms = doc.catalog.lookupMaybe(PDFName.of('Perms'), PDFDict);
  if (perms?.has(PDFName.of('DocMDP'))) return true;
  const usageRights = new Set<unknown>();
  for (const key of ['UR', 'UR3']) {
    const ref = perms?.get(PDFName.of(key));
    if (ref) usageRights.add(ref instanceof PDFRef ? doc.context.lookup(ref) : ref);
  }
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFDict) || usageRights.has(obj)) continue;
    const type = obj.get(Type);
    if (type === Sig || type === DocTimeStamp) return true;
    if (obj.has(ByteRange)) return true;
  }
  return false;
}

/**
 * True for XFA-only ("dynamic") forms. Hybrid forms such as the IRS W-9 also
 * contain normal AcroForm fields, which this app fills; the exporter removes
 * the XFA copy so every viewer shows those fields.
 */
function isXfaOnly(doc: PDFDocument): boolean {
  const acro = doc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
  if (!acro?.get(PDFName.of('XFA'))) return false;
  if (doc.catalog.lookupMaybe(PDFName.of('NeedsRendering'), PDFBool)?.asBoolean()) return true;
  const fields = acro.lookupMaybe(PDFName.of('Fields'), PDFArray);
  return !fields || fields.size() === 0;
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
  if (isXfaOnly(doc)) warnings.push(XFA_WARNING);
  return { ok: true, pageCount: doc.getPageCount(), warnings, hasDigitalSignature: signed };
}
