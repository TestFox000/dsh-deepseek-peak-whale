/**
 * 提示词优化器 —— **Host 专用**（不进浏览器 bundle）。
 *
 * 流程：你把鲸鱼娘拖到文本框上 → 浏览器把框里的文字 POST 给 Host →
 * Host 用**你自己的 DeepSeek API key** 调一次 `deepseek-v4-pro`（`reasoning_effort: max`）→
 * 返回改写后的提示词 → 浏览器写回文本框，原稿留着给你撤销。
 *
 * ── key 放哪 ────────────────────────────────────────────────────────────────
 * `$DSH_HOME/peak-whale/settings.json`（缺失时由 `ensureSettingsFile` 自动创建模板）：
 *
 * ```json
 * { "deepseekApiKey": "sk-…", "model": "deepseek-v4-pro",
 *   "reasoningEffort": "max", "baseUrl": "https://api.deepseek.com" }
 * ```
 *
 * 也可以用环境变量 `DEEPSEEK_API_KEY` 兜底（文件优先）。
 * key **不会**进插件代码、不会进对话、不会进日志。
 *
 * ── 为什么是「估算之外」的另一次调用 ────────────────────────────────────────
 * 这次请求走的是你的 DeepSeek **API 账户**（按 token 计费），与「今日费用」账本无关：
 * 账本只折算**会话日志**里的 provider 报告用量，Host 自己发的请求不在其中。
 *
 * @module src/optimize.js
 */

import fs from 'node:fs';
import path from 'node:path';

/** 没写配置时的默认值；每一项都能在 settings.json 里覆盖。 */
export const DEFAULTS = {
  model: 'deepseek-v4-pro',
  reasoningEffort: 'max',
  baseUrl: 'https://api.deepseek.com',
  timeoutMs: 120000,
  /** 输入太长只会烧钱且容易超时，先挡一道。 */
  maxInputChars: 12000,
  /** 同一段原文 5 分钟内不重复扣费（拖错了再拖一次不该再收一次钱）。 */
  cacheTtlMs: 300000,
};

/** settings.json 的路径（`dir` 一般是 `$DSH_HOME/peak-whale`）。 */
export function settingsPath(dir) {
  return path.join(dir, 'settings.json');
}

/**
 * 系统提示词：只改写、不越界。
 *
 * 关键约束写死在里面——**不改变原意、不增删任务**，而且只输出正文：
 * 模型要是把说明也吐回来，写回文本框就成了事故。
 */
export const SYSTEM_PROMPT = [
  '你是提示词优化器。用户会给一段自己写给 AI 助手的提示词/指令，请改写它。',
  '要求：',
  '1. 不改变原意、不增删任务目标、不替用户做决定；',
  '2. 补齐缺失的上下文、约束与边界条件，消除歧义；',
  '3. 明确输出格式、长度与验收标准，必要时分层（背景 / 任务 / 要求 / 输出）；',
  '4. 保留用户原来的语言（中文就中文），保留其中的专有名词与代码片段；',
  '5. 只输出改写后的提示词正文：不要解释、不要客套、不要 markdown 代码块包裹、',
  '   不要加“优化后的提示词”这类标题。',
].join('\n');

/** 模板内容：自动创建时写进 settings.json 的东西。 */
export function settingsTemplate() {
  return {
    _说明: '把 deepseekApiKey 填成你的 DeepSeek API key 即可；留空时优化功能会提示你先配置。key 只在本机读取，不会写进代码或日志。',
    _说明2: 'uiMode 控制详情浮层的排版（concise 简洁版，默认 / detailed 详细版）；optimizeEnabled 关掉后，把鲸鱼娘拖到文本框上不会再发起优化请求。',
    deepseekApiKey: '',
    model: DEFAULTS.model,
    reasoningEffort: DEFAULTS.reasoningEffort,
    baseUrl: DEFAULTS.baseUrl,
    timeoutMs: DEFAULTS.timeoutMs,
    uiMode: 'concise',
    optimizeEnabled: true,
  };
}

