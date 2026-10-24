/**
 * dsh-deepseek-peak-whale —— Host 半身。
 *
 * 职责三件：
 *   1. 注册 `/price` 命令：会话里打印当前峰谷时段、距半价倒计时与官方价格表；
 *   2. 注册 `/balance` 命令：打印**账户余额**与**今日消费**；
 *   3. 提供这两样数据本身 —— 余额与今日消费都取自**官方**账户读数
 *      （余额接口 + 它的逐次采样差分，见 src/official.js），
 *      再经 `/dsh-deepseek-peak-whale/api/wallet` 这条 HTTP 路由喂给浏览器半身。
 *
 * 界面部分（侧栏状态条、详情浮层）在 client.js。
 *
 * 设计原则：**绝不抛错**。apply 里的任何失败只记日志——这个 loader entry 必须
 * 正常激活，否则浏览器半身不会挂载（两者绑在同一行上）。所有可选服务都用
 * `ctx.get()` 软查找，缺一个也只是少一个功能，不拖垮 `/price`。
 */
import os from 'node:os';
import path from 'node:path';

import {
  MODELS,
  PEAK_UTC_WINDOWS,
  PRICING_AS_OF,
  PRICING_URL,
  PRICING_URL_CN,
  WEEKDAY_CN,
  beijingParts,
  boundaryLabel,
  describePeriod,
  formatBeijingFull,
  formatClock,
  formatCny,
  formatCnyAmount,
  formatDuration,
  formatMoney,
  formatTokens,
  priceOf,
  summary,
} from './src/peak.js';
import {
  USAGE_URL,
  createOfficialTracker,
  daySpend,
  emptyOfficialState,
  fetchOfficialBalance,
} from './src/official.js';
import { createLedger, daySnapshot, emptyState, exportLedgerCSV } from './src/wallet.js';
import {
  DEFAULTS as OPTIMIZE_DEFAULTS,
  createOptimizeRunner,
  ensureSettingsFile,
  optimize3,
  readSettings,
  readUiSettings,
  settingsPath,
  writeUiSettings,
} from './src/optimize.js';
import { optimize3ViaWebChat } from './src/webchat.js';
import { createSessionRouteRunner, routeHintOf } from './src/sessionllm.js';

/** Cordis 插件名（与 cordis.patch.yml 的 id 对应）。 */
export const name = 'peak-whale';

/**
 * 余额与账本的 HTTP 路径。浏览器半身用同源 fetch 取它（相对路径，同源即通）。
 * 之所以走 HTTP 而不是 `host.call`：`host.call` 是**动态插件**才有的内建，
 * 安装型包没有它 —— 官方插件（如 dsh-webhook-github）同样用 webServer 注册路由。
 */
export const WALLET_ROUTE = '/dsh-deepseek-peak-whale/api/wallet';
export const WALLET_EXPORT_ROUTE = '/dsh-deepseek-peak-whale/api/wallet/export';

/** 余额查询的缓存时长：`getBalance` 要打 Platform，不该每个标签页各打一次。 */
export const BALANCE_TTL_MS = 45000;

/**
 * 提示词优化的 HTTP 路径（POST，body `{ text }`）。
 *
 * 为什么在 Host 侧打上游：key 必须待在本机（浏览器半身是公开可读的 bundle），
 * 而且跨源直连 `api.deepseek.com` 还要赌 CORS —— Host 侧一个 fetch 就没这些事。
 */
export const OPTIMIZE_ROUTE = '/dsh-deepseek-peak-whale/api/optimize';

/**
 * 三版优化路由：`POST /dsh-deepseek-peak-whale/api/optimize3`，body `{ text }` →
 * `{ ok, variants: [{key,label,optimized,unchanged,usage,cached}, …] }`。
 *
 * 界面拿到后摆出「更详细 / 更专业 / AI 自主+建议 / 不优化了」四选一气泡。
 */
export const OPTIMIZE3_ROUTE = '/dsh-deepseek-peak-whale/api/optimize3';

/**
 * UI 设置（详情页模式 / 优化开关）的 HTTP 路径：GET 读取、POST 写入。
 *
 * 响应里**只含** `uiMode` / `optimizeEnabled` / `apiKeyConfigured` ——
 * API key 是绝不能离开 Host 的字段，连「是否配置了」都只回一个布尔。
 */
export const SETTINGS_ROUTE = '/dsh-deepseek-peak-whale/api/settings';

/** 优化配置（含 API key）的落点：`$DSH_HOME/peak-whale/settings.json`。 */
export function optimizeSettingsFile() {
  return settingsPath(ledgerDir());
}

/**
 * 上一次 `apply()` 自己注册的东西（路由 / 会话监听的撤销函数）。
 *
 * 热重载时 loader 会卸掉旧实例再挂新实例，但**顺序并不保证**：新的先注册、旧的再卸载，
 * 同名路由就会重复注册 → `webServer.register` 抛错 → 后面的注册（第二条路由、命令）
 * 全被带走。症状极具迷惑性：**路由双双 404、命令消失，而插件在设置页仍显示「已启用」**。
 * 模块级变量在同一个模块实例内跨多次 apply 存活，所以重挂前先自己把上一批撤掉。
 * 每个撤销函数都包成幂等的（见下），被撤两次也不会炸。
 */
let ownDisposers = [];

/**
 * 上一次「Host 接线」注册的路由/命令撤销函数（与上面的 ownDisposers 分开：
 * 那条管记账监听，这条管路由与命令）。每次 mountHost 前先撤掉自己上一次的，
 * 这样重试补挂与热重载都不会留下同名重复注册。
 */
let ownHostDisposers = [];

/**
 * 上一次注册的 /price /balance 命令撤销函数（与路由分开：命令不依赖 webServer，
 * 它的依赖是 commands 与 deepseekAccount，所以接线各自独立、各自重试）。
 */
let ownCommandDisposers = [];

/** 账本落在 `$DSH_HOME`（或 `~/.dsh`）下的插件目录里。 */
export function ledgerDir() {
  const fromEnv = process.env.DSH_HOME;
  const home = typeof fromEnv === 'string' && fromEnv.trim() !== '' ? fromEnv.trim() : path.join(os.homedir(), '.dsh');
  return path.join(home, 'peak-whale');
}

/** 每个 profile 一份账本：桌面和 web 各跑各的，写同一份会互相覆盖。 */
export function ledgerFile(profileName) {
  const profile = String(profileName ?? 'default').replace(/[^\w.-]+/g, '-') || 'default';
  return path.join(ledgerDir(), `wallet.${profile}.json`);
}

/** 官方余额采样快照，同样按 profile 分文件。 */
export function officialFile(profileName) {
  const profile = String(profileName ?? 'default').replace(/[^\w.-]+/g, '-') || 'default';
  return path.join(ledgerDir(), `official.${profile}.json`);
}

/** 官方余额的采样间隔：5 分钟一轮（余额接口很轻，采样密一些「消费」才不漏）。 */
export const SAMPLE_INTERVAL_MS = 5 * 60 * 1000;

