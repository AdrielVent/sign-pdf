# vnua-signature

Fill in and sign a PDF in your browser. No account, no upload, no paywall, no watermark.

**Open PDF → click a field (or Add Text) and type → add your signature → Download signed PDF**

Live: <https://adrielvent.github.io/sign-pdf/>

A static site hosted on GitHub Pages. Everything runs in the browser tab: the
PDF, what you type into it and your signature are never sent anywhere.

## Features

**Fillable PDFs** (forms with built-in AcroForm fields, e.g. the IRS W-9)
- Click or tap a field right in the page preview and type. Checkboxes tick on click/tap or Space. Radio buttons and dropdowns are supported too, but no test document exercises them yet.
- **Tab** / **Shift+Tab** move between fields in the document's own order, across pages.
- Max lengths and "comb" fields (one character per box, like SSN/EIN) behave as in Acrobat.
- Fields get readable names for screen readers from the captions printed next to them ("1 Name of entity/individual", "Social security number (part 2 of 3)").
- Values are written into the PDF's own fields, with appearance streams, so every viewer shows them and the recipient can still read them as form data.

**Flat PDFs** (no fields: scans, "print to PDF")
- **Add Text**: click or tap a blank line and start typing. The text sits on the line you clicked.
- Click a text box to edit it; drag to move; the corner handle or **+**/**−** resize; arrow keys nudge by 1 pt (Shift: 10 pt); **Delete** removes. Enter or Escape finishes typing.
- **Checkmark**: click where a ✓ belongs.
- **Undo** (button, or Ctrl+Z / ⌘Z) takes back any change: typing in a field, adding, moving, resizing or deleting.

This follows Apple Preview's rule: if the PDF has a field, you type into the field; if it doesn't, you add a text box.

**Signing** (unchanged)
- Draw (mouse, finger, stylus), type (three bundled script fonts) or upload (PNG/JPEG, optional background removal) a signature; place it on any page; move, resize, duplicate, delete.

**One completed PDF**
- **Download signed PDF** saves `<original-name>-signed.pdf` containing field values, typed text, checkmarks and signatures. The original file is never changed.
- Everything is stored in page-relative coordinates, so zooming, resizing the window or reopening the export never shifts anything.
- Typed text stays real, searchable text (Helvetica). Signatures are transparent high-resolution images.
- You can also just sign, without filling anything in.
- Clear errors for non-PDFs, damaged and password-protected files; a warning if the PDF already carries a certificate signature. Opening another PDF or **Start over** never silently discards work you haven't downloaded.

## Privacy

- **No backend.** Static files only; there is no server code to receive anything.
- **No third-party requests.** PDF.js, its worker and data files, and the fonts are bundled and served from the site itself. No CDNs, analytics or trackers.
- **Content-Security-Policy** `default-src 'self'; connect-src 'self'` in the production build: the page can't send data to another origin even by accident.
- **Nothing persisted or logged.** The document, field values, typed text and signatures live only in memory. No localStorage, sessionStorage, IndexedDB, cookies, Cache Storage or service worker. The app doesn't log what you type.
- **Tested.** The end-to-end suite goes offline after loading, fills a W-9 with dummy data, adds text and a signature, exports, and asserts that no request left the site or carried a body or any typed value, nothing was stored, and nothing typed appeared in the console.

GitHub Pages sees normal page-load requests, like any website, but never your files.

## What this is not

It places a **visible** signature image, like signing a printout. It does **not** create a certificate-based digital signature (PAdES/PKCS#7), verify identity or keep an audit trail. Whether that's acceptable is up to the recipient. Not legal advice.

## Local development

Requires Node.js 20.19+.

```bash
npm ci                 # install exact, locked dependencies
npm run dev            # dev server at http://localhost:5173/
npm run build          # type-check + production build into dist/
npm run preview        # serve dist/ at http://localhost:4317/sign-pdf/ (GitHub Pages-style subpath)
```

## Tests

```bash
npx playwright install chromium webkit   # once
npm test               # unit tests, then build, then end-to-end tests
npm run test:unit      # Vitest only
npm run test:e2e       # builds, then runs Playwright against dist/ served under /sign-pdf/
SAVE_EXPORTS=/some/dir npm run test:e2e  # also keep every exported PDF, to open in Preview/Acrobat
```

Fixtures: `tests/fixtures/fw9.pdf` is the blank, public-domain IRS Form W-9 (23 fields, plus an XFA copy and Adobe usage rights). Everything else is generated in `tests/fixtures/fixtures.ts`, including a flattened W-9 and a two-page flat form (page 2 rotated 90°). All data typed in tests is dummy data.

**Unit tests (Vitest)**
- Display ↔ PDF coordinates for 0/90/180/270° pages, offset and negative crop boxes, `/UserUnit`, checked against PDF.js's own viewport transform; clamping and proportional resize.
- Export: signatures land exactly on every page of the rotated / mixed-size / tricky fixtures (from PDF.js's operator list, ±0.001 pt). Typed text's baseline, left edge and size land exactly where the editor showed them on every page type, upright.
- W-9: values, checkbox state and appearances read back by both pdf-lib and PDF.js; the stale XFA copy and Adobe usage rights are removed; signing without filling leaves all 23 fields empty; the original bytes are unchanged; no false "digitally signed" warning.
- Characters the standard font can't encode are refused with a clear message instead of producing a broken file.

**End-to-end tests (Playwright)**, against the production build under `/sign-pdf/`:
- **fw9.pdf**: click fields in the preview, Tab/Shift+Tab, tick a box, comb SSN fields with max lengths, sign on the signature line, zoom in/out/fit and resize the window (fields and signature keep their page-relative position), export; the export is re-read in an isolated browser: field values, ink visible inside the filled fields and ticked box only, signature on page 1 only.
- **fw9.pdf, sign only**: export has 23 empty fields and the signature.
- **Flat form**: Add Text on lines, edit, drag, resize, arrow-nudge, delete, undo (Ctrl/⌘+Z and button), checkmark, text on a rotated page, sign, zoom; the export's text is real, upright text at the right baseline on the right page; ✓ in box A, nothing in box B.
- Everything from before: draw/type/upload signatures, rotated/cropped/UserUnit pages, errors, lazy rendering, offline privacy, phone touch input (Pixel 7 emulation with real CDP touch events), and WebKit (desktop Safari and iPhone emulation) runs of both filling and signing.

## Deploying

`.github/workflows/pages.yml` runs all tests, builds, and deploys to GitHub Pages on every push to `main`.

The public URL comes from the repository name: the repo is `sign-pdf`, so the site is `https://adrielvent.github.io/sign-pdf/`. To serve it at `/vnua-signature/` instead, rename the repository on GitHub (Settings → General → Repository name). GitHub Pages does **not** redirect the old URL, so the old link stops working. Also change `sign-pdf` to the new name in `package.json` (`preview` script), `playwright.config.ts` and `scripts/serve-subpath.mjs`, so tests keep matching the live path. The build uses relative URLs and needs no other change.

## Known limitations

- **Characters:** typed text uses the standard PDF font (Helvetica, WinAnsi), which covers English and Western European letters. Other scripts (e.g. Ł, Cyrillic, CJK) and emoji are left out with an on-screen notice.
- **XFA-only (dynamic LiveCycle) forms** have no normal fields to fill; the app says so, and you can still add text and sign. Hybrid forms like the W-9 are filled through their regular fields.
- **Existing certificate signatures** become invalid (the file is rewritten; the app warns). Adobe "Reader extensions" usage rights are removed on purpose, since any edit breaks them.
- Multi-select list boxes, push buttons, JavaScript actions and calculated fields are not supported. Field values are exported as typed.
- Typed text is single-line per box. Signature and text are page content, not annotations.
- Encrypted/password-protected PDFs can't be saved; very large PDFs are limited by device memory.
- Automated tests run on Chromium and WebKit; Firefox and Adobe Acrobat have not been tested automatically (exports have been checked with Apple's PDFKit, the engine behind Preview).

## Project layout

```
index.html              markup (start screen, workspace, dialogs, FAQ)
src/geometry.ts         the one coordinate model shared by editor and exporter
src/pdf.ts              PDF.js setup, opening and validation
src/inspect.ts          pre-flight checks: digital signatures, XFA-only forms
src/forms.ts            AcroForm fields → inputs over the preview (labels, comb, Tab order)
src/placements.ts       signatures, free text and checkmarks on the page (drag/resize/keys)
src/text.ts             text metrics shared by screen and export; encodable characters
src/export.ts           writes the completed PDF with pdf-lib
src/viewer.ts           lazy page rendering, zoom, navigation
src/signature.ts        draw/type/import → trimmed high-res PNG
src/main.ts             app state, undo, tools, UI wiring
tests/unit, tests/e2e   Vitest and Playwright suites; tests/fixtures: fixtures
```

## License

MIT. See [LICENSE](LICENSE). Third-party components are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
