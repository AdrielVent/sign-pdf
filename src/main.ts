import '@fontsource/dancing-script/latin-400.css';
import '@fontsource/great-vibes/latin-400.css';
import '@fontsource/caveat/latin-400.css';
import './style.css';

import { displaySize } from './geometry';
import { ExportError, exportSignedPdf, signedFileName, type ExportPlacement } from './export';
import { blankFieldsInPreview, FormLayer, readFormWidgets, type FieldValues, type Widget } from './forms';
import { OpenError, openPdf, startPdfWorker, type LoadedDocument } from './pdf';
import { PlacementLayer, type Placement } from './placements';
import { baselineRatio } from './text';
import {
  SIGNATURE_FONTS,
  SignatureError,
  SignaturePad,
  importedSignature,
  preloadSignatureFonts,
  typedSignature,
  type SignatureAsset,
} from './signature';
import { Viewer } from './viewer';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// ------------------------------------------------------------------ state
// Everything lives in memory only. Nothing is written to any browser storage.
interface AppState {
  doc: LoadedDocument | null;
  signature: SignatureAsset | null;
  assets: Map<string, SignatureAsset>;
  dirty: boolean; // placements changed since last successful download
}
const state: AppState = { doc: null, signature: null, assets: new Map(), dirty: false };

startPdfWorker();
void preloadSignatureFonts();

// ------------------------------------------------------------------ elements
const startEl = $('start');
const workspace = $('workspace');
const fileInput = $<HTMLInputElement>('file-input');
const openError = $('open-error');
const openingEl = $('opening');
const viewer = new Viewer($('scroller'), $('pages'));
const pageNum = $<HTMLInputElement>('page-num');
const pageCount = $('page-count');
const zoomLevel = $('zoom-level');
const downloadBtn = $<HTMLButtonElement>('download-btn');
const signBtn = $<HTMLButtonElement>('sign-btn');
const signLabel = $('sign-label');
const signThumb = $<HTMLImageElement>('sign-thumb');
const changeSig = $<HTMLButtonElement>('change-sig');
const notices = $('notices');
const undoBtn = $<HTMLButtonElement>('undo-btn');
const toolText = $<HTMLButtonElement>('tool-text');
const toolCheck = $<HTMLButtonElement>('tool-check');
const toast = $('toast');
const srAnnounce = $('sr-announce');

const APP_NAME = 'vnua-signature';
const brandName = $('brand-name');

function markChanged(): void {
  state.dirty = true;
  refreshActions();
}

const layer = new PlacementLayer({
  geom: (i) => state.doc!.geoms[i],
  overlay: (i) => viewer.overlay(i),
  assetUrl: (id) => state.assets.get(id)!.url,
  announce,
  checkpoint: () => undoHistory.checkpoint(),
  changed: markChanged,
  warn: (msg) => showToast(msg, 'error'),
});

const form = new FormLayer({
  overlay: (i) => viewer.overlay(i),
  geom: (i) => state.doc!.geoms[i],
  checkpoint: () => undoHistory.checkpoint(),
  changed: markChanged,
  warn: (msg) => showToast(msg, 'error'),
});

// ------------------------------------------------------------------ undo
// Snapshots of everything the user changed (placements + field values), in memory only.
interface Snapshot {
  placements: Placement[];
  values: [string, string][];
}
const undoHistory = {
  stack: [] as string[],
  current(): string {
    const snap: Snapshot = { placements: layer.snapshot(), values: [...form.values] };
    return JSON.stringify(snap);
  },
  /** Remember the state *before* a change. No-op entries are skipped when undoing. */
  checkpoint(): void {
    const now = this.current();
    if (this.stack[this.stack.length - 1] !== now) this.stack.push(now);
    if (this.stack.length > 300) this.stack.shift();
    refreshUndo();
  },
  undo(): boolean {
    const now = this.current();
    while (this.stack.length) {
      const prev = this.stack.pop()!;
      if (prev === now) continue;
      const snap = JSON.parse(prev) as Snapshot;
      (document.activeElement as HTMLElement | null)?.blur?.();
      layer.restore(snap.placements);
      form.setValues(new Map(snap.values) as FieldValues);
      markChanged();
      refreshUndo();
      return true;
    }
    refreshUndo();
    return false;
  },
  clear(): void {
    this.stack = [];
    refreshUndo();
  },
};
function refreshUndo(): void {
  undoBtn.setAttribute('aria-disabled', String(undoHistory.stack.length === 0));
}

