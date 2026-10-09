#!/usr/bin/env node
'use strict';
/**
 * 逐帧导出（流水线的"代码 → 帧"那一步）
 * ---------------------------------------------------------------------------
 * 做什么：
 *   1. 起一个无头浏览器，视口钉死成 W×H（默认 1920×1080，deviceScaleFactor=1）；
 *   2. 打开 `<你的页面>?video=1&duration=<秒>&fps=<帧率>` —— 页面进入**视频渲染模式**：
 *      固定帧率、固定分辨率、关掉 rAF 主循环，时间轴完全由脚本驱动；
 *   3. 加载 **plan provider**（`--plan <路径>`，必须导出 `async function solve(session, cfg)`），
 *      由它解出确定性时间轴 actions / log / shots；
 *   4. 照着时间轴**逐帧推进 + 逐帧抓图**，按时间轴有序命名写成 PNG 序列帧。
 *
 * 为什么不是"录屏"：
 *   录屏（screencast）是**实时**的，帧会因为机器性能被丢/被并；而这里每一帧都先
 *   `stepFrame()` 把时间轴推进恰好"一帧"的量，再 `render()` 并等两个 rAF 让画面真正
 *   上屏，最后才抓图 —— 所以导出的 N 张帧**逐帧对应 1/fps 秒**，与机器快慢无关。
 *
 * 用法：
 *   node video/render-frames.js --plan <provider.js> --url <页面> --duration 30
 *   node video/render-frames.js --limit 90            # 冒烟：只出前 90 帧
 *   node video/render-frames.js --capture inline      # 换用页面内 toDataURL 抓图
 *   node video/render-frames.js --plan-json out/plan.json   # 顺便把时间轴存盘
 *
 * 路径基准：`--plan` / `--out` / `--plan-json` / `--frames` 一律按
 *   `path.resolve(ROOT, v)` 解析（ROOT = 脚本所在目录的上一级 = 项目根），**与 cwd 无关**。
 */

const fs = require('fs');
const path = require('path');
const { launchSession, sleep } = require('./lib/cdp');

const ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const a = {
    url: process.env.PREVIEW_URL || 'http://127.0.0.1:5173/index.html',
    plan: '', planJson: '',
    outDir: path.join(ROOT, 'video', 'frames'),
    selector: 'canvas',
    ready: '!!(window.__video && window.__video.active)',
    width: 1920, height: 1080, fps: 60, duration: 30,
    capture: 'clip', limit: 0, quiet: false
  };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i], v = argv[i + 1];
    if (k === '--url') { a.url = v; i++; }
    else if (k === '--plan') { a.plan = path.resolve(ROOT, v); i++; }
    else if (k === '--out') { a.outDir = path.resolve(ROOT, v); i++; }
    else if (k === '--width') { a.width = Number(v); i++; }
    else if (k === '--height') { a.height = Number(v); i++; }
    else if (k === '--fps') { a.fps = Number(v); i++; }
    else if (k === '--duration') { a.duration = Number(v); i++; }
    else if (k === '--capture') { a.capture = v; i++; }
    else if (k === '--limit') { a.limit = Number(v); i++; }
    else if (k === '--plan-json') { a.planJson = path.resolve(ROOT, v); i++; }
    else if (k === '--selector') { a.selector = v; i++; }
    else if (k === '--ready') { a.ready = v; i++; }
    else if (k === '--quiet') { a.quiet = true; }
    else throw new Error('未知参数：' + k);
  }
  return a;
}

/** 约定式加载 plan provider：必须导出 solve(session, cfg) */
function loadProvider(planPath) {
  if (!planPath) throw new Error('缺少 --plan <provider.js>：渲染器不知道时间轴从哪来（见 video/VIDEO-MODE-CONTRACT.md）');
  if (!fs.existsSync(planPath)) throw new Error('--plan 文件不存在：' + planPath);
  const mod = require(planPath);
  const solveFn = mod && (mod.solve || (typeof mod === 'function' ? mod : null));
  if (typeof solveFn !== 'function') {
    throw new Error('--plan 模块必须导出 async function solve(session, cfg)：' + planPath);
  }
  return solveFn;
}

