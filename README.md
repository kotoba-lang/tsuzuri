# 綴 tsuzuri — Adobe非依存・端末内完結 PDF editor

**Adobe に一切依存しない、ブラウザ内（WASM/JS）で完結する PDF エディタ。**
ファイルはこの端末から外に出ません（サーバー送信・アップロードなし）。

> 問い *「adobe に依存しない pdf editor は wasm で設計されている?」* への実装回答。
> 結論: **WASM は固定要件ではない**が、フル機能（特に OCR・レンダリング）では WASM が定石。
> 本アプリは「純JS編集 + WASMレンダ + WASM OCR」のハイブリッドで、Adobe非依存を最小コストで達成する。

## なぜ Adobe 不要か

PDF は ISO 32000 のオープン規格。Adobe の SDK/ライブラリなしで読み書きできる。
本アプリは以下の Apache-2.0 / MIT のみで構成（**AGPL の MuPDF/Ghostscript は意図的に不採用** → Charter Rider の permissive 既定を崩さない）。

| 役割 | ライブラリ | ライセンス | WASM |
|---|---|---|---|
| 構造編集・保存（結合/分割/回転/削除/並替/テキスト/メタ） | **pdf-lib** | MIT | 不要（純TS/JS） |
| ページ描画（→ canvas） | **pdf.js** (Mozilla) | Apache-2.0 | 一部 |
| OCR（スキャンPDF→テキスト） | **tesseract.js** | Apache-2.0 | ✅ WASM |

→ 「Adobe非依存 ⇒ WASM」ではなく、**OCR/高精度レンダの所だけ WASM**が合理的、という設計判断を体現。

## 動かす（MVP）

```bash
cd 60-apps/tsuzuri
npm run dev          # = python3 -m http.server 8099 --directory public
# → http://localhost:8099 を開く
```

PDF をドラッグ&ドロップ、または「開く」。すべてブラウザ内で処理される。

## MVP でできること

- 開く（D&D / ファイル選択）・**保存DL**
- ページ: **回転 / 削除 / 並べ替え（前後）**
- **結合**（別PDFを末尾に追加）
- **抽出/分割**（`1-3,5` 形式で範囲指定 → 別PDFでDL）
- **テキスト追記**（配置モード→ページ上クリックで配置, 日本語OK = JPフォント自動 subset 埋め込み）
- **OCR**（選択ページ, `eng+jpn` 等, 認識テキスト表示 + .txt DL）
- **メタデータ編集**（タイトル/著者）

## アーキテクチャ

```
ブラウザ（1端末で完結 — no upload）
┌───────────────────────────────────────────────┐
│ index.html  UI（3ペイン: サムネ / 表示 / 操作）  │
│ tsuzuri.js  state.bytes = 現在のPDF（唯一の真実）│
│   ├─ pdf.js   : bytes → canvas 描画             │
│   ├─ pdf-lib  : bytes 編集 → 新 bytes に置換     │
│   └─ tesseract: 選択ページ canvas → OCRテキスト  │
└───────────────────────────────────────────────┘
```

編集は「`state.bytes` を pdf-lib で読み込み→変更→`save()`で新 bytes に差し替え→pdf.js で再描画」という単純で常に WYSIWYG な往復モデル。MVP では各編集ごとに再保存するが、状態が常に一貫する。

## Charter / Substrate 適合

- **端末内完結**: PDF bytes はネットワークに出ない（プライバシー既定）。`§1.13 Wellbecoming` の addictive-design なし。
- **ライセンス**: Apache-2.0 + Charter Rider。バンドルは MIT/Apache/OFL のみ（NOTICE 参照）。Adobe・AGPL 排除。
- **no-server-key**: サーバー署名鍵・秘密を一切持たない（そもそもサーバーなし）。

## did:web actor 統合（ameno browser-local）

- **Canonical DID**: `did:web:etzhayyim.com:actor:tsuzuri`
  - SSoT: `00-contracts/schemas/actor-profile-seed.kotoba.edn`（kind `:infra` / tier `app`）
  - フォールバック: `50-infra/etzhayyim-did-web/src/registry/infra-actors.ts`
  - manifest: `kotodama.jsonld`（`uiType: ameno` / `runtimeType: browser-local`）
