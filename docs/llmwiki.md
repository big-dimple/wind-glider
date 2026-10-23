# 风之翼：晴空滑翔竞速 (Wind Glider) AI 运行手册与开发维基

> **文档性质**：面向接手代码的 AI Agent 的渐进式披露（Progressive Disclosure）技术维基。
> **核心原则**：记录确定性事实、硬性约束、超细粒度任务注册表与跨会话交接协议。

---

## 📌 Level 0: 30秒快速恢复上下文

1. **项目定位**：基于 Three.js + TypeScript 的吉卜力水彩手绘风竞速游戏（复刻自 Board Race 引擎），运行于 `/var/www/wind-glider`。
2. **核心机制**：自动推进 + 左右转向 + `Shift` 水面切水漂移/空中空刹 + `Space` 展开帆布滑翔翼起飞/续航 + 穿过 7 道古代石门冲向终点站。
3. **单会话开发纪律（Single Task Per Session）**：
   - **一个会话只做一件原子任务**（严禁擅自扩大范围或跨任务开发）。
   - **完成即更新 Handoff**：每个任务完成后，必须通过验证并更新 `docs/handoff.md` 与本文件末尾的 `Active Handoff State`。
   - **严禁破坏物理与输入合同**：`BoatInput`、60Hz fixed-step 仿真、Gerstner 5波浮力采样、飞行回收惯性必须 100% 保持确定性。
4. **常用命令**：
   - 构建验证：`npm run build`
   - 契约验证：`npm run verify:release`
   - 发布验证：`npm run release:checked`
   - 本地开发：`npm run dev`

---

## 🏛️ Level 1: 核心架构与底层硬约束

### 1.1 目录结构与职责划分
```
/var/www/wind-glider/
├── src/
│   ├── contracts.ts          # 跨系统共享接口 (IBoat, ICourse, IWake, ISpray, BoatState)
│   ├── core/
│   │   ├── palette.ts        # 全局调色板单一事实源
│   │   ├── stage.ts          # WebGL渲染器、自适应DPR、抗锯齿配置
│   │   ├── loop.ts           # 60Hz 确定性物理模拟主循环
│   │   ├── input.ts          # 统一输入契约 BoatInput (键盘/手柄/触控)
│   │   └── abilityTelemetry.ts # 漂移蓄力与飞行库存派生数据
│   ├── cel/
│   │   ├── toonMaterial.ts   # 手绘水彩 Toon 着色器 (Ramp阶梯、暖调天光、微抖墨线)
│   │   ├── outline.ts        # Inverted-hull 几何描边
│   │   ├── edgePass.ts       # Sobel 法线/深度边缘检测 (结构线)
│   │   ├── sky.ts            # 蓬松积雨云层与手绘天空穹顶
│   │   └── postPipeline.ts   # 后处理管道 (柔和Bloom、风流速度线)
│   ├── water/
│   │   ├── waves.ts          # Gerstner 5波定义 (CPU水高采样与GPU着色器完全同源)
│   │   ├── ocean.ts          # 无缝海洋网格、水下焦散(Caustics)、蕾丝浪沫(Foam Lace)
│   │   ├── wake.ts           # 船体航迹水纹与水彩消散
│   │   └── spray.ts          # 水花水滴与飞舞花瓣粒子系统
│   ├── game/
│   │   ├── boat.ts           # 复古木质滑翔艇参数化拓扑建模与动力学状态机
│   │   ├── course.ts         # 赛道采样、CatmullRom/CubicBezier 航线与门判定
│   │   ├── jetTrail.ts       # 白色风流线与蒲公英飞舞拖尾
│   │   └── race.ts           # 比赛状态机 (READY -> 3·2·1·GO -> 飞越 -> 终点庆典)
│   └── hud/
│       ├── hud.ts            # 纸质羊皮质感仪表盘、风车充能槽、倒计时
│       └── finaleCelebration.ts # 黄金风向标终点站与花瓣彩纸盛典
└── docs/
    ├── llmwiki.md            # 本文件 (AI 渐进式维基与原子任务注册表)
    └── handoff.md            # 跨会话实时交接看板
```

