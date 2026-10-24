/**
 * chat.deepseek.com 网页端对话调用器（cookie / userToken 方案）。
 *
 * 流程（全部逆向自 chat.deepseek.com 的 main bundle，commit 4955e097）：
 *   1. Authorization: Bearer <userToken>（userToken 从浏览器 localStorage 拿）
 *   2. POST /api/v0/chat_session/create {} → data.biz_data.chat_session.id
 *   3. POST /api/v0/chat/create_pow_challenge {target_path:"/api/v0/chat/completion"}
 *      → data.biz_data.challenge {algorithm,challenge,salt,difficulty,signature,expire_at,...}
 *   4. 用 WASM（pow-solver）求出 answer
 *   5. header X-DS-PoW-Response = btoa(JSON: {algorithm,challenge,salt,answer,signature,target_path})
 *   6. POST /api/v0/chat/completion {chat_session_id,parent_message_id:null,prompt,...} → SSE 流
 *   7. 解 SSE，累积 assistant 正文
 *   8. POST /api/v0/chat_session/delete {chat_session_ids:[id]} → 用完即删，
 *      不在用户网页侧栏留垃圾对话（一次优化 = 3 条）。失败只 log，不影响已拿到的正文。
 *
 * **脆弱点**：WASM 的 URL/hash、请求体字段名、SSE 事件结构都随 DeepSeek 网页发版而变。
 * 变了就要重新抓包。这里把「能配的」都提成常量，方便改。
 *
 * 安全：userToken = 登录态，能以用户身份调网页端。只存本地 settings.json，不外发。
 */

import { createPowSolver } from './pow-solver.mjs';
import { VARIANT_KEYS, VARIANT_LABELS, systemPromptForStyle, cleanOptimized, ITERATION_SUFFIX, ITERATION_USER_PREFIX } from './optimize.js';

const BASE = 'https://chat.deepseek.com';
const COMPLETION_PATH = '/api/v0/chat/completion';
const SESSION_CREATE_PATH = '/api/v0/chat_session/create';
/** 删除会话。抓包自网页侧栏「删除」按钮（main.8d6a4f4bfa.js @906497）：
 *  `post("/api/v0/chat_session/delete", { json: { chat_session_ids: [...] } })`，
 *  前端只读 `json.data.biz_code`，成功码 0。不需要 PoW（PoW 只管 completion）。 */
const SESSION_DELETE_PATH = '/api/v0/chat_session/delete';
/** 会话列表。抓包自 main.8d6a4f4bfa.js @237402（**GET + query，不是 POST body**——
 *  用 POST 打会被 SPA 兜底成 9824 字节的 HTML，看着像 200 其实什么都没返回）：
 *  `http.get("/api/v0/chat_session/fetch_page", { query: { count, … } })`。 */
const SESSION_LIST_PATH = '/api/v0/chat_session/fetch_page';
const POW_CHALLENGE_PATH = '/api/v0/chat/create_pow_challenge';
const WASM_URL = 'https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm';

/** 标准 base64（网页端用的是 btoa）。Node 的 Buffer.toString('base64') 等价。 */
function base64Encode(str) {
  return Buffer.from(str, 'utf8').toString('base64');
}

/**
 * @param {{token: string, wasmPath?: string, fetchImpl?: Function, log?: Function,
 *           signal?: AbortSignal, timeoutMs?: number}} opts
 */
