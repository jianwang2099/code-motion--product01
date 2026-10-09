# 任务卡 01 · 《元素周期表简介》24 秒纯画面成片

> **状态**：审卡已过（首轮审卡结论「需修改后下发」，10 条阻断 + 6 条建议已全部整改）→
> **PM（人）已确认下发**，2026-10-09。未验收前不得 commit 实现。
>
> 关联决策：`HANDOFF.md` §3 的 D1（视觉方案 A）/ D2（24 秒）/ D3（三段分镜）/
> D4（前 36 号 + 碳 + 3 族）/ D5（纯画面）/ D6（不造工具）。

---

### 目标

在工作区根新建 `index.html`（canvas 2D 单文件页面，**只读参考**现成样板
`video/index-video-mode.snippet.html` 与 `video/VIDEO-MODE-CONTRACT.md`，
**不修改 `video/` 下任何既有文件**），按「铺装周期表 → 逐族扫过 → 点开碳原子」三段叙事
产出 **1920×1080 · 60fps · 24 秒（1440 帧）** 的确定性序列帧，并合成一支 MP4 成片。
本卡为**纯画面**：不含音频、不含字幕（另卡处理）。

> **本卡不做的事**（防止误判失败）：**不跑** `node verify/run-all.js`。模板继承来的
> `verify/visual/baseline/` 是**旧项目**的图库，与本页面无关，视觉环节对本页面必然不一致；
> 本卡的唯一门禁是 `verify/card-01/gate.js`。

### 验收标准

> 每条都可由脚本独立重跑判定；「像不像 / 好不好看」不在本卡脚本判定范围内，由人看截图判。
> **执行手段分工（硬性）**：A1 用 `fs.readFileSync('index.html','utf8')` 做**词法检查**（不调浏览器）；
> **A2–A7 与 B3 必须真调浏览器**（CDP，复用 `video/lib/cdp.js`），
> **禁止用正则/文本匹配模拟 DOM 状态**。

**A. 页面契约与确定性**

1. **A1 无 CSS 时钟依赖（文件词法检查，不调浏览器）**：`index.html` 文本中**不出现**
   `animation:`、`animation-`、`transition:`、`transition-`、`@keyframes`、
   `getAnimations`、`currentTime` 任一子串，命中即失败。
2. **A2 出口成员齐全、类型正确、非法 duration 被忽略**：打开
   `index.html?video=1&duration=24&fps=60` 后，`window.__video` 存在且
   `active===true`、`fps===60`、`width===1920`、`height===1080`、`duration===24`、
   `totalFrames===1440`；`reset/stepFrame/simulateFrames/render/commit/captureFrame`
   均为函数；依次赋 `duration = NaN / 0 / -5` 后，`duration` **仍为 24**。
   （`window.__video` 上**只允许**契约 §1 的成员，不得多挂 `STEPS_PER_FRAME` 之类的额外键。）
3. **A3 帧号推进自洽**：从 `reset()` 起连续 `stepFrame()` 120 次，第 k 次后
   `frameIndex===k` 且 `simSteps===k*2`（硬编码 2 —— `STEPS_PER_FRAME = Math.round((1/60)/(1/120)) = 2`）。
4. **A4 `reset()` 真正回零且可复现（非平凡）**：
   - ① `reset()` 后 `frameIndex===0`、`simSteps===0`；
   - ② 执行 `reset(); await commit();`，用**与流水线同一条抓图路径**取图
     （CDP `Page.captureScreenshot` + clip `0,0,1920,1080`, scale 1），记 md5；
     重复 ≥3 次，**三次 md5 完全相同**；
   - ③ **非平凡性**：该 md5 必须 **≠** 「`simulateFrames(700); await commit();` 后同路径抓图」的 md5。
   - ⚠️ **禁止**用 `captureFrame()`（`toDataURL`）的结果与 `video/frames/*.png` 逐字节比对
     （PNG 编码器不同，必然不同，那是假失败）。
5. **A5 `?video=1` 之外不挂出口**：打开 `index.html`（无 query）时 `window.__video === undefined`。
6. **A6 `render()` 不推进时间**：在 `simulateFrames(700)` 后，连续 `render()` 三次，
   每次 `frameIndex` 与 `simSteps` 都不变；且三次 `await commit()` 后同路径抓图 md5 相同。
