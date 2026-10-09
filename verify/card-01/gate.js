#!/usr/bin/env node
'use strict';
/**
 * verify/card-01/gate.js · 卡 01 的**唯一确定性门禁**
 * ---------------------------------------------------------------------------
 * 覆盖 storyboard/card-01.md 的 A1–A7 / B1–B3 / C1–C3 / D1–D2。
 *   - A1：对 index.html 做**文件词法检查**（不调浏览器）
 *   - A2–A7 / B3：**真调浏览器**（CDP，复用 video/lib/cdp.js）
 *   - C1–C3 / D1–D2：委托 video-frames-check.js（只读产物）
 *
 * **本门禁不渲染序列帧**：C/D 断言读已存在的 video/frames/ 与 video/out/*.mp4，
 * 缺产物时明确失败并打印"需先出片"的命令。跑之前请先按 verify/card-01/README.md 出片。
 *
 * 用法：node verify/card-01/gate.js
 * 退出码：0 = 全通过；打印 "N passed, M failed"
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { launchSession } = require(path.resolve(__dirname, '..', '..', 'video', 'lib', 'cdp.js'));

const ROOT = path.resolve(__dirname, '..', '..');
const W = 1920, H = 1080, FPS = 60, DURATION = 24, TOTAL = 1440;
const STEPS_PER_FRAME = 2;                       /* FIXED_DT = 1/120 → 每帧恰好 2 步（卡 01 硬编码） */
const CLIP = { x: 0, y: 0, width: W, height: H, scale: 1 };
const URL_VIDEO = 'http://127.0.0.1:5174/index.html?video=1&duration=24&fps=60';
const URL_PLAIN = 'http://127.0.0.1:5174/index.html';

/* A7 人工验收截图：帧号 + 镜头名（文件名形如 NN_00329_assembly-end.png） */
const FRAME_PLAN = [
  { n: 0, name: 'opening-wide' },
  { n: 329, name: 'assembly-end' },
  { n: 419, name: 'stage1-end' },
  { n: 620, name: 'halogen-start' },
  { n: 1020, name: 'carbon-start' },
  { n: 1100, name: 'carbon-centered' },
  { n: 1439, name: 'final' }
];
const REQUIRED_SHOT_FRAMES = FRAME_PLAN.map(s => s.n);

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ✔ ' + name + (detail ? '  ' + detail : '')); }
  else { fail++; failures.push(name); console.log('  ✘ ' + name + (detail ? '  ' + detail : '')); }
}
function md5(buf) { return crypto.createHash('md5').update(buf).digest('hex'); }

