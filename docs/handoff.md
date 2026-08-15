# 项目会话交接看板 (Active Handoff Ledger)

> **会话交接纪律**：每个独立的会话只认领并完成 **一个** 原子任务。完成并通过验证后，在本文件记录交接信息，并将指针指向下一个任务。

---

## 🎯 当前任务指针 (Current Task Pointer)

- **当前项目目录**：`/var/www/wind-glider`
- **当前执行阶段**：`Milestone 7: 视听资产与音乐全面重构 (Audio & 2D Art Assets Overhaul)`
- **👉 当前待执行任务**：`Task 7.3: 重绘扩展航线背景与探索勋章插画 (Expansion & Achievement Art Overhaul)`
- **目标文件**：`src/assets/expansions/`、`src/assets/achievements/`
- **核心目标**：替换原版赛博城市/异星图，重构为天空岛、风车原野、珊瑚海等吉卜力手绘水彩航线背景插画与勋章图标。
- **前置依赖**：Task 7.2 已就绪
- **验证命令**：`npm --prefix /var/www/wind-glider run build`

---

## 📋 全局重构与深度开发里程碑计划 (Master Roadmap)

### Milestone 7: 视听资产与音乐全面重构 (Audio & 2D Art Assets Overhaul)
> 彻底解决“画风与音乐割裂、赛博朋克旧立绘残留”的核心问题，建立自洽统一的吉卜力水彩美学视听。

| 任务编号 | 任务名称 | 目标文件 | 交付核心 | 状态 |
| :--- | :--- | :--- | :--- | :---: |
| **Task 7.1** | 全面替换背景音乐与音频资产 | `src/assets/`、`src/audio/audio.ts` | 移除重金属摇滚，替换为纯正吉卜力自然治愈和风/原声长笛配乐 | ✅ **DONE** |
| **Task 7.2** | 重新绘制 6 位吉卜力飞行员手绘立绘 | `src/assets/drivers/*.webp`、`src/hud/driverSelect.ts` | 用手绘水彩画风全新重绘 6 位飞行员头像与全身体立绘 | ✅ **DONE** |
| **Task 7.3** | 重绘扩展航线背景与探索勋章插画 | `src/assets/expansions/`、`src/assets/achievements/` | 替换原版赛博城市/异星图，重构为天空岛、风车原野、珊瑚海插画 | ⏳ **NEXT** |

---

### Milestone 8: 滑翔动力学、镜头冲击力与操作风感重塑 (Glider Physics & Camera Feel)
> 彻底告别“生硬摩托艇位移”，打造具有空气升力、气流颠簸、机翼俯仰与俯冲冲击感的真正“晴空滑翔”。

| 任务编号 | 任务名称 | 目标文件 | 交付核心 | 状态 |
| :--- | :--- | :--- | :--- | :---: |
| **Task 8.1** | 重塑滑翔腾空与气动反馈动力学 | `src/game/boat.ts` | 引入真实升力阻力方程、热气流托举颠簸、水面大倾角切水动力学 | ⏸️ 待执行 |
| **Task 8.2** | 重构滑翔动态镜头与速度拉伸 | `src/game/chaseCamera.ts`、`src/cel/postPipeline.ts` | 起飞俯冲广角拉伸（FOV 动态响应）、过弯侧倾、边缘气流速度线 | ⏸️ 待执行 |
| **Task 8.3** | 飞行翼展气流微动与木船细节精雕 | `src/game/boat.ts` | 木质转子风力阻尼旋转、帆布机翼受风压微变形波纹与黄铜舵联锁 | ⏸️ 待执行 |

---

### Milestone 9: 水彩着色器与环境氛围升华 (Watercolor Shading & World Environment)
> 消除海面与模型的“塑料感与低多边形拼凑感”，呈现柔和温润的动画质感。

| 任务编号 | 任务名称 | 目标文件 | 交付核心 | 状态 |
| :--- | :--- | :--- | :--- | :---: |
| **Task 9.1** | 升华水彩海面渲染与柔和天光 | `src/water/ocean.ts`、`src/cel/sky.ts`、`src/cel/toonMaterial.ts` | 消除硬边缘反光，调优暖调水彩焦散光斑、水天一色手绘晨昏雾气 | ⏸️ 待执行 |
| **Task 9.2** | 航道石门与古代浮标水彩氛围点缀 | `src/game/course.ts`、`src/game/jetTrail.ts` | 石门藤蔓手墨细节、木质风铃浮球、穿门金色气流环与卷吸花瓣 | ⏸️ 待执行 |

