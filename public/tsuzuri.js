// tsuzuri 綴 — Adobe-independent, in-browser PDF editor (MVP)
// SPDX-License-Identifier: Apache-2.0
// etzhayyim Charter Compliance Rider v2.0.
//
// Substrate boundary: the PDF bytes never leave this device. Every operation
// (render / edit / OCR) runs client-side via WASM/JS. No server, no upload.
//
// Libraries (all Apache-2.0 / MIT / OFL — no Adobe, no AGPL):
//   pdf-lib          MIT          structural editing + save
//   @pdf-lib/fontkit MIT          custom (CJK) font embedding + subsetting
//   pdfjs-dist       Apache-2.0   page rendering to canvas (Mozilla)
//   tesseract.js     Apache-2.0   WASM OCR
//   <JP font>        OFL-1.1      embedded for Japanese text annotations
//
// Imports use BARE specifiers resolved by the <script type="importmap"> in
// index.html. Default map -> esm.sh CDN; swap the map for ./vendor/* after
// running scripts/fetch-vendor.mjs for full offline (see README "Hardening").

import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import * as pdfjsLib from 'pdfjs-dist';

// Worker URL is not an import, but import.meta.resolve honors the importmap.
pdfjsLib.GlobalWorkerOptions.workerSrc =
  (import.meta.resolve && import.meta.resolve('pdfjs-dist/worker')) ||
  'https://esm.sh/pdfjs-dist@4.7.76/build/pdf.worker.mjs';

// ---- Japanese (CJK) font ---------------------------------------------------
// Vendored path first (offline), then a static TrueType JP font on CDN.
// Sawarabi Gothic (OFL-1.1) is a static TTF that subsets cleanly in pdf-lib;
// swap to Noto Sans JP by vendoring it to ./vendor/fonts/jp.ttf.
const JP_FONT_SOURCES = [
  './vendor/fonts/jp.ttf',
  'https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/sawarabigothic/SawarabiGothic-Regular.ttf',
];
let _jpFontBytes = null;
async function jpFontBytes() {
  if (_jpFontBytes) return _jpFontBytes;
  for (const url of JP_FONT_SOURCES) {
    try {
      const r = await fetch(url);
      if (r.ok) return (_jpFontBytes = new Uint8Array(await r.arrayBuffer()));
    } catch { /* try next source */ }
  }
  throw new Error('日本語フォントの読み込みに失敗しました');
}
const isAscii = (s) => /^[\x00-\x7F]*$/.test(s);

// Tesseract is loaded lazily on first OCR (keeps initial load light).
// Resolved via importmap ('tesseract.js') so CDN/vendor swap needs no code change.
let _tesseract = null;
async function tesseract() {
  if (!_tesseract) {
    const mod = await import('tesseract.js');
    _tesseract = mod.default ?? mod;
  }
  return _tesseract;
}

// When fetch-vendor.mjs has run, public/vendor/manifest.json carries local
// worker/core/lang paths so OCR makes zero network requests (CSP connect-src
// 'self'). Absent (CDN mode) -> tesseract uses its own defaults.
let _vendorTess = undefined;
async function vendorTesseractOpts() {
  if (_vendorTess !== undefined) return _vendorTess;
  try {
    const r = await fetch('./vendor/manifest.json');
    _vendorTess = r.ok ? (await r.json()).tesseract || null : null;
  } catch {
    _vendorTess = null;
  }
  return _vendorTess;
}

// ---------------------------------------------------------------- state -----

const state = {
  bytes: null,        // Uint8Array — current PDF, single source of truth
  pageCount: 0,
  current: 0,         // selected page index (0-based)
  fileName: 'tsuzuri.pdf',
  addText: false,
  lastOcr: '',
  mainScale: 1.3,
};

const $ = (id) => document.getElementById(id);
const els = {};
['thumbs', 'page', 'empty', 'status', 'pageno', 'pagecount', 'open', 'open-empty',
 'merge', 'save', 'rot-l', 'rot-r', 'up', 'down', 'del', 'addtext', 'textval',
 'textsize', 'range', 'extract', 'ocr', 'ocrdl', 'ocrout', 'ocrlang', 'meta-title',
 'meta-author', 'meta-save', 'file', 'file-merge', 'drop'].forEach((k) => (els[k] = $(k)));

