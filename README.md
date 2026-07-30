# creator-master × WorkBuddy 插件

让老师在腾讯 **WorkBuddy**（CodeBuddy 团队的 AI Agent 桌面工作台）里，**不打开 creator-master 网站/app**，就地创作教学应用——覆盖 **绘画 (image) / 课件 (learn) / 音乐 (music) / 视频 (video)** 四领域。

- 创作走 creator-master 原平台引擎（`createDraftApp`），**按规则扣创作分**，扣到密钥绑定的老师账号。
- 密钥**绑个人账号**（PAT，HMAC），在 creator-master 用户中心「API 密钥」生成。
- 后端薄路由 + 扣分 + 鉴权见 creator-master：`packages/backend/src/routes/integrations/workbuddy-apps.ts`。

## 前置条件

1. creator-master 后端已部署本插件所需的接口（WorkBuddy 集成 PoC：PAT 鉴权 + 薄创建路由 + 扣分 + PAT 签发页）。
2. 老师在 creator-master 是**创作者 (creator)** 角色，并在**用户中心 →「API 密钥」**生成一个个人密钥（`ak_live_...`，明文只显示一次）。
3. 本机装有 **Node.js ≥ 18**（MCP server 用全局 `fetch`，零依赖，无需 `npm install`）。

## 安装（WorkBuddy）

### 方式 A：插件市场（推荐）

把本仓库推到 GitHub，然后在 WorkBuddy 里：

```
/plugin marketplace add <你的GitHub用户名>/workbuddy-creator-plugin
```

安装 `creator-master` 插件时，WorkBuddy 会让你填写两项配置（即 `userConfig`）：

| 配置项 | 值 |
|--------|----|
| **API_ENDPOINT** | creator-master 后端地址，如 `http://localhost:3000`（不含 `/api/v1`） |
| **API_TOKEN** | 用户中心生成的个人密钥 `ak_live_...`（敏感，存入系统钥匙串） |

### 方式 B：手动兜底（内测版 userConfig 注入异常时）

若 WorkBuddy 内测版未能把 `userConfig` 注入 MCP 环境变量，把配置写进文件：

```bash
mkdir -p ~/.workbuddy-creator
cat > ~/.workbuddy-creator/config.json <<'EOF'
{ "endpoint": "http://localhost:3000", "token": "ak_live_你的密钥" }
EOF
```

MCP server 检测到环境变量缺失或未被替换（含 `${`）时，会自动读这个文件。

## 使用

安装后，在 WorkBuddy 对话里直接说要做什么应用，例如：

> 帮我做一个讲光合作用的课件（小学科学）

WorkBuddy 的 agent 会用本插件的 `create-app` 技能：确认领域与需求 → 调用 `create_app` 创建（扣分）→ 给你预览链接 → 你确认后 `publish_app` 提交审核 → 给你可分享给学生使用链接。

若 AI 生成不理想（默认模板兜底）、积分不足或密钥失效，agent 会如实告知，不会假装成功。

## 提供的 MCP 工具

| 工具 | 说明 |
|------|------|
| `create_app({domain, requirement, title?})` | 创建应用（扣创作分）。`domain` ∈ image/learn/music/video |
| `list_my_apps({domain?})` | 列出本人应用 |
| `get_app({appId})` | 查应用状态/链接 |
| `publish_app({appId})` | 草稿提交审核（不重复扣分） |

## 结构

```
workbuddy-creator-plugin/
├── .codebuddy-plugin/
│   ├── plugin.json          # 插件清单 + userConfig（API_ENDPOINT/API_TOKEN）
│   └── marketplace.json     # 去中心化市场清单（source: "."）
├── .mcp.json                # MCP server 声明（node + env 注入）
├── mcp-server/index.js      # 零依赖 stdio MCP server（JSON-RPC + 全局 fetch）
├── skills/create-app/SKILL.md  # 引导 agent 创作→预览→发布
└── README.md
```

## 本地自测 MCP server

```bash
# initialize 握手
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' | node mcp-server/index.js
# 列工具
echo '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' | API_ENDPOINT=http://localhost:3000 API_TOKEN=ak_live_x node mcp-server/index.js
```

## 范围与限制

- **领域**：image / learn / music / video。**game 暂未开放**（其创建入口是 agent game-gen，不共享 createDraftApp，Phase 1 再接）。
- 创作**扣分**到密钥绑定账号；重试会再次扣分。
- 密钥明文只在 creator-master 用户中心签发时显示一次；遗失请吊销重建。
