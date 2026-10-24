/**
 * 官方账户快照 —— **Host 专用**（不会被内联进浏览器 bundle）。
 *
 * 目标：回答「今天（北京时间）这个账户花了多少钱」，而且**只用官方数字**。
 *
 * ── 为什么不能用「牌价 × token」算 ────────────────────────────────────────────
 * 本地估算至少要凭空补三层：模型档位（路由）、峰谷档（按事件时刻推）、
 * 以及「哪些 token 算缓存命中的口径」。任一层猜错，数字就是错的，还看不出来。
 * 官方牌价是**对外报价**，不是账单：赠送抵扣、议价折扣、计费口径差异它都看不见。
 *
 * ── 官方到底给了什么（实测核对，2026-10-07）──────────────────────────────────
 *   · `GET https://api.deepseek.com/user/balance`（官方文档《查询余额》）
 *     → 唯一一个公开的账户数字接口：货币、总余额、赠金余额、充值余额。
 *   · 官方 API 文档的接口清单里**没有**任何消耗/用量/账单接口
 *     （Chat Completions / Responses / FIM / List Models / Get User Balance / Files）。
 *   · DSH 自己的 account 服务（`deepseekAccount`）也只暴露
 *     `getState / getProfile / getBalance / getUnnotifiedBonuses / …`——没有用量。
 *   · 官方用量明细只在网页端 `platform.deepseek.com/usage`（要登录态，非 API）。
 *
 * 所以「今日消费」只能从**官方余额**推：**累计当天的余额下降量**。
 *   余额 250.49 → 243.05 → 238.15 ⇒ 今日消费 = 12.34（全是官方读数之间的差）。
 * 充值/赠金到账会让余额**上升**，那部分单独记进 `topUps` 并**从消费里剔除**，
 * 免得「充了 100 块」被算成「今天倒赚 100」。
 *
 * ── 边界（请知悉，界面文案照实说）─────────────────────────────────────────────
 *   · **只统计插件运行期间**由官方余额变化反映出来的消费。DSH 关着的那段时间里
 *     花掉的钱，余额下一次被读到时会体现为一次「下降」，会记进**读到的这一天**。
 *   · 赠金**过期**也会让总余额下降，形态与消费一模一样，无法区分（余额接口不给原因）。
 *   · 所以它是「官方口径」而不是「官方账单」：数字来自官方接口，但采样密度由我们决定。
 *     要看权威明细，请点界面上的「token 消耗详情」去官方页面。
 *
 * @module src/official.js
 */

import fs from 'node:fs';
import path from 'node:path';

import { BEIJING_OFFSET_MS, beijingDateKey, beijingParts } from './peak.js';

/**
 * 存储结构版本；变了就整份重建（宁可丢一天的采样，也不读一份口径不同的旧账）。
 *
 * v1：首个「官方余额采样」版本（此前的本地牌价估算账本在 src/wallet.js，两者互不影响）。
 */
export const OFFICIAL_VERSION = 1;

/** 保留多少天的日采样（界面只看当天，留 30 天够排错）。 */
export const KEEP_DAYS = 30;

/** 官方用量明细页（DeepSeek 开放平台）。**这是用户看 token 消耗的权威入口**。 */
export const USAGE_URL = 'https://platform.deepseek.com/usage';

/**
 * 直接调官方余额接口 `GET /user/balance`，把返回收敛成 `normalizeBalance` 要的形状。
 *
 * 实测响应（2026-10-08，Bearer apiKey）：
 *   `{ "is_available": true, "balance_infos": [{ "currency": "CNY",
 *      "total_balance": "231.99", "granted_balance": "0.00",
 *      "topped_up_balance": "231.99" }] }`
 *
 * `total_balance` 是消费真正扣的那个数（含赠金 + 充值），用它当钱包余额；
 * `granted_balance` 是赠金明细，单列进 `bonusWallets`（只在 >0 时给，免得界面多一行 0）。
 *
 * @returns {{status: 'ready', value: Array, bonusWallets: Array}|{status: 'failed'}}
 *   `normalizeBalance` 只认 `status==='ready'` + `value`/`bonusWallets` 两个数组。
 */
