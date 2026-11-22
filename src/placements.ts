/**
 * Things the user puts on a page: signatures, free text (for flat PDFs, like
 * Acrobat's Fill & Sign "Add Text") and checkmarks.
 *
 * Drag to move, corner handle to resize (proportionally), keyboard
 * alternatives, delete; signatures can also be duplicated. Positions live in
 * display space (geometry.ts) and are rendered as percentages of the page
 * box, so zoom and window size never move anything.
 */
import { clampRect, defaultRect, displaySize, rectToPercent, resizeRect, type PageGeom, type Rect } from './geometry';
import { DEFAULT_TEXT_SIZE, LINE_HEIGHT, MIN_TEXT_SIZE, baselineRatio, sanitizeText, textBoxSize, TEXT_FONT_CSS, TEXT_PAD } from './text';

interface Base {
  id: string;
  pageIndex: number;
  rect: Rect;
}
export interface SignaturePlacement extends Base {
  kind: 'image';
  assetId: string;
}
export interface TextPlacement extends Base {
  kind: 'text';
  text: string;
}
export interface CheckPlacement extends Base {
  kind: 'check';
}
export type Placement = SignaturePlacement | TextPlacement | CheckPlacement;

export const fontSizeOf = (p: TextPlacement) => p.rect.height / LINE_HEIGHT;

/** Checkmark drawn in a 100×100 box (y down). Shared by the editor and the exporter. */
export const CHECK_PATH: [number, number][] = [
  [14, 54],
  [40, 80],
  [88, 20],
];
export const CHECK_STROKE = 13; // in the same 100-unit box
export const DEFAULT_CHECK_SIZE = 10; // pt
const MIN_CHECK = 4;

export interface PlacementHost {
  geom(pageIndex: number): PageGeom;
  overlay(pageIndex: number): HTMLElement;
  assetUrl(assetId: string): string;
  announce(msg: string): void;
  /** Called before any change, so it can be undone. */
  checkpoint(): void;
  changed(): void;
  warn(msg: string): void;
}

let seq = 0;
const NOUN = { image: 'signature', text: 'text', check: 'checkmark' } as const;
const DRAG_THRESHOLD = 4; // px before a press becomes a drag

export class PlacementLayer {
  readonly items: Placement[] = [];
  private els = new Map<string, HTMLElement>();
  private selected: string | null = null;
  private lastNudge = { id: '', at: 0 };

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

  /** Deep copy of all placements (for undo). */
  snapshot(): Placement[] {
    return this.items.map((p) => ({ ...p, rect: { ...p.rect } }));
  }

  /** Replace everything with a snapshot (undo). */
  restore(items: Placement[]): void {
    const keep = this.selected;
    this.clear();
    for (const p of items) {
      const copy = { ...p, rect: { ...p.rect } };
      this.items.push(copy);
      this.mount(copy);
    }
    if (keep && this.els.has(keep)) this.select(keep);
  }

  private minWidth(p: Placement): number {
    if (p.kind === 'check') return MIN_CHECK;
    if (p.kind === 'text') return textBoxSize(p.text, MIN_TEXT_SIZE).width;
    return undefined as unknown as number; // default (signature minimum)
  }

  private clamp(p: Placement, rect: Rect): Rect {
    const g = this.host.geom(p.pageIndex);
    return p.kind === 'image' ? clampRect(g, rect) : clampRect(g, rect, this.minWidth(p));
  }

  // ---------------------------------------------------------------- adding
  add(pageIndex: number, assetId: string, aspect: number, center?: { x: number; y: number }): Placement {
    this.host.checkpoint();
    const g = this.host.geom(pageIndex);
    const p: SignaturePlacement = { id: `pl-${++seq}`, kind: 'image', pageIndex, assetId, rect: this.freeSpot(g, pageIndex, defaultRect(g, aspect, center)) };
    this.items.push(p);
    this.mount(p);
    this.select(p.id, true);
    this.host.announce(`Signature placed on page ${pageIndex + 1}. Drag it, or use arrow keys to move and plus or minus to resize.`);
    this.host.changed();
    return p;
  }

  /**
   * Start a text box where the user clicked. The click point is where the
   * text starts and (almost) its baseline, so clicking on a printed line puts
   * the text on that line.
   */
  addText(pageIndex: number, at: { x: number; y: number }, size = DEFAULT_TEXT_SIZE): TextPlacement {
    this.host.checkpoint();
    const { width, height } = textBoxSize('', size);
    const p: TextPlacement = { id: `pl-${++seq}`, kind: 'text', pageIndex, text: '', rect: { x: 0, y: 0, width, height } };
    // Sit the text just above the clicked line, so descenders don't cross it.
    const baseline = at.y - 0.12 * size;
    p.rect = this.clamp(p, { x: at.x - TEXT_PAD * size, y: baseline - baselineRatio() * size, width, height });
    this.items.push(p);
    this.mount(p);
    this.select(p.id);
    this.edit(p);
    this.host.changed();
    return p;
  }

