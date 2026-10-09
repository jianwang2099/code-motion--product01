#!/usr/bin/env node
'use strict';
/**
 * verify/card-01/make-determinism-report.js · 生成确定性比对报告（卡 01 C3 的机器可读存档）
 * ---------------------------------------------------------------------------
 * 用法（需要 video/frames/ 与 video/frames-run2/ 同时在场）：
 *   node verify/card-01/make-determinism-report.js
 *
 * 产出：verify/card-01/determinism-report.json
 *   逐帧 md5 清单（1440 条）会被排序后汇总成 sha256，避免 JSON 体积过大，
 *   同时保留首/中/末三帧的原始 md5 供人快速核对。
 *
 * 退出码：0 = 两遍逐张一致；1 = 有差异或前置不满足。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const A = path.join(ROOT, 'video', 'frames');
const B = path.join(ROOT, 'video', 'frames-run2');
const OUT = path.join(__dirname, 'determinism-report.json');
const TOTAL = 1440;

function md5File(p) { return crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex'); }
function list(dir) {
  if (!fs.existsSync(dir)) return null;
  return fs.readdirSync(dir).filter(f => /^frame_\d{5}\.png$/.test(f)).sort();
}
function name(i) { return 'frame_' + String(i).padStart(5, '0') + '.png'; }

const fa = list(A), fb = list(B);
if (!fa || fa.length !== TOTAL) {
  console.error('✘ 前置不满足：' + path.relative(ROOT, A) + ' 应有 ' + TOTAL + ' 帧，实测 ' + (fa ? fa.length : '目录不存在'));
  process.exit(1);
}
if (!fb || fb.length !== TOTAL) {
  console.error('✘ 前置不满足：' + path.relative(ROOT, B) + ' 应有 ' + TOTAL + ' 帧，实测 ' + (fb ? fb.length : '目录不存在'));
  console.error('  跑：node video/render-frames.js --plan video/plan.js --url http://127.0.0.1:5174/index.html --duration 24 --out video/frames-run2');
  process.exit(1);
}

const manifestA = [], manifestB = [];
let diff = 0, firstDiff = null;
const samples = {};
for (let i = 0; i < TOTAL; i++) {
  const ha = md5File(path.join(A, name(i)));
  const hb = md5File(path.join(B, name(i)));
  manifestA.push(name(i) + ' ' + ha);
  manifestB.push(name(i) + ' ' + hb);
  if (ha !== hb) { diff++; if (!firstDiff) firstDiff = { frame: name(i), run1: ha, run2: hb }; }
  if (i === 0 || i === Math.floor(TOTAL / 2) || i === TOTAL - 1) samples[name(i)] = { run1: ha, run2: hb };
}
/* 文件名集合也必须是同一个（此处两者长度都为 TOTAL，再显式比一次顺序） */
const setEqual = fa.length === fb.length && fa.every((f, i) => f === fb[i]);

const digest = arr => crypto.createHash('sha256').update(arr.join('\n')).digest('hex');
const report = {
  card: '01',
  what: 'C3 确定性：同一 plan 渲染两遍，逐张 md5 必须完全一致',
  url: 'http://127.0.0.1:5174/index.html?video=1&duration=24&fps=60',
  plan: 'video/plan.js',
  fps: 60, duration: 24, totalFrames: TOTAL,
  run1: { dir: 'video/frames', files: fa.length, manifestSha256: digest(manifestA) },
  run2: { dir: 'video/frames-run2', files: fb.length, manifestSha256: digest(manifestB) },
  fileNameSetEqual: setEqual,
  perFrameMismatchCount: diff,
  firstMismatch: firstDiff,
  sampleFrames: samples,
  verdict: (diff === 0 && setEqual) ? 'PASS' : 'FAIL',
  note: 'manifestSha256 = 按帧号排序的 "文件名 md5" 行拼接（\\n）后的 sha256；逐帧清单不落盘以控制体积，可用本脚本一键重算复核。'
};
fs.writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n');
console.log('确定性报告已写出：' + path.relative(ROOT, OUT));
console.log('  逐帧不一致 = ' + diff + '；文件名集合相同 = ' + setEqual + '；判定 = ' + report.verdict);
console.log('  run1 manifest sha256 = ' + report.run1.manifestSha256);
console.log('  run2 manifest sha256 = ' + report.run2.manifestSha256);
process.exit(report.verdict === 'PASS' ? 0 : 1);
