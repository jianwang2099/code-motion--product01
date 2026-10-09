# verify/card-01 · 《元素周期表简介》24 秒成片 · 证据与复现

> 对应任务卡：`storyboard/card-01.md`（状态：审卡通过 + PM 已确认下发，**待人验收**）
> 门禁：`node verify/card-01/gate.js` —— 退出码 0 = 全通过，打印 `N passed, M failed`

---

## 1. 一句话复现

```bash
# ① 预览服务（受管后台作业，端口 5174；5173 被旧项目占用，不要用）
python3 -m http.server 5174 --bind 127.0.0.1        # cwd = 工作区根

# ② 出片（1440 帧 → MP4；实测约 4 分钟）
node video/make-video.js --plan video/plan.js --url http://127.0.0.1:5174/index.html \
  --duration 24 --out video/out/periodic-table-24s.mp4

# ③ 确定性对照（第二遍，输出到另一个目录）
node video/render-frames.js --plan video/plan.js --url http://127.0.0.1:5174/index.html \
  --duration 24 --out video/frames-run2

# ④ 序列帧断言（此时 frames-run2 在，C3 做**真比对**：逐张 md5 必须一致）
node verify/card-01/video-frames-check.js

# ⑤ 清掉中间产物（frames-run2 未进 .gitignore，留着会污染提交）
rm -rf video/frames-run2 video/frames-smoke

# ⑥ 完整门禁（收尾态；C3 记为 SKIP 而非假通过，并断言 run2 确实已删）
node verify/card-01/gate.js --allow-missing-run2
```

> **为什么有两个入口**：C3 需要 `frames-run2/` **存在**才能逐张比对，
> 而"比完即删"又是一条要求——两条不可能同时成立。所以：
> `video-frames-check.js` 在 run2 存在时做真比对；`gate.js --allow-missing-run2`
> 用于**收尾态**，把 C3 显式记为 `⚠ SKIP`（**没比对 ≠ 声称通过**）并断言 run2 已删除。
> 不带 `--allow-missing-run2` 跑 gate 时，缺 run2 会**判失败**并打印该怎么跑。

⚠️ **三条命令级硬约束**（少一条就会出错片或毁产物）：

1. **必须显式传 `--url http://127.0.0.1:5174/index.html`**
   —— `render-frames.js` / `make-video.js` 的默认 URL 是 `5173`，那是**旧项目**的页面。
2. **必须显式传 `--out video/out/periodic-table-24s.mp4`**
   —— `make-video.js` 的 `--out` 默认是 `video/out/video.mp4`，D1 断言的文件名不是它。
3. **冒烟必须换输出目录**：`--limit 120 --frames video/frames-smoke`
   —— `render-frames.js` 导出前会**先清空输出目录里的 `frame_*.png`**，
   直接冒烟到 `video/frames/` 会把已渲染好的 1440 张全删掉。

---

## 2. gate.js 覆盖了什么 / 不覆盖什么

| 组 | 断言 | 手段 |
|---|---|---|
| A1 | `index.html` 无 `animation:`/`transition:`/`@keyframes`/`getAnimations`/`currentTime` | `fs.readFileSync` **词法检查** |
| A2 | `?video=1` 下 12 组成员的类型与取值；非法 `duration`(NaN/0/-5) 被忽略；不多挂契约外键 | CDP |
| A3 | `reset()` 后归零；连续 120 次 `stepFrame()` 后 `frameIndex===k`、`simSteps===k×2` | CDP |
| A4 | `reset()` 三次抓图 md5 相同；且 **≠** 推进 700 帧后的 md5（非平凡） | CDP + `Page.captureScreenshot` |
| A5 | 无 query 时 `window.__video === undefined` | CDP（独立会话） |
| A6 | 连续 `render()` 三次不推进 `frameIndex`/`simSteps`，且抓图 md5 稳定 | CDP |
| A7 | `shots/` ≥6 张、命名 `NN_<帧号>_<镜头>.png`、覆盖 7 个关键帧号 | 文件系统 + CDP 抓图 |
| B1 | `video/plan.js` 的 `solve()` 返回 `fps/duration/totalFrames/actions.length` 正确，`log`/`shots` 合规 | Node `require` |
| B2 | `actions` 1440 项全为 `null` | Node |
| B3 | 段边界 `frame(419)≠frame(420)`、`frame(1019)≠frame(1020)`（页面端帧哈希） | CDP |
| C1 | `video/frames/` 连续 1440 张、每张 IHDR 1920×1080 | `video-frames-check.js` |
| C2 | 相邻帧两两必不同（0 次相等）；去重 md5 ≥1300；段边界帧不同；第 0 帧非空屏 | 同上 |
| C3 | `frames/` 与 `frames-run2/` 逐张 md5 一致；且 `frames-run2/` 已删除 | 同上 |
| D1/D2 | `ffprobe`：h264 / yuv420p / 1920×1080 / 60-1 / 1440 帧 / 24±0.1 s；体积 >100 KB | `ffprobe` |