export async function createWebChatCaller(opts = {}) {
  const token = opts.token;
  if (!token || typeof token !== 'string' || token.trim() === '') {
    throw new Error('没给 userToken：把 chat.deepseek.com 的 userToken 填进 settings.json 的 webToken');
  }
  const log = opts.log ?? (() => {});
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  if (!fetchImpl) throw new Error('webchat 需要 fetch，但当前环境没有');
  const timeoutMs = opts.timeoutMs ?? 120000;

  const solver = opts.solver ?? await createPowSolver({
    wasmUrl: WASM_URL,
    wasmPath: opts.wasmPath,
    fetchImpl,
    log,
  });

  function authHeaders(extra = {}) {
    return {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'text/event-stream',
      ...extra,
    };
  }

  /** 带超时的 fetch（AbortController）。 */
  async function fetchJson(url, body, extraHeaders = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetchImpl(url, {
        method: 'POST',
        headers: authHeaders(extraHeaders),
        body: JSON.stringify(body ?? {}),
        signal: opts.signal ?? controller.signal,
      });
      if (!resp || !resp.ok) {
        const text = await safeText(resp);
        throw new WebChatError(`HTTP ${resp ? resp.status : '?'}: ${text.slice(0, 200)}`, resp ? resp.status : 0);
      }
      const json = await resp.json();
      return json;
    } finally {
      clearTimeout(timer);
    }
  }

  /** 创建一个聊天会话，返回 session id。 */
  async function createSession() {
    const json = await fetchJson(`${BASE}${SESSION_CREATE_PATH}`, {});
    // 实测（2026-10）响应形状：{code:0, data:{biz_code:0, biz_data:{id, seq_id, agent, model_type, …}}}
    // 老 bundle 里是 data.biz_data.chat_session.id —— 两种都接，抗改版。
    const d = json?.data?.biz_data;
    const id = (d && (d.id ?? d.chat_session?.id)) || null;
    if (!id) {
      throw new WebChatError('创建会话失败：响应里没有 id / chat_session.id');
    }
    log(`peak-whale: webchat 会话已创建 ${id}`);
    return id;
  }

  /**
   * 删除一个网页端会话（用完即删，不在用户侧栏留垃圾对话）。
   *
   * **尽力而为**：删除失败绝不影响已拿到的正文 —— 顶多侧栏多一条对话，
   * 答案丢了才是真损失。所以这里吞掉一切异常，不抛。
   *
   * 但**返回真实成败**（`true` = 服务端 biz_code 0）。原来只 log 不返回值，
   * 于是「删了没删」在本机毫无可查痕迹，出问题时只能靠猜（2026-10-11 就是这么
   * 被坑了一轮：Host 加载的是旧副本、压根没这段代码，日志却看着正常）。
   * @param {string} sessionId
   * @returns {Promise<boolean>}
   */
  async function deleteSession(sessionId) {
    if (!sessionId) return false;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20000);
      let json;
      try {
        json = await fetchImpl(`${BASE}${SESSION_DELETE_PATH}`, {
          method: 'POST',
          headers: authHeaders({ accept: 'application/json, text/plain, */*' }),
          body: JSON.stringify({ chat_session_ids: [sessionId] }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      if (!json || !json.ok) {
        log(`peak-whale: 删除会话 ${sessionId} 失败（HTTP ${json ? json.status : '?'}），忽略`);
        return false;
      }
      const text = await json.text();
      let code = null;
      try { code = JSON.parse(text)?.data?.biz_code; } catch { /* 非 JSON：当失败处理 */ }
      if (code === 0) {
        log(`peak-whale: 会话 ${sessionId} 已删除`);
        return true;
      }
      log(`peak-whale: 删除会话 ${sessionId} 返回 biz_code=${code ?? '解析失败'}，忽略`);
      return false;
    } catch (err) {
      log(`peak-whale: 删除会话 ${sessionId} 异常（${err?.message ?? err}），忽略`);
      return false;
    }
  }

  /**
   * 拉服务端会话列表（**只读**，用于「用完即删」的服务端取证）。
   *
   * 为什么需要：DSH 的 Host 日志不落盘（走 IPC），删除回执也不回传，
   * 所以「到底删干净没有」在本机无法证明；唯一权威裁判是服务端自己的列表。
   *
   * @param {{count?: number}} [options]
   * @returns {Promise<Array<{id:string,title:string,updatedAt:number}>>}
   */
  async function listSessions(options = {}) {
    const count = Math.max(1, Math.min(100, Number(options.count) || 100));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetchImpl(`${BASE}${SESSION_LIST_PATH}?count=${count}`, {
        method: 'GET',
        headers: authHeaders({ accept: 'application/json, text/plain, */*' }),
        signal: opts.signal ?? controller.signal,
      });
      if (!resp || !resp.ok) {
        throw new WebChatError(`会话列表 HTTP ${resp ? resp.status : '?'}`, resp ? resp.status : 0);
      }
      // 服务端在路径/方法不对（或网页改版）时把 SPA 兜底页当 **HTTP 200 + text/html** 返回，
      // 实测 9824 字节的 index.html。所以这里两处都要防：
      //   1. `.json()` 对 HTML 会抛裸 SyntaxError ⇒ 必须转成 WebChatError，否则上层只看到
      //      一句 "Unexpected token '<'"，完全不知道该干什么；
      //   2. 就算解析成功也要验 biz_code，不能只看 HTTP 状态。
      let json;
      try {
        json = await resp.json();
      } catch (err) {
        throw new WebChatError(`会话列表响应不是 JSON（${err?.message ?? err}）—— 接口路径可能已随网页改版变化`);
      }
      const data = json?.data;
      if (!data || data.biz_code !== 0) {
        throw new WebChatError(`会话列表 biz_code=${data ? data.biz_code : '?'}（${data ? data.biz_msg : '响应不是预期结构'}）`);
      }
      return (data.biz_data?.chat_sessions ?? []).map((s) => ({
        id: s.id ?? s.chat_session_id ?? '',
        title: s.title ?? '',
        updatedAt: Number(s.updated_at ?? 0),
      }));
    } finally {
      clearTimeout(timer);
    }
  }

  /** 取一道 PoW challenge。 */
  async function getChallenge() {
    const json = await fetchJson(`${BASE}${POW_CHALLENGE_PATH}`, { target_path: COMPLETION_PATH });
    const data = json?.data;
    if (!data || data.biz_code !== 0) {
      throw new WebChatError(`取 PoW challenge 失败：biz_code=${data ? data.biz_code : '?'} ${data ? data.biz_msg : ''}`);
    }
    const ch = data.biz_data?.challenge;
    if (!ch || !ch.challenge || !ch.salt) {
      throw new WebChatError('PoW challenge 结构不对：缺 challenge/salt');
    }
    return ch; // {algorithm, challenge, salt, difficulty, signature, expire_at, expire_after}
  }

  /** 解 PoW → 构造 X-DS-PoW-Response header。 */
  async function solvePowHeader() {
    const challenge = await getChallenge();
    const answer = await solver.solve(challenge); // {algorithm, challenge, salt, answer, signature}
    const payload = {
      algorithm: answer.algorithm,
      challenge: answer.challenge,
      salt: answer.salt,
      answer: answer.answer,
      signature: answer.signature,
      target_path: COMPLETION_PATH,
    };
    const headerValue = base64Encode(JSON.stringify(payload));
    log(`peak-whale: PoW 已解（difficulty=${challenge.difficulty}, answer=${answer.answer}）`);
    return { 'x-ds-pow-response': headerValue };
  }

  /**
   * 发一条消息，返回 assistant 的完整正文（解 SSE 流累积）。
   *
   * **用完即删**：会话在网页侧栏里是垃圾（一次优化 = 3 条对话），
   * 默认拿完正文就把它删掉。传 `autoDelete: false` 可保留（多轮续聊用）。
   * 删除失败只 log 不抛 —— 答案已到手，别为扫尾动作毁掉这次优化。
   *
   * @param {string} prompt
   * @param {{thinkingEnabled?: boolean, autoDelete?: boolean}} options
   * @returns {Promise<string>}
   */
  async function chat(prompt, options = {}) {
    const sessionId = await createSession();
    const autoDelete = options.autoDelete !== false;
    try {
      const powHeader = await solvePowHeader();

      const body = {
        chat_session_id: sessionId,
        parent_message_id: null,
        model_type: null,
        prompt,
        ref_file_ids: [],
        thinking_enabled: options.thinkingEnabled === true,
        search_enabled: false,
        source: null,
        action: null,
        preempt: false,
      };

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const resp = await fetchImpl(`${BASE}${COMPLETION_PATH}`, {
          method: 'POST',
          headers: authHeaders(powHeader),
          body: JSON.stringify(body),
          signal: opts.signal ?? controller.signal,
        });
        if (!resp || !resp.ok) {
          const text = await safeText(resp);
          throw new WebChatError(`completion HTTP ${resp ? resp.status : '?'}: ${text.slice(0, 300)}`, resp ? resp.status : 0);
        }
        const { content, error } = await parseSSE(resp, log);
        // 服务端通过 event:hint 报错（如 parallel_chat_limit = 同账号并发对话上限）。
        // 只在**没拿到正文**时才当失败——已经流出来的答案不该被一条尾部提示作废。
        if (error && (!content || content.trim() === '')) {
          const e = new WebChatError(
            `网页端拒绝：${error.content || error.finish_reason || 'unknown'}`,
            resp.status,
          );
          e.finishReason = error.finish_reason || '';
          throw e;
        }
        if (!content || content.trim() === '') {
          throw new WebChatError('网页端没返回正文（SSE 流空或格式变了）');
        }
        return content;
      } finally {
        clearTimeout(timer);
      }
    } finally {
      if (autoDelete) {
        const ok = await deleteSession(sessionId);
        // 把真实回执交给调用方累计。原来这里丢弃了结果，导致「删没删」在响应里
        // 完全看不出来 —— Host 加载到旧副本时就是靠这个盲区混过一整轮验证的。
        if (typeof options.onSessionDeleted === 'function') {
          try { options.onSessionDeleted(sessionId, ok); } catch { /* 回调不许影响主流程 */ }
        }
      }
    }
  }

  return { chat, createSession, deleteSession, listSessions, solvePowHeader };
}

