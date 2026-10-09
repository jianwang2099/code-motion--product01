#!/usr/bin/env node
/**
 * verify/visual/fixtures.js · 视觉门禁的**自造样本**生成器（纯计算，无随机、无外部文件）
 * ---------------------------------------------------------------------------
 * 为什么单独一个文件：门禁脚本（visual-gate.js）应当只有"断言"，样本怎么造是另一回事。
 * 这里生成的 PNG 都是**算出来的**：
 *   sample(w,h)    有结构的底图（横向渐变 + 竖向色带 + 一块实心方块）—— 改哪一点都看得见
 *   poke(...)      在指定像素上抬某个通道的值（抬多少 = 超容差多少，是可控量）
 *   palettePng     8bit/调色板（ct=3）—— Pillow 存图常见形态，解码器必须能读
 *   grayPng        8bit/灰度（ct=0）  —— 同上
 *   rgbaPng        8bit/真彩+α（ct=6）—— 无头浏览器换参数时可能出这个形态
 * 生成结果重复运行**字节一致**（无随机源），因此"同图 → 差异计数 0"这类断言是确定的。
 */
'use strict';
const zlib = require('zlib');
const png = require('./png.js');

/** 有结构的底图 */
function sample(w, h) {
  const rgb = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 3;
      rgb[o] = (x * 3) & 0xff;
      rgb[o + 1] = (y * 5) & 0xff;
      rgb[o + 2] = ((x + y) * 2) & 0xff;
      if (x > w * 0.25 && x < w * 0.55 && y > h * 0.25 && y < h * 0.55) { rgb[o] = 240; rgb[o + 1] = 160; rgb[o + 2] = 60; }
    }
  }
  return { width: w, height: h, rgb };
}
const clone = img => ({ width: img.width, height: img.height, rgb: Buffer.from(img.rgb) });
/** 在指定像素上改某个通道的值（delta 就是"超容差多少"的直接控制量） */
function poke(img, pixels, delta, channel = 0) {
  for (const [x, y] of pixels) {
    const o = (y * img.width + x) * 3 + channel;
    img.rgb[o] = Math.max(0, Math.min(255, img.rgb[o] + delta));
  }
  return img;
}
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  }
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0); head.write(type, 4, 'ascii');
  const typed = Buffer.concat([head.subarray(4), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE((typeof zlib.crc32 === 'function' ? zlib.crc32(typed) : crc32(typed)) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}
const ihdrOf = (w, h, colorType) => {
  const b = Buffer.alloc(13);
  b.writeUInt32BE(w, 0); b.writeUInt32BE(h, 4); b[8] = 8; b[9] = colorType;
  return b;
};
const toPng = (w, h, colorType, raw, extra = []) => Buffer.concat(
  [png.PNG_SIG, chunk('IHDR', ihdrOf(w, h, colorType)), ...extra, chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);

/** 8bit 调色板 PNG → { png, expect }（expect 是"正确解码后应有的 RGB"） */
function palettePng(w, h) {
  const palette = Buffer.alloc(16 * 3);
  for (let i = 0; i < 16; i++) { palette[i * 3] = i * 16; palette[i * 3 + 1] = 255 - i * 16; palette[i * 3 + 2] = (i * 37) & 0xff; }
  const raw = Buffer.alloc(h * (w + 1));
  const idx = Buffer.alloc(w * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w + 1)] = 0;
    for (let x = 0; x < w; x++) { const i = x + y * w; idx[i] = (x * 3 + y * 5) & 0x0f; raw[y * (w + 1) + 1 + x] = idx[i]; }
  }
  const rgb = Buffer.alloc(w * h * 3);
  for (let i = 0; i < w * h; i++) { rgb[i * 3] = palette[idx[i] * 3]; rgb[i * 3 + 1] = palette[idx[i] * 3 + 1]; rgb[i * 3 + 2] = palette[idx[i] * 3 + 2]; }
  return { png: toPng(w, h, 3, raw, [chunk('PLTE', palette)]), expect: { width: w, height: h, rgb } };
}
/** 8bit 灰度 PNG */
function grayPng(w, h) {
  const raw = Buffer.alloc(h * (w + 1)); const val = Buffer.alloc(w * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w + 1)] = 0;
    for (let x = 0; x < w; x++) { const v = (x * 7 + y * 3) & 0xff; val[y * w + x] = v; raw[y * (w + 1) + 1 + x] = v; }
  }
  const rgb = Buffer.alloc(w * h * 3);
  for (let i = 0; i < w * h; i++) { rgb[i * 3] = val[i]; rgb[i * 3 + 1] = val[i]; rgb[i * 3 + 2] = val[i]; }
  return { png: toPng(w, h, 0, raw), expect: { width: w, height: h, rgb } };
}
/** 8bit 真彩 + α PNG（解码器应丢 α 保 RGB） */
function rgbaPng(w, h) {
  const raw = Buffer.alloc(h * (w * 4 + 1)); const px = [];
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const o = y * (w * 4 + 1) + 1 + x * 4;
      const r = (x * 11) & 0xff, g = (y * 13) & 0xff, b = (x * y) & 0xff;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = 200 + ((x + y) & 0x37);
      px.push([r, g, b]);
    }
  }
  const rgb = Buffer.alloc(w * h * 3);
  px.forEach((p, i) => { rgb[i * 3] = p[0]; rgb[i * 3 + 1] = p[1]; rgb[i * 3 + 2] = p[2]; });
  return { png: toPng(w, h, 6, raw), expect: { width: w, height: h, rgb } };
}

module.exports = { sample, clone, poke, palettePng, grayPng, rgbaPng, chunk, crc32 };
