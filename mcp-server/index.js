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
const SERVER_VERSION = '1.1.0'
const SUPPORTED_DOMAINS = ['image', 'learn', 'music', 'video', 'game']
// audio 块嵌入开关（裁定 4：以 WorkBuddy 实测为准——CodeBuddy 不渲染可置 false 回退 URL-only）
const EMBED_AUDIO_BLOCKS = process.env.EMBED_AUDIO === '0' ? false : true

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

// 把图片 URL 抓成 MCP image 内容块（{type:'image', data:base64, mimeType}），失败返回 null。
// 用于 get_app 把应用封面（cover_image）作为预览图直接嵌进 WorkBuddy（方案 B）。
async function fetchImageContent(url) {
  if (!url || typeof url !== 'string') return null
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    const ct = (res.headers.get('content-type') || 'image/png').split(';')[0].trim()
    if (!ct.startsWith('image/')) return null
    const buf = Buffer.from(await res.arrayBuffer())
    return { type: 'image', data: buf.toString('base64'), mimeType: ct }
  } catch {
    return null
  }
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
      text: `不支持的领域「${domain}」。可选：${SUPPORTED_DOMAINS.join(' / ')}。`,
    }
  }
  const requirement = typeof args?.requirement === 'string' ? args.requirement.trim() : ''
  if (!requirement) {
    return { isError: true, text: '请提供应用需求描述（requirement）。' }
  }

  // 1. POST → 202 + jobId（agent 后台跑，HTTP 立即返回）
  const { status, data } = await apiCall(token, endpoint, 'POST', '/api/v1/workbuddy/apps', {
    domain,
    requirement,
    title: args.title,
  })
  if (status !== 202) return { isError: true, text: translateHttpError(status, data) }
  const jobId = data?.data?.jobId
  if (!jobId) return { isError: true, text: '创建失败：后端未返回 jobId。' }

  // 2. 轮询 job 到完成（app-builder agent 多轮生成，分钟级）
  const job = await pollJob(token, endpoint, jobId)
  if (job.status === 'failed') {
    return { isError: true, text: `⚠️ ${job.error || '生成失败，可调整需求重试。'}` }
  }

  // 3. 完成 → 返回 appId + 链接
  const lines = [
    `✅ 已创建「${domain}」领域应用`,
    `   appId：${job.appId}`,
    (job.links?.create || job.links?.preview) ? `   创作页：${job.links?.create || job.links?.preview}` : '',
    job.links?.play ? `   使用（发布后可用）：${job.links.play}` : '',
    '   可到创作页继续完善，或调用 publish_app 提交审核。',
  ].filter(Boolean)
  return { text: lines.join('\n'), appId: job.appId }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 轮询 GET /jobs/:jobId 到 completed/failed（或超时）。opts 参数化：run 类传更长的 maxMs。 */
async function pollJob(token, endpoint, jobId, opts = {}) {
  const MAX_MS = opts.maxMs || 6 * 60 * 1000 // 默认 6 分钟（agent 多轮生成留足余量）
  const INTERVAL_MS = opts.intervalMs || 5000
  const start = Date.now()
  while (Date.now() - start < MAX_MS) {
    await sleep(INTERVAL_MS)
    const { status, data } = await apiCall(token, endpoint, 'GET', `/api/v1/workbuddy/jobs/${jobId}`)
    const d = data?.data
    if (d?.status === 'completed' || d?.status === 'failed') return d
    if (status === 404) return { status: 'failed', error: '任务已失效（后端可能重启），请重试。' }
    // pending → 继续轮询
  }
  return { status: 'failed', error: `生成超时（超过 ${Math.round(MAX_MS / 60000)} 分钟，agent 可能卡住或被重启打断）。` }
}

async function listMyApps(args) {
  const { endpoint, token } = readConfig()
  if (!endpoint || !token) return { isError: true, text: missingConfig() }
  const qs = args?.domain ? `?domain=${encodeURIComponent(args.domain)}` : ''
  const { status, data } = await apiCall(token, endpoint, 'GET', `/api/v1/workbuddy/apps${qs}`)
  if (status !== 200) return { isError: true, text: translateHttpError(status, data) }
  const apps = data?.data?.apps || []
  if (apps.length === 0) return { text: '还没有应用。调用 create_app 开始创作。' }
  const rows = apps.map(
    (a) => `- [${a.status}] ${a.name}（${a.domain}）appId=${a.id}` + (a.links?.create ? `\n    创作页：${a.links.create}` : ''),
  )
  return { text: `你的应用（共 ${data.data.total} 个）：\n${rows.join('\n')}` }
}

