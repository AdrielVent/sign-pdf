/**
 * Built-in (AcroForm) fields: read with PDF.js, edited as HTML inputs laid
 * over the page preview, written back by the exporter with pdf-lib.
 *
 * Like Apple Preview: if the PDF has a field, you click it and type into it.
 * If it doesn't, use the Add Text tool instead (see placements.ts).
 */
import type { PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { pdfRectToDisplay, pdfToDisplay, rectToPercent, displaySize, type PageGeom, type Rect } from './geometry';
import { measureText, sanitizeText, TEXT_FONT_CSS } from './text';

export type FieldKind = 'text' | 'checkbox' | 'radio' | 'choice';

export interface Widget {
  id: string;
  name: string;
  kind: FieldKind;
  pageIndex: number;
  rect: Rect; // display space
  label: string;
  readOnly: boolean;
  maxLen: number; // 0 = unlimited
  comb: boolean;
  multiline: boolean;
  align: 0 | 1 | 2;
  /** Fixed font size from the field's /DA, or 0 for auto. */
  fontSize: number;
  /** Checkbox / radio: the value this widget stands for when on. */
  onValue: string;
  options: { value: string; label: string }[];
}

/** Field value by fully-qualified field name. Buttons use their on-value or 'Off'. */
export type FieldValues = Map<string, string>;

interface AnnotationData {
  id: string;
  subtype: string;
  fieldType?: string;
  fieldName?: string;
  fieldValue?: string | string[];
  rect: number[];
  readOnly?: boolean;
  hidden?: boolean;
  checkBox?: boolean;
  radioButton?: boolean;
  pushButton?: boolean;
  exportValue?: string;
  buttonValue?: string;
  maxLen?: number;
  comb?: boolean;
  multiLine?: boolean;
  textAlignment?: number;
  alternativeText?: string;
  combo?: boolean;
  multiSelect?: boolean;
  options?: { exportValue: string; displayValue: string }[];
  defaultAppearanceData?: { fontSize?: number };
}

interface TextLine {
  str: string;
  x: number;
  y: number; // baseline, display space
  width: number;
  height: number;
}

async function pageTextLines(pdf: PDFDocumentProxy, pageIndex: number, g: PageGeom): Promise<TextLine[]> {
  const page = await pdf.getPage(pageIndex + 1);
  const tc = await page.getTextContent();
  const out: TextLine[] = [];
  for (const item of tc.items) {
    if (!('str' in item) || !item.str.trim()) continue;
    const [a, b, , , e, f] = item.transform as number[];
    const [x, y] = pdfToDisplay(g, e, f);
    // Only text that reads left-to-right on screen (skip sideways margin notes).
    const [x2, y2] = pdfToDisplay(g, e + a, f + b);
    if (!(x2 - x > 0 && Math.abs(y2 - y) < 0.01 * Math.abs(x2 - x) + 1e-6)) continue;
    out.push({ str: item.str.trim(), x, y, width: item.width * g.userUnit, height: item.height * g.userUnit });
  }
  return out;
}

const JUNK = /^[\s.\-–—_:]*$/;

/** First sentence of a caption, ignoring periods inside parentheses ("apt. or suite no."). */
function shortCaption(text: string): string {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '(') depth++;
    else if (c === ')') depth = Math.max(0, depth - 1);
    else if (c === '.' && depth === 0 && text[i + 1] === ' ' && i > 12) return text.slice(0, i).trim();
  }
  return text.replace(/[\s.]+$/, '').trim();
}

/**
 * A readable name for a field, for screen readers and tooltips: the words
 * printed right after a checkbox, or the caption left of / above a text field.
 */
