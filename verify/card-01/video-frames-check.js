#!/usr/bin/env node
'use strict';
/**
 * verify/card-01/video-frames-check.js · 序列帧与成片的确定性断言（卡 01 的 C1/C2/C3/D1/D2）
 * ---------------------------------------------------------------------------
 * 只读已存在的产物，**不渲染**：
 *   - C1：video/frames/ 的 frame_%05d.png 连续无缺号共 1440 张、每张 IHDR 1920×1080
 *   - C2：画面逐帧在动（相邻帧两两必不同 / 去重 ≥1300 / 段边界帧不同）
 *   - C3：video/frames/ 与 video/frames-run2/ 逐张 md5 完全一致，且 run2 不存在（用完即删）
 *   - D1/D2：video/out/periodic-table-24s.mp4 的 ffprobe 元数据与体积
 *
 * 用法：node verify/card-01/video-frames-check.js
 * 退出码：0 = 全通过；1 = 有失败（并打印 N passed, M failed 摘要）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const FRAMES = path.join(ROOT, 'video', 'frames');
const RUN2 = path.join(ROOT, 'video', 'frames-run2');
const MP4 = path.join(ROOT, 'video', 'out', 'periodic-table-24s.mp4');
const W = 1920, H = 1080, TOTAL = 1440;
const FPS = 60, DURATION = 24;
const UNIQ_MIN = 1300;                        /* C2(b) 阈值（卡 01 验收标准） */

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ✔ ' + name + (detail ? '  ' + detail : '')); }
  else { fail++; failures.push(name); console.log('  ✘ ' + name + (detail ? '  ' + detail : '')); }
}
function frameName(i) { return 'frame_' + String(i).padStart(5, '0') + '.png'; }
function md5(buf) { return crypto.createHash('md5').update(buf).digest('hex'); }
/** 读 PNG 的 IHDR（偏移 16..24 = width/height，大端 uint32），同时校验签名 */
function readPngSize(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(24);
    fs.readSync(fd, head, 0, 24, 0);
    const sig = head.slice(0, 8).toString('hex');
    if (sig !== '89504e470d0a1a0a') return null;             /* PNG 魔数 */
    return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
  } finally { fs.closeSync(fd); }
}
function listFrames(dir) {
  if (!fs.existsSync(dir)) return null;
  return fs.readdirSync(dir).filter(f => /^frame_\d{5}\.png$/.test(f)).sort();
}
function ffprobe(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,avg_frame_rate,nb_frames,codec_name,pix_fmt',
    '-show_entries', 'format=duration', '-of', 'json', file], { encoding: 'utf8' });
  if (r.status !== 0) return { status: r.status, error: (r.stderr || '').trim() };
  let j;
  try { j = JSON.parse(r.stdout); } catch (e) { return { status: 0, error: 'ffprobe JSON 解析失败' }; }
  const st = (j.streams && j.streams[0]) || {};
  const fm = j.format || {};
  return {
    status: 0,
    width: Number(st.width), height: Number(st.height),
    avg: st.avg_frame_rate, nb: Number(st.nb_frames),
    codec: st.codec_name, pix: st.pix_fmt,
    duration: fm.duration === undefined ? NaN : Number(fm.duration)
  };
}

console.log('卡 01 · 序列帧与成片断言（只读产物，不渲染）');
console.log('工作区根：' + ROOT + '\n');

/* ------------------------------- C1 ------------------------------- */
console.log('C1 · 序列帧完整性');
const files = listFrames(FRAMES);
if (!files) {
  ok('C1 video/frames/ 存在', false, '目录不存在 —— 需先出片：node video/make-video.js --plan video/plan.js --url http://127.0.0.1:5174/index.html --duration 24 --out video/out/periodic-table-24s.mp4');
} else {
  ok('C1 帧数 = ' + TOTAL, files.length === TOTAL, '实测 ' + files.length);
  const missing = [];
  for (let i = 0; i < TOTAL; i++) if (!files.includes(frameName(i))) missing.push(i);
  ok('C1 编号连续无缺号', missing.length === 0, missing.length ? '缺 ' + missing.length + ' 帧，首个缺 ' + frameName(missing[0]) : '0…' + (TOTAL - 1));
  let badSize = 0;
  for (const f of files) {
    const s = readPngSize(path.join(FRAMES, f));
    if (!s || s.width !== W || s.height !== H) badSize++;
  }
  ok('C1 每张 IHDR = ' + W + '×' + H, badSize === 0, badSize ? badSize + ' 张不符' : files.length + ' 张全部符合');
}