  /** A checkmark centred on the click point. */
  addCheck(pageIndex: number, at: { x: number; y: number }, size = DEFAULT_CHECK_SIZE): CheckPlacement {
    this.host.checkpoint();
    const p: CheckPlacement = { id: `pl-${++seq}`, kind: 'check', pageIndex, rect: { x: 0, y: 0, width: size, height: size } };
    p.rect = this.clamp(p, { x: at.x - size / 2, y: at.y - size / 2, width: size, height: size });
    this.items.push(p);
    this.mount(p);
    this.select(p.id, true);
    this.host.announce(`Checkmark placed on page ${pageIndex + 1}.`);
    this.host.changed();
    return p;
  }

  /** Step a new rect downwards (wrapping to the top) until it doesn't overlap another placement. */
  private freeSpot(g: PageGeom, pageIndex: number, rect: Rect): Rect {
    const others = this.items.filter((i) => i.pageIndex === pageIndex && i.kind === 'image').map((i) => i.rect);
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
    this.host.checkpoint();
    const g = this.host.geom(src.pageIndex);
    const page = displaySize(g);
    const offset = Math.max(8, src.rect.height * 0.6);
    let rect = { ...src.rect, y: src.rect.y + offset };
    if (rect.y + rect.height > page.height) rect = { ...src.rect, y: src.rect.y - offset };
    const p: Placement = { ...src, id: `pl-${++seq}`, rect: this.clamp(src, rect) };
    this.items.push(p);
    this.mount(p);
    this.select(p.id, true);
    this.host.announce(`${cap(NOUN[p.kind])} duplicated on page ${p.pageIndex + 1}.`);
    this.host.changed();
  }

  remove(id: string, opts: { checkpoint?: boolean; quiet?: boolean } = {}): void {
    const i = this.items.findIndex((p) => p.id === id);
    if (i < 0) return;
    if (opts.checkpoint !== false) this.host.checkpoint();
    const [p] = this.items.splice(i, 1);
    this.els.get(id)?.remove();
    this.els.delete(id);
    if (this.selected === id) this.selected = null;
    if (!opts.quiet) this.host.announce(`${cap(NOUN[p.kind])} removed from page ${p.pageIndex + 1}.`);
    this.host.changed();
  }

  select(id: string | null, focus = false): void {
    this.selected = id;
    for (const [pid, el] of this.els) el.classList.toggle('selected', pid === id);
    if (id && focus) this.els.get(id)?.focus({ preventScroll: false });
  }

  selectedItem(): Placement | null {
    return this.items.find((p) => p.id === this.selected) ?? null;
  }

  private update(p: Placement, rect: Rect): void {
    p.rect = this.clamp(p, rect);
    this.position(p);
    this.host.changed();
  }

  private position(p: Placement): void {
    const el = this.els.get(p.id);
    if (!el) return;
    const g = this.host.geom(p.pageIndex);
    const pc = rectToPercent(g, p.rect);
    el.style.left = `${pc.left}%`;
    el.style.top = `${pc.top}%`;
    el.style.width = `${pc.width}%`;
    el.style.height = `${pc.height}%`;
    if (p.kind === 'text') {
      const pageW = displaySize(g).width;
      const size = fontSizeOf(p);
      const input = el.querySelector('input')!;
      input.style.fontSize = `${(size / pageW) * 100}cqw`;
      input.style.paddingLeft = input.style.paddingRight = `${((TEXT_PAD * size) / pageW) * 100}cqw`;
    }
    // Exposed for tests and debugging; contains only coordinates.
    el.dataset.rect = [p.rect.x, p.rect.y, p.rect.width, p.rect.height].map((n) => n.toFixed(3)).join(',');
    el.classList.toggle('near-top', pc.top < 12);
  }

  /** Re-measure a text box after its text or size changed; keeps the left edge and baseline. */
  private refit(p: TextPlacement, size = fontSizeOf(p)): void {
    const { width, height } = textBoxSize(p.text, size);
    const baseline = p.rect.y + baselineRatio() * fontSizeOf(p);
    p.rect = this.clamp(p, { x: p.rect.x, y: baseline - baselineRatio() * size, width, height });
    this.position(p);
  }