(async function main() {
  console.log('卡 01 · 唯一确定性门禁');
  console.log('工作区根：' + ROOT);
  console.log('预览地址：' + URL_VIDEO + '\n');

  /* =============================== A1 =============================== */
  console.log('A1 · 无 CSS 时钟依赖（文件词法检查，不调浏览器）');
  const htmlPath = path.join(ROOT, 'index.html');
  if (!fs.existsSync(htmlPath)) {
    ok('A1 index.html 存在', false, '缺 ' + path.relative(ROOT, htmlPath));
  } else {
    const src = fs.readFileSync(htmlPath, 'utf8');
    const needles = ['animation:', 'animation-', 'transition:', 'transition-', '@keyframes', 'getAnimations', 'currentTime'];
    const hits = needles.filter(s => src.indexOf(s) >= 0);
    ok('A1 index.html 不含 ' + needles.join(' / '), hits.length === 0,
      hits.length ? '命中：' + hits.join(', ') : '0 命中');
    ok('A1? 时长常量 = 24（VIDEO_DURATION_DEFAULT 可改）', /VIDEO_DURATION_DEFAULT\s*=\s*24\s*;/.test(src),
      '用于静态模式的帧号规划与人类阅读');
  }

  /* =============================== B1/B2 =============================== */
  console.log('\nB1/B2 · plan.js 形状与 actions 全 null');
  const planPath = path.join(ROOT, 'video', 'plan.js');
  if (!fs.existsSync(planPath)) {
    ok('B1 video/plan.js 存在', false, '缺 ' + path.relative(ROOT, planPath));
  } else {
    let plan = null;
    try {
      plan = await require(planPath).solve(null, { fps: FPS, duration: DURATION, width: W, height: H });
    } catch (e) {
      ok('B1 solve() 可调用（async，需 await）', false, e.message);
    }
    if (plan) {
      ok('B1 fps = ' + FPS, plan.fps === FPS, String(plan.fps));
      ok('B1 duration = ' + DURATION, plan.duration === DURATION, String(plan.duration));
      ok('B1 totalFrames = ' + TOTAL, plan.totalFrames === TOTAL, String(plan.totalFrames));
      ok('B1 actions.length = ' + TOTAL, Array.isArray(plan.actions) && plan.actions.length === TOTAL,
        Array.isArray(plan.actions) ? String(plan.actions.length) : '不是数组');
      ok('B1 totalFrames === round(fps × duration)', plan.totalFrames === Math.round(plan.fps * plan.duration), '');
      const logOk = Array.isArray(plan.log) && plan.log.length > 0 && plan.log.every(s => typeof s === 'string');
      ok('B1 log 为非空字符串数组', logOk, logOk ? plan.log.length + ' 条' : '不合规');
      const shotsOk = Array.isArray(plan.shots) && plan.shots.length > 0 &&
        plan.shots.every(s => s && typeof s.index === 'number' && isFinite(s.index));
      ok('B1 shots 非空且每项含数字 index', shotsOk, shotsOk ? plan.shots.length + ' 个里程碑' : '不合规');
      const allNull = Array.isArray(plan.actions) && plan.actions.every(a => a === null);
      ok('B2 actions 全部 === null（时间轴由页面自算）', allNull,
        allNull ? TOTAL + ' 项全为 null' : '存在非 null 动作');
    }
  }

  /* ===================== 浏览器侧：A2–A7 + B3 ===================== */
  let session = null, plain = null;
  try {
    /* --- A5 先验：无 query 时不得挂出口（独立会话） --- */
    console.log('\nA5 · ?video=1 之外不挂 window.__video');
    try {
      plain = await launchSession({ url: URL_PLAIN, width: W, height: H, timeoutMs: 20000 });
      const v = await plain.evaluate('typeof window.__video');
      ok('A5 无 query 时 window.__video === undefined', v === 'undefined', 'typeof = ' + v);
    } catch (e) {
      ok('A5 打开默认页面', false, e.message);
    } finally {
      if (plain) { await plain.close(); plain = null; }
    }

    session = await launchSession({
      url: URL_VIDEO, width: W, height: H,
      readyExpr: '!!(window.__video && window.__video.active)', timeoutMs: 30000
    });

    /* --------------------------- A2 --------------------------- */
    console.log('\nA2 · 出口成员齐全、类型正确、非法 duration 被忽略');
    const info = await session.evaluate(`(function () {
      var v = window.__video;
      if (!v) return { exists: false };
      var fns = ['reset','stepFrame','simulateFrames','render','commit','captureFrame'];
      var keys = Object.getOwnPropertyNames(v).sort();
      var fnTypes = {};
      fns.forEach(function (k) { fnTypes[k] = typeof v[k]; });
      var extra = Object.getOwnPropertyNames(v).filter(function (k) {
        return ['active','fps','width','height','duration','totalFrames','frameIndex','simSteps',
                'reset','stepFrame','simulateFrames','render','commit','captureFrame'].indexOf(k) < 0;
      });
      return {
        exists: true, active: v.active, fps: v.fps, width: v.width, height: v.height,
        duration: v.duration, totalFrames: v.totalFrames, frameIndex: v.frameIndex, simSteps: v.simSteps,
        fnTypes: fnTypes, keys: keys, extra: extra,
        hasSetDrag: typeof v.setDrag, hasRelease: typeof v.release
      };
    })()`);
    if (!info.exists) {
      ok('A2 window.__video 存在', false, '未挂载');
    } else {
      ok('A2 active === true', info.active === true, String(info.active));
      ok('A2 fps = ' + FPS, info.fps === FPS, String(info.fps));
      ok('A2 width×height = ' + W + '×' + H, info.width === W && info.height === H, info.width + '×' + info.height);
      ok('A2 duration = ' + DURATION, info.duration === DURATION, String(info.duration));
      ok('A2 totalFrames = round(duration×fps) = ' + TOTAL, info.totalFrames === Math.round(info.duration * info.fps),
        String(info.totalFrames));
      const badFns = Object.keys(info.fnTypes).filter(k => info.fnTypes[k] !== 'function');
      ok('A2 六个方法都是函数', badFns.length === 0,
        badFns.length ? '不是函数：' + badFns.join(',') : Object.keys(info.fnTypes).join(' / '));
      ok('A2 无 setDrag/release（本片无脚本化输入）', info.hasSetDrag === 'undefined' && info.hasRelease === 'undefined',
        'setDrag=' + info.hasSetDrag + ' release=' + info.hasRelease);
      ok('A2 未多挂契约外的键', info.extra.length === 0,
        info.extra.length ? '多挂：' + info.extra.join(',') : info.keys.join(','));
      const durTest = await session.evaluateAwait(`(async function () {
        var v = window.__video, bad = [NaN, 0, -5], seen = [];
        for (var i = 0; i < bad.length; i++) { v.duration = bad[i]; seen.push(v.duration); }
        return { seen: seen, final: v.duration };
      })()`);
      ok('A2 非法 duration（NaN/0/-5）被忽略、仍为 ' + DURATION,
        durTest.final === DURATION && durTest.seen.every(d => d === DURATION),
        '赋值后 duration = ' + JSON.stringify(durTest.seen));
    }

    /* --------------------------- A3 --------------------------- */
    console.log('\nA3 · 帧号推进自洽（步长硬编码 ' + STEPS_PER_FRAME + '）');
    const a3 = await session.evaluateAwait(`(async function () {
      window.__video.reset();
      var resetState = { frameIndex: window.__video.frameIndex, simSteps: window.__video.simSteps };
      var bad = [];
      for (var k = 1; k <= 120; k++) {
        window.__video.stepFrame();
        if (window.__video.frameIndex !== k) bad.push('frameIndex@' + k + '=' + window.__video.frameIndex);
        if (window.__video.simSteps !== k * ${STEPS_PER_FRAME}) bad.push('simSteps@' + k + '=' + window.__video.simSteps);
      }
      return { resetState: resetState, bad: bad, end: window.__video.frameIndex, endSteps: window.__video.simSteps };
    })()`);
    ok('A3 reset() 后 frameIndex/simSteps 归零',
      a3.resetState.frameIndex === 0 && a3.resetState.simSteps === 0, JSON.stringify(a3.resetState));
    ok('A3 连续 120 次 stepFrame()：frameIndex === k 且 simSteps === k×' + STEPS_PER_FRAME,
      a3.bad.length === 0, a3.bad.length ? a3.bad.slice(0, 3).join('; ') : '120 步全部自洽');

    /* --------------------------- A4 --------------------------- */
    console.log('\nA4 · reset() 真正回零且非平凡可复现（CDP 同路径抓图）');
    const resetHashes = [];
    for (let i = 0; i < 3; i++) {
      await session.evaluateAwait(`(async function () { window.__video.reset(); await window.__video.commit(); return true; })()`);
      resetHashes.push(md5(await session.screenshot(CLIP)));
    }
    ok('A4② 三次 reset+commit 抓图 md5 完全相同',
      resetHashes[0] === resetHashes[1] && resetHashes[1] === resetHashes[2],
      resetHashes.map(h => h.slice(0, 8)).join(' / '));
    await session.evaluateAwait(`(async function () { window.__video.reset(); window.__video.simulateFrames(700); await window.__video.commit(); return true; })()`);
    const at700 = md5(await session.screenshot(CLIP));
    ok('A4③ 非平凡：reset 帧 ≠ 推进 700 帧后的帧', resetHashes[0] !== at700,
      'reset=' + resetHashes[0].slice(0, 8) + ' 700=' + at700.slice(0, 8));

    /* --------------------------- A6 --------------------------- */
    console.log('\nA6 · render() 不推进时间');
    const a6 = await session.evaluateAwait(`(async function () {
      window.__video.reset();
      window.__video.simulateFrames(700);
      var before = { f: window.__video.frameIndex, s: window.__video.simSteps };
      var mid = [];
      for (var i = 0; i < 3; i++) {
        window.__video.render();
        mid.push({ f: window.__video.frameIndex, s: window.__video.simSteps });
      }
      /* 三次 render 之后各交一帧，抓图应两张相同 */
      await window.__video.commit();
      return { before: before, mid: mid };
    })()`);
    const stable = a6.mid.every(x => x.f === a6.before.f && x.s === a6.before.s);
    ok('A6 连续 render() 3 次：frameIndex 与 simSteps 都不变', stable,
      'frameIndex=' + a6.before.f + ' simSteps=' + a6.before.s);
    const h1 = md5(await session.screenshot(CLIP));
    await session.evaluateAwait(`(async function () { await window.__video.commit(); return true; })()`);
    const h2 = md5(await session.screenshot(CLIP));
    ok('A6 三次 commit 后同路径抓图 md5 相同', h1 === h2, h1.slice(0, 8) + ' / ' + h2.slice(0, 8));

    /* --------------------------- A7 --------------------------- */
    console.log('\nA7 · 人工验收截图（≥6 张，覆盖指定帧号）');
    const shotsDir = path.join(__dirname, 'shots');
    fs.mkdirSync(shotsDir, { recursive: true });
    for (let i = 0; i < FRAME_PLAN.length; i++) {
      const s = FRAME_PLAN[i];
      await session.evaluateAwait(`(async function () {
        window.__video.reset(); window.__video.simulateFrames(${s.n}); await window.__video.commit(); return true;
      })()`);
      const png = await session.screenshot(CLIP);
      const name = String(i + 1).padStart(2, '0') + '_' + String(s.n).padStart(5, '0') + '_' + s.name + '.png';
      fs.writeFileSync(path.join(shotsDir, name), png);
      console.log('     写出 shots/' + name + '  (' + (png.length / 1024).toFixed(0) + ' KB)');
    }
    const shotFiles = fs.readdirSync(shotsDir).filter(f => /^\d{2}_\d{5}_.+\.png$/.test(f));
    const covered = new Set(shotFiles.map(f => Number(f.slice(3, 8))));
    const missing = REQUIRED_SHOT_FRAMES.filter(n => !covered.has(n));
    ok('A7 shots/ 至少 6 张且命名合规', shotFiles.length >= 6, shotFiles.length + ' 张');
    ok('A7 覆盖指定帧号 ' + REQUIRED_SHOT_FRAMES.join(', '),
      missing.length === 0, missing.length ? '缺 ' + missing.join(',') : '全部覆盖');

    /* --------------------------- B3 --------------------------- */
    console.log('\nB3 · 三段边界落在真实切换点上（页面端帧哈希）');
    async function frameHash(n) {
      await session.evaluateAwait(`(async function () {
        window.__video.reset(); window.__video.simulateFrames(${n}); await window.__video.commit(); return true;
      })()`);
      return md5(await session.screenshot(CLIP));
    }
    const b419 = await frameHash(419), b420 = await frameHash(420);
    const b1019 = await frameHash(1019), b1020 = await frameHash(1020);
    ok('B3 frame(419) ≠ frame(420)（① → ②）', b419 !== b420, b419.slice(0, 8) + ' vs ' + b420.slice(0, 8));
    ok('B3 frame(1019) ≠ frame(1020)（② → ③）', b1019 !== b1020, b1019.slice(0, 8) + ' vs ' + b1020.slice(0, 8));
  } catch (e) {
    ok('浏览器侧断言（A2–A7/B3）', false, e.message);
  } finally {
    if (session) await session.close();
    if (plain) await plain.close();
  }

  /* ================= C1–C3 / D1–D2：委托序列帧断言 ================= */
  console.log('\nC/D · 序列帧与成片（委托 video-frames-check.js）');
  const childArgs = [path.join(__dirname, 'video-frames-check.js')];
  /* 收尾态（frames-run2 已按规矩删掉）下要能跑绿：C3 记为 SKIP 而非假通过。
     确定性真比对的那一次**不要**带这个参数。 */
  if (process.argv.indexOf('--allow-missing-run2') >= 0) childArgs.push('--allow-missing-run2');
  const r = spawnSync(process.execPath, childArgs, { cwd: ROOT, encoding: 'utf8' });
  const out = (r.stdout || '') + (r.stderr || '');
  /* 把子脚本的结论并入本门禁的计数 */
  const m = out.match(/(\d+) passed, (\d+) failed/);
  if (m) {
    pass += Number(m[1]);
    fail += Number(m[2]);
    out.split('\n').forEach(l => { if (/^\s*[✔✘]/.test(l)) console.log('  ' + l.trim()); });
  } else {
    ok('C/D 子断言可运行', false, '未拿到摘要输出（exit ' + r.status + '）');
    console.log(out.split('\n').slice(-8).join('\n'));
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  if (fail) console.log('失败项：\n  - ' + failures.join('\n  - '));
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('\n✘ 门禁异常：' + (e && e.stack || e));
  process.exit(1);
});