// ------------------------------------------------------------------ helpers
function announce(msg: string): void {
  srAnnounce.textContent = '';
  requestAnimationFrame(() => (srAnnounce.textContent = msg));
}

let toastTimer = 0;
function showToast(msg: string, kind: 'ok' | 'error' = 'ok', ms = 5000): void {
  toast.textContent = msg;
  toast.className = `toast ${kind}`;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (toast.hidden = true), ms);
}

function showMessage(title: string, text: string): Promise<void> {
  const d = $<HTMLDialogElement>('message-dialog');
  $('message-title').textContent = title;
  $('message-text').textContent = text;
  d.showModal();
  return new Promise((resolve) => d.addEventListener('close', () => resolve(), { once: true }));
}

function confirmDiscard(text: string, okLabel = 'Discard'): Promise<boolean> {
  const d = $<HTMLDialogElement>('confirm-dialog');
  $('confirm-title').textContent = 'Discard your changes?';
  $('confirm-text').textContent = text;
  $('confirm-ok').textContent = okLabel;
  d.returnValue = '';
  d.showModal();
  $('confirm-cancel').focus();
  return new Promise((resolve) => d.addEventListener('close', () => resolve(d.returnValue === 'ok'), { once: true }));
}

function unsavedCount(): number {
  return state.dirty ? layer.items.length + form.changedFields().length : 0;
}

/** e.g. "1 signature placement and 3 filled-in fields" (counts only, never content). */
function describeUnsaved(): string {
  const n = (k: Placement['kind']) => layer.items.filter((p) => p.kind === k).length;
  const plural = (c: number, one: string, many: string) => `${c} ${c === 1 ? one : many}`;
  const parts: string[] = [];
  if (n('image')) parts.push(plural(n('image'), 'signature placement', 'signature placements'));
  const fields = form.changedFields().length;
  if (fields) parts.push(plural(fields, 'filled-in field', 'filled-in fields'));
  if (n('text')) parts.push(plural(n('text'), 'text box', 'text boxes'));
  if (n('check')) parts.push(plural(n('check'), 'checkmark', 'checkmarks'));
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0] ?? 'changes';
}

function refreshActions(): void {
  const n = layer.items.filter((p) => p.kind === 'image').length;
  const hasWork = layer.items.length > 0 || form.changedFields().length > 0;
  downloadBtn.setAttribute('aria-disabled', String(!hasWork));
  downloadBtn.textContent = n > 1 ? `Download signed PDF (${n})` : 'Download signed PDF';
  if (state.signature) {
    signLabel.textContent = 'Place signature';
    signThumb.src = state.signature.url;
    signThumb.hidden = false;
    changeSig.hidden = false;
  } else {
    signLabel.textContent = 'Add signature';
    signThumb.hidden = true;
    changeSig.hidden = true;
  }
}

