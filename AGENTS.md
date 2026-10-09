# 项目约定 · 元素周期表简介

> **全局铁律见 `~/.dsh/AGENTS.md`**（闸门、收尾流水线、证据纪律、汇报纪律）——**不要在这里重复**。
> 本文件只写**本项目的差异**：目标、技术约束、门禁命令、目录约定、本项目特有的坑。
> 建立日期：2026-10-09

## 1. 项目
- **目标（一句话）**：交付《元素周期表简介》**1920×1080 · 60fps · 24 秒**（1440 帧）纯画面短片；**定位是内部技术验证**，但内容要正常、非专业观众能看懂。
- **交付物与入口**：
  - 演示物（**给流水线喂的素材**）：`index.html`（canvas 2D，按帧驱动）+ `video/plan.js`
  - 成片：`video/out/periodic-table-24s.mp4`
  - 中间产物：`video/frames/`（1440 张 PNG，已被 `.gitignore` 忽略，不入库）
- **技术约束**：纯 canvas 2D、**零依赖零构建**、离线可用；动画**只由帧号驱动**，禁止 CSS `animation`/`transition` 当主体（会跟挂钟走）；canvas 固定 1920×1080、`dpr=1`；视频模式下不启动 rAF 主循环。
- **运行 / 预览方式**：`http://127.0.0.1:5174/`，由**受管后台作业**起在**工作区根**：`python3 -m http.server 5174 --bind 127.0.0.1`（**不要重复启动**）。
  ⚠️ **5173 被旧项目占用**；所有出片命令必须显式传 `--url http://127.0.0.1:5174/index.html`，否则抓到的是**旧项目的页面**。

## 2. 门禁与证据
- **唯一门禁**：`node verify/card-01/gate.js` —— 期望 `N passed, 0 failed`、exit 0。
  **它不渲染**：需先出片（1440 帧 + `video/out/*.mp4`）再跑，缺产物会明确失败。
- **全量回归**：本项目**不跑** `node verify/run-all.js` —— 模板继承的 `verify/visual/baseline/` 是**旧项目**图库，与本页面无关；`visual.js shoot` 会覆盖它，**禁止**。
- **证据目录**：`verify/card-<NN>/`（门禁脚本 + 截图 + README 映射表）
- **判定分工**：确定性断言由脚本判；**"好看/像不像"由人看 `verify/card-01/shots/` 截图判**

## 3. 目录约定（谁能改什么）
| 目录 | 内容 | 纪律 |
|---|---|---|
| `verify/card-<NN>/` | 每张卡的证据 | 一经**验收**即冻结，只加不改 |
| `storyboard/` | 协议 + `LEDGER.md` + `HANDOFF.md` + 任务卡 | `HANDOFF` 的 PM 章节只由人追加 |
| `video/` | **现成流水线（模板自带，9 文件）** | **不得修改任何既有文件**；只准在里面**新建** `plan.js` |
| `video/out/` | 成片 | 交付物，**要入库** |
| `video/frames/`、`frames-smoke/`、`frames-run2/` | 序列帧中间产物 | **不入库**；`frames-run2/` 用完即删 |

## 4. 本项目决策（D1..Dn）
放在 `storyboard/HANDOFF.md` 的决策表；**通用纪律不抄进来**（避免两处漂移），只写本项目的取舍与理由。

## 5. 本项目已知坑（都已在实测中踩到）
1. **默认 URL 是 5173 = 旧项目**（`render-frames.js`/`make-video.js` 里的默认值）→ 必传 `--url`。
2. **`--limit` 冒烟会先清空输出目录**再只写前 N 帧 → 冒烟必须用 `--frames video/frames-smoke`。
3. **`--out` 默认是 `video/out/video.mp4`**，与交付物名不符 → 成片名必须显式给。
4. **`verify/visual/baseline/*.png` 是旧项目图库** → 禁止 `visual.js shoot` 覆盖。
5. **`--duration` 不传默认 30 秒**，与 24 秒的 plan 冲突会在导出前报错退出 → 命令必须带 `--duration 24`。
