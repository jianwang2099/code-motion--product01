#!/usr/bin/env node
/**
 * verify/tool-01/clean-check.js · 协议文档「抽取清洗」门禁（纯文本断言，无浏览器）
 * ---------------------------------------------------------------------------
 * 用法：  node verify/tool-01/clean-check.js        （工作区根目录下运行；脚本内部用绝对路径）
 * 做什么：对 template/storyboard/ 下五份协议文档做全量扫描 + 结构断言。
 *
 * 判据（与 verify/tool-01/README.md 的「清洗规则」一一对应）：
 *   J1 专有名词零命中   —— 项目特有名/模块名/交付物名/第三方库名
 *   J2 编号与指纹零命中 —— 卡编号、md5、行数、tag 名、指向本项目的证据路径
 *   J3 结构完整 + 链接自洽 —— 必备段落仍在；所有 markdown 相对链接解析后必须存在
 *   J4 教训匿名化保留   —— 不许整段删；必须留下"曾有一个项目 / 某卡"这类通用表述
 *   J5 模板声明         —— 每份文档开头有"本文件是模板 + 项目特定段落用 <尖括号> 标注"
 *
 * 退出码：0 = 全部断言通过；1 = 有失败
 *
 * 实现说明（重要，别误会成"门禁给自己开后门"）：
 *   - 本脚本是唯一被扫描器显式跳过的文件（SELF）：它自己必须写出被禁的 token 才能断言。
 *   - 除此之外 verify/tool-01/ 下**任何** .js / .md 都纳入 J1/J2 扫描，所以证据文件本身也不许带项目痕迹。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');           // template/
const SELF = path.resolve(__filename);
const SCAN_DIR = path.resolve(__dirname);                   // verify/tool-01/

/**
 * 可选参数：`--docs-dir <路径>`
 * 用途：**负向对照**——把五份文档复制到临时目录、往副本里注入一个被禁 token，
 * 再让门禁去扫那份副本。这样既能自证"门禁真的会红"，又**完全不碰版本库里的真文档**。
 * Example: node verify/tool-01/clean-check.js --docs-dir /tmp/neg/storyboard
 */
const argv = process.argv.slice(2);
const ddIdx = argv.indexOf('--docs-dir');
const DOCS_DIR = ddIdx === -1
  ? path.join(ROOT, 'storyboard')
  : path.resolve(argv[ddIdx + 1] || '');

let passed = 0;
let failed = 0;
const failures = [];

function ok(cond, name, detail) {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; failures.push(name); console.log(`  FAIL  ${name}${detail ? `  → ${detail}` : ''}`); }
}
function section(title) { console.log(`\n${title}`); }

/* ---------------------------------------------------------------- 目标文档 */

const DOCS = [
  'DIRECTOR-PROTOCOL.md',
  'WORKER-PROTOCOL.md',
  'WORKFLOW-PRINCIPLES.md',
  'CARD-REVIEWER.md',
  'task-card-template.md',
];

/* ------------------------------------------------ J1 专有名词（项目特有名） */

const FORBIDDEN_TERMS = [
  // 项目专有名词 / 模块名
  '弹弓', '橡皮筋', '小球', '手部', '轨迹',
  'blinking', 'returning',
  // 项目专有的门禁/脚本名
  'hand-harness', 'blink-harness', 'square-harness', 'slingshot',
  // 项目交付物与依赖
  'index.html', 'vendor', 'three',
];

/* ------------------------------------------------ J2 编号与指纹 */

const FORBIDDEN_PATTERNS = [
  { name: '卡编号（卡 01 / 卡 02-A / 卡 03-R …）', re: /卡\s?0\d/ },
  { name: '卡编号（card-01 / card-05 / card-07 …）', re: /card-0\d/ },
  { name: 'tag 名（v4-card04 / v5-card05 / v7-card07 …）', re: /v\d+-card\d+/ },
  { name: 'md5 指纹（32 位十六进制）', re: /[0-9a-f]{32}/ },
  { name: '本项目专有数字指纹（交付物行数 / 断言条数 / 场景计数）', re: /\b(1004|292|251)\b/ },
  { name: '指向本项目的证据路径（../verify/card-NN/）', re: /\.\.\/verify\/card-\d/ },
  { name: '本项目专有命名指纹', re: /7063f43a|ab9aa262|68411c3e|SLEEP_SPEED/ },
];

/* ------------------------------------------------ J3 必备段落（结构完整） */

