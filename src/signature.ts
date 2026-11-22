/**
 * Signature creation: drawn, typed, or imported. Every method produces a
 * trimmed, transparent, high-resolution PNG held in memory only.
 */

export interface SignatureAsset {
  id: string;
  png: Uint8Array;
  /** Object URL for previews; revoked on Start over. */
  url: string;
  width: number;
  height: number;
  kind: 'draw' | 'type' | 'image';
}

export class SignatureError extends Error {}

/** Longest side of the exported signature image, in pixels. */
const TARGET_PX = 1600;
const MAX_IMPORT_PX = 2000;

let counter = 0;
const newId = () => `sig-${Date.now().toString(36)}-${(counter++).toString(36)}`;

async function canvasToAsset(canvas: HTMLCanvasElement, kind: SignatureAsset['kind']): Promise<SignatureAsset> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new SignatureError('Your browser couldn’t create the signature image.');
  const png = new Uint8Array(await blob.arrayBuffer());
  return { id: newId(), png, url: URL.createObjectURL(blob), width: canvas.width, height: canvas.height, kind };
}

/** Crop a canvas to its non-transparent pixels plus a small margin. Returns null if blank. */
export function trimCanvas(src: HTMLCanvasElement, minInk = 30): HTMLCanvasElement | null {
  const ctx = src.getContext('2d', { willReadFrequently: true })!;
  const { width, height } = src;
  const data = ctx.getImageData(0, 0, width, height).data;
  let minX = width, minY = height, maxX = -1, maxY = -1, ink = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 24) {
        ink++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0 || ink < minInk) return null;
  const pad = 2;
  minX = Math.max(0, minX - pad);
  minY = Math.max(0, minY - pad);
  maxX = Math.min(width - 1, maxX + pad);
  maxY = Math.min(height - 1, maxY + pad);
  const out = document.createElement('canvas');
  out.width = maxX - minX + 1;
  out.height = maxY - minY + 1;
  out.getContext('2d')!.drawImage(src, minX, minY, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}

// ---------------------------------------------------------------- drawing

interface Pt {
  x: number;
  y: number;
  w: number; // relative width (pressure)
}
type Stroke = Pt[];

/**
 * Drawing pad. Strokes are kept as vectors in CSS pixels and re-rendered at
 * export resolution, so the result is never a low-res copy of the pad.
 */
export class SignaturePad {
  private strokes: Stroke[] = [];
  private current: Stroke | null = null;
  private ctx: CanvasRenderingContext2D;
  private activePointer: number | null = null;
  color = '#111111';
  onChange: () => void = () => {};

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
    canvas.addEventListener('pointerdown', this.down);
    canvas.addEventListener('pointermove', this.move);
    canvas.addEventListener('pointerup', this.up);
    canvas.addEventListener('pointercancel', this.up);
    // Belt and braces for browsers that ignore touch-action on canvas.
    canvas.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
    canvas.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
    new ResizeObserver(() => this.resize()).observe(canvas);
  }

  get isEmpty(): boolean {
    return this.strokes.length === 0;
  }

  get strokeCount(): number {
    return this.strokes.length;
  }

  clear(): void {
    this.strokes = [];
    this.current = null;
    this.redraw();
    this.onChange();
  }

  undo(): void {
    this.strokes.pop();
    this.redraw();
    this.onChange();
  }

  setColor(c: string): void {
    this.color = c;
    this.redraw();
  }

  private resize(): void {
    const r = this.canvas.getBoundingClientRect();
    if (!r.width) return;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(r.width * dpr);
    this.canvas.height = Math.round(r.height * dpr);
    this.redraw();
  }

  private point(e: PointerEvent): Pt {
    const r = this.canvas.getBoundingClientRect();
    const pressure = e.pointerType === 'pen' && e.pressure > 0 ? e.pressure : 0.5;
    return { x: e.clientX - r.left, y: e.clientY - r.top, w: 0.55 + pressure * 0.9 };
  }

  private down = (e: PointerEvent) => {
    if (this.activePointer !== null) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    this.activePointer = e.pointerId;
    this.canvas.setPointerCapture(e.pointerId);
    this.current = [this.point(e)];
    this.strokes.push(this.current);
    this.redraw();
  };

  private move = (e: PointerEvent) => {
    if (e.pointerId !== this.activePointer || !this.current) return;
    e.preventDefault();
    const events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
    for (const ev of events.length ? events : [e]) this.current.push(this.point(ev));
    this.redraw();
  };

  private up = (e: PointerEvent) => {
    if (e.pointerId !== this.activePointer) return;
    this.activePointer = null;
    this.current = null;
    this.onChange();
  };

  private redraw(): void {
    const dpr = this.canvas.width / (this.canvas.getBoundingClientRect().width || 1);
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    renderStrokes(this.ctx, this.strokes, 2.6, this.color);
  }

  /** Render strokes to a trimmed high-resolution PNG. */
  async toAsset(): Promise<SignatureAsset> {
    const pts = this.strokes.flat();
    if (pts.length === 0) throw new SignatureError('Draw your signature in the box first.');
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let length = 0;
    for (const s of this.strokes) {
      for (let i = 0; i < s.length; i++) {
        const p = s[i];
        minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
        if (i) length += Math.hypot(p.x - s[i - 1].x, p.y - s[i - 1].y);
      }
    }
    if (length < 12 || Math.max(maxX - minX, maxY - minY) < 10) {
      throw new SignatureError('That signature is too small to read. Draw it larger.');
    }
    const lineWidth = 2.6;
    const margin = lineWidth * 1.5;
    const w = maxX - minX + margin * 2;
    const h = maxY - minY + margin * 2;
    const scale = TARGET_PX / Math.max(w, h);
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(w * scale);
    canvas.height = Math.ceil(h * scale);
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(scale, 0, 0, scale, (margin - minX) * scale, (margin - minY) * scale);
    renderStrokes(ctx, this.strokes, lineWidth, this.color);
    const trimmed = trimCanvas(canvas);
    if (!trimmed) throw new SignatureError('Draw your signature in the box first.');
    return canvasToAsset(trimmed, 'draw');
  }
}

