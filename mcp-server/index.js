#!/usr/bin/env node
// ── creator-master × WorkBuddy 桥接 MCP 服务器（零依赖，stdio JSON-RPC）──────────
//
// 让老师在 WorkBuddy 里不打开 creator-master 网站/app，就地创作教学应用。
// 经 MCP 工具调用 creator-master 后端的 WorkBuddy 薄路由（见 backend
// src/routes/integrations/workbuddy-apps.ts），复用其 PAT 鉴权 + 扣分 + createDraftApp。
//
// 工具：
//   create_app({domain, requirement, title?})  → 创建应用（扣创作分）
//   list_my_apps({domain?})                    → 列本人的应用
//   get_app({appId})                           → 查应用详情/预览
//   publish_app({appId})                       → 提交审核
//
// 配置来源（优先级）：
//   1) 环境变量 API_ENDPOINT / API_TOKEN（由插件 userConfig → .mcp.json env 注入，主路径）
//   2) ${CODEBUDDY_PLUGIN_DATA}/config.json 的 endpoint/token（手动兜底，防内测版
//      userConfig 注入差异；格式 { "endpoint": "...", "token": "ak_live_..." }）
//   若都拿不到，工具调用返回明确指引而非崩溃。

'use strict'

const readline = require('node:readline')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const SERVER_NAME = 'creator-master'
const SERVER_VERSION = '1.0.0'
const SUPPORTED_DOMAINS = ['image', 'learn', 'music', 'video'] // game 推迟 Phase 1

// ── 配置解析 ──────────────────────────────────────────────────────────────
function readConfig() {
  let endpoint = process.env.API_ENDPOINT
  let token = process.env.API_TOKEN

  // 检测 userConfig 未被替换（内测版可能原样留下 ${user_config.X} 字面量）
  const looksUnsubstituted = (v) => !v || (typeof v === 'string' && v.includes('${'))
  if (looksUnsubstituted(endpoint) || looksUnsubstituted(token)) {
    const dataDir =
      process.env.CODEBUDDY_PLUGIN_DATA ||
      process.env.CLAUDE_PLUGIN_DATA ||
      path.join(os.homedir(), '.workbuddy-creator')
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'))
      if (looksUnsubstituted(endpoint)) endpoint = cfg.endpoint
      if (looksUnsubstituted(token)) token = cfg.token
    } catch {
      /* 无兜底配置文件，留给调用时报错指引 */
    }
  }
  return { endpoint, token }
}

function missingConfig() {
  return (
    '⚠️ 尚未配置 creator-master 连接信息。请在 WorkBuddy 插件设置里填写：\n' +
    '  - API_ENDPOINT：creator-master 后端地址（如 http://localhost:3000）\n' +
    '  - API_TOKEN：你在 creator-master 用户中心「API 密钥」生成的个人密钥（ak_live_...）\n' +
    '或在 ~/.workbuddy-creator/config.json 写入 {"endpoint":"...","token":"..."}。'
  )
}

