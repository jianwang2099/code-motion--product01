#!/usr/bin/env node
/**
 * verify/run-all.js · 全量门禁汇总（骨架 + 视觉环节）
 * ---------------------------------------------------------------------------
 * 用法： node verify/run-all.js [--list] [--no-visual]
 * 做什么：一、自动发现 verify/card-* / 与 verify/tool-* / 下的门禁脚本，逐个运行，汇总通过率；
 *         二、跑**视觉环节**：确定性视觉门禁（自造样本，必须跑）→ 真实页面"截图 → 比对 baseline → 汇总"。
 *
 * 约定（与 verify/README.md 配套）：
 *   - 门禁 = 该目录里除 "截图/产出类" 脚本之外的 *.js（默认跳过名字含 screenshots / shot 的脚本）
 *   - 目录命名：`card-<NN>/` = 任务卡的证据；`tool-<NN>/` = 非卡类工作（工具/基建）的证据
 *     （**两者都要被发现**：只认 card-* 会让 tool-* 的门禁"跑了等于没跑"却仍打印通过 = 假绿）
 *   - 通过判据 = 退出码 0（脚本自己打印 "N passed, M failed" 这类摘要，本脚本只负责汇总与退出码）
 *   - 冻结脚本：若目录里存在 `FROZEN` 文件，该目录标记为「冻结 · 记录不判定」——
 *       仍会运行并打印结果，但**不计入**总失败数（历史证据已冻结，见 verify/README.md）
 *
 * 视觉环节的两条腿（口径见 verify/README.md「视觉回归」一节）：
 *   A) verify/visual/visual-gate.js     —— **确定性断言**，跑在自造样本上，不需要浏览器/预览服务；
 *                                          失败 → 计入失败数 → exit 1。
 *   B) verify/visual/visual.js all      —— 抓真实页面 → 与 baseline/ 逐像素比对（逐通道容差 maxDiff=8、超容差占比阈值 0.2%）；
 *                                          需要 ① `verify/visual/baseline/` 有图 ② 预览服务在跑；
 *                                          两者任一缺失 → 打印 ⚠ 跳过（**不判失败**，但绝不谎报"验过了"）；
 *                                          真跑起来而比对不一致 → 计入失败数 → exit 1。
 *
 * 退出码：0 = 所有非冻结门禁通过（含视觉确定性门禁与真实页面比对）；1 = 有失败
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const VERIFY = __dirname;
const VISUAL = path.join(VERIFY, 'visual');
const BASELINE = path.join(VISUAL, 'baseline');
const SKIP = /(screenshots?|shot)/i;
const PREVIEW_URL = process.env.PREVIEW_URL || 'http://127.0.0.1:5173/index.html';
const argNoVisual = process.argv.includes('--no-visual');

function gates() {
  return fs.readdirSync(VERIFY)
    .filter(d => /^(card|tool)-/.test(d) && fs.statSync(path.join(VERIFY, d)).isDirectory())
    .sort()
    .map(dir => {
      const full = path.join(VERIFY, dir);
      const files = fs.readdirSync(full).filter(f => f.endsWith('.js') && !SKIP.test(f)).sort();
      return { dir, full, files, frozen: fs.existsSync(path.join(full, 'FROZEN')) };
    })
    .filter(g => g.files.length);
}
const list = gates();
if (process.argv.includes('--list')) {
  list.forEach(g => console.log(`${g.dir}${g.frozen ? ' [FROZEN]' : ''}: ${g.files.join(', ')}`));
  console.log(`visual: ${fs.existsSync(path.join(VISUAL, 'visual-gate.js')) ? 'visual-gate.js' : '（缺失）'}` +
    ` + ${fs.existsSync(BASELINE) ? 'baseline/ 已就位' : 'baseline/ 缺失'}` +
    ` → ${fs.existsSync(path.join(VISUAL, 'visual.js')) ? 'visual.js all' : '（visual.js 缺失）'}`);
  process.exit(0);
}

let failed = 0, skipped = 0, ran = 0;
console.log(`全量门禁（工作区根：${ROOT}）\n`);

/* ---------- 一：各卡 / 各工具门禁 ---------- */
if (!list.length) {
  console.log('未发现任何门禁（verify/card-*/ 或 verify/tool-*/ 下没有 *.js）。');
} else {
  for (const g of list) {
    for (const f of g.files) {
      const rel = path.relative(ROOT, path.join(g.full, f));
      const r = spawnSync(process.execPath, [path.join(g.full, f)], { cwd: ROOT, encoding: 'utf8' });
      ran++;
      const out = `${r.stdout || ''}${r.stderr || ''}`;
      const summary = (out.match(/\d+ passed, \d+ failed/) || []).pop() || (r.status === 0 ? 'exit 0' : '无摘要输出');
      const ok = r.status === 0;
      if (!ok && !g.frozen) failed++;
      const tag = g.frozen ? '冻结·记录不判定' : (ok ? 'PASS' : 'FAIL');
      console.log(`[${tag}] ${rel}  →  ${summary}${ok ? '' : `  (exit ${r.status})`}`);
      if (!ok && g.frozen) console.log('         （冻结脚本的失败不计入总数；归因写在对应 README 里）');
    }
  }
}