### 1.2 物理与状态机硬约束
- **漂移与能量存储**：水面漂移达到黄色合格线后松开，存储 1 颗风力能量石（最多存 2 颗）。漂过黄线只延长水面 Boost 时间，不增加单次基础飞行时长。
- **飞行包络**：起飞基础包络 `6.45s`，巡航/下降期可消耗备用能量石续航 `+2.4s`（总计 `8.85s`）。
- **穿门惯性**：通过石门后进入下降阶段，**严禁 Teleport、Snap 或强制清空水平速度/朝向**，必须保留真实物理惯性滑翔至水面。
- **航道所有权**：全场视野内有且仅有一个主引导分支处于激活高亮状态。

---

## 🎨 Level 2: 吉卜力 / Solarpunk 美术规范

### 2.1 调色板定义 (`src/core/palette.ts`)
| 标识符 | 建议 HEX | 语义与用途 |
| :--- | :--- | :--- |
| `skyZenith` | `0x4A90E2` | 晴空天顶天青色 |
| `skyHorizon` | `0xE8F4F8` | 地平线暖白色（带微弱朝霞光晕） |
| `sun` | `0xFFF176` | 暖黄色太阳与漫射天光 |
| `seaShallow` | `0x26C6DA` | 浅滩/近景绿松石透亮水体 |
| `seaDeep` | `0x1565C0` | 深水区宝蓝色 |
| `seaFoam` | `0xFFFFFF` | 蕾丝浪尖泡沫与彩虹水雾 |
| `boatWood` | `0x8D6E63` | 柚木船身基色 |
| `boatWoodDark`| `0x5D4037` | 龙骨与深色木质构件 |
| `boatBrass` | `0xFFB300` | 黄铜包边与旋翼构件 |
| `gliderCanvas`| `0xFFF8E1` | 手织帆布米白色滑翔翼 |
| `stoneAncient`| `0xFAF0E6` | 古代石拱门白垩石材质 |
| `vineGreen` | `0x81C784` | 石门藤蔓嫩绿叶色 |

### 2.2 水彩着色器标准 (`src/cel/toonMaterial.ts`)
- **阶梯着色**：采用 `[0.45, 0.65, 0.85, 1.0]` 4 阶暖调水彩 ramp，暗部保留环境天光色，禁止死黑。
- **边缘墨线**：Inverted-hull 几何描边使用深暖褐色（`#2C1D11`），线宽随视距轻微缩放。

---

## 📋 Level 3: 超细粒度原子任务注册表 (Atomic Task Registry)

> **执行原则**：每次开发会话**严格选取一个未完成的 Task 执行**。完成后执行构建与测试，记录成果并递交 Handoff。

### Phase 1: 视觉基石与着色器重构 (Shaders & Palette)
- [x] **Task 1.1**：在 `src/core/palette.ts` 中重构全局调色板为吉卜力暖色调水彩 Token，并保证导出类型契约兼容。
- [x] **Task 1.2**：改造 `src/cel/toonMaterial.ts` 的光照模型与 1D 水彩 Ramp 生成器，引入暖调天光漫射。
- [x] **Task 1.3**：在 `src/cel/outline.ts` 与 `src/cel/edgePass.ts` 中将描边颜色替换为手绘深暖褐色墨线，并调优线宽衰减与水彩渗墨混合。
- [x] **Task 1.4**：重构 `src/cel/sky.ts` 为双层手绘晴空穹顶与阶梯明暗的初级层积云。

### Phase 2: 碧海焦散与晴空云海 (Ocean & Cloudscape)
- [x] **Task 2.1**：在 `src/water/ocean.ts` 的片段着色器中实现双层 Voronoi 水下焦散（Caustics）光斑算法。
- [x] **Task 2.2**：在 `src/water/ocean.ts` 中实现波峰蕾丝浪花（Foam Lace）与近岸/船体接触边缘水彩消散。
- [x] **Task 2.3**：在 `src/cel/sky.ts` 中实现动态漂浮的蓬松手绘积雨云群（Cumulonimbus）与阳光光芒。

