import { describe, expect, it } from 'vitest';
import {
  clampRect,
  defaultRect,
  displaySize,
  displayToPdf,
  normalizeBox,
  normalizeRotation,
  pdfToDisplay,
  placementToPdf,
  rectToPercent,
  resizeRect,
  type PageGeom,
  type Rotation,
} from '../../src/geometry';
import { mixedSizes, rotated, tricky } from '../fixtures/fixtures';
import { loadWithPdfjs } from './pdfjs-node';

const ROTATIONS: Rotation[] = [0, 90, 180, 270];
const geom = (rotation: Rotation, view: PageGeom['view'] = [0, 0, 612, 792], userUnit = 1): PageGeom => ({ view, rotation, userUnit });

describe('normalizeRotation / normalizeBox', () => {
  it('normalises any multiple of 90', () => {
    expect([0, 90, 180, 270, 360, 450, -90, -180, -270].map(normalizeRotation)).toEqual([0, 90, 180, 270, 0, 90, 270, 180, 90]);
  });
  it('orders box corners', () => {
    expect(normalizeBox([612, 792, 0, 0])).toEqual([0, 0, 612, 792]);
  });
});

describe('displaySize', () => {
  it('swaps width and height for 90/270', () => {
    expect(displaySize(geom(0))).toEqual({ width: 612, height: 792 });
    expect(displaySize(geom(90))).toEqual({ width: 792, height: 612 });
    expect(displaySize(geom(180))).toEqual({ width: 612, height: 792 });
    expect(displaySize(geom(270))).toEqual({ width: 792, height: 612 });
  });
  it('uses the crop box and UserUnit', () => {
    expect(displaySize(geom(0, [100, 50, 400, 450], 2))).toEqual({ width: 600, height: 800 });
  });
});

describe('display ↔ PDF corner mapping', () => {
  const view: PageGeom['view'] = [10, 20, 110, 220]; // 100 × 200, non-zero origin
  it('maps the visible top-left corner correctly for each rotation', () => {
    expect(displayToPdf(geom(0, view), 0, 0)).toEqual([10, 220]); // PDF top-left
    expect(displayToPdf(geom(90, view), 0, 0)).toEqual([10, 20]); // PDF bottom-left
    expect(displayToPdf(geom(180, view), 0, 0)).toEqual([110, 20]); // PDF bottom-right
    expect(displayToPdf(geom(270, view), 0, 0)).toEqual([110, 220]); // PDF top-right
  });
  it('round-trips random points', () => {
    for (const r of ROTATIONS) {
      for (const uu of [1, 2]) {
        const g = geom(r, view, uu);
        const { width, height } = displaySize(g);
        for (let i = 0; i < 50; i++) {
          const u = Math.random() * width;
          const v = Math.random() * height;
          const [x, y] = displayToPdf(g, u, v);
          const [u2, v2] = pdfToDisplay(g, x, y);
          expect(u2).toBeCloseTo(u, 9);
          expect(v2).toBeCloseTo(v, 9);
        }
      }
    }
  });
});

describe('placementToPdf', () => {
  it('rotates the image with the page so it appears upright', () => {
    const rect = { x: 50, y: 60, width: 120, height: 40 };
    for (const r of ROTATIONS) {
      const p = placementToPdf(geom(r), rect);
      expect(p.rotateDegrees).toBe(r);
      expect(p.width).toBe(120);
      expect(p.height).toBe(40);
      // image origin = on-screen bottom-left corner of the rect
      expect([p.x, p.y]).toEqual(displayToPdf(geom(r), 50, 100));
    }
  });
  it('divides by UserUnit', () => {
    const p = placementToPdf(geom(0, [0, 0, 300, 400], 2), { x: 20, y: 40, width: 100, height: 50 });
    expect(p).toMatchObject({ x: 10, y: 400 - 45, width: 50, height: 25 });
  });
});

describe('agrees with PDF.js viewport transform', () => {
  for (const [name, make] of [['mixed sizes', mixedSizes], ['rotated', rotated], ['tricky boxes', tricky]] as const) {
    it(name, async () => {
      const pdf = await loadWithPdfjs(await make());
      for (let n = 1; n <= pdf.numPages; n++) {
        const page = await pdf.getPage(n);
        const g: PageGeom = { view: normalizeBox(page.view), rotation: normalizeRotation(page.rotate), userUnit: page.userUnit };
        for (const zoom of [0.5, 1, 2.75]) {
          const vp = page.getViewport({ scale: zoom });
          const size = displaySize(g);
          expect(vp.width).toBeCloseTo(size.width * zoom, 6);
          expect(vp.height).toBeCloseTo(size.height * zoom, 6);
          for (const [fu, fv] of [[0, 0], [1, 0], [0, 1], [1, 1], [0.3, 0.7]]) {
            const u = fu * size.width;
            const v = fv * size.height;
            const [px, py] = vp.convertToPdfPoint(u * zoom, v * zoom);
            const [x, y] = displayToPdf(g, u, v);
            expect(x).toBeCloseTo(px, 6);
            expect(y).toBeCloseTo(py, 6);
          }
        }
      }
      await pdf.loadingTask.destroy();
    });
  }
});

describe('clampRect / resizeRect / defaultRect', () => {
  const g = geom(90, [0, 0, 300, 500]); // display 500 × 300
  it('keeps rects inside the visible page', () => {
    expect(clampRect(g, { x: -40, y: -10, width: 100, height: 50 })).toEqual({ x: 0, y: 0, width: 100, height: 50 });
    expect(clampRect(g, { x: 480, y: 290, width: 100, height: 50 })).toEqual({ x: 400, y: 250, width: 100, height: 50 });
  });
  it('shrinks oversized rects, preserving aspect ratio', () => {
    const r = clampRect(g, { x: 0, y: 0, width: 1000, height: 500 });
    expect(r.width).toBeCloseTo(500);
    expect(r.height).toBeCloseTo(250);
    const t = clampRect(g, { x: 0, y: 0, width: 300, height: 600 });
    expect(t.height).toBeCloseTo(300);
    expect(t.width).toBeCloseTo(150);
  });
  it('resizes proportionally and stops at the page edge', () => {
    const r = resizeRect(g, { x: 400, y: 10, width: 50, height: 25 }, 400);
    expect(r.width).toBeCloseTo(100);
    expect(r.height).toBeCloseTo(50);
    expect(r.x + r.width).toBeLessThanOrEqual(500 + 1e-9);
    const s = resizeRect(g, { x: 10, y: 10, width: 50, height: 25 }, 1);
    expect(s.width).toBeGreaterThanOrEqual(12);
    expect(s.width / s.height).toBeCloseTo(2);
  });
  it('default placement is centred and inside the page', () => {
    const r = defaultRect(g, 3, { x: 250, y: 150 });
    expect(r.x + r.width / 2).toBeCloseTo(250);
    expect(r.y + r.height / 2).toBeCloseTo(150);
    const edge = defaultRect(g, 3, { x: 0, y: 0 });
    expect(edge.x).toBe(0);
    expect(edge.y).toBe(0);
  });
  it('percent positioning does not depend on zoom', () => {
    const pc = rectToPercent(g, { x: 125, y: 75, width: 50, height: 30 });
    expect(pc).toEqual({ left: 25, top: 25, width: 10, height: 10 });
  });
});
