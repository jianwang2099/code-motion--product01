# video/ — 「代码 → 序列帧 → 成片」的视频渲染流水线（通用版）

> 目标：把**任何**可帧驱动的网页动画（canvas / WebGL / DOM+CSS）导出成
> **可逐帧复现的 PNG 序列帧**，再用 FFmpeg 合成 MP4。
> 本目录是**通用层**：它不认识你的动画，只认 [`VIDEO-MODE-CONTRACT.md`](VIDEO-MODE-CONTRACT.md) 里的契约。
>
> **零第三方依赖、零构建**：只用 Node 18+ 自带的 `fetch` / `WebSocket` / `child_process`
> 与本机的 `ffmpeg` / `ffprobe`（不装 puppeteer、不装 ffmpeg 封装）。

---

## 1. 一条命令跑完

```bash
# 前置：静态服务在 5173 上跑着（受管后台作业；不要重复启动）
curl -sI http://127.0.0.1:5173/                 # 期望 HTTP/1.0 200 OK

# 出片：逐帧导出 + 合成
node video/make-video.js \
  --plan   video/plan.example.js \
  --url    http://127.0.0.1:5173/index.html \
  --duration 3
```

其它入口：

| 命令 | 作用 |
|---|---|
| `node video/render-frames.js --plan <provider.js> --url <页面> --duration 3` | 只导出序列帧到 `video/frames/` |
| `node video/render-frames.js ... --limit 90` | 冒烟：只出前 90 帧 |
| `node video/render-frames.js ... --capture inline` | 换用页面内 `toDataURL` 抓图（canvas 页面） |
| `node video/compose.js` | 只做帧 → MP4（读 `video/frames/`，**缺号会拦下**） |
| `node video/compose.js --dry-run` | 只打印将执行的 ffmpeg 命令 |
| `node video/make-video.js --plan <provider.js> --skip-frames` | 复用已有序列帧，只重新合成 |
| `node video/lib/probe-capture-speed.js --url <页面> --ready '<表达式>'` | 抓图通路体检：量每张多少 ms、N 帧要跑多久 |

**不认识的参数一律报错退出**（不静默忽略）。

---

## 2. 三步各管一件事

```
你的页面 ?video=1            plan provider            render-frames.js          compose.js
┌──────────────────┐  求解   ┌──────────────────┐  逐帧   ┌──────────────────┐  合成  ┌──────────────┐
│ 视频渲染模式      │ ──────▶ │ 确定性时间轴      │ ──────▶ │ N 张 PNG          │ ─────▶ │ MP4          │
│ 固定 fps/分辨率   │         │ actions/log/shots │         │ frame_00000.png… │        │ H.264        │
│ 手动逐帧驱动      │ ◀────── │ （你的剧本）      │ ──────▶ │                  │        │              │
└──────────────────┘  provider 自己决定怎么算    └──────────────────┘          └──────────────┘
```

### 2.1 页面侧：`?video=1` 才进入视频渲染模式

把 [`index-video-mode.snippet.html`](index-video-mode.snippet.html) 里的 `<script>` 整段
粘进你的页面脚本（放在场景/状态初始化之后），通常只需要改 **2 处**：

- **▲改这里-1**：`reset()` 里补上"回到第 0 帧初始态"要复位的状态（**不要在这里渲染**）；
- **▲改这里-2**：需要脚本化输入（拖拽/释放）时，把 `setDrag()` / `release()` 接到
  **你已有的真人交互函数**上；不需要就把这两个方法与事件监听删掉。

契约细则（12 个成员、三条确定性口径、CSS 动画的坑、canvas 与 DOM 两条抓图路线）
全部在 [`VIDEO-MODE-CONTRACT.md`](VIDEO-MODE-CONTRACT.md)。

### 2.2 plan provider：`--plan <路径>`，必须导出 `solve(session, cfg)`

```js
module.exports.solve = async (session, cfg) => ({
  fps: 60, duration: 3, totalFrames: 180,        // totalFrames 必须 === round(fps × duration)
  actions: [ null, { drag: [12, -6] }, null, { release: true }, /* … 长度必须 === totalFrames */ ],
  log:   ['剧本说明（字符串数组，必填）'],
  shots: [{ index: 45, label: '释放' }]           // 必填；元素至少含 index
});
```

`actions[k]` = **推进到第 k 帧之前**要执行的动作（`k` 从 1 计；第 0 帧 = `reset()` 后的初始态）：

| 取值 | 渲染器做什么 |
|---|---|
| `null` | 什么都不做 |
| `{ drag: [dx, dy] }` | 调 `window.__video.setDrag(dx, dy)`（可选接口） |
| `{ release: true }` | 调 `window.__video.release()` |

- `config` / `trials` 允许省略，但 `log` / `shots` **必填**（渲染器无条件打印它们）；
- 返回值不合规（`actions.length !== totalFrames`、`totalFrames !== round(fps×duration)`、
  与命令行 `--duration` 冲突、`log`/`shots` 缺失）→ **`exit 1`**，stderr 打印**实际值 vs 期望值**，
  **不静默纠正、不截断、不补齐**；
- `session` 可用来在页面里跑离线求解，例如
  `await session.evaluateAwait('window.__video.simulateFrames(600)')` —— 纯计算、不渲染，几千帧只要几十毫秒；
- 最小示例见 [`plan.example.js`](plan.example.js)。

### 2.3 `render-frames.js`：逐帧驱动 + 逐帧抓图

**不是录屏。** 录屏是实时的，帧会随机器负载被丢或被并。这里每一帧都：

```
applyActions(k) → stepFrame() → render() → await commit()（等 2 个 rAF 让画面真上屏）
                → Page.captureScreenshot（clip = 0,0,W,H, scale=1） → 写 frame_%05d.png
```