// ------------------------------------------------------------------ open / reset
async function handleFile(file: File | undefined | null): Promise<void> {
  // Reset now so choosing the same file again (e.g. after Cancel) still fires "change".
  fileInput.value = '';
  if (!file) return;
  const pending = unsavedCount();
  if (pending > 0) {
    const ok = await confirmDiscard(
      `You have ${describeUnsaved()} on “${state.doc?.name}” that you haven’t downloaded. Opening another PDF will discard ${pending > 1 ? 'them' : 'it'}.`,
      'Discard and open',
    );
    if (!ok) return;
  }
  openError.hidden = true;
  openingEl.hidden = false;
  let loaded: LoadedDocument;
  try {
    loaded = await openPdf(file);
  } catch (err) {
    openingEl.hidden = true;
    const msg = err instanceof OpenError ? err.message : `Something went wrong opening this file: ${(err as Error).message}`;
    if (state.doc) {
      await showMessage('Couldn’t open that PDF', msg);
    } else {
      openError.textContent = msg;
      openError.hidden = false;
    }
    return;
  }
  openingEl.hidden = true;
  await closeDocument();
  state.doc = loaded;
  state.dirty = false;
  startEl.hidden = true;
  workspace.hidden = false;
  $('file-name').textContent = loaded.name;
  $('file-name').title = loaded.name;
  pageCount.textContent = `of ${loaded.pdf.numPages}`;
  pageNum.value = '1';
  let widgets: Widget[] = [];
  let initial: FieldValues = new Map();
  try {
    ({ widgets, initial } = await readFormWidgets(loaded.pdf, loaded.geoms));
    blankFieldsInPreview(loaded.pdf, widgets);
  } catch {
    // A broken form doesn't stop signing; the page can still take text and signatures.
    widgets = [];
    initial = new Map();
  }
  viewer.load(loaded.pdf, loaded.geoms);
  form.load(widgets, initial);
  renderNotices(loaded.warnings);
  undoHistory.clear();
  setTool('select');
  refreshActions();
  const fieldCount = form.widgets.length;
  $('fill-hint').textContent = fieldCount
    ? `This PDF has ${fieldCount} fillable field${fieldCount > 1 ? 's' : ''}: click one and type. Tab moves to the next.`
    : 'No fillable fields: use Add Text, then click where the text goes.';
  document.title = `${loaded.name} · ${APP_NAME}`;
  brandName.textContent = `${loaded.name} · ${APP_NAME}`;
  announce(`Opened ${loaded.name}, ${loaded.pdf.numPages} page${loaded.pdf.numPages > 1 ? 's' : ''}.`);
  signBtn.focus();
}

function renderNotices(warnings: string[]): void {
  notices.replaceChildren(
    ...warnings.map((w) => {
      const div = document.createElement('div');
      div.className = 'alert warn';
      div.setAttribute('role', 'note');
      const p = document.createElement('p');
      p.textContent = w;
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'icon-btn';
      close.setAttribute('aria-label', 'Dismiss warning');
      close.textContent = '×';
      close.addEventListener('click', () => div.remove());
      div.append(p, close);
      return div;
    }),
  );
}

async function closeDocument(): Promise<void> {
  layer.clear();
  form.clear();
  undoHistory.clear();
  setTool('select');
  viewer.clear();
  notices.replaceChildren();
  const old = state.doc;
  state.doc = null;
  if (old) await old.pdf.loadingTask.destroy().catch(() => {});
}

function clearSignature(): void {
  for (const a of state.assets.values()) URL.revokeObjectURL(a.url);
  state.assets.clear();
  state.signature = null;
  pad.clear();
  typeName.value = '';
  clearPreview();
}

async function startOver(): Promise<void> {
  const pending = unsavedCount();
  if (pending > 0) {
    const ok = await confirmDiscard(
      `You have ${describeUnsaved()} you haven’t downloaded. Start over and discard ${pending > 1 ? 'them' : 'it'}?`,
      'Start over',
    );
    if (!ok) return;
  }
  await closeDocument();
  clearSignature();
  state.dirty = false;
  workspace.hidden = true;
  startEl.hidden = false;
  openError.hidden = true;
  document.title = APP_NAME;
  brandName.textContent = APP_NAME;
  refreshActions();
  announce('Cleared. The document and signature have been removed from this page.');
  $('open-btn').focus();
}

