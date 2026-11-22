/**
 * On-page signature placements: drag to move, corner handle to resize
 * (proportionally), keyboard alternatives, duplicate and delete.
 * Positions live in display space (geometry.ts) and are rendered as
 * percentages of the page box.
 */
import { clampRect, defaultRect, displaySize, rectToPercent, resizeRect, type PageGeom, type Rect } from './geometry';

export interface Placement {
  id: string;
  pageIndex: number;
  rect: Rect;
  assetId: string;
}

export interface PlacementHost {
  geom(pageIndex: number): PageGeom;
  overlay(pageIndex: number): HTMLElement;
  assetUrl(assetId: string): string;
  announce(msg: string): void;
  changed(): void;
}

let seq = 0;

export class PlacementLayer {
  readonly items: Placement[] = [];
  private els = new Map<string, HTMLElement>();
  private selected: string | null = null;

  constructor(private host: PlacementHost) {
    document.addEventListener('pointerdown', (e) => {
      const t = e.target as HTMLElement;
      if (!t.closest('.placement')) this.select(null);
    });
  }

  clear(): void {
    for (const el of this.els.values()) el.remove();
    this.els.clear();
    this.items.length = 0;
    this.selected = null;
  }

  add(pageIndex: number, assetId: string, aspect: number, center?: { x: number; y: number }): Placement {
    const g = this.host.geom(pageIndex);
    const p: Placement = { id: `pl-${++seq}`, pageIndex, assetId, rect: this.freeSpot(g, pageIndex, defaultRect(g, aspect, center)) };
    this.items.push(p);
    this.mount(p);
    this.select(p.id, true);
    this.host.announce(`Signature placed on page ${pageIndex + 1}. Drag it, or use arrow keys to move and plus or minus to resize.`);
    this.host.changed();
    return p;
  }

  /** Step a new rect downwards (wrapping to the top) until it doesn't overlap another placement. */
  private freeSpot(g: PageGeom, pageIndex: number, rect: Rect): Rect {
    const others = this.items.filter((i) => i.pageIndex === pageIndex).map((i) => i.rect);
    const overlaps = (r: Rect) =>
      others.some((o) => r.x < o.x + o.width && o.x < r.x + r.width && r.y < o.y + o.height && o.y < r.y + r.height);
    const page = displaySize(g);
    let r = rect;
    const step = rect.height + 8;
    const tries = Math.ceil(page.height / step) + 1;
    for (let i = 0; i < tries && overlaps(r); i++) {
      let y = r.y + step;
      if (y + r.height > page.height) y = 0;
      r = clampRect(g, { ...r, y });
    }
    return overlaps(r) ? rect : r;
  }

  duplicate(id: string): void {
    const src = this.items.find((i) => i.id === id);
    if (!src) return;
    const g = this.host.geom(src.pageIndex);
    const page = displaySize(g);
    const offset = Math.max(8, src.rect.height * 0.6);
    let rect = { ...src.rect, y: src.rect.y + offset };
    if (rect.y + rect.height > page.height) rect = { ...src.rect, y: src.rect.y - offset };
    const p: Placement = { id: `pl-${++seq}`, pageIndex: src.pageIndex, assetId: src.assetId, rect: clampRect(g, rect) };
    this.items.push(p);
    this.mount(p);
    this.select(p.id, true);
    this.host.announce(`Signature duplicated on page ${p.pageIndex + 1}.`);
    this.host.changed();
  }

  remove(id: string): void {
    const i = this.items.findIndex((p) => p.id === id);
    if (i < 0) return;
    const [p] = this.items.splice(i, 1);
    this.els.get(id)?.remove();
    this.els.delete(id);
    if (this.selected === id) this.selected = null;
    this.host.announce(`Signature removed from page ${p.pageIndex + 1}.`);
    this.host.changed();
  }

  select(id: string | null, focus = false): void {
    this.selected = id;
    for (const [pid, el] of this.els) el.classList.toggle('selected', pid === id);
    if (id && focus) this.els.get(id)?.focus({ preventScroll: false });
  }

  private update(p: Placement, rect: Rect): void {
    p.rect = clampRect(this.host.geom(p.pageIndex), rect);
    this.position(p);
    this.host.changed();
  }

  private position(p: Placement): void {
    const el = this.els.get(p.id);
    if (!el) return;
    const pc = rectToPercent(this.host.geom(p.pageIndex), p.rect);
    el.style.left = `${pc.left}%`;
    el.style.top = `${pc.top}%`;
    el.style.width = `${pc.width}%`;
    el.style.height = `${pc.height}%`;
    // Exposed for tests and debugging; contains only coordinates.
    el.dataset.rect = [p.rect.x, p.rect.y, p.rect.width, p.rect.height].map((n) => n.toFixed(3)).join(',');
    el.classList.toggle('near-top', pc.top < 12);
  }