/** SSE 解析：标准 text/event-stream，`data: <json>\n\n`。返回 {content, error?}。 */
async function parseSSE(resp, log) {
  const reader = resp.body && typeof resp.body.getReader === 'function'
    ? resp.body.getReader()
    : null;
  if (!reader) {
    // Node fetch（undici）：resp.body 是 stream；或退回 resp.text() 整体解
    const text = await resp.text();
    return extractContentFromSSEText(text, log);
  }
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let content = '';
  let error = null;
  const feed = (block) => {
    const r = extractContentFromEvent(block, log);
    content += r.text ?? '';
    if (r.error && !error) error = r.error;
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // 按 \n\n 切事件
    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const eventBlock = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      feed(eventBlock);
    }
  }
  // 收尾：buffer 里可能还有最后一个事件（没有 \n\n 结尾）
  if (buffer.trim() !== '') feed(buffer);
  return error ? { content, error } : { content };
}

/** 从一整段 SSE 文本里抽正文（非流式 fallback）。返回 {content, error?}。 */
function extractContentFromSSEText(text, log) {
  let content = '';
  let error = null;
  const blocks = text.split('\n\n');
  for (const block of blocks) {
    const r = extractContentFromEvent(block, log);
    content += r.text ?? '';
    if (r.error && !error) error = r.error;
  }
  return error ? { content, error } : { content };
}

