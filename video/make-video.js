#!/usr/bin/env node
'use strict';
/**
 * 一键流水线：代码 → 帧导出 → FFmpeg 合成
 * ---------------------------------------------------------------------------
 *   node video/make-video.js --plan video/plan.example.js --duration 3
 *   node video/make-video.js --plan <provider.js> --skip-frames   # 复用已有序列帧，只重新合成
 *   node video/make-video.js --plan <provider.js> --skip-compose  # 只导出帧，不合成
 *   node video/make-video.js --plan <provider.js> --limit 90      # 冒烟：只跑前 90 帧（跳过合成）
 *
 * 参数 `--plan` / `--url` / `--plan-json` / `--fps` / `--duration` / `--frames` / `--out` / `--limit`
 * **原样转发**给 render-frames.js / compose.js；**不认识的参数直接报错退出**（不静默忽略）。
 * 路径基准与 render-frames.js 一致：相对路径按 `ROOT = 脚本所在目录的上一级` 解析。
 */

const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const has = f => argv.indexOf(f) >= 0;
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };

/** 已知参数（带值的写在 WITH_VALUE 里，开关写在 FLAGS 里）——其余一律报错 */
const WITH_VALUE = ['--plan', '--url', '--plan-json', '--fps', '--duration', '--frames', '--out',
                    '--limit', '--capture', '--selector', '--ready', '--width', '--height',
                    '--crf', '--preset'];
const FLAGS = ['--skip-frames', '--skip-compose', '--quiet'];

function checkArgs() {
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (WITH_VALUE.indexOf(k) >= 0) {
      if (i + 1 >= argv.length) throw new Error('参数 ' + k + ' 缺少取值');
      i++;
    } else if (FLAGS.indexOf(k) < 0) {
      throw new Error('未知参数：' + k + '（已知：' + WITH_VALUE.concat(FLAGS).join(' ') + '）');
    }
  }
}

const plan = val('--plan', path.join(ROOT, 'video', 'plan.example.js'));
const duration = val('--duration', '30');
const fps = val('--fps', '60');
const url = val('--url', 'http://127.0.0.1:5173/index.html');
const planJson = val('--plan-json', path.join(ROOT, 'video', 'out', 'plan.json'));
const out = val('--out', path.join(ROOT, 'video', 'out', 'video.mp4'));
const framesDir = val('--frames', path.join(ROOT, 'video', 'frames'));
const limit = val('--limit', '0');

function run(title, args) {
  console.log('\n=== ' + title + ' ===');
  console.log('$ node ' + args.join(' '));
  const r = spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit' });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(title + ' 失败（退出码 ' + r.status + '）');
}

function main() {
  checkArgs();
  const t0 = Date.now();
  const smoke = Number(limit) > 0;

  if (!has('--skip-frames')) {
    const args = [path.join('video', 'render-frames.js'),
                  '--plan', plan, '--url', url, '--fps', fps, '--duration', String(duration),
                  '--out', framesDir, '--plan-json', planJson];
    for (const f of ['--capture', '--selector', '--ready', '--width', '--height']) {
      if (has(f)) args.push(f, val(f));
    }
    if (smoke) args.push('--limit', String(limit));
    run('① 逐帧导出（页面 → PNG 序列帧）', args);
  } else {
    console.log('\n=== ① 逐帧导出：--skip-frames，复用 ' + path.relative(ROOT, framesDir) + ' ===');
  }

  if (smoke) {
    console.log('\n=== ② FFmpeg 合成：--limit 冒烟模式，跳过 ===');
    console.log('（要看效果请去掉 --limit，跑满 ' + duration + ' 秒）');
  } else if (!has('--skip-compose')) {
    const cargs = [path.join('video', 'compose.js'), '--frames', framesDir, '--out', out, '--fps', fps];
    for (const f of ['--crf', '--preset']) if (has(f)) cargs.push(f, val(f));
    run('② FFmpeg 合成（序列帧 → MP4）', cargs);
  } else {
    console.log('\n=== ② FFmpeg 合成：--skip-compose，跳过 ===');
  }

  console.log('\n总耗时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
  if (!smoke && !has('--skip-compose')) console.log('成片：' + path.resolve(ROOT, out));
}

try { main(); } catch (e) { console.error('\n✘ ' + (e && e.message || e)); process.exit(1); }
