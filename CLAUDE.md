# 60-apps/tsuzuri — 綴 (in-browser PDF editor)

**Adobe非依存・端末内完結 PDF editor.** 全処理がブラウザ内 WASM/JS。ファイルは端末外に出ない。
詳細は [`README.md`](./README.md)。

## Identity / actor 登録

- **Canonical actor DID**: `did:web:etzhayyim.com:actor:tsuzuri`
- 登録 SSoT: `00-contracts/schemas/actor-profile-seed.kotoba.edn`（`:actor/handle "tsuzuri"`、kind `:infra` / tier `app`）
- 互換フォールバック: `50-infra/etzhayyim-did-web/src/registry/infra-actors.ts`（`INFRA_ACTORS.tsuzuri`）
- アプリ manifest: `kotodama.jsonld`（`uiType: ameno` / `runtimeType: browser-local`）

## ameno 統合スコープ（正直な区別 — CRITICAL）

tsuzuri は **DOM ベースのブラウザアプリ**であり、**単一の WASM コンポーネントではない**。
従って ameno の `wasm-actor-loader`（`EtzhayyimWasmComponent` + `ipfs://<cid>` を
fetch + CID 検証して headless 実行）の**ロード対象ではない**。tsumugi/watatsuna 等の
`:actor/wasm-cid` を持つ componentize 系 actor とは別カテゴリ。

- 実行モデルは ameno の **browser-local**（端末内 WASM/JS 実行）に一致 → service type は
  `EtzhayyimBrowserLocalApp`（`EtzhayyimWasmComponent` を**詐称しない**）。
- アプリが**使う** WASM は依存（pdf.js / tesseract.js）側であり、アプリ自身を 1 つの
  wasm component 化はしていない（DOM 必須のため不可）。`wasm-cid` は付与しない。
- 静的バンドル（`public/`）自体は content-addressable で、apex の `/ipfs/<cid>` gateway
  からの browser-local 配信は将来可能（ADR-2606014500 の精神）。現状は未配信。

## 依存（no-Adobe / no-AGPL）

| role | lib | license |
|---|---|---|
| edit+save | pdf-lib | MIT |
| cjk-font-embed | @pdf-lib/fontkit (+pako) | MIT |
| render | pdfjs-dist | Apache-2.0 |
| ocr | tesseract.js | Apache-2.0 |
| jp-font | Sawarabi Gothic | OFL-1.1 |

MuPDF / Ghostscript (AGPL) と Adobe SDK/service は**不採用**（permissive 既定を維持）。

## Do Not

- Adobe / AGPL 依存を導入しない（Charter Rider の Apache-2.0 既定を弱めない）。
- サーバー署名鍵・サーバー保管を導入しない（no-server-key、そもそもサーバーなし）。
- 第三者広告・トラッキング・addictive design を入れない（§1.13 Wellbecoming）。
- `EtzhayyimWasmComponent` / `:actor/wasm-cid` を tsuzuri に付けない（DOM アプリで嘘になる）。

## Build / Run

```bash
npm run dev      # http://localhost:8099 (CDN importmap, 即起動)
npm run vendor   # public/vendor/ に全依存を同梱（≈50MB, gitignored）→ オフライン化
npm run check    # node --check public/tsuzuri.js
```
