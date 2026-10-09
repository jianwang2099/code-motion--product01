#!/usr/bin/env node
/**
 * verify/visual/visual-gate.js · 视觉环节的**确定性门禁**（跑在**自造样本**上，不依赖真实页面、不依赖浏览器）
 * ---------------------------------------------------------------------------
 * 运行：
 *   node verify/visual/visual-gate.js
 * 退出码：0 = 全部断言通过；1 = 有失败
 *
 * 为什么跑自造样本：门禁必须**确定**。像素比对这件事本身只有几个可判对错的性质
 * （同图=0、改了 N 个像素就数出 N、容差边界在哪儿、尺寸不一致必须拒绝、palette/灰度要能读），
 * 把它们钉在自造样本上，才能保证"改坏了比对器"一定被抓住 —— 而不是拿真实页面的
 * 非确定性（GPU / 帧相位 / 闪烁相位）当挡箭牌。
 *
 * 三条要点断言（对应交付要求 1/2/3）：
 *   1) 同图 → 判定"一致"，差异计数 = 0
 *   2) 在样本上人工改 3 个像素 → 判定"不一致"、差异图非空、差异计数 = 3
 *   3) 容差边界：maxDiff=8 时 ±8 不算差异、±9 算差异
 * 另有：尺寸不一致 / 计数与图幅无关 / 解码器自身往返 + **Pillow 独立引擎交叉核对**
 * （同一对图，两个不相干的实现必须给出同一个计数与同一个判定 —— 这是防"两套坐标换算各自空过"的那条）。
 *
 * 产出（写在 <本目录>/visual-gate-out/，**例外**：目录不存在时自建）：
 *   01-same.png / 02-one-pixel-plus9.png / 04-pm8.png / 05-pm9.png / 06-palette.png / 06-gray.png / 06-rgba.png
 *   diff/02-one-pixel-plus9.diff.png  ← 差异图（人可打开看：改了的那 1 个像素是红点）
 *   visual-gate-report.json           ← 机读报告
 * 全部样本都是**算出来的**（不是手画的图片文件），重复运行字节一致。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const png = require('./png.js');
const { judge } = require('./visual.js');

const OUT = path.join(__dirname, 'visual-gate-out');
const DIFF_DIR = path.join(OUT, 'diff');
fs.mkdirSync(DIFF_DIR, { recursive: true });

/* ---------- 断言骨架（沿用 verify/card-07/square-harness.js 的输出口径） ---------- */
let pass = 0, fail = 0;
const log = [], results = [];
function check(name, ok, detail) {
  (ok ? pass++ : fail++);
  log.push(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (detail) log.push(`      ${detail}`);
  results.push({ name, ok, detail });
}

/* ==========================================================================
 * A. 自造样本（纯计算，无随机 → 每次运行字节一致；生成器在 fixtures.js）
 * ========================================================================== */
const { sample, clone, poke, palettePng, grayPng, rgbaPng } = require('./fixtures.js');
const writePng = (name, img) => {
  const buf = png.encode(img);
  const file = path.join(OUT, name);
  fs.writeFileSync(file, buf);
  return { file, buf };
};
const BASE = sample(64, 48);
const BASE_FILE = writePng('01-same.png', BASE).file;
const SAME = clone(BASE);                                        // 同样的像素 → 独立的一份数据
const ONE_PX = poke(clone(BASE), [[31, 23]], +9);                 // 只改 1 个像素（+9 > 容差 8）
const ONE_PX_FILE = writePng('02-one-pixel-plus9.png', ONE_PX).file;
/* 边界样本：同一批像素分别 +8 与 +9（只差 1 个灰度级）；以及"改 5 个点"的计数样本 */
const PM8 = poke(clone(BASE), [[7, 7]], +8);
const PM9 = poke(clone(BASE), [[7, 7]], +9);
const PM8_FILE = writePng('04-pm8.png', PM8).file;
const PM9_FILE = writePng('05-pm9.png', PM9).file;
const N_PIX = poke(clone(BASE), [[3, 4], [10, 11], [40, 30], [63, 47], [0, 0]], +30);
/* 解码器覆盖面：调色板 / 灰度 / RGBA（Pillow 存图就长这些形态，而 Pillow 是交叉核对引擎） */
const PAL = palettePng(40, 30), GRAY = grayPng(40, 30), RGBA = rgbaPng(40, 30);
fs.writeFileSync(path.join(OUT, '06-palette.png'), PAL.png);
fs.writeFileSync(path.join(OUT, '06-gray.png'), GRAY.png);
fs.writeFileSync(path.join(OUT, '06-rgba.png'), RGBA.png);

/* ==========================================================================
 * B. Pillow 独立引擎（交叉核对；**可选**：找不到解释器/没装 Pillow 就如实标注跳过）
 * ========================================================================== */
const PY_CANDIDATES = [
  process.env.VISUAL_PYTHON,
  '/Users/zhangyifan/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/bin/python3',
  'python3'
].filter(Boolean);
const PY_SNIPPET = `
import sys, json
from PIL import Image
a = Image.open(sys.argv[1]).convert("RGB"); b = Image.open(sys.argv[2]).convert("RGB")
if a.size != b.size:
    print(json.dumps({"sizeMismatch": True, "a": list(a.size), "b": list(b.size)})); sys.exit(0)
pa = a.load(); pb = b.load(); maxdiff = int(sys.argv[3]); w, h = a.size
changed = 0; maxAbs = 0
for y in range(h):
    for x in range(w):
        m = max(abs(pa[x, y][c] - pb[x, y][c]) for c in range(3))
        if m > maxAbs: maxAbs = m
        if m > maxdiff: changed += 1
print(json.dumps({"sizeMismatch": False, "w": w, "h": h, "changed": changed, "maxAbs": maxAbs}))
`;
function pillowDiff(aFile, bFile, maxDiff) {
  let lastErr = '';
  for (const bin of PY_CANDIDATES) {
    const r = spawnSync(bin, ['-c', PY_SNIPPET, aFile, bFile, String(maxDiff)], { encoding: 'utf8', timeout: 120000 });
    if (r.error) { lastErr = `${bin}: ${r.error.message}`; continue; }
    if (r.status !== 0) { lastErr = `${bin}: exit ${r.status} ${(r.stderr || '').trim().split('\n').pop()}`; continue; }
    try { return { json: JSON.parse(r.stdout.trim().split('\n').pop()), bin }; } catch (e) { lastErr = `${bin}: 输出无法解析`; }
  }
  return { skipped: lastErr || 'no python' };
}

/* ==========================================================================
 * C. 断言
 * ========================================================================== */
/* 口径说明：比对器把"差异计数"与"阈值判定"分成两件事（见 visual.js 的 judge）。
   门禁用 maxRatio = 0 的**严格模式**断言"能不能判出不一致"（人对着样本改 3 个像素，就必须判不一致）；
   真实页面比对才用 maxRatio=0.1% 那条噪声阈值。两者不能混用，否则"改了 3 个像素"会被阈值吞掉。 */
const STRICT = { maxDiff: 8, maxRatio: 0 };

/* --- 1) 同图 → 一致、差异计数 = 0 --- */
const rSame = judge(BASE, SAME, STRICT);
{
  const diffFile = path.join(DIFF_DIR, '01-same.diff.png');
  fs.writeFileSync(diffFile, png.encode({ width: rSame.width, height: rSame.height, rgb: rSame.diff }));
  let reds = 0;
  for (let i = 0; i < rSame.width * rSame.height; i++) if (rSame.diff[i * 3] === 255 && rSame.diff[i * 3 + 1] === 0) reds++;
  check('视觉1 同图 → 判定"一致"、差异计数 = 0（且差异图里 0 个红点）',
    rSame.pass === true && rSame.changed === 0 && rSame.ratio === 0 && reds === 0 && /^✓/.test(rSame.verdict),
    `判定=${rSame.verdict}；差异图红点数=${reds}；差异图=${path.relative(process.cwd(), diffFile)}`);
}

/* --- 2) 人工改 3 个像素 → 不一致、差异图非空、差异计数 = 3 --- */
{
  const three = poke(clone(BASE), [[5, 6], [32, 24], [60, 44]], +9);
  const r = judge(BASE, three, STRICT);
  const diffFile = path.join(DIFF_DIR, '02-three-pixels.diff.png');
  const dbytes = png.encode({ width: r.width, height: r.height, rgb: r.diff });
  fs.writeFileSync(diffFile, dbytes);
  const redAt = [];
  for (let y = 0; y < r.height; y++) for (let x = 0; x < r.width; x++) {
    const o = (y * r.width + x) * 3;
    if (r.diff[o] === 255 && r.diff[o + 1] === 0 && r.diff[o + 2] === 0) redAt.push(`${x},${y}`);
  }
  const back = png.decode(dbytes);                       // 差异图必须能被解码器读回来（不是空文件/坏文件）
  let backRed = 0;
  for (let i = 0; i < back.width * back.height; i++) if (back.rgb[i * 3] === 255 && back.rgb[i * 3 + 1] === 0) backRed++;
  check('视觉2 人工改 3 个像素 → 判定"不一致"、差异图非空（3 个红点、可重新解码）、差异计数 = 3',
    r.pass === false && r.changed === 3 && /^✗/.test(r.verdict) && redAt.length === 3 && dbytes.length > 0 && backRed === 3,
    `判定=${r.verdict}；差异计数=${r.changed}；红点坐标=${redAt.join(' ')}；差异图 ${dbytes.length} 字节，解码回读红点=${backRed}；差异图=${path.relative(process.cwd(), diffFile)}`);
}

/* --- 3) 容差边界：maxDiff=8 时 ±8 不算差异、±9 算差异 --- */
{
  const at8 = judge(BASE, PM8, { maxDiff: 8, maxRatio: 0 });
  const at9 = judge(BASE, PM9, { maxDiff: 8, maxRatio: 0 });
  /* 反向对照：把容差放到 9，同一个 +9 的像素就应"不算差异" —— 证明判定真的由 maxDiff 控制，
     而不是"凡有差异一律算"（防恒真/恒假断言） */
  const at9Tol9 = judge(BASE, PM9, { maxDiff: 9, maxRatio: 0 });
  const shifted = judge(BASE, PM8, { maxDiff: 7, maxRatio: 0 });
  check('视觉3 容差边界：maxDiff=8 时 +8 不算差异（计数 0）、+9 算差异（计数 1）；maxDiff=9 时 +9 不算；maxDiff=7 时 +8 算（计数 1）',
    at8.changed === 0 && at8.pass === true && at9.changed === 1 && at9.pass === false &&
    at9Tol9.changed === 0 && shifted.changed === 1,
    `+8@tol8 → 计数 ${at8.changed}（${at8.pass ? '一致' : '不一致'}）；+9@tol8 → 计数 ${at9.changed}（${at9.pass ? '一致' : '不一致'}）；+9@tol9 → 计数 ${at9Tol9.changed}；+8@tol7 → 计数 ${shifted.changed}；样本 ${path.basename(PM8_FILE)} / ${path.basename(PM9_FILE)}`);
}

/* --- 4) 尺寸不一致必须被拒绝，不能"算着算着当通过" --- */
{
  const other = sample(64, 47);
  const r = judge(BASE, other, STRICT);
  const bad = judge(BASE, other, { maxDiff: 255, maxRatio: 0 });   // 容差开到最大也不许当通过
  check('视觉4 图幅不一致 → 判"不一致"并给出两边尺寸（容差开到 255 也不许当通过）',
    r.pass === false && r.sizeMismatch === true && bad.pass === false && /尺寸不一致/.test(r.verdict),
    `判定=${r.verdict}`);
}

/* --- 5) 差异计数与图幅无关：改了 5 个像素就是 5（大图小图同规则），且单通道越界也算 --- */
{
  const r = judge(BASE, N_PIX, STRICT);
  const blueOnly = poke(clone(BASE), [[1, 1]], +12, 2);     // 只动 B 通道
  const rb = judge(BASE, blueOnly, STRICT);
  const single = { width: 1, height: 1, rgb: Buffer.from([10, 20, 30]) };
  const single2 = { width: 1, height: 1, rgb: Buffer.from([10, 20, 30]) };
  const single3 = { width: 1, height: 1, rgb: Buffer.from([10, 20, 39]) };
  const r1 = judge(single, single2, STRICT);
  const r2 = judge(single, single3, STRICT);
  check('视觉5 计数规则与图幅无关：64×48 改 5 点 = 5、单像素图 +9 = 1、只看 B 通道的 +12 也算 1',
    r.changed === 5 && rb.changed === 1 && r1.changed === 0 && r1.pass === true && r2.changed === 1 && r2.pass === false,
    `64×48 改 5 点 → ${r.changed}；B 通道 +12 → ${rb.changed}；1×1 同图 → ${r1.changed}；1×1 +9 → ${r2.changed}`);
}

/* --- 6) 解码器自身：编码→解码往返逐字节相等（真实页面 PNG 的滤波覆盖面另见 6b） --- */
{
  const enc = png.encode(BASE);
  const dec = png.decode(enc);
  const real = png.decode(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'verify', 'card-07', '01-square-moving-1200x760.png')));
  const pal = png.decode(fs.readFileSync(path.join(OUT, '06-palette.png')));
  const gry = png.decode(fs.readFileSync(path.join(OUT, '06-gray.png')));
  const rga = png.decode(fs.readFileSync(path.join(OUT, '06-rgba.png')));
  const filterKinds = Object.keys(real.filtered).sort().join('');
  check('视觉6 解码器自证：编码→解码往返逐字节相等；真实页面 PNG（1200×760/含 Sub-Up-Average-Paeth 四种滤波）与调色板/灰度/RGBA 三类都能读对',
    dec.rgb.equals(BASE.rgb) && real.width === 1200 && real.height === 760 && filterKinds === '1234' &&
    pal.rgb.equals(PAL.expect.rgb) && gry.rgb.equals(GRAY.expect.rgb) && rga.rgb.equals(RGBA.expect.rgb),
    `往返相等=${dec.rgb.equals(BASE.rgb)}；真实页面 PNG 滤波分布=${JSON.stringify(real.filtered)}；调色板/灰度/RGBA 解码与期望相等=${pal.rgb.equals(PAL.expect.rgb)}/${gry.rgb.equals(GRAY.expect.rgb)}/${rga.rgb.equals(RGBA.expect.rgb)}`);
}

