---
name: create-app
description: 用于当老师想"做一个教学应用 / 课件 / 绘画工具 / 音乐工具 / 视频工具"、"帮我生成一个 XX 应用"、"做个光合作用的课件"等创作教学应用类需求时。引导确认领域与需求，调用 creator-master 引擎创建应用，并推进到预览/发布。
description_zh: "引导老师在 WorkBuddy 里创作教学应用（绘画/课件/音乐/视频）"
description_en: "Guide teachers to create teaching apps (painting/courseware/music/video) on creator-master"
version: 1.0.0
---

# 创作教学应用（creator-master）

把老师的自然语言需求变成 creator-master 上的教学应用，全程不用离开 WorkBuddy。覆盖五个领域：**绘画 (image)、课件 (learn)、音乐 (music)、视频 (video)、游戏 (game)**。

> ⚠️ 创建与运行（run_app）会按平台规则**扣创作分**，扣的是密钥绑定老师的账号。game 创建预扣较多（失败自动退还）；发布**不重复扣分**。若密钥无效或积分不足，工具会返回明确提示——照提示引导老师处理，不要假装成功。

## 何时使用本技能

老师表达"想做一个应用 / 课件 / 工具"类意图，且属于上述四领域之一。例如：
- "帮我做一个讲光合作用的课件" → learn
- "做一个让学生练写字的绘画应用" → image
- "做个能编简单旋律的音乐工具" → music
- "做个科普短视频应用" → video

## 创作流程

### 1. 确认领域与需求（缺一不可再创建）

用一两轮对话补齐：
- **领域 domain**：拿不准时按内容判断（讲知识点→learn；画画/涂鸦→image；编曲/音效→music；视频/动画短片→video；做题/闯关/小游戏→game）。
- **需求 requirement**：学科、学段、主题、要学生做什么。需求越具体，生成质量越高。

不要在 requirement 含糊时就调用 create_app——先问清楚一句话能说清的核心目标。

### 2. 创建：调用 `create_app`

```
create_app({ domain: "learn", requirement: "小学科学，光合作用，让学生通过场景理解阳光/水/二氧化碳如何变成养分" })
```

- 成功：返回 `appId` + 预览/使用链接。把**预览链接**给老师，请其确认效果。
- **兜底（isFallback=true）**：AI 生成不理想，已用默认模板。务必如实告诉老师，并询问"要不要调整需求重试"——**重试会再次扣分**，需老师确认。不要把兜底当成成功。
- 积分不足（402）：告诉老师去 creator-master 充值后再创建。
- 密钥无效（401）：告诉老师去 creator-master 用户中心「API 密钥」重新生成并更新到 WorkBuddy 插件配置。

### 3. 预览确认

把预览链接交给老师。询问应用是否符合预期；如需修改，调整 requirement 重新 `create_app`（会扣分，先告知）。

### 4. 发布（老师确认后）

```
publish_app({ appId })
```

提交审核。审核通过后学生即可使用，把**使用链接**给老师用于分享。

## 护栏

- **不编造内容**：requirement 由老师的需求决定；不要替老师编学科结论。
- **如实传达状态**：兜底、扣分失败、鉴权失败都要照实说，不粉饰。
- **领域约束**：支持 image/learn/music/video/game 五域；run_app 的 music/game 仅限作者本人应用。
- **扣分透明**：每次 create_app 前若需求明显会多次重试，提醒"每次创建都会扣创作分"。

## 运行应用（run_app）

老师想"**用**"某个已有应用时（不是新建）：`run_app({appId, input, sessionId?, confirm?})`。各领域一轮语义（如实告知老师，不要粉饰）：

| 领域 | 一轮得到什么 | 续聊方式 |
|------|------------|---------|
| image | ✅ 成品图/信息图（SVG） | 传 sessionId 继续（"把标题改成绿色"） |
| music | ✅ 一首歌（含封面） | 再 run 同一应用即接着改 |
| learn | ⚠️ 先出**大纲**；老师**确认后**逐场景生成配图配音（10-30 分钟，可能超工具等待上限——生成在后台继续，稍后到创作页看） | 老师表达确认时**传 confirm=true**（结构化优先，防"可以再加一章"被误判）；改大纲直接说 |
| video | ⚠️ 推进流水线阶段（分镜/角色/场景图），一轮**不出成片** | 传 sessionId 继续推进 |
| game | ✅ 迭代老师自己的游戏（加关卡/改玩法），返回可玩链接 | 再 run 同一应用 |

**权限**：image/learn/video 可运行自己的或已发布应用；**music/game 仅限应用作者本人**（运行会修改应用的作品内容——他人应用请到平台前端体验）。

**产物**：图片直接显示在对话里；链接 7 天内有效、可直接打开无需登录；创作页链接需登录平台。

## 常用工具

| 工具 | 用途 |
|------|------|
| `create_app({domain, requirement, title?})` | 创建应用（扣分；异步，agent 多轮生成约 1-3 分钟，工具自动等结果） |
| `run_app({appId, input, sessionId?, confirm?})` | 运行指定应用拿产物（扣分；异步自动等结果；learn 确认传 confirm=true） |
| `list_my_apps({domain?})` | 看老师已有的应用 |
| `get_app({appId})` | 查某个应用的状态/链接 |
| `publish_app({appId})` | 草稿提交审核（不扣分） |
