#!/usr/bin/env node
/**
 * verify/visual/visual.js · 视觉回归的统一入口（抓图 / 比对 / 出差异图 / 出人可读结论）
 * ---------------------------------------------------------------------------
 * 技术选型（README「技术选择」一节同步写明）：
 *   比对引擎 = **纯 JavaScript + 自带 node:zlib**（`verify/visual/png.js`），**零第三方依赖、离线可用**；
 *   抓图引擎 = **无头 Edge + CDP**（`Emulation.setDeviceMetricsOverride` 钉视口 + `Page.setWebLifecycleState`
 *   冻结时钟后 `Page.captureScreenshot`），与 `verify/card-05|07/make-screenshots.js` 同一套手法；
 *   独立交叉核对 = **Pillow**（只在 `visual-gate.js` 里用项目外的可选解释器跑一遍，不进入本脚本的运行依赖）。
 *
 * 子命令：
 *   shoot    抓图（真实页面或自造样本）→ 写入 --out 目录
 *   compare  比对 --baseline 图库 vs --actual 抓图目录 → 差异图 + 报告
 *   all      = shoot && compare（默认 --out 用固定临时目录，除非显式指定）
 *
 * 统一命令（人只需要记这一条）：
 *   node verify/visual/visual.js all --baseline template/verify/visual/baseline --out <抓图目录>
 *
 * 输出（决定性，退出码 0 = 全部在容差内；1 = 有差异超容差 / 抓图失败；2 = 用法错误）：
 *   <out>/*.png                 抓到的图（文件名含**页面内实测视口尺寸**）
 *   <out>/diff/<name>.diff.png  差异图（不增亮的灰度底 + 红色 = 超容差像素；差异非空一定可见）
 *   <out>/visual-report.json    机读报告（每条验收的差异计数 / 比例 / 判定）
 *   stdout                      人可读结论（"与 baseline 相比超容差的像素数 = N"）
 *
 * 判定语义（口径写死，避免两处漂移）：
 *   · 逐通道比较；某像素 **任一通道** |Δ| > maxDiff 即计入 `changed`
 *     → 这正是"容差边界"定义：maxDiff=8 时 ±8 不算差异、±9 算差异；
 *   · 比例 = changed / (W*H)；超阈值即判不一致（默认 maxRatio = 0.2%，可用 --max-ratio 调；来由见 baseline/README.md）。
 *     **计数（changed）是门禁比对的那一个数**；阈值只判"这个数算不算过"。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const png = require('./png.js');

const VISUAL_DIR = __dirname;
const REPO_ROOT = path.join(VISUAL_DIR, '..', '..', '..');   // template/verify/visual → 工作区根
/* 冻结后抓图仍会强制渲染 ≤2 帧（每帧 dt ≤ MAX_FRAME_DT=0.05s）→ 方块最多再走 ~6 世界 px。
   PIN_SLACK 就是给这段抖动的余量；它只影响"抓图时的软复核"，不参与比对判定。 */
const PIN_SLACK = 3;
const FIXTURE_PAGE = 'file://' + path.join(VISUAL_DIR, 'cdp-page.html');
const DEFAULT_PREVIEW = process.env.PREVIEW_URL || 'http://127.0.0.1:5173/index.html';
const EDGE_BIN = process.env.EDGE_BIN || '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ==========================================================================
 * 1. 像素比对（纯函数，供 CLI 与门禁共用）
 * ========================================================================== */