// ------------------------------------------------------------------ download
let exporting = false;
async function download(): Promise<void> {
  if (!state.doc) return;
  // Finish any text being typed so it's included.
  (document.activeElement as HTMLElement | null)?.blur?.();
  const fields = form.changedFields();
  if (layer.items.length === 0 && fields.length === 0) {
    showToast(
      state.signature ? 'Place your signature on a page first, or fill in the form.' : 'Add your signature first, or fill in the form.',
      'error',
    );
    return;
  }
  if (exporting) return;
  exporting = true;
  downloadBtn.classList.add('busy');
  const label = downloadBtn.textContent;
  downloadBtn.textContent = 'Saving…';
  try {
    const used = new Set(layer.items.flatMap((p) => (p.kind === 'image' ? [p.assetId] : [])));
    const items: ExportPlacement[] = layer.items.map((p) =>
      p.kind === 'image'
        ? { pageIndex: p.pageIndex, rect: p.rect, imageId: p.assetId }
        : p.kind === 'text'
          ? { kind: 'text', pageIndex: p.pageIndex, rect: p.rect, text: p.text }
          : { kind: 'check', pageIndex: p.pageIndex, rect: p.rect },
    );
    const bytes = await exportSignedPdf(
      state.doc.bytes,
      state.doc.geoms,
      items,
      [...state.assets.values()].filter((a) => used.has(a.id)).map((a) => ({ id: a.id, png: a.png })),
      { fields, baselineRatio: baselineRatio() },
    );
    const name = signedFileName(state.doc.name);
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/pdf' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    state.dirty = false;
    showToast(`Saved ${name}. Check your downloads.`, 'ok', 8000);
  } catch (err) {
    const msg = err instanceof ExportError ? err.message : `Unexpected error: ${(err as Error).message}`;
    await showMessage('The signed PDF wasn’t saved', `${msg} Everything you entered is still here, so you can try again.`);
  } finally {
    exporting = false;
    downloadBtn.classList.remove('busy');
    downloadBtn.textContent = label;
    refreshActions();
  }
}

// ------------------------------------------------------------------ placing
function placeOnCurrentPage(asset: SignatureAsset): void {
  if (!state.doc) return;
  const index = viewer.currentPage();
  const pageEl = viewer.pageElement(index);
  const g = state.doc.geoms[index];
  const size = displaySize(g);
  // Centre of the part of the page that is currently visible.
  const sr = viewer.scroller.getBoundingClientRect();
  const pr = pageEl.getBoundingClientRect();
  const top = Math.max(sr.top, pr.top);
  const bottom = Math.min(sr.bottom, pr.bottom);
  const left = Math.max(sr.left, pr.left);
  const right = Math.min(sr.right, pr.right);
  const k = size.width / pr.width;
  const center =
    bottom > top && right > left
      ? { x: ((left + right) / 2 - pr.left) * k, y: ((top + bottom) / 2 - pr.top) * k }
      : undefined;
  layer.add(index, asset.id, asset.width / asset.height, center);
}

// ------------------------------------------------------------------ signature dialog
const sigDialog = $<HTMLDialogElement>('sig-dialog');
const pad = new SignaturePad($<HTMLCanvasElement>('pad'));
const padHint = $('pad-hint');
const typeName = $<HTMLInputElement>('type-name');
const fontChoices = $('font-choices');
const imageInput = $<HTMLInputElement>('image-input');
const removeBg = $<HTMLInputElement>('remove-bg');
const sigError = $('sig-error');
const previewWrap = $('sig-preview-wrap');
const previewImg = $<HTMLImageElement>('sig-preview');
const inkField = $('ink-field');
type Tab = 'draw' | 'type' | 'image';
let tab: Tab = 'draw';
let previewAsset: SignatureAsset | null = null;
let imageFile: File | null = null;