/** 校验 provider 返回值：必填字段 + 长度一致性，**报实际值 vs 期望值后 exit 1**，不静默纠正 */
function validatePlan(plan, a) {
  const bad = m => { throw new Error(m); };
  if (!plan || typeof plan !== 'object') bad('plan provider 没有返回对象');
  const round = x => Math.round(x);
  const fps = Number(plan.fps), duration = Number(plan.duration), totalFrames = Number(plan.totalFrames);
  if (!isFinite(fps) || fps <= 0) bad('plan.fps 必须是正数，实际 = ' + JSON.stringify(plan.fps));
  if (!isFinite(duration) || duration <= 0) bad('plan.duration 必须是正数，实际 = ' + JSON.stringify(plan.duration));
  if (!isFinite(totalFrames)) bad('plan.totalFrames 必须是数字，实际 = ' + JSON.stringify(plan.totalFrames));
  const expectFrames = round(fps * duration);
  if (totalFrames !== expectFrames) {
    bad('plan.totalFrames 与 round(fps*duration) 不一致：实际 totalFrames = ' + totalFrames +
        '，期望 = ' + expectFrames + '（fps=' + fps + ' × duration=' + duration + '）');
  }
  if (totalFrames !== round(a.duration * fps)) {
    bad('plan.totalFrames 与命令行 --duration 不一致：实际 totalFrames = ' + totalFrames +
        '，期望 = ' + round(a.duration * fps) + '（--duration ' + a.duration + ' × fps ' + fps +
        '；页面 ?duration= 必须与 provider 的 duration 相同）');
  }
  if (!Array.isArray(plan.actions)) bad('plan.actions 必填且必须是数组，实际 = ' + JSON.stringify(plan.actions));
  if (plan.actions.length !== totalFrames) {
    bad('plan.actions.length 与 totalFrames 不一致：实际长度 = ' + plan.actions.length +
        '，期望长度 = ' + totalFrames + '（actions[k] = 推进到第 k 帧之前要执行的动作，k 从 1 计）');
  }
  if (!Array.isArray(plan.log)) bad('plan.log 必填且必须是字符串数组，实际 = ' + JSON.stringify(plan.log));
  if (!Array.isArray(plan.shots)) bad('plan.shots 必填且必须是数组，实际 = ' + JSON.stringify(plan.shots));
  plan.shots.forEach((s, i) => {
    if (!s || typeof s !== 'object' || s.index === undefined) {
      bad('plan.shots[' + i + '] 必须含 index 字段，实际 = ' + JSON.stringify(s));
    }
  });
  return { fps, duration, totalFrames };
}

const frameName = n => 'frame_' + String(n).padStart(5, '0') + '.png';

