// Generates a simple PNG (and ICO) for the app icon using only Node + Electron's
// bundled libpng-style approach. Uses pure-Node `pngjs` (small dep).
// Run with: node scripts/make-icon.js

const fs   = require('fs');
const path = require('path');

// Lazy-load deps installed via `npm install --no-save pngjs to-ico`
let PNG, toIco;
try { PNG   = require('pngjs').PNG; } catch (e) { console.error('Missing pngjs — install with: npm install --no-save pngjs to-ico'); process.exit(1); }
try { toIco = require('to-ico');      } catch (e) { console.error('Missing to-ico — install with: npm install --no-save pngjs to-ico'); process.exit(1); }

const SIZES = [16, 24, 32, 48, 64, 128, 256];

function hex(c) {
  return [
    parseInt(c.slice(1,3), 16),
    parseInt(c.slice(3,5), 16),
    parseInt(c.slice(5,7), 16),
    255,
  ];
}

// 8x8 bitmap font for "cm" — each row is a byte (1 bit per pixel, left to right)
const GLYPHS = {
  c: [
    0b00111100,
    0b01100110,
    0b11000010,
    0b11000000,
    0b11000000,
    0b11000010,
    0b01100110,
    0b00111100,
  ],
  m: [
    0b11000110,
    0b11101110,
    0b11111110,
    0b11010110,
    0b11000110,
    0b11000110,
    0b11000110,
    0b11000110,
  ],
};

function drawText(buf, w, h, text, fg, scale, ox, oy) {
  for (let i = 0; i < text.length; i++) {
    const g = GLYPHS[text[i]];
    if (!g) continue;
    for (let gy = 0; gy < 8; gy++) {
      for (let gx = 0; gx < 8; gx++) {
        if (!(g[gy] & (1 << (7 - gx)))) continue;
        // draw a scale x scale block
        for (let sy = 0; sy < scale; sy++) {
          for (let sx = 0; sx < scale; sx++) {
            const px = ox + i * 9 * scale + gx * scale + sx;
            const py = oy + gy * scale + sy;
            if (px < 0 || py < 0 || px >= w || py >= h) continue;
            const idx = (py * w + px) * 4;
            buf[idx]   = fg[0];
            buf[idx+1] = fg[1];
            buf[idx+2] = fg[2];
            buf[idx+3] = fg[3];
          }
        }
      }
    }
  }
}

function makePng(size) {
  const png = new PNG({ width: size, height: size, colorType: 6 /* RGBA */ });
  const bg = hex('#0e0e10');   // matches app dark bg
  const fg = hex('#f0f0f2');   // near-white accent
  // Fill bg
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      png.data[i]   = bg[0];
      png.data[i+1] = bg[1];
      png.data[i+2] = bg[2];
      png.data[i+3] = 255;
    }
  }
  // Rounded square cutout via simple corner masking
  const r = Math.round(size * 0.16);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let dx = 0, dy = 0;
      if      (x < r)         dx = r - x;
      else if (x >= size - r) dx = x - (size - r - 1);
      if      (y < r)         dy = r - y;
      else if (y >= size - r) dy = y - (size - r - 1);
      const d = Math.sqrt(dx*dx + dy*dy);
      if (d > r) {
        const i = (y * size + x) * 4;
        png.data[i+3] = 0;   // make transparent at corners
      }
    }
  }
  // Draw "cm" centered
  // each glyph is 8 px wide, gap of 1 px between = 17 px total at scale 1
  // pick scale so total width ≈ 60% of size
  const scale = Math.max(1, Math.floor((size * 0.55) / 17));
  const textW = 17 * scale;
  const textH = 8 * scale;
  const ox = Math.round((size - textW) / 2);
  const oy = Math.round((size - textH) / 2);
  drawText(png.data, size, size, 'cm', fg, scale, ox, oy);
  return PNG.sync.write(png);
}

const outDir = path.join(__dirname, '..', 'build');
fs.mkdirSync(outDir, { recursive: true });

const pngs = SIZES.map(s => makePng(s));

// Largest as standalone icon.png (used on Linux + as macOS fallback)
fs.writeFileSync(path.join(outDir, 'icon.png'), pngs[pngs.length - 1]);
console.log('  wrote build/icon.png');

// Bundle all sizes into icon.ico
toIco(pngs.filter((_, i) => SIZES[i] <= 256)).then(buf => {
  fs.writeFileSync(path.join(outDir, 'icon.ico'), buf);
  console.log('  wrote build/icon.ico');
}).catch(err => {
  console.error('to-ico failed:', err);
  process.exit(1);
});