function nearbyLabel(w: { kind: FieldKind; rect: Rect }, siblings: Rect[], lines: TextLine[]): string {
  const r = w.rect;
  const useful = lines.filter((l) => !JUNK.test(l.str));
  const bottom = r.y + r.height;
  if (w.kind === 'checkbox' || w.kind === 'radio') {
    // Text that starts right of the box on the same row. PDF.js may merge a
    // whole row of captions into one item, so cut it at the next box.
    const right = r.x + r.width;
    const row = useful.filter((l) => Math.abs(l.y - bottom) < Math.max(4, r.height * 0.6) && l.x + l.width > right && l.x < right + 40);
    const item = row.sort((a, b) => a.x - b.x)[0];
    if (item) {
      const next = Math.min(...siblings.filter((o) => Math.abs(o.y - r.y) < 3 && o.x > r.x).map((o) => o.x), item.x + item.width);
      const per = item.str.length / Math.max(item.width, 1);
      const from = Math.max(0, Math.round((right - item.x) * per));
      const to = Math.min(item.str.length, Math.round((next - item.x) * per));
      const text = item.str.slice(from, to > from ? to : undefined).trim();
      if (text) return shortCaption(text);
    }
  }
  // Join the fragments PDF.js splits a printed line into ("5" + "Address (number, ...").
  const lineFrom = (first: TextLine): string => {
    const parts = useful.filter((l) => Math.abs(l.y - first.y) < 1.5 && l.x >= first.x - 1).sort((a, b) => a.x - b.x);
    let text = '';
    let end = first.x;
    for (const l of parts) {
      if (l.x - end > 18) break;
      text += (text ? ' ' : '') + l.str;
      end = Math.max(end, l.x + l.width);
    }
    return text;
  };
  const lineStart = (l: TextLine): TextLine =>
    useful.filter((o) => Math.abs(o.y - l.y) < 1.5 && o.x < l.x && o.x + o.width > l.x - 18).sort((a, b) => a.x - b.x)[0] ?? l;
  const fromLeft = (gap = 60) => {
    const near = useful
      .filter((l) => l.y >= r.y - 1 && l.y <= bottom + 2 && l.x + l.width <= r.x + 2 && l.x + l.width > r.x - gap)
      .sort((a, b) => b.x + b.width - (a.x + a.width))[0];
    if (!near) return '';
    let text = lineFrom(lineStart(near));
    // A short caption that continues a line above ("…(FATCA) reporting" / "code (if any)"): join them.
    const start = lineStart(near);
    const prev = useful.filter((l) => l.y < start.y && l.y > start.y - 13 && Math.abs(l.x - start.x) < 2)[0];
    if (prev && text.length < 20) text = `${lineFrom(prev)} ${text}`;
    return shortCaption(text);
  };
  const fromAbove = () => {
    const within = (reach: number) => useful.filter((l) => l.y <= r.y + 2 && l.y >= r.y - 28 && l.x < r.x + r.width && l.x + l.width > r.x - reach);
    // Directly above first; digit boxes further along a row share the caption of the first box.
    let above = within(4);
    if (!above.length && r.height >= 18) above = within(60);
    const numbered = above.map(lineStart).filter((l) => /^\d+[a-z]?$/.test(l.str) || /^\d+[a-z]?\s/.test(l.str)).sort((a, b) => b.y - a.y)[0];
    const nearest = above.sort((a, b) => b.y - a.y || a.x - b.x)[0];
    const pick = numbered ?? (nearest && lineStart(nearest));
    return pick ? shortCaption(lineFrom(pick)) : '';
  };
  if (w.kind === 'checkbox' || w.kind === 'radio') return fromLeft(420);
  // Tall boxes (SSN/EIN digit boxes) are captioned above; short ones often on the left.
  return r.height >= 18 ? fromAbove() || fromLeft() : fromLeft() || fromAbove();
}

/** Read every editable widget, in the document's own order (page by page, /Annots order). */
export async function readFormWidgets(pdf: PDFDocumentProxy, geoms: PageGeom[]): Promise<{ widgets: Widget[]; initial: FieldValues }> {
  const widgets: Widget[] = [];
  const initial: FieldValues = new Map();
  for (let i = 0; i < pdf.numPages; i++) {
    const page = await pdf.getPage(i + 1);
    const anns = (await page.getAnnotations({ intent: 'display' })) as AnnotationData[];
    const fields = anns.filter((a) => a.subtype === 'Widget' && a.fieldName && !a.hidden && !a.pushButton && ['Tx', 'Btn', 'Ch'].includes(a.fieldType ?? ''));
    if (!fields.length) continue;
    const g = geoms[i];
    const lines = await pageTextLines(pdf, i, g);
    const rects = fields.map((a) => pdfRectToDisplay(g, a.rect));
    const pageWidgets: Widget[] = [];
    let n = 0;
    for (const [k, a] of fields.entries()) {
      const rect = rects[k];
      if (rect.width < 2 || rect.height < 2) continue;
      const kind: FieldKind = a.fieldType === 'Tx' ? 'text' : a.fieldType === 'Ch' ? 'choice' : a.radioButton ? 'radio' : 'checkbox';
      if (kind === 'choice' && a.multiSelect) continue; // list boxes with multiple selection: not supported
      const onValue = (kind === 'radio' ? a.buttonValue : a.exportValue) ?? '';
      if ((kind === 'checkbox' || kind === 'radio') && !onValue) continue;
      n++;
      const siblings = rects.filter((_, j) => j !== k && fields[j].fieldType === 'Btn');
      const caption = a.alternativeText?.trim() || nearbyLabel({ kind, rect }, siblings, lines);
      const label = caption || `Form field ${n} on page ${i + 1}`;
      pageWidgets.push({
        id: a.id,
        name: a.fieldName!,
        kind,
        pageIndex: i,
        rect,
        label,
        readOnly: !!a.readOnly,
        maxLen: a.maxLen ?? 0,
        comb: !!a.comb && (a.maxLen ?? 0) > 0,
        multiline: !!a.multiLine,
        align: (a.textAlignment ?? 0) as 0 | 1 | 2,
        fontSize: a.defaultAppearanceData?.fontSize ?? 0,
        onValue,
        options: (a.options ?? []).map((o) => ({ value: o.exportValue, label: o.displayValue })),
      });
      if (!initial.has(a.fieldName!)) {
        const v = Array.isArray(a.fieldValue) ? (a.fieldValue[0] ?? '') : (a.fieldValue ?? '');
        initial.set(a.fieldName!, kind === 'checkbox' || kind === 'radio' ? v || 'Off' : v);
      }
    }
    // Several boxes with the same caption (e.g. the three parts of an SSN): number them.
    const groups = new Map<string, Widget[]>();
    for (const w of pageWidgets) if (w.kind === 'text') groups.set(w.label, [...(groups.get(w.label) ?? []), w]);
    for (const [label, same] of groups) {
      if (same.length > 1) same.forEach((w, k) => (w.label = `${label} (part ${k + 1} of ${same.length})`));
    }
    widgets.push(...pageWidgets);
  }
  return { widgets, initial };
}

