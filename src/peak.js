/**
 * DeepSeek 峰谷计价 —— 单一事实来源。
 *
 * 本文件同时被两处使用：
 *   1. Host 半身 `index.js`（直接 ESM import，供 `/price` 命令使用）
 *   2. Client 半身 `client.js`（由 `build.mjs` 去掉 `export` 前缀后内联进浏览器 bundle）
 * 因此两端的判定逻辑**同源**，不存在漂移。不要手写第二份副本。
 *
 * ── 官方规则（https://api-docs.deepseek.com/zh-cn/quick_start/pricing）─────────
 *   · 峰时（PEAK）：UTC 01:00–04:00 与 06:00–10:00，**周一至周五**，
 *                   且**排除中国法定节假日**。
 *                   （换算到北京时间即 09:00–12:00 与 14:00–18:00）
 *   · 谷时（OFF-PEAK）：其余全部时段，**价格恰为峰时的一半**。
 *                   官方原文：all other hours are off-peak, including weekends
 *                   and Chinese public holidays **in full**。
 *   · 价格单位：**人民币（元）/ 每 100 万 tokens**。
 *
 * ── 为什么用人民币而不是美元 ──────────────────────────────────────────────────
 *   官方中英文定价页各有一套独立牌价，**不是同一组数字换汇**：
 *     缓存命中 Flash ¥0.02 ↔ $0.003（隐含 6.67）、V4-Pro ¥0.15 ↔ $0.022（隐含 6.82）。
 *   两个隐含汇率并不相等，说明「人民币价 ÷ 某汇率 = 美元价」这条路本身就是错的。
 *   既然目标用户看的是人民币账户（余额接口返回的就是 CNY），就**直接采用官方人民币牌价**，
 *   不做任何汇率换算——换算只会引入一层无法自证的误差。
 *
 * ── 关于周末与调休 ────────────────────────────────────────────────────────────
 *   官方明确「周末整天都算谷时」，因此调休上班的周六/周日（如 2026-05-09）**仍是谷时**，
 *   本实现据此只判断「是否周末」和「是否法定节假日」，不处理调休上班日。
 *
 * ── 关于节假日表的时效 ────────────────────────────────────────────────────────
 *   HOLIDAYS 内置的是国务院办公厅《关于 2026 年部分节假日安排的通知》
 *   （国办发明电〔2025〕7 号，2025-11-04）的日期。**跨年后必须更新**，
 *   否则元旦至春节前的判定会偏严（把假期误判成高峰日）。
 */

/** 官方定价页中文入口（**人民币牌价以此为准**）。 */
export const PRICING_URL_CN = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing';

/** 官方定价页英文入口（美元牌价，仅供对照）。 */
export const PRICING_URL = 'https://api-docs.deepseek.com/quick_start/pricing';

/** 本表数据的抓取日期（用于界面标注「数据时间」）。 */
export const PRICING_AS_OF = '2026-10-03';

/**
 * 峰时窗口，按 **UTC 当日的分钟数**表示（起始含、结束不含）。
 * `beijing` 仅供界面展示。
 */
export const PEAK_UTC_WINDOWS = [
  { start: 60, end: 240, beijing: '09:00–12:00' }, // UTC 01:00–04:00
  { start: 360, end: 600, beijing: '14:00–18:00' }, // UTC 06:00–10:00
];

/**
 * 官方在售模型与价格（**人民币元 / 100 万 tokens**，取自官方中文定价页）。
 * `off` = 谷时价，`peak` = 峰时价；官方保证 `off === peak / 2`。
 * 该不变量由 test/peak.test.mjs 断言。
 *
 * 官方原表（元 / 百万 tokens）：
 *   Flash  缓存命中 0.02 / 0.04，缓存未命中 1 / 2，输出 4 / 8
 *   V4-Pro 缓存命中 0.15 / 0.30，缓存未命中 4.5 / 9，输出 13.5 / 27
 */
export const MODELS = [
  {
    id: 'deepseek-flash',
    name: 'DeepSeek-Flash',
    short: 'Flash',
    version: 'DeepSeek-V4.1-Flash',
    cacheHit: { off: 0.02, peak: 0.04 },
    cacheMiss: { off: 1, peak: 2 },
    output: { off: 4, peak: 8 },
  },
  {
    id: 'deepseek-v4-pro',
    name: 'DeepSeek-V4-Pro',
    short: 'V4-Pro',
    version: 'DeepSeek-V4-Pro-0813',
    cacheHit: { off: 0.15, peak: 0.3 },
    cacheMiss: { off: 4.5, peak: 9 },
    output: { off: 13.5, peak: 27 },
  },
];

