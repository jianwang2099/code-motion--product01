# 视频模式契约（`window.__video`）

> 本文件是**页面侧必须遵守的契约**。渲染器（`video/render-frames.js`）只认这套成员名与语义；
> 页面侧样板见 [`index-video-mode.snippet.html`](index-video-mode.snippet.html)。
> 契约不满足 → 渲染器在"页面自证"阶段直接报错退出，不会导出半成品。

---

## 1. 出口成员（12 个成员名，逐个都必须在）—— **语义不得改**

| 成员 | 类型 | 语义 |
|---|---|---|
| `active` | getter → `true` | 视频模式下恒 `true`；非视频模式下 `window.__video` 必须**不存在**（`undefined`） |
| `fps` | getter → 数字 | 帧率（固定 60）。必须与 `--fps` 相同 |
| `width` / `height` | getter → 数字 | 固定输出分辨率（1920 / 1080）。必须与 `--width/--height` 相同 |
| `duration` | getter / **setter** | 总时长（秒）。setter 对非法值（NaN / ≤0）**忽略**，时间轴永远有限 |
| `totalFrames` | getter → 数字 | `round(duration × fps)`；帧号范围 `0 … totalFrames-1` |
| `frameIndex` | getter → 数字 | 「已推进到第几帧」；`reset()` 后为 `0`，每 `stepFrame()` 一次 **+1** |
| `simSteps` | getter → 数字 | 已执行的定长步数 = `frameIndex × 每帧步数`（供离线求解自证） |
| `reset()` | 方法 | 回到第 0 帧的**干净初始态**。**不渲染**、不重跑昂贵布局；可重复调用任意次 |
| `stepFrame()` | 方法 | **恰好推进 `1/fps` 秒**的时间轴。**不渲染** |
| `simulateFrames(n)` | 方法 | 连续推进 n 帧；不渲染（供离线求解 / 参数搜索用） |
| `render()` | 方法 | 把**当前**状态画出来；**不推进时间** |
| `commit()` | 方法 → Promise | `render()` 之后等 **2 个 rAF** 再 resolve（保证画面真上屏才抓图） |
| `captureFrame()` | 方法 → PNG data URL | 抓当前画面（canvas 页面适用；见 §4） |
| `setDrag(dx,dy)` / `release()` | 方法（**可选**） | 仅当你的动画有"拖拽 / 释放"这类输入时才需要（见 §5） |

> 表里 `active` 到最后一行共 **12 组**成员名：`active` `fps` `width` `height` `duration`
> `totalFrames` `frameIndex` `simSteps` `reset` `stepFrame` `simulateFrames` `render`
> `commit` `captureFrame` `setDrag` `release` —— 后两组是可选的。

---

## 2. 确定性时间轴：三条口径（**违反任何一条，导出就不可复现**）

1. **不许读挂钟。** 视频模式下不得用 `performance.now()` / `Date.now()` / 任何真实 deltaTime
   驱动时间轴；第 n 帧必须**只由帧号决定**。真实帧间隔会随设备负载抖动，同一份脚本在快慢两台
   机器上就会导出两条不同的时间轴。
2. **每帧固定步数。** 步长必须是**常量**（例：`FIXED_DT = 1/120`），每帧推进**恰好整数步**
   （60fps ÷ 120Hz = 2 步）。不许写"按实际耗时补步"。
3. **`reset()` 必须廉价。** 离线求解器会在一次求值里 `reset()` **上千次** →
   `reset()` **不得重跑昂贵布局、不得渲染**。谁要第 0 帧的画面，谁自己显式 `render()` / `commit()`。

> ⚠ 视频模式下**不要启动 rAF 主循环**：抓图本身会强制渲染，自带主循环会让相位被额外推进，
> 时间轴不再可复现（这正是"确定性"的前提）。

---

## 3. ⚠ CSS `animation` / `transition` 跟挂钟走，直接导出必然掉帧且不可复现

**新主题最容易栽在这一条。** 若页面用 CSS 动画 / 过渡（例如高亮渐显、卡片翻转），
浏览器是**按真实时间**推进它们的 —— 逐帧导出时每帧的 CSS 状态取决于"抓图花了多久"，
既不匀速也不可复现。

必须改成**可 seek**：暂停所有动画，然后按帧号直接写 `currentTime`：

```js
// 在 render() 里（视频模式）：
document.getAnimations().forEach(function (a) {
  a.pause();
  a.currentTime = videoFrameIndex * (1000 / VIDEO_FPS);   // 第 n 帧 = n 帧的毫秒数
});
```

再 `await commit()` 之后抓图。`getAnimations()` 覆盖 CSS animation / transition / Web Animations；
`currentTime` 单位是**毫秒**。若你用的是 JS 驱动的补间，把补间的进度也改成"由帧号算出来"。

---

## 4. canvas 页面 vs DOM/CSS 页面：抓图走哪条路

| 页面形态 | `captureFrame()` | 渲染器默认（`--capture clip`） |
|---|---|---|
| canvas / WebGL | `canvas.toDataURL('image/png')`，返回整幅 PNG | CDP `Page.captureScreenshot` + clip |
| DOM / CSS | **不适用**（没有 canvas 可 `toDataURL`） | 同上：**照样能抓**（抓的是合成结果，与用什么画无关） |

- 两条路都产出同尺寸 PNG；`render-frames.js --capture inline` 走前者，默认走后者。
- canvas 页面用 `toDataURL` 时注意：渲染器没开 `preserveDrawingBuffer` 的话，必须在**同一个 JS 任务里**
  先 `render()` 再 `toDataURL`，隔一个宏任务再抓只会拿到空图。
- DOM/CSS 页面**不需要**实现 `captureFrame()`；但 `reset/stepFrame/render/commit` 一个都不能少。

---

## 5. 脚本化输入（`setDrag` / `release`）：可选，但必须复用真人路径

- 只有你的动画真的存在"拖拽 / 释放"这类输入时才需要这两个方法；纯自动播放的动画可以整段删掉
  （渲染器只在 plan 里出现 `{drag}` / `{release}` 动作时才调用它们）。
- **必须复用真人交互的同一条代码路径**（例如真人 pointerdown 调用的那个函数），
  不要另写一套"脚本专用发射"：否则导出的片子不是这个页面真实的行为，
  而且两套逻辑一旦漂移，边界条件（截断、误触阈值、元素复位）会先出问题。
- 坐标口径由你的页面定义，**但要写进你自己的 README**，让写 plan 的人知道 `dx/dy` 是什么。

---

## 6. 门禁该断言什么（四组，照抄优先）

1. **入口存在性**：`?video=1` 下 `window.__video.active === true` 且 12 个成员齐全 / 类型正确；
   **不带参数时 `window.__video === undefined`**（默认页面不该多出全局出口）。
2. **时间轴一致**：`totalFrames === round(duration × fps)`；连续 `stepFrame()` 后
   `frameIndex` 每步 +1、`simSteps === frameIndex × 每帧步数`；`reset()` 后两者归零。
3. **确定性**：同一 plan 渲染两遍（两个不同输出目录）→ 文件名集合相同 + **逐张 md5 完全一致**；
   且**画面真的在动**（首/中/末三帧两两互不相同、去重后不同 md5 数 ≥ 总帧数的一部分）。
4. **产物**：`ffprobe` 实测时长 / 分辨率 / 帧率 / 帧数 / 编码 / 像素格式与预期一致。

> 页面自证（分辨率、`devicePixelRatio=1`、绘制区域、`totalFrames`）由 `render-frames.js` 自动做，
> 不满足就在**导出任何一帧之前**报错退出。