7. **A7 人工验收截图存在**：`verify/card-01/shots/` 下至少有 **6 张** PNG，
   命名形如 `NN_<五位帧号>_<镜头名>.png`，且**必须覆盖**帧号
   `00000`、`00329`、`00419`、`00620`、`01020`、`01100`、`01439` 中的**至少 6 个**；
   缺任一（少于 6 张或缺帧号）→ 门禁失败。（"好不好看"由人看这些图判。）
   > 说明：gate **不自己渲染**；这些图由出片流程产出（见「预览端口」步骤）。

**B. plan.js 与叙事时间轴**

8. **B1 plan 形状合规**：`await require('video/plan.js').solve(session, {fps:60, duration:24})`
   返回 `fps===60`、`duration===24`、`totalFrames===1440`、`actions.length===1440`、
   `log` 为非空字符串数组、`shots` 为非空数组且每个元素含**数字** `index`。
9. **B2 actions 全 null（本片无脚本化输入）**：`actions` 的 1440 项**全部** `=== null`。
10. **B3 三段边界落在真实切换点上**：除 B1 的形状检查外，必须用**帧哈希**证明：
    `frame_00419 ≠ frame_00420` 且 `frame_01019 ≠ frame_01020`。

**C. 逐帧产物（`video/frames/`，1440 张）**

> ⚠️ **本卡时间轴设计为"全程无静止帧"**：① 铺装完成后有**待机呼吸**（见《动效参数》），
> ② 扫族期间有**匀速扫描指示器 + 标签淡入淡出**，③ 碳原子有**旋转电子云**。
> 因此**不存在**"某段 90 帧全部同图"的豁免窗口。

11. **C1 序列帧完整性**：`video/frames/` 下 `frame_%05d.png` 从 `frame_00000.png` 到
    `frame_01439.png` **连续无缺号**，共 1440 张，且每张 IHDR 为 1920×1080。
12. **C2 画面逐帧在动**：
    - (a) **1440 帧两两相邻必须不同**：对 k=0…1438 断言 `md5(frame_k) ≠ md5(frame_{k+1})`，
      允许**至多 0 次**相等（有相等即失败——这正是"静止/卡帧"的机械定义）；
    - (b) 全片去重后不同 md5 数 **≥ 1300**；
    - (c) 三个段边界 `frame_00329 ≠ frame_00330`、`frame_01019 ≠ frame_01020`。
13. **C3 确定性**：同一 plan 渲染两遍到两个不同输出目录
    （`video/frames/` 与 `video/frames-run2/`），两次的**文件名集合相同**且**逐张 md5 完全一致**；
    比对完成后 `video/frames-run2/` **必须删除**，且 gate 断言它**不存在**
    （它未进 `.gitignore`，留着会污染提交）。

**D. 成片**

14. **D1 ffprobe 元数据**：`video/out/periodic-table-24s.mp4` 实测
    `width=1920 height=1080`、`avg_frame_rate=60/1`、`nb_frames=1440`、
    `codec_name=h264`、`pix_fmt=yuv420p`；时长在 **23.9–24.1 s** 容差内。
15. **D2 成片非空且可解码**：文件体积 > 100 KB，`ffprobe` 退出码 0。

### 涉及文件

- `index.html` — **新建**（交付物：canvas 2D 页面 + 粘贴的视频模式块）
- `video/plan.js` — **新建**（叙事型 plan provider）
- `verify/card-01/gate.js` — **新建**（唯一确定性门禁，exit 0 = 通过；打印 `N passed, M failed`）
- `verify/card-01/video-frames-check.js` — **新建**（C1/C2/C3/D1/D2 断言，被 `gate.js` 调用，也可单跑）
- `verify/card-01/README.md` — **新建**（命令级复现步骤 + 截图映射表）
- `verify/card-01/shots/*.png` — **新建**（人工验收截图，≥6 张）
- `video/out/periodic-table-24s.mp4` — **新建**（成片交付物）
- 只读参考：`video/index-video-mode.snippet.html`、`video/VIDEO-MODE-CONTRACT.md`、
  `video/README.md`、`video/lib/cdp.js`，以及工作区外的
  `/Users/zhangyifan/Documents/deepseek-harness/code-motion-project/verify/tool-08/demo/index.html`