**门禁不覆盖（由人判）**：画面好不好看、构图是否舒服、节奏是否合适。→ 见 §3 的截图。

**门禁不渲染序列帧**：C/D 断言只读已存在的产物；缺产物会明确报失败并打印"需先出片"。

---

## 3. 截图映射表（人工验收入口）

`node verify/card-01/gate.js` 每次都会**重写**下列 7 张图（抓图路径与流水线完全一致：
CDP `Page.captureScreenshot` + clip `0,0,1920,1080`, scale 1）。

| 文件 | 帧 | 秒 | 这张图证明什么 |
|---|---|---|---|
| `shots/01_00000_opening-wide.png` | 0 | 0.00 | ① 起手：36 格**散落全景**（都在画面内、角度各异）；也证明 C2(d) 首帧非空屏 |
| `shots/02_00329_assembly-end.png` | 329 | 5.48 | ① 归位完成：完整 4 行 × 18 列周期表（H 与 He 分居两端） |
| `shots/03_00419_stage1-end.png` | 419 | 6.98 | ① 末帧：仍在呼吸（不停帧）→ 支撑 C2(a) |
| `shots/04_00620_halogen-start.png` | 620 | 10.33 | ② 卤素段起手：族名标签 + 扫描条入场 |
| `shots/05_01020_carbon-start.png` | 1020 | 17.00 | ③ 起手：碳格开始放大 |
| `shots/06_01100_carbon-centered.png` | 1100 | 18.33 | ③ 放大完成：碳在中央 + 电子云（K 层 2 / L 层 4） |
| `shots/07_01439_final.png` | 1439 | 23.98 | ③ 末帧：成片收尾，电子云仍在转 |

**实测视口尺寸**：`1920×1080`，`devicePixelRatio = 1`
（由页面自证输出给出：`viewport:"1920x1080"`、`canvasBuf:"1920x1080"`、`dpr:1`）。
注意：无头浏览器的 `--window-size` 不可信，尺寸由 CDP `Emulation.setDeviceMetricsOverride` 钉死，
**以页面内实测值为准**。

---

## 4. 成片中可复算的指纹

出片后由门禁打印/断言（此处不写死数字，避免与本文件之外的实现漂移）：

```bash
md5 video/out/periodic-table-24s.mp4
ffprobe -v error -select_streams v:0 -show_entries stream=width,height,avg_frame_rate,nb_frames,codec_name,pix_fmt \
  -of default=noprint_wrappers=1 video/out/periodic-table-24s.mp4
```

---

## 5. 本卡踩过的坑（都已变成断言或写进文档）

1. **`EL.map` 里数组下标取错**：内层 `e[3]` 恒为 `0` → 36 个格子的 y 全算成第 0 行，
   周期表被压成一行、元素叠成一团。→ 现在位置由「周期 + 列」**直接**算出，不做二次推导。
2. **散落起点用了线性取模**（`(i*127)%361`）：相邻序号高度相关 → 36 格重叠且全挤在左侧。
   → 改为 xorshift 哈希（`hash32`），并在 ±185 内夹紧，保证**第 0 帧 36 格全在画面内**。
3. **前 8 帧近乎空屏**：格子起点在画面外 + 亚像素变化 → 相邻帧 PNG **完全相同**，C2(a) 必红。
   → 起点移入画面 + 呼吸幅度加到 3% + 背景独立呼吸（±8 px）。
4. **网格线"生长"是假的**：`gp` 很小时竖线已铺满整宽。→ 线段长度也按 `gp` 缩放。
5. **电子云被压在碳格下面**：核挡住元素符号、轨道缩在格内。
   → 改为先画碳格再叠电子云，并按放大倍数缩放轨道半径。
6. **渲染速度**：36 格 × 每帧两次 `shadowBlur` 是头号开销（实测 9.1 → 6.0 帧/s）。
   → 未高亮时（`glow === 0`）跳过 shadow，视觉等价。