/** 逐通道比较两张同尺寸 RGB 位图 → 计数 + 差异图 */
function diffImages(a, b, { maxDiff = 8 } = {}) {
  if (a.width !== b.width || a.height !== b.height) {
    return {
      sizeMismatch: true,
      widthA: a.width, heightA: a.height, widthB: b.width, heightB: b.height,
      width: 0, height: 0, changed: 0, ratio: 0, maxAbs: 0, diff: null
    };
  }
  const { width, height } = a;
  const diff = Buffer.alloc(width * height * 3);
  let changed = 0, maxAbs = 0, sumAbs = 0;
  for (let i = 0, p = 0; i < width * height; i++, p += 3) {
    const dr = Math.abs(a.rgb[p] - b.rgb[p]);
    const dg = Math.abs(a.rgb[p + 1] - b.rgb[p + 1]);
    const db = Math.abs(a.rgb[p + 2] - b.rgb[p + 2]);
    const m = Math.max(dr, dg, db);
    if (m > maxAbs) maxAbs = m;
    sumAbs += m;
    if (m > maxDiff) {
      changed++;
      diff[p] = 255; diff[p + 1] = 0; diff[p + 2] = 0;          // 红 = 超容差
    } else {
      /* 容差内的差异压成暗灰（视觉上几乎不可见），但保持**逐点**可辨：
         这样"差异图非空"这件事只可能由超容差像素造成 → 断言不会被噪声污染 */
      const g = 32 + Math.round(m * 9);
      diff[p] = g; diff[p + 1] = g; diff[p + 2] = g;
    }
  }
  return {
    sizeMismatch: false, width, height, changed,
    ratio: changed / (width * height), maxAbs, meanAbs: sumAbs / (width * height), diff
  };
}

/** 一次比对 + 判定（口径唯一入口） */
function judge(a, b, opts = {}) {
  const maxDiff = opts.maxDiff === undefined ? 8 : Number(opts.maxDiff);
  /* 默认阈值 0.2% 的来由（实测，见 template/verify/visual/baseline/README.md「噪声包络」一节）：
     真实页面重跑 6 次的噪声包络 = 0 ~ 0.057%（差异包围盒 = 方块/球本体），
     而"方块被挪离中轴"这种真回归实测 0.68%（1200×760）/ 1.82%（375×600）→ 0.2% 落在两者中间（约 3.5× 噪声余量）。 */
  const maxRatio = opts.maxRatio === undefined ? 0.002 : Number(opts.maxRatio);
  const d = diffImages(a, b, { maxDiff });
  if (d.sizeMismatch) {
    return {
      ...d, maxDiff, maxRatio, pass: false,
      verdict: `✗ 尺寸不一致：baseline ${d.widthA}×${d.heightA} vs 实测 ${d.widthB}×${d.heightB}` +
        `（视口没钉住 / 抓图被裁 → 先查钉视口，不要调容差）`
    };
  }
  const pass = d.ratio <= maxRatio;
  const verdict = pass
    ? `✓ 一致（超容差像素 ${d.changed} 个 = 全图 ${(d.ratio * 100).toFixed(4)}%，阈值 ${(maxRatio * 100).toFixed(2)}%；最大通道差 ${d.maxAbs}）`
    : `✗ 不一致（超容差像素 ${d.changed} 个 = 全图 ${(d.ratio * 100).toFixed(4)}%，阈值 ${(maxRatio * 100).toFixed(2)}%；最大通道差 ${d.maxAbs}）`;
  return { ...d, maxDiff, maxRatio, pass, verdict };
}

/* ==========================================================================
 * 2. 无头 Edge + CDP 抓图
 * ========================================================================== */
function cdpConnect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let seq = 0; const pending = new Map();
    const api = {
      send(method, params = {}) {
        return new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
      },
      close() { try { ws.close(); } catch (e) { /* ignore */ } }
    };
    ws.addEventListener('open', () => resolve(api));
    ws.addEventListener('error', () => reject(new Error('CDP WebSocket 连接失败：' + wsUrl)));
    ws.addEventListener('message', ev => {
      let msg; try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id); pending.delete(msg.id);
        if (msg.error) rej(new Error(msg.error.message)); else res(msg.result);
      }
    });
  });
}
async function evaluate(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true });
  if (r.exceptionDetails) throw new Error('页面内求值失败：' + JSON.stringify(r.exceptionDetails));
  return r.result.value;
}
async function evaluateAwait(cdp, expression, timeoutMs = 60000) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, timeout: timeoutMs });
  if (r.exceptionDetails) throw new Error('页面内求值失败：' + JSON.stringify(r.exceptionDetails));
  return r.result.value;
}
async function waitPageReady(cdp, timeoutMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { if (await evaluate(cdp, `!!(document.querySelector('canvas') && window.__slingshotState)`)) return true; } catch (e) { /* 未就绪 */ }
    await sleep(120);
  }
  throw new Error("等不到 canvas / window.__slingshotState（真实页面请确认预览服务在跑；样本请确认 file:// 可读）");
}
/** 页面内实测视口 + 画布 + 相位读数（就是 README 里要标的"页面内实测值"） */
const probe = cdp => evaluate(cdp, `(() => {
  const cv = document.querySelector('canvas'), s = window.__slingshotState;
  const sq = s.square || {};
  return { viewport: window.innerWidth + 'x' + window.innerHeight,
    canvasCss: cv.clientWidth + 'x' + cv.clientHeight, canvasBuf: cv.width + 'x' + cv.height,
    dpr: window.devicePixelRatio, phase: s.phase,
    ready: (typeof s.atReady === 'boolean') ? s.atReady : (typeof s.atPouch === 'boolean' ? s.atPouch : null),
    square: { x: sq.x, y: sq.y, dir: sq.dir, state: sq.state },
    inViewport: cv.clientWidth === window.innerWidth && cv.clientHeight === window.innerHeight };
})()`);