每一步都断言 `window.__video.frameIndex === k`，**帧号漂移直接报错退出**。
导出前先做"页面自证"：`active` / `fps` / `width,height` / 绘制缓冲 / 绘制区域 / `dpr=1` /
`totalFrames`，任一不符就**在导出任何一帧之前**退出。

### 2.4 `compose.js`：FFmpeg 合成插件

```bash
ffmpeg -framerate 60 -start_number 0 -i frames/frame_%05d.png -frames:v 180 \
       -c:v libx264 -preset slow -crf 16 -pix_fmt yuv420p -profile:v high -r 60 \
       -movflags +faststart out/video.mp4
```

合成前**先自检序列帧**：数量、命名连续性（**缺号会让 ffmpeg 静默截断成片**）、
逐张 IHDR 分辨率一致。任一不满足直接退出 1，不出半成品。

---

## 3. 路径基准（**硬性，与 cwd 无关**）

所有路径参数按 **`path.resolve(ROOT, v)`** 解析，其中
`ROOT = path.resolve(__dirname, '..')` = **脚本所在目录的上一级 = 项目根**（`video/` 的父目录）：

| 参数 | 默认值 | 解析基准 |
|---|---|---|
| `--plan` / `--out` / `--plan-json` / `--frames` | `video/frames`、`video/out/...` | `ROOT`（不是 cwd） |
| `--url` | `http://127.0.0.1:5173/index.html` | 原样字符串 |

→ 所以在任何目录下执行 `node /abs/path/to/video/render-frames.js`，产物都落在**项目根**下的
`video/frames`、`video/out`，**不会**跟着 cwd 乱跑。
`video/frames/` 已在 `.gitignore` 里（它是可确定性重放的中间产物）；**成片（`video/out/*.mp4`）不忽略** ——
交付物应当进版本库，体积大到不适合入库时再由你自己的项目补一条规则。

### 3.1 ⚠️ 在模板副本里直接调用时，ROOT = `<仓库>/template`（实测踩过）

`ROOT` 由**脚本所在目录**决定，与 cwd 无关：脚本在 `<新项目>/video/` 下 → ROOT = `<新项目>`（正确）；
但在**本模板副本**里直接调用（`node template/video/render-frames.js …`）→ ROOT = **`<仓库>/template`**，
于是 `--plan` / `--out` 的**相对路径以 `template/` 为基准**，不是以仓库根为基准。

**错误写法**（实测；把仓库根基准的相对路径交给了脚本）：

```bash
node template/video/render-frames.js --plan verify/demo/plan.demo.js
# → 报错：--plan 文件不存在：<仓库绝对路径>/template/verify/demo/plan.demo.js
```

**正确写法**（给绝对路径，`--out` / `--plan-json` 同理；或给「相对 `template/`」的路径，**注意不是相对仓库根**）：

```bash
node template/video/render-frames.js --plan "$(git rev-parse --show-toplevel)/verify/demo/plan.demo.js"
node template/video/render-frames.js --plan ../verify/demo/plan.demo.js    # 相对 template/，故要带 ../
```

> **诚实标注（修订卡 08-R2）**：上面示例里的路径已**泛化**（`verify/demo/` 这个目录在模板副本里**并不存在**，
> 照抄无法复现）；**真实可复现的逐字原文**在**本仓库的证据目录**：`verify/tool-*/logs/a14-root-basis.txt`。
> 之所以不在这里写全，是因为那些目录名带**数字编号**（形如 `tool-NN`），会被本模板的**清洗断言**抓出（`tool-` 后跟数字即违规）。

---

## 4. 机器级前置（缺一样就跑不起来）

| 前置 | 要求 | 怎么自证 |
|---|---|---|
| Node.js | **≥ 18**（需要全局 `fetch` 与 `WebSocket`） | `node -v` |
| 浏览器 | **Chromium 内核**（Edge / Chrome / Chromium 任一）；macOS 默认候选见 `lib/cdp.js` | `ls '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'` |
| `EDGE_BIN` | 候选都找不到时用它指定可执行文件路径（例：`export EDGE_BIN=/usr/bin/chromium`） | `EDGE_BIN=... node video/render-frames.js ...` |
| `ffmpeg` / `ffprobe` | 需含 **libx264**（`compose.js` 用 `FFMPEG_BIN` 可覆盖路径） | `ffmpeg -version \| head -1` |
| 静态服务 | 页面必须走 HTTP（`file://` 有跨域风险，不能用） | `curl -sI <你的预览地址>` |

- 无头浏览器的 `--window-size` **不可信**（实测要 1200×760 实际只有 1192×629）：
  本流水线用 CDP `Emulation.setDeviceMetricsOverride` 钉死视口，所以尺寸以**页面内实测值**为准。
- 只支持 **headless Chromium 内核**；Firefox / Safari 不支持 `Page.captureScreenshot` 的这条用法。

---

## 5. 已知边界（如实记录）

- **帧率与分辨率是命令行常量**（默认 60fps / 1920×1080），页面侧的 `?fps=` 只用于自证比对；
  真要多分辨率/帧率请显式传 `--fps` / `--width` / `--height`，并同步改页面里的常量。
- **CSS 动画 / 过渡不会自己跟上帧号** —— 见契约 §3，必须 `getAnimations()` + `currentTime` 手动 seek。
- **`reset()` 必须廉价**：离线求解器会 reset 上千次；若你的 `reset()` 里跑了布局或渲染，求解会慢到不可用。
- **画面好不好看由人判**：本目录的脚本只做确定性断言（帧数、md5 一致、ffprobe 元数据），
  "像不像 / 好不好看"必须人看截图。