function status(msg, kind = '') {
  els.status.textContent = msg;
  els.status.style.color = kind === 'err' ? '#b4503c' : kind === 'ok' ? '#5d8a4a' : '';
}

function setBusy(b) {
  document.body.style.cursor = b ? 'progress' : '';
}

// ------------------------------------------------------------ pdf helpers ---

// Load current bytes into a fresh pdf-lib doc, mutate via fn, persist + re-render.
async function edit(fn, msg) {
  setBusy(true);
  try {
    const doc = await PDFDocument.load(state.bytes);
    await fn(doc);
    state.bytes = await doc.save();
    state.pageCount = doc.getPageCount();
    if (state.current >= state.pageCount) state.current = state.pageCount - 1;
    await render();
    if (msg) status(msg, 'ok');
  } catch (e) {
    console.error(e);
    status('編集に失敗: ' + e.message, 'err');
  } finally {
    setBusy(false);
  }
}

// pdf.js detaches the buffer it is given; always hand it a fresh copy.
function freshCopy() {
  return state.bytes.slice();
}

async function loadBytes(bytes, fileName) {
  state.bytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  state.fileName = fileName || state.fileName;
  state.current = 0;
  // validate + read metadata
  const doc = await PDFDocument.load(state.bytes);
  state.pageCount = doc.getPageCount();
  els['meta-title'].value = doc.getTitle() || '';
  els['meta-author'].value = doc.getAuthor() || '';
  await render();
  enableUI(true);
  status(`読み込み完了 — ${state.pageCount} ページ`, 'ok');
}

// ---------------------------------------------------------------- render ----

async function render() {
  els.empty.hidden = true;
  els.page.hidden = false;
  const pdf = await pdfjsLib.getDocument({ data: freshCopy() }).promise;
  await Promise.all([renderThumbs(pdf), renderMain(pdf)]);
  els.pageno.textContent = state.current + 1;
  els.pagecount.textContent = state.pageCount;
}

async function renderThumbs(pdf) {
  els.thumbs.innerHTML = '';
  for (let i = 0; i < pdf.numPages; i++) {
    const wrap = document.createElement('div');
    wrap.className = 'thumb' + (i === state.current ? ' active' : '');
    wrap.innerHTML = `<span class="n">${i + 1}</span>`;
    const canvas = document.createElement('canvas');
    wrap.appendChild(canvas);
    wrap.onclick = () => selectPage(i);
    els.thumbs.appendChild(wrap);
    const pg = await pdf.getPage(i + 1);
    const vp = pg.getViewport({ scale: 0.28 });
    canvas.width = vp.width; canvas.height = vp.height;
    await pg.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
  }
}

let mainViewport = null;
async function renderMain(pdf) {
  const pg = await pdf.getPage(state.current + 1);
  const vp = pg.getViewport({ scale: state.mainScale });
  mainViewport = vp;
  els.page.width = vp.width; els.page.height = vp.height;
  await pg.render({ canvasContext: els.page.getContext('2d'), viewport: vp }).promise;
}

async function selectPage(i) {
  state.current = i;
  const pdf = await pdfjsLib.getDocument({ data: freshCopy() }).promise;
  await renderMain(pdf);
  [...els.thumbs.children].forEach((c, k) => c.classList.toggle('active', k === i));
  els.pageno.textContent = i + 1;
}

// ----------------------------------------------------------- page ops -------

function reorderedIndices(move) {
  const idx = [...Array(state.pageCount).keys()];
  const i = state.current;
  if (move === 'up' && i > 0) { [idx[i - 1], idx[i]] = [idx[i], idx[i - 1]]; state.current = i - 1; }
  if (move === 'down' && i < state.pageCount - 1) { [idx[i + 1], idx[i]] = [idx[i], idx[i + 1]]; state.current = i + 1; }
  if (move === 'del') idx.splice(i, 1);
  return idx;
}