SIGNATURE_FONTS.forEach((f, i) => {
  const label = document.createElement('label');
  label.className = 'font-choice';
  const input = document.createElement('input');
  input.type = 'radio';
  input.name = 'font';
  input.value = f.family;
  input.checked = i === 0;
  const sample = document.createElement('span');
  sample.className = 'font-sample';
  sample.style.fontFamily = `"${f.family}", cursive`;
  sample.textContent = 'Your name';
  sample.dataset.sample = '';
  sample.setAttribute('aria-hidden', 'true');
  const caption = document.createElement('span');
  caption.className = 'sr-only';
  caption.textContent = f.label;
  label.append(input, sample, caption);
  fontChoices.append(label);
});

const ink = () => (document.querySelector<HTMLInputElement>('input[name="ink"]:checked')?.value ?? '#111111');
const font = () => (document.querySelector<HTMLInputElement>('input[name="font"]:checked')?.value ?? SIGNATURE_FONTS[0].family);

function clearPreview(): void {
  if (previewAsset) URL.revokeObjectURL(previewAsset.url);
  previewAsset = null;
  previewWrap.hidden = true;
  previewImg.removeAttribute('src');
}

function setError(msg: string | null): void {
  sigError.textContent = msg ?? '';
  sigError.hidden = !msg;
}

let previewSeq = 0;
async function updatePreview(): Promise<void> {
  const seq = ++previewSeq;
  setError(null);
  clearPreview();
  try {
    let asset: SignatureAsset | null = null;
    if (tab === 'type' && typeName.value.trim()) asset = await typedSignature(typeName.value, font(), ink());
    if (tab === 'image' && imageFile) asset = await importedSignature(imageFile, removeBg.checked);
    if (seq !== previewSeq) {
      if (asset) URL.revokeObjectURL(asset.url);
      return;
    }
    if (asset) {
      previewAsset = asset;
      previewImg.src = asset.url;
      previewWrap.hidden = false;
    }
  } catch (err) {
    if (seq === previewSeq) setError((err as Error).message);
  }
}

let previewTimer = 0;
const schedulePreview = () => {
  clearTimeout(previewTimer);
  previewTimer = window.setTimeout(() => void updatePreview(), 150);
};

function selectTab(next: Tab, focus = false): void {
  tab = next;
  for (const t of ['draw', 'type', 'image'] as Tab[]) {
    const btn = $(`tab-${t}`);
    btn.setAttribute('aria-selected', String(t === next));
    btn.tabIndex = t === next ? 0 : -1;
    $(`panel-${t}`).hidden = t !== next;
    if (t === next && focus) btn.focus();
  }
  inkField.hidden = next === 'image';
  setError(null);
  clearPreview();
  if (next !== 'draw') void updatePreview();
  if (next === 'type') typeName.focus();
}

function openSignatureDialog(): void {
  setError(null);
  sigDialog.showModal();
  if (tab === 'type') typeName.focus();
  else $(`tab-${tab}`).focus();
}

async function useSignature(): Promise<void> {
  setError(null);
  let asset: SignatureAsset;
  try {
    if (tab === 'draw') asset = await pad.toAsset();
    // Always regenerate from the current inputs, so a stale preview is never used.
    else if (tab === 'type') asset = await typedSignature(typeName.value, font(), ink());
    else {
      if (!imageFile) throw new SignatureError('Choose an image of your signature first.');
      asset = await importedSignature(imageFile, removeBg.checked);
    }
  } catch (err) {
    setError(err instanceof SignatureError ? err.message : `Couldn’t create the signature: ${(err as Error).message}`);
    return;
  }
  clearTimeout(previewTimer);
  previewSeq++;
  clearPreview();
  state.assets.set(asset.id, asset);
  state.signature = asset;
  sigDialog.close();
  refreshActions();
  // Every new signature is placed on the current page right away; earlier
  // placements keep the signature they were made with.
  placeOnCurrentPage(asset);
}