/**
 * Make the page render its fields empty: the HTML inputs on top show the
 * values. Must run before the first page render.
 */
export function blankFieldsInPreview(pdf: PDFDocumentProxy, widgets: Widget[]): void {
  for (const w of widgets) {
    pdf.annotationStorage.setValue(w.id, { value: w.kind === 'checkbox' || w.kind === 'radio' ? false : '' });
  }
}

/**
 * Font size for a text field. Fixed sizes from the PDF are kept; "auto" (0)
 * fields fit the height and shrink so the whole value fits the width, which
 * is what Acrobat does. The exporter writes this exact size into the field.
 */
export function fieldFontSize(w: Widget, value: string): number {
  if (w.fontSize > 0) return w.fontSize;
  const byHeight = w.multiline ? 10 : Math.min(12, Math.max(4, (w.rect.height - 2) * 0.72));
  if (w.multiline || w.comb || !value) return byHeight;
  const avail = w.rect.width - 4;
  const natural = measureText(value, 1);
  return Math.max(4, Math.min(byHeight, avail / Math.max(natural, 0.001)));
}

export interface FormHost {
  overlay(pageIndex: number): HTMLElement;
  geom(pageIndex: number): PageGeom;
  /** Called before a value changes (for undo). */
  checkpoint(): void;
  changed(): void;
  warn(msg: string): void;
}

/** HTML inputs over each page for the PDF's own fields. */
export class FormLayer {
  widgets: Widget[] = [];
  private initial: FieldValues = new Map();
  values: FieldValues = new Map();
  private inputs = new Map<string, HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>();

  constructor(private host: FormHost) {}

  load(widgets: Widget[], initial: FieldValues): void {
    this.clear();
    this.widgets = widgets;
    this.initial = new Map(initial);
    this.values = new Map(initial);
    for (const w of widgets) this.mount(w);
    this.sync();
  }

  clear(): void {
    for (const el of this.inputs.values()) el.remove();
    this.inputs.clear();
    this.widgets = [];
    this.values = new Map();
    this.initial = new Map();
  }

  /** Fields whose value differs from the original document. */
  changedFields(): { name: string; kind: FieldKind; value: string; fontSize: number }[] {
    const out: { name: string; kind: FieldKind; value: string; fontSize: number }[] = [];
    for (const [name, value] of this.values) {
      if ((this.initial.get(name) ?? '') === value) continue;
      const w = this.widgets.find((x) => x.name === name)!;
      out.push({ name, kind: w.kind, value, fontSize: w.kind === 'text' ? fieldFontSize(w, value) : 0 });
    }
    return out;
  }

  setValues(values: FieldValues): void {
    this.values = new Map(values);
    this.sync();
  }