/** 真实页面（index.html）的相位等待器 —— 与 verify/card-07 同源的轮询写法 */
const waiters = {
  /** 方块扫到中轴附近（把"移动中"那一帧钉在方块居中，抓图才是确定的） */
  squareNearCenter: (cdp, tol) => evaluateAwait(cdp, `new Promise(res => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      const s = window.__slingshotState, sq = s.square;
      if (!sq || sq.state !== 'moving') { clearInterval(iv); res(null); }
      else if (Math.abs(sq.x) <= ${tol}) { clearInterval(iv); res({ x: +sq.x.toFixed(2), y: +sq.y.toFixed(2), dir: sq.dir }); }
      else if (Date.now() - t0 > 60000) { clearInterval(iv); res(null); }
    }, 2);
  })`),
  /** 命中 → 爆炸结束（碎片全部离场、方块不再出现）*/
  explosionOver: cdp => evaluateAwait(cdp, `new Promise(res => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      const s = window.__slingshotState;
      if (s.square.state === 'destroyed' && !s.explosion.active && s.explosion.visible === 0) {
        clearInterval(iv); res({ state: s.square.state, visible: s.explosion.visible, t: +s.explosion.t.toFixed(4) });
      } else if (Date.now() - t0 > 60000) { clearInterval(iv); res(null); }
    }, 4);
  })`)
};
/** 真实拖拽发射：屏幕方向位移（+y 向下），长度按页面里的 MAX_STRETCH 截断 */
async function dragAndRelease(cdp, sx, sy) {
  const rect = await evaluate(cdp, `(() => { const r = document.querySelector('canvas').getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; })()`);
  const a = JSON.parse(await evaluate(cdp, 'JSON.stringify(window.__slingshotState.anchor)'));
  const max = 190 * (await evaluate(cdp, 'window.__slingshotState.viewScale'));
  const d = Math.hypot(sx, sy), k = d > max ? max / d : 1;
  const dx = sx * k, dy = sy * k;
  const p0 = { x: rect.left + rect.width / 2 + a.x, y: rect.top + rect.height / 2 - a.y };
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p0.x, y: p0.y, buttons: 1, button: 'left', clickCount: 1 });
  for (let i = 1; i <= 6; i++) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p0.x + dx * i / 6, y: p0.y + dy * i / 6, buttons: 1, button: 'none', clickCount: 0 });
    await sleep(35);
  }
  await sleep(150);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p0.x + dx, y: p0.y + dy, buttons: 0, button: 'left', clickCount: 1 });
}

