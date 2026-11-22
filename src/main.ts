import '@fontsource/dancing-script/latin-400.css';
import '@fontsource/great-vibes/latin-400.css';
import '@fontsource/caveat/latin-400.css';
import './style.css';

import { displaySize } from './geometry';
import { ExportError, exportSignedPdf, signedFileName } from './export';
import { OpenError, openPdf, startPdfWorker, type LoadedDocument } from './pdf';
import { PlacementLayer } from './placements';
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
const toast = $('toast');
const srAnnounce = $('sr-announce');

const layer = new PlacementLayer({
  geom: (i) => state.doc!.geoms[i],
  overlay: (i) => viewer.overlay(i),
  assetUrl: (id) => state.assets.get(id)!.url,
  announce,
  changed: () => {
    state.dirty = true;
    refreshActions();
  },
});

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
  $('confirm-title').textContent = 'Discard your signatures?';
  $('confirm-text').textContent = text;
  $('confirm-ok').textContent = okLabel;
  d.returnValue = '';
  d.showModal();
  $('confirm-cancel').focus();
  return new Promise((resolve) => d.addEventListener('close', () => resolve(d.returnValue === 'ok'), { once: true }));
}

function unsavedCount(): number {
  return state.dirty ? layer.items.length : 0;
}

function refreshActions(): void {
  const n = layer.items.length;
  downloadBtn.setAttribute('aria-disabled', String(n === 0));
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
      `You have ${pending} signature placement${pending > 1 ? 's' : ''} on “${state.doc?.name}” that you haven’t downloaded. Opening another PDF will discard ${pending > 1 ? 'them' : 'it'}.`,
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
  viewer.load(loaded.pdf, loaded.geoms);
  renderNotices(loaded.warnings);
  refreshActions();
  document.title = `${loaded.name} · Sign PDF`;
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
      `You have ${pending} signature placement${pending > 1 ? 's' : ''} you haven’t downloaded. Start over and discard ${pending > 1 ? 'them' : 'it'}?`,
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
  document.title = 'Sign PDF: no account, no upload';
  refreshActions();
  announce('Cleared. The document and signature have been removed from this page.');
  $('open-btn').focus();
}

// ------------------------------------------------------------------ download
let exporting = false;
async function download(): Promise<void> {
  if (!state.doc) return;
  if (layer.items.length === 0) {
    showToast(state.signature ? 'Place your signature on a page first.' : 'Add your signature first.', 'error');
    return;
  }
  if (exporting) return;
  exporting = true;
  downloadBtn.classList.add('busy');
  const label = downloadBtn.textContent;
  downloadBtn.textContent = 'Saving…';
  try {
    const used = new Set(layer.items.map((p) => p.assetId));
    const bytes = await exportSignedPdf(
      state.doc.bytes,
      state.doc.geoms,
      layer.items.map((p) => ({ pageIndex: p.pageIndex, rect: p.rect, imageId: p.assetId })),
      [...state.assets.values()].filter((a) => used.has(a.id)).map((a) => ({ id: a.id, png: a.png })),
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
    const pages = new Set(layer.items.map((p) => p.pageIndex)).size;
    showToast(`Saved ${name} (signed on ${pages} page${pages > 1 ? 's' : ''}). Check your downloads.`, 'ok', 8000);
  } catch (err) {
    const msg = err instanceof ExportError ? err.message : `Unexpected error: ${(err as Error).message}`;
    await showMessage('The signed PDF wasn’t saved', `${msg} Your signatures are still on the page, so you can try again.`);
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

// Test hook: read-only counters, no document content.
(window as unknown as { __signPdf: object }).__signPdf = {
  renderedPages: () => viewer.renderedCount(),
  zoom: () => viewer.zoom,
};

refreshActions();