### Phase 3: 木质滑翔艇与自然粒子 (Vehicle & Nature Particles)
- [x] **Task 3.1**：在 `src/game/boat.ts` 中用参数化几何体构建柚木水翼船身、龙骨与黄铜包边（替换原塑料快艇）。
- [x] **Task 3.2**：在 `src/game/boat.ts` 中增加折叠帆布滑翔翼与木质旋翼，绑定起飞展开动画状态。
- [x] **Task 3.3**：在 `src/water/spray.ts` 中将切水喷射粒子改造为半透明水彩水滴与彩虹水雾。
- [x] **Task 3.4**：在 `src/game/jetTrail.ts` 中实现白色风流线粒子（Wind Trails）与空中飞舞的花瓣/蒲公英粒子。

### Phase 4: 古代石门航道与终点站 (Gates & Finale)
- [x] **Task 4.1**：在 `src/game/course.ts` 中重构飞行引导门为缠绕青藤的古代白石拱门（Ancient Stone Torii/Arches）。
- [x] **Task 4.2**：在石门两侧挂置迎风摆动的彩色风马旗与古朴风铃标志。
- [x] **Task 4.3**：在 `src/hud/finaleCelebration.ts` 与 `src/game/course.ts` 中重构终点站为金色风向标大门，并在通关时释放漫天花瓣彩纸庆典。

### Phase 5: 纸质羊皮HUD与交互音效 (HUD & Audio)
- [x] **Task 5.1**：在 `src/hud/hud.ts` 与 `hud.css` 中重构仪表盘为手绘羊皮纸底纹与原木质感。
- [x] **Task 5.2**：将飞行库存钻石图标替换为旋转小风车（Windmill）或轻盈羽毛能量指示器。
- [x] **Task 5.3**：重构 3·2·1·GO 起航倒计时与速度计为手写水墨笔画质感。
- [x] **Task 5.4**：在 `src/audio/audio.ts` 中调优木质破浪声、风声呼啸与风铃起飞音效合成器。

### Phase 6: 初版框架验证与上线 (Base Verification & Staging)
- [x] **Task 6.1**：运行全局端到端测试与物理契约验证 `npm run verify:release`。
- [x] **Task 6.2**：配置 Nginx 站点，将一级域名 `https://hp666.cc` 指向风之翼。

### Milestone 7: 视听资产与音乐全面重构 (Audio & 2D Art Assets Overhaul)
- [x] **Task 7.1**：在 `src/assets/` 与 `src/audio/audio.ts` 中彻底替换原版重金属摇滚 BGM 为治愈和风/原声吉他/风笛自然风配乐。
- [x] **Task 7.2**：在 `src/assets/drivers/*.webp` 与 `src/hud/driverSelect.ts` 中重新绘制 6 位吉卜力风格飞行员头像与立绘（凌风/云雀/日羽/波澜/晴岚/风铃）。
- [x] **Task 7.3**：在 `src/assets/expansions/` 与 `src/assets/achievements/` 中重绘天空岛、风车原野、珊瑚海等吉卜力手绘水彩航线背景与探索勋章。

### Milestone 8: 晴空滑翔动力学与 3D 空气动力引擎 (Glider Aerodynamics & Flight Mechanics)
- [x] **Task 8.1**：在 `src/game/boat.ts` 中重塑空气动力学核心——引入真实迎角（AoA）升力阻力方程、俯冲换速与仰冲爬升模型。
- [x] **Task 8.2**：在 `src/game/boat.ts` 与 `src/game/jetTrail.ts` 中实现翼地效应 (Ground Effect) 与贴海/贴岩掠行共鸣机制。
- [x] **Task 8.3**：在 `src/game/course.ts` 与 `src/game/boat.ts` 中引入上升暖气流柱 (Thermal Updrafts) 与高空风道弹射机制。

### Milestone 9: 3D 奇观航道、引导光带与自然环境升华 (3D Wonder Course & Visuals)
- [x] **Task 9.1**：在 `src/game/course.ts` 中构建三维立体奇观航道——高崖弹射起飞、珊瑚礁穿插、盘旋天梯与遗迹空中悬廊。
- [x] **Task 9.2**：在 `src/game/course.ts` 与 `src/cel/edgePass.ts` 中实现 3D 动态气流引导带与远景天光地标锚点系统，彻底解决赛道显示与迷路痛点。
- [x] **Task 9.3**：在 `src/water/ocean.ts`、`src/cel/sky.ts`、`src/cel/toonMaterial.ts` 中升华软调水彩天光、蓬松体积积雨云与通透珊瑚海焦散。
- [x] **Task 9.4**：在 `src/game/chaseCamera.ts` 与 `src/cel/postPipeline.ts` 中重构飞行动态镜头与沉浸感风感反馈 (FOV 呼吸缩放、俯冲拉远广角张开、仰冲拉近收拢、柔和机体侧倾过载、手绘水彩水墨风流线速度线)。