/** 抓一张图 = 一个独立的无头 Edge 会话 */
async function capture({ url, width, height, name, outDir, prep = null, pin = null, tol = 3, retries = 3 }) {
  let lastErr = null;
  for (let attempt = 1; attempt <= retries; attempt++) {
    const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-visual-'));
    const port = 9600 + Math.floor(Math.random() * 300);
    const child = spawn(EDGE_BIN, [
      '--headless=new', '--no-sandbox', '--no-first-run', '--no-default-browser-check',
      '--disable-sync', '--disable-extensions', '--disable-component-update',
      '--user-data-dir=' + userDir, '--window-size=' + width + ',' + height,
      '--remote-debugging-port=' + port, url
    ], { stdio: 'ignore' });
    const t0 = Date.now();
    try {
      let wsUrl = null;
      while (!wsUrl && Date.now() - t0 < 25000) {
        try {
          const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
          const page = list.find(t => t.type === 'page' && t.url.indexOf(url.split('#')[0]) === 0);
          if (page && page.webSocketDebuggerUrl) wsUrl = page.webSocketDebuggerUrl;
        } catch (e) { /* 浏览器还没起来 */ }
        if (!wsUrl) await sleep(250);
      }
      if (!wsUrl) throw new Error('等不到页面 target（确认预览服务在跑 / Edge 能启动）');
      const cdp = await cdpConnect(wsUrl);
      await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
      /* 无头 Edge 的 --window-size 会被裁（实测 1200×760 → 1192×629；375 → 492），
         必须用设备度量覆盖把视口钉死成我们要的尺寸 */
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      await waitPageReady(cdp);
      /* 等画面稳定（相位 / 尺寸不再变化） */
      let last = '', stable = 0;
      for (let i = 0; i < 40 && stable < 3; i++) {
        const s = JSON.stringify(await probe(cdp));
        if (s === last) stable++; else { stable = 0; last = s; }
        await sleep(200);
      }
      const prepInfo = prep ? await prep(cdp) : null;
      /* 钉相位：让 animate 在"方块已在目标位置"的那一帧先渲染、再由冻结接住，
         于是抓图只会再推进 ≤ 2 帧（见下方注释），相位漂移被压到最小 */
      let pinned = null;
      if (pin) pinned = await pin(cdp, tol);
      await cdp.send('Page.setWebLifecycleState', { state: 'frozen' });
      await sleep(250);
      const held = await probe(cdp);
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      const after = await probe(cdp);
      const buf = Buffer.from(shot.data, 'base64');
      const file = path.join(outDir, name);
      fs.writeFileSync(file, buf);
      /* 自己解一遍：证明"抓到的 PNG 真的能被本仓库的解码器读出来"，尺寸也对得上 */
      const decoded = png.decode(buf);
      const info = {
        name, file, bytes: buf.length, url, wanted: `${width}x${height}`,
        pngSize: `${decoded.width}x${decoded.height}`, colorType: decoded.colorType,
        filtered: decoded.filtered,
        viewport: after.viewport, canvasCss: after.canvasCss, canvasBuf: after.canvasBuf, dpr: after.dpr,
        inViewport: after.inViewport, phase: after.phase, ready: after.ready, square: after.square,
        prep: prepInfo, pinned, attempt
      };
      /* 复核（口径写死，别用"容差"当验收线，否则会把有效的图判废）：
         ① 硬条件：PNG 尺寸 = 目标尺寸、且画布满视口（视口没钉住 → 这张图直接不能用）；
         ② 软条件：方块最终落在 `tol + PIN_SLACK` 内。`PIN_SLACK=3` 的理由是**实测**——
            冻结后 CDP 抓图仍会强制渲染 ≤2 帧（animate 把单帧 dt 夹在 MAX_FRAME_DT=0.05s），
            方块最多再走 62×1×0.1 ≈ 6 世界 px；pin 已经把它压到 tol 内，再放 3px 是留这个抖动。
            超出软条件的图**不判废**（会被记进 pinned/after 供 README 引用），
            真正的噪声包络由"重跑实测"给出（见 baseline/README.md）。 */
      const okSize = decoded.width === width && decoded.height === height && after.inViewport === true;
      info.pinOk = !pin || (pinned && Math.abs(after.square.x) <= tol + PIN_SLACK);
      if (okSize) { cdp.close(); return info; }
      lastErr = new Error(`第 ${attempt} 次复核未达标：PNG=${decoded.width}×${decoded.height} 实测视口=${after.viewport} inViewport=${after.inViewport}（视口/尺寸对不上，这张图不能用）`);
      cdp.close();
    } catch (e) {
      lastErr = e;
    } finally {
      child.kill('SIGKILL');
      await sleep(350);
      try { fs.rmSync(userDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    }
    if (attempt < retries) await sleep(400);
  }
  throw lastErr || new Error('抓图失败');
}

/* ==========================================================================
 * 3. 图库清单（一套定义，抓图与比对共用）
 * ========================================================================== */
/**
 * 每张图声明：
 *   name   文件名（含 `实测<页面内实测视口>` —— 命名纪律，见 verify/README.md）
 *   size   目标视口（会被 CDP 钉死；抓完用页面内实测值复核）
 *   page   'real' = 真实交付物 index.html（需预览服务） | 'fixture' = 自造样本
 *   prep   进入目标状态的动作；pin  抓图前的钉相位钩子
 *   tol    钉相位容差（px）
 *   checks 这张图对应哪几条验收（写进 baseline/README.md 的映射表）
 */
/* 钉相位容差 `tol` 的取法（2026-10-09 实测教训）：噪声**全部**来自"方块没落在同一个像素上"，
   而窄窗 viewScale≈0.6 → 1 设备 px ≈ 1.67 世界 px。容差给到 ±8 世界 px 时，方块整体平移 1~2 设备 px，
   就吃掉 0.112% 的全图差异（阈值只有 0.2% → 余量 1.8×，太薄）。
   → 真实页面的三张统一收到 **±4 世界 px**（≈2.4 设备 px），把噪声压到包络可忽略的量级。 */
const REAL_TOL = 4;
const SHOTS = [
  {
    name: 'ready-square-center-1200x760.png', size: [1200, 760], page: 'real', tol: REAL_TOL,
    prep: null,
    pin: cdp => waiters.squareNearCenter(cdp, REAL_TOL),
    checks: ['真实页面默认态（球在弹兜、phase=ready）', '方块往复到中轴附近', '宽视口布局与等比缩放']
  },
  {
    name: 'ready-square-center-375x600.png', size: [375, 600], page: 'real', tol: REAL_TOL,
    prep: null,
    pin: cdp => waiters.squareNearCenter(cdp, REAL_TOL),
    checks: ['窄视口 375×600（viewScale 变小）', '小窗里球/支架/方块等比缩小', '窄窗边界处方块往复']
  },
  {
    name: 'destroyed-after-explosion-1200x760.png', size: [1200, 760], page: 'real', tol: REAL_TOL,
    prep: async cdp => {
      const r = await waiters.squareNearCenter(cdp, REAL_TOL);
      if (!r) throw new Error('等不到方块扫到中轴附近');
      await dragAndRelease(cdp, 0, 1000);            // 屏幕正下方 = 世界竖直向上发射
      const e = await waiters.explosionOver(cdp);
      if (!e) throw new Error('等不到爆炸结束');
      return e;
    },
    pin: null,
    checks: ['命中后爆炸结束：碎片全部离场、方块保持消失', '球在能量耗尽后的闪烁态（形状/位置）']
  },
  {
    name: 'fixture-square-center-800x600.png', size: [800, 600], page: 'fixture', tol: 6,
    prep: null,
    pin: cdp => waiters.squareNearCenter(cdp, 6),
    checks: ['【自造样本】视觉门禁的链路自检图，不属于真实页面验收']
  }
];

const byName = n => SHOTS.filter(s => s.name === n);
const pageUrl = s => (s.page === 'fixture' ? FIXTURE_PAGE : DEFAULT_PREVIEW);

/** 解析出要抓的图：默认抓 real 的；--include-fixture 时连样本一起抓。
 *  `--tol N` 覆盖钉相位容差（建图库时用它把容差一致地钉住，命令可完整复现）。 */
function selectShots(opts) {
  const tol = opts.tol === undefined ? null : Number(opts.tol);
  const withTol = s => ({ ...s, tol, pin: s.pin ? cdp => waiters.squareNearCenter(cdp, tol) : null });
  let list = SHOTS;
  if (opts.only && opts.only.length) {
    list = list.filter(s => opts.only.some(o => s.name.includes(o)));
  } else if (!opts.includeFixture) {
    list = list.filter(s => s.page === 'real');
  }
  /* --tol 只对真实页面生效：自造样本页没有"方块往复相位"这件事，容差对它无意义 */
  return tol === null ? list : list.map(s => (s.page === 'real' ? withTol(s) : s));
}

/* ==========================================================================
 * 4. 命令行
 * ========================================================================== */
function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2), next = argv[i + 1];
      if (k === 'include-fixture' || k === 'json' || k === 'verbose' || k === 'help' || k === 'list') o[k] = true;
      else if (next === undefined || next.startsWith('--')) { o[k] = true; }
      else if (k === 'only') { (o.only = o.only || []).push(next); i++; }
      else { o[k] = next; i++; }
    } else o._.push(a);
  }
  return o;
}
const USAGE = `用法：
  node verify/visual/visual.js shoot   [--out DIR] [--only 片段] [--include-fixture] [--json]
  node verify/visual/visual.js compare --baseline DIR [--actual DIR] [--max-diff N] [--max-ratio R] [--json]
  node verify/visual/visual.js all     --baseline DIR [--out DIR] [--max-diff N] [--max-ratio R] [--json]
  node verify/visual/visual.js list

  --baseline  图库目录（默认 template/verify/visual/baseline）
  --out       抓图输出目录（默认 <os.tmpdir()>/dsh-visual-shots）
  --actual    比对用的"实测图目录"（默认与 --out 相同）
  --max-diff  逐通道容差（默认 8；边界语义：±8 不算差异、±9 算差异）
  --max-ratio 超容差像素占比阈值（默认 0.002 = 0.2%；见 baseline/README.md 噪声包络）
  --only      只抓名字含该片段的图（可给多个）
  --tol N     覆盖钉相位容差（默认 4 世界 px；建图库时用它把容差一致钉住，命令可完整复现）
  --include-fixture 连自造样本一起抓（默认只抓真实页面）
`;