/** 读取 profile 名（读不到就回落 `default`）。 */
function profileNameOf(ctx) {
  try {
    const info = typeof ctx?.get === 'function' ? ctx.get('profileContext') : undefined;
    const name = info?.name;
    return typeof name === 'string' && name.trim() !== '' ? name.trim() : 'default';
  } catch {
    return 'default';
  }
}

/**
 * 组装一次 Platform 调用要带的客户端身份。
 *
 * 三项都是**发起这次调用的 UI** 的事实（DSH 自己的 account 控制器也是这么拼的）：
 * `version` 取构建期注入的 `DSH_CLIENT_VERSION`，`timezoneOffsetSeconds`
 * 是「东为正」的秒数（北京时间 = +28800）。
 *
 * @param {string} [locale] - UI 语言，例如 `zh-CN`；平台侧会归一成 zh_CN / en_US。
 * @param {Date} [now] - 取本机时区偏移的时刻。
 */
export function accountClientMetadata(locale, now = new Date()) {
  return {
    version: process.env.DSH_CLIENT_VERSION || '0.0.0',
    locale: typeof locale === 'string' && locale.trim() !== '' ? locale.trim() : 'zh-CN',
    timezoneOffsetSeconds: -now.getTimezoneOffset() * 60,
  };
}

/**
 * 余额查询器：带 TTL 缓存与并发去重。
 *
 * @param {{getState?: Function, getBalance?: Function}|(() => any)|null|undefined} source
 *   `deepseekAccount` 服务本体，**或者**一个「现在去取它」的解析函数（推荐后者）。
 * @param {{ttl?: number, now?: () => number}} [options]
 * @returns {(locale?: string) => Promise<{state: object|null, balance: object|null, unavailable: boolean}>}
 */
