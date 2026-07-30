---
name: create-app
description: 用于当老师想"做一个教学应用 / 课件 / 绘画工具 / 音乐工具 / 视频工具"、"帮我生成一个 XX 应用"、"做个光合作用的课件"等创作教学应用类需求时。引导确认领域与需求，调用 creator-master 引擎创建应用，并推进到预览/发布。
description_zh: "引导老师在 WorkBuddy 里创作教学应用（绘画/课件/音乐/视频）"
description_en: "Guide teachers to create teaching apps (painting/courseware/music/video) on creator-master"
version: 1.0.0
---

# 创作教学应用（creator-master）

把老师的自然语言需求变成 creator-master 上的教学应用，全程不用离开 WorkBuddy。覆盖四个领域：**绘画 (image)、课件 (learn)、音乐 (music)、视频 (video)**。

> ⚠️ 创建会按平台规则**扣创作分**，扣的是密钥绑定老师的账号。发布**不重复扣分**。若密钥无效或积分不足，工具会返回明确提示——照提示引导老师处理，不要假装成功。

## 何时使用本技能

老师表达"想做一个应用 / 课件 / 工具"类意图，且属于上述四领域之一。例如：
- "帮我做一个讲光合作用的课件" → learn
- "做一个让学生练写字的绘画应用" → image
- "做个能编简单旋律的音乐工具" → music
- "做个科普短视频应用" → video

## 创作流程

### 1. 确认领域与需求（缺一不可再创建）

用一两轮对话补齐：
- **领域 domain**：拿不准时按内容判断（讲知识点→learn；画画/涂鸦→image；编曲/音效→music；视频/动画短片→video）。不在四个领域内（如纯游戏 game）就如实说明 game 暂未开放。
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
- **领域约束**：只支持 image/learn/music/video；game 暂不开放，别承诺。
- **扣分透明**：每次 create_app 前若需求明显会多次重试，提醒"每次创建都会扣创作分"。

## 常用工具

| 工具 | 用途 |
|------|------|
| `create_app({domain, requirement, title?})` | 创建应用（扣分；异步，agent 多轮生成约 1-3 分钟，工具自动等结果） |
| `list_my_apps({domain?})` | 看老师已有的应用 |
| `get_app({appId})` | 查某个应用的状态/链接 |
| `publish_app({appId})` | 草稿提交审核（不扣分） |