async function cmdShoot(o) {
  const outDir = o.out || path.join(os.tmpdir(), 'dsh-visual-shots');
  fs.mkdirSync(outDir, { recursive: true });
  const list = selectShots(o);
  if (!list.length) throw new Error('没有匹配的图（用 list 子命令看清单）');
  console.log(`抓图：${list.length} 张 → ${outDir}`);
  console.log(`（真实页面 ${DEFAULT_PREVIEW}；样本 ${FIXTURE_PAGE}）`);
  const shots = [];
  for (const s of list) {
    const info = await capture({ url: pageUrl(s), width: s.size[0], height: s.size[1], name: s.name, outDir, prep: s.prep, pin: s.pin, tol: s.tol });
    console.log(`  ✔ ${info.name}  ${(info.bytes / 1024).toFixed(1)} KB  PNG=${info.pngSize}（颜色类型 ${info.colorType}）`);
    console.log(`     页面内实测视口=${info.viewport}  canvas CSS=${info.canvasCss}  绘制缓冲=${info.canvasBuf}  dpr=${info.dpr}  phase=${info.phase} ready=${info.ready}`);
    console.log(`     方块 x=${info.square.x}（钉相位容差 ±${s.tol}）${info.prep ? `  前置动作=${JSON.stringify(info.prep)}` : ''}`);
    if (info.pngSize !== info.wanted) throw new Error(`${info.name}：PNG 尺寸 ${info.pngSize} ≠ 目标 ${info.wanted}`);
    shots.push(info);
  }
  fs.writeFileSync(path.join(outDir, 'shots.json'), JSON.stringify({ url: DEFAULT_PREVIEW, fixture: FIXTURE_PAGE, shots }, null, 2));
  console.log(`\n共 ${shots.length} 张写入 ${outDir}（清单 shots.json 同步写入）`);
  return shots;
}