### 画面与时间轴

**总时长 24.0 s = 1440 帧 @60fps，单次播放（非循环），1920×1080。**

构图：**18 列 × 4 行**网格，只画**前 36 号元素**（H–Kr，4 周期），每格显示原子序数 + 元素符号。
网格几何建议（可用更好的，但须满足"符号 ≥28 px、格内文字四周留白 ≥12 px"）：
格宽 76 px、格高 120 px、水平间隙 20 px、垂直间隙 20 px；
网格整体 18×76 + 17×20 = 1708 px 宽、4×120 + 3×20 = 540 px 高，居中于 (960, 570)。

| 段 | 帧区间 | 秒区间 | 内容 |
|---|---|---|---|
| ① 铺装周期表 | 0 – 419 | 0.00 – 7.00 | 36 个格子从散落位置/角度**聚合并归位**成网格（帧 0–330）；背景网格线同步生长（帧 0–330，**持续**）；顶部落标题《元素周期表简介》（帧 0–90）：帧 90–329 待机**呼吸+光晕**，帧 330–419 **继续呼吸**（不停帧） |
| ② 逐族扫过 | 420 – 1019 | 7.00 – 17.00 | 高亮**依次**扫过 3 个族：**碱金属（第 1 族：Li Na K Rb Cs，5 格）→ 卤素（第 17 族：F Cl Br I，4 格）→ 稀有气体（第 18 族：He Ne Ar Kr，4 格）**；一个**匀速扫描指示器**（垂直青色亮条）在这 600 帧内从左向右**连续**移动；族名标签淡入并停留至本族时段结束 |
| ③ 点开碳原子 | 1020 – 1439 | 17.00 – 24.00 | **碳 C（6 号）**自网格放大移到画面中央；展示「碳 / Carbon」、原子序数 6、电子排布示意（原子核 + K 层 2 点 + L 层 4 点**绕核旋转**）；其余格子压暗至 `alpha 0.28` 但仍可见 |

**镜头**：固定机位、无推拉摇移；「点开」用元素格自身的位移 + 缩放表达
（或移动画布坐标系的做法，由实现者择一，须在 `verify/card-01/README.md` 注明选的是哪种）。

### 动效参数

> **总原则：全程无静止帧。** 任何"停留"期间都必须有连续的待机运动。

- **基准**：1920×1080，`FIXED_DT = 1/120`，`STEPS_PER_FRAME = 2`，所有位置/角度/透明度/半径
  **只由帧号或累加步数算出**，绝不读挂钟。
- **缓动**：全局 `easeInOutCubic(t) = t<0.5 ? 4t³ : 1-(-2t+2)³/2`，定义一次、复用。
- **待机呼吸（① 全程与 ②③ 的底色）**：
  `idle = 0.5 + 0.5*sin(2π*n/120)`（`n` = 帧号）；格子 `scale = 1 + 0.012*idle`；
  描边 `alpha = 0.38 + 0.16*idle`；背景渐变中心每帧水平偏移 `+ n/1440 * 40 px`。
- **① 铺装**：第 i 格（i = 0…35）散落起点
  `x0 = 100 + ((i*127) % 1720)`、`y0 = -260 - ((i*211) % 520)`、`rot0 = ((i*37) % 21 - 10) * 0.012 rad`
  （**确定性公式，不用 `Math.random`**）。归位进度
  `p = easeInOutCubic(clamp((n - i*3.5)/330, 0, 1))`；最晚一格（i=35）延迟 122.5 帧，
  故所有格子在帧 330 前完成。帧 0–90 标题 `alpha = easeInOutCubic(n/90)`。
- **② 扫族**：每族占 200 帧（420–619 / 620–819 / 820–1019）。
  族内自左向右逐格点亮：`on_k = clamp((n - (familyStart + k*12))/30, 0, 1)`；
  高亮态 `scale = 1.06`、`shadowBlur = 28`、描边换青 `#5fe3ff`。
  族名标签在该族前 40 帧淡入（`alpha 0→1`）、最后 40 帧淡出。
  **扫描指示器**：`x = 60 + (n - 420)/600 * 1800`，宽 6 px 高 620 px 的青色竖条，
  `alpha = 0.35 + 0.25*idle`（连续移动 → 每帧必变）。
