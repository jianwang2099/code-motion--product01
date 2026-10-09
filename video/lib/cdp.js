'use strict';
/**
 * 极简 CDP 客户端 + 无头浏览器会话（**零第三方依赖**，只用 Node 18+ 自带的 fetch / WebSocket）
 * ---------------------------------------------------------------------------
 * 做法（沿用一套经过验证的成熟写法，不装 puppeteer）：
 *   - `spawn` 起一个无头 Chromium 内核浏览器，自带 `--remote-debugging-port`；
 *   - 用 Node 自带的 `WebSocket` 直接讲 CDP；
 *   - 无头浏览器的 `--window-size` 会被裁，必须再用 `Emulation.setDeviceMetricsOverride`
 *     把视口钉死成我们要的尺寸（实测：要 1200×760 实际只有 1192×629）。
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** 候选浏览器二进制（macOS 常见位置）；都找不到就用 EDGE_BIN 手工指定 */
const BROWSER_CANDIDATES = [
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium'
];

function resolveBrowserBin() {
  if (process.env.EDGE_BIN) return process.env.EDGE_BIN;
  for (const b of BROWSER_CANDIDATES) {
    try { fs.accessSync(b, fs.constants.X_OK); return b; } catch (e) { /* 试下一个 */ }
  }
  throw new Error('找不到可用的 Chromium 内核浏览器；请用 EDGE_BIN 指定可执行文件路径');
}

function cdpConnect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let seq = 0;
    const pending = new Map();
    const api = {
      send(method, params = {}) {
        return new Promise((res, rej) => {
          const id = ++seq;
          pending.set(id, { res, rej });
          ws.send(JSON.stringify({ id, method, params }));
        });
      },
      close() { try { ws.close(); } catch (e) { /* ignore */ } }
    };
    ws.addEventListener('open', () => resolve(api));
    ws.addEventListener('error', () => reject(new Error('CDP WebSocket 连接失败：' + wsUrl)));
    ws.addEventListener('message', ev => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(msg.error.message)); else res(msg.result);
      }
    });
  });
}

/**
 * 起一个无头浏览器会话，并把视口钉死。
 * @param {{url:string,width:number,height:number,readyExpr?:string,timeoutMs?:number}} opts
 * @returns {Promise<{cdp, child, evaluate, evaluateAwait, screenshot, close}>}
 */
async function launchSession(opts) {
  const width = opts.width;
  const height = opts.height;
  const bin = resolveBrowserBin();
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-video-'));
  const port = 9700 + Math.floor(Math.random() * 250);
  const timeoutMs = opts.timeoutMs || 30000;

  const child = spawn(bin, [
    '--headless=new', '--no-sandbox', '--no-first-run', '--no-default-browser-check',
    '--disable-sync', '--disable-extensions', '--disable-component-update',
    '--hide-scrollbars', '--force-device-scale-factor=1', '--disable-lcd-text',
    '--user-data-dir=' + userDir,
    '--window-size=' + width + ',' + height,
    '--remote-debugging-port=' + port,
    opts.url
  ], { stdio: 'ignore' });

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try { child.kill('SIGKILL'); } catch (e) { /* ignore */ }
    await sleep(300);
    try { fs.rmSync(userDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  };

  try {
    let wsUrl = null;
    const t0 = Date.now();
    while (!wsUrl && Date.now() - t0 < timeoutMs) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
        const page = list.find(t => t.type === 'page' && t.url.indexOf(opts.url) === 0) ||
                     list.find(t => t.type === 'page');
        if (page && page.webSocketDebuggerUrl) wsUrl = page.webSocketDebuggerUrl;
      } catch (e) { /* 浏览器还没起来 */ }
      if (!wsUrl) await sleep(200);
    }
    if (!wsUrl) throw new Error('等不到页面 target（确认预览服务在跑、浏览器能启动）');

    const cdp = await cdpConnect(wsUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width, height, deviceScaleFactor: 1, mobile: false
    });

    const evaluate = async expression => {
      const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true });
      if (r.exceptionDetails) throw new Error('页面内求值失败：' + JSON.stringify(r.exceptionDetails));
      return r.result.value;
    };
    const evaluateAwait = async (expression, t = 600000) => {
      const r = await cdp.send('Runtime.evaluate', {
        expression, returnByValue: true, awaitPromise: true, timeout: t
      });
      if (r.exceptionDetails) throw new Error('页面内求值失败：' + JSON.stringify(r.exceptionDetails));
      return r.result.value;
    };

    if (opts.readyExpr) {
      const t1 = Date.now();
      let ok = false;
      while (Date.now() - t1 < timeoutMs) {
        try { if (await evaluate(opts.readyExpr)) { ok = true; break; } } catch (e) { /* 未就绪 */ }
        await sleep(100);
      }
      if (!ok) throw new Error('页面未在超时内就绪：' + opts.readyExpr);
    }

    /** 抓一张 PNG；clip 用 CSS 像素，scale=1 表示 1 设备像素 = 1 CSS 像素 */
    const screenshot = async clip => {
      const params = { format: 'png', fromSurface: true, captureBeyondViewport: false };
      if (clip) params.clip = { x: clip.x, y: clip.y, width: clip.width, height: clip.height, scale: 1 };
      const r = await cdp.send('Page.captureScreenshot', params);
      return Buffer.from(r.data, 'base64');
    };

    return {
      cdp, child, evaluate, evaluateAwait, screenshot,
      close
    };
  } catch (err) {
    await close();
    throw err;
  }
}

module.exports = { launchSession, cdpConnect, resolveBrowserBin, sleep, BROWSER_CANDIDATES };