// ── HTTP 调用 ─────────────────────────────────────────────────────────────
async function apiCall(token, endpoint, method, urlPath, body) {
  const res = await fetch(`${endpoint.replace(/\/+$/, '')}${urlPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  let data = null
  const text = await res.text()
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = { raw: text }
    }
  }
  return { status: res.status, data }
}

// 把后端 HTTP 错误翻成给老师/agent 的中文指引（不把原始报文直接抛给老师）
function translateHttpError(status, data) {
  const code = data?.error?.code || data?.code
  const backendMsg = data?.error?.message || data?.message
  if (status === 401) {
    return '🔐 API 密钥无效或已过期。请在 creator-master 用户中心「API 密钥」重新生成，并更新到 WorkBuddy 插件配置。'
  }
  if (status === 402) {
    return '💎 积分不足，请先在 creator-master 充值后再创建（创作会扣创作分）。'
  }
  if (status === 403) {
    return '🚫 无权操作。该密钥绑定的账号可能不是创作者（creator），请用创作者账号生成密钥。'
  }
  if (status === 404) {
    return '应用不存在或无权查看。'
  }
  if (status >= 400 && status < 500) {
    return `请求无效（${code || status}）：${backendMsg || '请检查参数'}`
  }
  return `creator-master 后端错误（${status}）：${backendMsg || '请稍后重试'}`
}

// ── 工具实现 ──────────────────────────────────────────────────────────────
async function createApp(args) {
  const { endpoint, token } = readConfig()
  if (!endpoint || !token) return { isError: true, text: missingConfig() }
  const domain = args?.domain
  if (!SUPPORTED_DOMAINS.includes(domain)) {
    return {
      isError: true,
      text: `不支持的领域「${domain}」。可选：${SUPPORTED_DOMAINS.join(' / ')}（game 暂未开放）。`,
    }
  }
  const requirement = typeof args?.requirement === 'string' ? args.requirement.trim() : ''
  if (!requirement) {
    return { isError: true, text: '请提供应用需求描述（requirement）。' }
  }

  const { status, data } = await apiCall(token, endpoint, 'POST', '/api/v1/integrations/workbuddy/apps', {
    domain,
    requirement,
    title: args.title,
  })
  if (status !== 201) return { isError: true, text: translateHttpError(status, data) }

  const d = data?.data || {}
  const lines = [
    `✅ 已创建「${domain}」领域应用`,
    `   appId：${d.appId}`,
    d.links?.preview ? `   预览：${d.links.preview}` : '',
    d.links?.play ? `   使用（发布后可用）：${d.links.play}` : '',
  ].filter(Boolean)
  if (d.isFallback) {
    lines.push(`   ⚠️ ${d.hint || '生成不理想，已用默认模板，可重试或调整需求。'}`)
  } else {
    lines.push('   可继续完善后调用 publish_app 提交审核。')
  }
  return { text: lines.join('\n'), appId: d.appId, isFallback: !!d.isFallback }
}

async function listMyApps(args) {
  const { endpoint, token } = readConfig()
  if (!endpoint || !token) return { isError: true, text: missingConfig() }
  const qs = args?.domain ? `?domain=${encodeURIComponent(args.domain)}` : ''
  const { status, data } = await apiCall(token, endpoint, 'GET', `/api/v1/integrations/workbuddy/apps${qs}`)
  if (status !== 200) return { isError: true, text: translateHttpError(status, data) }
  const apps = data?.data?.apps || []
  if (apps.length === 0) return { text: '还没有应用。调用 create_app 开始创作。' }
  const rows = apps.map(
    (a) => `- [${a.status}] ${a.name}（${a.domain}）appId=${a.id}`,
  )
  return { text: `你的应用（共 ${data.data.total} 个）：\n${rows.join('\n')}` }
}

async function getApp(args) {
  const { endpoint, token } = readConfig()
  if (!endpoint || !token) return { isError: true, text: missingConfig() }
  const appId = typeof args?.appId === 'string' ? args.appId.trim() : ''
  if (!appId) return { isError: true, text: '请提供 appId。' }
  const { status, data } = await apiCall(token, endpoint, 'GET', `/api/v1/integrations/workbuddy/apps/${encodeURIComponent(appId)}`)
  if (status !== 200) return { isError: true, text: translateHttpError(status, data) }
  const app = data?.data?.app
  if (!app) return { text: '应用详情为空。' }
  return {
    text: [
      `应用：${app.name}（${app.domain}）`,
      `状态：${app.status}`,
      app.description ? `描述：${app.description}` : '',
      data.data.links?.play ? `使用链接（发布后）：${data.data.links.play}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
  }
}

