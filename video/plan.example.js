#!/usr/bin/env node
'use strict';
/**
 * 最小 plan provider 示例（**照抄改两句就能用**）
 * ---------------------------------------------------------------------------
 * 渲染器 `video/render-frames.js --plan <本文件>` 只认一个约定：
 *
 *   module.exports.solve = async (session, cfg) => ({ fps, duration, totalFrames, actions, log, shots })
 *
 *  - `cfg` = { fps, duration, width, height }（由命令行给出；第二个参数可忽略）；
 *  - `actions[k]` = **推进到第 k 帧之前**要执行的动作（k 从 1 计；第 0 帧 = reset 后的初始态）：
 *      null               什么都不做
 *      { drag: [dx, dy] } 调 window.__video.setDrag(dx, dy)（可选接口：只要你的动画有"拖拽"输入）
 *      { release: true }  调 window.__video.release()
 *  - `actions.length` 必须 === `totalFrames`，`totalFrames` 必须 === round(fps × duration)；
 *  - `log` / `shots` 必填（渲染器无条件打印，是你自己的里程碑台账）。
 *
 * 本示例：第 30 帧放行 → 之后每 45 帧推一把。替换成你自己的剧本即可。
 * `session` 可用来在页面里跑离线求解（`session.evaluateAwait('window.__video.simulateFrames(600)')`）。
 */

module.exports.solve = async (session, cfg) => {
  const fps = cfg.fps, duration = cfg.duration;
  const totalFrames = Math.round(fps * duration);
  const actions = new Array(totalFrames).fill(null);
  if (totalFrames > 30) actions[30] = { release: true };   // 放行：让元素自己动起来
  for (let k = 46; k < totalFrames; k += 45) actions[k] = { drag: [0, 0] };  // 周期性推一把
  return {
    fps, duration, totalFrames, actions,
    log: ['示例剧本：第 30 帧放行，之后每 45 帧推一把（共 ' + totalFrames + ' 帧）'],
    shots: [{ index: 30, label: '放行' }]
  };
};