async function cmdCompare(o) {
  const baseline = o.baseline || path.join(VISUAL_DIR, 'baseline');
  const actual = o.actual || o.out || path.join(os.tmpdir(), 'dsh-visual-shots');
  const maxDiff = o['max-diff'] === undefined ? 8 : Number(o['max-diff']);
  const maxRatio = o['max-ratio'] === undefined ? 0.002 : Number(o['max-ratio']);
  if (!fs.existsSync(baseline)) throw new Error(`图库目录不存在：${baseline}`);
  if (!fs.existsSync(actual)) throw new Error(`实测图目录不存在：${actual}（先跑 shoot）`);
  const diffDir = path.join(actual, 'diff');
  fs.mkdirSync(diffDir, { recursive: true });
  const names = fs.readdirSync(baseline).filter(f => f.endsWith('.png')).sort();
  const results = [];
  console.log(`比对：图库 ${baseline}\n   vs 实测 ${actual}`);
  console.log(`   容差 maxDiff=${maxDiff}（|Δ|≤${maxDiff} 不算差异）  阈值 maxRatio=${(maxRatio * 100).toFixed(2)}%\n`);
  for (const name of names) {
    const bFile = path.join(baseline, name), aFile = path.join(actual, name);
    if (!fs.existsSync(aFile)) {
      results.push({ name, status: 'MISSING', pass: false, changed: null, verdict: `✗ 缺图：${aFile} 不存在（这一条没抓 → 等于没验）` });
      continue;
    }
    const a = png.decode(fs.readFileSync(bFile));
    const b = png.decode(fs.readFileSync(aFile));
    const r = judge(a, b, { maxDiff, maxRatio });
    if (!r.sizeMismatch) {
      const diffFile = path.join(diffDir, name.replace(/\.png$/, '.diff.png'));
      fs.writeFileSync(diffFile, png.encode({ width: r.width, height: r.height, rgb: r.diff }));
      r.diffFile = diffFile;
      r.diffBytes = fs.statSync(diffFile).size;
    }
    r.name = name;
    r.baselineSize = `${a.width}x${a.height}`;
    r.actualSize = `${b.width}x${b.height}`;
    r.status = r.pass ? 'PASS' : 'FAIL';
    r.shots = byName(name).map(s => ({ checks: s.checks, page: s.page, size: s.size }));
    results.push(r);
  }
  const failed = results.filter(r => !r.pass);
  console.log('结论（"人只看差异报告"的那张报告）：\n');
  for (const r of results) {
    console.log(`  [${r.status}] ${r.name}  baseline ${r.baselineSize} vs 实测 ${r.actualSize}`);
    console.log(`         ${r.verdict}`);
    if (r.diffFile) console.log(`         差异图：${path.relative(REPO_ROOT, r.diffFile)}${r.changed === 0 ? '（差异计数 0 → 全灰底，无红点）' : `（红色 ${r.changed} 个）`}`);
  }
  const report = { maxDiff, maxRatio, baseline, actual, total: results.length, failed: failed.length, results };
  const reportFile = path.join(actual, 'visual-report.json');
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
  console.log(`\n报告：${path.relative(REPO_ROOT, reportFile)}  （机读；人看上面这几行 + 差异图即可）`);
  console.log(`汇总：${results.length - failed.length} 通过 / ${failed.length} 不一致`);
  if (o.json) console.log(JSON.stringify(report));
  return report;
}