/**
 * 从一个 SSE 事件块里抽 assistant 正文。
 *
 * **实测格式**（2026-10，commit 4955e097，抓的是真流）：
 *   event: ready          data: {...}          ← 控制事件，无正文
 *   event: update_session data: {...}          ← 控制事件
 *   （无 event 行）        data: {"v":{"response":{"fragments":[{"content":"提示"}]}}}   ← 消息快照
 *   （无 event 行）        data: {"p":"response/fragments/-1/content","o":"APPEND","v":"词"}
 *   （无 event 行）        data: {"v":"工程"}                                            ← 裸字符串 = 流式文本块
 *   （无 event 行）        data: {"p":"response","o":"BATCH","v":[…token/status…]}
 *   event: title          data: {"content":"标题"}  ← ★ 不是正文，必须跳过
 *   event: close          data: {...}
 *
 * 所以判据是 **event 名**：没有 event 行（隐式 delta）或 `delta` 才出正文，
 * 其余（ready/update_session/title/close/…）一律跳过。
 */
function extractContentFromEvent(block, log) {
  const lines = block.split('\n');
  let eventName = '';
  const dataParts = [];
  for (const line of lines) {
    if (line.startsWith('event:')) {
      eventName = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      dataParts.push(line.slice(5).trim());
    }
  }
  if (dataParts.length === 0) return { text: '' };
  let payload;
  try {
    payload = JSON.parse(dataParts.join('\n'));
  } catch {
    return { text: '' }; // 非 JSON 的 data 行（心跳等），跳过
  }
  // ★ 错误提示：event:hint {type:"error", content:"…", finish_reason:"…"}
  // 实测遇到过 finish_reason:"parallel_chat_limit"（同账号并发对话上限 2）。
  if (eventName === 'hint') {
    if (payload && payload.type === 'error') {
      return { text: '', error: payload };
    }
    return { text: '' };
  }
  // 控制事件不出正文（尤其 event:title 的 content 是标题，混进去会污染答案）
  if (eventName !== '' && eventName !== 'delta') return { text: '' };
  return { text: extractFromDeltaBody(payload) };
}