/**
 * 中国法定节假日。
 * 日期为**北京时间自然日**，闭区间；`name` 用于界面徽标。
 * 2026 年：国务院办公厅 国办发明电〔2025〕7 号。
 *   元旦 1/1–1/3、春节 2/15–2/23、清明 4/4–4/6、劳动节 5/1–5/5、
 *   端午 6/19–6/21、中秋 9/25–9/27、国庆 10/1–10/7。
 * 2027 年：⚠ 按农历推算（2027 春节 = 2/6、端午 = 6/9、中秋 = 9/15），
 *   国务院办公厅通知通常于前一年 11 月公布，届时需以官方通知为准。
 *   元旦 1/1–1/3、春节 2/5–2/12、清明 4/3–4/5、劳动节 5/1–5/5、
 *   端午 6/9–6/11、中秋 9/15–9/17、国庆 10/1–10/7。
 */
export const HOLIDAYS = [
  { start: '2026-01-01', end: '2026-01-03', name: '元旦' },
  { start: '2026-02-15', end: '2026-02-23', name: '春节' },
  { start: '2026-04-04', end: '2026-04-06', name: '清明节' },
  { start: '2026-05-01', end: '2026-05-05', name: '劳动节' },
  { start: '2026-06-19', end: '2026-06-21', name: '端午节' },
  { start: '2026-09-25', end: '2026-09-27', name: '中秋节' },
  { start: '2026-10-01', end: '2026-10-07', name: '国庆节' },
  { start: '2027-01-01', end: '2027-01-03', name: '元旦' },
  { start: '2027-02-05', end: '2027-02-12', name: '春节' },
  { start: '2027-04-03', end: '2027-04-05', name: '清明节' },
  { start: '2027-05-01', end: '2027-05-05', name: '劳动节' },
  { start: '2027-06-09', end: '2027-06-11', name: '端午节' },
  { start: '2027-09-15', end: '2027-09-17', name: '中秋节' },
  { start: '2027-10-01', end: '2027-10-07', name: '国庆节' },
];

/** 北京时间的固定 UTC 偏移（毫秒）。中国自 1991 年起不实行夏令时。 */
export const BEIJING_OFFSET_MS = 8 * 3600 * 1000;

const MINUTE_MS = 60000;
/** 扫描边界的上限：12 天。谷时最长的一段（春节 + 周末叠加）也不会超过它。 */
const SCAN_LIMIT_MINUTES = 12 * 24 * 60;

/** 补零到两位。 */
function pad2(value) {
  return String(value).padStart(2, '0');
}

/** 取北京时间各字段（不依赖浏览器/系统时区）。 */
export function beijingParts(date) {
  const shifted = new Date(date.getTime() + BEIJING_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    weekday: shifted.getUTCDay(), // 0=周日 … 6=周六
    hours: shifted.getUTCHours(),
    minutes: shifted.getUTCMinutes(),
    seconds: shifted.getUTCSeconds(),
  };
}

