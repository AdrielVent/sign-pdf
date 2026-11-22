/**
 * Test fixtures, generated from code. No private or third-party documents.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import {
  PDFArray,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFString,
  StandardFonts,
  degrees,
  rgb,
  type PDFFont,
  type PDFPage,
} from 'pdf-lib';

export const FIXTURE_DIR = join(import.meta.dirname, 'generated');

export const textMarker = (n: number) => `SIGNPDF-TEXT-${n}`;

function decorate(page: PDFPage, font: PDFFont, n: number, label: string): void {
  const { x, y, width, height } = page.getMediaBox();
  // light grey frame + label; drawn in user space, so it rotates with the page
  page.drawRectangle({ x: x + 10, y: y + 10, width: width - 20, height: height - 20, borderColor: rgb(0.8, 0.8, 0.8), borderWidth: 1 });
  page.drawText(label, { x: x + 36, y: y + height - 60, size: 14, font, color: rgb(0, 0, 0) });
  // searchable marker near the centre, so it is inside every crop box used below
  page.drawText(textMarker(n), { x: x + width / 2 - 50, y: y + height / 2, size: 10, font, color: rgb(0, 0, 0) });
  page.drawText('Signature: ____________________', { x: x + 36, y: y + 80, size: 12, font, color: rgb(0, 0, 0) });
}

/** 3 pages of different sizes: Letter, A4, Letter landscape. */
export async function mixedSizes(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const sizes: [number, number, string][] = [
    [612, 792, 'Letter portrait'],
    [595.28, 841.89, 'A4 portrait'],
    [792, 612, 'Letter landscape'],
  ];
  sizes.forEach(([w, h, label], i) => decorate(doc.addPage([w, h]), font, i + 1, label));
  return doc.save();
}

/** 4 pages with /Rotate 0, 90, 180, 270. */
export async function rotated(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  [0, 90, 180, 270].forEach((r, i) => {
    const page = doc.addPage([612, 792]);
    decorate(page, font, i + 1, `Rotate ${r}`);
    page.setRotation(degrees(r));
  });
  return doc.save();
}

/**
 * Pages with unusual boxes and state:
 *  1. CropBox with non-zero origin inside the MediaBox
 *  2. MediaBox with a negative origin + CropBox + /Rotate 90
 *  3. Content stream that leaves a scaled/translated CTM (no q/Q)
 *  4. /UserUnit 2
 *  5. CropBox + /Rotate 270
 */
export async function tricky(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);

  const p1 = doc.addPage([612, 792]);
  decorate(p1, font, 1, 'Cropped');
  p1.setCropBox(72, 144, 468, 556);

  const p2 = doc.addPage([612, 792]);
  p2.setMediaBox(-200, -100, 612, 792);
  decorate(p2, font, 2, 'Negative origin');
  p2.setCropBox(-150, -50, 500, 650);
  p2.setRotation(degrees(90));

  const p3 = doc.addPage([612, 792]);
  decorate(p3, font, 3, 'Dirty CTM');
  // Append raw operators that change the CTM without restoring it.
  const dirty = doc.context.flateStream('0.5 0 0 0.5 100 100 cm 1 0 0 1 20 20 cm');
  p3.node.addContentStream(doc.context.register(dirty));

  const p4 = doc.addPage([300, 400]);
  decorate(p4, font, 4, 'UserUnit 2');
  p4.node.set(PDFName.of('UserUnit'), PDFNumber.of(2));

  const p5 = doc.addPage([612, 792]);
  decorate(p5, font, 5, 'Cropped rotated');
  p5.setCropBox(50, 100, 400, 500);
  p5.setRotation(degrees(270));

  return doc.save();
}

/** Many pages, for lazy-rendering checks. */
export async function manyPages(count = 60): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= count; i++) decorate(doc.addPage([612, 792]), font, i, `Page ${i}`);
  return doc.save();
}

/** A PDF containing a (dummy) certificate signature field and value. */
export async function digitallySigned(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  decorate(page, font, 1, 'Digitally signed');
  const ctx = doc.context;
  const sigValue = ctx.register(
    ctx.obj({
      Type: 'Sig',
      Filter: 'Adobe.PPKLite',
      SubFilter: 'adbe.pkcs7.detached',
      ByteRange: [0, 100, 200, 300],
      Contents: PDFHexString.of('00'.repeat(64)),
      M: PDFString.of('D:20260101000000Z'),
    }),
  );
  const field = ctx.register(
    ctx.obj({ FT: 'Sig', T: PDFString.of('Signature1'), V: sigValue, Type: 'Annot', Subtype: 'Widget', Rect: [0, 0, 0, 0], F: 132, P: page.ref }),
  );
  page.node.set(PDFName.of('Annots'), ctx.obj([field]));
  doc.catalog.set(PDFName.of('AcroForm'), ctx.obj({ Fields: ctx.obj([field]) as PDFArray, SigFlags: 3 }));
  return doc.save({ useObjectStreams: false });
}

/**
 * A file whose trailer declares Standard-handler encryption with a user
 * password we don't know: viewers ask for a password, as with a real
 * password-protected PDF.
 */
export async function passwordProtected(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  decorate(doc.addPage([612, 792]), font, 1, 'Encrypted');
  const ctx = doc.context;
  const rnd = (n: number, seed: number) => Array.from({ length: n }, (_, i) => ((i * 37 + seed) % 256).toString(16).padStart(2, '0')).join('');
  const enc = ctx.register(
    ctx.obj({ Filter: 'Standard', V: 1, R: 2, Length: 40, P: -4, O: PDFHexString.of(rnd(32, 11)), U: PDFHexString.of(rnd(32, 99)) }),
  );
  ctx.trailerInfo.Encrypt = enc;
  ctx.trailerInfo.ID = ctx.obj([PDFHexString.of(rnd(16, 5)), PDFHexString.of(rnd(16, 5))]);
  return doc.save({ useObjectStreams: false });
}

export function notAPdf(): Uint8Array {
  return new TextEncoder().encode('Hello, this is a plain text file pretending to be a PDF.\n');
}

export function corruptPdf(): Uint8Array {
  const junk = Array.from({ length: 2000 }, (_, i) => String.fromCharCode(33 + ((i * 7919) % 90))).join('');
  return new TextEncoder().encode(`%PDF-1.7\n${junk}\n`);
}

/** Solid-colour RGBA PNG (no external encoder needed). */
export function solidPng(width: number, height: number, [r, g, b]: [number, number, number]): Uint8Array {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      const o = row + 1 + x * 4;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
      raw[o + 3] = 255;
    }
  }
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(raw)),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  );
}

export async function writeAllFixtures(): Promise<Record<string, string>> {
  mkdirSync(FIXTURE_DIR, { recursive: true });
  const files: Record<string, Uint8Array> = {
    'mixed-sizes.pdf': await mixedSizes(),
    'rotated.pdf': await rotated(),
    'tricky.pdf': await tricky(),
    'many-pages.pdf': await manyPages(),
    'digitally-signed.pdf': await digitallySigned(),
    'password.pdf': await passwordProtected(),
    'not-a-pdf.pdf': notAPdf(),
    'corrupt.pdf': corruptPdf(),
    'red-signature.png': solidPng(300, 100, [255, 0, 0]),
  };
  const out: Record<string, string> = {};
  for (const [name, bytes] of Object.entries(files)) {
    const p = join(FIXTURE_DIR, name);
    writeFileSync(p, bytes);
    out[name] = p;
  }
  return out;
}