export async function fetchOfficialBalance(options = {}) {
  const apiKey = typeof options.apiKey === 'string' ? options.apiKey.trim() : '';
  if (apiKey === '') return { status: 'failed' };
  const baseUrl = (typeof options.baseUrl === 'string' && options.baseUrl.trim() !== ''
    ? options.baseUrl.trim() : 'https://api.deepseek.com').replace(/\/+$/, '');
  const fetchImpl = options.fetchImpl !== undefined
    ? options.fetchImpl
    : (typeof fetch === 'function' ? (...args) => fetch(...args) : null);
  if (fetchImpl === null) return { status: 'failed' };
  try {
    const response = await fetchImpl(`${baseUrl}/user/balance`, {
      method: 'GET',
      headers: { authorization: `Bearer ${apiKey}` },
      signal: options.signal ?? undefined,
    });
    if (!response || !response.ok) return { status: 'failed' };
    const payload = await response.json();
    if (!payload || payload.is_available !== true || !Array.isArray(payload.balance_infos)) {
      return { status: 'failed' };
    }
    const value = [];
    const bonusWallets = [];
    for (const info of payload.balance_infos) {
      if (!info || typeof info !== 'object') continue;
      const currency = typeof info.currency === 'string' && info.currency !== '' ? info.currency : 'CNY';
      const total = typeof info.total_balance === 'string' ? info.total_balance : String(info.total_balance ?? '');
      if (total !== '' && total !== '0' && total !== '0.00') value.push({ currency, balance: total });
      const granted = typeof info.granted_balance === 'string' ? info.granted_balance : String(info.granted_balance ?? '');
      if (granted !== '' && granted !== '0' && granted !== '0.00') bonusWallets.push({ currency, balance: granted });
    }
    if (value.length === 0) return { status: 'failed' };
    return { status: 'ready', value, bonusWallets };
  } catch (error) {
    options.log?.(`peak-whale: 官方余额接口读取失败（${error?.message ?? error}）`);
    return { status: 'failed' };
  }
}

/**
 * 当天首个采样落在这个时刻之前，就认为「覆盖了完整一天」。
 *
 * 采样器 5 分钟一轮，所以零点过后最多 5 分钟就会有第一条；给 10 分钟余量，
 * 免得把「00:04 开机」的完整一天误标成半天。
 */
export const FULL_DAY_GRACE_MS = 10 * 60 * 1000;

/** 空快照账本。 */
export function emptyOfficialState() {
  return { version: OFFICIAL_VERSION, days: {} };
}

/** 六位小数：JSON 里不出现 0.30000000000000004 这种浮点噪声。 */
function round6(value) {
  return Math.round(value * 1e6) / 1e6;
}