function renderStrokes(ctx: CanvasRenderingContext2D, strokes: Stroke[], base: number, color: string): void {
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  for (const s of strokes) {
    if (s.length === 1) {
      ctx.beginPath();
      ctx.arc(s[0].x, s[0].y, (base * s[0].w) / 2, 0, Math.PI * 2);
      ctx.fill();
      continue;
    }
    // Quadratic curves through segment midpoints give smooth lines.
    for (let i = 1; i < s.length; i++) {
      const p0 = s[i - 1];
      const p1 = s[i];
      const prevMid = i === 1 ? p0 : { x: (s[i - 2].x + p0.x) / 2, y: (s[i - 2].y + p0.y) / 2 };
      const mid = i === s.length - 1 ? p1 : { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 };
      ctx.beginPath();
      ctx.lineWidth = base * ((p0.w + p1.w) / 2);
      ctx.moveTo(prevMid.x, prevMid.y);
      ctx.quadraticCurveTo(p0.x, p0.y, mid.x, mid.y);
      ctx.stroke();
    }
  }
}

// ---------------------------------------------------------------- typing

export const SIGNATURE_FONTS = [
  { family: 'Dancing Script', label: 'Dancing Script' },
  { family: 'Great Vibes', label: 'Great Vibes' },
  { family: 'Caveat', label: 'Caveat' },
] as const;

/** Load the bundled fonts now so typed signatures work offline later. */
export function preloadSignatureFonts(): Promise<unknown> {
  return Promise.all(SIGNATURE_FONTS.map((f) => document.fonts.load(`64px "${f.family}"`, 'Ab'))).catch(() => {});
}

export async function typedSignature(name: string, family: string, color: string): Promise<SignatureAsset> {
  const text = name.trim().replace(/\s+/g, ' ');
  if (!text) throw new SignatureError('Type your name first.');
  if (text.length > 80) throw new SignatureError('That’s too long for a signature (80 characters max).');
  const size = 220;
  await document.fonts.load(`${size}px "${family}"`, text).catch(() => {});
  const font = `${size}px "${family}", cursive`;
  const measure = document.createElement('canvas').getContext('2d')!;
  measure.font = font;
  const textWidth = Math.ceil(measure.measureText(text).width);
  const canvas = document.createElement('canvas');
  // Generous canvas so swashes are never clipped; trimmed afterwards.
  canvas.width = Math.min(textWidth + size * 2, 16000);
  canvas.height = Math.round(size * 2.2);
  const ctx = canvas.getContext('2d')!;
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(text, size, size * 1.4);
  const trimmed = trimCanvas(canvas);
  if (!trimmed) throw new SignatureError('Type your name first.');
  return canvasToAsset(trimmed, 'type');
}

// ---------------------------------------------------------------- importing

export async function importedSignature(file: File, removeBackground: boolean): Promise<SignatureAsset> {
  if (!/^image\/(png|jpeg)$/.test(file.type) && !/\.(png|jpe?g)$/i.test(file.name)) {
    throw new SignatureError('Choose a PNG or JPEG image.');
  }
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new SignatureError('That image couldn’t be read. Try a different PNG or JPEG.');
  }
  const scale = Math.min(1, MAX_IMPORT_PX / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  if (removeBackground) {
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      // Paper-white → transparent, ink stays, soft edge in between.
      const keep = Math.min(1, Math.max(0, (235 - lum) / 60));
      d[i + 3] = Math.round(d[i + 3] * keep);
    }
    ctx.putImageData(img, 0, 0);
  }
  const trimmed = trimCanvas(canvas);
  if (!trimmed) {
    throw new SignatureError(
      removeBackground
        ? 'No signature found in that image. If it’s light-colored, untick “Remove white background”.'
        : 'That image is blank.',
    );
  }
  return canvasToAsset(trimmed, 'image');
}