// tabs with arrow-key navigation (WAI-ARIA tabs pattern)
(['draw', 'type', 'image'] as Tab[]).forEach((t, i, all) => {
  const btn = $(`tab-${t}`);
  btn.addEventListener('click', () => selectTab(t));
  btn.addEventListener('keydown', (e) => {
    const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (d) {
      e.preventDefault();
      selectTab(all[(i + d + all.length) % all.length], true);
    }
  });
});

pad.onChange = () => {
  padHint.hidden = !pad.isEmpty;
  setError(null);
};
$('pad-undo').addEventListener('click', () => pad.undo());
$('pad-clear').addEventListener('click', () => pad.clear());
typeName.addEventListener('input', () => {
  document.querySelectorAll<HTMLElement>('[data-sample]').forEach((s) => (s.textContent = typeName.value.trim() || 'Your name'));
  schedulePreview();
});
fontChoices.addEventListener('change', schedulePreview);
inkField.addEventListener('change', () => {
  pad.setColor(ink());
  schedulePreview();
});
$('image-pick').addEventListener('click', () => imageInput.click());
imageInput.addEventListener('change', () => {
  imageFile = imageInput.files?.[0] ?? null;
  $('image-name').textContent = imageFile?.name ?? '';
  imageInput.value = '';
  void updatePreview();
});
removeBg.addEventListener('change', () => void updatePreview());
$<HTMLFormElement>('sig-form').addEventListener('submit', (e) => {
  e.preventDefault();
  void useSignature();
});
document.querySelectorAll<HTMLElement>('[data-close]').forEach((b) =>
  b.addEventListener('click', () => (b.closest('dialog') as HTMLDialogElement).close()),
);
// Close dialogs by clicking the backdrop.
document.querySelectorAll('dialog').forEach((d) =>
  d.addEventListener('click', (e) => {
    if (e.target === d) d.close();
  }),
);

// ------------------------------------------------------------------ wiring
$('open-btn').addEventListener('click', () => fileInput.click());
$('other-btn').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => void handleFile(fileInput.files?.[0]));
$('reset-btn').addEventListener('click', () => void startOver());
downloadBtn.addEventListener('click', () => void download());
signBtn.addEventListener('click', () => {
  if (state.signature) placeOnCurrentPage(state.signature);
  else openSignatureDialog();
});
changeSig.addEventListener('click', () => openSignatureDialog());

$('prev-page').addEventListener('click', () => viewer.scrollToPage(viewer.currentPage() - 1));
$('next-page').addEventListener('click', () => viewer.scrollToPage(viewer.currentPage() + 1));
pageNum.addEventListener('change', () => {
  const n = parseInt(pageNum.value, 10);
  if (Number.isFinite(n)) viewer.scrollToPage(n - 1);
  pageNum.value = String(viewer.currentPage() + 1);
});
pageNum.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') pageNum.dispatchEvent(new Event('change'));
});
viewer.onPageChange = (i) => {
  if (document.activeElement !== pageNum) pageNum.value = String(i + 1);
};
viewer.onZoomChange = (z) => {
  zoomLevel.textContent = `${Math.round(z * 100)}%`;
};
const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];
$('zoom-in').addEventListener('click', () => viewer.setZoom(ZOOM_STEPS.find((s) => s > viewer.zoom + 0.001) ?? 4));
$('zoom-out').addEventListener('click', () => viewer.setZoom([...ZOOM_STEPS].reverse().find((s) => s < viewer.zoom - 0.001) ?? 0.25));
$('zoom-fit').addEventListener('click', () => viewer.setZoom('fit'));

const faq = $<HTMLDialogElement>('faq-dialog');
$('faq-open').addEventListener('click', () => faq.showModal());
document.querySelectorAll<HTMLElement>('[data-faq]').forEach((b) =>
  b.addEventListener('click', () => {
    faq.showModal();
    $('faq-privacy').scrollIntoView({ block: 'start' });
  }),
);