- **③ 点开**：帧 1020–1100 碳格从网格位置插值到画面中央、`scale 1.0→2.4`（用 `easeInOutCubic`）；
  帧 1100–1439 保持并**持续**旋转电子云。电子云（**必须打破 180° 自同构**）：
  - K 层 2 点：`θ_k = 2π*n/60 * 0.37 + k*π`（k=0,1），`r = R_K + 8*sin(3θ_k + 2π*n/37)`
  - L 层 4 点：`θ_k = 2π*n/60 * 0.19 + k*π/2`（k=0…3），`r = R_L + 8*sin(3θ_k + 2π*n/41)`
  - 即**两层反向旋转 + 半径脉动 + 非定常角速度**，任两帧不同。
- **视觉（方案 A · 深空霓虹科技，人已选定）**：
  - 背景：近黑深蓝 `#080b18` → `#0d1430` 线性渐变（角度固定，中心微移见「待机呼吸」）
  - 元素格：填充 `rgba(255,255,255,0.05)`、描边 `rgba(120,200,255,0.45)`、圆角 8 px
  - 强调色：青 `#5fe3ff`（高亮）、品红 `#ff5fa2`（族名标签）；碳格描边青→白渐变
  - 字体：`ui-monospace, Menlo, monospace`；标题 64 px / 符号 30 px / 序数 18 px / 族名 40 px

### 技术约束

- **纯 canvas 2D**（`getContext('2d')`），**零依赖零构建**：不引入 three.js / npm 包 / CDN / 外部字体。
- canvas 写死 `width="1920" height="1080"`；`dpr=1`。
- **视频模式块只允许这 5 处改动**（样板可粘贴的最小集）：
  - `:36` `VIDEO_DURATION_DEFAULT` 可改为 `24`；
  - `:63` `reset()` 补上"回到第 0 帧初始态"的复位（**不渲染**）；
  - `:73` `stepFrame()` 内推进时间轴（只用常量 `FIXED_DT`）；
  - `:87` `render()` 内绘制当前状态（**不推进时间**）；
  - `:105` 起**整段删除** `setDrag` / `release` 及其事件监听（本片无输入），
    并相应从出口对象里移除这两个键。
  其余样板代码逐字保留（含 `duration` setter 的非法值忽略逻辑）。
- **视频模式下不启动 rAF 主循环**；非视频模式（无 `?video=1`）可有 rAF 预览循环。
- 视频模式代码路径中不得出现 `performance.now()` / `Date.now()`。
- 运行环境（**导演已实测**）：Node v22.23.1、`ffmpeg`/`ffprobe` 8.1.1（含 libx264）、
  无头 Edge `/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge`。

### 不许改动的部分

- **`video/` 下任何既有文件一律不得修改**（流水线是现成件；本卡只**新建** `video/plan.js`）。
  尤其不改 `render-frames.js` / `compose.js` / `make-video.js` / 样板 / 契约文档 / `lib/`。
- **不新建时间轴工具**（不写 `timeline.js` 之类）；时间轴由页面按帧号自算 + `plan.js` 返回全 `null`。
- **不得触碰工作区之外**：`/Users/zhangyifan/Documents/deepseek-harness/code-motion-project/`
  一律**只读**，不得有任何写操作。
- **不许运行 `node verify/visual/visual.js shoot`**：那会覆盖模板继承来的冻结图库
  `verify/visual/baseline/*.png`（属于旧项目）。也不得删除/改写该目录下任何既有文件。
- 不许改 `storyboard/` 下的协议文件与 `AGENTS.md` / `ROADMAP.md`。
- 不许改 `.gitignore`（`video/frames-run2/` 靠"用完即删 + gate 断言不存在"处理）。

### 验证证据出口

| 范围 | 权限 |
|---|---|
| `index.html`、`video/plan.js`、`video/out/periodic-table-24s.mp4` | 可改 / 可新建 |
| `verify/card-01/`（含 `shots/`） | **可新建（唯一出口）** |
| `video/frames/`、`video/frames-smoke/`、`video/frames-run2/` | 可写（中间产物，**不得入库**；`frames-run2/` 比对完必须删） |
| 其余一切 | 不得触碰 |