/* ------------------------------- C2 ------------------------------- */
console.log('\nC2 · 画面逐帧在动');
if (files && files.length === TOTAL) {
  const hashes = new Array(TOTAL);
  for (let i = 0; i < TOTAL; i++) hashes[i] = md5(fs.readFileSync(path.join(FRAMES, frameName(i))));
  let sameAdj = 0, firstSame = -1;
  for (let i = 0; i < TOTAL - 1; i++) {
    if (hashes[i] === hashes[i + 1]) { sameAdj++; if (firstSame < 0) firstSame = i; }
  }
  ok('C2(a) 相邻帧两两不同（允许 0 次相等）', sameAdj === 0,
    sameAdj === 0 ? '1439 对全部不同' : sameAdj + ' 对相同，首个 ' + frameName(firstSame) + '==' + frameName(firstSame + 1));

  const uniq = new Set(hashes).size;
  ok('C2(b) 去重 md5 ≥ ' + UNIQ_MIN, uniq >= UNIQ_MIN, '实测去重 ' + uniq + ' / ' + TOTAL);

  const pairs = [[329, 330], [1019, 1020]];
  const bad = pairs.filter(([a, b]) => hashes[a] === hashes[b]).map(([a, b]) => frameName(a) + '==' + frameName(b));
  ok('C2(c) 段边界帧不同', bad.length === 0, bad.length ? bad.join(' ') : '329≠330、1019≠1020');

  /* 非平凡性：首帧不能是近空屏（背景只有 ~192KB，有 36 格时实测 >430KB） */
  const s0 = fs.statSync(path.join(FRAMES, frameName(0))).size;
  ok('C2(d) 第 0 帧非空屏（>250KB）', s0 > 250 * 1024, s0 + ' bytes');
} else {
  ok('C2 跳过（C1 未通过：帧不全）', false, '需先出满 1440 帧');
}

/* ------------------------------- C3 ------------------------------- */
console.log('\nC3 · 确定性（两遍渲染逐张一致）');
/* 说明：C3 需要 video/frames-run2/ 存在才能比对；而"比完即删"又是一条要求。
   两条不可能同时成立，所以这里显式区分**未跑**与**失败**：
     · 没有 run2 且带 --allow-missing-run2 → 记为 SKIP（不计失败，但**绝不声称通过**）
     · 没有 run2 且不带该参数             → 记为失败，并打印该怎么跑
     · 有 run2                            → 真比对，逐张 md5 必须一致
   README 的常规流程是：先跑确定性对照 → 跑本脚本（此时 run2 在）→ 删 run2 → 跑 gate（带 --allow-missing-run2）。 */
const allowMissingRun2 = process.argv.indexOf('--allow-missing-run2') >= 0;
if (files && listFrames(RUN2)) {
  const f2 = listFrames(RUN2);
  ok('C3 文件名集合相同', JSON.stringify(files) === JSON.stringify(f2),
    'run1 ' + files.length + ' 张 / run2 ' + f2.length + ' 张');
  let diff = 0, firstDiff = '';
  const n = Math.min(files.length, f2.length);
  for (let i = 0; i < n; i++) {
    if (files[i] !== f2[i]) { diff++; if (!firstDiff) firstDiff = files[i] + ' vs ' + f2[i]; continue; }
    const a = md5(fs.readFileSync(path.join(FRAMES, files[i])));
    const b = md5(fs.readFileSync(path.join(RUN2, f2[i])));
    if (a !== b) { diff++; if (!firstDiff) firstDiff = files[i]; }
  }
  ok('C3 逐张 md5 完全一致', diff === 0, diff === 0 ? n + ' 张全部一致' : diff + ' 张不同，首个 ' + firstDiff);
} else if (allowMissingRun2) {
  console.log('  ⚠ C3 跳过：video/frames-run2/ 不存在（--allow-missing-run2）——**没比对 ≠ 确定性通过**');
} else {
  ok('C3 video/frames-run2/ 存在（需先跑确定性对照）', false,
    '跑：node video/render-frames.js --plan video/plan.js --url http://127.0.0.1:5174/index.html --duration 24 --out video/frames-run2');
}
ok('C3 frames-run2 已删除（比完即删，避免污染提交）', !fs.existsSync(RUN2),
  fs.existsSync(RUN2) ? '仍存在：请 rm -rf video/frames-run2' : '不存在 ✔');

/* ------------------------------- D1/D2 ------------------------------- */
console.log('\nD1/D2 · 成片');
if (!fs.existsSync(MP4)) {
  ok('D1 成片存在', false, '缺 ' + path.relative(ROOT, MP4) + ' —— 需先出片（带 --out）');
} else {
  const size = fs.statSync(MP4).size;
  ok('D2 体积 > 100KB', size > 100 * 1024, (size / 1048576).toFixed(2) + ' MB');
  const p = ffprobe(MP4);
  if (p.status !== 0) {
    ok('D2 ffprobe 可解码（exit 0）', false, p.error || 'ffprobe 退出码 ' + p.status);
  } else {
    ok('D2 ffprobe 可解码（exit 0）', true, '');
    ok('D1 codec = h264', p.codec === 'h264', String(p.codec));
    ok('D1 pix_fmt = yuv420p', p.pix === 'yuv420p', String(p.pix));
    ok('D1 分辨率 = ' + W + '×' + H, p.width === W && p.height === H, p.width + '×' + p.height);
    ok('D1 avg_frame_rate = ' + FPS + '/1', p.avg === FPS + '/1', String(p.avg));
    ok('D1 nb_frames = ' + TOTAL, p.nb === TOTAL, String(p.nb));
    const durOk = isFinite(p.duration) && p.duration >= DURATION - 0.1 && p.duration <= DURATION + 0.1;
    ok('D1 时长在 ' + (DURATION - 0.1) + '–' + (DURATION + 0.1) + ' s', durOk, p.duration + ' s');
  }
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (fail) console.log('失败项：\n  - ' + failures.join('\n  - '));
process.exit(fail ? 1 : 0);