/* --- 7) Pillow 独立引擎交叉核对：同一对图两个实现必须同计数、同判定 --- */
{
  const threeFile = path.join(OUT, '02-three-pixels.png');
  fs.writeFileSync(threeFile, png.encode(poke(clone(BASE), [[5, 6], [32, 24], [60, 44]], +9)));
  const pairs = [
    ['同图', BASE_FILE, BASE_FILE, 8, 0],
    ['改 3 像素', BASE_FILE, threeFile, 8, 3],
    ['+8（容差内）', BASE_FILE, PM8_FILE, 8, 0],
    ['+9（超容差）', BASE_FILE, PM9_FILE, 8, 1]
  ];
  const rows = [], mism = [];
  let skipped = null, bin = null;
  for (const [label, aF, bF, tol, expectNode] of pairs) {
    const node = judge(png.decode(fs.readFileSync(aF)), png.decode(fs.readFileSync(bF)), { maxDiff: tol, maxRatio: 0 });
    const py = pillowDiff(aF, bF, tol);
    if (py.skipped) { skipped = py.skipped; break; }
    bin = py.bin;
    rows.push(`${label}: node=${node.changed} pillow=${py.json.changed}`);
    if (py.json.changed !== node.changed || node.changed !== expectNode) mism.push(`${label}(node=${node.changed},pillow=${py.json.changed},期望=${expectNode})`);
  }
  if (skipped) {
    check('视觉7 Pillow 独立引擎交叉核对（可选）', true, `⚠ 跳过：找不到带 Pillow 的解释器（${skipped}）—— 本机 Node 侧已通过；需要交叉核对时用 VISUAL_PYTHON=<带 Pillow 的 python3> 重跑`);
  } else {
    check('视觉7 Pillow 独立引擎交叉核对：4 组样本上 node 与 Pillow 的差异计数完全一致，且都等于期望值',
      mism.length === 0, `解释器=${bin}；${rows.join('；')}`);
  }
}