// Rebuild the document from an explicit page-index order (used by move/delete).
// Standalone (not via edit()) because it replaces the whole document.
async function applyOrder(idx, msg) {
  setBusy(true);
  try {
    const src = await PDFDocument.load(state.bytes);
    const out = await PDFDocument.create();
    const pages = await out.copyPages(src, idx);
    pages.forEach((p) => out.addPage(p));
    state.bytes = await out.save();
    state.pageCount = idx.length;
    if (state.current >= state.pageCount) state.current = state.pageCount - 1;
    await render();
    status(msg, 'ok');
  } catch (e) {
    console.error(e);
    status('編集に失敗: ' + e.message, 'err');
  } finally {
    setBusy(false);
  }
}

function rotate(deg) {
  return edit(async (doc) => {
    const pg = doc.getPage(state.current);
    pg.setRotation(degrees((pg.getRotation().angle + deg + 360) % 360));
  }, `${deg > 0 ? '右' : '左'}に回転`);
}

// parse "1-3,5" (1-based) -> 0-based index array, bounded
function parseRange(str, max) {
  const out = [];
  for (const part of str.split(',').map((s) => s.trim()).filter(Boolean)) {
    const m = part.match(/^(\d+)(?:-(\d+))?$/);
    if (!m) continue;
    let a = +m[1], b = m[2] ? +m[2] : a;
    if (a > b) [a, b] = [b, a];
    for (let n = a; n <= b; n++) if (n >= 1 && n <= max) out.push(n - 1);
  }
  return out;
}

// ----------------------------------------------------------- text add -------

async function placeText(clientX, clientY) {
  const txt = els.textval.value.trim();
  if (!txt) { status('追記する文字を入力してください', 'err'); return; }
  const rect = els.page.getBoundingClientRect();
  // canvas device px (== viewport px at mainScale)
  const cx = (clientX - rect.left) * (els.page.width / rect.width);
  const cy = (clientY - rect.top) * (els.page.height / rect.height);
  const size = Math.max(6, Math.min(96, +els.textsize.value || 18));
  await edit(async (doc) => {
    const pg = doc.getPage(state.current);
    const { height } = pg.getSize();
    // ASCII -> Standard14 Helvetica (no download). Non-ASCII (日本語等) ->
    // subset-embed a CJK TrueType font via fontkit.
    let font;
    if (isAscii(txt)) {
      font = await doc.embedFont(StandardFonts.Helvetica);
    } else {
      doc.registerFontkit(fontkit);
      font = await doc.embedFont(await jpFontBytes(), { subset: true });
    }
    // viewport px -> PDF point (origin bottom-left). Assumes unrotated page.
    const x = cx / state.mainScale;
    const y = height - cy / state.mainScale;
    pg.drawText(txt, { x, y, size, font, color: rgb(0.05, 0.05, 0.05) });
  }, '文字を配置しました');
}

// -------------------------------------------------------------- OCR ---------

async function runOcr() {
  setBusy(true); status('OCR 実行中…（初回は言語データDL）');
  try {
    const T = await tesseract();
    // hi-res render of current page for accuracy
    const pdf = await pdfjsLib.getDocument({ data: freshCopy() }).promise;
    const pg = await pdf.getPage(state.current + 1);
    const vp = pg.getViewport({ scale: 2.4 });
    const c = document.createElement('canvas');
    c.width = vp.width; c.height = vp.height;
    await pg.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
    const lang = els.ocrlang.value.trim() || 'eng';
    const opts = {
      logger: (m) => m.status && status(`OCR: ${m.status} ${Math.round((m.progress || 0) * 100)}%`),
    };
    const v = await vendorTesseractOpts();
    if (v) Object.assign(opts, v); // local worker/core/lang -> no network
    const { data } = await T.recognize(c, lang, opts);
    state.lastOcr = data.text || '';
    els.ocrout.textContent = state.lastOcr || '(認識テキストなし)';
    els.ocrdl.disabled = !state.lastOcr;
    status('OCR 完了', 'ok');
  } catch (e) {
    console.error(e);
    status('OCR 失敗: ' + e.message, 'err');
  } finally {
    setBusy(false);
  }
}

// -------------------------------------------------------------- io ----------