const REQUIRED_SECTIONS = {
  'DIRECTOR-PROTOCOL.md': [
    '## 1. 你是谁',
    '## 1.5 下发闸门',
    '### 下发前的自检',
    '## 2. 一轮闭环',
    '## 5. 权限与沙箱',
    '## 7. 结算通知怎么读',
    '## 9. 台账',
    '### 冷启动顺序（固定）',
    '### Git 纪律',
    '## 10. 审卡',
    '## 11. 给人看的汇报格式',
  ],
  'WORKER-PROTOCOL.md': [
    '## 1. 你是谁',
    '## 2. 硬约束',
    '## 3. 工作流程',
    '## 4. 预览约定',
    '## 5. 收尾文本格式',
    '## 改动清单',
    '## 预览地址',
    '## 验证步骤',
    '## 未决问题',
    '## 6. 权限边界',
    '### 预览服务的起停',
    '## 7. 收到后续消息时',
  ],
  'WORKFLOW-PRINCIPLES.md': [
    '## 一、四大核心角色',
    '## 二、机制实测',
    '## 三、核心原理',
    '### 原理 1 ·',
    '### 原理 9 ·',
    '### 原理 10 ·',
    '### 原理 11 ·',
    '### 原理 12 ·',
    '### 原理 13 ·',
    '## 四、完整闭环与职责划分',
    '## 五、决策树',
    '## 六、协议模板的关键字段',
    '## 七、失败模式清单',
    '## 八、进阶路线',
    '## 九、一句话总纲',
  ],
  'CARD-REVIEWER.md': [
    '## 1. 你是谁',
    '## 2. 零上下文警告',
    '## 3. 审查清单',
    '### C1 · 恒真断言',
    '### C2 · 原子性',
    '### C3 · 内部一致性',
    '### C4 · 视觉决策是否留给人',
    '### C5 · 要求 vs 能力',
    '### C6 · 证据出口',
    '### C7 · 黑盒 vs 白盒断言',
    '### C8 · 可执行性与措辞',
    '## 4. 输出格式',
    '## 5. 判据优先级',
    '## 6. 你的限制',
  ],
  'task-card-template.md': [
    '### 目标',
    '### 验收标准',
    '### 涉及文件',
    '### 技术约束',
    '### 不许改动的部分',
    '### 验证证据出口',
    '### 预览端口',
    '## 验证证据出口',
    '## 填写要求',
    '## 一致性检查',
    '## 视觉决策必须交给人',
    '## 一张卡只做一件事',
    '## 续派（修订）卡的写法',
  ],
};

/* ------------------------------------------------ J4 教训匿名化保留 */

const ANONYMIZED_LESSONS = [
  { doc: 'DIRECTOR-PROTOCOL.md', label: 'Git 纪律·实现被覆盖的教训', must: ['曾有一个项目'] },
  { doc: 'WORKFLOW-PRINCIPLES.md', label: '原理 5·"不许新建任何文件"的教训', must: ['【教训】', '/tmp'] },
  { doc: 'WORKFLOW-PRINCIPLES.md', label: '原理 6·证据时效性的教训', must: ['【教训】', 'ERR_CONNECTION_REFUSED'] },
  { doc: 'WORKFLOW-PRINCIPLES.md', label: '原理 9·两次返工的复盘', must: ['曾有一个项目', '某卡'] },
  { doc: 'WORKFLOW-PRINCIPLES.md', label: '原理 12·恒真断言的实例', must: ['某卡实例', '恒真'] },
  { doc: 'WORKFLOW-PRINCIPLES.md', label: '原理 13·夹带子系统的实例', must: ['某卡实例', '全新子系统'] },
  { doc: 'CARD-REVIEWER.md', label: 'C1·恒真断言的实例', must: ['真实案例'] },
  { doc: 'CARD-REVIEWER.md', label: 'C3·约束矛盾的实例', must: ['真实案例'] },
  { doc: 'task-card-template.md', label: '验证证据出口·教训来源', must: ['曾有一个项目', '/tmp'] },
  { doc: 'task-card-template.md', label: '一致性检查·两次返工', must: ['曾有一个项目', '某卡'] },
  { doc: 'task-card-template.md', label: '原子性·夹带子系统的实例', must: ['曾有一个项目', '全新子系统'] },
];

/* ---------------------------------------------------------------- 工具函数 */

