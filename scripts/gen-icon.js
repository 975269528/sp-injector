// scripts/gen-icon.js · 生成 electron/icon.png(256x256)
// 蓝底(#2563EB)圆角方块 + 白色太极 · 逐像素 3x3 超采样抗锯齿 · 零依赖(仅 node:zlib)
// 用法:node scripts/gen-icon.js

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const SIZE = 256;
const CX = SIZE / 2;
const CY = SIZE / 2;
const HALF = 118; // 方块半宽
const CORNER = 56; // 圆角半径
const R = 64; // 太极半径
const RING = R + 7; // 太极外白环外沿
const BLUE = [37, 99, 235]; // #2563EB 底色
const DEEP = [30, 64, 175]; // #1E40AF 蓝鱼(比底深,避免与底融在一起)
const WHITE = [255, 255, 255];

// 圆角方块内判定
function inRoundRect(x, y) {
  const dx = Math.max(Math.abs(x - CX) - (HALF - CORNER), 0);
  const dy = Math.max(Math.abs(y - CY) - (HALF - CORNER), 0);
  return dx * dx + dy * dy <= CORNER * CORNER;
}

// 圆内取色:白环 / 太极白鱼 / 太极蓝鱼;圆外返回 null(用底色)
function pixel(x, y) {
  const dx = x - CX;
  const dy = y - CY;
  const d2 = dx * dx + dy * dy;
  if (d2 > RING * RING) return null;
  if (d2 > R * R) return WHITE; // 外圈白环
  const topC = [CX, CY - R / 2];
  const botC = [CX, CY + R / 2];
  const dist2 = (p) => {
    const ax = x - p[0];
    const ay = y - p[1];
    return ax * ax + ay * ay;
  };
  let white = dx >= 0; // 右半白鱼、左半蓝鱼
  if (dist2(topC) <= (R / 2) * (R / 2)) white = true; // 上小圆补白(S 曲线)
  if (dist2(botC) <= (R / 2) * (R / 2)) white = false; // 下小圆补蓝
  if (dist2(topC) <= (R / 6) * (R / 6)) white = false; // 白鱼眼(蓝点)
  if (dist2(botC) <= (R / 6) * (R / 6)) white = true; // 蓝鱼眼(白点)
  return white ? WHITE : DEEP;
}

// 3x3 超采样求平均 RGBA
function sample(x, y) {
  let a = 0;
  let rs = 0;
  let gs = 0;
  let bs = 0;
  const n = 3;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const sx = x + (i + 0.5) / n;
      const sy = y + (j + 0.5) / n;
      if (!inRoundRect(sx, sy)) continue;
      a++;
      const c = pixel(sx, sy) || BLUE;
      rs += c[0];
      gs += c[1];
      bs += c[2];
    }
  }
  if (a === 0) return [0, 0, 0, 0];
  return [
    Math.round(rs / a),
    Math.round(gs / a),
    Math.round(bs / a),
    Math.round((a / (n * n)) * 255),
  ];
}

// ── PNG 编码(RGBA · filter 0 · zlib) ──
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0; // filter: none
  for (let x = 0; x < SIZE; x++) {
    const [r, g, b, a] = sample(x, y);
    const off = y * (SIZE * 4 + 1) + 1 + x * 4;
    raw[off] = r;
    raw[off + 1] = g;
    raw[off + 2] = b;
    raw[off + 3] = a;
  }
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // color type: RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

const out = path.resolve(__dirname, "..", "electron", "icon.png");
fs.writeFileSync(out, png);
console.log("icon written: " + out + " (" + png.length + " bytes)");