/** 读成有限数；不是数就返回 null。 */
function toAmount(value) {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** 北京时间某一天的 00:00 对应的 epoch 毫秒（不依赖系统时区）。 */
export function startOfBeijingDay(at = Date.now()) {
  const p = beijingParts(new Date(at));
  return Date.UTC(p.year, p.month - 1, p.day) - BEIJING_OFFSET_MS;
}

/**
 * 从 `/api/wallet` 的归一化余额里挑出要跟踪的那个钱包。
 *
 * 优先人民币钱包（本插件全面按人民币计价），否则用第一个可读的钱包。
 * 只认**总余额**（`wallets`）——它已经含赠金与充值，是消费真正扣的那个数；
 * `bonus`（赠金明细）只是它的一个子集，跟着它算会重复扣。
 *
 * @param {{status?: string, wallets?: Array<{currency?: string, balance?: string|number}>}|null} balance
 *   归一化后的余额（形状见 index.js 的 `normalizeBalance`）。
 * @returns {{currency: string, amount: number}|null}
 */
export function pickWallet(balance) {
  if (!balance || balance.status !== 'ready' || !Array.isArray(balance.wallets)) return null;
  const rows = [];
  for (const row of balance.wallets) {
    if (!row || typeof row !== 'object') continue;
    const amount = toAmount(row.balance);
    if (amount === null) continue;
    const currency = typeof row.currency === 'string' && row.currency.trim() !== ''
      ? row.currency.trim().toUpperCase()
      : 'CNY';
    rows.push({ currency, amount });
  }
  if (rows.length === 0) return null;
  return rows.find((row) => row.currency === 'CNY') ?? rows[0];
}

/**
 * 记一次官方余额采样。
 *
 * 语义：**消费 = 余额的下降量**。
 *   · 余额比上一次低 → 差额计入当日消费；
 *   · 余额比上一次高 → 差额计入当日充值/赠金（`topUps`），不参与消费；
 *   · 相等 → 只累加采样次数。
 *
 * @param {object} state - 快照账本（就地修改 `days`）。
 * @param {{currency: string, amount: number}|null} wallet - `pickWallet` 的结果。
 * @param {number} [at] - 采样时刻（epoch 毫秒）。
 * @returns {boolean} 账本是否被改动。
 */
export function applySample(state, wallet, at = Date.now()) {
  if (!state || typeof state !== 'object' || !state.days || typeof state.days !== 'object') return false;
  if (!wallet || typeof wallet !== 'object') return false;
  const amount = toAmount(wallet.amount);
  if (amount === null) return false;
  const time = Number.isFinite(at) ? at : Date.now();
  const currency = typeof wallet.currency === 'string' && wallet.currency !== ''
    ? wallet.currency
    : 'CNY';

  const key = beijingDateKey(new Date(time));
  let day = state.days[key];
  if (!day || typeof day !== 'object') {
    state.days[key] = {
      currency,
      spent: 0,
      topUps: 0,
      samples: 1,
      firstAt: time,
      firstAmount: amount,
      lastAt: time,
      lastAmount: amount,
    };
    return true;
  }

  const last = toAmount(day.lastAmount);
  if (last !== null && amount < last) day.spent = round6((Number.isFinite(day.spent) ? day.spent : 0) + (last - amount));
  if (last !== null && amount > last) day.topUps = round6((Number.isFinite(day.topUps) ? day.topUps : 0) + (amount - last));
  day.samples = (Number.isFinite(day.samples) ? day.samples : 0) + 1;
  if (!Number.isFinite(day.firstAt)) day.firstAt = time;
  if (!Number.isFinite(day.firstAmount)) day.firstAmount = amount;
  day.lastAt = time;
  day.lastAmount = amount;
  if (typeof day.currency !== 'string' || day.currency === '') day.currency = currency;
  return true;
}

/**
 * 某一时刻所在（北京时间）那一天的官方口径消费快照。
 *
 * @param {object} state - 快照账本。
 * @param {number} [at] - 时刻，默认现在。
 * @returns {{date: string, cny: number, currency: string, samples: number, topUps: number,
 *            since: number|null, lastAt: number|null, fullDay: boolean, available: boolean}}
 *   `since` = 当天首次采样时刻（界面要照实说「自 HH:MM 起」）；
 *   `fullDay` = 首次采样是否落在零点后 10 分钟内（够近才算覆盖整天）。
 */
export function daySpend(state, at = Date.now()) {
  const date = new Date(at);
  const key = beijingDateKey(date);
  const day = state && state.days && typeof state.days === 'object' ? state.days[key] : null;
  const base = {
    date: key,
    cny: 0,
    currency: 'CNY',
    samples: 0,
    topUps: 0,
    since: null,
    lastAt: null,
    fullDay: false,
    available: false,
  };
  if (!day || typeof day !== 'object') return base;
  const samples = Number.isFinite(day.samples) ? day.samples : 0;
  const since = Number.isFinite(day.firstAt) ? day.firstAt : null;
  const midnight = startOfBeijingDay(at);
  return {
    date: key,
    cny: round6(Number.isFinite(day.spent) ? day.spent : 0),
    currency: typeof day.currency === 'string' && day.currency !== '' ? day.currency : 'CNY',
    samples,
    topUps: round6(Number.isFinite(day.topUps) ? day.topUps : 0),
    since,
    lastAt: Number.isFinite(day.lastAt) ? day.lastAt : null,
    fullDay: since !== null && since - midnight <= FULL_DAY_GRACE_MS,
    available: samples > 0,
  };
}

/** 丢掉 KEEP_DAYS 之外的旧采样；返回是否有改动。 */
export function pruneDays(state, keepDays = KEEP_DAYS) {
  if (!state || !state.days) return false;
  const keys = Object.keys(state.days).sort();
  if (keys.length <= keepDays) return false;
  for (const key of keys.slice(0, keys.length - keepDays)) delete state.days[key];
  return true;
}

/** 把磁盘上的任意 JSON 收敛成合法账本（读不出来就当没有）。 */
export function normalizeOfficialState(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyOfficialState();
  if (raw.version !== OFFICIAL_VERSION) return emptyOfficialState();
  const state = emptyOfficialState();
  if (raw.days && typeof raw.days === 'object') {
    for (const [key, day] of Object.entries(raw.days)) {
      if (!day || typeof day !== 'object') continue;
      const samples = Number.isFinite(day.samples) ? day.samples : 0;
      if (samples <= 0) continue; // 没有采样次数的日账没有意义
      state.days[key] = {
        currency: typeof day.currency === 'string' && day.currency !== '' ? day.currency : 'CNY',
        spent: Number.isFinite(day.spent) ? day.spent : 0,
        topUps: Number.isFinite(day.topUps) ? day.topUps : 0,
        samples,
        firstAt: Number.isFinite(day.firstAt) ? day.firstAt : null,
        firstAmount: toAmount(day.firstAmount),
        lastAt: Number.isFinite(day.lastAt) ? day.lastAt : null,
        lastAmount: toAmount(day.lastAmount),
      };
    }
  }
  pruneDays(state);
  return state;
}

/** 读快照文件；不存在/损坏一律给空账本（损坏文件留一份 .corrupt 备份）。 */
export function readOfficialFile(file, log) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return normalizeOfficialState(JSON.parse(raw));
  } catch (error) {
    if (error && error.code !== 'ENOENT') {
      try {
        if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.corrupt-${Date.now()}`);
      } catch { /* 备份失败不归这个文件管 */ }
      log?.(`peak-whale: 官方快照读取失败（${error.message ?? error}），从空账继续`);
    }
    return emptyOfficialState();
  }
}

/**
 * 带持久化的官方快照实例。
 *
 * 写盘是**合并 + 临时文件 + rename**：崩溃最多丢最近不到一秒的增量，
 * 不会留下半截 JSON。写不进去（权限/磁盘满）只告警一次，快照继续在内存里跑。
 *
 * @param {{file?: string, log?: (message: string) => void}} [options]
 */
export function createOfficialTracker(options = {}) {
  const { file, log } = options;
  const state = file ? readOfficialFile(file, log) : emptyOfficialState();
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
        log?.(`peak-whale: 官方快照写入失败（${error?.message ?? error}），今日消费只保留在内存里`);
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
    /**
     * 记一次余额读数。传归一化后的余额（`{status, wallets}`）或 `pickWallet` 的结果都行。
     * 异常一律吞掉：快照坏了也不能拖垮会话。
     */
    record(balance, at = Date.now()) {
      try {
        const wallet = balance && Array.isArray(balance.wallets) ? pickWallet(balance) : balance;
        if (!wallet) return false;
        const changed = applySample(state, wallet, at);
        if (changed) {
          pruneDays(state);
          schedule();
        }
        return changed;
      } catch (error) {
        log?.(`peak-whale: 官方快照记账失败（${error?.message ?? error}）`);
        return false;
      }
    },
    /** 当日快照（官方口径）。 */
    snapshot(at = Date.now()) {
      try {
        return daySpend(state, at);
      } catch {
        return daySpend(emptyOfficialState(), at);
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
    /** 快照状态（测试与排错用）。 */
    get state() {
      return state;
    },
  };
}
