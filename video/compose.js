#!/usr/bin/env node
'use strict';
/**
 * FFmpeg 合成插件（**读本地序列帧文件夹 → 出标准固定帧率 MP4**）
 * ---------------------------------------------------------------------------
 * 这是流水线里负责"帧 → 视频"的那一步，零第三方 npm 依赖，
 * 只要求本机有 `ffmpeg`（含 libx264；实测 8.1.1 可用）。
 *
 * 用法：
 *   node video/compose.js                         # 默认读 video/frames，写 video/out/video.mp4
 *   node video/compose.js --frames <目录> --out <文件.mp4>
 *   node video/compose.js --fps 60 --crf 16 --preset slow
 *   node video/compose.js --dry-run               # 只打印将执行的 ffmpeg 命令，不执行
 *
 * 输入约定：序列帧按**时间轴有序命名** `frame_%05d.png`（frame_00000.png 起、从 0 连续编号）。
 * 输出约定：H.264 / yuv420p / +faststart（网页与剪辑软件都能直接播）。
 *
 * 路径基准：`--frames` / `--out` 一律按 `path.resolve(ROOT, v)` 解析
 * （ROOT = 脚本所在目录的上一级 = 项目根），**与 cwd 无关**；默认值也落在 ROOT 下。
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const a = {
    frames: path.join(ROOT, 'video', 'frames'),
    out: path.join(ROOT, 'video', 'out', 'video.mp4'),
    fps: 60, width: 1920, height: 1080,
    crf: 16, preset: 'slow', pattern: 'frame_%05d.png',
    ffmpeg: process.env.FFMPEG_BIN || 'ffmpeg',
    dryRun: false
  };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k === '--frames') { a.frames = path.resolve(ROOT, v); i++; }
    else if (k === '--out') { a.out = path.resolve(ROOT, v); i++; }
    else if (k === '--fps') { a.fps = Number(v); i++; }
    else if (k === '--pattern') { a.pattern = v; i++; }
    else if (k === '--crf') { a.crf = Number(v); i++; }
    else if (k === '--preset') { a.preset = v; i++; }
    else if (k === '--ffmpeg') { a.ffmpeg = v; i++; }
    else if (k === '--dry-run') { a.dryRun = true; }
    else throw new Error('未知参数：' + k);
  }
  return a;
}

/** 序列帧自检：编号从 0 连续、无缺号 —— 缺号会让 ffmpeg 静默截断成片，必须先挡住 */
function inspectFrames(dir, pattern) {
  if (!fs.existsSync(dir)) throw new Error('序列帧目录不存在：' + dir);
  const re = new RegExp('^' + pattern.replace('%05d', '(\\d{5})').replace(/\./g, '\\.') + '$');
  const nums = fs.readdirSync(dir).filter(f => re.test(f))
    .map(f => Number(f.match(re)[1])).sort((x, y) => x - y);
  if (!nums.length) throw new Error('目录里没有匹配 ' + pattern + ' 的帧：' + dir);
  const missing = [];
  for (let i = 0; i <= nums[nums.length - 1]; i++) if (nums.indexOf(i) < 0) missing.push(i);
  const sizes = new Set();
  for (const n of [nums[0], nums[Math.floor(nums.length / 2)], nums[nums.length - 1]]) {
    const f = path.join(dir, pattern.replace('%05d', String(n).padStart(5, '0')));
    const buf = fs.readFileSync(f);
    // PNG IHDR：宽高各 4 字节大端，紧跟在 8 字节签名 + 4 字节长度 + 4 字节 "IHDR" 之后
    sizes.add(buf.readUInt32BE(16) + 'x' + buf.readUInt32BE(20));
  }
  return { count: nums.length, first: nums[0], last: nums[nums.length - 1], missing, sizes: [...sizes] };
}

function main() {
  const a = parseArgs(process.argv);
  const info = inspectFrames(a.frames, a.pattern);
  console.log('[compose] 序列帧目录 ' + path.relative(ROOT, a.frames));
  console.log('           帧数 = ' + info.count + '，编号 ' + info.first + ' … ' + info.last +
              '，缺号 ' + (info.missing.length ? info.missing.slice(0, 20).join(',') : '无'));
  console.log('           抽检分辨率 = ' + info.sizes.join(' / '));
  if (info.missing.length) throw new Error('序列帧有缺号，先补齐再合成（共 ' + info.missing.length + ' 个）');
  if (info.sizes.length !== 1) throw new Error('序列帧分辨率不一致：' + info.sizes.join(' / '));
  const [w, h] = info.sizes[0].split('x').map(Number);
  if (w !== a.width || h !== a.height) {
    throw new Error('序列帧分辨率 ' + info.sizes[0] + ' 与目标 ' + a.width + 'x' + a.height + ' 不一致');
  }
  if (a.fps !== 60) console.log('[compose] ⚠ 目标帧率不是 60fps：' + a.fps);

  fs.mkdirSync(path.dirname(a.out), { recursive: true });
  const args = [
    '-y', '-hide_banner', '-loglevel', 'error', '-stats',
    '-framerate', String(a.fps),
    '-start_number', String(info.first),
    '-i', path.join(a.frames, a.pattern),
    '-frames:v', String(info.count),
    '-c:v', 'libx264',
    '-preset', a.preset,
    '-crf', String(a.crf),
    '-pix_fmt', 'yuv420p',
    '-profile:v', 'high',
    '-r', String(a.fps),
    '-movflags', '+faststart',
    a.out
  ];
  console.log('[compose] ' + a.ffmpeg + ' ' + args.join(' '));
  if (a.dryRun) { console.log('[compose] --dry-run：未执行'); return; }

  const r = spawnSync(a.ffmpeg, args, { stdio: ['ignore', 'inherit', 'inherit'] });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error('ffmpeg 退出码 ' + r.status);
  const st = fs.statSync(a.out);
  console.log('[compose] ✔ ' + path.relative(ROOT, a.out) + '  ' + (st.size / 1048576).toFixed(2) + ' MB');
  console.log('[compose] 预期时长 = ' + (info.count / a.fps).toFixed(3) + ' s（' + info.count + ' 帧 / ' + a.fps + 'fps）');
}

if (require.main === module) {
  try { main(); } catch (e) { console.error('[compose] ✘ ' + e.message); process.exit(1); }
}
module.exports = { inspectFrames };
