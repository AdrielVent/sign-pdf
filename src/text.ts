/**
 * Text that the user types onto the page or into form fields.
 *
 * The exported PDF uses the standard Helvetica font (WinAnsi encoding). On
 * screen we use Arial/Helvetica, which have the same advance widths, and we
 * measure the actual on-screen font's ascent/descent so the exported baseline
 * sits exactly where the text was shown.
 */

export const TEXT_FONT_CSS = 'Arial, Helvetica, "Liberation Sans", "Helvetica Neue", sans-serif';
/** Box height as a multiple of the font size. */
export const LINE_HEIGHT = 1.3;
/** Horizontal padding inside a text box, as a multiple of the font size. */
export const TEXT_PAD = 0.15;
export const DEFAULT_TEXT_SIZE = 10; // pt, like Acrobat Fill & Sign's default
export const MIN_TEXT_SIZE = 4;

let ctx: CanvasRenderingContext2D | null = null;
function measureCtx(): CanvasRenderingContext2D {
  if (!ctx) ctx = document.createElement('canvas').getContext('2d')!;
  return ctx;
}

/** Width of `text` at `size` in the on-screen text font (same advances as Helvetica). */
export function measureText(text: string, size: number): number {
  const c = measureCtx();
  c.font = `100px ${TEXT_FONT_CSS}`;
  return (c.measureText(text).width / 100) * size;
}

let baselineRatioCache: number | null = null;
/**
 * Distance from the top of a text box to the text baseline, as a multiple of
 * the font size, for a box whose CSS line-height equals its height
 * (LINE_HEIGHT × size). This mirrors how the browser centres the font's
 * content area in the line box.
 */
export function baselineRatio(): number {
  if (baselineRatioCache !== null) return baselineRatioCache;
  let ascent = 0.905;
  let descent = 0.212; // Arial's metrics, used if the browser can't tell us
  try {
    const c = measureCtx();
    c.font = `100px ${TEXT_FONT_CSS}`;
    const m = c.measureText('Hg');
    if (m.fontBoundingBoxAscent > 0 && m.fontBoundingBoxDescent > 0) {
      ascent = m.fontBoundingBoxAscent / 100;
      descent = m.fontBoundingBoxDescent / 100;
    }
  } catch {
    /* keep defaults */
  }
  baselineRatioCache = (LINE_HEIGHT - (ascent + descent)) / 2 + ascent;
  return baselineRatioCache;
}

/** Size of a single-line text box holding `text` at `size`. */
export function textBoxSize(text: string, size: number): { width: number; height: number } {
  return { width: measureText(text || ' ', size) + 2 * TEXT_PAD * size, height: LINE_HEIGHT * size };
}

// Characters the standard PDF fonts can encode (WinAnsiEncoding).
const WIN_ANSI_EXTRA = new Set(
  '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ'.split(''),
);
export function isEncodable(ch: string): boolean {
  const c = ch.codePointAt(0)!;
  return (c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xff) || WIN_ANSI_EXTRA.has(ch);
}

/** Remove characters the PDF's standard font can't show (emoji, most non-Latin scripts). */
export function sanitizeText(text: string, multiline = false): { text: string; removed: string } {
  let out = '';
  let removed = '';
  const flat = multiline ? text.replace(/\r\n?/g, '\n').replace(/\t/g, ' ') : text.replace(/[\t\r\n]+/g, ' ');
  for (const ch of flat) {
    if (isEncodable(ch) || (multiline && ch === '\n')) out += ch;
    else removed += ch;
  }
  return { text: out, removed };
}