- **正直なスコープ**: tsuzuri は DOM アプリで**単一 WASM コンポーネントではない**ため、ameno の
  `wasm-actor-loader`（`EtzhayyimWasmComponent` + CID 検証ロード）の対象ではない。service type は
  `EtzhayyimBrowserLocalApp`。実行モデル（端末内 WASM/JS）が ameno の browser-local に一致する、
  という意味での統合。詳細は [`CLAUDE.md`](./CLAUDE.md)。

## 依存解決の仕組み（importmap 1点切替）

`index.html` の `<script type="importmap">` が唯一の CDN/vendor 切替点。`tsuzuri.js` は
bare specifier（`pdf-lib` / `@pdf-lib/fontkit` / `pdfjs-dist` / `tesseract.js`）でのみ import する。

- **既定 (CDN)**: importmap → `esm.sh`。即起動。コードは CDN 取得だが **PDF は端末外に出ない**。
- **vendor (オフライン)**: 下記スクリプトで全依存をローカル同梱し、importmap を差し替え。

## Hardening（完全オフライン化）

```bash
npm run vendor   # = node scripts/fetch-vendor.mjs  (≈50MB を public/vendor/ に取得)
```

取得物: pdf-lib / fontkit(+pako) / pdf.js(+worker) / tesseract.js(+worker+wasm core+eng/jpn lang) / JP font。
`public/vendor/` は `.gitignore` 済（巨大バイナリは commit せず再現）。

その後 **2 ステップで egress ゼロ**:

1. `public/index.html` の importmap ブロックを `public/vendor/importmap.vendored.json` の内容に差し替え。
2. 同 `index.html` の **CSP `<meta>` をコメント解除**（`connect-src 'self'`）。
   → OCR の worker/wasm-core/言語データ・JPフォントも全てローカル参照になり、ネットワーク送信が技術的に不可能になる。

> 注: npm の `fontkit.es.js` は唯一 `pako` を外部 import するため、pako も自己完結 ESM として
> 同梱し importmap で解決している（検証済）。tesseract の worker/core/lang パスは
> `vendor/manifest.json` から `tsuzuri.js` が自動で読み、CDN を一切叩かない。

## 残課題（さらに先）

3. **kotoba-EAVT 監査ログ（任意）**: 編集操作を `as-of` 履歴として記録（非終末論, 最終状態datomなし）。本人同意 + 暗号化エンベロープ。
4. **OCR 透明テキストレイヤー埋め込み**（検索可能PDF化）。

## Roadmap（フル機能へ）

| 項目 | 状態 |
|---|---|
| ページ回転/削除/並替/結合/分割/メタ | ✅ MVP |
| テキスト追記 | ✅ MVP |
| **日本語テキスト追記**（fontkit + JP TTF subset 埋め込み, Type0/CIDFontType2 検証済） | ✅ |
| OCR（表示 + txt DL） | ✅ MVP |
| **vendor化**（importmap切替 + fetch-vendor + CSP lockdown） | ✅ |
| **did:web actor 登録**（seed + INFRA_ACTORS + kotodama.jsonld） | ✅ |
| **OCR 透明テキストレイヤー埋め込み**（検索可能PDF化） | ⏳ |
| 注釈（ハイライト/図形/手書き）・墨消し redaction | ⏳ |
| フォーム（AcroForm）入出力 | ⏳ |
| 電子署名（PAdES, WebCrypto + did:key） | ⏳ |
| 回転ページへのテキスト配置の座標補正 | ⏳ |

## 既知の制限（MVP, 正直に）

- テキスト追記: ASCII→Helvetica / 日本語→JPフォント subset 自動埋め込み（混在行はJPフォント描画）。
- テキスト配置の座標は**未回転ページ前提**（回転ページはずれる）。
- OCR は初回に言語データを CDN から取得（`npm run vendor` で完全オフライン化）。
- 各編集ごとに全体を再保存するため、巨大PDFでは遅い（差分編集モデルは将来）。