// Drag and drop anywhere.
const dropOverlay = $('drop-overlay');
let dragDepth = 0;
const hasFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  dropOverlay.hidden = false;
});
window.addEventListener('dragover', (e) => {
  if (hasFiles(e)) e.preventDefault();
});
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) dropOverlay.hidden = true;
});
window.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  dropOverlay.hidden = true;
  if (document.querySelector('dialog[open]')) return;
  void handleFile(e.dataTransfer?.files[0]);
});

// Keyboard shortcuts for zoom while a document is open.
window.addEventListener('keydown', (e) => {
  if (!state.doc || document.querySelector('dialog[open]')) return;
  if ((e.ctrlKey || e.metaKey) && (e.key === '=' || e.key === '+')) {
    e.preventDefault();
    $('zoom-in').click();
  } else if ((e.ctrlKey || e.metaKey) && e.key === '-') {
    e.preventDefault();
    $('zoom-out').click();
  } else if ((e.ctrlKey || e.metaKey) && e.key === '0') {
    e.preventDefault();
    viewer.setZoom('fit');
  }
});

// Never lose unsaved work silently.
window.addEventListener('beforeunload', (e) => {
  if (unsavedCount() > 0) {
    e.preventDefault();
    e.returnValue = '';
  }
});

// ------------------------------------------------------------------ fill tools
type Tool = 'select' | 'text' | 'check';
let tool: Tool = 'select';
function setTool(next: Tool): void {
  tool = next;
  toolText.setAttribute('aria-pressed', String(next === 'text'));
  toolCheck.setAttribute('aria-pressed', String(next === 'check'));
  workspace.dataset.tool = next;
}
toolText.addEventListener('click', () => {
  setTool(tool === 'text' ? 'select' : 'text');
  if (tool === 'text') announce('Add Text: click or tap where the text goes, then type. Press Escape when done.');
});
toolCheck.addEventListener('click', () => {
  setTool(tool === 'check' ? 'select' : 'check');
  if (tool === 'check') announce('Checkmark: click or tap where the checkmark goes. Press Escape when done.');
});
undoBtn.addEventListener('click', () => {
  if (!undoHistory.undo()) showToast('Nothing to undo.', 'error', 2500);
  else announce('Undone.');
});

// A click on an empty spot of a page, with a fill tool active, puts text or a checkmark there.
$('pages').addEventListener('click', (e) => {
  if (!state.doc || tool === 'select') return;
  const overlay = e.target as HTMLElement;
  if (!overlay.classList.contains('overlay')) return;
  const pageIndex = Number(overlay.parentElement!.dataset.page);
  const r = overlay.getBoundingClientRect();
  const k = displaySize(state.doc.geoms[pageIndex]).width / r.width;
  const at = { x: (e.clientX - r.left) * k, y: (e.clientY - r.top) * k };
  if (tool === 'text') layer.addText(pageIndex, at);
  else layer.addCheck(pageIndex, at);
});

window.addEventListener('keydown', (e) => {
  if (!state.doc || document.querySelector('dialog[open]')) return;
  const t = e.target as HTMLElement;
  const typing = t.tagName === 'TEXTAREA' || (t.tagName === 'INPUT' && !['checkbox', 'radio'].includes((t as HTMLInputElement).type));
  if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'z' && !typing) {
    e.preventDefault();
    undoBtn.click();
  } else if (e.key === 'Escape' && tool !== 'select' && !typing) {
    setTool('select');
  }
});

// iOS zooms the whole page when a small text input gets focus; the app has its own zoom.
if (/iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) {
  document.querySelector('meta[name="viewport"]')?.setAttribute('content', 'width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover');
}

// Test hook: read-only counters, no document content.
(window as unknown as { __vnuaSignature: object }).__vnuaSignature = {
  renderedPages: () => viewer.renderedCount(),
  pageSize: (i: number) => (state.doc ? displaySize(state.doc.geoms[i]) : null),
  baselineRatio: () => baselineRatio(),
  zoom: () => viewer.zoom,
};

refreshActions();