/**
 * 从 delta 载荷里抽正文。载荷可能是：
 *   - 事件封装 {event, data} → 取 data
 *   - 隐式 {data: …}（没有 event）→ 取 data
 *   - 裸操作 {p, o, v} / {v: …} / {v: {response: {fragments}}}
 */
function extractFromDeltaBody(body) {
  if (body === null || body === undefined) return '';
  if (typeof body === 'string') return body;
  if (Array.isArray(body)) return body.map(extractFromDeltaBody).join('');
  if (typeof body !== 'object') return '';

  // ⓪ 包装解包：{event:"delta", data:{…}} 或 {data:{…}}（没有 p/o/v/content 的才是包装）
  if (body.data !== undefined && body.p === undefined && body.o === undefined
      && body.v === undefined && body.content === undefined) {
    return extractFromDeltaBody(body.data);
  }

  // ① 消息快照：{v:{response:{fragments:[{content:"…"}]}}}
  const v = body.v;
  if (v && typeof v === 'object' && !Array.isArray(v) && v.response
      && Array.isArray(v.response.fragments)) {
    return v.response.fragments
      .map((f) => (f && typeof f.content === 'string' ? f.content : ''))
      .join('');
  }
  // ② 显式操作 {p, o, v}
  if (typeof body.o === 'string' && typeof body.p === 'string') {
    if (body.o === 'BATCH' && Array.isArray(body.v)) {
      return body.v.map(extractFromDeltaBody).join(''); // 子操作各自按 path 过滤
    }
    if ((body.o === 'APPEND' || body.o === 'SET') && isContentPath(body.p) && typeof body.v === 'string') {
      return body.v;
    }
    return ''; // status/token_usage 之类
  }
  // ③ 裸 {v:"…"} —— 流式文本块（真流里绝大多数正文走这条）
  if (typeof v === 'string' && Object.keys(body).length === 1) return v;
  // ④ 兜底：直接给正文字段
  for (const key of ['content', 'text', 'delta', 'message']) {
    if (typeof body[key] === 'string' && body[key] !== '') return body[key];
  }
  return '';
}

/** path 看起来像「正文」吗（response/fragments/-1/content、response/content 等）。 */
function isContentPath(p) {
  return typeof p === 'string' && /content|text|answer/i.test(p);
}

async function safeText(resp) {
  try { return await resp.text(); } catch { return ''; }
}

export class WebChatError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'WebChatError';
    this.status = status ?? 0;
  }
}

/**
 * 简单并发限流器：返回一个把任务排进池里的函数。
 * 用来满足 DeepSeek「同账号最多 2 路并发对话」的账号级限制。
 */
function withConcurrency(limit) {
  let active = 0;
  const queue = [];
  const pump = () => {
    while (active < limit && queue.length > 0) {
      active += 1;
      const { fn, resolve, reject } = queue.shift();
      Promise.resolve()
        .then(fn)
        .then(resolve, reject)
        .finally(() => {
          active -= 1;
          pump();
        });
    }
  };
  return (fn) => new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    pump();
  });
}

/**
 * 用网页端对话跑三版优化（跟 optimize.js 的 optimize3 同形状输出，方便互换）。
 *
 * 每版把 systemPromptFor(variantKey) + 原文拼成一条用户消息发给网页端，
 * 网页端的回复就是优化后的提示词。
 *
 * **并发限流**：实测 DeepSeek 账号级限制同一时刻最多 2 路对话
 * （`finish_reason:"parallel_chat_limit"`）。三版全并发必挂一路，
 * 所以限 2 并发 + 撞限重试（指数退避）。
 *
 * @param {{token: string, wasmPath?: string, fetchImpl?: Function, log?: Function,
 *           timeoutMs?: number, concurrency?: number, autoDelete?: boolean}} opts
 * @param {string} text - 已 trim 的原文。
 * @returns {Promise<{ok: boolean, variants?: Array, message?: string}>}
 */
