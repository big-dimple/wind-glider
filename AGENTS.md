# Wind Glider (风之翼：晴空滑翔竞速) AI 工程师行为准则与项目红线

> **重要**：本项目位于 `/var/www/wind-glider`。邻近的 `/var/www/board-race` 为只读参考基准，**严禁修改**。

---

## 🚫 防屎山与防跑偏四大铁律 (Anti-Spaghetti & Anti-Drift Rules)

1. **单会话单任务纪律（Strict Single Atomic Task）**：
   - 每次会话接手时，必须首先读取 [`docs/handoff.md`](docs/handoff.md) 获取当前 `[Current Active Task]`。
   - **严禁跨任务开发或借机做“顺手重构”**。修改范围必须严格限制在当前 Task 规定的目标文件与功能点内。
2. **纯粹性与零无用残留（Zero Dead Code & Zero Hack）**：
   - 禁止在代码中留下临时注释掉的大段废弃代码、未使用的变量/导入或临时 mock 函数。
   - 每次修改后必须通过 `npm run build` 确保 TypeScript 强类型校验 0 错误、0 警告。
3. **着色器与物理同源原则（Shader & Math Coherence）**：
   - 水体浮力（Gerstner 波）在 CPU 计算与 GPU GLSL 着色器中必须保持 100% 数学一致。
   - 严禁通过在物理层打补丁（如硬编码传送、瞬移、强制吸附）来解决视觉问题。
4. **交接与闭环纪律（Mandatory Handoff Closeout）**：
   - 任务完成后，必须运行构建测试。
   - 必须同步更新 [`docs/handoff.md`](docs/handoff.md) 与 [`docs/llmwiki.md`](docs/llmwiki.md)，明确记录修改内容，并将当前任务标记为 `DONE`，推移指针至下一个任务。

---

## 🛠️ 命令与构建

- `npm run dev`：启动本地 Vite 开发服务。
- `npm run build`：生产环境 TypeScript 强类型检查与静态资产打包。
- `npm run verify:release`：执行端到端飞行、碰撞、音频、性能全量契约测试。

---

## 📐 架构与文件责任地图

- **调色与基底**：`src/core/palette.ts`（全局唯一颜色事实源）。
- **着色器体系**：
  - `src/cel/toonMaterial.ts`：4阶手绘水彩渐变着色器与天光漫射。
  - `src/cel/outline.ts`：Inverted-hull 手绘深褐墨线。
  - `src/cel/sky.ts`：手绘晴空穹顶与蓬松积雨云层。
  - `src/water/ocean.ts`：无缝水下焦散与蕾丝泡沫海面。
- **载具与动力学**：
  - `src/game/boat.ts`：复古木质水翼滑翔艇参数化建模与 60Hz 动力学。
  - `src/game/course.ts`：航道、青藤古代石门与穿门判定。
  - `src/water/spray.ts` & `src/game/jetTrail.ts`：水彩水滴、白色风流线与飘落花瓣粒子。
- **UI 与音频**：
  - `src/hud/hud.ts` & `src/hud/hud.css`：纸质羊皮质感仪表盘与风车能量槽。
  - `src/audio/audio.ts`：木船击水、清脆风铃与气流音效。
- **确定性契约测试**：`harness/` 目录。
- **真相文档**：
  - 人读全景：[`README.md`](README.md)
  - AI渐进式维基：[`docs/llmwiki.md`](docs/llmwiki.md)
  - 实时交接看板：[`docs/handoff.md`](docs/handoff.md)