function download(bytes, name, mime = 'application/pdf') {
  const blob = new Blob([bytes], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
}

async function openFile(file) {
  if (!file) return;
  if (file.type && file.type !== 'application/pdf') { status('PDF を選んでください', 'err'); return; }
  const buf = await file.arrayBuffer();
  await loadBytes(new Uint8Array(buf), file.name);
}

async function mergeFile(file) {
  if (!file) return;
  const buf = await file.arrayBuffer();
  await edit(async (doc) => {
    const add = await PDFDocument.load(buf);
    const pages = await doc.copyPages(add, add.getPageIndices());
    pages.forEach((p) => doc.addPage(p));
  }, `${file.name} を結合`);
}

async function extractRange() {
  const idx = parseRange(els.range.value, state.pageCount);
  if (!idx.length) { status('範囲が不正です（例: 1-3,5）', 'err'); return; }
  setBusy(true);
  try {
    const src = await PDFDocument.load(state.bytes);
    const out = await PDFDocument.create();
    const pages = await out.copyPages(src, idx);
    pages.forEach((p) => out.addPage(p));
    download(await out.save(), state.fileName.replace(/\.pdf$/i, '') + `_p${els.range.value}.pdf`);
    status(`${idx.length} ページを抽出`, 'ok');
  } catch (e) { status('抽出失敗: ' + e.message, 'err'); }
  finally { setBusy(false); }
}

function saveMeta() {
  return edit(async (doc) => {
    doc.setTitle(els['meta-title'].value || '');
    doc.setAuthor(els['meta-author'].value || '');
    doc.setProducer('tsuzuri 綴 (etzhayyim)');
  }, 'メタデータを反映');
}

// ---------------------------------------------------------------- ui --------

function enableUI(on) {
  ['merge', 'save', 'rot-l', 'rot-r', 'up', 'down', 'del', 'addtext',
   'extract', 'ocr', 'meta-save'].forEach((k) => (els[k].disabled = !on));
}

function wire() {
  els.open.onclick = els['open-empty'].onclick = () => els.file.click();
  els.file.onchange = (e) => openFile(e.target.files[0]);
  els.merge.onclick = () => els['file-merge'].click();
  els['file-merge'].onchange = (e) => mergeFile(e.target.files[0]);

  els.save.onclick = () => download(state.bytes, state.fileName);
  els['rot-l'].onclick = () => rotate(-90);
  els['rot-r'].onclick = () => rotate(90);
  els.up.onclick = () => applyOrder(reorderedIndices('up'), '前へ移動');
  els.down.onclick = () => applyOrder(reorderedIndices('down'), '後へ移動');
  els.del.onclick = () => {
    if (state.pageCount <= 1) { status('最後の1ページは削除できません', 'err'); return; }
    applyOrder(reorderedIndices('del'), 'ページを削除');
  };

  els.addtext.onclick = () => {
    state.addText = !state.addText;
    els.addtext.classList.toggle('on', state.addText);
    status(state.addText ? '配置モード: ページ上をクリック' : '配置モード OFF');
  };
  els.page.onclick = (e) => { if (state.addText) placeText(e.clientX, e.clientY); };

  els.extract.onclick = extractRange;
  els.ocr.onclick = runOcr;
  els.ocrdl.onclick = () => download(state.lastOcr, state.fileName.replace(/\.pdf$/i, '') + `_p${state.current + 1}.txt`, 'text/plain');
  els['meta-save'].onclick = saveMeta;

  // drag & drop
  const stage = document.getElementById('stage');
  ['dragover', 'dragenter'].forEach((ev) => stage.addEventListener(ev, (e) => {
    e.preventDefault(); els.drop && els.drop.classList.add('hot');
  }));
  ['dragleave', 'drop'].forEach((ev) => stage.addEventListener(ev, () => els.drop && els.drop.classList.remove('hot')));
  stage.addEventListener('drop', (e) => {
    e.preventDefault();
    const f = [...(e.dataTransfer?.files || [])].find((x) => x.type === 'application/pdf' || /\.pdf$/i.test(x.name));
    if (f) openFile(f);
  });
}

wire();
status('PDF を開いてください');