/**
 * 「禁名单区块」豁免标记（只对 J6 证据文件生效，五份协议文档**没有**这个豁免）。
 *
 * 为什么需要：证据 README 的职责是**逐行列出**被清掉的 token 作为可核对清单，
 * 那必然要写出这些 token。若不给豁免，只能靠"不写清单"骗过门禁 —— 那才是真的假绿。
 *
 * 规则（尽可能窄）：
 *   - 单行豁免：以哨兵 `clean-check:allow-forbidden-list` 结尾的行；
 *   - 区块豁免：`clean-check:begin-forbidden-list` 与 `clean-check:end-forbidden-list`
 *     之间的行（用于"逐份替换清单"表格——它的"原文"列必须引用被清洗的字符串）。
 *   - 除这两种情形外，证据文件任何一行命中都 FAIL；
 *   - **五份协议文档不享受任何豁免**（本函数只用于 J6），所以 J1/J2 对它们仍是全量零命中。
 */
const ALLOWLIST_SENTINEL = 'clean-check:allow-forbidden-list';
const LIST_BEGIN = 'clean-check:begin-forbidden-list';
const LIST_END = 'clean-check:end-forbidden-list';

function scanFile(full, text) {
  const rel = path.relative(ROOT, full);
  const lines = text.split('\n');
  const termHits = [];
  const patHits = [];
  let inList = false;
  lines.forEach((line, i) => {
    if (line.includes(LIST_BEGIN)) { inList = true; return; }
    if (line.includes(LIST_END)) { inList = false; return; }
    if (inList) return;
    if (line.trimEnd().endsWith(ALLOWLIST_SENTINEL)) return;
    for (const term of FORBIDDEN_TERMS) {
      if (line.includes(term)) termHits.push(`${term}@L${i + 1}`);
    }
    for (const { name: pname, re } of FORBIDDEN_PATTERNS) {
      const m = line.match(new RegExp(re.source, 'g'));
      if (m) patHits.push(`${pname}: ${[...new Set(m)].join('|')}@L${i + 1}`);
    }
  });
  return { rel, termHits, patHits };
}

function readDoc(name) { return fs.readFileSync(path.join(DOCS_DIR, name), 'utf8'); }

function lineOf(text, index) { return text.slice(0, index).split('\n').length; }

/** 递归收集目录下的 .js / .md（跳过本脚本自身） */
function collectScanFiles(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { collectScanFiles(full, acc); continue; }
    if (!/\.(js|md)$/.test(entry.name)) continue;
    if (path.resolve(full) === SELF) continue;   // 唯一豁免：本脚本必须写出被禁 token 才能断言
    acc.push(full);
  }
  return acc;
}

/* ================================================================= 开始 */

console.log('协议文档抽取清洗门禁 · clean-check');
console.log(`工作区根（template/）：${ROOT}`);
console.log(`被扫描文档目录：${DOCS_DIR}${ddIdx === -1 ? '（默认）' : '（--docs-dir 覆盖：负向对照模式）'}`);
console.log(`证据目录：${path.relative(ROOT, SCAN_DIR)}/**/*.{js,md}\n`);

if (ddIdx !== -1 && !fs.existsSync(DOCS_DIR)) {
  console.log(`FAIL  被扫描文档目录不存在：${DOCS_DIR}`);
  process.exit(1);
}

/* ---- 0. 文档存在且非空 ---------------------------------------------- */

section('J0 五份文档存在且非空');
for (const name of DOCS) {
  const p = path.join(DOCS_DIR, name);
  const exists = fs.existsSync(p);
  ok(exists, `${name} 存在`, p);
  if (!exists) continue;
  const text = readDoc(name);
  const lines = text.split('\n').length;
  ok(text.trim().length > 500, `${name} 非空且是成文文档（${lines} 行）`, `${text.trim().length} chars`);
}

/* ---- J1 专有名词零命中 ---------------------------------------------- */

section('J1 专有名词零命中（弹弓/橡皮筋/小球/手部/轨迹/blinking/returning/hand-harness/blink-harness/square-harness/slingshot/index.html/vendor/three）');
for (const name of DOCS) {
  const text = readDoc(name);
  const hits = [];
  for (const term of FORBIDDEN_TERMS) {
    let idx = text.indexOf(term);
    while (idx !== -1) {
      hits.push(`${term}@L${lineOf(text, idx)}`);
      idx = text.indexOf(term, idx + 1);
    }
  }
  ok(hits.length === 0, `${name} 零命中`, hits.join(', '));
}

/* ---- J2 编号与指纹零命中 -------------------------------------------- */