async function publishApp(args) {
  const { endpoint, token } = readConfig()
  if (!endpoint || !token) return { isError: true, text: missingConfig() }
  const appId = typeof args?.appId === 'string' ? args.appId.trim() : ''
  if (!appId) return { isError: true, text: '请提供 appId。' }
  const { status, data } = await apiCall(token, endpoint, 'POST', `/api/v1/integrations/workbuddy/apps/${encodeURIComponent(appId)}/publish`)
  if (status !== 200) return { isError: true, text: translateHttpError(status, data) }
  const msg = data?.data?.message
  return { text: msg ? `ℹ️ ${msg}` : '✅ 已提交审核，审核通过后学生即可使用。' }
}

// ── MCP 工具声明 ─────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'create_app',
    description:
      '在 creator-master 创建一个教学应用（覆盖 image 绘画 / learn 课件 / music 音乐 / video 视频）。' +
      '需要老师的自然语言需求；创建会按平台规则扣创作分。返回 appId、预览/使用链接；若 AI 生成不理想会标注并给提示。',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', enum: SUPPORTED_DOMAINS, description: '应用领域：image/learn/music/video' },
        requirement: { type: 'string', description: '应用需求的自然语言描述（老师想做什么应用）' },
        title: { type: 'string', description: '可选应用标题' },
      },
      required: ['domain', 'requirement'],
    },
  },
  {
    name: 'list_my_apps',
    description: '列出当前密钥绑定的老师在 creator-master 的应用。可选按领域过滤。',
    inputSchema: {
      type: 'object',
      properties: { domain: { type: 'string', enum: SUPPORTED_DOMAINS } },
    },
  },
  {
    name: 'get_app',
    description: '查询单个应用的详情与状态（预览/使用链接）。',
    inputSchema: {
      type: 'object',
      properties: { appId: { type: 'string' } },
      required: ['appId'],
    },
  },
  {
    name: 'publish_app',
    description: '把草稿应用提交审核（draft → completed）。审核通过后学生即可使用。不重复扣分。',
    inputSchema: {
      type: 'object',
      properties: { appId: { type: 'string' } },
      required: ['appId'],
    },
  },
]

const TOOL_HANDLERS = {
  create_app: createApp,
  list_my_apps: listMyApps,
  get_app: getApp,
  publish_app: publishApp,
}

// ── JSON-RPC over stdio ──────────────────────────────────────────────────
function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n')
}

async function handle(msg) {
  const { id, method, params } = msg
  try {
    if (method === 'initialize') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        },
      }
    }
    if (method === 'tools/list') {
      return { jsonrpc: '2.0', id, result: { tools: TOOLS } }
    }
    if (method === 'tools/call') {
      const name = params?.name
      const handler = TOOL_HANDLERS[name]
      if (!handler) {
        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `未知工具：${name}` }], isError: true } }
      }
      const out = await handler(params?.arguments || {})
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: out.text }],
          isError: out.isError === true,
        },
      }
    }
    // ping / 其它：空结果应答
    if (method === 'ping') return { jsonrpc: '2.0', id, result: {} }
    return { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } }
  } catch (err) {
    return {
      jsonrpc: '2.0',
      id,
      result: { content: [{ type: 'text', text: `工具执行出错：${err?.message || err}` }], isError: true },
    }
  }
}

function main() {
  const rl = readline.createInterface({ input: process.stdin, terminal: false, crlfDelay: Infinity })
  rl.on('line', (line) => {
    const s = line.trim()
    if (!s) return
    let msg
    try {
      msg = JSON.parse(s)
    } catch {
      return // 非 JSON 行忽略
    }
    // 通知（无 id）无需应答
    if (msg.id === undefined || msg.id === null) return
    handle(msg).then((reply) => {
      if (reply) send(reply)
    })
  })
  // stdio MCP：绝不向 stdout 写日志（会污染协议），日志走 stderr
  process.on('uncaughtException', (e) => process.stderr.write(`[creator-master MCP] uncaught: ${e}\n`))
}

main()
