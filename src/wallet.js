/**
 * 当日用量账本 —— **Host 专用**（不会被内联进浏览器 bundle）。
 *
 * 目标只有一个：回答「今天（北京时间）我已经花了多少钱」。
 *
 * ── 数据从哪来 ────────────────────────────────────────────────────────────────
 * 一切来自会话的持久化事件流 `session/event`（Host 侧 emit，插件 `ctx.on` 就能收）。
 * 计费用量由 DSH 自己的 provider 报告，落在两类结算事件里：
 *
 *   · `assistant/message` —— 本步的最终消息，`data.usage` 带样本；
 *                             没有就从 `data.stream` 里倒着找最后一个 usage 分片。
 *   · `assistant/attempt` —— 一次被替换的尝试（重试前的结算），样本在 `data.stream` 里。
 *
 * 再加两个控制事件，语义**逐字对齐 DSH 内置的 `tokenUsage` 投影**
 * （见 @deepseek-ai/dsh-token-meter 的 usage-projection）：
 *
 *   · `request/header`     —— 记住本会话当前的 (provider, model)，
 *                             `assistant/attempt` 没有消息体，只能靠它推断路由；
 *   · `llm/retry-started`  —— 与投影一致：清掉 (turn, step) 的上一个样本，
 *                             于是重试的那次用量**叠加**而不是替换。
 *
 * 同一 (turn, step) 的重复样本不改账（与投影同语义），替换时按 **delta** 调整
 * token 与美元 —— 所以账本与界面上那颗「用量甜甜圈」的总数口径一致。
 *
 * ── 边界（请知悉）─────────────────────────────────────────────────────────────
 *   · 只统计**本插件加载之后**发生的事件：装上插件那天的前半段不补账。
 *     DSH 运行期间才会产生用量，所以此后每个自然日都是完整的。
 *   · 只统计 DeepSeek 路由（`resolveModel` 返回 null 的直接不入账）——
 *     别的厂商不走 DeepSeek 钱包。
 *   · 这是**按官方牌价的估算**，不是账单：赠送余额抵扣、议价折扣、
 *     计费口径的细微差异都看不到。界面文案照实说。
 *
 * @module src/wallet.js
 */

import fs from 'node:fs';
import path from 'node:path';

import { beijingDateKey, costUsd, periodAt, resolveModel } from './peak.js';

/** 存储结构的版本；变了就整份重建（宁可丢一天的估算，也不读一份错账）。 */
export const LEDGER_VERSION = 1;
/** 保留多少天的日账（界面只看当天，留 30 天够排错）。 */
export const KEEP_DAYS = 30;
/** 记住多少个会话的「上一个样本」（用于替换/叠加判定）。 */
export const KEEP_LAST = 50;

/** 四个计费桶的零值。 */
export function emptyTokens() {
  return {
    uncachedInputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
}

/** 空账本。 */
export function emptyState() {
  return { version: LEDGER_VERSION, days: {}, last: {} };
}

/** 读成非负安全整数；不是数就返回 null（表示「压根没有这个字段」）。 */
function toCount(value) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.floor(n);
}

/** 把一个 usage 样本折成四个桶；缺关键字段返回 null。 */
function bucketsOf(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const input = toCount(usage.inputTokens);
  const output = toCount(usage.outputTokens);
  if (input === null || output === null) return null;
  return {
    uncachedInputTokens: input,
    outputTokens: output,
    cacheReadTokens: toCount(usage.cacheReadTokens) ?? 0,
    cacheWriteTokens: toCount(usage.cacheWriteTokens) ?? 0,
  };
}

/**
 * 从流里倒着找最后一个可用的 usage 样本。
 *
 * 上游把它封装成 `lastAssistantStreamChunk(stream, 'usage')?.usage`，
 * 这里不引上游模块（Host 半身要自包含），因此按同一约定手写：
 * 优先 `type === 'usage'` 的分片，其次任何带 `.usage` 的分片，
 * 最后兜底「分片本身就是 usage 形状」。
 *
 * @param {unknown} stream - 事件里的分片数组。
 * @returns {object|null} 四个桶，或 null。
 */