async function cmdAll(o) {
  const out = o.out || path.join(os.tmpdir(), 'dsh-visual-shots');
  o.out = out;
  await cmdShoot(o);
  console.log('');
  return cmdCompare({ ...o, actual: out });
}

if (require.main === module) (async () => {
  const argv = process.argv.slice(2);
  const o = parseArgs(argv);
  const cmd = o._[0] || 'help';
  if (cmd === 'help' || o.help) { console.log(USAGE); process.exit(0); }
  if (cmd === 'list') {
    SHOTS.forEach(s => console.log(`${s.name}  ${s.size[0]}x${s.size[1]}  page=${s.page}  → ${s.checks.join(' / ')}`));
    process.exit(0);
  }
  try {
    if (cmd === 'shoot') { await cmdShoot(o); process.exit(0); }
    if (cmd === 'compare') { const r = await cmdCompare(o); process.exit(r.failed ? 1 : 0); }
    if (cmd === 'all') { const r = await cmdAll(o); process.exit(r.failed ? 1 : 0); }
    console.error(USAGE); process.exit(2);
  } catch (e) {
    console.error('失败：' + (e && e.message));
    process.exit(1);
  }
})();

module.exports = { diffImages, judge, SHOTS, selectShots, capture, pageUrl, DEFAULT_PREVIEW, FIXTURE_PAGE, REPO_ROOT };
