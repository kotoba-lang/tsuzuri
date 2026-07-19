#!/usr/bin/env node
// fetch-vendor.mjs — download every runtime dependency into public/vendor/ so
// tsuzuri runs FULLY OFFLINE (no network egress) for Charter §2 supply-chain
// hardening. After running this, swap index.html's importmap for the generated
// public/vendor/importmap.vendored.json and enable the CSP meta.
//
// SPDX-License-Identifier: Apache-2.0
//
// Sources are the SELF-CONTAINED npm `dist` builds (not esm.sh, whose modules
// re-import sub-paths from the CDN and would defeat offline). Pinned versions
// mirror the CDN importmap in index.html.
//
//   node scripts/fetch-vendor.mjs
//
// public/vendor/ is .gitignored — these are large third-party binaries
// (≈50 MB incl. OCR language data); reproduce locally rather than committing.

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = join(ROOT, 'public', 'vendor');

// [url, destination-relative-to-public/vendor, importmap-bare-specifier?]
const ASSETS = [
  ['https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.esm.js', 'pdf-lib.esm.js', 'pdf-lib'],
  ['https://cdn.jsdelivr.net/npm/@pdf-lib/fontkit@1.1.1/dist/fontkit.es.js', 'fontkit.es.js', '@pdf-lib/fontkit'],
  // fontkit.es.js's only external import is pako (zlib); pako has no deps so it
  // vendors as a self-contained ESM and is resolved via the importmap.
  ['https://cdn.jsdelivr.net/npm/pako@2.1.0/dist/pako.esm.mjs', 'pako.esm.mjs', 'pako'],
  ['https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/build/pdf.mjs', 'pdfjs/pdf.mjs', 'pdfjs-dist'],
  ['https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/build/pdf.worker.mjs', 'pdfjs/pdf.worker.mjs', 'pdfjs-dist/worker'],
  ['https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.esm.min.js', 'tesseract/tesseract.esm.min.js', 'tesseract.js'],
  // tesseract worker + wasm core + OCR language data (loaded at OCR time, not via importmap)
  ['https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/worker.min.js', 'tesseract/worker.min.js'],
  ['https://cdn.jsdelivr.net/npm/tesseract.js-core@5.1.1/tesseract-core.wasm.js', 'tesseract/tesseract-core.wasm.js'],
  ['https://cdn.jsdelivr.net/npm/tesseract.js-core@5.1.1/tesseract-core.wasm', 'tesseract/tesseract-core.wasm'],
  ['https://cdn.jsdelivr.net/npm/tesseract.js-core@5.1.1/tesseract-core-simd.wasm.js', 'tesseract/tesseract-core-simd.wasm.js'],
  ['https://cdn.jsdelivr.net/npm/tesseract.js-core@5.1.1/tesseract-core-simd.wasm', 'tesseract/tesseract-core-simd.wasm'],
  ['https://cdn.jsdelivr.net/gh/naptha/tessdata@gh-pages/4.0.0_best/eng.traineddata.gz', 'tesseract/lang/eng.traineddata.gz'],
  ['https://cdn.jsdelivr.net/gh/naptha/tessdata@gh-pages/4.0.0_best/jpn.traineddata.gz', 'tesseract/lang/jpn.traineddata.gz'],
  // embedded CJK font (OFL-1.1) — Sawarabi Gothic, static TrueType, subsets cleanly
  ['https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/sawarabigothic/SawarabiGothic-Regular.ttf', 'fonts/jp.ttf'],
];

async function get(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

const importmap = { imports: {} };
const manifest = { generatedBy: 'fetch-vendor.mjs', assets: [], note: 'offline vendor bundle' };
let ok = 0, fail = 0;

for (const [url, dest, spec] of ASSETS) {
  const out = join(VENDOR, dest);
  process.stdout.write(`↓ ${dest} … `);
  try {
    const bytes = await get(url);
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, bytes);
    if (spec) importmap.imports[spec] = './vendor/' + dest;
    manifest.assets.push({ dest, bytes: bytes.length, source: url });
    console.log(`${(bytes.length / 1024).toFixed(0)} KB`);
    ok++;
  } catch (e) {
    console.log(`FAILED (${e.message})`);
    fail++;
  }
}

// tesseract runtime paths (consumed by tsuzuri.js when vendored)
manifest.tesseract = {
  workerPath: './vendor/tesseract/worker.min.js',
  corePath: './vendor/tesseract/',
  langPath: './vendor/tesseract/lang',
};

await writeFile(join(VENDOR, 'importmap.vendored.json'), JSON.stringify(importmap, null, 2) + '\n');
await writeFile(join(VENDOR, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

console.log(`\n${ok} ok, ${fail} failed.`);
console.log('Wrote public/vendor/importmap.vendored.json + manifest.json');
console.log('\nNext: in public/index.html replace the <script type="importmap"> block');
console.log('with importmap.vendored.json, and uncomment the CSP <meta>.');
process.exit(fail ? 1 : 0);