export function usageFromStream(stream) {
  if (!Array.isArray(stream)) return null;
  let fallback = null;
  for (let i = stream.length - 1; i >= 0; i -= 1) {
    const chunk = stream[i];
    if (!chunk || typeof chunk !== 'object') continue;
    const typed = chunk.type === 'usage' ? bucketsOf(chunk.usage) : null;
    if (typed !== null) return typed;
    if (fallback === null) {
      const direct = bucketsOf(chunk.usage) ?? bucketsOf(chunk.data) ?? bucketsOf(chunk);
      if (direct !== null) fallback = direct;
    }
  }
  return fallback;
}

/** 从一条结算事件里取出用量样本。 */
function usageOfSettlement(data, type) {
  if (type === 'assistant/message') {
    const direct = bucketsOf(data.usage);
    if (direct !== null) return direct;
  }
  return usageFromStream(data.stream);
}

function bucketsEqual(a, b) {
  return a.uncachedInputTokens === b.uncachedInputTokens
    && a.outputTokens === b.outputTokens
    && a.cacheReadTokens === b.cacheReadTokens
    && a.cacheWriteTokens === b.cacheWriteTokens;
}

/** next − previous（缺 previous 当 0）。 */
function subtractBuckets(next, previous) {
  const base = previous ?? emptyTokens();
  return {
    uncachedInputTokens: next.uncachedInputTokens - base.uncachedInputTokens,
    outputTokens: next.outputTokens - base.outputTokens,
    cacheReadTokens: next.cacheReadTokens - base.cacheReadTokens,
    cacheWriteTokens: next.cacheWriteTokens - base.cacheWriteTokens,
  };
}

/**
 * 把一条会话事件折进账本。
 *
 * @param {object} state - 账本状态（就地修改：`days` 与 `last`）。
 * @param {Map<string, {provider: string, model: string}>} routes - 会话 → 当前路由。
 * @param {string} sessionId - 会话 id。
 * @param {{type?: string, time?: number, data?: object}} event - 会话事件。
 * @returns {boolean} 账本是否被改动。
 */
export function applyEvent(state, routes, sessionId, event) {
  if (!state || typeof state !== 'object') return false;
  if (!state.days || !state.last) return false;
  if (typeof sessionId !== 'string' || sessionId === '') return false;
  if (!event || typeof event.type !== 'string') return false;
  const data = event.data && typeof event.data === 'object' ? event.data : {};
  const time = Number.isFinite(event.time) ? event.time : Date.now();

  // ── 路由记忆：本会话当前生效的 provider/model ──────────────────────────────
  if (event.type === 'request/header') {
    const config = data.header && typeof data.header === 'object' ? data.header.config : null;
    if (config && typeof config === 'object') {
      const provider = typeof config.provider === 'string' ? config.provider : '';
      const model = typeof config.model === 'string' ? config.model : '';
      if (provider !== '' || model !== '') routes.set(sessionId, { provider, model });
    }
    return false;
  }

  // ── 重试开始：与投影一致，清掉上一个样本，让重试的用量叠加 ────────────────
  if (event.type === 'llm/retry-started') {
    const last = state.last[sessionId];
    if (last && last.turn === data.turn && last.step === data.step) {
      delete state.last[sessionId];
      return true;
    }
    return false;
  }

  if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return false;

  // ── 路由：message 自带 source；attempt 只能用最近一次 request/header 推断 ──
  let route;
  const message = data.message;
  if (event.type === 'assistant/message' && message && typeof message === 'object' && message.source) {
    route = {
      provider: typeof message.source.provider === 'string' ? message.source.provider : '',
      model: typeof message.source.model === 'string' ? message.source.model : '',
    };
    if (route.provider !== '' || route.model !== '') routes.set(sessionId, route);
  } else {
    route = routes.get(sessionId);
  }
  if (!route) return false;

  // 非 DeepSeek 路由不进 DeepSeek 的账。
  if (resolveModel(route.provider, route.model) === null) return false;

  const buckets = usageOfSettlement(data, event.type);
  if (buckets === null) return false;

  const turn = Number.isFinite(data.turn) ? data.turn : -1;
  const step = Number.isFinite(data.step) ? data.step : -1;
  const previous = state.last[sessionId];
  const same = previous && previous.turn === turn && previous.step === step ? previous.buckets : null;
  // 同 (turn, step) 的重复样本：与投影一样不改账。
  if (same !== null && bucketsEqual(same, buckets)) return false;

  const delta = subtractBuckets(buckets, same);
  state.last[sessionId] = { turn, step, buckets };

  const key = beijingDateKey(new Date(time));
  let day = state.days[key];
  if (!day || typeof day !== 'object') {
    day = { usd: 0, requests: 0, tokens: emptyTokens() };
    state.days[key] = day;
  }
  if (!day.tokens || typeof day.tokens !== 'object') day.tokens = emptyTokens();
  if (!Number.isFinite(day.usd)) day.usd = 0;
  if (!Number.isFinite(day.requests)) day.requests = 0;

  const usd = costUsd(delta, route, time);
  if (usd !== null && Number.isFinite(usd)) day.usd = Math.max(0, day.usd + usd);
  day.requests += 1;
  for (const bucket of Object.keys(emptyTokens())) {
    const value = Number.isFinite(day.tokens[bucket]) ? day.tokens[bucket] : 0;
    day.tokens[bucket] = Math.max(0, value + (Number.isFinite(delta[bucket]) ? delta[bucket] : 0));
  }
  return true;
}

