/**
 * Coordinate model shared by the on-screen editor and the PDF exporter.
 *
 * A placement is stored ONCE, in "display space":
 *   - units are PDF points × UserUnit (i.e. the page at 100% zoom, CSS px = pt)
 *   - origin is the top-left corner of the *visible* page (the effective crop box)
 *   - x grows right, y grows down
 *   - the page's /Rotate has already been applied (what the user sees upright)
 *
 * The editor turns display space into CSS percentages of the page box, so zoom,
 * window size and device pixel ratio never change where a signature sits.
 * The exporter turns display space into PDF user space with `placementToPdf`.
 */

export type Rotation = 0 | 90 | 180 | 270;

/** Page geometry as reported by PDF.js (`page.view`, `page.rotate`, `page.userUnit`). */
export interface PageGeom {
  /** Effective visible box in PDF user space: [xMin, yMin, xMax, yMax]. */
  view: [number, number, number, number];
  rotation: Rotation;
  userUnit: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Parameters for pdf-lib `page.drawImage` (rotation is counter-clockwise about x,y). */
export interface PdfImagePlacement {
  x: number;
  y: number;
  width: number;
  height: number;
  rotateDegrees: number;
}

export function normalizeRotation(r: number): Rotation {
  const n = ((Math.round(r / 90) * 90) % 360 + 360) % 360;
  return n as Rotation;
}

/** Normalise a PDF rectangle so xMin<xMax and yMin<yMax. */
export function normalizeBox(b: readonly number[]): [number, number, number, number] {
  const [a, c, d, e] = b;
  return [Math.min(a, d), Math.min(c, e), Math.max(a, d), Math.max(c, e)];
}

/** Size of the visible page in display units. */
export function displaySize(g: PageGeom): { width: number; height: number } {
  const [x0, y0, x1, y1] = g.view;
  const w = (x1 - x0) * g.userUnit;
  const h = (y1 - y0) * g.userUnit;
  return g.rotation === 90 || g.rotation === 270 ? { width: h, height: w } : { width: w, height: h };
}

/** Display point (u, v) → PDF user-space point (x, y). */
export function displayToPdf(g: PageGeom, u: number, v: number): [number, number] {
  const [x0, y0, x1, y1] = g.view;
  const s = g.userUnit;
  const a = u / s;
  const b = v / s;
  switch (g.rotation) {
    case 0:
      return [x0 + a, y1 - b];
    case 90:
      // Page turned clockwise: top-left on screen is the PDF's bottom-left.
      return [x0 + b, y0 + a];
    case 180:
      return [x1 - a, y0 + b];
    case 270:
      return [x1 - b, y1 - a];
  }
}

/** PDF user-space point (x, y) → display point (u, v). Inverse of displayToPdf. */
export function pdfToDisplay(g: PageGeom, x: number, y: number): [number, number] {
  const [x0, y0, x1, y1] = g.view;
  const s = g.userUnit;
  switch (g.rotation) {
    case 0:
      return [(x - x0) * s, (y1 - y) * s];
    case 90:
      return [(y - y0) * s, (x - x0) * s];
    case 180:
      return [(x1 - x) * s, (y - y0) * s];
    case 270:
      return [(y1 - y) * s, (x1 - x) * s];
  }
}

/**
 * Where to draw an upright-on-screen image in PDF user space.
 * The image's bottom-left corner on screen is (rect.x, rect.y + rect.height);
 * its rightward edge on screen points along PDF direction `rotation` (CCW).
 */
export function placementToPdf(g: PageGeom, rect: Rect): PdfImagePlacement {
  const [x, y] = displayToPdf(g, rect.x, rect.y + rect.height);
  return {
    x,
    y,
    width: rect.width / g.userUnit,
    height: rect.height / g.userUnit,
    rotateDegrees: g.rotation,
  };
}

export const MIN_SIGNATURE_WIDTH = 12; // display units (pt)

/**
 * Keep a rectangle inside the visible page, preserving aspect ratio.
 * If it is larger than the page it is scaled down first.
 */
export function clampRect(g: PageGeom, rect: Rect): Rect {
  const page = displaySize(g);
  let { width, height } = rect;
  const aspect = width / height;
  const minW = Math.min(MIN_SIGNATURE_WIDTH, page.width);
  if (width < minW) {
    width = minW;
    height = width / aspect;
  }
  if (width > page.width) {
    width = page.width;
    height = width / aspect;
  }
  if (height > page.height) {
    height = page.height;
    width = height * aspect;
  }
  const x = Math.min(Math.max(rect.x, 0), page.width - width);
  const y = Math.min(Math.max(rect.y, 0), page.height - height);
  return { x, y, width, height };
}

/** Resize about the top-left corner to a new width, keeping aspect, then clamp. */
export function resizeRect(g: PageGeom, rect: Rect, newWidth: number): Rect {
  const page = displaySize(g);
  const aspect = rect.width / rect.height;
  const maxW = Math.min(page.width - rect.x, (page.height - rect.y) * aspect);
  const w = Math.max(Math.min(newWidth, maxW), Math.min(MIN_SIGNATURE_WIDTH, maxW));
  return clampRect(g, { x: rect.x, y: rect.y, width: w, height: w / aspect });
}

/** Default placement: a signature ~30% of page width, centred on a display point. */
export function defaultRect(g: PageGeom, aspect: number, center?: { x: number; y: number }): Rect {
  const page = displaySize(g);
  const width = Math.min(page.width * 0.3, 220);
  const height = width / aspect;
  const c = center ?? { x: page.width / 2, y: page.height / 2 };
  return clampRect(g, { x: c.x - width / 2, y: c.y - height / 2, width, height });
}

/** Rect as percentages of the page, for CSS positioning (zoom/DPR independent). */
export function rectToPercent(g: PageGeom, r: Rect): { left: number; top: number; width: number; height: number } {
  const p = displaySize(g);
  return {
    left: (r.x / p.width) * 100,
    top: (r.y / p.height) * 100,
    width: (r.width / p.width) * 100,
    height: (r.height / p.height) * 100,
  };
}
