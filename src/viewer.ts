/**
 * Continuous-scroll page viewer with lazy rendering. Only pages near the
 * viewport get a canvas; far-away canvases are released.
 */
import { AnnotationMode, type PDFDocumentProxy, type RenderTask } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { displaySize, type PageGeom } from './geometry';

const MAX_CANVAS_PIXELS = 12_000_000; // stays under iOS Safari's canvas limit
const MAX_RENDERED = 8;
export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 4;

interface PageView {
  index: number;
  el: HTMLDivElement;
  overlay: HTMLDivElement;
  canvas: HTMLCanvasElement | null;
  renderedZoom: number;
  task: RenderTask | null;
  visible: boolean;
  lastUsed: number;
}

export class Viewer {
  private pages: PageView[] = [];
  private pdf: PDFDocumentProxy | null = null;
  private geoms: PageGeom[] = [];
  private io: IntersectionObserver | null = null;
  private queueTimer = 0;
  private rendering = false;
  private fit = true;
  zoom = 1;
  onPageChange: (index: number) => void = () => {};
  onZoomChange: (zoom: number, fit: boolean) => void = () => {};

  constructor(
    readonly scroller: HTMLElement,
    private readonly container: HTMLElement,
  ) {
    scroller.addEventListener('scroll', () => this.reportPage(), { passive: true });
    new ResizeObserver(() => {
      if (this.fit && this.pdf) this.applyZoom(this.fitZoom(), true);
    }).observe(scroller);
  }

  get pageCount(): number {
    return this.pages.length;
  }

  overlay(index: number): HTMLDivElement {
    return this.pages[index].overlay;
  }

  pageElement(index: number): HTMLDivElement {
    return this.pages[index].el;
  }

  load(pdf: PDFDocumentProxy, geoms: PageGeom[]): void {
    this.clear();
    this.pdf = pdf;
    this.geoms = geoms;
    this.io = new IntersectionObserver((entries) => this.onIntersect(entries), {
      root: this.scroller,
      rootMargin: '100% 0px',
    });
    geoms.forEach((g, index) => {
      const el = document.createElement('div');
      el.className = 'page';
      el.dataset.page = String(index);
      el.setAttribute('role', 'region');
      el.setAttribute('aria-label', `Page ${index + 1} of ${geoms.length}`);
      const size = displaySize(g);
      el.style.aspectRatio = `${size.width} / ${size.height}`;
      const overlay = document.createElement('div');
      overlay.className = 'overlay';
      el.append(overlay);
      this.container.append(el);
      this.io!.observe(el);
      this.pages.push({ index, el, overlay, canvas: null, renderedZoom: 0, task: null, visible: false, lastUsed: 0 });
    });
    this.fit = true;
    this.applyZoom(this.fitZoom(), true);
    this.scroller.scrollTop = 0;
  }

  clear(): void {
    this.io?.disconnect();
    this.io = null;
    for (const p of this.pages) p.task?.cancel();
    this.pages = [];
    this.container.replaceChildren();
    this.pdf = null;
    this.geoms = [];
  }

  private fitZoom(): number {
    const style = getComputedStyle(this.container);
    const pad = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
    const avail = Math.max(120, this.scroller.clientWidth - pad);
    const widest = Math.max(...this.geoms.map((g) => displaySize(g).width));
    return clampZoom(Math.min(avail / widest, 1.5));
  }

  setZoom(z: number | 'fit'): void {
    if (!this.pdf) return;
    if (z === 'fit') {
      this.fit = true;
      this.applyZoom(this.fitZoom(), true);
    } else {
      this.fit = false;
      this.applyZoom(clampZoom(z), false);
    }
  }

  private applyZoom(z: number, fit: boolean): void {
    // Keep the same spot of the current page in view across zoom changes.
    const anchorIndex = this.currentPage();
    const anchor = this.pages[anchorIndex]?.el;
    const frac = anchor ? (this.scroller.scrollTop - anchor.offsetTop) / Math.max(anchor.offsetHeight, 1) : 0;
    this.zoom = z;
    this.pages.forEach((p, i) => {
      p.el.style.width = `${Math.round(displaySize(this.geoms[i]).width * z)}px`;
    });
    if (anchor) this.scroller.scrollTop = anchor.offsetTop + frac * anchor.offsetHeight;
    this.onZoomChange(z, fit);
    this.scheduleRender();
  }