/** 六位小数：JSON 里不出现 0.30000000000000004 这种浮点噪声。 */
function round6(value) {
  return Math.round(value * 1e6) / 1e6;
}

/**
 * 某一时刻所在的（北京时间）那一日的快照。
 *
 * @param {object} state - 账本状态。
 * @param {number} [at] - 时刻，默认现在。
 * @returns {{date: string, usd: number, requests: number, tokens: object, isPeak: boolean}}
 */
export function daySnapshot(state, at = Date.now()) {
  const date = new Date(at);
  const key = beijingDateKey(date);
  const day = state && state.days && typeof state.days === 'object' ? state.days[key] : null;
  const tokens = day && day.tokens && typeof day.tokens === 'object' ? day.tokens : emptyTokens();
  return {
    date: key,
    usd: day && Number.isFinite(day.usd) ? round6(day.usd) : 0,
    requests: day && Number.isFinite(day.requests) ? day.requests : 0,
    tokens: {
      uncachedInputTokens: Number.isFinite(tokens.uncachedInputTokens) ? tokens.uncachedInputTokens : 0,
      outputTokens: Number.isFinite(tokens.outputTokens) ? tokens.outputTokens : 0,
      cacheReadTokens: Number.isFinite(tokens.cacheReadTokens) ? tokens.cacheReadTokens : 0,
      cacheWriteTokens: Number.isFinite(tokens.cacheWriteTokens) ? tokens.cacheWriteTokens : 0,
    },
    isPeak: periodAt(date).isPeak,
  };
}

/** 丢掉 KEEP_DAYS 之外的旧日账；返回是否有改动。 */
export function pruneDays(state, keepDays = KEEP_DAYS) {
  if (!state || !state.days) return false;
  const keys = Object.keys(state.days).sort();
  if (keys.length <= keepDays) return false;
  const drop = keys.slice(0, keys.length - keepDays);
  for (const key of drop) delete state.days[key];
  return true;
}

/** 只保留最近 KEEP_LAST 个会话的「上一个样本」。 */
export function pruneLast(state, keepLast = KEEP_LAST) {
  if (!state || !state.last) return false;
  const keys = Object.keys(state.last);
  if (keys.length <= keepLast) return false;
  for (const key of keys.slice(0, keys.length - keepLast)) delete state.last[key];
  return true;
}