/** 读 settings.json；不存在/损坏/字段缺失都回落到默认值。 */
export function readSettings(file, env = process.env) {
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    raw = null;
  }
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const str = (value, fallback) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback);
  const envKey = env && typeof env.DEEPSEEK_API_KEY === 'string' ? env.DEEPSEEK_API_KEY.trim() : '';
  return {
    apiKey: str(source.deepseekApiKey, envKey),
    model: str(source.model, DEFAULTS.model),
    reasoningEffort: str(source.reasoningEffort, DEFAULTS.reasoningEffort),
    baseUrl: str(source.baseUrl, DEFAULTS.baseUrl).replace(/\/+$/, ''),
    timeoutMs: Number.isFinite(Number(source.timeoutMs)) && Number(source.timeoutMs) > 0
      ? Number(source.timeoutMs)
      : DEFAULTS.timeoutMs,
    maxInputChars: Number.isFinite(Number(source.maxInputChars)) && Number(source.maxInputChars) > 0
      ? Number(source.maxInputChars)
      : DEFAULTS.maxInputChars,
    cacheTtlMs: Number.isFinite(Number(source.cacheTtlMs)) && Number(source.cacheTtlMs) > 0
      ? Number(source.cacheTtlMs)
      : DEFAULTS.cacheTtlMs,
    uiMode: source.uiMode === 'detailed' ? 'detailed' : 'concise',
    optimizeEnabled: source.optimizeEnabled === false ? false : true,
    file,
  };
}

/**
 * 详情页模式与优化开关：设置页 / 详情浮层要的那一小块 UI 设置。
 *
 * **绝不带出 apiKey**——这个函数专门给「要回传给浏览器的载荷」用。
 */
export function readUiSettings(file, env = process.env) {
  const settings = readSettings(file, env);
  return {
    uiMode: settings.uiMode,
    optimizeEnabled: settings.optimizeEnabled,
    apiKeyConfigured: settings.apiKey !== '',
  };
}

/**
 * 写 UI 设置（白名单：`uiMode` 枚举、`optimizeEnabled` 布尔）。
 *
 * 其余字段（尤其是 `deepseekApiKey`）一律原样保留；未知字段直接忽略。
 * 写盘用「临时文件 + 原子改名」，正在读的进程永远读不到半个文件。
 *
 * @returns {{ok: boolean, settings?: object, message?: string}}
 */
export function writeUiSettings(file, patch) {
  const incoming = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};
  const next = {};
  let changed = false;
  if (incoming.uiMode !== undefined) {
    if (incoming.uiMode !== 'concise' && incoming.uiMode !== 'detailed') {
      return { ok: false, message: 'uiMode 只能是 concise 或 detailed' };
    }
    next.uiMode = incoming.uiMode;
    changed = true;
  }
  if (incoming.optimizeEnabled !== undefined) {
    if (typeof incoming.optimizeEnabled !== 'boolean') {
      return { ok: false, message: 'optimizeEnabled 必须是 true 或 false' };
    }
    next.optimizeEnabled = incoming.optimizeEnabled;
    changed = true;
  }
  if (!changed) return { ok: false, message: '没有可写的设置项' };

  let current = {};
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) current = raw;
  } catch {
    // 不存在 / 损坏：按模板建，保证 deepseekApiKey 等字段都在
    current = settingsTemplate();
  }
  const merged = { ...current, ...next };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, `${JSON.stringify(merged, null, 2)}\n`);
    fs.renameSync(tmp, file);
  } catch (error) {
    return { ok: false, message: `设置写不进去：${error?.message ?? error}` };
  }
  return { ok: true, settings: readUiSettings(file) };
}

/**
 * settings.json 不存在就写一份模板。
 * @returns {boolean} 是否真的创建了（调用方据此打一条日志）。
 */