  private mount(p: Placement): void {
    const el = document.createElement('div');
    el.className = 'placement';
    el.tabIndex = 0;
    el.dataset.id = p.id;
    el.dataset.page = String(p.pageIndex);
    el.setAttribute('role', 'group');
    el.setAttribute('aria-roledescription', 'signature');
    el.setAttribute(
      'aria-label',
      `Signature on page ${p.pageIndex + 1}. Arrow keys move it, Shift plus arrows moves faster, plus and minus resize, D duplicates, Delete removes.`,
    );

    const img = document.createElement('img');
    img.src = this.host.assetUrl(p.assetId);
    img.alt = '';
    img.draggable = false;

    const handle = document.createElement('div');
    handle.className = 'resize-handle';
    handle.setAttribute('aria-hidden', 'true');

    const bar = document.createElement('div');
    bar.className = 'placement-bar';
    bar.append(
      this.button('−', 'Make smaller', () => this.scale(p, 1 / 1.15)),
      this.button('+', 'Make larger', () => this.scale(p, 1.15)),
      this.button('Duplicate', 'Duplicate signature', () => this.duplicate(p.id)),
      this.button('Delete', 'Delete signature', () => this.remove(p.id), 'danger'),
    );

    el.append(img, handle, bar);
    this.host.overlay(p.pageIndex).append(el);
    this.els.set(p.id, el);
    this.position(p);

    el.addEventListener('focus', () => this.select(p.id));
    el.addEventListener('keydown', (e) => this.onKey(e, p));
    this.enableDrag(el, handle, p);
  }

  private button(text: string, label: string, fn: () => void, cls = ''): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = text;
    b.setAttribute('aria-label', label);
    b.title = label;
    if (cls) b.classList.add(cls);
    b.addEventListener('pointerdown', (e) => e.stopPropagation());
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      fn();
    });
    return b;
  }

  private scale(p: Placement, factor: number): void {
    const g = this.host.geom(p.pageIndex);
    const cx = p.rect.x + p.rect.width / 2;
    const cy = p.rect.y + p.rect.height / 2;
    const r = resizeRect(g, { ...p.rect, x: 0, y: 0 }, p.rect.width * factor);
    this.update(p, { x: cx - r.width / 2, y: cy - r.height / 2, width: r.width, height: r.height });
  }

  private onKey(e: KeyboardEvent, p: Placement): void {
    const step = e.shiftKey ? 10 : 1;
    const r = p.rect;
    let handled = true;
    switch (e.key) {
      case 'ArrowLeft': this.update(p, { ...r, x: r.x - step }); break;
      case 'ArrowRight': this.update(p, { ...r, x: r.x + step }); break;
      case 'ArrowUp': this.update(p, { ...r, y: r.y - step }); break;
      case 'ArrowDown': this.update(p, { ...r, y: r.y + step }); break;
      case '+': case '=': this.scale(p, 1.05); break;
      case '-': case '_': this.scale(p, 1 / 1.05); break;
      case 'd': case 'D': this.duplicate(p.id); break;
      case 'Delete': case 'Backspace': {
        const idx = this.items.indexOf(p);
        this.remove(p.id);
        const next = this.items[Math.min(idx, this.items.length - 1)];
        if (next) this.select(next.id, true);
        break;
      }
      case 'Escape': this.select(null); (e.target as HTMLElement).blur(); break;
      default: handled = false;
    }
    if (handled) e.preventDefault();
  }

  private enableDrag(el: HTMLElement, handle: HTMLElement, p: Placement): void {
    let mode: 'move' | 'resize' | null = null;
    let startX = 0, startY = 0;
    let start: Rect = p.rect;
    let pointer: number | null = null;

    const unitsPerPx = () => {
      const page = this.host.overlay(p.pageIndex).getBoundingClientRect();
      return displaySize(this.host.geom(p.pageIndex)).width / page.width;
    };

    const down = (e: PointerEvent, m: 'move' | 'resize') => {
      if (pointer !== null || (e.pointerType === 'mouse' && e.button !== 0)) return;
      e.preventDefault();
      e.stopPropagation();
      pointer = e.pointerId;
      mode = m;
      startX = e.clientX;
      startY = e.clientY;
      start = { ...p.rect };
      el.setPointerCapture(e.pointerId);
      el.classList.add('dragging');
      this.select(p.id);
      el.focus({ preventScroll: true });
    };

    handle.addEventListener('pointerdown', (e) => down(e, 'resize'));
    el.addEventListener('pointerdown', (e) => {
      if ((e.target as HTMLElement).closest('.placement-bar, .resize-handle')) return;
      down(e, 'move');
    });
    el.addEventListener('pointermove', (e) => {
      if (e.pointerId !== pointer || !mode) return;
      e.preventDefault();
      const k = unitsPerPx();
      const dx = (e.clientX - startX) * k;
      const dy = (e.clientY - startY) * k;
      if (mode === 'move') {
        this.update(p, { ...start, x: start.x + dx, y: start.y + dy });
      } else {
        // Proportional: follow whichever axis moved further.
        const aspect = start.width / start.height;
        const dw = Math.abs(dx) > Math.abs(dy * aspect) ? dx : dy * aspect;
        p.rect = resizeRect(this.host.geom(p.pageIndex), start, start.width + dw);
        this.position(p);
        this.host.changed();
      }
    });
    const end = (e: PointerEvent) => {
      if (e.pointerId !== pointer) return;
      pointer = null;
      mode = null;
      el.classList.remove('dragging');
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }
}