async function main() {
  const a = parseArgs(process.argv);
  const solve = loadProvider(a.plan);
  const pageUrl = a.url + (a.url.indexOf('?') < 0 ? '?' : '&') + 'video=1&duration=' + a.duration + '&fps=' + a.fps;
  console.log('[frames] 页面 ' + pageUrl);
  console.log('[frames] plan ' + path.relative(ROOT, a.plan) + '   视口 ' + a.width + '×' + a.height +
              '  dpr=1  抓图方式=' + a.capture);

  const session = await launchSession({
    url: pageUrl, width: a.width, height: a.height,
    readyExpr: a.ready,
    timeoutMs: 45000
  });

  try {
    /* ---- 1) 页面自证：分辨率 / 帧率 / 绘制缓冲必须和我们要的一模一样 ---- */
    const info = await session.evaluate(`(() => {
      const V = window.__video, c = document.querySelector(${JSON.stringify(a.selector)});
      const rect = c ? c.getBoundingClientRect() : null;
      return { active: V.active, fps: V.fps, w: V.width, h: V.height, duration: V.duration,
               totalFrames: V.totalFrames, hasCanvas: !!c,
               canvasBuf: c ? c.width + 'x' + c.height : '(无 canvas，走整屏抓图)',
               canvasRect: rect ? [rect.left, rect.top, rect.width, rect.height] : [0, 0, a.width, a.height],
               dpr: window.devicePixelRatio,
               viewport: window.innerWidth + 'x' + window.innerHeight };
    })()`);
    console.log('[frames] 页面自证 ' + JSON.stringify(info));
    const problems = [];
    if (!info.active) problems.push('window.__video.active 不为 true');
    if (info.fps !== a.fps) problems.push('fps=' + info.fps + ' ≠ ' + a.fps);
    if (info.hasCanvas && info.canvasBuf !== a.width + 'x' + a.height) {
      problems.push('绘制缓冲 ' + info.canvasBuf + ' ≠ ' + a.width + 'x' + a.height);
    }
    if (info.canvasRect.join(',') !== [0, 0, a.width, a.height].join(',')) {
      problems.push('绘制区域不是 (0,0,' + a.width + ',' + a.height + ')：' + info.canvasRect.join(','));
    }
    if (info.dpr !== 1) problems.push('devicePixelRatio=' + info.dpr + ' ≠ 1');
    if (info.totalFrames !== Math.round(a.duration * a.fps)) {
      problems.push('totalFrames=' + info.totalFrames + ' ≠ ' + Math.round(a.duration * a.fps));
    }
    if (problems.length) throw new Error('页面未满足视频渲染前置条件：\n  - ' + problems.join('\n  - '));

    /* ---- 2) 求解时间轴（provider 自己决定怎么算，纯计算不渲染） ---- */
    const t0 = Date.now();
    const plan = await solve(session, { fps: a.fps, duration: a.duration, width: a.width, height: a.height });
    const chk = validatePlan(plan, a);
    if (chk.fps !== a.fps) throw new Error('plan.fps 与 --fps 不一致：实际 = ' + chk.fps + '，期望 = ' + a.fps);
    console.log('[frames] 求解耗时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
    plan.log.forEach(l => console.log('[frames]   ' + l));
    if (a.planJson) {
      fs.mkdirSync(path.dirname(a.planJson), { recursive: true });
      const dump = Object.assign({}, plan);
      delete dump.actions;   // 逐帧动作表太长，不进存档；shots/log 足够复核里程碑
      fs.writeFileSync(a.planJson, JSON.stringify(Object.assign(dump, {
        fps: chk.fps, totalFrames: chk.totalFrames, duration: chk.duration, url: pageUrl
      }), null, 2));
      console.log('[frames] 时间轴已存盘 ' + path.relative(ROOT, a.planJson));
    }

    const TOTAL = chk.totalFrames;
    const last = a.limit > 0 ? Math.min(a.limit, TOTAL) : TOTAL;
    if (a.limit > 0) console.log('[frames] ⚠ --limit ' + a.limit + '：只导出前 ' + last + ' 帧（冒烟用，产物不完整）');

    /* ---- 3) 逐帧渲染 + 抓图 ---- */
    fs.mkdirSync(a.outDir, { recursive: true });
    /* 清掉上一批同名帧的残留（--limit 冒烟后如果不清理，合成时会混进旧帧） */
    for (const f of fs.readdirSync(a.outDir)) {
      if (/^frame_\d{5}\.png$/.test(f)) fs.unlinkSync(path.join(a.outDir, f));
    }

    const clip = { x: 0, y: 0, width: a.width, height: a.height };
    const actions = plan.actions;
    const tStart = Date.now();
    let lastReport = 0;

    /* 第 0 帧 = reset 后的初始态 */
    await session.evaluate('window.__video.reset()');
    await session.evaluateAwait('window.__video.commit()');
    await captureFrame(session, a, clip, 0);

    for (let k = 1; k < last; k++) {
      const act = actions[k];
      let pre = '';
      if (act && act.drag) pre = 'window.__video.setDrag(' + act.drag[0] + ',' + act.drag[1] + ');';
      else if (act && act.release) pre = 'window.__video.release();';
      const idx = await session.evaluateAwait(
        '(async () => { ' + pre + ' window.__video.stepFrame(); await window.__video.commit(); ' +
        'return window.__video.frameIndex; })()');
      if (idx !== k) throw new Error('帧号漂移：期望第 ' + k + ' 帧，页面报 ' + idx);
      await captureFrame(session, a, clip, k);

      if (!a.quiet && (k - lastReport >= 60 || k === last - 1)) {
        lastReport = k;
        const el = (Date.now() - tStart) / 1000;
        const eta = el / k * (last - 1 - k);
        console.log('[frames] ' + k + '/' + (last - 1) + '  已用 ' + el.toFixed(1) + 's  ' +
                    'ETA ' + eta.toFixed(0) + 's  ' + (k / el).toFixed(1) + ' 帧/s');
      }
    }

    /* ---- 4) 产物自证 ---- */
    const files = fs.readdirSync(a.outDir).filter(f => /^frame_\d{5}\.png$/.test(f)).sort();
    const bytes = files.reduce((s, f) => s + fs.statSync(path.join(a.outDir, f)).size, 0);
    const sample = readPngSize(path.join(a.outDir, files[0]));
    const sample2 = readPngSize(path.join(a.outDir, files[files.length - 1]));
    console.log('[frames] ✔ ' + files.length + ' 帧 → ' + path.relative(ROOT, a.outDir) +
                '  ' + (bytes / 1048576).toFixed(1) + ' MB  ' +
                '首帧 ' + files[0] + ' (' + sample + ')  末帧 ' + files[files.length - 1] + ' (' + sample2 + ')');
    if (a.limit === 0) {
      if (files.length !== TOTAL) throw new Error('导出帧数 ' + files.length + ' ≠ 应有 ' + TOTAL);
      if (files[0] !== frameName(0) || files[files.length - 1] !== frameName(TOTAL - 1)) {
        throw new Error('序列帧命名不连续：' + files[0] + ' … ' + files[files.length - 1]);
      }
      console.log('[frames] 预期视频时长 = ' + (TOTAL / chk.fps).toFixed(3) + 's（' + TOTAL + ' 帧 / ' + chk.fps + 'fps）');
    }
    console.log('[frames] 里程碑 ' + JSON.stringify(
      plan.shots.map(s => String(s.index) + ': ' + JSON.stringify(s.label ?? s.action ?? null))));
  } finally {
    await session.close();
  }
}

async function captureFrame(session, a, clip, k) {
  const file = path.join(a.outDir, frameName(k));
  if (a.capture === 'inline') {
    const dataUrl = await session.evaluate('window.__video.captureFrame()');
    const b64 = String(dataUrl).split(',')[1];
    fs.writeFileSync(file, Buffer.from(b64, 'base64'));
  } else {
    const buf = await session.screenshot(clip);
    fs.writeFileSync(file, buf);
  }
}

/** 读 PNG 的 IHDR 拿宽高（只读 24 字节，不做解码） */
function readPngSize(file) {
  const fd = fs.openSync(file, 'r');
  const b = Buffer.alloc(24);
  fs.readSync(fd, b, 0, 24, 0);
  fs.closeSync(fd);
  return b.readUInt32BE(16) + 'x' + b.readUInt32BE(20);
}

if (require.main === module) {
  main().catch(e => { console.error('[frames] ✘ ' + (e && e.stack || e)); process.exit(1); });
}
module.exports = { readPngSize, validatePlan, loadProvider };