/** 北京时间日期键 `YYYY-MM-DD`，用于与节假日表比较。 */
export function beijingDateKey(date) {
  const p = beijingParts(date);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

/** 北京时间星期（0=周日 … 6=周六）。 */
export function beijingWeekday(date) {
  return beijingParts(date).weekday;
}

/** 是否周末（北京时间周六/周日）。 */
export function isWeekend(date) {
  const weekday = beijingWeekday(date);
  return weekday === 0 || weekday === 6;
}

/** 命中法定节假日则返回该条目，否则 null。 */
export function holidayAt(date) {
  const key = beijingDateKey(date);
  for (const holiday of HOLIDAYS) {
    if (key >= holiday.start && key <= holiday.end) return holiday;
  }
  return null;
}

/** UTC 当日分钟数（含秒的小数部分）。官方峰谷窗口就是按 UTC 定义的。 */
export function utcMinutesOfDay(date) {
  return date.getUTCHours() * 60 + date.getUTCMinutes() + date.getUTCSeconds() / 60;
}

/**
 * 判定某一时刻处于峰时还是谷时。
 *
 * 优先级：节假日 → 周末 → 峰时窗口 → 其余谷时。
 * 官方措辞是「周末和节假日整天都算谷时」，所以节假日/周末即便落在峰时窗口内也判为谷时。
 *
 * @returns {{ period: 'peak'|'offpeak', isPeak: boolean, reason: string,
 *             holiday: object|null, isWeekend: boolean, isHoliday: boolean,
 *             utcMinutes: number }}
 */
export function periodAt(date) {
  const weekend = isWeekend(date);
  const holiday = holidayAt(date);
  const minutes = utcMinutesOfDay(date);
  const inPeakWindow = PEAK_UTC_WINDOWS.some((w) => minutes >= w.start && minutes < w.end);

  let period = 'offpeak';
  let reason = 'off-hours';
  if (holiday) {
    reason = 'holiday';
  } else if (weekend) {
    reason = 'weekend';
  } else if (inPeakWindow) {
    period = 'peak';
    reason = 'peak-window';
  }

  return {
    period,
    isPeak: period === 'peak',
    reason,
    holiday,
    isWeekend: weekend,
    isHoliday: holiday !== null,
    utcMinutes: minutes,
  };
}

/** 该时刻的价格倍率：峰时 1，谷时 0.5。 */
export function multiplierAt(date) {
  return periodAt(date).isPeak ? 1 : 0.5;
}

/** 向下对齐到整分钟。 */
function alignDownToMinute(ms) {
  return Math.floor(ms / MINUTE_MS) * MINUTE_MS;
}

/**
 * 下一个时段切换点。
 *
 * 逐分钟前扫（上限 12 天）直到时段翻转。窗口是左闭右开，因此翻转那一分钟的
 * `periodAt` 已经属于新时段——返回的就是切换发生的精确时刻。
 */
export function nextBoundary(date) {
  const current = periodAt(date).period;
  const start = alignDownToMinute(date.getTime()) + MINUTE_MS;
  for (let i = 0; i < SCAN_LIMIT_MINUTES; i += 1) {
    const at = start + i * MINUTE_MS;
    if (periodAt(new Date(at)).period !== current) return new Date(at);
  }
  return null;
}

/**
 * 当前时段的起点（上一个切换点）。用于画进度条。
 *
 * 向后扫：找到第一个与当前时段不同的分钟 `t`，真正的边界是 `t + 1min`
 * （因为 `periodAt(t)` 已经是旧时段，边界在它之后一分钟）。
 */
export function previousBoundary(date) {
  const current = periodAt(date).period;
  const start = alignDownToMinute(date.getTime());
  for (let i = 0; i < SCAN_LIMIT_MINUTES; i += 1) {
    const at = start - i * MINUTE_MS;
    if (periodAt(new Date(at)).period !== current) return new Date(at + MINUTE_MS);
  }
  return null;
}

/**
 * 界面所需的全部派生状态。
 *
 * @returns 聚合对象，含 period/reason/holiday、下一起点 `next`、上一`prev`、
 *          剩余分钟 `minutesLeft`、当前时段进度 `progress`、以及
 *          是否半价 `isHalfPrice`、下一次是否为峰时 `nextIsPeak`。
 */
export function summary(date) {
  const state = periodAt(date);
  const next = nextBoundary(date);
  const prev = previousBoundary(date);
  const minutesLeft = next === null ? null : (next.getTime() - date.getTime()) / MINUTE_MS;
  const span = next !== null && prev !== null ? next.getTime() - prev.getTime() : null;
  const elapsed = prev === null ? null : date.getTime() - prev.getTime();
  const nextState = next === null ? null : periodAt(next);

  return {
    ...state,
    next,
    prev,
    nextState,
    minutesLeft,
    progress: span === null || elapsed === null ? null : Math.min(1, Math.max(0, elapsed / span)),
    isHalfPrice: !state.isPeak,
    nextIsPeak: nextState === null ? null : nextState.isPeak,
    beijingKey: beijingDateKey(date),
  };
}

/** 把分钟数格式化成「3 小时 12 分」。 */
export function formatDuration(minutes) {
  if (minutes === null || minutes === undefined) return '—';
  const total = Math.max(0, Math.round(minutes));
  const hours = Math.floor(total / 60);
  const mins = total % 60;
  if (hours <= 0) return `${mins} 分`;
  if (mins === 0) return `${hours} 小时`;
  return `${hours} 小时 ${mins} 分`;
}

/** 紧凑时长（`3h12m` 风格）。 */
export function formatDurationShort(minutes) {
  if (minutes === null || minutes === undefined) return '—';
  const total = Math.max(0, Math.round(minutes));
  const hours = Math.floor(total / 60);
  const mins = total % 60;
  if (hours <= 0) return `${mins}分`;
  if (mins === 0) return `${hours}小时`;
  return `${hours}小时${mins}分`;
}

/** 北京时间的 `HH:MM`。 */
export function formatClock(date) {
  const p = beijingParts(date);
  return `${pad2(p.hours)}:${pad2(p.minutes)}`;
}

/** 北京时间的完整时间戳。 */
export function formatBeijingFull(date) {
  const p = beijingParts(date);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)} ${pad2(p.hours)}:${pad2(p.minutes)}:${pad2(p.seconds)}`;
}

/** 星期中文名，索引 0=周日。 */
export const WEEKDAY_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/**
 * 切换点的可读文案：当天只给时间，跨天补「周X」。
 */
export function boundaryLabel(date, boundary) {
  if (boundary === null) return '—';
  const time = formatClock(boundary);
  const todayKey = beijingDateKey(date);
  const targetKey = beijingDateKey(boundary);
  if (todayKey === targetKey) return time;
  return `${WEEKDAY_CN[beijingWeekday(boundary)]} ${time}`;
}

/**
 * 把时段状态翻译成界面文案。
 *
 * @returns {{ title: string, note: string, tone: 'off'|'peak' }}
 */
export function describePeriod(state) {
  if (state.isPeak) {
    return { title: '峰时 · 全价', note: '工作日高峰时段，价格是全价的 2 倍', tone: 'peak' };
  }
  if (state.reason === 'holiday' && state.holiday) {
    return { title: '谷时 · 半价', note: `${state.holiday.name}假期全天半价`, tone: 'off' };
  }
  if (state.reason === 'weekend') {
    return { title: '谷时 · 半价', note: '整个周末都算谷时，全天半价', tone: 'off' };
  }
  return { title: '谷时 · 半价', note: '当前不在高峰时段，价格减半', tone: 'off' };
}

/** 取某模型某个价目项的当前价格。 */
export function priceOf(model, kind, isPeak) {
  const bucket = model[kind];
  if (!bucket) return null;
  return isPeak ? bucket.peak : bucket.off;
}

/**
 * 牌价格式化（价格表用）：**固定小数位**，不足 1 元的给 3 位、其余 2 位。
 *
 * 价格表是同列上下比大小的地方，位数必须整齐（`¥0.020 / ¥0.040`、`¥4.50 / ¥27.00`），
 * 所以这里**不做**「掐掉末尾 0」那种美化——那会让同一列的小数点错开。
 * 官方最低档 ¥0.02 用 3 位表示成 ¥0.020，既保住精度又不丢对齐。
 */
export function formatCny(value) {
  if (value === null || value === undefined) return '—';
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return '—';
  return `¥${n < 1 ? n.toFixed(3) : n.toFixed(2)}`;
}

/**
 * 把定点小数字符串的末尾 0 去掉，但**至少保留 `minDec` 位**。
 * `0.500`→`0.50`（钱不该写成 ¥0.5）、`0.042`→`0.042`（信息不许丢）。
 */
function trimZeros(text, minDec) {
  const [int, dec = ''] = text.split('.');
  let kept = dec.replace(/0+$/, '');
  if (kept.length < minDec) kept = dec.slice(0, minDec);
  return kept === '' ? int : `${int}.${kept}`;
}

/** 把可能是字符串/undefined 的 token 数读成非负安全整数。 */
function tokenCount(value) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}

/**
 * 把一条路由 (provider, model) 解析成价格表条目。
 *
 * 只认 DeepSeek 路由：别的厂商不走 DeepSeek 的钱包，按本表计价只会算出一个
 * 没有账户对应的数字，所以直接返回 `null`（调用方据此把该笔用量排除在账外）。
 *
 * 型号判定只看 `model`：含 `pro` 归 V4-Pro，其余归 Flash。拿不准的 DeepSeek
 * 型号**回落到 Flash** —— 宁可低估，也不编一个官方没公布过的价格。
 *
 * @param {string|null|undefined} provider - 请求路由的 provider id。
 * @param {string|null|undefined} model - 请求路由的 model id。
 * @returns {object|null} MODELS 里的条目；非 DeepSeek 路由为 null。
 */
export function resolveModel(provider, model) {
  const id = `${provider ?? ''} ${model ?? ''}`.toLowerCase();
  if (!id.includes('deepseek')) return null;
  const name = `${model ?? ''}`.toLowerCase();
  const target = name.includes('pro') ? 'deepseek-v4-pro' : 'deepseek-flash';
  return MODELS.find((entry) => entry.id === target) ?? MODELS[0] ?? null;
}

/**
 * 按官方牌价估算一笔用量的**人民币**成本。
 *
 * 四个计费桶与 DeepSeek 账单的口径一致（与 DSH 自带的 `tokenUsage` 投影相同）：
 *   · `uncachedInputTokens` —— 未命中缓存的输入，按「输入·未命中」计；
 *   · `cacheReadTokens`     —— 缓存命中，按「输入·命中」计；
 *   · `cacheWriteTokens`    —— 写缓存按普通输入计（官方只公布命中折扣，
 *                              没有单独的写入溢价，官方账单亦如此处理）；
 *   · `outputTokens`        —— 输出，按「输出」计（推理 token 已含在内）。
 *
 * 峰/谷档由 `at` 那一刻判定，所以跨时段的一天会自动按各时刻的档位分别计价。
 *
 * @param {object} buckets - 四个 token 桶（缺省按 0）。
 * @param {{provider?: string, model?: string}} route - 计费路由。
 * @param {Date|number} at - 该笔用量发生的时刻。
 * @returns {number|null} 人民币成本（元）；非 DeepSeek 路由返回 null。
 */
export function costCny(buckets, route, at) {
  const model = resolveModel(route?.provider, route?.model);
  if (model === null) return null;
  const date = at instanceof Date ? at : new Date(at);
  const isPeak = periodAt(date).isPeak;
  const uncached = tokenCount(buckets?.uncachedInputTokens);
  const read = tokenCount(buckets?.cacheReadTokens);
  const write = tokenCount(buckets?.cacheWriteTokens);
  const output = tokenCount(buckets?.outputTokens);
  return (
    (uncached * priceOf(model, 'cacheMiss', isPeak)
      + read * priceOf(model, 'cacheHit', isPeak)
      + write * priceOf(model, 'cacheMiss', isPeak)
      + output * priceOf(model, 'output', isPeak)
    ) / 1e6
  );
}

/**
 * 金额格式化（余额 / 当日费用共用，Host 与浏览器同源）。
 *
 * 余额是十进制字符串，可能精确到 4 位以上；≥1 显示 2 位（看得出多少），
 * <1 显示 4 位（0.0037 这种余额不能被四舍五入成 0.00）。
 *
 * @param {string|number|null|undefined} value - 金额。
 * @param {string} [currency] - `CNY` 用 ¥，其余用 $。
 * @returns {string}
 */
export function formatMoney(value, currency) {
  const symbol = currency === 'CNY' ? '¥' : '$';
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return `${symbol}—`;
  return `${symbol}${Math.abs(n) >= 1 ? n.toFixed(2) : n.toFixed(4)}`;
}

/**
 * 当日费用的格式化（**人民币**，与牌价、余额币种一致）。
 *
 * 金额越小给越多位小数，否则一整天的用量会被显示成 `¥0.00`；给够位数后
 * **掐掉末尾多余的 0**，但至少留 2 位（`¥4.69` / `¥0.042`），钱不写成 `¥0.5`。
 *
 * 位数比美元版收紧一档：官方谷时最低档是 ¥0.02/百万 tokens，
 * 「一天花几分钱」在人民币量级下几乎不会出现，不必留到 5 位小数。
 */
export function formatCnyAmount(value) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return '¥—';
  if (n === 0) return '¥0.00';
  if (n >= 1) return `¥${n.toFixed(2)}`;
  if (n >= 0.01) return `¥${trimZeros(n.toFixed(3), 2)}`;
  return `¥${trimZeros(n.toFixed(4), 2)}`;
}

/** token 计数的紧凑写法：950 / 12.4k / 128k / 1.28M。 */
export function formatTokens(value) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n < 1000) return String(Math.round(n));
  if (n < 1e6) {
    const k = n / 1e3;
    const text = k < 100 ? k.toFixed(1) : k.toFixed(0);
    return `${text.replace(/\.0$/, '')}k`;
  }
  return `${(n / 1e6).toFixed(2)}M`;
}