export function createAccountReader(source, options = {}) {
  const ttl = Number.isFinite(options.ttl) ? options.ttl : BALANCE_TTL_MS;
  const clock = typeof options.now === 'function' ? options.now : () => Date.now();
  let cache = null;
  let inflight = null;

  /**
   * **每次读取时重新解析服务** —— 这是本文件第二个「开机竞态」修出来的同一类坑。
   *
   * 实测教训（2026-10-06）：开机瞬间 `deepseekAccount` 还没注册，挂载那一刻
   * `serviceOf('deepseekAccount')` 只能拿到 `undefined`。老写法把「此刻拿不到」
   * 当成「永远没有账户服务」，于是 reader 从此恒返回 `unavailable`——
   * 症状就是**自启修好之后余额反而永远消失**（以前手动开关插件＝晚注册，恰好躲过）。
   *
   * 传函数进来就没有这个陷阱：服务什么时候到，什么时候就能读；
   * 顺带也扛得住热重载换服务实例。`unavailable` 的结果**不进缓存**，
   * 所以下一次轮询就会自己恢复，不需要重启也不需要重新挂载。
   */
  const resolveSource = () => {
    if (typeof source !== 'function') return source;
    try {
      return source();
    } catch {
      return undefined;
    }
  };

  async function load(account, locale) {
    const meta = accountClientMetadata(locale, new Date(clock()));
    let state = null;
    let balance = null;
    try {
      state = await account.getState();
    } catch {
      state = null; // 查询失败保留登录态以外的空结果（官方语义：失败不等于登出）
    }
    const signedOut = state === null || state === undefined || state.status === 'signed-out';
    if (!signedOut && typeof account.getBalance === 'function') {
      try {
        balance = await account.getBalance(meta);
      } catch {
        balance = null;
      }
    }
    return { state, balance, unavailable: false };
  }

  return async function read(locale) {
    const account = resolveSource();
    if (!account || typeof account.getState !== 'function') {
      // 服务还没到：**不写缓存**，下一次读取会再解析一遍（自动恢复的关键）。
      return { state: null, balance: null, unavailable: true };
    }
    const now = clock();
    if (cache !== null && now - cache.at < ttl) return cache;
    if (inflight !== null) return inflight;
    inflight = (async () => {
      try {
        const result = await load(account, locale);
        cache = { at: clock(), ...result };
        return cache;
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  };
}

/** 把 `AccountDetails['balance']` 收敛成界面要的形状（十进制字符串原样保留）。 */
export function normalizeBalance(balance) {
  if (balance === null || balance === undefined) return { status: 'unknown' };
  if (balance.status === 'failed') return { status: 'failed' };
  if (balance.status !== 'ready') return { status: 'unknown' };
  const toRows = (list) => (Array.isArray(list)
    ? list
      .filter((row) => row && typeof row === 'object')
      .map((row) => ({
        currency: typeof row.currency === 'string' ? row.currency : '',
        balance: typeof row.balance === 'string' ? row.balance : String(row.balance ?? ''),
      }))
    : []);
  return { status: 'ready', wallets: toRows(balance.value), bonus: toRows(balance.bonusWallets) };
}

/**
 * 组装 `/api/wallet` 的响应体 —— 纯函数式的组装（读取由调用方注入），
 * 所以能在没有网络、没有账号的测试里跑通。
 *
 * **余额与今日消费都来自官方**：
 *   · `balance` —— 官方余额接口的原始读数（经 `normalizeBalance` 收敛）；
 *   · `today`   —— 官方余额的**逐次采样差分**（见 src/official.js）。
 * 本地那份「牌价 × token」的估算**只保留在 `session` 里当参考**，
 * 它不出现在界面的金额位置（口径不同，摆在一起只会互相打架）。
 *
 * @param {{reader: Function, ledger?: {snapshot: Function}|null,
 *          official?: {record: Function, snapshot: Function}|null,
 *          locale?: string, now?: Date, profile?: string}} options
 */
export async function buildWalletPayload(options) {
  const now = options.now instanceof Date ? options.now : new Date();
  const at = now.getTime();
  let account = { state: null, balance: null, unavailable: true };
  if (typeof options.reader === 'function') {
    try {
      account = await options.reader(options.locale);
    } catch {
      account = { state: null, balance: null, unavailable: true };
    }
  }
  const state = account.state;
  const known = state && (state.status === 'signed-out' || state.status === 'credential-stored');
  const links = state && state.links && typeof state.links === 'object' ? state.links : {};

  // ── 余额来源：优先直接打官方余额接口（用 API key），拿不到再回落账户服务 ──
  // 账户服务给的余额也是官方数字，但走的是 DSH 登录态；直接用 API key 打
  // /user/balance 更贴合「查询官网」，而且不依赖 DSH 账户服务是否就绪。
  let balanceRaw = account.balance;
  if (typeof options.officialBalance === 'function') {
    try {
      const ob = await options.officialBalance();
      if (ob && ob.status === 'ready') balanceRaw = ob;
    } catch { /* 官方接口失败就回落账户服务的余额 */ }
  }
  const balance = normalizeBalance(balanceRaw);

  // ── 今日消费：官方口径 ────────────────────────────────────────────────────
  // 每读一次余额就记一次采样，消费 = 当天余额的下降量累计（充值/赠金不计入）。
  let today;
  try {
    if (options.official) {
      options.official.record(balance, at);
      today = options.official.snapshot(at);
    } else {
      today = daySpend(emptyOfficialState(), at);
    }
  } catch {
    today = daySpend(emptyOfficialState(), at);
  }

  // ── 本机会话统计：token 计数（本地，只作参考，不参与任何金额）────────────
  let session;
  try {
    const snap = options.ledger ? options.ledger.snapshot(at) : daySnapshot(emptyState(), at);
    session = {
      date: snap.date,
      requests: snap.requests,
      tokens: snap.tokens,
      estimateCny: snap.cny,
    };
  } catch {
    const snap = daySnapshot(emptyState(), at);
    session = { date: snap.date, requests: snap.requests, tokens: snap.tokens, estimateCny: snap.cny };
  }

  return {
    ok: true,
    nowMs: at,
    profile: options.profile ?? 'default',
    account: {
      status: account.unavailable ? 'unavailable' : known ? state.status : 'unknown',
      topUpUrl: typeof links.topUpUrl === 'string' ? links.topUpUrl : null,
      usageUrl: typeof links.usageUrl === 'string' ? links.usageUrl : null,
    },
    balance,
    today: { ...today, source: 'official-balance' },
    /** 本机会话统计（token 计数）；界面的金额位置**不用**它。 */
    session,
    /** 界面据此标注来源：今日消费是官方余额差，不是本地牌价估算。 */
    note: 'official-balance-delta',
    /** UI 设置（详情页模式 / 优化开关）。调用方没给 settingsFile 就不带。 */
    settings: options.settings ?? undefined,
    /** token 消耗明细的官方入口（拿不到账户链接时的兜底）。 */
    usageUrl: (typeof links.usageUrl === 'string' && links.usageUrl !== '') ? links.usageUrl : USAGE_URL,
  };
}

/** 余额行：`$12.34` 或 `¥12.34`；多个钱包分行给。 */
function balanceLines(balance) {
  if (!balance || balance.status !== 'ready') {
    if (balance && balance.status === 'failed') return ['  查询失败（网络或登录态问题），稍后重试'];
    if (balance && balance.status === 'unknown') return ['  未查询到余额'];
    return [];
  }
  const lines = [];
  for (const row of balance.wallets) lines.push(`  ${formatMoney(row.balance, row.currency || 'CNY')}（${row.currency || 'CNY'}）`);
  for (const row of balance.bonus) lines.push(`  赠送 ${formatMoney(row.balance, row.currency || 'CNY')}（${row.currency || 'CNY'}）`);
  if (lines.length === 0) lines.push('  （钱包为空）');
  return lines;
}

/** `/balance` 命令的纯文本报告。 */
export function buildBalanceReport(payload) {
  const accountStatus = payload?.account?.status;
  const statusText = accountStatus === 'credential-stored' || accountStatus === 'signed-out'
    ? (accountStatus === 'signed-out' ? '未登录' : '已登录（凭据在本地）')
    : (accountStatus === 'unavailable' ? '账户服务不可用' : '状态未知');
  const today = payload?.today ?? daySpend(emptyOfficialState());
  const session = payload?.session ?? null;
  const tokens = session?.tokens ?? emptyTokensForReport();
  const lines = [
    `DeepSeek 账户 · ${payload?.profile ?? 'default'} profile`,
    `登录状态：${statusText}`,
    '余额：',
    ...balanceLines(payload?.balance),
    '',
    `今日消费（官方口径 · 北京时间 ${today.date}）：`,
  ];
  if (today.available === false) {
    lines.push('  暂无采样 —— 插件启动后每 5 分钟读一次官方余额，之后这里才有数。');
  } else {
    lines.push(`  ${formatCnyAmount(today.cny)}（${today.currency}）`
      + ` · ${today.samples} 次官方余额采样`);
    lines.push(`  采样区间：${today.fullDay ? '当日 00:00 起（覆盖整天）' : `自 ${clockOf(today.since)} 起（当天首次读数）`}`);
    if (Number.isFinite(today.topUps) && today.topUps > 0) {
      lines.push(`  期间充值/赠金 ${formatCnyAmount(today.topUps)} —— 已从消费中剔除`);
    }
  }
  if (session) {
    lines.push(
      `  本机会话统计（token 计数，仅本插件运行期间）：${session.requests} 次请求`,
      `    输入·未命中 ${formatTokens(tokens.uncachedInputTokens)} · 缓存命中 ${formatTokens(tokens.cacheReadTokens)}`
        + ` · 写缓存 ${formatTokens(tokens.cacheWriteTokens)} · 输出 ${formatTokens(tokens.outputTokens)}`,
      `    按官方牌价的本地估算（仅供参考，不是账单）：${formatCnyAmount(session.estimateCny)}`,
    );
  }
  if (payload?.account?.topUpUrl) lines.push(`充值：${payload.account.topUpUrl}`);
  const usageUrl = payload?.usageUrl ?? payload?.account?.usageUrl ?? USAGE_URL;
  lines.push(`token 消耗明细（官方页面）：${usageUrl}`);
  lines.push('说明：余额与今日消费都取自官方余额接口（消费 = 当天余额下降量累计），');
  lines.push('      不含「插件没运行时发生的采样空档」之外的口径换算，也不是账单。');
  return lines.join('\n');
}

/** 毫秒时间戳 → 北京时间 `HH:MM`（拿不到就 `—`）。 */
function clockOf(ms) {
  if (!Number.isFinite(ms)) return '—';
  try {
    return formatClock(new Date(ms));
  } catch {
    return '—';
  }
}

function emptyTokensForReport() {
  return {
    uncachedInputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
}

/** 生成 `/price` 的纯文本报告。 */
export function buildReport(date = new Date()) {
  const s = summary(date);
  const desc = describePeriod(s);
  const p = beijingParts(date);
  const lines = [
    `DeepSeek 峰谷计价 · 北京时间 ${formatBeijingFull(date)}（${WEEKDAY_CN[p.weekday]}）`,
    `当前：${desc.title} —— ${desc.note}`,
    `下次切换：${boundaryLabel(date, s.next)} → ${s.nextIsPeak ? '峰时（全价）' : '谷时（半价）'}，还需 ${formatDuration(s.minutesLeft)}`,
    '',
    '价格（人民币元 / 100 万 tokens，谷 / 峰）：',
  ];
  for (const model of MODELS) {
    lines.push(
      `  ${model.name.padEnd(16)} 输入·命中 ${formatCny(priceOf(model, 'cacheHit', false))}/${formatCny(priceOf(model, 'cacheHit', true))}` +
        `  输入·未命中 ${formatCny(priceOf(model, 'cacheMiss', false))}/${formatCny(priceOf(model, 'cacheMiss', true))}` +
        `  输出 ${formatCny(priceOf(model, 'output', false))}/${formatCny(priceOf(model, 'output', true))}`,
    );
  }
  lines.push(
    '',
    '峰时：UTC 01:00–04:00、06:00–10:00（北京时间 09:00–12:00、14:00–18:00），周一至周五且非法定节假日。',
    `其余时段（含整个周末与节假日）均为谷时，价格恰好减半。当前峰时窗口：${PEAK_UTC_WINDOWS.map((w) => `北京 ${w.beijing}`).join('、')}。`,
    `节假日表内置 2026 年（国务院办公厅放假安排），跨年需更新。`,
    `数据来源：${PRICING_URL_CN}（抓取于 ${PRICING_AS_OF}；美元牌价见 ${PRICING_URL}）`,
    '账户余额与今日费用：输入 `/balance`。',
  );
  return lines.join('\n');
}

/**
 * 把 HTTP 响应当成 JSON 送出去；写失败不能抛。
 *
 * **先序列化、再写响应头**：载荷一旦序列化不了，还能改口发 500，
 * 而不是 200 已经发出去了才发现 body 送不出来。
 */
function sendJson(response, status, payload) {
  let body;
  try {
    body = JSON.stringify(payload);
  } catch {
    status = 500;
    body = JSON.stringify({ ok: false, error: 'payload is not serializable' });
  }
  try {
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    response.end(body);
  } catch {
    try {
      response.end();
    } catch { /* 连接已经没了 */ }
  }
}

/**
 * 路由处理器：`GET /dsh-deepseek-peak-whale/api/wallet?locale=zh-CN`。
 *
 * 同源限定（不发 CORS 头）：余额是账户数据，不该让任意网页读到。
 *
 * @param {{reader: Function, ledger: {snapshot: Function}|null, profile: string}} deps
 */
export function createWalletHandler(deps) {
  return async function handle(request, response) {
    try {
      if (request.method !== undefined && request.method !== 'GET' && request.method !== 'HEAD') {
        sendJson(response, 405, { ok: false, error: 'method not allowed' });
        return;
      }
      let locale;
      try {
        const url = new URL(request.url ?? WALLET_ROUTE, 'http://localhost');
        locale = url.searchParams.get('locale') ?? undefined;
      } catch {
        locale = undefined;
      }
      const payload = await buildWalletPayload({
        reader: deps.reader,
        ledger: deps.ledger,
        official: deps.official ?? null,
        officialBalance: deps.officialBalance ?? null,
        locale,
        profile: deps.profile,
        settings: typeof deps.settingsFile === 'string' && deps.settingsFile !== ''
          ? readUiSettings(deps.settingsFile)
          : undefined,
      });
      sendJson(response, 200, payload);
    } catch (error) {
      ctxWarn(deps, `wallet 路由失败: ${error?.message ?? error}`);
      sendJson(response, 500, { ok: false, error: 'internal error' });
    }
  };
}

/**
 * 导出账本路由处理器：`GET /dsh-deepseek-peak-whale/api/wallet/export?format=csv`
 *
 * format=csv（默认）返回 CSV 文本；format=json 返回完整 JSON。
 * 同源限定，不发 CORS 头。
 */
export function createWalletExportHandler(deps) {
  return async function handle(request, response) {
    try {
      if (request.method !== undefined && request.method !== 'GET' && request.method !== 'HEAD') {
        sendJson(response, 405, { ok: false, error: 'method not allowed' });
        return;
      }
      let format = 'csv';
      try {
        const url = new URL(request.url ?? WALLET_EXPORT_ROUTE, 'http://localhost');
        format = (url.searchParams.get('format') || 'csv').toLowerCase();
      } catch { /* 默认 csv */ }
      const state = deps.ledger?.state ?? emptyState();
      const rows = Object.entries(state.days || {}).length;
      if (rows === 0) {
        sendJson(response, 404, { ok: false, error: 'no ledger data' });
        return;
      }
      if (format === 'json') {
        sendJson(response, 200, state);
      } else {
        const csv = exportLedgerCSV(state);
        response.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="peak-whale-ledger.csv"',
          'Content-Length': Buffer.byteLength(csv),
        });
        response.end(csv);
      }
    } catch (error) {
      ctxWarn(deps, `wallet export 路由失败: ${error?.message ?? error}`);
      sendJson(response, 500, { ok: false, error: 'internal error' });
    }
  };
}

function ctxWarn(deps, message) {
  try {
    deps?.log?.(message);
  } catch { /* 日志失败无所谓 */ }
}

/**
 * 路由处理器：`POST /dsh-deepseek-peak-whale/api/optimize`，body `{ text }`。
 *
 * 有界读 body；方法不对 405；**业务失败一律 200 + `ok:false` + 一句中文**
 * ——「没配 key」「余额不足」是要显示给人看的，不该让浏览器只看到一个状态码。
 *
 * @param {{optimize: (text: string) => Promise<object>, log?: Function}} deps
 */
export function createOptimizeHandler(deps) {
  const MAX_BODY = 64 * 1024;
  return async function handle(request, response) {
    try {
      if (request.method !== 'POST') {
        sendJson(response, 405, { ok: false, error: 'method not allowed' });
        return;
      }
      let body = '';
      let tooBig = false;
      if (request && typeof request[Symbol.asyncIterator] === 'function') {
        for await (const chunk of request) {
          body += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
          if (body.length > MAX_BODY) {
            tooBig = true;
            break;
          }
        }
      }
      if (tooBig) {
        sendJson(response, 413, { ok: false, error: 'too large', message: '请求太大了（上限 64KB），先把提示词精简一点' });
        return;
      }
      let parsed = null;
      try {
        parsed = body === '' ? {} : JSON.parse(body);
      } catch {
        parsed = null;
      }
      const text = parsed && typeof parsed === 'object' && typeof parsed.text === 'string' ? parsed.text : '';
      if (typeof deps.optimize !== 'function' && typeof deps.sessionRunner !== 'function') {
        sendJson(response, 503, { ok: false, error: 'unavailable', message: '优化器没装上（Host 侧未就绪）' });
        return;
      }
      // 通道优先级：请求带 route（浏览器读到当前会话的模型选择）→ 会话同路由
      // 通道（ctx.llm，与对话共用适配器和凭据）；读不到时先试全局默认模型，
      // 通道级错误（no-route/no-llm）再回落网关 runner（baseUrl+key）。测试里两个
      // runner 都可以不注入：那时保持旧网关行为，正好钉住回归。
      const route = routeHintOf(parsed);
      const sessionRunner = typeof deps.sessionRunner === 'function' ? deps.sessionRunner : null;
      let result;
      if (sessionRunner !== null) {
        result = await sessionRunner(text, undefined, route);
        if (result && result.ok !== true
          && (result.error === 'no-route' || result.error === 'no-llm')
          && typeof deps.optimize === 'function') {
          ctxWarn(deps, 'peak-whale: 会话路由通道不可用，optimize 回落网关通道');
          result = await deps.optimize(text);
        }
      } else {
        result = (await deps.optimize(text)) ?? { ok: false, message: '优化器没有返回结果' };
      }
      sendJson(response, 200, result.ok
        ? {
          ok: true,
          optimized: typeof result.optimized === 'string' ? result.optimized : '',
          model: typeof result.model === 'string' ? result.model : OPTIMIZE_DEFAULTS.model,
          cached: result.cached === true,
          unchanged: result.unchanged === true,
          rounds: typeof result.rounds === 'number' ? result.rounds : 1,
          // 用量只在**这次真花了钱**时带出（缓存命中没有 usage）：客户端据此在
          // 完成气泡里显示 token 数，让人看得见这次调用花了多少。
          usage: result.usage && typeof result.usage === 'object'
            ? {
              prompt: Number(result.usage.prompt) || 0,
              completion: Number(result.usage.completion) || 0,
              total: Number(result.usage.total) || 0,
            }
            : null,
        }
        : {
          ok: false,
          error: typeof result.error === 'string' ? result.error : 'failed',
          message: typeof result.message === 'string' ? result.message : '优化失败',
        });
    } catch (error) {
      ctxWarn(deps, `optimize 路由失败: ${error?.message ?? error}`);
      sendJson(response, 500, { ok: false, error: 'internal error', message: 'Host 侧出错了，看一眼 DSH 日志' });
    }
  };
}

/**
 * 路由处理器：`POST /dsh-deepseek-peak-whale/api/optimize3`，body `{ text }`。
 *
 * 并行跑三版（更详细 / 更专业 / AI 自主+建议），返回 `variants` 数组；
 * 界面据此摆出四选一气泡（三版 + 「还是不优化了吧」）。
 *
 * **后端选择**：请求带 `route`（浏览器读到的当前会话模型选择）走会话同路由
 * 通道（ctx.llm）；否则按 settings：填了 `webToken` 走网页端对话（cookie 方案），
 * 没填先试全局默认模型（llm），再回落 API key 网关。每次请求都重读 settings，
 * 用户填完 token 不用重启。
 *
 * @param {{optimize: Function, sessionRunner?: Function|null, settingsFile: string, wasmPath?: string, log?: Function}} deps
 */
export function createOptimize3Handler(deps) {
  const MAX_BODY = 64 * 1024;
  return async function handle(request, response) {
    try {
      if (request.method !== 'POST') {
        sendJson(response, 405, { ok: false, error: 'method not allowed' });
        return;
      }
      let body = '';
      let tooBig = false;
      if (request && typeof request[Symbol.asyncIterator] === 'function') {
        for await (const chunk of request) {
          body += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
          if (body.length > MAX_BODY) {
            tooBig = true;
            break;
          }
        }
      }
      if (tooBig) {
        sendJson(response, 413, { ok: false, error: 'too large', message: '请求太大了（上限 64KB），先把提示词精简一点' });
        return;
      }
      let parsed = null;
      try {
        parsed = body === '' ? {} : JSON.parse(body);
      } catch {
        parsed = null;
      }
      const text = parsed && typeof parsed === 'object' && typeof parsed.text === 'string' ? parsed.text : '';

      // 后端选择：填了 webToken 走网页端，否则走 API key
      let webToken = '';
      let keepWebSessions = false;
      let promptStyle = '';
      let serialVariants = false;
      let iterateRounds = 2;
      try {
        const s = readSettings(deps.settingsFile);
        webToken = s.webToken || '';
        keepWebSessions = s.keepWebSessions === true;
        promptStyle = s.promptStyle || '';
        serialVariants = s.serialVariants === true;
        iterateRounds = s.iterateRounds;
        if (s.webTokenInvalid) {
          // 粘进来的是取 token 的**命令**而不是 token 本身。必须显式报错：
          // 当没填会静默回落到按 token 计费的 API 通道，那是白花钱。
          sendJson(response, 200, {
            ok: false,
            error: 'bad_web_token',
            message: 'settings.json 的 webToken 填的不是 token，而是一段 JS 代码（看起来像 copy(...) 这条命令本身）。'
              + '请在 chat.deepseek.com 按 F12 → 控制台 → 粘贴该命令并回车 → 再回 settings.json 按 Ctrl+V（此时剪贴板里才是真正的 token）。修好后无需重启。',
          });
          return;
        }
      } catch { /* settings 读挂了就回落 API key */ }

      // 通道优先级：① 请求带 route（浏览器读到当前会话的模型选择）→ 会话同路由
      // 通道；② webToken（用户显式配置的网页端对话）；③ 全局默认模型（llm）；
      // ④ 网关 runner（baseUrl+key）。③④ 之间的回落只在通道级错误
      // （no-route/no-llm）时发生——上游模型自己的失败（限流/凭据）不回落，
      // 否则换通道重打三版只是把一次失败变成两次失败。
      const route = routeHintOf(parsed);
      const sessionRunner = typeof deps.sessionRunner === 'function' ? deps.sessionRunner : null;
      let result;
      if (route !== null && sessionRunner !== null) {
        let firstError = null;
        const wrapped = async (t, key) => {
          const r = await sessionRunner(t, key, route);
          if (r && r.ok !== true && firstError === null) firstError = r.error;
          return r;
        };
        result = await optimize3(wrapped, text, { serial: serialVariants });
        if (result.ok !== true && (firstError === 'no-route' || firstError === 'no-llm')
          && typeof deps.optimize === 'function') {
          ctxWarn(deps, 'peak-whale: 会话路由通道不可用，optimize3 回落网关通道');
          result = await optimize3(deps.optimize, text, { serial: serialVariants });
        }
      } else if (webToken) {
        // deps 可注入：没有它就没法在测试里验「回执透传 + 零回执告警」（真调用要联网花钱）。
        const viaWeb = deps.optimize3ViaWebChat ?? optimize3ViaWebChat;
        ctxWarn(deps, `peak-whale: optimize3 走网页端对话（cookie 方案，${keepWebSessions ? '保留' : '用完即删'}会话）`);
        result = await viaWeb(
          {
            token: webToken,
            wasmPath: deps.wasmPath,
            log: (m) => ctxWarn(deps, m),
            timeoutMs: 120000,
            autoDelete: !keepWebSessions,
            promptStyle,
            iterateRounds,
          },
          text,
        );
        // 删除回执必须透传到响应里。2026-10-11 的教训：Host 加载到旧副本时
        // 会话一条没删，而响应体、日志、本机文件三处都看不出任何异常 ——
        // 有这两个字段，「删了没删」在 GUI 侧一眼可判。
        if (!keepWebSessions && Array.isArray(result?.deletedSessions) && result.deletedSessions.length === 0) {
          ctxWarn(deps, 'peak-whale: ⚠ 用完即删未确认删除任何会话（可能是加载了旧版 webchat.js）');
        }
      } else if (sessionRunner !== null) {
        // 浏览器没读到路由（旧 client / API 直调）：先试全局默认模型，
        // 通道级错误再回落网关；网关也没装（无 key 的裸装）才报 unavailable。
        let firstError = null;
        const wrapped = async (t, key) => {
          const r = await sessionRunner(t, key, null);
          if (r && r.ok !== true && firstError === null) firstError = r.error;
          return r;
        };
        result = await optimize3(wrapped, text, { serial: serialVariants });
        if (result.ok !== true && (firstError === 'no-route' || firstError === 'no-llm')
          && typeof deps.optimize === 'function') {
          ctxWarn(deps, 'peak-whale: 默认模型通道不可用，optimize3 回落网关通道');
          result = await optimize3(deps.optimize, text, { serial: serialVariants });
        }
      } else {
        if (typeof deps.optimize !== 'function') {
          sendJson(response, 503, { ok: false, error: 'unavailable', message: '优化器没装上（Host 侧未就绪），也没配 webToken' });
          return;
        }
        result = await optimize3(deps.optimize, text, { serial: serialVariants });
      }
      sendJson(response, 200, result);
    } catch (error) {
      ctxWarn(deps, `optimize3 路由失败: ${error?.message ?? error}`);
      sendJson(response, 500, { ok: false, error: 'internal error', message: 'Host 侧出错了，看一眼 DSH 日志' });
    }
  };
}

/**
 * 诊断路由：`GET/POST /dsh-deepseek-peak-whale/api/diag`。
 *
 * 浏览器半身把「脚本执行 → 工厂物化 → apply → 每次挂载尝试」打点到这里。
 * 「重启后不自启、开关一下插件才有」这类只在真机开机瞬间发生的问题，
 * 没有这条通道就只能靠猜；有了它，重启一次就能看到确切的失败阶段。
 *
 * 有界（最多 60 条、每条 ≤300 字符）、同源、失败绝不影响主流程。
 */
export const DIAG_ROUTE = '/dsh-deepseek-peak-whale/api/diag';
/** 环形缓冲上限：够看清一次开机全过程，又不会被刷爆内存。 */
const DIAG_MAX = 60;
const diagRing = [];

/** 当前诊断环形缓冲（测试与命令用）。 */
export function diagEntries() {
  return diagRing.slice();
}

/** 清空诊断缓冲。 */
export function clearDiagEntries() {
  diagRing.length = 0;
}

export function createDiagHandler() {
  const MAX_BODY = 8 * 1024;
  return async function handle(request, response) {
    try {
      const method = request.method ?? 'GET';
      if (method === 'GET' || method === 'HEAD') {
        sendJson(response, 200, {
          ok: true,
          now: Date.now(),
          count: diagRing.length,
          entries: diagRing.slice(),
        });
        return;
      }
      if (method !== 'POST') {
        sendJson(response, 405, { ok: false, error: 'method not allowed' });
        return;
      }
      let body = '';
      let tooBig = false;
      if (request && typeof request[Symbol.asyncIterator] === 'function') {
        for await (const chunk of request) {
          body += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
          if (body.length > MAX_BODY) {
            tooBig = true;
            break;
          }
        }
      }
      if (tooBig) {
        sendJson(response, 413, { ok: false, error: 'too large' });
        return;
      }
      let parsed = null;
      try {
        parsed = body === '' ? {} : JSON.parse(body);
      } catch {
        parsed = null;
      }
      if (parsed === null || typeof parsed !== 'object') {
        sendJson(response, 400, { ok: false, error: 'bad-json' });
        return;
      }
      diagRing.push({
        at: Date.now(),
        phase: typeof parsed.phase === 'string' ? parsed.phase.slice(0, 40) : 'unknown',
        detail: typeof parsed.detail === 'string' ? parsed.detail.slice(0, 300) : '',
      });
      while (diagRing.length > DIAG_MAX) diagRing.shift();
      sendJson(response, 200, { ok: true, count: diagRing.length });
    } catch {
      try {
        sendJson(response, 500, { ok: false, error: 'internal error' });
      } catch { /* 连接已经没了 */ }
    }
  };
}

/**
 * 路由处理器：`GET/POST /dsh-deepseek-peak-whale/api/settings`。
 *
 * GET  → `{ ok: true, settings: { uiMode, optimizeEnabled, apiKeyConfigured } }`；
 * POST → body `{ uiMode?, optimizeEnabled? }`，白名单校验后原子写回 settings.json。
 * 任何路径都**不会**把 `deepseekApiKey` 送回浏览器——那是个连「是否配置」都只回布尔的字段。
 */
export function createSettingsHandler(deps) {
  const MAX_BODY = 16 * 1024;
  return async function handle(request, response) {
    try {
      const method = request.method ?? 'GET';
      const file = typeof deps?.settingsFile === 'string' && deps.settingsFile !== ''
        ? deps.settingsFile
        : null;
      if (file === null) {
        sendJson(response, 503, { ok: false, error: 'unavailable', message: '设置存储没就绪（Host 侧未初始化）' });
        return;
      }
      if (method === 'GET' || method === 'HEAD') {
        sendJson(response, 200, { ok: true, settings: readUiSettings(file) });
        return;
      }
      if (method !== 'POST') {
        sendJson(response, 405, { ok: false, error: 'method not allowed' });
        return;
      }
      let body = '';
      let tooBig = false;
      if (request && typeof request[Symbol.asyncIterator] === 'function') {
        for await (const chunk of request) {
          body += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
          if (body.length > MAX_BODY) {
            tooBig = true;
            break;
          }
        }
      }
      if (tooBig) {
        sendJson(response, 413, { ok: false, error: 'too large', message: '请求太大了（上限 16KB）' });
        return;
      }
      let parsed = null;
      try {
        parsed = body === '' ? {} : JSON.parse(body);
      } catch {
        parsed = null;
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        sendJson(response, 400, { ok: false, error: 'bad-json', message: 'body 必须是 JSON 对象' });
        return;
      }
      const result = writeUiSettings(file, parsed);
      sendJson(response, result.ok ? 200 : 400, result.ok
        ? { ok: true, settings: result.settings }
        : { ok: false, error: 'invalid', message: result.message });
    } catch (error) {
      ctxWarn(deps, `settings 路由失败: ${error?.message ?? error}`);
      sendJson(response, 500, { ok: false, error: 'internal error' });
    }
  };
}

/** 注册 `/price`、`/balance`、wallet 路由与记账监听。 */
export function apply(ctx, config = {}) {
  try {
    const log = (level, message) => {
      try {
        ctx?.logger?.[level]?.(message);
      } catch { /* logger 不可用 */ }
    };

    // ── 账本：先建起来，记账和命令都靠它 ─────────────────────────────────────
    // `config.ledgerFile` 是测试用的落点覆盖；不给就按 profile 存到 $DSH_HOME 下。
    const file = typeof config?.ledgerFile === 'string' && config.ledgerFile !== ''
      ? config.ledgerFile
      : ledgerFile(profileNameOf(ctx));
    let ledger = null;
    try {
      ledger = createLedger({ file, log: (m) => log('warn', m) });
    } catch (error) {
      log('warn', `peak-whale: 账本初始化失败（${error?.message ?? error}），今日费用将只在内存中`);
      try {
        ledger = createLedger({ log: (m) => log('warn', m) });
      } catch {
        ledger = null;
      }
    }

    // ── 官方余额快照：今日消费的唯一数据源 ──────────────────────────────────
    // 消费 = 当天官方余额的下降量累计。采样器每 5 分钟读一次余额接口，
    // 界面每次拉取 `/api/wallet` 也会顺手记一次（UI 开着时密度自然更高）。
    const officialPath = typeof config?.officialFile === 'string' && config.officialFile !== ''
      ? config.officialFile
      : officialFile(profileNameOf(ctx));
    let official = null;
    try {
      official = createOfficialTracker({ file: officialPath, log: (m) => log('warn', m) });
    } catch (error) {
      log('warn', `peak-whale: 官方快照初始化失败（${error?.message ?? error}），今日消费将只在内存中`);
      try {
        official = createOfficialTracker({ log: (m) => log('warn', m) });
      } catch {
        official = null;
      }
    }

    // ── 取 Host 服务的统一入口 ──────────────────────────────────────────────
    // 开机时服务可能还没就绪：老式的 ctx.get() 只会**静默拿到 undefined**，
    // 于是路由一条都注册不上（症状：重启后全 404，重新挂载一次又好了）。
    // 所以 Host 接线走「立即试一次 + 指数退避重试」，见下面的 mountHost。
    const serviceOf = (key) => {
      try {
        return typeof ctx?.get === 'function' ? ctx.get(key) : ctx?.[key];
      } catch {
        return undefined;
      }
    };
    const profile = profileNameOf(ctx);

    // ── 提示词优化器：key 在 settings.json（缺了就自动补一份模板） ──────────
    const settingsFile = typeof config?.settingsFile === 'string' && config.settingsFile !== ''
      ? config.settingsFile
      : optimizeSettingsFile();
    let optimize = null;
    try {
      if (ensureSettingsFile(settingsFile)) {
        log('info', `peak-whale: 已创建配置模板 ${settingsFile} —— 把 DeepSeek API key 填进 deepseekApiKey`);
      }
      // 优化器的 log 约定是 (message, level?)：完成/用量这类流水走 info，
      // 失败没给级别时仍落 warn——不能让一条成功日志把告警级别带偏。
      optimize = createOptimizeRunner({
        file: settingsFile,
        log: (m, level) => log(level === 'info' ? 'info' : 'warn', m),
      });
    } catch (error) {
      log('warn', `peak-whale: 提示词优化器初始化失败（${error?.message ?? error}）`);
      optimize = null;
    }

    // ── 会话同路由优化通道：借 ctx.llm（与会话共用适配器与凭据）──────────
    // serviceOf 传的是「取值函数」而非当前值：llm / agentDefaultModel 都可能
    // 晚于本插件就绪，每次优化请求现取，取不到由 runner 报 no-llm/no-route
    // 并在路由层回落网关通道——不会因为服务时序把功能永久判死。
    let sessionRunner = null;
    try {
      sessionRunner = createSessionRouteRunner({
        file: settingsFile,
        llm: () => serviceOf('llm'),
        fallbackRoute: () => {
          try {
            const adm = serviceOf('agentDefaultModel');
            const sel = typeof adm?.currentSelection === 'function' ? adm.currentSelection() : null;
            return sel ?? null;
          } catch {
            return null;
          }
        },
        log: (m, level) => log(level === 'info' ? 'info' : 'warn', m),
      });
    } catch (error) {
      log('warn', `peak-whale: 会话路由优化器初始化失败（${error?.message ?? error}）`);
      sessionRunner = null;
    }

    // ── 先撤掉上一次自己注册的东西：热重载幂等，避免同名重复注册 ────────────
    while (ownDisposers.length > 0) {
      const off = ownDisposers.pop();
      try {
        off();
      } catch { /* 旧的已经没了也无所谓 */ }
    }
    /** 本轮注册的撤销函数（卸载时按它们清场）。 */
    const disposers = [];
    /** 收下一个撤销函数：包成幂等的（被撤两次也不会炸）。 */
    const keep = (off, label) => {
      if (typeof off !== 'function') return;
      let done = false;
      disposers.push(() => {
        if (done) return;
        done = true;
        try {
          off();
        } catch (error) {
          log('warn', `peak-whale: 撤销 ${label} 失败（${error?.message ?? error}）`);
        }
      });
    };

    // ── 记账：会话事件流（失败只记一次日志，绝不冒泡） ──────────────────────
    if (typeof ctx?.on === 'function') {
      const onEvent = (session, event) => {
        if (!ledger) return;
        try {
          const id = typeof session?.id === 'string' ? session.id : String(session?.id ?? '');
          if (id === '') return;
          ledger.observe(id, event);
        } catch (error) {
          log('warn', `peak-whale: 记账监听异常（${error?.message ?? error}）`);
        }
      };
      try {
        keep(ctx.on('session/event', onEvent), '记账监听');
      } catch (error) {
        log('warn', `peak-whale: 记账监听注册失败（${error?.message ?? error}）`);
      }
    }

    // 本轮（记账监听）清单交给下一次 apply（或卸载时的 effect）
    ownDisposers = disposers;
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => () => {
        while (disposers.length > 0) {
          const off = disposers.pop();
          off();
        }
      }, 'peak-whale: ledger listener');
    }

    // ── 官方余额直读：用 settings 里的 API key 打 /user/balance（见 src/official.js）──
    // 定义在外层，/balance 命令与 wallet 路由**共用同一份**；读不到 key / 接口失败都
    // 回落账户服务的余额，绝不抛。原来它只生在 wireRoutes 闭包里，/balance 命令拿不到
    // → ReferenceError → 命令永远只回「余额查询失败」（真 bug，已修）。
    const officialBalance = async () => {
      try {
        const s = readSettings(settingsFile);
        if (s.apiKey === '') return { status: 'failed' };
        return await fetchOfficialBalance({
          apiKey: s.apiKey,
          baseUrl: s.baseUrl,
          log: (m) => log('warn', m),
        });
      } catch {
        return { status: 'failed' };
      }
    };

    // ── Host 接线：webServer 路由 + 命令 ────────────────────────────────────
    /**
     * 注册 /price 与 /balance 两条命令。**命令不依赖 webServer**，只依赖
     * commands 与 deepseekAccount；服务没就绪就先返回 false，交给下面的
     * 退避重试再调。重挂前先撤掉自己上一次注册的（幂等）。
     */
    const registerCommands = () => {
      const service = serviceOf('commands') ?? ctx?.commands;
      if (service === undefined || typeof service.register !== 'function') {
        log('warn', 'peak-whale: commands 服务还没就绪，稍后自动重试');
        return false;
      }
      while (ownCommandDisposers.length > 0) {
        const off = ownCommandDisposers.pop();
        try {
          off();
        } catch { /* 旧的已经没了也无所谓 */ }
      }
      // 传**解析函数**而不是服务本体：开机时 deepseekAccount 可能还没注册，
      // 抓一次就会把「此刻没拿到」永久当成「没有账户服务」（余额从此消失）。
      const reader = createAccountReader(() => serviceOf('deepseekAccount'), {});
      const keepCmd = (off) => {
        if (typeof off !== 'function') return;
        let done = false;
        ownCommandDisposers.push(() => {
          if (done) return;
          done = true;
          try {
            off();
          } catch { /* 忽略 */ }
        });
      };
      /** 注册一条命令；重名之类的问题只告警，不带崩整个挂载。 */
      const addCommand = (definition) => {
        try {
          keepCmd(service.register(definition));
        } catch (error) {
          log('warn', `peak-whale: /${definition.name} 注册失败（${error?.message ?? error}）`);
        }
      };
      addCommand({
        name: 'price',
        description: '显示 DeepSeek 当前峰谷时段、距半价倒计时与官方价格表',
        handler: () => ({ kind: 'success', text: buildReport(new Date()) }),
      });
      addCommand({
        name: 'balance',
        description: '显示 DeepSeek 账户余额与今日消费（余额与消费都取自官方账户读数）',
        handler: async () => {
          try {
            const payload = await buildWalletPayload({ reader, ledger, official, officialBalance, profile });
            return { kind: 'success', text: buildBalanceReport(payload) };
          } catch (error) {
            return { kind: 'success', text: `余额查询失败：${error?.message ?? error}` };
          }
        },
      });
      log('info', 'peak-whale: /price 与 /balance 命令已注册');
      return true;
    };

    /**
     * 把 wallet / settings / optimize 三条路由挂到**一个 webServer 实例**上。
     * 每次挂载前先撤掉自己上一次注册的（幂等，热重载与重试都安全）。
     * 返回撤销函数。
     */
    const wireRoutes = (webServer) => {
      if (!webServer || typeof webServer.register !== 'function') return () => {};
      while (ownHostDisposers.length > 0) {
        const off = ownHostDisposers.pop();
        try {
          off();
        } catch { /* 旧的已经没了也无所谓 */ }
      }
      const offs = [];
      const keepHost = (off, label) => {
        if (typeof off !== 'function') return;
        let done = false;
        offs.push(() => {
          if (done) return;
          done = true;
          try {
            off();
          } catch (error) {
            log('warn', `peak-whale: 撤销 ${label} 失败（${error?.message ?? error}）`);
          }
        });
      };
      /**
       * 注册一条路由。**一条失败不能把后面的注册全带走**——热重载时最容易在这里炸，
       * 结果是「余额、今日费用、提示词优化同时消失」，而插件仍显示已启用。
       */
      const addRoute = (path, handler, label) => {
        try {
          keepHost(webServer.register({ kind: 'exact', path, handler }), label);
          log('info', `peak-whale: ${label}已注册（${path}）`);
        } catch (error) {
          log('warn', `peak-whale: ${label}注册失败（${error?.message ?? error}）`);
        }
      };
      // 传**解析函数**而不是服务本体：开机时 deepseekAccount 可能还没注册，
      // 抓一次就会把「此刻没拿到」永久当成「没有账户服务」（余额从此消失）。
      const reader = createAccountReader(() => serviceOf('deepseekAccount'), {});
      // officialBalance 已在外层定义（/balance 命令与这里共用），不再重复。
      addRoute(
        WALLET_ROUTE,
        createWalletHandler({ reader, ledger, official, officialBalance, profile, settingsFile, log: (m) => log('warn', m) }),
        'wallet 路由',
      );
      // 导出账本路由
      addRoute(
        WALLET_EXPORT_ROUTE,
        createWalletExportHandler({ ledger, log: (m) => log('warn', m) }),
        '账本导出路由',
      );
      // 设置路由不依赖优化器装没装上：模式与开关随时可读写。
      addRoute(
        SETTINGS_ROUTE,
        createSettingsHandler({ settingsFile, log: (m) => log('warn', m) }),
        '设置路由',
      );
      // 诊断路由：浏览器半身的开机打点落点（有界环形缓冲，随时可读）。
      addRoute(DIAG_ROUTE, createDiagHandler(), '诊断路由');
      if (optimize) {
        addRoute(
          OPTIMIZE_ROUTE,
          createOptimizeHandler({ optimize, sessionRunner, log: (m) => log('warn', m) }),
          '提示词优化路由',
        );
      }
      // optimize3 可以走 webToken（网页端对话，不需要 API key），所以总是注册。
      // WASM 缓存放在 settings.json 同目录下。
      addRoute(
        OPTIMIZE3_ROUTE,
        createOptimize3Handler({
          optimize,
          sessionRunner,
          settingsFile,
          wasmPath: path.join(path.dirname(settingsFile), 'sha3_wasm_bg.wasm'),
          log: (m) => log('warn', m),
        }),
        '三版提示词优化路由',
      );
      ownHostDisposers = offs;
      return () => {
        while (offs.length > 0) {
          const off = offs.pop();
          off();
        }
      };
    };

    /**
     * 首选路径：`ctx.inject(['webServer'], …)`。
     *
     * 开机竞态的正确解药是 inject 而不是重试：inject 会在服务**就绪后**回调、
     * 热重载时自动重挂、由 host.effect 管好卸载（与内置插件 dsh-plugin 的
     * `ctx.inject(['webServer'], host => host.effect(…))` 同一契约）。
     * 实测教训（2026-10-06）：ctx.get('webServer') 在开机瞬间会拿到一个
     * **还没接管端口的内置 server**——register 成功、路由却不服务 19387，
     * 而 mountHost 一旦「成功」就不会再重试，重启后就是全 404 的死局。
     */
    let routesWired = false;
    if (typeof ctx?.inject === 'function') {
      try {
        ctx.inject(['webServer'], (host) => {
          const webServer = host?.webServer;
          if (typeof host?.effect === 'function') {
            host.effect(() => {
              if (!webServer || typeof webServer.register !== 'function') return () => {};
              return wireRoutes(webServer);
            }, 'peak-whale: http routes (inject)');
          } else if (webServer && typeof webServer.register === 'function') {
            wireRoutes(webServer);
          }
        });
        routesWired = true;
        log('info', 'peak-whale: 路由走 inject([webServer]) 挂载');
      } catch (error) {
        log('warn', `peak-whale: inject(['webServer']) 不可用（${error?.message ?? error}），退回 ctx.get + 退避重试`);
        routesWired = false;
      }
    }

    /** 回退路径（无 inject 的环境 / 测试桩）：ctx.get + 退避重试。 */
    const mountHostFallback = () => {
      const webServer = serviceOf('webServer');
      if (webServer === undefined || typeof webServer.register !== 'function') {
        log('warn', 'peak-whale: webServer 服务还没就绪，稍后自动重试');
        return false;
      }
      const off = wireRoutes(webServer);
      if (typeof ctx.effect === 'function') {
        ctx.effect(() => off, 'peak-whale: http routes');
      }
      return true;
    };

    // 立即试一次（回退路径）；没就绪就按 2s→5s→15s→60s→120s→300s 退避重试，
    // 路由与命令各自独立补挂，卸载时把排队中的重试取消（effect 清理）。
    if (!routesWired) routesWired = mountHostFallback();
    let commandsDone = registerCommands();
    const retryUntil = (label, isDone, attempt) => {
      if (typeof ctx?.effect !== 'function') return;
      const delays = [2000, 5000, 15000, 60000, 120000, 300000];
      let step = 0;
      let timer = null;
      const clearTimer = () => {
        if (timer === null) return;
        try {
          const clearFn = typeof ctx?.clearTimeout === 'function' ? ctx.clearTimeout : clearTimeout;
          clearFn(timer);
        } catch { /* 忽略 */ }
        timer = null;
      };
      const schedule = () => {
        if (isDone() || step >= delays.length) return;
        const delay = delays[step];
        step += 1;
        const setFn = typeof ctx?.setTimeout === 'function' ? ctx.setTimeout : setTimeout;
        timer = setFn(() => {
          timer = null;
          attempt();
          if (!isDone()) schedule();
        }, delay);
      };
      schedule();
      ctx.effect(() => clearTimer, `peak-whale: ${label} retry`);
    };
    if (!routesWired) retryUntil('routes', () => routesWired, () => {
      routesWired = mountHostFallback();
    });
    if (!commandsDone) retryUntil('commands', () => commandsDone, () => {
      commandsDone = registerCommands();
    });
  } catch (error) {
    try {
      ctx?.logger?.warn?.(
        `peak-whale: 注册失败: ${error instanceof Error ? error.message : String(error)}`,
      );
    } catch { /* 连日志都不能记就算了 */ }
  }
}