section('J2 编号与指纹零命中（卡编号 / md5 / 行数 / tag 名 / 本项目证据路径）');
for (const name of DOCS) {
  const text = readDoc(name);
  const hits = [];
  for (const { name: pname, re } of FORBIDDEN_PATTERNS) {
    const m = text.match(new RegExp(re.source, 'g'));
    if (m) hits.push(`${pname}: ${[...new Set(m)].join('|')}`);
  }
  ok(hits.length === 0, `${name} 零命中`, hits.join('; '));
}

/* ---- J3 结构完整 + 链接自洽 ----------------------------------------- */

section('J3a 必备段落仍在（目录 / 角色职责 / 闸门 / 验收流程 / 证据出口 / 汇报格式）');
for (const name of DOCS) {
  const text = readDoc(name);
  for (const heading of REQUIRED_SECTIONS[name]) {
    ok(text.includes(heading), `${name} 含「${heading}」`);
  }
}

section('J3b 所有相对链接都自洽（无指向本项目的链接，且模板内目标文件真实存在）');
for (const name of DOCS) {
  const text = readDoc(name);
  const links = [...text.matchAll(/\]\(([^)]+)\)/g)].map(m => m[1]);
  const bad = [];
  for (const raw of links) {
    const target = raw.split('#')[0].trim();
    if (!target) continue;
    if (/^[a-z]+:/i.test(target)) continue;                       // 外链（应为零，另测）
    if (target.includes('<') || target.includes('>')) continue;   // 占位符链接
    const abs = path.resolve(DOCS_DIR, target);
    if (!fs.existsSync(abs)) bad.push(`${target}（不存在）`);
  }
  ok(bad.length === 0, `${name} 链接自洽（${links.length} 个相对链接）`, bad.join(', '));

  const external = [...text.matchAll(/\]\((https?:\/\/[^)]+)\)/g)].map(m => m[1]);
  ok(external.length === 0, `${name} 无 http(s) 外链`, external.join(', '));
}

section('J3c 冷启动顺序里引用的计划文件真实存在');
for (const name of DOCS) {
  const text = readDoc(name);
  if (!text.includes('../ROADMAP.md')) { ok(true, `${name} 未引用 ../ROADMAP.md（不适用）`); continue; }
  const roadmap = path.resolve(DOCS_DIR, '../ROADMAP.md');
  ok(fs.existsSync(roadmap), `${name} 引用的 ../ROADMAP.md 存在`, roadmap);
}

/* ---- J4 教训匿名化保留 ---------------------------------------------- */

section('J4 教训用匿名化保留（不许整段删）');
for (const { doc, label, must } of ANONYMIZED_LESSONS) {
  const text = readDoc(doc);
  const missing = must.filter(token => !text.includes(token));
  ok(missing.length === 0, `${doc} · ${label}`, `缺: ${missing.join(', ')}`);
}

/* ---- J5 模板声明 ---------------------------------------------------- */

section('J5 每份文档开头都有模板声明');
for (const name of DOCS) {
  const text = readDoc(name);
  const head = text.split('\n').slice(0, 12).join('\n');
  ok(head.includes('本文件是模板'), `${name} 声明「本文件是模板」`);
  ok(head.includes('尖括号'), `${name} 声明「项目特定段落用 <尖括号> 标注」`);
}

/* ---- J6 证据文件本身也不许带项目痕迹 --------------------------------- */

const NEGATIVE_MODE = ddIdx !== -1;
if (NEGATIVE_MODE) {
  section('J6 负向对照模式：跳过（只判被 --docs-dir 指定的那份副本）');
} else {
  section('J6 verify/tool-01/ 下的证据文件（除本脚本）零项目痕迹');
  const scanFiles = collectScanFiles(SCAN_DIR).sort();
  ok(scanFiles.length > 0, `发现待扫描证据文件（${scanFiles.length} 个）`, scanFiles.map(f => path.relative(ROOT, f)).join(', '));
  for (const full of scanFiles) {
    const { rel, termHits, patHits } = scanFile(full, fs.readFileSync(full, 'utf8'));
    ok(termHits.length === 0, `${rel} 无 J1 专有名词`, termHits.join(', '));
    ok(patHits.length === 0, `${rel} 无 J2 编号指纹`, patHits.join('; '));
  }
}

/* ---------------------------------------------------------------- 汇总 */

console.log(`\n${'='.repeat(72)}`);
if (failed) {
  console.log(`${passed} passed, ${failed} failed`);
  console.log('\n失败项：');
  failures.forEach(f => console.log(`  - ${f}`));
  process.exit(1);
}
console.log(`${passed} passed, 0 failed`);
process.exit(0);