async function getApp(args) {
  const { endpoint, token } = readConfig()
  if (!endpoint || !token) return { isError: true, text: missingConfig() }
  const appId = typeof args?.appId === 'string' ? args.appId.trim() : ''
  if (!appId) return { isError: true, text: '请提供 appId。' }
  const { status, data } = await apiCall(token, endpoint, 'GET', `/api/v1/workbuddy/apps/${encodeURIComponent(appId)}`)
  if (status !== 200) return { isError: true, text: translateHttpError(status, data) }
  const app = data?.data?.app
  if (!app) return { text: '应用详情为空。' }
  const links = data?.data?.links || {}
  const text = [
    `应用：${app.name}（${app.domain}）`,
    `状态：${app.status}`,
    app.description ? `描述：${app.description}` : '',
    links.create ? `创作页：${links.create}` : '',
    links.play ? `使用页（发布后）：${links.play}` : '',
  ]
    .filter(Boolean)
    .join('\n')
  // 封面图作为预览直接嵌进 WorkBuddy（方案 B）；无封面则提示去创作页生成
  const images = []
  const img = await fetchImageContent(app.cover_image)
  if (img) images.push(img)
  return {
    text: images.length ? `${text}\n（封面预览见下图）` : `${text}\n（暂无封面，到创作页运行生成后才有预览图）`,
    images,
  }
}

async function publishApp(args) {
  const { endpoint, token } = readConfig()
  if (!endpoint || !token) return { isError: true, text: missingConfig() }
  const appId = typeof args?.appId === 'string' ? args.appId.trim() : ''
  if (!appId) return { isError: true, text: '请提供 appId。' }
  const { status, data } = await apiCall(token, endpoint, 'POST', `/api/v1/workbuddy/apps/${encodeURIComponent(appId)}/publish`)
  if (status !== 200) return { isError: true, text: translateHttpError(status, data) }
  const msg = data?.data?.message
  return { text: msg ? `ℹ️ ${msg}` : '✅ 已提交审核，审核通过后学生即可使用。' }
}

// ── run_app（openspec workbuddy-run-app）：调用指定应用 → 返回产物 ────────────
async function runApp(args) {
  const { endpoint, token } = readConfig()
  if (!endpoint || !token) return { isError: true, text: missingConfig() }
  const appId = typeof args?.appId === 'string' ? args.appId.trim() : ''
  if (!appId) return { isError: true, text: '请提供 appId。' }
  const input = typeof args?.input === 'string' ? args.input.trim() : ''
  if (!input) return { isError: true, text: '请提供运行输入（input）。' }
  if (input.length > 10000) return { isError: true, text: 'input 超过 10000 字上限。' }

  // 1. POST → 202 + jobId（learn 确认轮后端放宽 30min，轮询对齐 8min 常规上限，
  //    learn 内容生成超 8min 属预期——如实提示可继续轮询/到创作页查看）
  const body = { input }
  if (args?.sessionId) body.sessionId = args.sessionId
  if (args?.confirm === true) body.confirm = true
  const { status, data } = await apiCall(token, endpoint, 'POST', `/api/v1/workbuddy/apps/${encodeURIComponent(appId)}/run`, body)
  if (status === 404) {
    return { isError: true, text: '后端版本过低，不支持 run_app（需部署 2026-08-27 之后的后端）。请联系管理员升级。' }
  }
  if (status !== 202) return { isError: true, text: translateHttpError(status, data) }
  const jobId = data?.data?.jobId
  if (!jobId) return { isError: true, text: '运行失败：后端未返回 jobId。' }

  // 2. 轮询（run 类：8min 上限 / 10s 间隔）
  const job = await pollJob(token, endpoint, jobId, { maxMs: 8 * 60 * 1000, intervalMs: 10000 })
  if (job.status === 'failed') {
    return { isError: true, text: `⚠️ ${job.error || '运行失败，可调整输入重试。'}` }
  }

  // 3. 组装：reply + sessionId + artifacts（图片嵌块；音频按开关嵌块）
  const lines = ['✅ 运行完成', `   回复：${String(job.reply || '').slice(0, 500)}`]
  if (job.sessionId) lines.push(`   会话：${job.sessionId}（续聊/继续调整时传入 sessionId）`)
  const arts = Array.isArray(job.artifacts) ? job.artifacts : []
  if (arts.length === 0) {
    lines.push('   （本轮无新产物——生成失败或应用类型一轮不出成品，见上方回复）')
  } else {
    lines.push('   产物：')
    for (const a of arts) {
      const label = { image: '图片', svg: '信息图/矢量图', audio: '音频', video: '视频', outline: '大纲', game: '游戏' }[a.type] || a.type
      if (a.url) lines.push(`   - [${label}] ${a.url}${a.note ? `（${a.note}）` : ''}`)
      else if (a.text) lines.push(`   - [${label}] ${String(a.text).slice(0, 800)}`)
    }
  }
  if (job.links?.create) lines.push(`   创作页（需登录平台）：${job.links.create}`)

  const contentExtras = []
  for (const a of arts) {
    if (a.type === 'image' && a.url) {
      const img = await fetchImageContent(a.url)
      if (img) contentExtras.push(img)
    } else if (a.type === 'audio' && a.url && EMBED_AUDIO_BLOCKS) {
      try {
        const res = await fetch(a.url)
        if (res.ok) {
          const buf = Buffer.from(await res.arrayBuffer())
          contentExtras.push({ type: 'audio', data: buf.toString('base64'), mimeType: 'audio/mpeg' })
        }
      } catch { /* 音频嵌入失败退 URL */ }
    }
  }
  return { text: lines.join('\n'), images: contentExtras.filter((c) => c.type === 'image'), audios: contentExtras.filter((c) => c.type === 'audio') }
}

