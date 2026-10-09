# verify/visual/ · 视觉回归（截图 → 图库 → 逐像素比对 → 纳入全量 runner）

> 目标：把「人看画面」这一步自动化成「**人只看差异报告**」。
> 本目录是这条链路的**全部实现**：抓图、图库、比对、差异图、确定性门禁、全量 runner 接入。

---

## 1. 技术选择（本项目：零依赖 / 离线优先）

| 环节 | 选型 | 为什么 |
|---|---|---|
| **比对** | **纯 JavaScript + 自带 `node:zlib`**（`png.js` 自写 PNG 解码/编码） | 零第三方依赖、离线可用。**不引入 Pillow / pngjs**：本项目任何机器只要有 Node 就能跑完门禁 |
| **抓图** | **无头 Edge + CDP**（`Emulation.setDeviceMetricsOverride` 钉视口 + `Page.setWebLifecycleState('frozen')` 冻结时钟 + `Page.captureScreenshot`） | 与 `verify/card-05|07/make-screenshots.js` 同一套手法；**驱动真实页面**（不复制、不注入） |
| **独立交叉核对** | **Pillow**（项目外解释器，**可选**） | 只用于门禁里的"双引擎"断言：同一对图，Node 与 Pillow 必须给出同一个差异计数。找不到 Pillow 时该条如实标"⚠ 跳过"，**不影响门禁通过** |

> **为什么"可选"也要写进来**：本项目吃过"同一脚本里两套坐标换算 → 断言空过"的亏（见 `verify/card-04/README.md` 的 `验收7b` 归因）。
> 像素类证据最怕"看似通过实则空过"，所以留一条**独立实现**的交叉核对：本机实测 Node 与 Pillow 在 4 组样本上计数完全一致。
> 指定解释器：`VISUAL_PYTHON=/path/to/python3 node visual-gate.js`。

---

## 2. 目录与统一命令

```
verify/visual/
  README.md            ← 本文件（技术选择 / 口径 / 边界 / 纪律）
  png.js               ← 零依赖 PNG 解码 + 编码（node:zlib；8bit ct=0/2/3/4/6，5 种行滤波）
  fixtures.js          ← 视觉门禁的**自造样本**生成器（纯计算，无随机）
  visual.js            ← **统一入口**：shoot / compare / all（抓图 + 比对 + 差异图 + 人可读结论）
  visual-gate.js       ← **确定性门禁**（9 条断言，跑在自造样本上，不需要浏览器/预览服务）
  cdp-page.html        ← 自造最小页面（只为验证"冻结时钟 → CDP 抓图"这条链路本身）
  baseline/            ← **图库**（真实页面抓的图 + 映射表 README.md + capture-run1.json 指纹）
  visual-gate-out/     ← 门禁运行产物（自造样本 + 差异图；**由代码现算，不入库**，见 template/.gitignore）
```

**人只需要记这一条命令**（截图 → 比对 → 汇总；退出码 0 = 全部在容差内）：

```bash
# 前置：预览服务在跑（受管后台作业，别重复启动）
python3 -m http.server 5173 --bind 127.0.0.1
# 一键：抓真实页面 → 与图库比对 → 出差异图 + 结论
node template/verify/visual/visual.js all \
     --baseline template/verify/visual/baseline --out /tmp/dsh-visual-shots
```

分步子命令：`shoot`（只抓图）/ `compare`（只比对）/ `list`（看图清单）。
自造样本要一起抓时加 `--include-fixture`；样本单独抓：`--only fixture`。

**确定性门禁**（任何人任何机器都能跑，不需要浏览器，也不需要预览服务）：

```bash
node template/verify/visual/visual-gate.js      # 期望 9 passed, 0 failed；exit 0
```

---

## 3. 比对口径（唯一入口 = `visual.js` 的 `judge()`）

- **差异计数** = 逐通道比较后，**任一通道 |Δ| > maxDiff** 的像素个数。`maxDiff` 默认 **8**（±8 不算、±9 算）。
- **判定** = 差异计数占全图比例是否 ≤ `maxRatio`（默认 **0.2%**；来由与噪声包络实测见 `baseline/README.md` §2）。
- **钉相位**：抓图前把方块**钉在中轴附近**（默认容差 **±4 世界 px**，`--tol N` 可覆盖）。
  否则"方块往复相位"本身就会淹掉比对结果 —— 实测这就是噪声的**唯一**来源（差异包围盒恒等于方块/球本体）。
  冻结后 CDP 抓图仍会强制渲染 ≤2 帧（每帧 dt ≤ `MAX_FRAME_DT=0.05s`），故实测位置还会再漂 ~6 世界 px：
  这段抖动是**噪声**、不是缺陷，用包络阈值吸收（见 `baseline/README.md` §2）。
- **产物**：抓图（文件名含**页面内实测视口**）+ `diff/<name>.diff.png`（红点 = 超容差像素）+ `visual-report.json` + stdout 结论。
- **尺寸不一致**：直接判失败并打印两边尺寸（先查钉视口，**不要**调容差）。

---

## 4. 边界（原理层，必须写在人看得见的地方）

1. **像素比对只能抓"意外变化"，抓不了"符合预期但依然荒谬"。**
   如果某个荒谬从第一版就在，它就在 baseline 里，比对永远通过 —— 所谓"符合预期但依然荒谬"（如卡 02 的皮筋跟球）
   必须靠**人的视觉判断**或**针对性断言**去抓。
2. **人的视觉判断不可被替代，只能被缩小到"看哪几张图"。**
   本环节把人的工作从"每张卡逐张找不同"缩小为"**门禁失败时看差异图上的红点**"；
   `✓ 一致` 的含义只是"和上次看到的一样"，**不等于"对"**。
3. **"预期之内就该变"的改动必然让比对失败**：正确动作是**更新基准 + 写明归因**，不是调容差吞掉红点。

---

## 5. 冻结纪律（本轮硬约束）

- **不许改任何 `verify/card-NN/` 下已有的图与脚本**：卡 01/02/03/04/05/07 的历史证据全部只读。
- **新图库独立放**：`template/verify/visual/baseline/`，与 `verify/card-*/` 互不影响，不覆盖、不移动任何旧图。
- 门禁的产物（`visual-gate-out/`）与抓图产物（默认落在系统临时目录）**都不入库**：前者由本仓库代码现算，后者是运行产物。
  **入库的只有**：实现脚本 + 图库 PNG + 图库映射表 + 指纹 JSON。

---

## 6. 接入全量 runner

`node verify/run-all.js` 现在多跑**视觉环节**两条腿：

```
—— 视觉环节 ——
[PASS] verify/visual/visual-gate.js  →  9 passed, 0 failed        ← 自造样本，确定性断言
[PASS] verify/visual/visual.js all（截图 → 比对 baseline）  →  全部在容差内
         [PASS] ready-square-center-1200x760.png ...
         抓图与差异图：/tmp/dsh-visual-shots（visual-report.json 在里面）
```

- 视觉门禁失败 / 真实页面比对不一致 → **计入失败数 → exit 1**。
- 图库为空或预览服务不可达 → 打印 **`[SKIP]`**，并明确写出「**没比对 ≠ 视觉通过**」（不判失败，但绝不谎报验过）。
- 跳过视觉环节：`--no-visual`；换预览地址：`PREVIEW_URL=http://127.0.0.1:5174/index.html`；换抓图目录：`VISUAL_OUT=<dir>`。