export function ensureSettingsFile(file) {
  try {
    if (fs.existsSync(file)) return false;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(settingsTemplate(), null, 2)}\n`);
    return true;
  } catch {
    return false; // 写不进去（权限/磁盘满）不影响插件，运行时会走「未配置」的提示
  }
}

/** 给一段文本做小而稳的散列（cache key 用，不是安全用途）。 */
export function hashText(text) {
  let h = 5381;
  const s = String(text);
  for (let i = 0; i < s.length; i += 1) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return `${h.toString(36)}:${s.length}`;
}

/**
 * 组装一次上游请求体。
 *
 * `reasoningEffort` 非空才带上（有人的账户不认这个字段，删掉配置就退回默认思考）。
 *
 * @param {ReturnType<typeof readSettings>} settings
 * @param {string} text - 用户的原始提示词。
 */
export function buildRequestBody(settings, text) {
  const body = {
    model: settings.model || DEFAULTS.model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `【原始提示词】\n${text}` },
    ],
    stream: false,
    temperature: 0.3,
  };
  const effort = typeof settings.reasoningEffort === 'string' ? settings.reasoningEffort.trim() : '';
  if (effort !== '') body.reasoning_effort = effort;
  return body;
}

/**
 * 把模型的输出收敛成「能直接粘进文本框的正文」。
 *
 * 模型爱干两件事：整段包进 ``` 代码块、前面加一句「好的，以下是…」。
 * 这两种都会让写回去的结果很难看，所以在这里剥干净；剥完是空的就当失败。
 *
 * @param {unknown} raw - `choices[0].message.content`。
 * @returns {string|null}
 */
export function cleanOptimized(raw) {
  if (typeof raw !== 'string') return null;
  let text = raw.replace(/\r\n/g, '\n').trim();
  if (text === '') return null;

  // 整段被包进代码块 → 剥开。**只在「包住整段」时才剥**：提示词自己带代码片段
  // 是常事，一刀切取「最长的那块」会把正文丢掉、只留下那段代码。
  const wrapped = /^```[^\n]*\n([\s\S]*?)\n?```$/.exec(text);
  if (wrapped) text = wrapped[1].trim();
  if (text === '') return null;

  const lines = text.split('\n');
  // 开头的引导语：短、且是套话才删（用户自己的首行短句不动）
  const head = lines[0].trim();
  if (lines.length > 1 && head.length <= 60
    && /^(好的|好的[，,]|以下是|下面是|优化后|这是改写|当然可以|没问题|Sure|Here (is|are)|Below (is|are))/i.test(head)) {
    lines.shift();
  }
  // 结尾的客套
  while (lines.length > 0 && /^(希望(这|对)|如有需要|祝你|Let me know|Feel free)/.test(lines[lines.length - 1].trim())) {
    lines.pop();
  }
  const out = lines.join('\n').trim();
  return out === '' ? null : out;
}

/** 把上游 HTTP 错误翻成一句能直接显示给人看的中文。 */
export function describeHttpError(status, payload) {
  const detail = payload && payload.error && typeof payload.error.message === 'string'
    ? payload.error.message
    : '';
  const short = detail.length > 160 ? `${detail.slice(0, 160)}…` : detail;
  if (status === 401) return `API key 无效或已过期（HTTP 401）${short ? `：${short}` : ''}`;
  if (status === 402) return `DeepSeek 账户余额不足（HTTP 402）${short ? `：${short}` : ''}`;
  if (status === 403) return `没有权限调用该模型（HTTP 403）${short ? `：${short}` : ''}`;
  if (status === 404) return `模型 id 找不到（HTTP 404），检查 settings.json 的 model${short ? `：${short}` : ''}`;
  if (status === 429) return `请求太频繁了，稍等几秒再拖一次（HTTP 429）`;
  if (status === 400) {
    // 最常见的 400 就是「这个账户不认 reasoning_effort」——顺手告诉用户改哪里
    const hint = /reasoning|thinking/i.test(short)
      ? '；把 settings.json 的 reasoningEffort 留空即可关掉思考字段'
      : '';
    return `请求被拒（HTTP 400）${short ? `：${short}` : ''}${hint}`;
  }
  return `上游返回 HTTP ${status}${short ? `：${short}` : ''}`;
}

/**
 * 创建一个「优化一段文本」的函数：读配置 → 查缓存 → 打上游 → 收敛输出。
 *
 * @param {{file: string, env?: object, fetchImpl?: Function, now?: () => number,
 *          log?: (message: string) => void}} options
 * @returns {(text: string) => Promise<{ok: boolean, optimized?: string, message?: string,
 *          error?: string, cached?: boolean, ms?: number}>}
 */
export function createOptimizeRunner(options = {}) {
  const file = options.file;
  const env = options.env ?? process.env;
  const now = options.now ?? (() => Date.now());
  const log = options.log ?? (() => {});
  const fetchImpl = options.fetchImpl !== undefined
    ? options.fetchImpl
    : (typeof fetch === 'function' ? (...args) => fetch(...args) : null);

  /** hash → { at, optimized, model } */
  const cache = new Map();
  /** hash → in-flight promise（同一段文字并发拖两次只打一次上游） */
  const inflight = new Map();

  function cacheGet(hash, settings) {
    const hit = cache.get(hash);
    if (!hit) return null;
    if (now() - hit.at > settings.cacheTtlMs) {
      cache.delete(hash);
      return null;
    }
    return hit;
  }

  async function callUpstream(settings, text) {
    if (fetchImpl === null) {
      return { ok: false, error: 'no-fetch', message: '这个运行环境没有 fetch，没法调 DeepSeek API' };
    }
    const controller = new AbortController();
    // 双保险的超时：① `abort()` 让 fetch 真的断掉；② `guard` 保证**即使上游不理会
    // signal**（自定义实现、卡住的流）也一定在超时点返回。
    // 计时器故意不 unref —— 这是用户正等着的、有上限（默认 120s）的操作，
    // 进程该为它多活一会儿；unref 了反而可能在空转的事件循环里被回收，请求悬死。
    let timedOut = false;
    let rejectGuard = () => {};
    const guard = new Promise((resolve, reject) => {
      rejectGuard = reject;
    });
    guard.catch(() => {}); // 没被 race 到的那次拒绝，别变成 unhandled rejection
    const timer = setTimeout(() => {
      timedOut = true;
      const abort = new Error('timeout');
      abort.name = 'AbortError';
      try {
        controller.abort();
      } catch { /* 已经断了 */ }
      rejectGuard(abort);
    }, settings.timeoutMs);
    const timeoutResult = () => ({
      ok: false,
      error: 'timeout',
      message: `等了 ${Math.round(settings.timeoutMs / 1000)} 秒还没想完（max 思考就是慢），稍后再试`,
    });
    const started = now();
    try {
      const response = await Promise.race([
        fetchImpl(`${settings.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${settings.apiKey}`,
          },
          body: JSON.stringify(buildRequestBody(settings, text)),
          signal: controller.signal,
        }),
        guard,
      ]);
      let payload = null;
      try {
        payload = await Promise.race([response.json(), guard]);
      } catch {
        payload = null;
      }
      if (timedOut) return timeoutResult();
      if (!response.ok) {
        const message = describeHttpError(response.status, payload);
        log(`peak-whale: 提示词优化失败（HTTP ${response.status}）`);
        return { ok: false, error: `http-${response.status}`, message };
      }
      const message = payload && payload.choices && payload.choices[0]
        ? payload.choices[0].message && payload.choices[0].message.content
        : null;
      const optimized = cleanOptimized(message);
      if (optimized === null) {
        return { ok: false, error: 'empty-result', message: '模型没返回可用内容，再拖一次试试' };
      }
      return {
        ok: true,
        optimized,
        model: settings.model,
        effort: settings.reasoningEffort,
        ms: now() - started,
      };
    } catch (error) {
      if (timedOut || (error && (error.name === 'AbortError' || error.code === 'ABORT_ERR'))) {
        return timeoutResult();
      }
      const detail = error && error.message ? error.message : String(error);
      log(`peak-whale: 提示词优化网络错误：${detail}`);
      return { ok: false, error: 'network', message: `连不上 DeepSeek：${detail}` };
    } finally {
      clearTimeout(timer);
    }
  }

  return async function optimize(rawText) {
    const settings = readSettings(file, env);
    if (settings.optimizeEnabled === false) {
      return {
        ok: false,
        error: 'disabled',
        message: '提示词优化已在设置里关掉了；想用的话去「设置 → 插件 → 小鲸鱼」把开关打开',
      };
    }
    const text = typeof rawText === 'string' ? rawText.trim() : '';
    if (text === '') {
      return { ok: false, error: 'empty', message: '文本框里还没有提示词，先写一点再拖我过来～' };
    }
    // 传输层用错编码时，Node 按 UTF-8 解会留下 U+FFFD。真让它打上游的话：
    // 模型看见一堆乱码照样回一句话——钱花了还拿到垃圾。先挡下来。
    if (text.indexOf('�') !== -1) {
      return {
        ok: false,
        error: 'encoding',
        message: '文本里有乱码字符（U+FFFD），说明传输编码不对——先确认文本框里显示正常，再拖一次',
      };
    }
    if (text.length > settings.maxInputChars) {
      return {
        ok: false,
        error: 'too-long',
        message: `提示词太长了（${text.length} 字，上限 ${settings.maxInputChars}），先精简一点再优化`,
      };
    }
    if (settings.apiKey === '') {
      return {
        ok: false,
        error: 'no-api-key',
        message: `还没配置 API key：把 key 填进 ${settings.file} 的 deepseekApiKey`,
      };
    }

    const hash = hashText(text);
    const cached = cacheGet(hash, settings);
    if (cached) {
      return { ok: true, optimized: cached.optimized, cached: true, model: cached.model };
    }
    const running = inflight.get(hash);
    if (running) return running;

    const promise = (async () => {
      try {
        const result = await callUpstream(settings, text);
        if (result.ok) {
          cache.set(hash, { at: now(), optimized: result.optimized, model: result.model });
          while (cache.size > 8) cache.delete(cache.keys().next().value);
        }
        return result;
      } finally {
        inflight.delete(hash);
      }
    })();
    inflight.set(hash, promise);
    return promise;
  };
}