### Milestone 10: 羊皮纸飞行仪表盘、风语交互与音效升华 (Flight HUD & Audio Feel)
- [x] **Task 10.1**：在 `src/hud/hud.ts` 与 `src/hud/hud.css` 中重构航空高度仪、空速节数计与风之共鸣槽极简手绘 HUD。
- [x] **Task 10.2**：在 `src/audio/audio.ts` 中合成滑翔动态气流呼啸、木翼震颤、穿环风铃与海鸥环境音效。

### Milestone 11: 全量契约测试适配、生产构建与发布交付 (Verification & Staging)
- [x] **Task 11.1**：更新 `harness/*.mjs` 端到端自动化契约测试适配新 3D 飞行系统，确保 `npm run verify:release` 全绿。
- [x] **Task 11.2**：构建生产包发布至 `https://wind.hp666.cc`，完成真机全流程验收与 Git 仓库提交准备。

### Milestone 12: 触控操作与全平台体验升华 (Mobile Floating Controls & Cross-Platform Refinement)
- [x] **Task 12.1**：在 `src/core/mobileControls.ts`、`src/core/mobileControls.css` 与 `src/core/input.ts` 中实现左侧动态浮动黄铜罗盘摇杆、右侧双动作气泡与按键长按恢复。
- [x] **Task 12.2**：在 `src/game/boat.ts` 与 `src/contracts.ts` 中实现空中刹车落地切入切水漂移与智能防砸地面/水面气垫保护。
- [x] **Task 12.3**：在 `src/game/course.ts`、`src/hud/hud.ts` 与 `src/core/haptics.ts` 中实现世界坐标手绘木质转弯立牌/浮标、HUD 航向与俯冲提示增强，以及触控震动反馈调优。

### Milestone 13: 白垩海湾、红瓦风车海滨村落与世界生态重构 (Chalk Haven & Living Ecosystem)
- [x] **Task 13.1**：在 `src/game/course.ts` 与 `src/core/palette.ts` 中彻底废除暗黑海中孤山，构建白垩海岬与翡翠草坡台地、地中海红瓦白墙木屋群、4叶旋转大风车、木质滑翔起飞跑道，以及惊飞海鸥群、跃水海豚与飘散蒲公英生态系统。
- [x] **Task 13.2**：在 `src/game/course.ts` 与 `src/cel/sky.ts` 中构建高空拉普达浮岛回廊（象牙白石倒锥浮空岛群、古罗马双层引水渠悬廊、古代太阳神殿与风向标日晷、飘扬五色祈风彩旗、+14m/s金色暖气流柱与高空穿云水粉层叠积雨云海）。

### Milestone 14: 终极水彩飞行员群像与吉卜力管弦巅峰原声 (Ultimate Roster & Ghibli Orchestral Peak)
- [x] **Task 14.1**：升级 6 位终极手绘飞行员档案（苏轼/清照/萧峰/舟伯通/孔明/娃娃）与 640x960 2:3 水彩立绘，生成 3 首吉卜力管弦巅峰交响乐（晴空碧海/天空之城/红猪），并在 `src/audio/audio.ts` 中实现动态随机洗牌循环（Shuffle Loop）与无缝交叉淡入淡出（Crossfade）。
- [x] **Task 14.2**：在 `src/game/boat.ts`、`src/game/racers.ts` 与 `src/game/rider.ts` 中构建 3D 飞行员入舱角色系统（6 位飞行员专属 3D 外观与护目镜/发型/头饰）、灵动身体姿态动力学（水平压弯侧倾、俯冲前倾低风阻流线姿态、仰冲拉杆抬头姿态）与 5 节多质点弹簧动态随风长围巾/披风物理。
- [x] **Task 14.3**：在 `src/game/boat.ts` 中构建 6 款飞行员专属机体拓扑与展开机械翼（晴空信天翁/风谷蜻蜓/赤炎狂龙/顽童重锤/卧龙天机/彩虹雨燕），在 `src/game/course.ts` 中打造 70m 海天巨拱黄金太阳风向标终点凯旋大门与 36 面祈风流苏彩旗阵，在 `src/audio/audio.ts` 与 `src/hud/finaleCelebration.ts` 中升级久石让胜利交响大管弦原声与群鸟翱翔礼花盛典。