  /** Push model values into every input. */
  private sync(): void {
    for (const w of this.widgets) {
      const el = this.inputs.get(w.id);
      if (!el) continue;
      const v = this.values.get(w.name) ?? '';
      if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) el.checked = v === w.onValue;
      else if (el.value !== v) el.value = v;
      if (w.kind === 'text') this.styleText(w, el as HTMLInputElement, v);
    }
  }

  private set(w: Widget, value: string): void {
    if ((this.values.get(w.name) ?? '') === value) return;
    this.values.set(w.name, value);
    // Other widgets of the same field show the same value.
    for (const o of this.widgets) if (o.name === w.name && o.id !== w.id) {
      const el = this.inputs.get(o.id);
      if (!el) continue;
      if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) el.checked = value === o.onValue;
      else if (el.value !== value) el.value = value;
      if (o.kind === 'text') this.styleText(o, el as HTMLInputElement, value);
    }
    this.host.changed();
  }

  private styleText(w: Widget, el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
    const page = displaySize(this.host.geom(w.pageIndex));
    const size = fieldFontSize(w, value);
    // Font size as a fraction of the page width, so it scales with zoom exactly like the page.
    el.style.fontSize = `${(size / page.width) * 100}cqw`;
    if (w.comb) {
      // One character per cell: spread with letter-spacing. Letter-spacing
      // also follows the last character, so widen the input by that half-gap
      // (clipped away) or a full field would scroll and hide its first digit.
      const cell = w.rect.width / w.maxLen;
      const glyph = 0.556 * size; // digit advance in Helvetica/Arial
      const gap = Math.max(0, cell - glyph);
      const cq = (v: number) => `${(v / page.width) * 100}cqw`;
      el.style.letterSpacing = cq(gap);
      el.style.paddingLeft = cq(gap / 2);
      el.style.paddingRight = '0';
      el.style.width = `calc(${rectToPercent(this.host.geom(w.pageIndex), w.rect).width}% + ${cq(gap)})`;
      el.style.clipPath = `inset(0 ${cq(gap)} 0 0)`;
    }
  }

  private mount(w: Widget): void {
    const overlay = this.host.overlay(w.pageIndex);
    const pc = rectToPercent(this.host.geom(w.pageIndex), w.rect);
    let el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
    if (w.kind === 'text') {
      el = w.multiline ? document.createElement('textarea') : document.createElement('input');
      if (el instanceof HTMLInputElement) el.type = 'text';
      if (w.maxLen > 0) el.maxLength = w.maxLen;
      el.spellcheck = false;
      el.autocomplete = 'off';
      el.style.fontFamily = w.comb ? TEXT_FONT_CSS : TEXT_FONT_CSS;
      el.style.textAlign = ['left', 'center', 'right'][w.align];
      if (w.comb) el.inputMode = 'text';
    } else if (w.kind === 'choice') {
      const s = document.createElement('select');
      s.append(new Option('', ''), ...w.options.map((o) => new Option(o.label || o.value, o.value)));
      el = s;
    } else {
      const i = document.createElement('input');
      i.type = w.kind === 'radio' ? 'radio' : 'checkbox';
      i.value = w.onValue;
      if (w.kind === 'radio') i.name = `field:${w.name}`;
      el = i;
    }
    el.className = `pdf-field pdf-field-${w.kind}`;
    el.dataset.field = w.name;
    el.dataset.widget = w.id;
    el.setAttribute('aria-label', w.label);
    el.title = w.label;
    if (w.readOnly) el.setAttribute('disabled', '');
    Object.assign(el.style, { left: `${pc.left}%`, top: `${pc.top}%`, width: `${pc.width}%`, height: `${pc.height}%` });
    // Exposed for tests: coordinates only.
    el.dataset.rect = [w.rect.x, w.rect.y, w.rect.width, w.rect.height].map((n) => n.toFixed(3)).join(',');

    el.addEventListener('focus', () => this.host.checkpoint());
    el.addEventListener('pointerdown', (e) => e.stopPropagation());
    if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
      el.addEventListener('change', () => {
        this.host.checkpoint();
        this.set(w, (el as HTMLInputElement).checked ? w.onValue : 'Off');
      });
      // Space toggles natively; Enter too, as in most PDF viewers.
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          (el as HTMLInputElement).click();
        }
      });
    } else if (el instanceof HTMLSelectElement) {
      el.addEventListener('change', () => this.set(w, (el as HTMLSelectElement).value));
    } else {
      const t = el;
      t.addEventListener('input', () => {
        const { text, removed } = sanitizeText(t.value, w.multiline);
        if (removed) {
          const pos = t.selectionStart ?? text.length;
          t.value = text;
          t.setSelectionRange(Math.min(pos, text.length), Math.min(pos, text.length));
          this.host.warn(`“${removed}” can’t be saved in this PDF’s standard font, so it was left out.`);
        }
        this.styleText(w, t, t.value);
        this.set(w, t.value);
      });
    }
    overlay.append(el);
    this.inputs.set(w.id, el);
  }

  focusFirst(): void {
    const first = this.widgets.find((w) => !w.readOnly);
    if (first) this.inputs.get(first.id)?.focus();
  }
}