// ── MCP 工具声明 ─────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'create_app',
    description:
      '在 creator-master 创建一个教学应用（覆盖 image 绘画 / learn 课件 / music 音乐 / video 视频 / game 游戏）。' +
      '需老师的自然语言需求。创建是异步的：通常需 1-3 分钟（game 单轮出完整可玩游戏包），本工具会自动轮询到完成。' +
      '创建按平台规则扣创作分（game 预扣较多，失败自动退还）。成功返回 appId+预览/使用链接；失败返回提示，可调整需求重试。',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', enum: SUPPORTED_DOMAINS, description: '应用领域：image/learn/music/video/game' },
        requirement: { type: 'string', description: '应用需求的自然语言描述（老师想做什么应用）' },
        title: { type: 'string', description: '可选应用标题' },
      },
      required: ['domain', 'requirement'],
    },
  },
  {
    name: 'run_app',
    description:
      '调用（运行）creator-master 上的指定应用：传入自然语言输入，平台代跑一轮生成，返回 AI 回复 + 产物（图片/信息图 SVG/歌曲/课程大纲/游戏链接）。' +
      '各领域一轮语义【如实告知老师】：image=出成品图/信息图（可续聊改图）；music=出一首歌；learn=先出大纲，老师确认后（回复"确认"或传 confirm=true）逐场景生成配图配音（10-30 分钟，超 8 分钟工具会超时但生成仍在后台继续，可稍后到创作页查看）；' +
      'video=推进流水线阶段（分镜/角色/场景图，一轮不出成片）；game=迭代老师自己的已有游戏（加关卡/改玩法，返回可玩链接）。' +
      '权限：image/learn/video 可运行自己的或已发布应用；music/game 仅限应用作者本人（运行会修改应用的作品内容）。' +
      '运行按平台规则扣创作分。产物链接 7 天内有效、可直接打开无需登录；创作页链接需登录平台。',
    inputSchema: {
      type: 'object',
      properties: {
        appId: { type: 'string', description: '要运行的应用 ID' },
        input: { type: 'string', description: '自然语言输入（想生成什么/怎么改），≤10000 字' },
        sessionId: { type: 'string', description: '续聊凭证（上次 run 返回的会话 ID），传入即在上次基础上继续/调整' },
        confirm: { type: 'boolean', description: 'learn 确认信号：老师明确表达「确认/开始生成」时传 true（结构化优先，避免文本误判）' },
      },
      required: ['appId', 'input'],
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
  run_app: runApp,
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
      const content = [{ type: 'text', text: out.text }]
      if (Array.isArray(out.images) && out.images.length) content.push(...out.images)
      if (Array.isArray(out.audios) && out.audios.length) content.push(...out.audios)
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content,
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
