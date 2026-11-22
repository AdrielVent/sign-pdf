# Third-party notices

Sign PDF is MIT-licensed. The built site bundles the following third-party
software and fonts. Full license texts are shipped with the site in
`licenses/` and are in each package under `node_modules/`.

| Component | Version | License | Used for |
|---|---|---|---|
| [PDF.js](https://github.com/mozilla/pdf.js) (`pdfjs-dist`) | 6.5.438 | Apache-2.0 | Rendering pages in the browser |
| PDF.js data files: CMaps, standard fonts, wasm decoders (OpenJPEG, JBIG2, QCMS), ICC profile | bundled with `pdfjs-dist` | See `pdfjs/LICENSE` and the `LICENSE_*` files in `pdfjs/wasm/` and `pdfjs/iccs/` in the built site | Rendering PDFs that rely on them |
| [pdf-lib](https://github.com/Hopding/pdf-lib) | 1.17.1 | MIT | Writing the signed PDF |
| `@pdf-lib/standard-fonts`, `@pdf-lib/upng` | (pdf-lib deps) | MIT | pdf-lib internals |
| [pako](https://github.com/nodeca/pako) | (pdf-lib dep) | MIT AND Zlib | Compression |
| [tslib](https://github.com/microsoft/tslib) | (pdf-lib dep) | 0BSD | Runtime helpers |
| Dancing Script font (`@fontsource/dancing-script`) | 5.3.0 | SIL OFL 1.1 | Typed signatures |
| Great Vibes font (`@fontsource/great-vibes`) | 5.3.0 | SIL OFL 1.1 | Typed signatures |
| Caveat font (`@fontsource/caveat`) | 5.3.0 | SIL OFL 1.1 | Typed signatures |

PDF.js is distributed under the Apache License, Version 2.0. A copy of the
license is included in the built site at `pdfjs/LICENSE` and
`licenses/pdfjs-dist.txt`. No modifications were made to PDF.js.

The fonts are distributed under the SIL Open Font License 1.1. They are bundled
unmodified (Latin subset files as published by Fontsource) and are not sold
separately.