  currentPage(): number {
    if (!this.pages.length) return 0;
    const top = this.scroller.scrollTop;
    const mid = top + this.scroller.clientHeight / 3;
    let best = 0;
    for (const p of this.pages) {
      if (p.el.offsetTop <= mid) best = p.index;
      else break;
    }
    return best;
  }

  scrollToPage(index: number): void {
    const p = this.pages[Math.max(0, Math.min(index, this.pages.length - 1))];
    if (!p) return;
    this.scroller.scrollTop = p.el.offsetTop - 12;
    this.reportPage();
  }

  private lastReported = -1;
  private reportPage(): void {
    const i = this.currentPage();
    if (i !== this.lastReported) {
      this.lastReported = i;
      this.onPageChange(i);
    }
  }

  private onIntersect(entries: IntersectionObserverEntry[]): void {
    for (const e of entries) {
      const idx = Number((e.target as HTMLElement).dataset.page);
      const p = this.pages[idx];
      if (p) p.visible = e.isIntersecting;
    }
    this.scheduleRender();
  }

  private scheduleRender(): void {
    clearTimeout(this.queueTimer);
    this.queueTimer = window.setTimeout(() => void this.renderNext(), 30);
  }

  private async renderNext(): Promise<void> {
    if (this.rendering || !this.pdf) return;
    const current = this.currentPage();
    const todo = this.pages
      .filter((p) => p.visible && p.renderedZoom !== this.zoom)
      .sort((a, b) => Math.abs(a.index - current) - Math.abs(b.index - current))[0];
    if (!todo) {
      this.evict();
      return;
    }
    this.rendering = true;
    const pdf = this.pdf;
    try {
      await this.renderPage(todo);
    } catch (err) {
      if ((err as Error)?.name !== 'RenderingCancelledException') console.error(err);
    } finally {
      this.rendering = false;
      if (this.pdf === pdf) this.scheduleRender();
    }
  }

  private async renderPage(p: PageView): Promise<void> {
    const pdf = this.pdf!;
    const zoom = this.zoom;
    const page = await pdf.getPage(p.index + 1);
    const dpr = window.devicePixelRatio || 1;
    let scale = zoom * dpr;
    const base = page.getViewport({ scale: 1 });
    const pixels = base.width * base.height * scale * scale;
    if (pixels > MAX_CANVAS_PIXELS) scale *= Math.sqrt(MAX_CANVAS_PIXELS / pixels);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    canvas.className = 'page-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    // ENABLE_STORAGE: paint annotations as when printing, but form fields use the
    // values in pdf.annotationStorage, which forms.ts blanks for every field it
    // covers with a live input (so values never show twice).
    p.task = page.render({ canvas, viewport, annotationMode: AnnotationMode.ENABLE_STORAGE });
    await p.task.promise;
    p.task = null;
    if (this.pdf !== pdf) return;
    // Swap in the new canvas only when it's finished, so zooming never flashes white.
    if (p.canvas) p.canvas.replaceWith(canvas);
    else p.el.prepend(canvas);
    releaseCanvas(p.canvas);
    p.canvas = canvas;
    p.renderedZoom = zoom;
    p.lastUsed = performance.now();
    p.el.classList.add('rendered');
  }

  private evict(): void {
    const rendered = this.pages.filter((p) => p.canvas);
    if (rendered.length <= MAX_RENDERED) return;
    rendered
      .filter((p) => !p.visible)
      .sort((a, b) => a.lastUsed - b.lastUsed)
      .slice(0, rendered.length - MAX_RENDERED)
      .forEach((p) => {
        p.canvas?.remove();
        releaseCanvas(p.canvas);
        p.canvas = null;
        p.renderedZoom = 0;
        p.el.classList.remove('rendered');
      });
  }

  renderedCount(): number {
    return this.pages.filter((p) => p.canvas).length;
  }
}

export function clampZoom(z: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
}

function releaseCanvas(c: HTMLCanvasElement | null): void {
  if (!c) return;
  c.width = 0;
  c.height = 0;
}