export async function optimize3ViaWebChat(opts, text) {
  const log = opts.log ?? (() => {});
  const caller = await createWebChatCaller(opts);
  const run = withConcurrency(Math.max(1, opts.concurrency ?? 2));
  // 默认用完即删；settings 里设 `keepWebSessions: true` 可保留（排查/续聊用）。
  const autoDelete = opts.autoDelete !== false;
  // 删除回执：服务端确认删掉的、以及尝试删但失败的，都记下来回传给调用方。
  const deletedSessions = [];
  const deleteFailures = [];

  /** 发一版；撞限流就退避重试（每次重新取 challenge + 解 PoW）。 */
  async function chatWithRetry(userMessage) {
    let lastErr = null;
    // 两类限流，退避策略不同：
    //   parallel_chat_limit —— 同账号并发对话上限（实测 2），退避短；
    //   Messages too frequent —— 全局频率限制，退避长。
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      try {
        return await caller.chat(userMessage, {
          autoDelete,
          onSessionDeleted: (id, ok) => {
            (ok ? deletedSessions : deleteFailures).push(id);
          },
        });
      } catch (err) {
        lastErr = err;
        const reason = String(err?.finishReason ?? '');
        const msg = String(err?.message ?? '');
        const isParallel = reason === 'parallel_chat_limit' || /parallel/i.test(msg);
        const isFrequency = /too frequent|frequency|rate limit|quota/i.test(msg);
        if ((!isParallel && !isFrequency) || attempt === 4) throw err;
        const base = isFrequency ? 2000 : 500;
        const delay = base * attempt + Math.random() * 500;
        log(`peak-whale: 网页端限流（${isFrequency ? '频率' : '并发'}），${Math.round(delay)}ms 后重试（第 ${attempt} 次）`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    throw lastErr;
  }

  const results = await Promise.all(
    VARIANT_KEYS.map((key) => run(async () => {
      const started = Date.now();
      try {
        // ── 迭代打磨（与网关/llm 通道同一套逻辑）─────────────────────────
        // 第 1 轮优化原文；第 2 轮起把上一轮的优化稿捕获回来当新输入继续打磨。
        let current = text;
        let optimized = '';
        let raw = '';
        let rounds = 0;
        for (let round = 1; round <= (opts.iterateRounds ?? 2); round += 1) {
          rounds = round;
          const isFirst = round === 1;
          const roundPrompt = isFirst
            ? systemPromptForStyle(key, opts.promptStyle)
            : systemPromptForStyle(key, opts.promptStyle) + '\n\n' + ITERATION_SUFFIX;
          const userMessage = `${roundPrompt}\n\n${isFirst ? '【原始提示词】' : ITERATION_USER_PREFIX}\n${current}`;
          raw = await chatWithRetry(userMessage);
          optimized = cleanOptimized(raw);
          if (optimized === null) {
            throw new Error('模型没返回可用内容');
          }
          if (optimized === current || round >= (opts.iterateRounds ?? 2)) break;
          current = optimized;
        }
        return { key, ok: true, optimized, raw, ms: Date.now() - started, rounds };
      } catch (err) {
        log(`peak-whale: 网页端优化 ${key} 版失败：${err?.message ?? err}`);
        return { key, ok: false, message: err.message };
      }
    })),
  );
  const variants = [];
  let firstError = null;
  for (const r of results) {
    if (r.ok && typeof r.optimized === 'string' && r.optimized !== '') {
      variants.push({
        key: r.key,
        label: VARIANT_LABELS[r.key],
        optimized: r.optimized,
        unchanged: r.optimized === text,
        usage: null, // 网页端不返回 token 用量
        cached: false,
        ms: typeof r.ms === 'number' ? r.ms : null,
      });
    } else if (!firstError) {
      firstError = r.message || '网页端优化失败';
    }
  }
  if (variants.length === 0) {
    return { ok: false, message: firstError || '三版网页端优化全失败了', deletedSessions, deleteFailures };
  }
  return { ok: true, variants, deletedSessions, deleteFailures };
}