/* ---------- 二：视觉环节 ---------- */
/** 预览服务可达性：只判"能不能连上"，不下载任何东西（离线优先；Node 18+ 自带 fetch） */
const reachable = url => spawnSync(process.execPath,
  ['-e', `fetch(${JSON.stringify(url)}).then(() => process.exit(0)).catch(() => process.exit(1))`],
  { timeout: 8000, encoding: 'utf8' }).status === 0;

console.log('\n—— 视觉环节 ——');
if (argNoVisual) {
  skipped += 2;
  console.log('[SKIP] 视觉环节（--no-visual）');
} else {
  /* A) 确定性视觉门禁：自造样本，无浏览器 / 无预览服务也能跑 */
  const gateFile = path.join(VISUAL, 'visual-gate.js');
  if (!fs.existsSync(gateFile)) {
    skipped++;
    console.log('[SKIP] verify/visual/visual-gate.js 不存在（模板未铺视觉环节？）');
  } else {
    const r = spawnSync(process.execPath, [gateFile], { cwd: ROOT, encoding: 'utf8' });
    ran++;
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    const summary = (out.match(/\d+ passed, \d+ failed/) || []).pop() || (r.status === 0 ? 'exit 0' : '无摘要输出');
    const ok = r.status === 0;
    if (!ok) failed++;
    console.log(`[${ok ? 'PASS' : 'FAIL'}] verify/visual/visual-gate.js  →  ${summary}${ok ? '' : `  (exit ${r.status})`}`);
    console.log('          （确定性断言：同图=0 差异 / 改 3 像素=3 / maxDiff=8 时 ±8 不算、±9 算）');
  }
  /* B) 真实页面：截图 → 与图库比对 → 汇总 */
  const visualFile = path.join(VISUAL, 'visual.js');
  if (!fs.existsSync(visualFile)) {
    skipped++;
    console.log('[SKIP] verify/visual/visual.js 不存在（跳过真实页面截图比对）');
  } else if (!fs.existsSync(BASELINE) || !fs.readdirSync(BASELINE).some(f => f.endsWith('.png'))) {
    skipped++;
    console.log(`[SKIP] 图库为空：${path.relative(ROOT, BASELINE)}/ 里没有 PNG（先跑 visual.js shoot 建库）——**没比对 ≠ 视觉通过**`);
  } else if (!reachable(PREVIEW_URL)) {
    skipped++;
    console.log(`[SKIP] 预览服务不可达：${PREVIEW_URL}（真实页面截图需要它）——**没比对 ≠ 视觉通过**`);
    console.log('         起法：python3 -m http.server 5173 --bind 127.0.0.1（受管后台作业，别重复启动）');
  } else {
    const outDir = process.env.VISUAL_OUT || path.join(os.tmpdir(), 'dsh-visual-shots');
    const r = spawnSync(process.execPath, [visualFile, 'all', '--baseline', BASELINE, '--out', outDir],
      { cwd: ROOT, encoding: 'utf8', timeout: 600000 });
    ran++;
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    const lines = out.split('\n').filter(l => /^\s*\[(PASS|FAIL|MISSING)\]|^\s*汇总：|^\s*✗/.test(l)).slice(0, 12);
    const ok = r.status === 0;
    if (!ok) failed++;
    console.log(`[${ok ? 'PASS' : 'FAIL'}] verify/visual/visual.js all（截图 → 比对 baseline）  →  ${ok ? '全部在容差内' : `有差异超容差 (exit ${r.status})`}`);
    lines.forEach(l => console.log(`         ${l.trim()}`));
    console.log(`         抓图与差异图：${outDir}（visual-report.json 在里面）`);
    if (r.error) console.log(`         ⚠ ${r.error.message}`);
  }
}

console.log(`\n汇总：跑过 ${ran} 个门禁，跳过 ${skipped} 项`);
console.log(failed ? `\n结果：${failed} 个门禁失败` : '\n结果：全部门禁通过 ✔');
process.exit(failed ? 1 : 0);