/** 把磁盘上的任意 JSON 收敛成合法账本（读不出来就当没有）。 */
export function normalizeState(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyState();
  if (raw.version !== LEDGER_VERSION) return emptyState();
  const state = emptyState();
  if (raw.days && typeof raw.days === 'object') {
    for (const [key, day] of Object.entries(raw.days)) {
      if (!day || typeof day !== 'object') continue;
      const tokens = day.tokens && typeof day.tokens === 'object' ? day.tokens : {};
      state.days[key] = {
        usd: Number.isFinite(day.usd) ? day.usd : 0,
        requests: Number.isFinite(day.requests) ? day.requests : 0,
        tokens: {
          uncachedInputTokens: Number.isFinite(tokens.uncachedInputTokens) ? tokens.uncachedInputTokens : 0,
          outputTokens: Number.isFinite(tokens.outputTokens) ? tokens.outputTokens : 0,
          cacheReadTokens: Number.isFinite(tokens.cacheReadTokens) ? tokens.cacheReadTokens : 0,
          cacheWriteTokens: Number.isFinite(tokens.cacheWriteTokens) ? tokens.cacheWriteTokens : 0,
        },
      };
    }
  }
  if (raw.last && typeof raw.last === 'object') {
    for (const [key, entry] of Object.entries(raw.last)) {
      if (!entry || typeof entry !== 'object') continue;
      if (!Number.isFinite(entry.turn) || !Number.isFinite(entry.step)) continue;
      const buckets = entry.buckets && typeof entry.buckets === 'object' ? entry.buckets : {};
      state.last[key] = {
        turn: entry.turn,
        step: entry.step,
        buckets: {
          uncachedInputTokens: Number.isFinite(buckets.uncachedInputTokens) ? buckets.uncachedInputTokens : 0,
          outputTokens: Number.isFinite(buckets.outputTokens) ? buckets.outputTokens : 0,
          cacheReadTokens: Number.isFinite(buckets.cacheReadTokens) ? buckets.cacheReadTokens : 0,
          cacheWriteTokens: Number.isFinite(buckets.cacheWriteTokens) ? buckets.cacheWriteTokens : 0,
        },
      };
    }
  }
  pruneDays(state);
  pruneLast(state);
  return state;
}

/** 读账本文件；不存在/损坏一律给空账本（损坏文件留一份 .corrupt 备份）。 */
export function readLedgerFile(file, log) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return normalizeState(JSON.parse(raw));
  } catch (error) {
    if (error && error.code !== 'ENOENT') {
      try {
        if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.corrupt-${Date.now()}`);
      } catch { /* 备份失败不归这个文件管 */ }
      log?.(`peak-whale: 账本读取失败（${error.message ?? error}），从空账本继续`);
    }
    return emptyState();
  }
}

/**
 * 带持久化的账本实例。
 *
 * 写盘是**合并 + 临时文件 + rename**：崩溃最多丢最近不到一秒的增量，
 * 不会留下半截 JSON。写不进去（权限/磁盘满）只告警一次，账本继续在内存里跑。
 *
 * @param {{file?: string, log?: (message: string) => void}} [options]
 */
export function createLedger(options = {}) {
  const { file, log } = options;
  const routes = new Map();
  const state = file ? readLedgerFile(file, log) : emptyState();
  let timer = null;
  let dirty = false;
  let writeWarned = false;

  function persist() {
    if (!file || !dirty) return;
    dirty = false;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const temp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(state));
      fs.renameSync(temp, file);
      writeWarned = false;
    } catch (error) {
      if (!writeWarned) {
        writeWarned = true;
        log?.(`peak-whale: 账本写入失败（${error?.message ?? error}），今日费用只保留在内存里`);
      }
    }
  }

  function schedule() {
    dirty = true;
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      persist();
    }, 800);
    // 计时器绝不能拖住进程退出。
    timer.unref?.();
  }

  return {
    /** 折一条会话事件；异常一律吞掉（账本坏了也不能拖垮会话）。 */
    observe(sessionId, event) {
      try {
        const changed = applyEvent(state, routes, sessionId, event);
        if (changed) {
          pruneDays(state);
          pruneLast(state);
          schedule();
        }
        return changed;
      } catch (error) {
        log?.(`peak-whale: 记账失败（${error?.message ?? error}）`);
        return false;
      }
    },
    /** 当日快照。 */
    snapshot(at = Date.now()) {
      try {
        return daySnapshot(state, at);
      } catch {
        return daySnapshot(emptyState(), at);
      }
    },
    /** 立刻落盘（供测试与插件卸载使用）。 */
    flush() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      persist();
    },
    dispose() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      persist();
    },
    /** 账本状态（测试与排错用）。 */
    get state() {
      return state;
    },
  };
}
