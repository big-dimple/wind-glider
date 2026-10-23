# 项目会话交接看板 (Active Handoff Ledger)

> **会话交接纪律**：每个独立的会话只认领并完成 **一个** 原子任务。完成并通过验证后，**必须彻底清理无用临时文件、死循环定时器与残留进程（严禁遗留占用 5199/5216/5221 等端口的孤儿进程或泄漏内存）**，在本文件记录交接信息，并将指针指向下一个任务。

---

## 🎯 当前任务指针 (Current Task Pointer)

- **当前项目目录**：`/var/www/wind-glider`
- **当前执行阶段**：`Milestone 17: 晴空吉卜力水彩视觉与航道纯净重构 (Ghibli Visual & Clean Flight Path Overhaul)`
- **👉 当前状态**：🚀 **Task 17.2 待启动** (6位飞行员 3D 模型与立绘 100% 对齐精修)
- **线上发布地址**：[https://wind.hp666.cc](https://wind.hp666.cc)
- **目标文件**：`src/game/rider.ts`、`src/game/racers.ts`
- **核心成果与质检门禁**：
  1. 彻底消灭粉红塑料人偶，按 6 位立绘精准匹配服装色彩/五官/发髻/风镜/动态长围巾；
  2. 自审截图: `rider.png`, `ready.png`；
  3. `npm run build` 0 错误 0 警告通过。
- **下一原子任务指针**：`Milestone 17: Task 17.3` (6款手作木质复古滑翔艇机体精修)

---

## 📋 全局重构与深度开发里程碑计划 (Master Overhaul Roadmap)

### Milestone 7: 视听资产与音乐全面重构 (Audio & 2D Art Assets Overhaul)
> 彻底解决“画风与音乐割裂、赛博朋克旧立绘残留”的核心问题，建立自洽统一的吉卜力水彩美学视听。

| 任务编号 | 任务名称 | 目标文件 | 交付核心与清理要求 | 状态 |
| :--- | :--- | :--- | :--- | :---: |
| **Task 7.1** | 全面替换背景音乐与音频资产 | `src/assets/`、`src/audio/audio.ts` | 移除重金属摇滚，替换为纯正吉卜力自然治愈和风/原声长笛配乐 | ✅ **DONE** |
| **Task 7.2** | 重新绘制 6 位吉卜力飞行员手绘立绘 | `src/assets/drivers/*.webp`、`src/hud/driverSelect.ts` | 用手绘水彩画风全新重绘 6 位飞行员头像与全身体立绘 | ✅ **DONE** |
| **Task 7.3** | 重绘扩展航线背景与探索勋章插画 | `src/assets/expansions/`、`src/assets/achievements/` | 替换原版赛博城市/异星图，重构为天空岛、风车原野、珊瑚海插画与探索勋章 | ✅ **DONE** |

---

### Milestone 8: 晴空滑翔动力学与 3D 空气动力引擎 (Glider Aerodynamics & Flight Mechanics)
> 汲取《旷野之息》《极限国度》精髓，彻底告别摩托艇平移，构建基于真实升力、俯冲换速与气流互动的飞行体验。

| 任务编号 | 任务名称 | 目标文件 | 交付核心与清理要求 | 状态 |
| :--- | :--- | :--- | :--- | :---: |
| **Task 8.1** | 空气动力学重塑——俯冲换速、仰冲爬升与升力阻力模型 | `src/game/boat.ts` | 引入真实迎角（AoA）升力阻力方程，俯冲将重力势能转化为极速，拉起仰升转化为爬升高度，平飞自然后沉 | ✅ **DONE** |
| **Task 8.2** | 翼地效应 (Ground Effect) 与贴海/贴岩掠行共鸣机制 | `src/game/boat.ts`、`src/game/jetTrail.ts` | 离海面或崖壁 1~3 米贴地飞行时触发空气垫浮力与速度增益，生成贴水白色风纹与风能槽快速充能；验证后清理临时脚本与残留进程 | ✅ **DONE** |
| **Task 8.3** | 上升暖气流柱 (Thermal Updrafts) 与高空风道弹射机制 | `src/game/course.ts`、`src/game/boat.ts` | 在赛道关键区域布置旋转上升的半透明暖气流柱与风环加速道，进入瞬间获得气动抬升与机翼震颤反馈；**任务收尾必须杀死所有后台挂起进程，杜绝端口/内存占用** | ✅ **DONE** |

---

### Milestone 9: 3D 奇观航道、引导光带与自然环境升华 (3D Wonder Course & Visuals)
> 消除生硬赛道感与塑料感，打造清晰美观的 3D 飞行指引与立体云海。

| 任务编号 | 任务名称 | 目标文件 | 交付核心与清理要求 | 状态 |
| :--- | :--- | :--- | :--- | :---: |
| **Task 9.1** | 三维立体奇观航道重构——从起飞悬崖到空岛回廊与峡谷天梯 | `src/game/course.ts` | 将平面水路升级为高低起伏的 3D 飞行航道：高崖弹射起飞、珊瑚礁群侧倾穿插、盘旋天梯、古遗迹空中悬廊；交付时释放废弃模型顶点内存与清理进程 | ✅ **DONE** |
| **Task 9.2** | 3D 动态气流引导带与远景天光地标锚点系统 | `src/game/course.ts`、`src/cel/edgePass.ts` | 实现双层半透明水彩风流导轨、远景天光光柱（God Rays）与穿门涟漪光效，彻底解决赛道显示与迷路痛点；交付时清理临时几何体与进程 | ✅ **DONE** |
| **Task 9.3** | 软调水彩天光、蓬松体积积雨云与暖调海面焦散升华 | `src/water/ocean.ts`、`src/cel/sky.ts`、`src/cel/toonMaterial.ts` | 消除所有硬边塑料反光，引入软笔触天光漫射、随风漂移的层叠水彩积雨云与通透珊瑚礁焦散；严格控制 Shader 显存与编译开销 | ✅ **DONE** |
| **Task 9.4** | 飞行动态镜头与沉浸感风感反馈 (FOV 呼吸缩放、侧倾过载、气流速度线) | `src/game/chaseCamera.ts`、`src/cel/postPipeline.ts` | 俯冲时镜头拉远且 FOV 广角张开，仰冲拉近，大角度转弯带有柔和机体侧倾与边缘半透明水墨风流线；清理多余后期 Pass 与残留进程 | ✅ **DONE** |

---

### Milestone 10: 羊皮纸飞行仪表盘、风语交互与音效升华 (Flight HUD & Audio Feel)
> 将 UI 与音效全方位升华至纯正吉卜力自然风。

| 任务编号 | 任务名称 | 目标文件 | 交付核心与清理要求 | 状态 |
| :--- | :--- | :--- | :--- | :---: |
| **Task 10.1** | 航空高度仪、空速节数计与风之共鸣槽 HUD 极简手绘重构 | `src/hud/hud.ts`、`src/hud/hud.css` | 重构为手绘纸质罗盘仪：简洁清晰的空速指针、气压高度刻度、风车能量石与气流提示；无 DOM 泄漏与定时器挂起 | ✅ **DONE** |
| **Task 10.2** | 滑翔气流呼啸、木翼震颤、穿环风铃与环境风音效深度合成 | `src/audio/audio.ts` | 引入基于真实物理速度的白噪气流滤波声、俯冲机翼帆布震颤、穿过风门清脆风铃泛音与海鸥鸣叫；确保 Web Audio 节点自释放与无常驻悬挂 buffer | ✅ **DONE** |

---

### Milestone 11: 全量契约测试适配、生产构建与发布交付 (Verification & Staging)
> 确保全平台高质量稳定性并正式交付线上。

| 任务编号 | 任务名称 | 目标文件 | 交付核心与清理要求 | 状态 |
| :--- | :--- | :--- | :--- | :---: |
| **Task 11.1** | 更新端到端自动化契约测试适配新 3D 飞行系统 | `harness/*.mjs` | 适配全新 3D 飞行物理、高度采样与航道断言，确保 `npm run verify:release` 全绿通过；测试执行完毕必须优雅销毁所有 Playwright 与 Vite 进程 | ✅ **DONE** |
| **Task 11.2** | 生产发布、Nginx 部署与 GitHub 仓库就绪 | `dist/`、`/etc/nginx/`、`README.md` | 构建发布至 `https://wind.hp666.cc`，完成真机全流程验收与 Git 提交，清理所有构建产物缓存与多余临时文件 | ✅ **DONE** |

---

### Milestone 12: 触控操作与全平台体验升华 (Mobile Floating Controls & Cross-Platform Refinement)
> 全面升级触控操作体验，引入动态浮动黄铜罗盘摇杆与手绘水彩双动作气泡，保障多端无缝沉浸式游玩。

| 任务编号 | 任务名称 | 目标文件 | 交付核心与清理要求 | 状态 |
| :--- | :--- | :--- | :--- | :---: |
| **Task 12.1** | 移动端左侧动态浮动黄铜罗盘摇杆与按键长按恢复 | `src/core/mobileControls.ts`、`src/core/mobileControls.css`、`src/core/input.ts` | 触控左半屏动态唤出 360° 黄铜罗盘摇杆，松手弹簧回中阻尼，右侧双动作气泡与中央留白，失焦/过场按键长按恢复 | ✅ **DONE** |
| **Task 12.2** | 空中刹车落地切水漂移与智能防砸地面/水面气垫保护 | `src/game/boat.ts`、`src/contracts.ts` | 空中刹车落水瞬间无缝切入水面漂移与水刀喷雾/充能，低空大角度俯冲自然施加气垫效应升力托举与机头平缓回平掠水 | ✅ **DONE** |
| **Task 12.3** | 触控震动反馈与世界坐标手绘转弯指示牌 | `src/game/course.ts`、`src/hud/hud.ts`、`src/core/haptics.ts` | 世界坐标系手绘木质转弯立牌/波浪浮标、HUD 航向与俯冲提示增强，以及移动端触控震动精细调优 | ✅ **DONE** |

---

### Milestone 13: 白垩海湾、红瓦风车海滨村落与世界生态重构 (Chalk Haven & Living Ecosystem)
> 彻底废除生硬暗黑孤山，构建吉卜力水彩白垩海岬、地中海红瓦风车村落、起飞跳台跑道与充满生机的海洋生态。

| 任务编号 | 任务名称 | 目标文件 | 交付核心与清理要求 | 状态 |
| :--- | :--- | :--- | :--- | :---: |
| **Task 13.1** | 白垩海岬、红瓦风车海滨村落与海洋生态系统 | `src/game/course.ts`、`src/core/palette.ts` | 废除暗黑海山，构建白垩海崖台地、地中海红瓦白墙木屋群、4叶旋转大风车、木质滑翔起跑台、惊飞海鸥群、跃水海豚与蒲公英花瓣粒子 | ✅ **DONE** |
| **Task 13.2** | 高空云海与天空之城拉普达浮岛回廊 | `src/game/course.ts`、`src/cel/sky.ts` | 构建高空（$Y=25\sim 60\text{m}$）象牙白石浮岛群、古罗马双层引水渠悬廊(穿拱/贴水)、古代太阳神殿与风向标日晷、飘扬五色祈风彩旗、+14m/s金色暖气流柱与高空穿云水粉层叠积雨云海 | ✅ **DONE** |

---

### Milestone 14: 终极水彩飞行员群像与吉卜力管弦巅峰原声 (Ultimate Roster & Ghibli Orchestral Peak)
> 彻底重塑 6 位飞行员档案立绘与 3 首久石让巅峰管弦交响大曲，实现随机动态洗牌与无缝交叉淡入淡出。

| 任务编号 | 任务名称 | 目标文件 | 交付核心与清理要求 | 状态 |
| :--- | :--- | :--- | :--- | :---: |
| **Task 14.1** | 6位终极飞行员水彩人设立绘与3首吉卜力巅峰管弦交响大曲 | `src/game/racers.ts`、`src/hud/driverSelect.ts`、`src/assets/drivers/`、`src/assets/audio/`、`src/audio/audio.ts` | 升级 6 位终极手绘飞行员档案（苏轼/清照/萧峰/舟伯通/孔明/娃娃）与 640x960 2:3 立绘，生成 3 首 48kHz Ogg/MP3 久石让管弦巅峰大曲并实现动态随机洗牌器与无缝平滑交叉淡入淡出（Crossfade） | ✅ **DONE** |
| **Task 14.2** | 3D飞行员入舱角色系统、灵动身体姿态动力学与随风飘舞长围巾物理 | `src/game/boat.ts`、`src/game/racers.ts`、`src/game/rider.ts`、`src/main.ts` | 告别无人空船，构建驾驶舱 3D 飞行员模型、6 位专属飞行员人设（发型/风镜/服饰）、灵动身体动力学（水平侧倾压弯、俯冲前倾压低流线、仰冲拉杆抬头姿态）与 5 节多质点弹簧动态随风长围巾/披风物理 | ✅ **DONE** |
| **Task 14.3** | 黄金风向标终点盛典、祈风彩旗礼花与全流程视听综合体验升华 | `src/hud/finaleCelebration.ts`、`src/game/course.ts`、`src/audio/audio.ts`、`src/game/boat.ts` | 打造 70m 海天巨拱黄金太阳风向标、高空冲线万千五彩祈风流苏彩旗/礼花与胜利管弦盛典，构建 6 位飞行员专属机体拓扑与展开机械翼，全流程深度打磨与跨端最终交付 | ✅ **DONE** |

---

### Milestone 15: 纯正吉卜力水彩原画着色器与手绘视界升华 (Pure Ghibli Watercolor Shaders & Hand-Drawn Realm)
> 彻底消除硬阶梯赛璐珞与塑料反光膜，引入湿画法漫射、双半球天光反射、手绘铅笔排线阴影与深暖褐色手写水墨轮廓线。

| 任务编号 | 任务名称 | 目标文件 | 交付核心与清理要求 | 状态 |
| :--- | :--- | :--- | :--- | :---: |
| **Task 15.1** | 水彩湿画法漫射、铅笔排线阴影与深暖褐墨线 | `src/cel/toonMaterial.ts`、`src/cel/outline.ts`、`src/core/palette.ts` | 消除硬切阶梯，引入湿画法柔和晕染（Feathering）、天顶天青与海面翡翠双半球反弹光、暖阳透光微晕与水彩留白高光、明暗交界处手绘微抖铅笔排线/交叉排线纹理（Cross-Hatch Strokes），以及 Inverted-Hull 深暖褐色（#3D2B1F/#4A3525）手写提按笔触与渗墨质感 | ✅ **DONE** |
| **Task 15.2** | 手绘水墨动态气流速度流线、老柚木机体震颤与风铃泛音 | `src/cel/postPipeline.ts`、`src/audio/audio.ts`、`src/game/boat.ts` | 极速俯冲/风道弹射/推进爆发毛笔手绘水墨飞白速度流线（带飞白随风微抖质感与中央50%区域通透留白）、动态镜头FOV呼吸与机体微震颤，Web Audio老柚木机体受力嘎吱声（Wood Creak Shudder）、帆布翻卷声（Canvas Flutter）、古代风环/风之日晷清脆风铃和弦泛音与水面切水漂移浪花白噪 | ✅ **DONE** |

---

### Milestone 17: 晴空吉卜力水彩视觉与航道纯净重构 (Ghibli Visual & Clean Flight Path Overhaul)
> 彻底解决实机截图暴露的 6 大视觉败笔：巨型甲板覆盖海面、不透明青色公路航道、单色粉红塑料人偶、死黑石门剪影、生硬几何方块地貌与杂物挡视线。每个子任务均强制执行 Playwright 实机截图自审，过关后方可交接。

| 任务编号 | 任务名称 | 目标文件 | 交付核心与自审要求 | 状态 |
| :--- | :--- | :--- | :--- | :---: |
| **Task 17.1** | 出航栈桥轻量化、水彩海风涡流航道与视距净空 | `src/game/course.ts`、`src/core/palette.ts`、`src/cel/toonMaterial.ts` | 拆除巨型甲板，换为 13m 极简手作木栈桥；修复 shadowTint 导致的高饱和青色反光 Bug；航道改造为半透明水彩海风涡流光带（Opacity 0.25）；航道 ±25m 净空除障。**自审截图: `start.png`, `sweeper.png`, `ready.png`** | ✅ **DONE** |
| **Task 17.2** | 6位飞行员3D模型与立绘 100% 对齐精修 | `src/game/rider.ts`、`src/game/racers.ts` | 彻底消灭粉红塑料人偶，按 6 位立绘精准匹配服装色彩/五官/发髻/风镜/动态长围巾。**自审截图: `rider.png`, `ready.png`** | 🟡 **IN PROGRESS** |
| **Task 17.3** | 6款手作木质复古滑翔艇机体精修 | `src/game/boat.ts` | 告别生硬方块机身，重构精美手作柚木/雪松木龙骨、透光棉麻帆布机翼与黄铜旋翼。**自审截图: `rider.png`, `flight-cruise.png`** | ⏳ **PENDING** |
| **Task 17.4** | 暖白垩风化石门与有机悬崖浮岛地貌重塑 | `src/cel/toonMaterial.ts`、`src/game/course.ts` | 石门改为暖白垩风化石 (#E3DAC9) + 青藤彩旗；悬崖与浮岛有机草坡化。**自审截图: `airtime.png`, `hairpin.png`** | ⏳ **PENDING** |
| **Task 17.5** | 全场景实机视听综合自审与生产发布验收 | 全量文件、`harness/*.mjs` | 全量 8 张关键视角高清截图对比自审 + 契约测试回归 + 生产构建发布部署上线。 | ⏳ **PENDING** |

---

## 📜 历史会话交接流水 (Session Changelog)

### [2026-08-16] Session #37: Task 17.1 出航栈桥轻量化、水彩海风涡流航道与视距净空
- **目标文件**：[`src/game/course.ts`](file:///var/www/wind-glider/src/game/course.ts), [`src/core/palette.ts`](file:///var/www/wind-glider/src/core/palette.ts), [`src/cel/toonMaterial.ts`](file:///var/www/wind-glider/src/cel/toonMaterial.ts)
- **完成动作**：
  1. **彻底解决出航栈桥视觉硬伤与相机遮挡 (`src/game/course.ts`)**：
     - 重构 `makeGliderLaunchPier`：设定栈桥长度为 13.0m（$Z = -30.0\text{m} \sim -17.0\text{m}$，宽度 13.0m），采用复古手作老柚木（`PALETTE.woodPlank` / `PALETTE.woodDark`）；
     - 入水斜坡在最后 4.5m 平滑自然没入海平面（$Y = 0.38\text{m} \to -0.18\text{m}$），发车滑行 5 米即冲入波光粼粼的水彩海水；
     - 移除水端可能遮挡镜头的悬空横梁与高立杆，路沿石与立柱严密跟随斜坡隐入水下；
  2. **修复着色器 `shadowTint` 导致的高饱和青色色偏 (`src/cel/toonMaterial.ts`)**：
     - 修复 `createToonMaterial` 中将 `shadowTint` 颜色十六进制整数误作为 float 传入 shader 的问题，新增 `uShadowTintColor` uniform，杜绝环境岩壁与机体产生高饱和青色伪影；
  3. **水彩海风涡流航道与 80%+ 视野通透 (`src/game/course.ts`)**：
     - 调优 `buildRibbonMaterial`、`buildAuraRibbonMaterial`、`buildCoreRibbonMaterial`，航道呈现极柔和羽化天青（Opacity 0.22 ~ 0.25），不挡海面焦散与水彩浪花；
     - 导流箭头采用柔光水彩导流波（Soft Floating Chevrons）；
  4. **赛道关键区域 ±25m 强制净空**：
     - 检查并确认起飞区、峡谷、浮岛回廊与巨拱中心线左右两侧均保持充分净空；
  5. **实机截图自审与契约测试通过**：
     - 运行 `node harness/screenshot.mjs start sweeper ready`，经 `view_file` 亲自确认画面无大甲板遮挡、水面通透波光粼粼；
     - `npm run build` 0 错误 0 警告；
     - `npm run verify:systems`、`npm run verify:collision`、`npm run verify:mobile` 100% 全绿通过。
- **下一会话目标**：执行 `Milestone 17: Task 17.2`（6位飞行员 3D 模型与立绘 100% 对齐精修）。

### [2026-08-16] Session #36: Task 15.2 手绘水墨动态气流速度流线、老柚木机体震颤与风铃泛音
- **目标文件**：[`src/cel/postPipeline.ts`](file:///var/www/wind-glider/src/cel/postPipeline.ts), [`src/audio/audio.ts`](file:///var/www/wind-glider/src/audio/audio.ts), [`src/game/boat.ts`](file:///var/www/wind-glider/src/game/boat.ts)
- **完成动作**：
  1. **手绘水墨动态气流速度流线与沉浸镜头 (`src/cel/postPipeline.ts`)**：
     - 在 `src/cel/postPipeline.ts` 中升级水墨风流线生成器：极速俯冲（$V > 45\text{km/h}$）、风道弹射与推进爆发时动态激活毛笔手绘水墨飞白流线；
     - 注入多频段手绘飞白随风微抖质感与宣纸渗墨笔触，屏幕中央 50% 视野严格保持通透干净，杜绝遮挡航门与准星；
     - 注入高速俯冲/爆发时的相机动态微震颤（Airframe Micro-Jitter）与镜头呼吸畸变；
  2. **木质机翼震颤与气流呼啸沉浸声学 (`src/audio/audio.ts`)**：
     - 在 Web Audio 中构建老柚木机体受力微震嘎吱声（Wood Creak Shudder）与脉冲碎裂声（Wood Creak Click），精准响应高速俯冲、大迎角拉杆拉升与高 G 力侧倾转弯；
     - 升级帆布气流剧烈翻卷声（Canvas Flutter），注入带通双振荡与迎风鼓动低频波动；
     - 调优古代石门与风之日晷穿门清脆空灵风铃和弦（Furin Wind Chime Harmonics，4 阶泛音与青铜共鸣体）与回响泛音；
     - 升级水面极速切水漂移双弧水花与彩虹浪花白噪（Water Carving & Rainbow Spray Fizz）；
  3. **老柚木机翼动力学与微震形变 (`src/game/boat.ts`)**：
     - 在 `updateWingAndRotorVisual` 中深度整合气动受力挠曲与俯冲微震（Wood Shudder Flex），呈现纯正吉卜力手作机械美感；
  4. **全平台契约测试全绿**：
     - `npm run build` 0 错误 0 警告通过；
     - `npm run verify:flight`、`npm run verify:collision`、`npm run verify:mobile`、`npm run verify:audio`、`npm run verify:systems`、`npm run verify:performance` 100% 全绿通过；
     - 在 [`docs/todo-test.md`](file:///var/www/wind-glider/docs/todo-test.md) 中追加 1 行精炼本地复核要点。
- **下一会话目标**：执行 `Milestone 15` 的下一个原子任务【Task 15.3】（或全量发布上线验收）。

### [2026-08-16] Session #35: Task 15.1 水彩湿画法漫射、天光漫射、铅笔排线阴影与深暖褐色手写水墨轮廓线
- **目标文件**：[`src/cel/toonMaterial.ts`](file:///var/www/wind-glider/src/cel/toonMaterial.ts), [`src/cel/outline.ts`](file:///var/www/wind-glider/src/cel/outline.ts), [`src/core/palette.ts`](file:///var/www/wind-glider/src/core/palette.ts), [`src/audio/audio.ts`](file:///var/www/wind-glider/src/audio/audio.ts), [`src/hud/hud.css`](file:///var/www/wind-glider/src/hud/hud.css)
- **完成动作**：
  1. **水彩湿画法漫射与天光去塑料感 (`src/cel/toonMaterial.ts`)**：
     - 彻底消除生硬的赛璐珞 3 段式硬阶梯，采用湿画法柔和渐变晕染（Feathering）与颜料边界微沉淀（Wash Edge）；
     - 暗部自然融入天顶晴空天青色（Zenith Sky Wash）与海面/草坡翡翠反弹光（Ground Bounce Light），高光转为自然的水彩留白（Paper Reserve）与暖阳透光微晕（Sunlight Translucency），彻底消除塑料反光膜与死白高光点；
  2. **手绘铅笔排线阴影着色器 (`src/cel/toonMaterial.ts`)**：
     - 在着色器明暗交界处（Terminator Line）与阴影过渡带中，GLSL 程序化生成带有手绘微抖笔触的三平面铅笔排线/交叉排线纹理（Cross-Hatch Strokes），赋予木质、帆布与石体纯正吉卜力原画级手作素描温润质感；
  3. **深暖褐色手写水墨轮廓线 (`src/cel/outline.ts`, `src/core/palette.ts`)**：
     - 升级 Inverted-Hull 轮廓线生成器：采用深暖褐色（Warm Sepia `#3D2B1F` / `#4A3525`）替代纯死黑，注入微抖动与提按笔触变化（Calligraphic Brush Stroke Modulation），呈现蘸水笔/毛笔手绘渗墨质感；
     - 加入 mesh outline 幂等性防御，杜绝重复创建轮廓线网格；
  4. **全量构建与全平台契约测试全绿**：
     - `npm run build` 0 错误 0 警告通过；
     - `npm run verify:flight`、`npm run verify:collision`、`npm run verify:mobile`、`npm run verify:audio`、`npm run verify:systems`、`npm run verify:performance` 100% 全绿通过；
     - 在 [`docs/todo-test.md`](file:///var/www/wind-glider/docs/todo-test.md) 中追加 1 行精炼本地复核要点。
- **下一会话目标**：执行 `Milestone 15` 的下一个原子任务【Task 15.2】。

### [2026-08-16] Session #34: Task 14.3 打造黄金风向标终点盛典、祈风彩旗礼花与 6 位飞行员专属机体拓扑
- **目标文件**：[`src/game/boat.ts`](file:///var/www/wind-glider/src/game/boat.ts), [`src/game/course.ts`](file:///var/www/wind-glider/src/game/course.ts), [`src/hud/finaleCelebration.ts`](file:///var/www/wind-glider/src/hud/finaleCelebration.ts), [`src/audio/audio.ts`](file:///var/www/wind-glider/src/audio/audio.ts), [`src/hud/hud.ts`](file:///var/www/wind-glider/src/hud/hud.ts), [`src/hud/hud.css`](file:///var/www/wind-glider/src/hud/hud.css)
- **完成动作**：
  1. **6 位飞行员专属 3D 机体拓扑与展开机械翼 (`src/game/boat.ts`)**：
     - **苏轼** - 「晴空信天翁」：柚木单体龙骨、经典优雅双折海鸥木翼、手织棉帆布翼膜、3叶旋翼机；
     - **清照** - 「风谷蜻蜓」：极简轻量碳木骨架、双尾撑双方向舵、半透明浅青网格掠翼、轻灵双鸭翼、涵道 4 叶高转速风扇；
     - **萧峰** - 「赤炎狂龙」：楔形折角硬朗船体、激进前掠龙翼、金色太阳能光伏翼板、尾部双发聚气环形喷管与矢量扰流板；
     - **舟伯通** - 「顽童重锤/旋转飞燕」：厚重双体双浮筒旗舰、粗犷黄铜铆钉防撞角、宽大重型大升力翼、超大双 4 叶重型宽桨推力轮；
     - **孔明** - 「卧龙天机/木鸢」：修长三体船侧置稳定浮标、鲁班机关多段折叠高展弦比木鸢风筝翼、座舱后背旋转银铜八卦浑天星盘仪；
     - **娃娃** - 「风之浮子/彩虹雨燕」：圆润浮子双球形侧浮筒、上下双层错落双翼机、水彩拼布七彩翼膜、翼尖 4 叶旋转七彩风车；
     - 实现 `Boat.rebuildVisual(color)` 与 `Boat.setDriver()`，切换飞行员时动态平滑重构专属机体几何体与动画挂载节点。
  2. **70m 海天巨拱与黄金太阳风向标凯旋终点盛典 (`src/game/course.ts`)**：
     - 横跨 70 米航道的白垩象牙古石与黄铜天桥凯旋门，悬挂 36 面前风五彩祈风流苏彩旗阵随海风自然翻滚；中央高悬旋转黄金太阳风向标与 3 杯式风速仪；
  3. **吉卜力胜利交响大管弦原声与海风海鸥 (`src/audio/audio.ts`)**：
     - 全新合成 G 大调英雄大管弦号角（G4-B4-D5-G5-E5-D5-G5）、11 音竖琴五度琶音滑音、金色风铃和弦与海岸海鸥和鸣；
  4. **水彩群鸟翱翔与满屏礼花盛典 (`src/hud/finaleCelebration.ts`)**：
     - 16 只低空翱翔水彩海鸥/雨燕盘旋穿行于金色朝阳与七彩礼花之间，零每帧 GC 内存分配；
  5. **移动端触控引导与全量契约测试**：
     - 调优移动端紧凑模式引导卡片边距与安全视口；
     - `npm run build` 0 错误 0 警告通过。
     - `npm run verify:flight`、`npm run verify:collision`、`npm run verify:mobile`、`npm run verify:audio`、`npm run verify:systems` 100% 全绿通过。
- **里程碑状态**：🎉 **Milestone 14（终极水彩飞行员群像与吉卜力管弦巅峰原声）已圆满收官！**

### [2026-08-16] Session #33: Task 14.2 打造 3D 飞行员入舱角色系统、身体姿态动力学与随风飘舞长围巾物理
- **目标文件**：[`src/game/boat.ts`](file:///var/www/wind-glider/src/game/boat.ts), [`src/game/racers.ts`](file:///var/www/wind-glider/src/game/racers.ts), [`src/game/rider.ts`](file:///var/www/wind-glider/src/game/rider.ts), [`src/main.ts`](file:///var/www/wind-glider/src/main.ts)
- **完成动作**：
  1. **3D 飞行员入舱角色系统 (`src/game/boat.ts`, `src/game/racers.ts`, `src/game/rider.ts`)**：
     - 在每艘飞艇驾驶舱（Cockpit）构建端坐握把的 3D 飞行员模型；
     - 在 `src/game/racers.ts` 中定义 `PilotVisualConfig` 并为 6 位飞行员配置专属人设与色彩：
       - **苏轼**：深青工装（`0x1B4552`）、发簪墨发儒生发髻、金铜额前风镜（`0xDDA73A` / `0x80C4E8`）、**米白长围巾**（`0xFAF6EB` 双尾长围巾）；
       - **清照**：水天青短衫（`0x4A8C7D`）、优雅双环发髻与浅青发带、金铜细边镜（`0xE5B84B` / `0x9EE2EE`）、**水天青长飘带轻纱丝带**；
       - **萧峰**：英挺战袍（`0x7A2A1E`）、坚韧皮质护肩带铜铆钉、豪迈披肩长发与深褐抹额、**赤红战袍披风**（`0xC22B22` 豪侠战袍披风）；
       - **舟伯通**：大胡子老爹造型（海风老爹装 `0x465A42`、保暖耳罩毡帽、蓬松雪白大胡须）、单片黄铜测风镜（`0xC8963E` / `0x58D4E2`）、**墨绿风暴斗篷**（`0x1E422C`）；
       - **孔明**：儒雅学者造型（深蓝工装 `0x1C2D4A`、白玉银冠 `0xE2ECF2`、飘逸流云长发）、精密银镜（`0xD0DCE8` / `0xB8E4F8`）、**深蓝长风衣**（`0x243B66` 学者大氅）；
       - **娃娃**：天真萌童造型（翠绿短装 `0x2D7A47`、猫耳连帽风帽、水彩腮红）、大圆黄铜风镜（`0xEAA836` / `0x78E0F0`）、**翠绿连帽斗篷与黄金水彩风铃**（`0x369450` 坠挂铜铃与彩珠）。
  2. **灵动身体动画与姿态动力学 (`src/game/rider.ts`)**：
     - **水平侧倾压弯 (Bank Leaning)**：横向 G 值与船体 Roll 驱动脊柱与胸腔向弯心大角度侧倾压弯（最大约 30° / 0.54 rad），头部自适应反向偏摆（Counter-leaning）锁定前方地平线与航道；
     - **高速俯冲前压低风阻流线姿态 (Dive Streamline Tuck)**：在高速俯冲（W / 下倾）时，腰部与胸腔向前低伏紧贴仪表盘降低风阻，肘部收拢，头部微扬目视前下方；
     - **仰冲拉杆抬头姿态 (Climb Pitch Arch)**：拉杆仰冲（S / 上仰）时身体后靠椅背，双手向后拉紧操纵杆，头部仰视晴空云海；
     - **触水缓冲与胜利盛典**：落地冲击弹性下蹲、闲时自然呼吸微动与冲线高昂挥臂庆祝。
  3. **随风烈烈飘舞的多节长围巾/披风物理 (`src/game/rider.ts`)**：
     - 构建 5 节（6 质点）多质点弹簧物理链条，每帧根据真实空速矢量（$-Z$ 逆风推力）、迎角升力气流（$Y$ 向风动）、转弯离心加速度（$X$ 侧风甩摆）与重力实时积分；
     - 注入多谐波吉卜力水彩翻滚波动（$A \sin(\omega t - k s)$），随航速增加自动激化翻滚频率与波幅；
     - 采用 double-sided 水彩渐变着色器与 Inverted-hull 描边，零每帧 GC 内存分配。
  4. **测试与类型检查**：
     - `npm run build` 0 错误 0 警告通过。
     - `npm run verify:flight`、`npm run verify:collision`、`npm run verify:mobile`、`npm run verify:audio`、`npm run verify:systems` 100% 全绿通过。
     - 在 [`docs/todo-test.md`](file:///var/www/wind-glider/docs/todo-test.md) 中追加 1 行精炼本地复核要点。
- **下一会话目标**：执行 `Milestone 14` 的下一个原子任务【Task 14.3】（黄金风向标终点盛典、祈风彩旗礼花与全流程视听综合体验升华）。

### [2026-08-16] Session #32: Task 14.1 升级 6 位手绘飞行员人设与 3 首吉卜力管弦巅峰原声大曲
- **目标文件**：[`src/game/racers.ts`](file:///var/www/wind-glider/src/game/racers.ts), [`src/hud/driverSelect.ts`](file:///var/www/wind-glider/src/hud/driverSelect.ts), [`src/assets/drivers/`](file:///var/www/wind-glider/src/assets/drivers/), [`src/assets/audio/`](file:///var/www/wind-glider/src/assets/audio/), [`src/audio/audio.ts`](file:///var/www/wind-glider/src/audio/audio.ts), [`harness/systems.mjs`](file:///var/www/wind-glider/harness/systems.mjs), [`harness/screenshot.mjs`](file:///var/www/wind-glider/harness/screenshot.mjs)
- **完成动作**：
  1. **6 位终极手绘飞行员人设档案与 640x960 2:3 水彩立绘升级 (`src/game/racers.ts`, `src/assets/drivers/`)**：
     - **苏轼 (东坡)** - 「御风客」：豁达沉稳，米白长围巾，飞艇「晴空信天翁」（平衡全能型）；
     - **清照 (易安)** - 「乘风羽」：灵动清雅，水天青短衫与风镜，飞艇「风谷蜻蜓」（轻量敏捷空刹型）；
     - **萧峰 (乔峰)** - 「九霄豪侠」：豪气干云，赤红战袍披风，飞艇「赤炎狂龙」（俯冲极速爆发型）；
     - **舟伯通 (老顽童)** - 「海风老爹」：幽默爱搞怪，墨绿风暴斗篷与铜烟斗，飞艇「旋转飞燕」（大仰角滞空型）；
     - **孔明 (诸葛亮)** - 「凌虚算仙」：从容睿智，深蓝长风衣与八卦星盘，飞艇「卧龙天机」（气流弹射巡航型）；
     - **娃娃 (Wawa)** - 「风语童心」：纯真乐观，翠绿连帽斗篷与水彩风铃，飞艇「彩虹雨燕」（贴海掠行充能型）。
     - 生成并输出标准 640x960 WebP 格式立绘，删除旧版立绘并全面更新 `LICENSES.md`。
  2. **3 首 48kHz 久石让管弦巅峰原声大曲 (`src/assets/audio/`)**：
     - `bgm-azure-climax.ogg/.mp3`：《晴空碧海之翼 · 决战狂潮》（Azure Battle Climax，G大调/E小调，124BPM，92.9s，爱尔兰哨笛/弦乐齐奏/铜管/定音鼓）；
     - `bgm-laputa-climax.ogg/.mp3`：《天空之城 · 狂风龙卷之跃》（Laputa Tornado Surge，D小调/F大调，132BPM，90.9s，双簧管/圆号/竖琴/大提琴/狂风声学共鸣）；
     - `bgm-porco-climax.ogg/.mp3`：《红猪 · 亚得里亚海狂想曲》（Porco Adriatic Rhapsody，F大调/Bb大调，128BPM，93.8s，爵士小号/手风琴/萨克斯风/长笛/浪漫意式滑翔管弦乐）。
     - 同步更新向后兼容的 `wind-glider-theme.ogg/.mp3` 并完善 `LICENSES.md` 声学工程与版权说明。
  3. **音频引擎多曲洗牌器与无缝平滑交叉淡入淡出 (`src/audio/audio.ts`)**：
     - 定义 `BGM_TRACKS` 数组并实现全异步预加载与 `AudioBuffer` 极速解码；
     - 实现基于 Fisher-Yates 的动态洗牌队列（`shufflePlaylist` / `nextShuffleTrack`）确保连贯不重复；
     - 构筑双缓冲与多增益节点架构，实现 2.0s 等功率曲线无缝交叉淡入淡出（`crossfadeToTrack`）；
     - 完美保持倒计时 3/2/1 分段低通滤镜（1200Hz -> 3200Hz -> 6800Hz -> 16000Hz 全开）与不同游戏场景自适应动态增益。
  4. **测试与类型检查**：
     - `npm run build` 0 错误 0 警告通过。
     - `npm run verify:audio`、`npm run verify:systems`、`npm run verify:flight`、`npm run verify:collision`、`npm run verify:mobile` 100% 全绿通过。
- **下一会话目标**：执行 `Milestone 14` 的下一个原子任务【Task 14.2】（黄金风向标终点盛典、祈风彩旗礼花与全流程视听综合体验升华）。

### [2026-08-16] Session #31: Task 13.2 打造高空云海与天空之城拉普达浮岛回廊
- **目标文件**：[`src/game/course.ts`](file:///var/www/wind-glider/src/game/course.ts), [`src/cel/sky.ts`](file:///var/www/wind-glider/src/cel/sky.ts), [`src/core/mobileControls.ts`](file:///var/www/wind-glider/src/core/mobileControls.ts), [`src/hud/driverSelect.ts`](file:///var/www/wind-glider/src/hud/driverSelect.ts)
- **完成动作**：
  1. **拉普达浮空群岛与地貌体系 (`src/game/course.ts`)**：
     - 构建高空（$Y = 25\text{m} \sim 60\text{m}$）4 大浮岛大陆（主大陆、太阳神殿岛、梯步空岛、绝顶石锥岛）与 10 座悬浮卫星微型石岛群。
     - 采用分层倒锥岩体（`PALETTE.chalkStone` / `PALETTE.stoneAncient`）、悬垂钟乳尖锥、覆顶翡翠草坡台地与悬挂青藤（`PALETTE.vineGreen`）。
  2. **古罗马式多拱引水渠悬廊 (`makeSkyAqueductViaduct`)**：
     - 构建横跨群岛的双层拱券石桥，支持飞艇在桥面贴水滑翔或从拱门中穿行；带有石质桥墩、排水滴水兽与青藤攀爬。
  3. **古代太阳神殿与风向标日晷 (`makeAncientSunTemple` / `makeAncientSundialRuin` / `makeSuspendedPrayerPennants`)**：
     - 建造环形爱奥尼柱廊遗迹、中央太阳石祭坛、十二时辰日晷刻盘、黄铜日晷针与旋转太阳风向标。
     - 跨柱廊与峡谷拉设悬挂钢索，布置五色（金/青/绯红/绿/白）祈风彩旗阵，迎高空烈风飘舞。
  4. **金色上升暖气流柱与高空风环隧道**：
     - 将赛道第 4 区暖气流柱高空升力抬升至 65m（Lift +14m/s），高空气动风环隧道（+54m/s）无缝对接穿云悬廊。
  5. **吉卜力水粉多层蓬松积雨云海升级 (`src/cel/sky.ts`)**：
     - 重构 5 种程序化水粉云朵材质生成器（入道云山·巨型积云柱、多峰云海、风卷飞云、平底积云与高空卷云），加入暖金受光日晕（`#FFE082` / `#FFA726`）、宫崎骏淡紫灰阴影（`#928FA8` / `#716C88`）与海天青蓝反光。
     - 在天穹着色器中注入高空丁达尔圣光柱与浮空微粒散射效果。
  6. **测试与类型检查**：
     - `npm run build` 0 错误 0 警告通过。
     - `npm run verify:flight`、`npm run verify:collision`、`npm run verify:mobile` 100% 全绿通过。
- **下一会话目标**：执行 `Milestone 14`（终点庆典、彩旗礼花与综合体验最终抛光）。

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

### [2026-08-15] Session #23: Task 7.3 重绘扩展航线背景与探索勋章插画
- **目标文件**：[`src/assets/achievements/macho-medal.webp`](file:///var/www/wind-glider/src/assets/achievements/macho-medal.webp), [`src/assets/achievements/LICENSES.md`](file:///var/www/wind-glider/src/assets/achievements/LICENSES.md), [`src/assets/drivers/*.webp`](file:///var/www/wind-glider/src/assets/drivers/)
- **完成动作**：
  1. 对 Task 7.2 的 6 张吉卜力水彩飞行员立绘进行了详细审美与工程 review，确认画风、色调、设定与构图完全自洽。
  2. 将 6 位飞行员立绘资产规范化重采样为 640x960 2:3 黄金规格，完美通过移动端与高密屏响应式契约。
  3. 彻底移除原版肌肉硬汉/赛博霓虹勋章，以吉卜力水彩手绘风格全新重绘“晴空探索者金翼勋章”（`macho-medal.webp`）：包含古朴黄铜罗盘、天青色透亮宝石核心、向外舒展的金色滑翔飞翼、翠绿月桂花环与蓝色流苏丝带，并完成高质量透明 Alpha 通道羽化抠图。
  4. 更新 `src/assets/achievements/LICENSES.md` 资产许可证与描述规范。
  5. 执行 `npm run build`（TypeScript 0 错误、0 警告）。
- **下一会话目标**：执行 `Task 8.1`（重塑滑翔腾空与气动反馈动力学）。

### [2026-08-15] Session #24: Task 8.1 空气动力学重塑——俯冲换速、仰冲爬升与升力阻力模型
- **目标文件**：[`src/game/boat.ts`](file:///var/www/wind-glider/src/game/boat.ts), [`harness/systems.mjs`](file:///var/www/wind-glider/harness/systems.mjs)
- **完成动作**：
  1. 在 `src/game/boat.ts` 的 `TUNING` 中引入完整空气动力学物理参数（`glideRatio: 10.5`、`wingArea: 6.8m²`、`airDensity: 1.225 kg/m³`、`gliderMass: 420kg`、`liftCoeff0: 0.32`、`liftSlope: 5.0`、`stallAngle: 0.30 rad`、`stallLiftDrop: 0.65`、`dragCoeff0: 0.030`、`inducedDragK: 0.042`、`airBrakeDragCoeff: 0.32`、`divePitchMax: 0.36`、`climbPitchMax: 0.40`、`neutralPitchTrim: -0.035`、`pitchControlRate: 8.5`、`diveSpeedCap: 56m/s`）。
  2. 在 `Boat` 类中添加 `private aeroPitch = 0` 飞行气动俯仰状态，并在 `teleport()` 中重置。
  3. 重构 `updateFlight(dt, surfaceY, surfaceTargetY, thr, vF)`：
     - 计算航迹倾角 $\gamma = \text{atan2}(v_y, \max(1.0, v_F))$ 与迎角 $\alpha = \theta - \gamma$。
     - 计算动压 $q_m = \frac{1}{2}\rho V^2 \frac{S}{m}$、弯度翼型线性与失速区升力系数 $C_L(\alpha)$、诱导阻力与空阻扰流阻力 $C_D(\alpha)$。
     - 整合重力势能与前进动能转换：俯冲推进极速最高达 56 m/s，空刹与平飞自然顺畅沉降，水面触地无缝过度。
  4. 在 `updateWingAndRotorVisual()` 中根据动态气动载荷与迎角引入机翼气动微弯曲与俯仰联调。
  5. 更新 `harness/systems.mjs` 中 6 位吉卜力飞行员的名称与 ID 契约断言。
  6. 运行全量 `npm run verify:release`（包括 `build`、`verify:flight`、`verify:mobile`、`verify:collision`、`verify:audio`、`verify:systems`、`verify:performance`）100% 全绿通过。
- **下一会话目标**：执行 `Task 8.2`（翼地效应 Ground Effect 与贴海/贴岩掠行共鸣机制）。

### [2026-08-16] Session #25: Task 8.2 翼地效应 (Ground Effect) 与贴海/贴岩掠行共鸣机制
- **目标文件**：[`src/contracts.ts`](file:///var/www/wind-glider/src/contracts.ts), [`src/game/boat.ts`](file:///var/www/wind-glider/src/game/boat.ts), [`docs/todo-test.md`](file:///var/www/wind-glider/docs/todo-test.md)
- **完成动作**：
  1. 在 `src/contracts.ts` 的 `BoatState` 中扩展 `groundEffect`（0..1 翼地效应强度）、`groundResonance`（0..1 贴海共鸣强度）与 `groundResonanceCharge`（0..1 飞行充能进度）契约字段。
  2. 在 `src/game/boat.ts` 的 `TUNING` 中引入标准 WIG 物理参数：
     - 有效翼展 `groundEffectSpan: 3.8m`，有效高度区间 `0.25m ~ 3.2m`，峰值共鸣带 `0.9m ~ 2.2m`。
     - 翼地气垫升力增益最大 `+32%`（`groundEffectLiftMul: 0.32`）。
     - 维塞尔斯伯格 (Wieselsberger) 翼尖涡流抑制与诱导阻力衰减最大 `-52%`（`groundEffectDragCut: 0.52`）。
     - 贴水防下沉柔性气垫浮力加速度阻尼 `groundEffectCushionK: 4.8 m/s²`。
     - 掠海推力效率增益系数 `3.6 * groundSigma * clamp(vF / 25, 0.4, 1.25)`。
  3. 在 `updateFlight()` 与 `update()` 中实现连续平滑的翼地效应与共鸣积能逻辑：
     - 当以 $>20\text{m/s}$ 高速在贴水 $0.9\sim 2.2\text{m}$ 掠行时，持续累积掠海共鸣，积满自动回充风之石（`flightCharges`）并补充滑翔爆发能量槽。
  4. 在 `update()` 中实现翼尖高速掠水风涡流线（`trail.emit` 双侧白色风纹）与金色共鸣闪光粒子。
  5. 在 `teleport()` 中严密重置所有翼地效应与充能状态变量，并暴露 `debugGroundEffect()` 契约接口。
  6. 修复 `audio.ts` 中 `resume()` 与 `ensureMusicPlaying()` 跨环境自动化测试兼容性；修复 `vite.config.ts` 中的 HMR 与文件监控隔离配置。
  7. 建立 [`docs/todo-test.md`](file:///var/www/wind-glider/docs/todo-test.md)，梳理并归档端到端测试清单供本地机器一键验收。
  8. 运行 `npm run build`，通过 TypeScript 强类型校验（0 错误、0 警告）。
- **下一会话目标**：执行 `Task 8.3`（上升暖气流柱 Thermal Updrafts 与高空风道弹射机制）。

### [2026-08-16] Session #26: Task 8.3 上升暖气流柱 (Thermal Updrafts) 与高空风道弹射机制
- **目标文件**：[`src/contracts.ts`](file:///var/www/wind-glider/src/contracts.ts), [`src/game/course.ts`](file:///var/www/wind-glider/src/game/course.ts), [`src/game/boat.ts`](file:///var/www/wind-glider/src/game/boat.ts), [`src/main.ts`](file:///var/www/wind-glider/src/main.ts)
- **完成动作**：
  1. 在 `src/contracts.ts` 中扩展 `BoatState`（`thermalUpdraft`、`windTunnelBoost`）并定义 `ThermalUpdraftDef`、`ThermalSample`、`WindRingDef`、`WindTunnelDef`、`WindTunnelSample` 接口，更新 `ICourse` 声明 `sampleThermalUpdraft()` 和 `sampleWindTunnel()`。
  2. 在 `src/game/course.ts` 中布置 5 个暖气流柱（Cape/Plateau/Canyon/Ridge/Carousel，lift 12~14 m/s）与 4 条风道弹射隧道（Chicane/Canyon/Jetstream/Carousel，boost 52~56 m/s），实现 4 套手绘 GLSL 着色器（热柱螺旋、底部旋涡、风环光圈、风道导流管），以及完整 `sampleThermalUpdraft()` / `sampleWindTunnel()` 零分配采样方法和 `buildThermalUpdrafts()` / `buildWindTunnels()` 3D 可视化构建与 `update()` 动画驱动。
  3. 在 `src/game/boat.ts` 中引入 `thermalCouplingK: 4.8`、`thermalExtendRate: 0.75`、`windTunnelBoostMul: 1.45`、`windTunnelDragCut: 0.72` TUNING 参数，在 `updateFlight()` 中实现暖气流垂直抬升（$a_y = \text{intensity} \times (\text{liftSpeed} - v_y) \times 4.8$）与飞行时长延伸、风道穿环弹射加速与诱导阻力 -72% 切减、`updateWingAndRotorVisual()` 热颤振与风道气动后掠联调、暖气流金色日光粒子与风道白色翼尖涡流线粒子发射。
  4. 在 `src/main.ts` 中将 `course` 注入 `Boat` 构造器，实现运行时物理采样连接。
  5. 在 `teleport()` 中严密重置所有热流/风道状态，暴露 `debugThermalAndTunnel()` 与 `setCourse()` 接口。
  6. 运行 `npm run build`，通过 TypeScript 强类型校验（0 错误、0 警告）。
- **下一会话目标**：执行 `Task 9.1`（三维立体奇观航道重构）。

### [2026-08-16] Session #27: Task 9.1 三维立体奇观航道重构——从起飞悬崖到空岛回廊与峡谷天梯
- **目标文件**：[`src/game/course.ts`](file:///var/www/wind-glider/src/game/course.ts)
- **完成动作**：
  1. 在 `src/game/course.ts` 中构建全套 procedural 3D wonder scenery 奇观航道系统（包含 13 种参数化几何体生成算法与 5 大主题奇观地貌）：
     - **Zone 1: 起飞悬崖群与古代出航台**：西岸白垩海崖（22~34m）、悬挑木质滑翔跳台、八角古石瞭望塔、悬崖 4 叶旋转大风车与东岸跃升海岬。
     - **Zone 2: 珊瑚礁群与海蚀柱穿插区**：浅海珊瑚环礁桌盘、彩色鹿角珊瑚群、双拱海蚀天生门（Twin Arch Rock）、针状海蚀柱石林。
     - **Zone 3: 峡谷天梯与阶梯云瀑**：千仞对峙峡谷赤壁（36~48m）、层级盘旋上升云阶岩台、横跨峡谷上空的古老高空悬索吊桥与飞瀑。
     - **Zone 4: 古遗迹空中悬廊与浮岛回廊**：4 座高空倒悬空岛群（Laputa Floating Islands，24~34m 高度）、神殿白石柱廊遗迹、横跨浮岛之间的多拱悬空石引水渠。
     - **Zone 5: 外海回旋海湾与海蚀巨拱**：跨度 66 米的天然海蚀天生巨拱（玩家可俯冲穿过拱心）、外海哨戒礁石与古风向灯塔。
  2. 实现严密的 Material Batching 与 `mergeGeometries` 拓扑合并机制：10 组材质（石构件/岩壁/草皮/木构/黄铜/沙滩/粉珊瑚/青珊瑚/金珊瑚/绿植）各自归一化为单一 draw-call Mesh，附带 `addOutline` 水彩墨线与 `markInk`，并在合并后彻底 `.dispose()` 所有瞬时几何体。
  3. 在 `update(dt, t)` 中为悬崖大风车叶片绑定物理旋转动画（`sceneryWindmillRotors`）。
  4. 运行 `npm run build`，通过 TypeScript 强类型校验（0 错误、0 警告）。
- **下一会话目标**：执行 `Task 9.2`（3D 动态气流引导带与远景天光地标锚点系统）。

### [2026-08-16] Session #28: Task 9.2 3D 动态气流引导带与远景天光地标锚点系统
- **目标文件**：[`src/game/course.ts`](file:///var/www/wind-glider/src/game/course.ts), [`src/cel/edgePass.ts`](file:///var/www/wind-glider/src/game/course.ts)
- **完成动作**：
  1. **双层半透明水彩风流导轨 (Dual-layer Dynamic Airflow Guide Ribbons)**：
     - **Layer 1 (外层柔和风流云雾带 Aura Ribbon)**：在 `src/game/course.ts` 中引入 `buildAuraRibbonMaterial`，构建较宽（1.35x）半透明水彩气流微雾带，带动态谐波流动波纹、蓄力升力波动光效（`uReady`）、转弯暖光警示与平滑距离衰减。
     - **Layer 2 (内层高清晰速度风纹核心带 Core Ribbon)**：基于 3D 轨迹计算三维流线与中心高光流动槽，结合动态流动箭头（Chevrons）、左/右多车道水彩风痕、转弯区金色高亮引导以及穿门着水恢复过渡。
  2. **远景天光地标锚点系统 / 远景天光光柱 (Volumetric God Rays & Astrolabe Landmark Beacons)**：
     - 为航道中 7 道古代石门构建 110 米贯通云层的高耸天光光柱（`GodRayShaderMaterial`），具备云层与石门双向柔和衰减、圆柱菲涅尔软边处理、纵向下泻光束条纹、长视距明亮与近身柔化特性。
     - 在石门顶端构建古代 Solarpunk 双环旋转天光地标罗盘环（Astrolabe Landmark Beacon），附带 12 星座刻度与 4 向太阳指向针，自适应视距缩放以在复杂 3D 空岛/峡谷中指明目标大门。
  3. **穿门涟漪光效 (Gate Passage Resonance Ripple / Shockwave VFX)**：
     - 在滑翔机穿过石门的瞬间，触发 3D 色散共鸣冲击波（`GateResonanceRipple`，包含先导强光白刃、水天青色主冲击波与暖金太阳余晖，平滑扩展至 26 米），并在石门正下方海面同步激荡出扩散水面水彩涟漪（`GateResonanceWater`）。
  4. **图层与后处理渲染协同**：
     - 所有半透明引导光带、天光光柱、罗盘与冲击波禁用 `LAYER_INK` 并启用 `LAYER_ENERGY`，杜绝边缘 Sobel 墨线撕裂与穿透伪影，自然融入辉光泛光通道。
  5. 运行 `npm run build`，通过 TypeScript 强类型校验（0 错误、0 警告）。
- **下一会话目标**：执行 `Task 9.3`（软调水彩天光、蓬松体积积雨云与暖调海面焦散升华）。

### [2026-08-16] Session #29: Task 9.3 软调水彩天光、蓬松体积积雨云与暖调海面焦散升华
- **目标文件**：[`src/cel/toonMaterial.ts`](file:///var/www/wind-glider/src/cel/toonMaterial.ts), [`src/cel/sky.ts`](file:///var/www/wind-glider/src/cel/sky.ts), [`src/water/ocean.ts`](file:///var/www/wind-glider/src/water/ocean.ts)
- **完成动作**：
  1. **软调水彩天光与无塑料高光着色器升华 (`src/cel/toonMaterial.ts`)**：
     - 彻底消除生硬塑料白点高光，引入暖调水彩高光光泽（`uSpecStrength`、`uSpecColor`、`smoothstep` 阶梯微羽化高光）；
     - 构建吉卜力双半球天光漫射模型：天顶至地平线柔和天光（`uSkyZenith` -> `uSkyHorizon`）与下半球碧波/大地反弹光（`uGroundBounceColor`）；
     - 升级多阶边缘天光微辉（`uRimColor` 迎光面暖金高光与背光面天青微光）与柔和水彩远景天光透视（`uFogStart`/`uFogFar` 渐进式空中透视）。
  2. **蓬松体积积雨云与手绘水彩晴空穹顶升华 (`src/cel/sky.ts`)**：
     - 重塑 5 套程序化 Ghibli 水彩云朵纹理生成器（入道云山巨型积云柱、连绵积雨云群多峰云海、风卷飞云舒展流线、低空海天平底积云、高空卷云水彩天幕）；
     - 构建 4 深度层级立体云海系统（Hero 6 座入道云柱、Mid 12 座连绵云群、Near 14 座流动飞云、Cirrus 8 道高空卷云微动，共 40 朵云朵），具备全向风力漂移与正弦垂直呼吸浮动，零每帧 GC 内存分配；
     - 晴空穹顶着色器升级暖阳日冕、微羽化 12 分段太阳光芒与动态呼吸 Tyndall 丁达尔光柱。
  3. **暖调海面焦散、次表面透光与水彩碧波升华 (`src/water/ocean.ts`)**：
     - 引入双层 Voronoi 浅海珊瑚礁焦散网络，附带波浪法线折射与干涉高光节点；
     - 实现迎阳波坡次表面透光（Subsurface sunlight translucency），使波浪顶部呈现玉石般通透翡翠与水天青色温润光泽；
     - 消除水面 3 阶高度硬切阶梯，采用微羽化水彩湿画法过渡（Wet-in-wet blend），从根本上消除高空俯冲飞行时的像素点阵闪烁与塑料感；
     - 增强蕾丝浪花泡沫边缘水彩晕染扩散光晕。
  4. 运行 `npm run build`，通过 TypeScript 强类型校验（0 错误、0 警告）。
- **下一会话目标**：执行 `Task 9.4`（飞行动态镜头与沉浸感风感反馈）。

### [2026-08-16] Session #30: Task 9.4 飞行动态镜头与沉浸感风感反馈 (FOV 呼吸缩放、侧倾过载、气流速度线)
- **目标文件**：[`src/game/chaseCamera.ts`](file:///var/www/wind-glider/src/game/chaseCamera.ts), [`src/cel/postPipeline.ts`](file:///var/www/wind-glider/src/cel/postPipeline.ts)
- **完成动作**：
  1. **飞行动态追随镜头与空气动力响应 (`src/game/chaseCamera.ts`)**：
     - **俯冲动态 (Dive Dynamics)**：从四元数实时提取欧拉角俯仰 $\theta$ 与下降阶段状态，当俯冲机头下倾或高速俯冲时，镜头动态拉远 $+2.5\text{m}$，机身上方视点抬升 $+1.3\text{m}$，FOV 广角张开 $+5.8^\circ$，视线向下前瞻延伸，呈现雄浑开阔的俯冲俯瞰视野；
     - **仰冲动态 (Climb Dynamics)**：当拉起机头仰冲或进入暖气流垂直抬升时，镜头拉近 $-1.8\text{m}$，视点微降 $-0.75\text{m}$，FOV 聚焦紧凑 $-2.2^\circ$，视线仰望天空，呈现对抗重力腾空爬升的厚重力量感；
     - **侧倾过载 (Roll Banking & Centrifugal Overload)**：结合横向加速度离心 G 值（`ROLL_PER_G = 0.012`）与真实机翼倾角（`hullRoll * 0.24`），实现最大约 $8.0^\circ$（`ROLL_MAX = 0.14 rad`）的柔和侧倾入弯，辅以转弯前瞻引导（`lookSteerLead`）与离心侧偏位移；
     - **自然风感呼吸与风道拉伸**：融入高空气流微浮呼吸（$0.5\text{Hz}$ $\pm 0.45^\circ$ FOV 波动与 $\pm 0.09\text{m}$ 垂直浮沉），在风道弹射时展开 $+3.4^\circ$ 隧道拉伸，贴水翼地效应时轻微贴水下沉穩定视角。
  2. **手绘水墨风边缘气流速度线与后处理管线升华 (`src/cel/postPipeline.ts`)**：
     - **多尺度水彩手绘风流线 (Ghibli Ink Speed Streamlines)**：重构 120 极坐标风道流线算法，融合微细水墨毛笔笔触（`strokeCore`）与柔和水彩速度云气（`strokeFeather`），辅以两端自然平滑收尖（calligraphy brush stroke envelope）；
     - **吉卜力水彩调色与墨边渗染**：纯净云白色气流核心（`#F5FAFF`）、天青色天光微晕（`#AEE0FF`）、爆发/俯冲暖阳金辉（`#FFEBB0`）与外沿深灰水墨勾边阴影（`#2E3847`）；
     - **视线保护与气动反馈**：屏幕中央 42% 视野保持通透清洁，高空俯冲与风道极速时边缘水墨风线自然涌现；集成空气刹车横向减速扰流弧面（`uAirBrake`）与暖气流高空金阳光尘（`uThermal`）；
     - **性能与管线纯净**：保持 `PrePass` + `EnergyComposer` + `EdgePass` + `FinalPass` 极简单 Pass 复合，零每帧 GC 内存分配。
  3. 运行 `npm run build`，通过 TypeScript 强类型校验（0 错误、0 警告）。
- **下一会话目标**：执行 `Task 10.1`（航空高度仪、空速节数计与风之共鸣槽 HUD 极简手绘重构）。

### [2026-08-16] Session #31: Task 10.1 航空高度仪、空速节数计与风之共鸣槽 HUD 极简手绘重构
- **目标文件**：[`src/hud/hud.ts`](file:///var/www/wind-glider/src/hud/hud.ts), [`src/hud/hud.css`](file:///var/www/wind-glider/src/hud/hud.css)
- **完成动作**：
  1. **航空高度仪与气压高度刻度 (`src/hud/hud.ts`, `src/hud/hud.css`)**：
     - 构建手绘羊皮纸气压高度计面板（`.hud-alt-panel`），显示动态实时净空高度（`altVal`）与高度分段状态徽章（`水面` / `掠海气垫 WIG` / `巡航滑翔 GLIDE` / `高空天梯 APEX`）；
     - 集成大气气流动态指示器（`altAero`），实时提示上升暖气流（`THERMAL ↑`）、极速风道弹射（`STREAM ⇶`）与空气刹车扰流（`AIR-BRAKE ▼`）；
  2. **双制式空速节数计与柚木黄铜罗盘指针 (`src/hud/hud.ts`, `src/hud/hud.css`)**：
     - 在速度面板中增加节数副仪表徽章（`speedKnots`，`xx KTS`）；
     - 重构高分辨率 2D 罗盘空速仪表盘（`hud-gauge`）：外环 KM/H 与内环 Knots 双刻度、三段水彩飞行分区（0~30 km/h 绿松石巡航、30~42 km/h 暖阳金升力、42~56 km/h 珊瑚红俯冲爆发与水墨交叉排线）；
     - 精准绘制手绘柚木箭叶针体、抛光黄铜中脊嵌条、空心黄铜水滴平衡配重与多阶黄铜旋钮螺纹轴心；
  3. **风之共鸣槽与风车能量石 HUD (`src/hud/hud.ts`, `src/hud/hud.css`)**：
     - 在动力面板中引入掠海掠岩共鸣充能槽（`.hud-resonance-track`），当在贴水/近崖 $0.9\sim 2.2\text{m}$ 掠行时，触发青金渐变水彩微光波纹平滑蓄力进度；
     - 调优 Solarpunk 四叶水彩旋转小风车（`ready` 柔和微风转动、`active` 极速风车飞舞、`penalty` 惩罚警示）；
  4. **零泄漏与全分辨率响应式排版**：
     - 保持按需差分 DOM 更新与零每帧垃圾回收（GC）内存分配；
     - 适配移动端与紧凑屏幕布局，严密杜绝 UI 元素视口重叠；
     - 在 [`docs/todo-test.md`](file:///var/www/wind-glider/docs/todo-test.md) 中追加 1 行本地复核要点。
  5. 运行 `npm run build`，通过 TypeScript 强类型校验（0 错误、0 警告）。
- **下一会话目标**：执行 `Task 10.2`（滑翔气流呼啸、木翼震颤、穿环风铃与环境风音效深度合成）。

### [2026-08-16] Session #32: Task 10.2 滑翔气流呼啸、木翼震颤、穿环风铃与环境风音效深度合成
- **目标文件**：[`src/audio/audio.ts`](file:///var/www/wind-glider/src/audio/audio.ts)
- **完成动作**：
  1. **滑翔气流呼啸与高空风哨 (Glider Airflow Rush & Wind Whistle)**：
     - 在 `src/audio/audio.ts` 中构建多阶白噪动态滤波网络（`flightNoise` -> `flightNoiseHp` 180Hz -> `flightNoiseBp` 420Hz~2370Hz -> `flightNoiseGain`），随物理空速、迎角升力与空气刹车扰流线性/指数动态扫频开合；
     - 引入高空气动风哨正弦微调层（`flightWhistleOsc` 1200Hz~2550Hz），在高速俯冲与腾空滑翔时营造清透的高空风语感。
  2. **木翼帆布微震颤与共鸣 (Wood Wing Flutter & Canvas Vibrato)**：
     - 构建低通木构微震颤网络（`wingFlutterNoise` -> `wingFlutterLp` 140Hz~300Hz -> `wingFlutterGain`），在高速俯冲、大迎角过载与空气刹车扰流时产生真实木质机身与帆布翼膜受力微震颤体感。
  3. **穿环风铃与古代石门共鸣 (Solarpunk Pentatonic Furin Chimes)**：
     - 升级 7 阶古代石门风铃泛音系列（E5~E6 和弦），结合物理铜铃声学分音（$f_0$ + $2.756f_0$ + $5.404f_0$）；
     - 暴露暖气流抬升（`thermalWhoosh`）、风道弹射（`windTunnelBoost`）与翼地共鸣（`groundSkimResonance`）音效合成接口。
  4. **自然海风呼吸与远景海鸥鸣叫 (Ambient Sea Breeze & Seagull Call)**：
     - 在环境总线（`ambienceBus`）中实现基于 $0.08\text{Hz}$ 柔和正弦呼吸波动的晴空海风；
     - 实现纯 Web Audio FM/正弦双阶梯弯音合成的远景海鸥自然鸣叫（`playSeagullCall`），在竞速/飞行中以有机间隔触发，并在环境音试听时即时预览。
  5. **内存纯净与契约测试通过**：
     - 所有 Web Audio 瞬态节点与 one-shot 均绑定自动断开与内存自释放逻辑，`activeOneShots` 严格受控（$\le 24$），无常驻悬挂 buffer；
     - 执行 `npm run build`（TypeScript 0 错误、0 警告）并通过 `node harness/audio.mjs` 全量契约测试；
     - 在 [`docs/todo-test.md`](file:///var/www/wind-glider/docs/todo-test.md) 中追加 1 行本地复核要点。
- **下一会话目标**：执行 `Task 11.1`（更新端到端自动化契约测试适配新 3D 飞行系统）。

### [2026-08-16] Session #33: Task 11.1 更新端到端自动化契约测试适配新 3D 飞行系统
- **目标文件**：[`harness/screenshot.mjs`](file:///var/www/wind-glider/harness/screenshot.mjs), [`harness/audio.mjs`](file:///var/www/wind-glider/harness/audio.mjs), [`harness/collision.mjs`](file:///var/www/wind-glider/harness/collision.mjs), [`harness/systems.mjs`](file:///var/www/wind-glider/harness/systems.mjs), [`src/hud/driverSelect.css`](file:///var/www/wind-glider/src/hud/driverSelect.css)
- **完成动作**：
  1. **自动化契约测试全面适配与验证**：
     - `npm run verify:systems`：验证 AI 竞速 pacing、6 位吉卜力飞行员属性与 14 圈耐久赛契约，100% 通过；
     - `npm run verify:collision`：验证连续碰撞检测 (CCD)、15 对船体对撞矩阵、飞行门隔离、4号门 8m 边界判定与检查点隔离，100% 通过；
     - `npm run verify:audio`：验证 Web Audio 混音器、倒计时阶段、GO 单音节频率与增益峰值、BGM 无缝循环与后台静音恢复，100% 通过；
     - `npm run verify:mobile`：优化 `driverSelect.css` 响应式媒体查询（兼容紧凑横屏触控设备），修复移动端飞行员立绘 lock-in 动画断言与虚拟输入，100% 通过；
     - `npm run verify:flight`：验证 PC 键盘/手柄输入、飞行包络（基础 6.45s / 续航 8.85s）、7 航道着水回收与终点冲刺，100% 通过；
     - `npm run verify:performance`：适配 3D 奇观航道（5 大主题地貌、40 朵水彩积雨云、7 道天光光柱、5 处暖气流与 4 条风道）draw calls 预算（$\le 750$）与 4K 自适应分辨率预算，100% 通过。
  2. **代码卫生与格式规范**：
     - 清理所有 TS / GLSL / Markdown 中的 trailing whitespace 与多余空行，通过 `git diff --check`。
     - 确保测试执行完毕后优雅终止所有 Playwright 与 Vite 进程，端口与内存零残留。
  3. 执行 `npm run build`（TypeScript 0 错误、0 警告）。
  4. 在 [`docs/todo-test.md`](file:///var/www/wind-glider/docs/todo-test.md) 中追加 1 行归档记录。
- **下一会话目标**：执行 `Task 11.2`（生产发布、Nginx 部署与 GitHub 仓库就绪）。

### [2026-08-16] Session #34: Task 11.2 生产发布、Nginx 部署与 GitHub 仓库就绪
- **目标文件**：[`dist/`](file:///var/www/wind-glider/dist/), [`/etc/nginx/sites-available/wind.hp666.cc.conf`](file:///etc/nginx/sites-available/wind.hp666.cc.conf), [`README.md`](file:///var/www/wind-glider/README.md), [`scripts/release-checked.sh`](file:///var/www/wind-glider/scripts/release-checked.sh), [`docs/llmwiki.md`](file:///var/www/wind-glider/docs/llmwiki.md), [`docs/handoff.md`](file:///var/www/wind-glider/docs/handoff.md), [`docs/todo-test.md`](file:///var/www/wind-glider/docs/todo-test.md)
- **完成动作**：
  1. **生产构建与验证**：
     - 执行 `npm run build`，通过 TypeScript 强类型校验与 Vite 生产打包（`dist/` 资源完整无损坏）；
     - 验证全量契约测试套件：飞行气动、手柄输入、移动端虚拟摇杆、CCD 碰撞、Web Audio 混音与事件流、AI 竞速与 14 圈耐久赛、性能预算（Draw calls $\le 658$），100% 全绿通过。
  2. **Nginx 部署与线上服务**：
     - 确认 `/etc/nginx/sites-available/wind.hp666.cc.conf` 软链接至 `sites-enabled/`，测试 `nginx -t` 语法 100% 正确并热重载；
     - 验证 `https://wind.hp666.cc` 线上服务（HTTP/2 200 OK，SSL 证书与 30 天静态资产强缓存正常生效）。
  3. **文档与仓库就绪**：
     - 全面更新 `README.md`，增加空气动力学、翼地效应、暖气流柱、风道弹射、3D 奇观航道、6 位吉卜力飞行员、双制式航空仪表盘与操作指南；
     - 完善 `scripts/release-checked.sh` 脚本路径与 release 契约配置；
     - 同步更新 `docs/llmwiki.md`、`docs/handoff.md` 与 `docs/todo-test.md`。
  4. **彻底清理与零残留**：
     - 优雅销毁所有临时 Playwright 与 Vite 测试进程，确保端口与内存零泄漏；
     - 通过 `git diff --check` 代码格式与空白字符校验。
- **里程碑状态**：🎉 **Milestone 7 ~ 11 全量重构与深度开发已全部圆满交付！**
- **下一会话目标**：执行 `Task 12.1`（移动端左侧动态浮动黄铜罗盘摇杆与按键长按恢复）。

### [2026-08-16] Session #35: Task 12.1 移动端左侧动态浮动黄铜罗盘摇杆与按键长按恢复
- **目标文件**：[`src/core/mobileControls.ts`](file:///var/www/wind-glider/src/core/mobileControls.ts), [`src/core/mobileControls.css`](file:///var/www/wind-glider/src/core/mobileControls.css), [`src/core/input.ts`](file:///var/www/wind-glider/src/core/input.ts)
- **完成动作**：
  1. **移动端左侧动态浮动黄铜罗盘摇杆 (Floating Compass Joystick)**：
     - 在 `src/core/mobileControls.ts` 与 `src/core/mobileControls.css` 中构建吉卜力黄铜罗盘浮动摇杆（`.mobile-joystick`）；
     - 当玩家触碰左半屏（$X < 48\%\text{vw}$）任意区域时，以落点为圆心唤出黄铜罗盘与星轨指针；
     - 实现 360° 全向模拟量输入：水平 $X \in [-1, 1]$ 平滑控制航向与滚转压弯，垂直 $Y \in [-1, 1]$ 控制俯冲加速与后拉爬升（后拉过半在飞行中亦可辅助空刹）；
     - 当手指划出外圈（$R = 50\text{px}$）时自动截断为 1.0 模长，抬手松开时应用三阶贝塞尔弹簧阻尼平滑回中（`cubic-bezier(0.175, 0.885, 0.32, 1.275)`）并优雅渐隐；
     - 保持与自动化测试契约（`.mobile-steer-zones`、`[data-mobile-action="left/right"]`）100% 几何与事件兼容。
  2. **右侧极简手绘水彩双动作气泡与视野留白**：
     - 右下角「漂/刹」（水面漂移 / 空中空刹 / 冲线刹车）与右上角「飞/续」（水面起飞 / 空中续航 / 冲线就绪）双水彩气泡布局；
     - 屏幕中央保持 100% 留白与通透视野，零多余 UI 阻挡；
     - 羊皮纸墨水与黄铜描边质感，附带触控动态缩放与同心圆进度环反馈。
  3. **按键长按恢复 (Held Key Recovery)**：
     - 在 `src/core/input.ts` 中移植 `recover held keyboard actions`：利用 `keydown` 重复事件（`e.repeat`）无缝恢复失焦、切屏或过场后的按键长按状态，同时严密隔离一次性瞬态输入（如 `Space` 起飞）。
  4. **构建与契约测试验证**：
     - `npm run build`：TypeScript 0 错误、0 警告通过；
     - `npm run verify:mobile`：移动端触控、横竖屏切换、飞行员立绘、全流程控制 100% 通过；
     - `npm run verify:flight`：飞行气动与手柄控制契约 100% 通过。
  5. 更新 [`docs/todo-test.md`](file:///var/www/wind-glider/docs/todo-test.md) 与 [`docs/llmwiki.md`](file:///var/www/wind-glider/docs/llmwiki.md)。
- **下一会话目标**：执行 `Task 12.2`（空中刹车落地切水漂移与智能防砸地面/水面气垫保护）。

### [2026-08-16] Session #36: Task 12.2 空中刹车落地切水漂移与智能防砸地面/水面气垫保护
- **目标文件**：[`src/game/boat.ts`](file:///var/www/wind-glider/src/game/boat.ts), [`src/contracts.ts`](file:///var/www/wind-glider/src/contracts.ts)
- **完成动作**：
  1. **空中刹车落地无缝切入切水漂移 (Air-brake to Drift Landing Handoff)**：
     - 在 `src/game/boat.ts` 的 `update()` 与 `updateFlight()` 中重塑落水触水（`surfaceContact`）无缝交接逻辑；
     - 当处于滑翔状态（`flightPhase !== 'surface'`）或腾空抛物线状态（`airborne`）且玩家按住空气刹车（`input.airBrake` / `Shift` / 摇杆后拉减速）时，在落水触水的瞬间立即无缝切入水面漂移（`st.drifting = true` / `wasDrifting = true`）；
     - 触水瞬间立即激发三向切水水刀喷雾（`this.spray.burst` 艇艉与双侧水翼切水）并无缝起步累积 `boostCharge` 漂移能量槽，消除任何动作打断与卡顿；
     - 水面漂移释放推进（Boost）与风之能量石（`flightCharges`）充能机制严密协同。
  2. **智能防砸地面/水面气垫保护 (Ground Auto-Level & Cushion)**：
     - 在 `TUNING` 中引入 `groundAutoLevelAlt: 3.0`、`groundAutoLevelFlare: 0.02`、`groundCushionSinkDamp: 4.2`；
     - 当滑翔机大角度俯冲接近水面/地面（$Y < 3\text{m}$ 且向下垂直速度较大）时，自然施加气垫效应升力托举与机头平缓回平（`aeroPitch` 柔和拉平至 $+0.02\text{ rad}$ 微扬仰角），使大俯冲平滑转为贴水极速掠行，彻底防止倒栽葱砸水；
     - 动态气垫力结合冲压动压 $q_m$ 与下沉阻尼，将垂直势能无缝转化为贴海高速掠行速度与共鸣充能。
  3. **构建与契约测试验证**：
     - `npm run build`：TypeScript 0 错误、0 警告通过；
     - `npm run verify:flight`：飞行气动与手柄控制契约 100% 通过；
     - `npm run verify:mobile`：移动端触控与全流程控制 100% 通过。
  4. 同步更新 [`docs/todo-test.md`](file:///var/www/wind-glider/docs/todo-test.md) 与 [`docs/llmwiki.md`](file:///var/www/wind-glider/docs/llmwiki.md)。
- **下一会话目标**：执行 `Task 12.3`（触控震动反馈与世界坐标手绘转弯指示牌）。

### [2026-08-16] Session #37: Task 12.3 触控震动反馈与世界坐标手绘转弯指示牌
- **目标文件**：[`src/game/course.ts`](file:///var/www/wind-glider/src/game/course.ts), [`src/hud/hud.ts`](file:///var/www/wind-glider/src/hud/hud.ts), [`src/hud/hud.css`](file:///var/www/wind-glider/src/hud/hud.css), [`src/core/haptics.ts`](file:///var/www/wind-glider/src/core/haptics.ts)
- **完成动作**：
  1. **世界坐标系手绘木质转弯指示牌与浮标 (`src/game/course.ts`)**：
     - 在航道所有急转弯与分岔口部署吉卜力手绘木质立牌（`freestanding turn signs`）与多层木构波浪浮标（`buoys`）；
     - 采用柚木/深木材质、黄铜包角锁扣、双面可读水彩墨印箭头与波浪浪花泡环；
     - 确保转弯立牌箭头方向与航道切线/转向指引（`left/right`）严格同向对齐，浮标底座随 Gerstner 5波浪高动态浮动倾侧。
  2. **HUD 路线指引与控制提示升级 (`src/hud/hud.ts`, `src/hud/hud.css`)**：
     - 增强世界坐标到屏幕的航向组合按键短提示（`[SHIFT] + [←/→] 空刹入弯`），并与移动端浮动摇杆及双水彩气泡高亮无缝衔接；
     - 在航空高度仪气动指示器中集成动态俯冲加速（`DIVE [W] ⇲` / `俯冲加速 ⇲`）与仰冲爬升（`CLIMB [S] ⇱` / `仰冲爬升 ⇱`）姿态短提示。
  3. **触控震动反馈精细调优 (`src/core/haptics.ts`)**：
     - 调优移动端穿过古代风环（清脆轻震 15ms）、腾空起飞（双脉冲 25ms + 40ms）、落地无缝切漂（`[14, 18, 14]` 连续微震）与防砸撞门保护柔和警告脉冲（`[16, 24, 16]`），显著增强触感体验。
  4. **全量构建与契约测试验证**：
     - `npm run build`：TypeScript 0 错误、0 警告通过；
     - `npm run verify:flight`：飞行气动与手柄控制契约 100% 通过；
     - `npm run verify:mobile`：移动端触控与全流程控制 100% 通过。
  5. 同步更新 [`docs/todo-test.md`](file:///var/www/wind-glider/docs/todo-test.md) 与 [`docs/llmwiki.md`](file:///var/www/wind-glider/docs/llmwiki.md)。
- **里程碑状态**：🎉 **Milestone 12（触控操作与全平台体验升华）已全部圆满交付！**
- **下一会话目标**：执行 `Task 13.1`（白垩海岬、红瓦风车海滨村落与海洋生态系统）。

### [2026-08-16] Session #38: Task 13.1 白垩海岬、红瓦风车海滨村落与海洋生态系统
- **目标文件**：[`src/game/course.ts`](file:///var/www/wind-glider/src/game/course.ts), [`src/core/palette.ts`](file:///var/www/wind-glider/src/core/palette.ts), [`docs/todo-test.md`](file:///var/www/wind-glider/docs/todo-test.md), [`docs/llmwiki.md`](file:///var/www/wind-glider/docs/llmwiki.md), [`docs/handoff.md`](file:///var/www/wind-glider/docs/handoff.md)
- **完成动作**：
  1. **全局调色板拓展 (`src/core/palette.ts`)**：
     - 新增暖白石基座 `chalkStone`（`#FFF8E7`）、翡翠草坡 `hillsideGreen`（`#78C87A`）、地中海红瓦 `roofTerracotta`（`#E76F51`）、白垩石墙 `wallChalk`（`#FCF9F2`）以及海鸥与海豚生态色值（`seagullWhite`/`seagullWingGrey`/`seagullBeak`/`dolphinBody`/`dolphinBelly`）。
  2. **彻底废除海中暗黑孤山与地貌重构 (`src/game/course.ts`)**：
     - 彻底废除泥黑色岩石结构（原版 `makeCliff` 与 0x5D4037 泥黑材质）；
     - 实现 `makeChalkCapeCliff`：生成 Dover/Étretat 风格白垩海崖台地，具备海浪冲蚀水线凹槽、暖白石分层阶梯与翡翠草坡厚顶；
     - 峡谷区域升级为温暖陶土红岩 strata（`makeCanyonCliff` 与 `wonder-canyon-rock`）。
  3. **地中海红瓦白墙木屋群与大风车 (`src/game/course.ts`)**：
     - 实现 `makeVillageHouse`：包含白石墙面、红瓦坡屋顶、外露木构柱梁、门窗木百叶、石砌烟囱、露台木栏杆与花卉盆栽；
     - 在西岸海岬阶梯台地与东岸岬角依山就势布置 10 栋多层次红瓦白墙村落民居；
     - 实现 `makeChalkWindmill`：在西岸悬崖顶端（X=-64, Y=28, Z=235）与东岸高岬（X=66, Y=24, Z=275）部署 4 叶旋转大木质风车，随海风自然旋转。
  4. **木质滑翔起飞跳台跑道 (`src/game/course.ts`)**：
     - 实现 `makeGliderLaunchPier`：开局起跑点打造延伸向大海的宏伟木质滑翔跳台跑道（从 Z=-35 贯穿至 Z=225），配备水下加固木桩、横梁斜撑、厚木甲板、黄铜领航航标灯与前沿弹射起飞跳台斜坡。
  5. **世界生机与生态系统 (`src/game/course.ts`)**：
     - **惊飞海鸥群 (`scenerySeagulls`)**：低多边形手绘白色海鸥群，开局弹射出海或飞艇掠过时在跑道上空盘旋，在草坡海崖上升气流中振翅滑翔；
     - **跃水飞鱼/海豚 (`sceneryLeapingCreatures`)**：浅海与环礁水道中 5 组海豚与飞鱼群周期性波光跃水、空中抛物线翻跃与入水扩散泡沫波纹；
     - **飘散草屑与蒲公英花瓣 (`scenerySporesPoints`)**：飞艇贴坡与海风吹拂时微粒在翡翠草坡台地自然漂移。
  6. **全量构建与契约测试验证**：
     - `npm run build`：TypeScript 0 错误、0 警告通过；
     - `npm run verify:collision`：碰撞判定契约 100% 通过；
     - `npm run verify:flight`：飞行气动与手柄控制契约 100% 通过；
     - `npm run verify:mobile`：移动端触控与全流程控制 100% 通过。
  7. 同步更新 [`docs/todo-test.md`](file:///var/www/wind-glider/docs/todo-test.md) 与 [`docs/llmwiki.md`](file:///var/www/wind-glider/docs/llmwiki.md)。
- **下一会话目标**：执行 `Task 13.2`（航道地貌与生态交互深度打磨）。
