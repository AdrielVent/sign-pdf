// Copies the PDF.js worker and the data files it loads on demand (CMaps,
// standard fonts, wasm decoders, ICC profile) into public/pdfjs so they are
// served from the site itself. Nothing is fetched from a CDN at runtime.
import { cpSync, mkdirSync, rmSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'node_modules', 'pdfjs-dist');
const dest = join(root, 'public', 'pdfjs');

rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
// .js extension: every static host (including GitHub Pages) serves it as JavaScript.
copyFileSync(join(src, 'legacy', 'build', 'pdf.worker.min.mjs'), join(dest, 'pdf.worker.min.js'));
copyFileSync(join(src, 'LICENSE'), join(dest, 'LICENSE'));
for (const dir of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
  cpSync(join(src, dir), join(dest, dir), { recursive: true });
}
console.log('Copied PDF.js assets to public/pdfjs');

// Ship third-party licenses with the built site (OFL fonts, Apache/MIT libraries).
const licenses = join(root, 'public', 'licenses');
rmSync(licenses, { recursive: true, force: true });
mkdirSync(licenses, { recursive: true });
const shipped = {
  'pdfjs-dist': 'LICENSE',
  'pdf-lib': 'LICENSE.md',
  '@pdf-lib/standard-fonts': 'LICENSE.md',
  '@pdf-lib/upng': 'LICENSE',
  pako: 'LICENSE',
  tslib: 'LICENSE.txt',
  '@fontsource/dancing-script': 'LICENSE',
  '@fontsource/great-vibes': 'LICENSE',
  '@fontsource/caveat': 'LICENSE',
};
for (const [pkg, file] of Object.entries(shipped)) {
  copyFileSync(join(root, 'node_modules', pkg, file), join(licenses, `${pkg.replace('/', '__').replace('@', '')}.txt`));
}
copyFileSync(join(root, 'THIRD_PARTY_NOTICES.md'), join(licenses, 'THIRD_PARTY_NOTICES.txt'));
copyFileSync(join(root, 'LICENSE'), join(licenses, 'vnua-signature-LICENSE.txt'));
console.log('Copied licenses to public/licenses');