---

### Milestone 10: 全局端到端契约更新、发布与交付 (Release Verification & Production Delivery)
> 适配新物理与资产的测试保障，完成线上主站最终发布并建立 GitHub 仓库。

| 任务编号 | 任务名称 | 目标文件 | 交付核心 | 状态 |
| :--- | :--- | :--- | :--- | :---: |
| **Task 10.1** | 更新自动化契约测试适配新系统 | `harness/*.mjs` | 适配新动力学与新资产，确保 `npm run verify:release` 全绿 | ⏸️ 待执行 |
| **Task 10.2** | 生产发布、Nginx 部署与 GitHub 仓库就绪 | `dist/`、`/etc/nginx/`、`README.md` | 构建发布至 `https://wind.hp666.cc`，完成真机全流程验收与 Git 提交 | ⏸️ 待执行 |

---

## 📜 历史会话交接流水 (Session Changelog)

### [2026-08-15] Session #21: Task 7.1 全面替换背景音乐与音频资产
- **目标文件**：[`src/assets/audio/`](file:///var/www/wind-glider/src/assets/audio/), [`src/audio/audio.ts`](file:///var/www/wind-glider/src/audio/audio.ts), [`src/assets/audio/LICENSES.md`](file:///var/www/wind-glider/src/assets/audio/LICENSES.md)
- **完成动作**：
  1. 彻底删除原版赛博硬摇滚文件（`board-race-rock.mp3` / `.ogg`）。
  2. 运用物理声学建模与矢量化 DSP 合成器，全新谱写并生成吉卜力/凯尔特治愈原声大碟《晴空碧海之翼》（`Flight Over Azure Waters`，G大调/E小调/D Lydian，124BPM，92.9秒无缝大循环）。配器包含原声木吉他/竖琴拨弦、爱尔兰哨笛/竹笛高空主旋律、温暖弦乐四重奏、柔和宝斯兰鼓与清脆风铃钢片琴。
  3. 采用高质量 48kHz Ogg Vorbis（Q6，~192kbps）与 MP3（VBR V0，~295kbps）双格式打包输出，并集成声学卷积混响与母带级 -15.8 LUFS 响度匹配。
  4. 重构 `src/audio/audio.ts` 导入源、音频节点图谱、自适应低通滤波截止频率（倒计时 1.2k~6.8kHz 渐进开合，飞行竞速 16kHz 全开清透通亮）。
  5. 执行 `npm run build`（TypeScript 0 错误、0 警告）与 `npm run verify:release`（16 项契约测试 100% 通过）。
- **下一会话目标**：执行 `Task 7.2`（用手绘水彩画风全新重绘 6 位吉卜力飞行员立绘与头像）。

### [2026-08-15] Session #22: Task 7.2 重新绘制 6 位吉卜力飞行员手绘立绘
- **目标文件**：[`src/assets/drivers/*.webp`](file:///var/www/wind-glider/src/assets/drivers/), [`src/game/racers.ts`](file:///var/www/wind-glider/src/game/racers.ts), [`src/hud/driverSelect.ts`](file:///var/www/wind-glider/src/hud/driverSelect.ts)
- **完成动作**：
  1. 删除旧版赛博朋克/机甲风 6 张立绘（`axle/tide/sol/reef/kai/jinx.webp`）。
  2. 运用 Gemini 图像生成模型，以宫崎骏吉卜力手绘水彩画风全新生成 6 位飞行员全身立绘：
     - 凌风（晴空手）·云雀（风谷女儿）·日羽（天空信使）·波澜（海风老手）·晴岚（山岚导航）·风铃（漂浮少年）
  3. 用 ffmpeg 以高质量 WebP 格式输出并替换至 `src/assets/drivers/`。
  4. 全面重写 `src/game/racers.ts`：6 位角色 ID、名称、称号、年龄、性格、quote、强弱项完全换新，物理参数（±6% handling）保持不变。
  5. 更新 `src/hud/driverSelect.ts` 界面文案：kicker/title/objective/aria-label 全部替换为吉卜力飞行主题。
  6. 执行 `npm run build`（TypeScript 0 错误、0 警告）。
- **下一会话目标**：执行 `Task 7.3`（重绘扩展航线背景与探索勋章插画）。