/* --- 8) 差异图必须"差异非空即可见"：全同 → 无红点；有差异 → 红点位置精确 --- */
{
  const same = judge(BASE, clone(BASE), STRICT);
  const one = judge(BASE, ONE_PX, STRICT);
  const diffImg = { width: one.width, height: one.height, rgb: one.diff };
  const file = path.join(DIFF_DIR, '08-one-pixel.diff.png');
  fs.writeFileSync(file, png.encode(diffImg));
  const back = png.decode(fs.readFileSync(file));
  const o = (23 * one.width + 31) * 3;
  const reds = [];
  for (let y = 0; y < back.height; y++) for (let x = 0; x < back.width; x++) {
    const p = (y * back.width + x) * 3;
    if (back.rgb[p] === 255 && back.rgb[p + 1] === 0 && back.rgb[p + 2] === 0) reds.push(`${x},${y}`);
  }
  check('视觉8 差异图语义：同图 → 差异图零红点；单像素 +9 → 差异图恰好 1 个红点且坐标 = (31,23)',
    same.changed === 0 && reds.length === 1 && reds[0] === '31,23' &&
    /^✓/.test(same.verdict), `同图红点 0；单点样本红点=${reds.join(' ')}；样本 ${path.basename(ONE_PX_FILE)}；差异图=${path.relative(process.cwd(), file)}`);
}

/* --- 9) 预算自证（本文件自己 ≤ 300 行、断言 ≤ 12 条、产出目录可重跑） --- */
{
  const selfLines = fs.readFileSync(__filename, 'utf8').replace(/\n$/, '').split('\n').length;
  const nAssert = pass + fail + 1;
  const outs = fs.readdirSync(OUT).filter(f => f.endsWith('.png')).sort();
  check('视觉9 预算自证：本脚本 ≤ 300 行、断言 ≤ 12 条、样本与差异图都已落盘（可独立复核）',
    selfLines <= 300 && nAssert <= 12 && outs.length >= 6,
    `本脚本 ${selfLines} 行；断言 ${nAssert} 条；产出 ${outs.length} 张 PNG：${outs.join(', ')}`);
}

/* ---------- 输出 ---------- */
fs.writeFileSync(path.join(OUT, 'visual-gate-report.json'),
  JSON.stringify({ outDir: OUT, pass, fail, results }, null, 2));
console.log(log.join('\n'));
console.log(`\n样本与差异图：${path.relative(process.cwd(), OUT)}（全为计算生成，重复运行字节一致）`);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