`verify/card-01/` 至少包含：

1. `gate.js` —— **唯一确定性门禁**：`node verify/card-01/gate.js` 单命令重跑，覆盖 A1–A7、B1–B3、C1–C3、D1–D2；
   打印 `N passed, M failed`；exit 0 = 全通过。A2–A7/B3 必须走 CDP。
   **它不渲染序列帧**：C1–C3/D 断言读已存在的 `video/frames/` 与 `video/out/*.mp4`；
   缺产物时**明确报"需先出片"并失败**（不许静默跳过）。
2. `video-frames-check.js` —— C1/C2/C3/D1/D2 的断言实现。
3. `README.md` —— **命令级复现步骤**，步骤顺序**写死**为：
   起 5174 服务 → 全量出片（带 `--out`）→（确定性对照）→ 生成 shots → 跑 `gate.js`；
   并含**截图映射表**（每张 `shots/*.png` 证明哪条标准编号）+ 实测视口尺寸。

> 判据：**人（导演）必须能独立重跑 `node verify/card-01/gate.js` 得到同样结论。**

### 预览端口

**5174**（5173 已被旧项目占用，**导演已实测**）。服务已在跑：受管后台作业
`python3 -m http.server 5174 --bind 127.0.0.1`（cwd = 工作区根）。**不要重复启动**；
若挂了按同命令以受管后台作业重启。

**所有出片/渲染命令必须显式带 `--url`**，否则默认抓 `http://127.0.0.1:5173/index.html` = **旧项目页面**：

```bash
# 冒烟（只看前 2 秒；**输出到独立目录**，否则会清空 video/frames/ 里已渲染的全量帧）
node video/make-video.js --plan video/plan.js --url http://127.0.0.1:5174/index.html \
  --duration 24 --limit 120 --frames video/frames-smoke
rm -rf video/frames-smoke          # 冒烟完清掉

# 全量出片（1440 帧，实测约 2 分钟；--out 必须显式给，默认名是 video.mp4）
node video/make-video.js --plan video/plan.js --url http://127.0.0.1:5174/index.html \
  --duration 24 --out video/out/periodic-table-24s.mp4

# 确定性对照（C3：第二个输出目录；比对完必须删）
node video/render-frames.js --plan video/plan.js --url http://127.0.0.1:5174/index.html \
  --duration 24 --out video/frames-run2

# 唯一门禁
node verify/card-01/gate.js
```

### 预算

- 迭代期用 `--limit 120` 冒烟（写进 `video/frames-smoke/`）；**每个新页面的全量渲染最多 3 次**
  （全量出片 1 次 + 确定性对照 1 次 + 修补后补跑 1 次）。
- 实测参考：30 帧耗时 2.5 s ≈ **11.7 帧/s**，1440 帧约 **2 分钟**（页面更重会更慢，属正常）。
- 上下文：本轮只做本卡；超范围的发现写进「未决问题」，不夹带。

---

## 附 · 本卡的审卡与审核记录（证据）

| 项 | 值 |
|---|---|
| 审卡角色 | 一次性审卡 Worker（`CARD-REVIEWER.md` 全文 + 本卡下发，零项目上下文） |
| 首轮结论 | **需修改后下发**：10 条阻断 + 6 条建议 |
| 首轮抓到的硬伤 | ① C2「去重 ≥1365」与卡内《动效参数》数学上互斥（上限 ≈775，源于两段静止保持 + 电子点 180° 自同构）；② 全量出片命令缺 `--out`；③ 冒烟 `--limit` 会清空已渲染的全量帧 |
| 整改 | 时间轴改为**全程无静止帧**；C2 换机械判据（相邻帧必不同 + 去重 ≥1300 + 段边界）；命令补 `--out` / 冒烟改独立目录；A1 手段与出口条款解耦；A3 硬编码 `STEPS_PER_FRAME=2`；A4/A6 加**非平凡性**（reset 后 md5 必须 ≠ 推进 700 帧后的 md5）；B3 加真实帧哈希边界；新增 A7 截图断言；权限表补 `video/frames*/`；参考物改绝对路径；补「为何不跑 run-all.js」 |
| PM 审核 | **通过**（2026-10-09），并就 A7 截图帧号、C2 阈值、散落/轨道公式逐条确认无异议 |