  // ---------------------------------------------------------------- DOM
  private mount(p: Placement): void {
    const el = document.createElement('div');
    el.className = `placement placement-${p.kind}`;
    el.tabIndex = 0;
    el.dataset.id = p.id;
    el.dataset.page = String(p.pageIndex);
    el.dataset.kind = p.kind;
    el.setAttribute('role', 'group');
    el.setAttribute('aria-roledescription', NOUN[p.kind]);
    const keys =
      p.kind === 'text'
        ? 'Enter edits the text, arrow keys move it, Shift plus arrows moves faster, plus and minus change the size, Delete removes.'
        : `Arrow keys move it, Shift plus arrows moves faster, plus and minus resize,${p.kind === 'image' ? ' D duplicates,' : ''} Delete removes.`;
    el.setAttribute('aria-label', `${cap(NOUN[p.kind])} on page ${p.pageIndex + 1}. ${keys}`);

    const handle = document.createElement('div');
    handle.className = 'resize-handle';
    handle.setAttribute('aria-hidden', 'true');

    const bar = document.createElement('div');
    bar.className = 'placement-bar';
    const noun = NOUN[p.kind];
    bar.append(
      this.button('−', `Make ${noun} smaller`, () => this.scale(p, 1 / 1.15)),
      this.button('+', `Make ${noun} larger`, () => this.scale(p, 1.15)),
    );
    if (p.kind === 'image') bar.append(this.button('Duplicate', 'Duplicate signature', () => this.duplicate(p.id)));
    bar.append(this.button('Delete', `Delete ${noun}`, () => this.remove(p.id), 'danger'));

    if (p.kind === 'image') {
      const img = document.createElement('img');
      img.src = this.host.assetUrl(p.assetId);
      img.alt = '';
      img.draggable = false;
      el.append(img);
    } else if (p.kind === 'check') {
      el.insertAdjacentHTML(
        'beforeend',
        `<svg viewBox="0 0 100 100" aria-hidden="true"><path d="M${CHECK_PATH.map((q) => q.join(' ')).join(' L')}" fill="none" stroke="#000" stroke-width="${CHECK_STROKE}" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
      );
    } else {
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'ptext';
      input.value = p.text;
      input.spellcheck = false;
      input.autocomplete = 'off';
      input.style.fontFamily = TEXT_FONT_CSS;
      input.setAttribute('aria-label', `Text on page ${p.pageIndex + 1}`);
      input.tabIndex = -1;
      this.wireText(p, el, input);
      el.append(input);
    }
    el.append(handle, bar);
    this.host.overlay(p.pageIndex).append(el);
    this.els.set(p.id, el);
    this.position(p);

    el.addEventListener('focus', () => this.select(p.id));
    el.addEventListener('keydown', (e) => {
      if (e.target === el) this.onKey(e, p);
    });
    this.enableDrag(el, handle, p);
  }

  private wireText(p: TextPlacement, el: HTMLElement, input: HTMLInputElement): void {
    input.addEventListener('input', () => {
      const { text, removed } = sanitizeText(input.value);
      if (removed) {
        const pos = input.selectionStart ?? text.length;
        input.value = text;
        input.setSelectionRange(Math.min(pos, text.length), Math.min(pos, text.length));
        this.host.warn(`“${removed}” can’t be saved in the PDF’s standard font, so it was left out.`);
      }
      p.text = input.value;
      this.refit(p);
      this.host.changed();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === 'Escape') {
        e.preventDefault();
        el.focus();
      }
    });
    input.addEventListener('focus', () => {
      el.classList.add('editing');
      this.select(p.id);
    });
    input.addEventListener('blur', () => {
      el.classList.remove('editing');
      input.tabIndex = -1;
      // An empty box disappears, as in Acrobat. Its creation was the undo step.
      if (!p.text.trim() && this.items.includes(p)) this.remove(p.id, { checkpoint: false, quiet: true });
    });
  }

  /** Put the caret in a text box. */
  edit(p: Placement): void {
    if (p.kind !== 'text') return;
    const input = this.els.get(p.id)?.querySelector('input');
    if (!input) return;
    this.host.checkpoint();
    input.tabIndex = 0;
    input.focus({ preventScroll: true });
    const n = input.value.length;
    input.setSelectionRange(n, n);
  }

  private button(text: string, label: string, fn: () => void, cls = ''): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = text;
    b.setAttribute('aria-label', label);
    b.title = label;
    if (cls) b.classList.add(cls);
    b.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      e.preventDefault(); // keep focus (and the caret) where it is
    });
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      fn();
    });
    return b;
  }

  private scale(p: Placement, factor: number, checkpoint = true): void {
    if (checkpoint) this.host.checkpoint();
    if (p.kind === 'text') {
      const size = Math.max(MIN_TEXT_SIZE, Math.min(72, fontSizeOf(p) * factor));
      this.refit(p, size);
      this.host.changed();
      return;
    }
    const g = this.host.geom(p.pageIndex);
    const cx = p.rect.x + p.rect.width / 2;
    const cy = p.rect.y + p.rect.height / 2;
    const r = p.kind === 'image' ? resizeRect(g, { ...p.rect, x: 0, y: 0 }, p.rect.width * factor) : resizeRect(g, { ...p.rect, x: 0, y: 0 }, p.rect.width * factor, MIN_CHECK);
    this.update(p, { x: cx - r.width / 2, y: cy - r.height / 2, width: r.width, height: r.height });
  }

  /** Arrow-key nudges on the same item within a second count as one undo step. */
  private nudge(p: Placement, dx: number, dy: number): void {
    const now = performance.now();
    if (this.lastNudge.id !== p.id || now - this.lastNudge.at > 1000) this.host.checkpoint();
    this.lastNudge = { id: p.id, at: now };
    this.update(p, { ...p.rect, x: p.rect.x + dx, y: p.rect.y + dy });
  }

  private onKey(e: KeyboardEvent, p: Placement): void {
    const step = e.shiftKey ? 10 : 1;
    let handled = true;
    switch (e.key) {
      case 'ArrowLeft': this.nudge(p, -step, 0); break;
      case 'ArrowRight': this.nudge(p, step, 0); break;
      case 'ArrowUp': this.nudge(p, 0, -step); break;
      case 'ArrowDown': this.nudge(p, 0, step); break;
      case '+': case '=': this.scale(p, 1.05); break;
      case '-': case '_': this.scale(p, 1 / 1.05); break;
      case 'Enter': case 'F2': if (p.kind === 'text') this.edit(p); else handled = false; break;
      case 'd': case 'D': if (p.kind === 'image') this.duplicate(p.id); else handled = false; break;
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
    let startSize = 0;
    let pointer: number | null = null;
    let moved = false;

    const unitsPerPx = () => {
      const page = this.host.overlay(p.pageIndex).getBoundingClientRect();
      return displaySize(this.host.geom(p.pageIndex)).width / page.width;
    };
    const editing = () => p.kind === 'text' && el.classList.contains('editing');

    const down = (e: PointerEvent, m: 'move' | 'resize') => {
      if (pointer !== null || (e.pointerType === 'mouse' && e.button !== 0)) return;
      e.preventDefault();
      e.stopPropagation();
      pointer = e.pointerId;
      mode = m;
      moved = false;
      startX = e.clientX;
      startY = e.clientY;
      start = { ...p.rect };
      startSize = p.kind === 'text' ? fontSizeOf(p) : 0;
      el.setPointerCapture(e.pointerId);
      this.select(p.id);
      if (!editing()) el.focus({ preventScroll: true });
    };

    handle.addEventListener('pointerdown', (e) => down(e, 'resize'));
    el.addEventListener('pointerdown', (e) => {
      const t = e.target as HTMLElement;
      if (t.closest('.placement-bar, .resize-handle')) return;
      // While typing, presses inside the text go to the text (caret, selection).
      if (editing() && t.tagName === 'INPUT') return;
      down(e, 'move');
    });
    el.addEventListener('pointermove', (e) => {
      if (e.pointerId !== pointer || !mode) return;
      e.preventDefault();
      if (!moved) {
        if (Math.hypot(e.clientX - startX, e.clientY - startY) < DRAG_THRESHOLD) return;
        moved = true;
        this.host.checkpoint();
        el.classList.add('dragging');
      }
      const k = unitsPerPx();
      const dx = (e.clientX - startX) * k;
      const dy = (e.clientY - startY) * k;
      if (mode === 'move') {
        this.update(p, { ...start, x: start.x + dx, y: start.y + dy });
      } else if (p.kind === 'text') {
        const size = Math.max(MIN_TEXT_SIZE, Math.min(72, startSize * ((start.width + dx) / start.width)));
        p.rect = { ...start };
        this.refit(p, size);
        this.host.changed();
      } else {
        // Proportional: follow whichever axis moved further.
        const aspect = start.width / start.height;
        const dw = Math.abs(dx) > Math.abs(dy * aspect) ? dx : dy * aspect;
        const g = this.host.geom(p.pageIndex);
        p.rect = p.kind === 'image' ? resizeRect(g, start, start.width + dw) : resizeRect(g, start, start.width + dw, MIN_CHECK);
        this.position(p);
        this.host.changed();
      }
    });
    const end = (e: PointerEvent) => {
      if (e.pointerId !== pointer) return;
      pointer = null;
      const wasMode = mode;
      mode = null;
      el.classList.remove('dragging');
      // A click (no drag) on a text box puts the caret in it.
      if (!moved && wasMode === 'move' && e.type === 'pointerup' && p.kind === 'text') this.edit(p);
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
