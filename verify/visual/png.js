#!/usr/bin/env node
/**
 * verify/visual/png.js · 纯 JavaScript PNG 编解码（**零依赖**）
 * ---------------------------------------------------------------------------
 * 为什么自己写：本项目的硬约束是「零依赖 / 离线可用」。像素比对必须能在任何一台
 * 装了 Node 的机器上跑起来，不能要求 `pip install Pillow` 或 `npm i pngjs`。
 * 只用 Node 自带的 `node:zlib`（inflate/deflate）实现 PNG 的容器解析 + 行滤波还原。
 *
 * 支持范围（足够覆盖本项目的全部分工）：
 *   解码：位深 8、颜色类型 0/2/3/4/6（灰/真彩/调色板/灰+α/真彩+α）、非隔行、
 *        全部 5 种行滤波（None/Sub/Up/Average/Paeth）。tRNS 视作不透明（本项目不依赖透明度）。
 *         —— 实测来源：无头 Edge 的 `Page.captureScreenshot` 出的是 **8bit/RGB(ct=2)/非隔行**，
 *            而 Pillow 存 8bit/调色板(ct=3) 或 RGBA(ct=6)；这三类都必须能读。
 *   编码：8bit / 颜色类型 2（RGB）/ 非隔行，行滤波固定 None（确定性 → 同样的像素永远同样的字节）。
 *
 * 输出约定：解码统一返回 **RGB**（每像素 3 通道，无 alpha），比较器因此不必分支。
 *
 * 自证：`node verify/visual/visual-gate.js` 第 1 条断言就是"编码→解码往返逐字节相等"，
 *       另有 Pillow 独立解码交叉核对（见 visual-gate.js 的「双引擎」一节）。
 */
'use strict';
const zlib = require('zlib');

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/** 逐行反滤波。raw = 带滤波字节的原始扫描线；bpp = 单像素字节数（位深 8 时 = 通道数） */
function unfilter(raw, width, height, bpp) {
  const stride = width * bpp;
  if (raw.length !== height * (stride + 1)) {
    throw new Error(`PNG 数据长度不符：期望 ${height * (stride + 1)}，实际 ${raw.length}`);
  }
  const out = Buffer.alloc(height * stride);
  let prev = Buffer.alloc(stride);          // 上一行（已还原）；第一行视为全 0
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const dst = out.subarray(y * stride, (y + 1) * stride);
    switch (ft) {
      case 0: src.copy(dst); break;
      case 1:
        for (let i = 0; i < stride; i++) dst[i] = (src[i] + (i >= bpp ? dst[i - bpp] : 0)) & 0xff;
        break;
      case 2:
        for (let i = 0; i < stride; i++) dst[i] = (src[i] + prev[i]) & 0xff;
        break;
      case 3:
        for (let i = 0; i < stride; i++) {
          const a = i >= bpp ? dst[i - bpp] : 0, b = prev[i];
          dst[i] = (src[i] + ((a + b) >> 1)) & 0xff;
        }
        break;
      case 4:
        for (let i = 0; i < stride; i++) {
          const a = i >= bpp ? dst[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
          const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          const pred = (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
          dst[i] = (src[i] + pred) & 0xff;
        }
        break;
      default:
        throw new Error(`未知 PNG 行滤波类型：${ft}（第 ${y} 行）`);
    }
    prev = dst;
  }
  return out;
}

/** 调色板 / 灰度 / 带 α 的位图 → 统一 RGB */
function toRgb(rows, width, height, colorType, channels, palette, trns) {
  if (colorType === 2) return Buffer.from(rows);       // 已是 RGB
  const out = Buffer.alloc(width * height * 3);
  let o = 0;
  for (let i = 0; i < width * height; i++) {
    const p = i * channels;
    if (colorType === 3) {
      const idx = rows[p];
      out[o++] = palette[idx * 3]; out[o++] = palette[idx * 3 + 1]; out[o++] = palette[idx * 3 + 2];
    } else if (colorType === 0) {
      out[o++] = rows[p]; out[o++] = rows[p]; out[o++] = rows[p];
    } else if (colorType === 4) {
      out[o++] = rows[p]; out[o++] = rows[p]; out[o++] = rows[p];
    } else {                                            // colorType 6：丢 α（合成到背景由调用方自理）
      out[o++] = rows[p]; out[o++] = rows[p + 1]; out[o++] = rows[p + 2];
    }
  }
  return out;
}

/**
 * 解码 PNG → { width, height, rgb: Buffer(width*height*3), colorType, bitDepth, filtered }
 * `filtered` = 各类滤波在文件里的行数（自证"真的还原了滤波"，不是恰好都是 None）
 */
function decode(buf, opts = {}) {
  const strict = opts.strict !== false;
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) throw new Error('不是 PNG 文件（签名不符）');
  let off = 8, ihdr = null, palette = null, trns = null;
  const idat = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      ihdr = {
        width: data.readUInt32BE(0), height: data.readUInt32BE(4),
        bitDepth: data[8], colorType: data[9], compression: data[10], filter: data[11], interlace: data[12]
      };
    } else if (type === 'PLTE') palette = Buffer.from(data);
    else if (type === 'tRNS') trns = Buffer.from(data);
    else if (type === 'IDAT') idat.push(Buffer.from(data));
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (!ihdr) throw new Error('PNG 缺少 IHDR');
  const { width, height, bitDepth, colorType, interlace, filter } = ihdr;
  if (interlace !== 0) throw new Error('暂不支持隔行（Adam7）PNG');
  if (bitDepth !== 8) throw new Error(`暂不支持位深 ${bitDepth}（只支持 8）`);
  if (!CHANNELS[colorType]) throw new Error(`未知颜色类型 ${colorType}`);
  if (filter !== 0) throw new Error(`IHDR.filter 必须为 0，实际 ${filter}`);
  if (colorType === 3 && !palette) throw new Error('调色板 PNG 缺少 PLTE');
  if (!idat.length) throw new Error('PNG 缺少 IDAT');

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const channels = CHANNELS[colorType];
  const stride = width * channels;
  const counts = {};
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)];
    counts[ft] = (counts[ft] || 0) + 1;
  }
  const rows = unfilter(raw, width, height, channels);
  const rgb = toRgb(rows, width, height, colorType, channels, palette, trns);
  if (strict && rgb.length !== width * height * 3) throw new Error('解码结果长度异常');
  return { width, height, rgb, colorType, bitDepth, filtered: counts };
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const typed = Buffer.concat([head.subarray(4), data]);
  const sum = (typeof zlib.crc32 === 'function') ? (zlib.crc32(typed) >>> 0) : crc32(typed);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(sum, 0);
  return Buffer.concat([head, data, crc]);
}
/* Node 22 的 zlib.crc32 存在；为兼容更老的 Node 自备一份同结果实现 */
let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      CRC_TABLE[n] = c;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** 编码：接受 { width, height, rgb }（rgb 长度必须 = w*h*3），输出 8bit/RGB 非隔行 PNG */
function encode({ width, height, rgb }) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) throw new Error('宽高必须是正整数');
  if (rgb.length !== width * height * 3) throw new Error(`RGB 长度不符：期望 ${width * height * 3}，实际 ${rgb.length}`);
  const stride = width * 3;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;                                  // 滤波固定 None → 字节级确定
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    PNG_SIG,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

module.exports = { decode, encode, PNG_SIG };
