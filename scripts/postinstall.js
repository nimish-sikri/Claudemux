// Bundle xterm and addons into public/vendor/
const fs = require('fs');
const path = require('path');

const vendorDir = path.join(__dirname, '..', 'public', 'vendor');
fs.mkdirSync(vendorDir, { recursive: true });

const copies = [
  ['@xterm/xterm/lib/xterm.js',                       'xterm.js'],
  ['@xterm/xterm/css/xterm.css',                      'xterm.css'],
  ['@xterm/addon-fit/lib/addon-fit.js',               'addon-fit.js'],
  ['@xterm/addon-web-links/lib/addon-web-links.js',   'addon-web-links.js'],
  ['@xterm/addon-search/lib/addon-search.js',         'addon-search.js'],
];

let ok = 0;
for (const [src, dest] of copies) {
  try {
    const srcPath = path.join(__dirname, '..', 'node_modules', src);
    fs.copyFileSync(srcPath, path.join(vendorDir, dest));
    console.log('  bundled', dest);
    ok++;
  } catch (e) {
    console.warn('  skipped', dest, '—', e.message);
  }
}
console.log(`postinstall: ${ok}/${copies.length} vendor files ready`);