### Milestone 15: 纯正吉卜力水彩原画着色器与手绘视界升华 (Pure Ghibli Watercolor Shaders & Hand-Drawn Realm)
- [x] **Task 15.1**：在 `src/cel/toonMaterial.ts`、`src/cel/outline.ts` 与 `src/core/palette.ts` 中彻底消除赛璐珞硬阶梯，引入水彩湿画法柔和晕染（Feathering）、天顶天青与海面翡翠双半球反弹漫射、暖阳透光微晕与水彩留白高光、明暗交界处手绘铅笔排线阴影（Cross-Hatch Strokes），以及 Inverted-Hull 深暖褐色（`#3D2B1F`/`#4A3525`）手写提按笔触与渗墨质感。
- [x] **Task 15.2**：在 `src/cel/postPipeline.ts`、`src/audio/audio.ts` 与 `src/game/boat.ts` 中实现吉卜力毛笔手绘水墨飞白动态气流速度流线（带飞白随风微抖质感与中央50%区域通透留白）、动态镜头FOV呼吸与机体微震颤，在 Web Audio 中实现老柚木机体受力嘎吱声（Wood Creak Shudder）、帆布气流剧烈翻卷声（Canvas Flutter）、古代风环与风之日晷清脆风铃和弦泛音与水面极速切水漂移浪花声学。

---

## 🤝 Level 4: 标准会话交接协议 (Handoff Protocol)

任何 Agent 在开始或结束一个会话时，必须遵循以下交接标准：

### 📥 接入时（Check-in）
1. 打开 `docs/handoff.md` 查看 `[Current Active Task]`。
2. 确认前置任务的 `Status: DONE` 与验证结果。
3. 本会话仅针对 `[Current Active Task]` 开展编码与验证，禁止做无关变动。

### 📤 离开时（Check-out）
1. 运行 `npm run build` 确保 TypeScript 编译 0 报错。
2. 若由于云端环境限制跳过了端到端测试，**仅在 [`docs/todo-test.md`](docs/todo-test.md) 追加 1 行精炼要点**，严禁大段贴表。
3. 强制清理所有测试/构建挂起的后台进程（如占用 5199/5216/5221 端口的 Vite/Playwright），清理临时调试文件，保证内存与端口零残留。
4. 更新 `docs/handoff.md` 与本文件末尾：
   - 将已完成任务标记为 `DONE`。
   - 记录修改的具体文件路径与关键技术决策。
   - 将 `[Current Active Task]` 指针移动到下一个原子任务。
   - 输出清晰的下一会话启动指引。

---

## 📍 Level 5: 当前实时交接状态 (Active Handoff State)

- **当前项目目录**：`/var/www/wind-glider`
- **线上发布地址**：[https://wind.hp666.cc](https://wind.hp666.cc)
- **当前所处阶段**：`Milestone 15: 纯正吉卜力水彩原画着色器与手绘视界升华 (Pure Ghibli Watercolor Shaders & Hand-Drawn Realm)`
- **👉 当前状态**：🎉 **Task 15.2 交付完毕！**（毛笔手绘水墨飞白动态气流速度流线、中央50%通透留白、动态FOV呼吸与机体微震颤、老柚木机体受力嘎吱声、帆布翻卷声、古代风环风铃和弦泛音与切水漂移白噪浪花）
- **当前构建状态**：✅ `npm run build` 0 错误 0 警告，契约测试（`verify:flight` / `verify:collision` / `verify:mobile` / `verify:audio` / `verify:systems` / `verify:performance`）100% 全绿通过，端口与内存零残留。
- **下一原子任务指针**：`Milestone 15: Task 15.3` (或 Milestone 15 最终发布验收)
