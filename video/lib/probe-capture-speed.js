#!/usr/bin/env node
'use strict';
/**
 * 抓图通路体检（**不产出交付物，只回答一个问题：N 帧要跑多久？**）
 * ---------------------------------------------------------------------------
 *   node video/lib/probe-capture-speed.js [--n 30] [--capture clip|inline]
 *                                        [--url <页面>] [--ready <表达式>]
 *                                        [--selector <CSS 选择器>] [--width W] [--height H]
 *
 * 在 W×H 视口上对**真实页面**连续抓 n 张图，打印每张平均耗时与整片外推耗时。
 * 它不修改任何东西、不写任何交付物 —— 纯粹是"大规模导出前先量一下机器的底"。
 *
 * 默认值都是中性的：只有 `--url` 指向你自己的页面、`--ready` 指向你自己页面的就绪条件，
 * 这个脚本才对你有意义。`--selector` 只用于打印绘制缓冲尺寸，**匹配不到也不会报错**。
 */

const path = require('path');
const { launchSession } = require('./cdp');

async function main() {
  const argv = process.argv.slice(2);
  const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
  const n = Number(val('--n', 30));
  const mode = val('--capture', 'clip');
  const url = val('--url', 'http://127.0.0.1:5173/index.html');
  const ready = val('--ready', '!!(window.__video && window.__video.active)');
  const selector = val('--selector', 'canvas');
  const W = Number(val('--width', 1920)), H = Number(val('--height', 1080));

  console.log('[probe] ' + url + '  视口 ' + W + '×' + H + '  抓图=' + mode + '  n=' + n);
  const s = await launchSession({ url, width: W, height: H, readyExpr: ready, timeoutMs: 30000 });
  try {
    const info = await s.evaluate(`(() => { const c = document.querySelector(${JSON.stringify(selector)});
      if (!c) return { buf: '无 canvas：' + ${JSON.stringify(selector)} + ' 未匹配', rect: 'n/a', dpr: window.devicePixelRatio,
                       vp: window.innerWidth + 'x' + window.innerHeight };
      const r = c.getBoundingClientRect();
      return { buf: c.width + 'x' + c.height, rect: [r.left, r.top, r.width, r.height].join(','), dpr: window.devicePixelRatio,
               vp: window.innerWidth + 'x' + window.innerHeight }; })()`);
    console.log('[probe] 绘制缓冲=' + info.buf + '  rect=' + info.rect + '  dpr=' + info.dpr + '  视口=' + info.vp);
    console.log('[probe] --ready 就绪条件 = ' + ready + '   --selector = ' + selector);

    const clip = { x: 0, y: 0, width: W, height: H };
    // 预热 3 张（首张往往含合成器首次上屏的固定开销，不计入均值）
    for (let i = 0; i < 3; i++) await s.screenshot(clip);

    const t0 = Date.now();
    let bytes = 0;
    for (let i = 0; i < n; i++) {
      const buf = (mode === 'inline')
        ? await s.evaluate('window.__video ? window.__video.captureFrame() : null')
        : await s.screenshot(clip);
      bytes += Buffer.isBuffer(buf) ? buf.length : (buf ? String(buf).length : 0);
    }
    const el = (Date.now() - t0) / 1000;
    console.log('[probe] ' + n + ' 张耗时 ' + el.toFixed(2) + 's → ' + (el / n * 1000).toFixed(0) + ' ms/张，' +
                '平均 ' + (bytes / n / 1024).toFixed(0) + ' KB/张');
    console.log('[probe] 外推 1800 帧：约 ' + (el / n * 1800 / 60).toFixed(1) + ' 分钟（不含物理推进与写盘）');
  } finally {
    await s.close();
  }
}

main().catch(e => { console.error('[probe] ✘ ' + (e && e.stack || e)); process.exit(1); });
