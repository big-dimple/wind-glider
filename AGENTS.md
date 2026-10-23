# Wind Glider (风之翼：晴空滑翔竞速) AI 工程师行为准则与高效开发规范

> **重要**：本项目位于 `/var/www/wind-glider`。邻近的 `/var/www/board-race` 为只读参考基准，**严禁修改**。

---

## 🚫 防死循环、防屎山与务实交付五大铁律 (Pragmatic Engineering & Anti-Looping Rules)

1. **单会话单任务纪律（Strict Single Atomic Task）**：
   - 每次会话接手时，必须首先读取 [`docs/handoff.md`](docs/handoff.md) 获取当前 `[Current Active Task]`。
   - 修改范围严格限制在当前 Task 规定的目标文件与功能点内，严禁未经允许借机做大范围“顺手重构”。
2. **两轮失败强制熔断与用户反问协议（2-Strike Escalation Protocol - 核心防死循环）**：
   - **严禁在自动化测试失败时盲目陷入“改代码 -> 跑测试 -> 报错 -> 再改代码”的死循环**。
   - 如果同一项测试断言连续 **2 次失败**，AI **必须立即停止任何代码编辑与测试循环**，直接向用户汇报：
     1. 【死锁症结】：是真实功能 Bug，还是测试脚本存在硬编码时序/私有状态过度拟合？
     2. 【妥协选项】：提供 2~3 个具体可行的工程妥协方案（如放宽测试阈值、简化状态机、允许合理延迟）。
     3. 【推荐方案】：给出 AI 推荐的选项，等待用户确认后再恢复编码。
3. **黑盒实用主义与真实体验优先（Black-Box Pragmatism over Micro-Pedantry）**：
   - 以用户在真机和浏览器中的顺畅可玩性与感官体验为第一准绳。
   - 杜绝为了追求理论极端指标（如绝对 0ms、极端微秒时钟）而在工程上堆砌臃肿脆弱的黑客补丁（Hacks）。
   - 允许对 `harness/` 中脆弱的硬编码等待（如固定 `waitForTimeout(180)`）优化为健壮的状态条件等待（`waitForFunction`）或合理的容差范围。
4. **着色器与物理同源原则（Shader & Math Coherence）**：
   - 水体浮力（Gerstner 波）在 CPU 计算与 GPU GLSL 着色器中保持数学一致。
   - 严禁通过在物理层打硬编码瞬移补丁来掩盖视觉问题。
5. **纯粹性与零残留（Clean Codebase）**：
   - 禁止在代码中留下临时注释掉的大段废弃代码或悬挂的无用变量。
   - 每次正常交付后确保 TypeScript 类型检查通过（`npm run build`）。
6. **云端轻量收尾与渐进式测试归档（Lean Cloud Closeout & Progressive Test Ledger）**：
   - 云端低配环境严禁盲目跑大体量软光栅端到端测试。只要 `npm run build` 0 错误 0 警告且代码逻辑完备，若有需本地高配复核的测试点，**只在 [`docs/todo-test.md`](docs/todo-test.md) 追加 1 行超精炼记录**，严禁倾倒废话或大表格。
   - 任务完成后严格执行交接闭环：更新 [`docs/handoff.md`](docs/handoff.md)（标记 `DONE`、记入短流水、推移指针）、同步 [`docs/llmwiki.md`](docs/llmwiki.md)、清理所有后台进程。

---

## 🛠️ 常用命令与构建

- `npm run dev`：启动本地 Vite 开发服务。
- `npm run build`：生产环境 TypeScript 强类型检查与静态资产打包。
- `npm run verify:release`：执行端到端飞行、碰撞、音频、性能全量契约测试。
- `npm run release:checked`：执行安全受控发布与 GitHub 远端推送。

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
