// Generates the Qofeno icon set as real PNGs: dark rounded square + white diamond.
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let c = 0xffffffff;
  for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, pixelFn) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0; // filter none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixelFn(x, y, size);
      const o = rowStart + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function qofenoPixel(x, y, size) {
  const s = size;
  const margin = s * 0.08, radius = s * 0.18;
  // rounded-square background #10161d
  const inX = x >= margin && x <= s - margin, inY = y >= margin && y <= s - margin;
  const cx = Math.min(Math.max(x, margin + radius), s - margin - radius);
  const cy = Math.min(Math.max(y, margin + radius), s - margin - radius);
  const dist = Math.hypot(x - cx, y - cy);
  if (!(inX && inY) || dist > radius) return [0, 0, 0, 0];
  // diamond glyph centered
  const dx = Math.abs(x - s / 2), dy = Math.abs(y - s / 2);
  const half = s * 0.26, thick = s * 0.055;
  const d = dx + dy;
  if (d > half - thick && d < half + thick) return [78, 161, 255, 255]; // accent ring
  if (Math.abs(d - half) <= thick / 2) return [231, 236, 239, 255];   // crisp edge
  return [16, 22, 29, 255];
}

mkdirSync("apps/desktop/src-tauri/icons", { recursive: true });
for (const size of [32, 128, 256]) writeFileSync(`apps/desktop/src-tauri/icons/${size}x${size}.png`, png(size, qofenoPixel));
// Tauri expects these exact names:
writeFileSync("apps/desktop/src-tauri/icons/icon.png", png(512, qofenoPixel));
writeFileSync("apps/desktop/src-tauri/icons/128x128@2x.png", png(256, qofenoPixel));
console.log("icons generated");
