/**
 * dsh-deepseek-peak-whale —— 浏览器半身【模板】
 *
 * 这是**模板**，不是最终产物：`client.js` 由 `build.mjs` 注入下面两组标记之间的内容生成
 *   1. `src/peak.js`           —— 峰谷判定核心（与 Host 半身同源）
 *   2. `vendor/pet-runtime.js` —— Coopanion 鲸鱼桌宠运行时（AGPL-3.0：
 *                                 Live2D 式 WebGL2 分件模型 + 物理/动作/表情控制器），
 *                                 连同 50 张贴图的 data URI 与侧栏图标一起注入。
 * 要改请改这两个源文件，然后跑 `node build.mjs`。
 *
 * 本半身提供两个挂载点：
 *   · `sidebar.footer.action` —— 侧栏脚部的价格状态条（一眼看出是否半价）
 *   · `shell.overlay`         —— 全屏浮层里的鲸鱼娘桌宠：
 *                                自由漫游、拎起拖动、抛出、摸头、说话（价格台词）。
 *   本组件只负责**接线**（指针事件、命中区跟随、台词与气泡、右键菜单、亲密度）；
 *   动画、物理、表情、视线跟随全部由 vendored 的 pet-core 驱动。
 */

// ── 诊断信标 ────────────────────────────────────────────────────────────────
// 「开机不自启」这类只在真机开机瞬间出现的问题，光看代码猜不出来：把浏览器半身
// 走到的每一步回报给 Host 的 /api/diag，重启一次就能拿到确凿证据。
// 失败一律静默——诊断绝不能影响主流程，也绝不能拖慢它（不 await、不重试）。
var PW_DIAG_ROUTE = '/dsh-deepseek-peak-whale/api/diag';
function pwBeacon(phase, detail) {
  try {
    if (typeof fetch !== 'function') return;
    fetch(PW_DIAG_ROUTE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        phase: String(phase),
        detail: detail === undefined || detail === null ? '' : String(detail),
      }),
      keepalive: true,
    }).catch(function () { /* 诊断失败无所谓 */ });
  } catch (error) { /* 同上 */ }
}
/** 把任意抛出来的东西压成一行短文本（诊断用，绝不能再抛）。 */
function errText(error) {
  try {
    return (error && (error.message || error.name)) || String(error);
  } catch (inner) {
    return 'unknown';
  }
}

/**
 * 跑一个**可选步骤**：炸了只记一笔，绝不往上冒。
 *
 * 这是「开机不自启」的根治手法。真机实测（2026-10-06 16:52 开机信标）：
 * `apply-start` 之后什么都没有——既没有 `mounted` 也没有 `mount-failed`，
 * 说明 apply 在两者之间抛了异常，被外层 catch 静默吞掉，于是价格条 / 鲸鱼娘 /
 * 设置页 tab **一个都没挂上**。事后去插件页关掉再打开（重新 apply）就好了——
 * 因为那时 layout 已经就绪，不再抛。
 *
 * 教训：apply 里任何「锦上添花」的一步（装样式、抓 layout）都**不许**有能力
 * 拦住宿主功能。每一步各自 try，出事的步骤名会发回 /api/diag。
 */
function pwStep(name, fn) {
  try {
    return fn();
  } catch (error) {
    pwBeacon('step-threw', name + ': ' + errText(error));
    if (typeof console !== 'undefined') console.warn('[peak-whale] 步骤失败 ' + name + ':', error);
    return undefined;
  }
}

pwBeacon('script-executed', 'facade=' + (
  typeof window !== 'undefined' && window.__ModuleLoader__ ? 'yes' : 'no'
));

window.__ModuleLoader__.load({
  id: 'dsh-deepseek-peak-whale',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
    pwBeacon('factory-materialized', 'require=' + typeof require);
    var react = require('react');
    var h = react.createElement;

    /** 价格状态条：侧栏脚部、账号位旁边的动作区。 */
    var STRIP_SLOT = 'sidebar.footer.action';
    var STRIP_ORDER = -10;
    /** 鲸鱼娘桌宠：全屏浮层（在所有列之上、滚动容器之外，且本身点击穿透）。 */
    var ROAM_SLOT = 'shell.overlay';
    var ROAM_ORDER = 5;

    // ============================================================================
    //  峰谷核心逻辑 —— 由 build.mjs 从 src/peak.js 注入（不要在此手改）
    // ============================================================================
    /* __PEAK_CORE_BEGIN__ */
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
const PRICING_URL_CN = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing';

/** 官方定价页英文入口（美元牌价，仅供对照）。 */
const PRICING_URL = 'https://api-docs.deepseek.com/quick_start/pricing';

/** 本表数据的抓取日期（用于界面标注「数据时间」）。 */
const PRICING_AS_OF = '2026-10-03';

/**
 * 峰时窗口，按 **UTC 当日的分钟数**表示（起始含、结束不含）。
 * `beijing` 仅供界面展示。
 */
const PEAK_UTC_WINDOWS = [
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
const MODELS = [
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
const HOLIDAYS = [
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
const BEIJING_OFFSET_MS = 8 * 3600 * 1000;

const MINUTE_MS = 60000;
/** 扫描边界的上限：12 天。谷时最长的一段（春节 + 周末叠加）也不会超过它。 */
const SCAN_LIMIT_MINUTES = 12 * 24 * 60;

/** 补零到两位。 */
function pad2(value) {
  return String(value).padStart(2, '0');
}

/** 取北京时间各字段（不依赖浏览器/系统时区）。 */
function beijingParts(date) {
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
function beijingDateKey(date) {
  const p = beijingParts(date);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

/** 北京时间星期（0=周日 … 6=周六）。 */
function beijingWeekday(date) {
  return beijingParts(date).weekday;
}

/** 是否周末（北京时间周六/周日）。 */
function isWeekend(date) {
  const weekday = beijingWeekday(date);
  return weekday === 0 || weekday === 6;
}

/** 命中法定节假日则返回该条目，否则 null。 */
function holidayAt(date) {
  const key = beijingDateKey(date);
  for (const holiday of HOLIDAYS) {
    if (key >= holiday.start && key <= holiday.end) return holiday;
  }
  return null;
}

/** UTC 当日分钟数（含秒的小数部分）。官方峰谷窗口就是按 UTC 定义的。 */
function utcMinutesOfDay(date) {
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
function periodAt(date) {
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
function multiplierAt(date) {
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
function nextBoundary(date) {
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
function previousBoundary(date) {
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
function summary(date) {
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
function formatDuration(minutes) {
  if (minutes === null || minutes === undefined) return '—';
  const total = Math.max(0, Math.round(minutes));
  const hours = Math.floor(total / 60);
  const mins = total % 60;
  if (hours <= 0) return `${mins} 分`;
  if (mins === 0) return `${hours} 小时`;
  return `${hours} 小时 ${mins} 分`;
}

/** 紧凑时长（`3h12m` 风格）。 */
function formatDurationShort(minutes) {
  if (minutes === null || minutes === undefined) return '—';
  const total = Math.max(0, Math.round(minutes));
  const hours = Math.floor(total / 60);
  const mins = total % 60;
  if (hours <= 0) return `${mins}分`;
  if (mins === 0) return `${hours}小时`;
  return `${hours}小时${mins}分`;
}

/** 北京时间的 `HH:MM`。 */
function formatClock(date) {
  const p = beijingParts(date);
  return `${pad2(p.hours)}:${pad2(p.minutes)}`;
}

/** 北京时间的完整时间戳。 */
function formatBeijingFull(date) {
  const p = beijingParts(date);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)} ${pad2(p.hours)}:${pad2(p.minutes)}:${pad2(p.seconds)}`;
}

/** 星期中文名，索引 0=周日。 */
const WEEKDAY_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/**
 * 切换点的可读文案：当天只给时间，跨天补「周X」。
 */
function boundaryLabel(date, boundary) {
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
function describePeriod(state) {
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
function priceOf(model, kind, isPeak) {
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
function formatCny(value) {
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
function resolveModel(provider, model) {
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
function costCny(buckets, route, at) {
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
function formatMoney(value, currency) {
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
function formatCnyAmount(value) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return '¥—';
  if (n === 0) return '¥0.00';
  if (n >= 1) return `¥${n.toFixed(2)}`;
  if (n >= 0.01) return `¥${trimZeros(n.toFixed(3), 2)}`;
  return `¥${trimZeros(n.toFixed(4), 2)}`;
}

/** token 计数的紧凑写法：950 / 12.4k / 128k / 1.28M。 */
function formatTokens(value) {
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
    /* __PEAK_CORE_END__ */
    // ============================================================================

    // ============================================================================
    //  鲸鱼桌宠运行时 —— 由 build.mjs 注入（不要在此手改）
    //  得到 PET_MODEL（几何）/ PET_TEX（贴图 data URI）/ PET（运行时 API）
    //  以及 WHALE_ICON_URI（侧栏小图标）。
    //  来源 github.com/Pal-AI-Lab/Coopanion，AGPL-3.0-or-later，仅本机个人使用。
    // ============================================================================
    /* __PET_RUNTIME_BEGIN__ */
    /* 由 tools/vendor_pet.mjs 生成 —— 请勿手改。
     * 来源：github.com/Pal-AI-Lab/Coopanion（AGPL-3.0-or-later），
     * rig.js / figure.js / pet-core.js 原样拼接（仅剥 import/export），
     * 贴图为 data URI 内联。仅本机个人使用；对外分发需遵守 AGPL。 */
    var PET_MODEL = {"units":{"S":0.19,"X0":650,"FEET":1363,"DS":0.6,"featDS":1},"pivots":{"body":[128,256],"waist":[128,188.93],"neck":[129.9,154.73],"armNear":[113.18,166.13],"armFar":[153.65,168.98],"legBack":[112.42,203.18],"legFront":[144.15,203.18],"tail":[88.1,206.03],"finNear":[80.88,128.13],"finFar":[173.22,126.23],"ahoge":[118.5,54.03],"head":[137.5,114.83]},"parts":[{"id":"hair_back","tex":"hair_back","z":1,"parent":"hairSway","grid":[8,12],"box":[39.46,48.33,144.21,173.66]},{"id":"tail","tex":"tail","z":1.5,"parent":"tailBend","grid":[10,4],"box":[24.26,172.21,83.03,40.47]},{"id":"hair_back_curl","tex":"hair_back_curl","z":1.75,"parent":"hairSway","grid":[4,8],"box":[74.23,171.83,41.23,47.88]},{"id":"arm_far","tex":"arm_far","z":4.5,"parent":"armFar","grid":[3,5],"box":[144.91,163.28,28.5,39.71]},{"id":"leg_back","tex":"leg_back","z":3,"parent":"legBack","grid":[3,6],"box":[96.08,173.16,40.28,84.55]},{"id":"leg_front","tex":"leg_front","z":4,"parent":"legFront","grid":[3,6],"box":[120.21,168.79,43.7,86.83]},{"id":"torso_up","tex":"torso_up","z":5,"parent":"body","grid":[6,6],"box":[106.15,147.89,48.83,46.55]},{"id":"hair_front_right","tex":"hair_front_right","z":5.05,"parent":"hairSway","grid":[4,6],"box":[146.62,148.27,30.21,42.75]},{"id":"arm_far_end_front","tex":"arm_far_end_front","z":5.1,"parent":"armFar","grid":[3,3],"box":[156.88,183.99,16.53,19]},{"id":"skirt","tex":"skirt","z":5.2,"parent":"skirt","grid":[8,6],"box":[79.55,168.41,98.04,61.18]},{"id":"skirt_sit","tex":"skirt_sit","z":5.3,"parent":"skirtSit","grid":[8,4],"box":[47.44,168.98,151.81,68.97]},{"id":"hair_front_left","tex":"hair_front_left","z":5.4,"parent":"hairSway","grid":[4,8],"box":[60.93,118.63,44.84,76.57]},{"id":"waist_bow_front","tex":"waist_bow_front","z":5.5,"parent":"skirt","grid":[4,4],"box":[84.87,168.41,29.83,33.06]},{"id":"waist_bow_sit_front","tex":"waist_bow_sit_front","z":5.55,"parent":"skirtSit","grid":[4,4],"box":[79.74,168.98,39.52,28.88]},{"id":"arm_near","tex":"arm_near","z":6,"parent":"armNear","grid":[4,6],"box":[93.8,157.96,28.69,54.53]},{"id":"fin_far","tex":"fin_far","z":7,"parent":"finFar","grid":[4,3],"box":[166,103.62,38.76,39.14]},{"id":"sidelocks","tex":"sidelocks","z":7.5,"parent":"bangsSway","grid":[4,8],"box":[87.72,124.14,98.23,49.21]},{"id":"face","tex":"face","z":8,"parent":"headMid","grid":[6,6],"box":[100.26,73.98,75.62,82.08]},{"id":"eye_creases","tex":"eye_creases","z":8.5,"parent":"headFeat","grid":[4,2],"box":[126.29,108.94,44.46,9.88]},{"id":"brows","tex":"brows","z":8.6,"parent":"headFeat","grid":[12,2],"box":[117.74,97.35,58.33,9.12]},{"id":"headdress","tex":"headdress","z":12.5,"parent":"headMid","grid":[8,4],"box":[72.71,38.64,114.76,72.2]},{"id":"fin_near","tex":"fin_near","z":11,"parent":"finNear","grid":[5,3],"box":[37.37,100.39,59.85,42.75]},{"id":"bow","tex":"bow","z":13.8,"parent":"headMid","grid":[3,3],"box":[66.06,94.5,28.88,24.32]},{"id":"bangs","tex":"bangs","z":13,"parent":"bangsSway","grid":[8,10],"box":[80.69,51.75,112.29,99.75]},{"id":"ahoge","tex":"ahoge","z":14,"parent":"ahoge","grid":[5,4],"box":[87.15,20.4,53.2,36.29]}],"feat":{"eyes":{"eyeL":{"lash":[549,609,714,715],"ball":[585,630,710,748],"iris":[611,629,707,748],"lidFit":[0.008654097031104648,-11.40448806820491,4388.756473993086],"rimFit":[-0.011105816330789699,14.433190194160977,-3943.1944247092115]},"eyeR":{"lash":[825,617,911,701],"ball":[819,635,886,745],"iris":[822,636,874,744],"lidFit":[0.034502404875217586,-59.064235979945046,25913.794804961508],"rimFit":[-0.053416795724098264,90.54594798983726,-37627.38070212919]}},"sprites":{"neutral_mouth":[758,764,773,775],"happy_eyeL":[554,651,699,756],"happy_eyeR":[792,659,877,754],"happy_mouth":[715,740,772,783],"sleep_eyeL":[557,672,696,721],"sleep_eyeR":[789,681,874,726],"sleep_mouth":[739,758,763,772],"drag_eyeL":[577,619,685,720],"drag_eyeR":[795,631,875,727],"drag_mouth":[709,745,766,764],"love_eyeL":[539,607,706,776],"love_eyeR":[799,608,888,768],"love_mouth":[723,748,785,792],"dizzy_eyeL":[568,607,701,733],"dizzy_eyeR":[784,608,878,732],"dizzy_mouth":[711,761,782,779],"surprised_eyeL":[535,594,716,758],"surprised_eyeR":[818,601,904,751],"surprised_mouth":[751,747,791,795]},"blush":[253,222,209],"skin":[253,242,231]},"schemes":[{"id":"deepseek","brand":"DeepSeek","label":"原版","accent":"#4D6BFE","ready":true},{"id":"harness","brand":"DeepSeek Harness","label":"纯黑","accent":"#555555","ready":true},{"id":"chatgpt","brand":"ChatGPT","label":"银白","accent":"#303030","ready":true},{"id":"claude","brand":"Claude","label":"赤陶","accent":"#D97757","ready":true},{"id":"gemini","brand":"Gemini","label":"四色","accent":"#4285F4","ready":true},{"id":"qwen","brand":"千问","label":"紫","accent":"#7F69F0","ready":true},{"id":"kimi","brand":"Kimi","label":"黑蓝","accent":"#007CFF","ready":true},{"id":"minimax","brand":"MiniMax","label":"玫红橙","accent":"#D92D7A","ready":true}],"view":[-12,-8,268,272]};
    var PET_TEX = {"tex/hair_back.png":"data:image/webp;base64,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","tex/tail.png":"data:image/webp;base64,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","tex/hair_back_curl.png":"data:image/webp;base64,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","tex/arm_far.png":"data:image/webp;base64,UklGRjwNAABXRUJQVlA4WAoAAAAQAAAAWQAAfAAAQUxQSEEGAAAB8Ebblinb2rb1ETO3fWzbts+5bNu2bdu2bdvmsW1u731WRow+YvzIzJlzRmQp529ETADuCsroLJJmgNEwCDJbpAEw2HK7rZcCQCMzJAArH/mJP1981WX/++nb77UUCDOjwaJXXOWT80UvXoxmRgTs/Sd3jUmpKcbk/u+j0MyEgEOv9yFtPGk69DvOwGAGBGxzmQ9tyuirj0eor2m+43M2dfQrd5ZQW4PHeOR0Fv2XoalNFvzfk3UZ/Y1o6mpwP1frlCnfA01lX/RIdmHql20XQkWCFee7dkKz6F9DU1HAnhsyad1Y8seiqafBUZm0rtVu3VtCRad66s6S/yI0Us9prtZj9BegqSXgCGMftA0HIlSzx7rMHiz5zwdNJYLl57j2YcmfiaYONPi4x14037JzCLWc6dqLJf8Emjog4fc+7MUYj0dTR4OTs0dtQSOnSP7rQZAqEPCof7hHnUSbxjTfE00dCFj4xP+7k2a0TlP+VAiVoAEWPvxfbmod06/cB6ESSAPgeXOeOjLaE9DUAsgg4AF3uI4jp1D/HaQeAA2Ovd7TCKcyxlMl1IQBDrvF1TqN/l3UhQYH3+TaCW3TGQhVIeDEa4wT2MaSf21hUxcGeJPrhPbM1+2CUFcIR23I7MIYv74NmqoEy/7pOo404ySjf6hBkKrufXPmuJYc1bl139wLCNUIFn3Vad2Q6pc8QxDqWf4bT+xINfrwS/shSC3LfuGJZCckVf3C0wCp5Zdj2I2ZJb/lVQsQZo2NMmX/2DKEmWE2QjMjqZq/tB3C7LARGkc12Z/PhEh5y381xqYfmZz86gciSHFLft6VtWLyGx6J8g45L3dlrZjyTY+CSFGQNxtJWl/GZDc/GqEkwS7/c+1sSmq+6ZGQova7tBRjyjc+CKGk5X/yWIgx+dXHoylowY88FcPkP90SUo58shwjk31pOaQQBDxmTpVkEUam/PHFQYo56Y5cjlETn4lQzA5/81QQU778aIQyIHhfWUz+rUUiZQTc/XbTkjTd+WIUIlj8LU/FGEn1yw+GFIGAJ6vSCmLyry+CFCGy0688FWMklWvuhVAEAs5a7VoKR6N/AFIGZPCKOWNR+ezdEMoA5r0xWSrDRpRzDylGMO/Vd3piMUz+5XkiZUCAR57trizAxv19ESSUMbrbp1a7J+VoL2ZGtZufuq0AUkgATvr8LU7tKOecW5jR4kVfv3cDKQMiwBGf3JS6yWPbGNV843sXQcoAAtB8xiNJdpRzC6MOh/zAQpFCIAPsc3ZOJFkANQ7T4xBKAQIeuJFKku1y20lGcui/WwopBrLgmx6nsza5ldodhyGUE3D31dQijOQwP7ckkYVf99RLbqNRn1gSAs66ndpLznlCstsPKUpk3tc89ZXNjNShn71lUQg45qqsVoDGuU2PRUDRgtcxsac8MvRvDFB4kB3+45HtrJOUvrMTpDAI7nadpymsC1t3JhoUL7j3Za5sZzaVqX1YRIpDwME/yak3bn4GQnkY4P5DZU9UW303hPIk7P2v3J2NJZP/Y2dIcQCefae1z+OtLRn9O4tFihPs8mfXNnm8TUm1x6I8CJ4zZ5zKpqSp/3MVpLiAE270vsyo9iyE4gTLv9zKLGfrkMn/vZVIaRDc46bMNt3SND0FoYI9LjIl+zFL/vsVIuXt8G93956ouvlRCKVB5KwvX3DbzUOyB5LJf70cUtrobkec+fes7M5I8s4HIZQnAPAKS2Qvyd8bpDxABnLWHdQebOQ/W0MqgGDpDz2S3RnVr94LoQYEPGJT0n5s9RmVCHb5jyWyO9Nkz68Egjf2xJhfXs9uf/VE9uGvrAWCpw/ZehpqvPMJ9ciyD9yp2oLTRF6xXzUQbPUHjz3ks7eD1IKA+17lql0N8w+XVCSCB54dXccoySnsZQioWLDPa87LqmRSKtlG040n1DV6wj89phRVlWSLmL80gNQlgqN+l8jNm1MiyQlqt52MgMolYOcnPud5z/9XbkXVl0FQv2D0fR5HRjWZ/3DZTICEMJBHxKTjlHrL53aGYEYGnLVJ05iUz3v9qQ0Es1Kw03l5RIe86nQAgtkpeGlmTHFO06sQgmCWyIp33+bu+ca3rhDBrB2c9f7Pfeadpw0wewUTZfZAgkAkCO4CAgBWUDgg1AYAAHAgAJ0BKloAfQA+USKPRSOiIRSpJaQ4BQSxgGjdE3+A2De2kdSE3t0/MB51Xpd3iXeS/KIvE/8Z4W+Xzzz7OctVnH+E4Z9rr+/b5pyD9pOOPttuQzoAfzD+zf6D1Qv+Hy7/S//j9wL+W/1P/Tf2/8fvAx6HP69CdzsJo7GFYpc3VaLRlUZRwRXdHZ/FCKJctkYWREeaFrcJnfJWpPYZkY75XZrLEIA10lYbsOVbBEoPg6qgT5cAEKS26l9wHK3IftvlbJq7+RavrkyV7fIY7XCtr6YNMkkU1i9aj2As3CnMifNJck+sU6AcyIUH4KN18VkOEY90z2N/wIjWE8vIEipXwIQ7vxbb6hKkyAAA/v9WwffSBV8jy4lsQgdfXiSN4Dj4i+x2juimlwkLf6mSY2cUcTo7RuOx9MJ7b6nfXxvH9FoRCPjcUD9V5tk0Pgeri/aPb4qTOX1gLrT1oGP8VGLiN1cYGu8+QsBzXG2c0i1MtOBbXgB3ZJseiM3mYLxjwe2VMWR/6Z0/F3Cc8F5uh55W9gL7tZdR/8FlxaN1JNOyF9S1abpjJ1XzVAFV8u9odwI/hpQvFxYmrG3x0gVT32comrwlAIj7v0VvjAHXkqha3uQPgqVgsOTAsESRteBupLf6zhe/5RBer9Oa5r2awcrHRA8NhiCVInHQjs+I5d0BZOyFozk5tnBWUf7vM0WzSoy17Sb9MM9pNqdM8kz6xX9Cx7uHTj9siH2atqzmMgLvoSeldt4bh+X0cXt3VaZDKetJ+4633EtwrmV1r9D1r8RZeXIXBhlEivwGHRKQFSUmGUMC9h9ZmFfatPkvOOb3EAwVP+PZ61o7t061qjl8FiI6LpxUJ3Id24lp/yrgfaOx2wUjZAgFx6HH56tVZXXzseHwmjy3u8HrbuGTnVZZ/f0x1ogTmVDD58xXlPffQSiJIG9hUkjfN6nLMOJnE0wsHygMvPsogxUYHmQxF+MO5HqiX+JFAM3XZV3e2j+Fii9cnOTUlYZ5JmvRXJTWM6IQLIqOY2tUfloNQdj5bFNUpbm81cpvZ4v0Rt3kelAtbZH8U5dm9P98GfyRfnHd/OoVQI6Hx/zkF8/CHaG+2n8Duj6BlQt+iim8Rf9pKZt9dGi/Kah9IjKaOMlDX/KZjioK18keEqS0CJUBX9pQVSiXb3MtmIfuDkrcfGzy6injaITUNEfl8PnK4iuIducDeox+ngBKNwnyCDP5H8uDW7T0Ox1PpYTP8wKN6cyeOpEbbJ+Oo39eyX+EeWV/ftawhpaLN01p33QedsiVTvANXtNIJXDB0mkNNi9SFd2AzzfqSh/RkOCRjRno9EM0ErCgTi0WlhY/Ms/dyzoQ/KZxNqE88H7dnVFhijC2teuDzfGt898tlMHG4IHM3qYNZ3kwvxysuaHWePyZ10yP4Mq7T75VtYGtmCTEMQb2jRUa2oScuBgcffvtrJw/U/71wnKik2Z2ZxuG5Hs515AsWatBqQ3w03vxcJcLu7nP/UCZA4HAc+K4R0e4f8tvOrZnJTS7CkK3u+F6l23cQ5DnO405Xb+yk7DQwnu7N4SwOKPJMo+bIiK1Vm/5lr58JYtz3eDfuaaxNnlD4y88u/BIvvh0dsacewa0xXiIx7wrfb/HMm/TSGh4FvkTm/31s5cn/JihWFWVU+A0x8oR5H/uv8BXiedFakVU7yHQfMKkYePucrFX9yW118SUL62n1Tg+LJXX6punObtIh0xhII9ROQHX7iSd7MUTyIyUJNSJ++PvMwwl7hAH181ulgYxCASlPld7LbY60piQQTidMBnr3I2X+faIBuWoE9y/fUZXGjt/JIda7N/vd83CmRZQUC1fIAJ4Z/SIFG5boVYSe4ifyEfdDf3g+dduA0LXnO7llx/dhNNfbEZw/uwWztAJ+ERwr+U3dKdPNNiWPtJz6CpQ0uU/SKoY/+n+hqPmI96AIb+A0TRaeQcJ740SkX2PgvGenjgwcIx4i/NGzFnfq+1VRg3H2ce5WL9Ug+9TYVwH3RPpAbfjzrI+6rWcsHy3Yr2sHNF41ufjXqar8ieJ2W6HVDNdyPIVVeyzYB3QBfXVgwDMe0coi1joElS+JulyHYqs8u3UbZzyL3rhvCBZ8HZQ/RzlLDwimAL3fwZaVOSeQZDKbwUO9AxjmDztd/IVZhMU5cDSTY0d7ZNC6L8d4eT/1wPO/J2DRVvCfclObe2zlOpOnmUpip8PyVSx31AyXWMR06DgYvIHvCflqujPIN+51kw/3/9d+RAKfGDdZ+MvK7KkhFE6eITMT95UMKQUY/3s0K+bfTs+kKBIbj66fZIKizd7gh2o4lNdC5wA","tex/leg_back.png":"data:image/webp;base64,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","tex/leg_front.png":"data:image/webp;base64,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","tex/torso_up.png":"data:image/webp;base64,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","tex/hair_front_right.png":"data:image/webp;base64,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","tex/arm_far_end_front.png":"data:image/webp;base64,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","tex/skirt.png":"data:image/webp;base64,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","tex/skirt_sit.png":"data:image/webp;base64,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","tex/hair_front_left.png":"data:image/webp;base64,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","tex/waist_bow_front.png":"data:image/webp;base64,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","tex/waist_bow_sit_front.png":"data:image/webp;base64,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","tex/arm_near.png":"data:image/webp;base64,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","tex/fin_far.png":"data:image/webp;base64,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","tex/sidelocks.png":"data:image/webp;base64,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","tex/face.png":"data:image/webp;base64,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","tex/eye_creases.png":"data:image/webp;base64,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","tex/brows.png":"data:image/webp;base64,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","tex/headdress.png":"data:image/webp;base64,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","tex/fin_near.png":"data:image/webp;base64,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","tex/bow.png":"data:image/webp;base64,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","tex/bangs.png":"data:image/webp;base64,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","tex/ahoge.png":"data:image/webp;base64,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","feat/neutral_mouth.png":"data:image/webp;base64,UklGRhQBAABXRUJQVlA4WAoAAAAQAAAADgAACgAAQUxQSGgAAAABZ2CkbeToDU3BoYPv8SMigpO+PQGj2raV3P8b/Ab43BlrBAo4FSigBVgk8AJS4cd6ISL6r7BtG2TM8AYghGAAlCTPdADFum0thzJ8/79YsHcp5ROy6KVAxGKR8N1x0tZb9G6PA+QPAFZQOCCGAAAAkAIAnQEqDwALAAEAHCUAToO0Ac7PnQam8lTfBwAA/v2ZRJfsdALRz9P6Va+EPCXYTeHqQIP41o0Gu9x8yIOsUxX6nshxbeQ5z29OSZIZ6My/rvB1t3vsRFQZ6wYU2rrGp9m0WtgXpbFH7VKR15LqatKjoKBfkxhj3eV2m6rDr4rtnbuT4AA=","feat/happy_eyeL.png":"data:image/webp;base64,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","feat/happy_eyeR.png":"data:image/webp;base64,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","feat/happy_mouth.png":"data:image/webp;base64,UklGRrADAABXRUJQVlA4WAoAAAAQAAAAOAAAKgAAQUxQSD4BAAABkGtr27FHT2zbtpOvitnZtm3bdmUnlTn2EXjmRL7uGX98BnVETAD88QrEhdh4elH2dFLns7l/R/s+kke9l0Xa7DN9roAvX6mf2XFVfCW/ZcahM0lvUofD6TO9ZlWOYKSXBZwpX8ljIFcRvR1zrnJ6g9ocqlX0ClQ41GrIXfoCp2Y9uWn9PyZfmUujjtqpK3CrVVHrVOdRziP2NAD445DWkIYAhtYbBgTaviU1oCFEY4jSEy8QnCngm3wdINwX+eQ/txehvkUnC8SGIs83uWbUROms88j9wBHEhyCNJJBQa45EDUhqsUegU1Ua8LyQrV8DpGau5ME2DZCeOZHjNhZk9VqVDI8tQGbrFpQEn8drg+zawW2IYpCtcAKS6j5Za4iIvyEisum2QNeIiUurGl1GtjYj0scQyKubWBrDfydWUDggTAIAAJAMAJ0BKjkAKwA+RR6JRCKhoRv8dVQoBESyAF2c7S3fG/7l+QHNR747gG3A0JLqJefR9j5f3bb0B/vDNcG5aG/zfDsFz70JXjaMfx1942DqyVl0VVcY7NmsYa8XVnhyjGYBTXSAcLt059898wAA/vkV/ipemKF/5+QN8nGLgHEDERyvDcQZCGIg9Njn5D57Q750DNKrhaSyWbU4Ntz7nUus43lnZALIkAXLa0UroMfP/5N9tZeHqTtOqUUefGS3eCAbfNnPJzzu26dNb1mQZ2ycMpV8fY8feR3UZfidbfOuBV63ZaWFlpN2Rj7YkqwGJcHNw8THK5Flsad5bKModStX3bsp9KX/lHdNdDCLqBSigA0OHvc/sf5/bRSif5lMpLl6ipLT0harue9+wQtnR+pZRgxNAD4lqhFj5ucfU5rmJZ3NvEfG985f9m78XG+BPMP3MRMV1/yd/mAVNkNF/xO/TR2F5N32sBJdlGtTtqMTjO68oo7gfrwCSV2SFkbsfNuzmHphvol62E040X+AKnqk8pgmOvyjunIXbWzZ+37RD+cd//62//60J//thO1pYKWyKrlv4NIwvqjWPe50NdbD4e8cH/ucL+Ec5ZtXbaWFHiv3SH+JnIYiQObobdTdMK+5MbzLcJyJ7uu9tbm0LeI3D5WZVRfXWoaf3Ev8t3PqflCCdOppV07ECnAbrz4elLGqf4c/bxQ9bTXfmJp6nC51hjG7MX7uVp9D+hf+9/3Wnl2mPGuj15Ffyc83vRczNlD+P+M8q2rAZQAAAA==","feat/sleep_eyeL.png":"data:image/webp;base64,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","feat/sleep_eyeR.png":"data:image/webp;base64,UklGRkoFAABXRUJQVlA4WAoAAAAQAAAAVAAALAAAQUxQSNABAAABgGNrW9bIrwqLcCqtZPaQVLJHZx+kMovQaXQRSUUqsCDfDwIndUQwkCQlDitmXTB3gm9ovh8AajTV96pCv1l7U/X54/1+3FR9fhzvew/1+RFWXZEBctEurQIoynoTXTR1nUbdqWIkMru5gzHmObz29W56BYVmReZDwLYbMvHn73WE8N4RgQKz5g8jdjhLJqpx/5xKJNboLqcAgGcFDNT5bcQb6O/k8bp9IUImRRs0S8BzaknAxA2C95xwJhWwcl92mXFdA7//xEIIVNBDTEUQ9odjUVmjEplsiwauox6IsC4oleyO7K8btEYxqiSYsx0wnzbjjEBS0e4IjF0iUMyHRPi4ozQXUpndcfsjsWRbybidnoIn7i51f0mRAdvlOrtQDZztmMzN57dzEfLR2VKb9L2S5NnVNOZbRWOh+VrGQrObq2Ms143yWW5OWBgAyqrE5ayCxLMuZ5Ujbjux1IJyxM0GLQrPEl/gw4Dzhdkue5KQ4U97lnSaCD7j15alRGOBloP0H7vcZRIGbSwuNALcvjIFSPjZ5BFoiTV2YcAWS/Jo+B9DthAt3gRCWVcdXsXw5Strqgj20fSYuMpW7pg88a+hMjJO149XR9pL863RAFZQOCBUAwAAMBEAnQEqVQAtAD5RJI9Fo6IhEcXAOAUEsoCcAKQVbZ6ZetGjby/9j/GzoKPXrJ6nuXgDtM/2zvANZx/jrZfMh8cX0d7BX8o/rv/H4CX9gCT6wbeDgfZf7RcwKKmsu3oNJwy/6Bk7LSB4Gx5zBcPQ30eJ/ARRGan2YhhG+jlEubP6b56ur4CcBDNeunetWyb92gAA/v+dHn/8XSHpAwHPa5vxWN7xefuInqi8nhx1TZNLgMC3Tv4ida/4gJoTnGJBHOLq8KBaKR5hrJtVH2oge2CB6Rcn7M/PZN2/dqcTQe+QdvC3/X///Xi9+69fXsftbPxO5/EIa8c//1H/9Dz+MX9uo3+7fU2R9HQA5/ovIYuGrBBsZ0k5pwZfxllNLfJeWw+s9e9qY3Lk+0j+RpxTy/9uPwDtIqe5f/vg4TzoPnYl3vGyuSoFUp1p9VJj7zg9WXSI5R2/QluY/46wsMHv4LWt/0STe627PJDGSFaH0PxBDJmMK5mkxqJKyPeNbPZ7RJvqQ+9ch57dH+EGiAA+umP5zBRoXWhPyZCnSDv5bqf7jc2syj/oCXdmu3Qul200tAsJwBhrt6eIQVTWmbjkV/RRJhzfhrS5ejcoURWF6IQojJH1m4AnobNDRkAl7k/wqifSZqWStY1dOQcplR0PbtzFP+CAqUBL+k2DeUNJsA7dpLv9GnrlEf149HNZopyOjrXJwM1aC6jk0DMiglS0Hcy8pDYYQz3qTPydy6pu7XcQbI36eusw5bIztoLro4RTO52fPOn7/ufg9UcnRlJDtHwsfmELetFyWCZyO/X9P+BufEf65Hm/ti9V9Gz4gZIvyEtK4pplmCXoUsol0A7hJG2McNgpYm2zRa/lLx//5TfH7wyMqwG90LhLlolH/Cf//+3a//7akf+24kACHEWqa9AI+uBIOqoKzEsuoqSnafolz2Hb7aO2AG3QdJQV9VTN+ywerHvMY1Yp0McEF/N0EAfSkk5FXZ8TvP0RSK2rkMmsPpVnAvSHamhThOJ0ibTuT5PiNkOrseVCThwD5TSEE+yAi0Mkr/eT0M6fhLSOIYGK3hACaTxKltz5BYhHkotgAFXKrEVXXprvAXskFLlfOzOLrFz0MD/nQDKfd2ihl3AAAAAA","feat/sleep_mouth.png":"data:image/webp;base64,UklGRmgBAABXRUJQVlA4WAoAAAAQAAAAFwAADQAAQUxQSG0AAAABYBsASBvY+AMnfcLNj9l8QifzB1t6guWDiFDYtm3T7J30DFgHNDCMEfvwgmfqKV8sSfmBJEeWopS66f4DbRLJUP5ih4Fd8w+RRY8BqDDOP2P0fPvPsCnNZm+1SOwUul7X4NkSQP83ESd/fxkAAFZQOCDUAAAAcAQAnQEqGAAOAD5RIIxEI6IhGAQAOAUEoAnTKAJZkWGUSakftQMVUNHyxgAA/vcRfcu+xc6Rb1i1GZdNoGhOK0aaYVfQs6tf7/3H/wdSw2N4kKUoRQ9eqFXjEaqSrQEQr+vIPjivZwOjc0VPwj7AzKThFjO4B/FJwMRw/YbA8Z98ey0Np2E0EQncVnPbTrGFnuLBc6dwv/KL/nf5wfvB9fkdh7e/awfmkCjHRd1EeqDfdfCsW7Ity9amh1WrwwvjohnFfCHv6NyTq/ZRC4hQnQYAAAA=","feat/drag_eyeL.png":"data:image/webp;base64,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","feat/drag_eyeR.png":"data:image/webp;base64,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","feat/drag_mouth.png":"data:image/webp;base64,UklGRq4CAABXRUJQVlA4WAoAAAAQAAAAOAAAEgAAQUxQSD4BAAABkCsAkCFZdbZt27Zt27bte7YV2bYZ+WUvf3/SFVVNzzzlETEB8J/XDyzq6S0JttHE2s3LzUYz/aQdTwSieH2q01GNaebM2dsPbp9byDHVxGvrEypf8Zfz2SOQF1d81RnWPUbph1Ey5Y9R9kWUGqs5gSrfRSl1C5T/GCtnswP5W12ts88Jvg3iRpD/cvg8gx/CZGx2IXs23QTAMOo0wRexZBjZ86Ue1u411wne91IyWUd2xgRYuw2CokbfaQWpGLUC6rKf4DkHhXZkB0DZeIUgvnuI9G0eKFqdILhhxnh9ZgZB1mCJ4V8Hg6TjA4K1TCvSGQMpgGWJ+wEgHfuTCC/STHaZgtrBX9wpJ1DZx0QTh7NCnLYD9eE73wvxo9EA1BoeQMQ7jgQs4hIsQFPXoAAz0NBs4slZf/hLHUzgPw1WUDggSgEAAHAHAJ0BKjkAEwA+UR6MRCOhoRgMBQA4BQS2Bt8isNo1+/bAjAbYDzAY4xvIn+jR4IQDWFFyVawxdf1/LbAGJzJN/tgwAP7nxCW/3KCK+VxcJnsuPv0a9O33Zb63mKUMIVcgz3Hjh/JkKXMhIU+lBx6aytKANU77wTrHu9fvykvRKcZft/UMzzdv1JGY8tmsp8bACE1HKXMCSUdxqK2cHpouj6XmhDiLo48GS4XgDn+njRA6Dlu+NUhNn8EYYMzIhJ3BDMS6/09A8YSLELoSp6nyKMlssADuxKYxAdOgZaUKIna0E5rnleYjrgj4ZBHG7capqQ+60GZsso8K58c//Jx89bPm3cu2gXYQCa5/08f//GXYk4Mj+nmtoj92HklTlMCQgz+Y9Gh3Qh3t2PAf/hUnwchIIBv/n+//2G7gIeqYV3ven2XqgwAAAA==","feat/love_eyeL.png":"data:image/webp;base64,UklGRgAWAABXRUJQVlA4WAoAAAAQAAAApgAAqAAAQUxQSAUFAAABoCsBkOLK6Yk0oS4yPVCVFJk51ZjeRmYMmTJ2xOwQo0N9gCnSRTplTh9FKzOzD1emhSppdqCnu01JREAMwLZtAxAmA1OOkg7PC+CfAlUYBRqr+2ef4+fZfS3FUNfYbLwTwnHmGsrYsXpbY3dnRRnCYrZrDW21snUWva6xVRjbQ63WpcHUsXureNqt/AynU2HSaXDpH3icFMZAKyb9ucNJY+T0C0d/lZbtgnLl6qdRkK5sh0hh0pudlYCZOys6xSS5qYd7NwaeQmljVcRomUnr4eRX+49LuUZNHBUxM2ms7P3V/uM6xz5WsUdVNJk29EZeVlVrX7U85rJHyRNqMC7a+6rdBWcEq5pIaDMpKtqsPTHspIsst39wtcWKOH/Zu5LcqgjLu0hvYaNesvEw/gsuZ5lOumfJZth/rwHbC9hcMHbPSbqrVufsosLZG91KbaEwF3XbwVtF6T+2tVPGHY9uUAnr+AbTSWP4I9lWSrQqZeENqvu+2qroFMV4oJIIq6JUlHmmUwipolI4Ez01tOhK6MKqKJmOhCyEimC0EzHRLFoJU/EV2bATHVEOO6EpsqJOK5EQfS5SXxEQBy6RWg0P/mh0cnHhrYlVN2wwElLNZ/EXAyLFib34SytCqLkz2pNCzftCqjmaTuwYvjVp1FwYfrVCGDUPh7nRVysajnjOWaHdFWlYYupZh3NXpGYK7zMh9l0RDLEd2H4mxLorEine0MbxTEgVyYYtTOvuItYzITVzrOz9Be2aLl8851igoOEM1MvPNWs4d8tlvFjDs2dG8vju/rDMmj+wzIY/kMxaAHjNeWgWAD7zurwMy+wRdlVAJASeJJYhkgWuXaE4eA7rTLHhD6Tz7looAHifKmjEgjpnRxjcEIy++/1qAWAg5qUo6ELES1kAEPNSFEReoxYEm5FX/AXB6xCZJNmrRKY4yHJvIg6y3OmRAgj3zYTAZwBIiT1GgJVk6EQZUgvQiWUJsAbL4n+eiJZq7p1IiT8M5uNP7NfgWexf41k19//WiBbv/9aowX0NYk/N/FAcs4f3OTeqVTM+S0SOOVfcBUJGF7BjODrJdJ+Czs7KiyxxESRgd5MhtiEJeyy703DEDl+pROh+xg2PQypeeJQXTuxJBniOF95Q6QDvc8L3GlJykxHeVEnRO8onnwZpadjEkwpSB5cd33K9hOVQpQfcwAHvLDKFOMphDA1e+Blx/HltoCfP0eRTC49MfEAZH2qgxNfp4vjFihTgTqr46w4NxNib0lRUkygHlAtR5IWb5PCaBqJ8+KiMAuiNaEq2QfdqIM4bPiOB+cPkBdC982h6fHzxUvIVb5+mgAuTFt8/1HaZNHyWCu9aLqvi4STFV5crYEgzwsaxKzwVr01j/gOf3gWseeHrR1Fw9PUe8KeJ//OY3gli8M7npqFvs/ncDSANe+a556bTz9rbm77/nDHwfys7K53YaQgBPdw71HHTMFoGmckvk2HHMw1XaHPk1yNGy6Ci/HXvimca+1ZdmldH963KoKrMN7R3Gi7V1WyD9AL14a1iPFDeabhUzw8PFP+c5WVVTIwOm4YaHF6ommVaCi/TodPIZpWdBRCGtxgtQ1OZZ9GeCE32T01Eb2J0qDeRxIva4rio5PDitpiXlQie6rd3KGHT6AyXv4iWJwEsL3AaK3t/qaqCtzyHYEYHTMOxWH5Z8h3fajMesxbi6YHu9zWISKXg75wAAFZQOCDUEAAAMEgAnQEqpwCpAD5RIo5Eo6IhFQlGaDgFBLEiO5CQ39104RfO+chVv7n+JeZ2N/22/0f77+S3wx9Y36i9gP9Sfxg7M/mZ/af9sPd29Kv9m9Qb+gf5zrUfQL/ar02/2g+Fb9pv2w9nLNef6x+NH6geUn+B/J39te6t9vzPHADNZ+B/0P9w42eAX+NfzD/Xfkt+W/LfZr/3fp7zg8gL9YeOcoC/pP0YPpb0MfUnsGfrb/vPXS9jv7n+0Z+vKQAPuD+7KKnJ1X9jWDRJUr1gzSP7mu+lPmgG0aqKj5VQyBwac7H3xtmfcf/QdY+aTGR6CZ7//5gosEi0URNuESO7tfPoPjsXYj4grn9ziKk2gmTK8SvXKDKs7cRadE3cd+8Ml5QntQgjZNMvgN030obDZd/8VmkqWJ19D964O4KLW66ve/U61MI605SDAcXnrOvEbGNse7WS7nJRsyiyzU28WgFv1Axgyu3eww4GHgnlGS6Ynehp7bt93lSvDWLsc5Qx/b1yyOCrd2jViwatdtxtDUh78AL9KarbR8lFfYbRF9IFNzXL36Wc3nq9bbw0pJ8JsZ6hOEXqE9j7zwU7uOWbPcrWcdsIsxmLDyNxfrTtIU+AknRltuuRt5hYM3lFOLk9wXQwB870+vj0a70JWcuT9B1M9fM++h9K1+am7T23/tCj4clDTCE5rhA1tmgUkqab7UoqppvBTkEiUmRRd6+ZNcBhwhIrCi1fEOFf9xpS3OSLy9mpQEdlOH2l2AJvT79mWM4zXKmij9X4EOvMAAD+/gbRPfYbvrKfFDmABFWqb1N7k5a5Wf/+aGjbb7/lokOPkYOP+bidQzfsmsPLnaIPPezdtne8OmxNG3ba1g779HoJhNlU/AWTAm++vN2rwB9p3OQJuMQErRUKneHaMOd3deW2qqJoYpEMkzrLCHJ3WxVgZJlvyQ2GCfi/KlxpyBWefSr6eRlrluU0DDOdVirV05oY+uyqfAa/8m+9SgS66q05WCvF7/ryx5KfWteZMrXNN/gMD8iFwL6Gi6U9zCV24gDoHZXNUS6OMp9Cv4/urF6r5fFWt/+lWemDQJBnCH+H5E72YNyI3x/buQJhHVETvy/VUhoVnT2RIiMe8+X/S0wI90MGKC+z0rRz9Qmmjefbl7VX3okbUqgxotDF9aiAR6EKEoxluDELjPx5xRyBz52joXn/50f+9EH15jAb/5JmQV+fIqnA5tau0v+1A8I6+hn/YsfC+1vKJ0fuIqI6FenrxDHG0SeSlrfzv7/WFX8B2ERqG3OZ6C92/5/i9Y+r73L/4b4fo+O7K6/3dcz9tQudfdXov9XTuynTumxnj9mzyO5jVYLXQWz8REy6ySBOGjIVDGLsb3eOficZmoc2SFtIwrjo2EDSja/TuPFeepZklXJ/2lq4TiOakDdHjd9X8RJKeCni7IAU97NGqQaiqHF5vqwdbnZSViuANdCOAIfHM93xLaBKTwluH3Ak3cxpqNCVVI6vqRP3rYfIUo2D9p+osnZAGjrx9/kBv7/5LwPWIhfoug4miCSx5JvPrSzTzindUU3AnA/vmIDuxZVmA8nsIiP++sAzzmzy74rFhkfTzO2xja11trsbfqUIa2HNm1i0TdbpbYD5RyqBnppUTUnLF7EaSF/t9zy8HRtx4CPERp5YrvCXs3hE2XDx+0yu/t1O6L91FoItVPRq7/3B4T/NxyV4VA71jKaBvT30rApFEup75nXwUXSCtMtJ9+Oqsn4XiP/pE1OP4Nqyft04U/oRj8ko9xlYwdiHgsvCQ5Su04e6pqxu8wC7jL5FyaQQnEeaSdGLcEQQ7E392dOIVEGdLN3pS+VuLC3B50GvQr3anaEBAw1alsZmWNUlK105rXtTeRnA+dusw7RjRT7rRgXmNICL/zqVcVlSE8b0W8utrM/NKxEmYplMEcbuFp/1UAPJ2zWs7BnGYjrgHb/2Le+JQJeg6X1RkVe3HzKeLoVzPul9Y2oP0o4zc7wor38Ostq9toEzMNf1CO82UcR3w/HbKLL4BkhcFPzcVZlrlavWNZr/r0i54f26Rnlpx3xnNx2TluNaKv37B53qYzsUZAK8PPlccx3In9/2HCPbkN8i7kxTeDxbARod2J8ogPX98IkDzS6Y7FXPMjkNVG9bk0zLDGSpCXUYCXHfWdaju/IPeUMyrzBESw3AlPH6XUEEzIzibzCMdmLXdlSFEt9DdrazZ4YWwrxStBrA4MeDFlQVD4FftnQlgFCjlJ4DWWw4y7lc4qE+ouii5vRFIhlxVAL1pUCdtdyX+6xpPpQSd5qVTkucPYxq229l/bHQBIafeH1jygukiQ4Z35oj5FPzlOZoIBujmlyWiJBstw2MGPuzZeZfx4HFY0zEFGYxiIWf/o5G2XzD4DmAhSL7fwGc5awZ7CSAYJgGzP+Tax43uGInrx///6bwSE2FMiH5tzvTSOcwe6rIKcKqULbte6fOuMEKXP4vaXCrqOAv4QKjr7230Aec5dOaBrpmzuu7FZH9vSaxviigGxi1ujTA84VX/Ljfw7qb21vTKqnvC861/nwQBmpDaasA/3Evvjz2IriW5wj8oRaaab9S5rJ5lDrJRlE4Za94UJwlm98cfQl+Jjq1repc62jESYrr4UzbLWKuobo9YeHdxj1SjbatQCFVy1Kir9PmDajKoNpFgWaXbjHsQJvDTBE3dmKsRmTzyFksw5saHtgN09pBJXHq9eDlA5PfctJK+E6Ya1o6U8Zv4Sc6qh29Xotrok+V7jTf10d/mHpc9sgu60JyTFP9NqX3p5y0U9jJla8oHIN1/o4COZwH2gDkgkY9donTyKyp9AMs1TmyDyAWRzAXBlXwQi/H5rXsF/9M2KDobCgEnhVr9NSvT0mZ72K1gW/g5jlv8cB8Ym5KKVmYzISfIAoQLsBz/gbiQ/E/N7iF3V3P0jLr+naS4HdV34GGIBEdXi7qA/8fhnVBGUuBICRjT69ZRP6HotvY6f9/0vIkMb9IlfvjQegsHDh+pc5CBsTIzxR1VvXsuzva/R6SC3gR83PDQjWMCRxtJBmPjrTFiMjXHxHqE6z91mrcH6VdTIzCSQM5inzoRUjaa2xzbh5sXdldJQb18jNWKTaGslL4/NfuD7MZbCLPngs3Rek9bTNv9GWemY+7QhyMGV7BBwKzOAqaxt3nNahKfaGIUNnQrek7u6Z7DGekAhGq1k7+4XAzsyMpoeFPOdUAKVuaXIEBeIfo35CYoHeTb7ilG+aEj98oQM9x4KD4K7ucegJQbNk2Xpem/DLrOc/XzzwtLhQlnFrorRTInDIztI/g7fQRVfmHlw60huPdWU/hOcxatxCXyiLljZI48JvsUE5OZqSvZgTePK6VLRX5Sp3Y7IoC7tKKCaWECC2fLPOpj+9YNcTEruH5yIbnfb/7nF8nItdBrdML0fT6RvBC8t8oQ9OpZ14ikM8sk895ppktvnBezf/EK/9MLVB2TKkGPto1DNvqnZyP9UDU8OJFdVoPGlXSkXeFdGzUfIl4LATyG5VTpl3ewe4aGNYv2wxld+X7t1LHrQYJ8VV4OJ1pc9A1LeG0Uyr8ci0L6/WjrW5QtOEkT57NJEbrXG1ldu5v/ZMIr9bn/fxxRYdRFeQr2IEJ2qoTdu3bxZEEXeAxcKend+MzLTitJloqV9D0gHUVv4wqfw/LPQYxWXS5YhcsQjIr/w7BFUfEJ4Wr19mfsjMUnuobtP/wa8hqR+fM8g65+AcwTLpC7j5OKNdIWHxZ2QO4FG4mwFGzaFK23qh8tgifVFWOnXmoYukK2omvWBAf6/181uCYyq6p5gdcMELwieHfzWt+tq9el8Z0wVCctuSJVkcFJRQTUD7VcXbphiUe3BkAjbgsm79KLbLoSaCzbFb6wdN5CdfyLAS5ndVhn98+MZXxYv9qjxg4wWFJXWINyk7wnM0RLPuQgt4aOKr7p4aRgVN+flS3AhV4Ay9AuZZW0uOffVJsM8DXuWrEetMqFLPi7wB5Tc7n296rWZT85C2Eo/AH9oGnVrUv4yWpPN1eOfUiOo49XXEW7CgMYBaFpsFI4ASHARdMhNz2zkoye7QoruNBKBqhJR+YP+pI0sPR0OvDYVfpcW1el8xU0+lxjZHc4hG/LsAo/Xv6JxBEp5SNxY9RcFXQItlV+HrAAcurd2sQ8BeDnt0jJmRvefOumHclAxEyE6Rj3L0y4MBCFxKqxsVertH9Wq/CdKXTixT36ZV/+9p7VJyqgEe1Fhbcw/Jjkk24Io+m70h5ybphcUT0kbZ6sQtncCqLwUn3BkSWGqBGA8b0cfXjyihxkbG/kV7//Nwxmg0Gv9zZxmxI/QUG05kIr9xufFT7QOUv/PwEVOyY0cc4GDRxaWBx71/D+tQCOB2Qq1BJ9bbr+Ot3jkLjeLPas1dGVIY+deK6fqDQ3V13Vw7hmr5UKQVnlDBhLfBigbSwZhKJrU2JeC4g8QQn27ZtdLz4pH2sK+6sgX3ysSpjHHm7UqSVqMsu92CbwkANN+yzKDcWG+36iEfNeH7R0Yf2nkog+hBcaFBZHjqBxlZ87ggsNSnqFvfSgAycHbiRfcluDQla4aMmIAHwM4gojwcNnzkChf/BF////RfAAAQGB1o5XBxOHNDzRTP1JvTIHEtbsmfuU9p7axRHxuqa6kWPmCRSXPjemrzPdlAxZGPQn0iF04e6mIqOw6ZC8tKMbKhx0PLOzYnUaS81sz9y36hUJU87tApVsATSJGNp6XihhokAvqFFCzpxM3h3Xj8fGwryCGRwoQ2Z1iyNv6htyoJd2IfS7eeebZYx9HqqtxaeI4x1sOiBiCf5/fC4qXzsG758lQk05eFues5NsURFl8eOW/7KaLTS4DKndppz/41Szhvf7UzPPvJIFFFYLaTnXML5GHPJRWgpzI9H2u29kjGaatdwnAx36WAYePekjRlsYFEOrNzyrCq4ciPh9m2dGFbhq3X23xOhVuw7uosYeOkczvOEIU80Lr2ya5vIXRD5Uq1n/2YbYlhT5A8rpHRS3zJX64tEWIGsyUpzkIvg0pzxnxqyV4m3EqVPg3td6eIheHM8HJb37VhPW6J/4riukqfVrU5L7XPGOvw7hE+ar9U7nAAIjoeIEXlfA7fgTiHiGe1faPNAH4OS4nLi2oGURW7L805NhGUefSJoZ8sXIinnuEAGGKL8teIFx4Laxm2tx+mVjSZXHwpA2jID/EKmuRDnDOSw7sOWx4mzXWhot3obeqG7MiGWLj5lNxWeRDMwRIbEMrJmLA3oxtscz3+6+dnoe/UU68HoOHjbwLazt2AsAB4BIgwdxBiXJVqx5JzMByffzqtWkRBpN91hyiDs4fSrvlTwPxLENY1MinjFyNfZSeuQcHW8ELlnqGo+CuLtZt6lX2H1/Ennut67JJk7AU3dH1+X3YPJC//MFg31ACT+rPTidycVnVfcK98qfStsoRCuN4j5dqRd+Kciyp7pcd4D0aq8WQi/vSAR0vyx4bVnLj/Jua1keFg3uGl8erUFkZuAok940PrMxE0VLMZDU5dvzdmMvKFqhFzBrHoii/5Lhn0aQ8fix1bQuyNfUt8NwScgyheiaH+rWS8AZmtx9cq7BLhXjSf5f/+YxzWJQAPPkAAT31lYkHc2fWSxqg0zoQWUgjgSmFQA8YwZ8IY+TeIBzr/D+LwrKpSqLX7fEL9NyDbvGb4MM6leVww1oQlGKa7aqc8bvmZoqRjABLE8PAELoy9LO9qE8YgjYSAzQAAA","feat/love_eyeR.png":"data:image/webp;base64,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","feat/love_mouth.png":"data:image/webp;base64,UklGRgYEAABXRUJQVlA4WAoAAAAQAAAAPQAAKwAAQUxQSCIBAAABcBsAaNuIjT/kSXrCmz5myxPyZP+hLT0UCXJARDiQgLZtgggXgbqH3pD+H2DB+7FiLlVDybg8aj3WRl0HNT466fGs+liPa9x1jOv4je447TWyHuvDAh+9WSU9mX2swijArHkPHwzKIA7cGnXu+eHeCwjudA7NczwJ3oboeOrVUOHDH/ejMoVMGgMcqJ27QQ6263uEOMp1pFP6PdQpcU7gxf1smFJcZNAG4otZj7APeNjn7N7ZtAxGpWUwKC2D5z0kLWWjEaGGBGiY8J9xU9x7pkT1lB9F395UeXKy/DhdXlwoH0bVfYUe/2XjpAXq/6NziW+3bQvU/sPZ/7DduTrtCB47ltgBjBWnU6t5sWvuH9Z6lRHAcy/EXKzVLnSxTH+LBFZQOCC+AgAAkAwAnQEqPgAsAD5NIIxEIqIhmAquqCgExLQAUu97QLyZXNknpz8bWgJZl6K+hf+AJgiDX/xD2Qd6hA+gk5JOGPqvS3rBy8a8qMMElEsg9uJRGAWroYRs+r9USrX7OGBcqkf4QdM+rrt/mVSCAAD+/xKahrBYHDuawg5au9ZjDjEf2aMmGn512C/KEfr6fAytrJ5VkzcKttzdyezCrOVvexWGYnQhAlab2jecIp491o/bbDd7sUU1c4gXBE/DDnn8LjGJBt/DQHRiLeWYC2XQJXRcplnHhC/2mIzceyzgLqVN6YMzi/WGtqwrmMNkKmeYFsjYwKpFNH8q6wOIlG9b3qyDodHPy2ERQa9V+DNU/vULjEKcOCfBPQGBb9VSrtkttkXjSW60Iz25f8CAoUh51JsVbit/RrGn584nDjeg5Hs0n5QBBNoIM1VcGE3r5r0kMtm3Y2AcgvMeXlYfTjpv84eMJ6YM1uW5WvzDX6W+5Ntn8AyeumfReAfUXzBDbFurtTpniis/05aoRJLB0eflgE4JSCgIsg3T/MgFpFBoTbdLoFRQsN8dvPFyonVqDz/Q9AQvl1T9HcCQ6JRWiLcrHKw307nNAQRE5kGNg9NP6iEyNvCJBawD6cn7KPa6On4t1sZedaHxt7BDKPOnHSI+zR03v3/K1O0E2J9VVwofa2HSejnVSLsu21/+Vm1LMloyIdutiFgAX/35yrmN6O/uH2W0ErnLYpxm6h7OOX3I1Xc023v+t4GxcsHKEl2WmzXACyV4zn45z3rWvsQJftiJS0O7TEe4yErlDYk4lWPKg4oi3judQbTGqz/9xKHLsNrLVyE256qWCHpUIhnn1b3/+3Sl/oZtsXFzFaVnLvROwcRIuNCuBUXC2YfdYAl6lhAYX0cKJJtDg0wf2HX//1p7//We3//1kiBCexAMAAAA","feat/dizzy_eyeL.png":"data:image/webp;base64,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","feat/dizzy_eyeR.png":"data:image/webp;base64,UklGRk4QAABXRUJQVlA4WAoAAAAQAAAAXQAAewAAQUxQSGwHAAAB8HVt2zFJ2rbtPcZ5noG0bbNamVlmFruUUZFlpLq6bNu2bVy2jSlzrv9HzO17XDqP7TjOIxqzETEB9CU5q2lKfHDDli0bBhaMacv7bKmZvfEys6iZ+cxAd9Zng9u+6iKLSf7DtrHpKVfYd57FPP94ZUlKlQw+k6B5qChlClc9Exu/syI7JdL77oitjyaG7as6JBbz8TzLovEXYvftGqtyd4r1L99z7Ck/JynIyzxbqh9Lag64doxPSKousaKPxSz/6+zO1fNnTOqdExvaf/WNGRltwWIx+sdjS8fUZDik9HJbYvtemHhTH1ifGOSv9zemk35aw/JbenIhP6DJrMc7x2eSYad05Qst2RkJpCoh2pdbXQqycoeWfBRE/kPRfTo3QgGHZr3UeVpqLnJONPmTYrKw/ISG7PJMOVtF81FniKzM2KvBY03NE80ThWRrxjZMbmSaKfm2xkg62Zu+B5M+I85pgXkBWZ19CXudY2I8Q4k2srz6LSQxA9kvBU3UkvXzsBcRvdWCJmrJfm8vJJO0qn6McDelYs496LLWFkHjlJrjGOE6jXpG1lGKercQWaexTsDzThDRorLyQs8UdTPCWNWvAC4hw17dlMFTT5hFTo9MqTGT/hpqhlYJ2Etm6xddYfFN/r+8nBw1QHMQWY/k/wzY7poIvb+bRe2TTCaf9Ub0in+MPEfGs+pxJhl87xAL7CMicqFCyxlCuAhYL0ruIv2sARbjb2foUDsDMldV+HvVbkev+pwEGtPJOoucU/WwgptJezZLwEs1nOUIu4r5qhFXx10mwfdh1MxIpWJQwdWkGRkQC3kUlnMFkJmKXYp1rkZ0UKx8kAmFdyM7/byzftxJeLhfLN0GUQy54Rf+p9/OiEYr28I9UDMD7PlE/Xgc4SX3xSA/unn1DmvJ9Qwk6ypS5JPmdyIfSz8l2nw83pIbDafXLzqsI6sRZyvS6RP1W+BiMdHlzY0eqduPabwpBGgBkFzg4/kcyie44Ns619sIzxzBpB/5kIG1PjQrIXKvkvA9orkrSrruMHY+AjQgW/y8Wec3lxE+ijViZDB0AOIOIPcFsN+PKCNEmtcE7yKjWQ8QiQPhM8B5lfYoxmKOGRrPyAHA2aWS+8ZuCbw8TKbvI0+KVbQOeGGqiqHdGWR8PAP8PjAEvHENHRP0YTWZj/wAkBnAauCtZyaXoSVOALQaWQIsB9jQBEHP5lOQYxlYDywJyn0JzaFAG5H9QD8SMlLOyPnMYLI/BY4Di4BXYSMzBO0jzfzKdIzOASeNPAsZ+QbyqBCr2cr8q2Zsn5F+4JFnIo+RjQT3sohIoh7aDRwHlgM3HRMtCPdAMfHfDu0HjgIjwEUyOVfAWzlICyuuhpHjwEFgF3DQyA5kB6FfE+UZF7kCbAROAetMOH9DYshUUfcRmPMp0K+K3ATiJnIZ4PeQ76iuR5EOVvF4VdZzYKKJeuRVCVDHqomELhSgQ1XNKm4w8QFyPgwsE+WLTGgH8LxM1YVkm5gr4A4HOKnaSmj274BLEVWfqB+TyZXIKgIfqhZBYxjYTOotwEEjW5C5QJRVvdAWAeeowheBuJHjAH8IFACzkHoGuFpV+g8Vt5tw7yKNQDUwAIQuCng6pBrDQJ6JDEbKgVrgapbCWSJonNQDov4KmcyDSoASQGJ+Xpegz4tU6aeBk0YKoGwgikg8wyGveLnAw6SuZhUvNFII5QB0G5EbC3qXnhH4TQnQK0CHkQKoGNkIGRwktbcRSESN5EEVSA8H8SofKP6tig+Q0SyoEckOZBGB4xiYbyb0CHkXoScBHHYBZ70ADWboPCAzoA42xqUElv4KSJD7jpE9yABE14zNJHSuqHmIDA8hB7FSNrSW0MxvIKNMzUJupUHOTDObolAPAwmH3jHTwQDXQeTNYz0eSiPU2SxqHibTJYjMxSg05pbOwwkRgmt/ibQZS4N2hjGi0rWMfDteRJrrBbxH5n+DPCzToYz3lp3j///71inFYdKs/jnAcwLoR2SWo0PkpJe1drbUFEY80vUuCVIUQCsju0J6AY5hZIQCzISeV9mTdVf8k8mkVAdBrxBZac9OUSeTH1Og46C7hbZ0sSqZlMpgchiRpZbkXBdk0A2GrkLPKq3IOCbIs3wKuIkR2eFaEN4r0BwKOvQWkvnBecMCn0sPjGZjPCGo0KBIMgl0U/ClDEmiOhh3vfgk/ba5Fjg7MEn0OAGEt4q/3+MysrGAMeGVEWPF50VzDlnpztYQ2Z1nJmMui+b2sB2UcU1HHnZ7erlTr4nu1WKy9QPWET4/KhdwvLTqhVdF+20rWet9oiXCP1rb21GRk51b3zV3+BSLwbhnD6Wf0vt//ueF0xefspgdiZLNRbeMBLo2neyufG3XmijZ3vQ1i77dHyL7W79qzdNWSsmWF5acLaIUrb9iA8dDlLLFu4K70UCpnBG7Gcy3+9MoxctW3zX30+Ey+gysWHKajfxiuJY+I/N6Pr7EGJ9fN7vKo89Op6R73sjuY2fOXzh7eN2SGa05IfrMDaVlZGdnZUYd+pIMVlA4ILwIAADwJwCdASpeAHwAPkkcikQioaEcWi9EKASEsYBiaBDqXlZZJ6Ztv7zz3nmb8d0V9ux/0D0CeFf5Tl01QTtXfhujuyvAB1U2ovFMeFPQA/QHqxf2/jT+rPYH8sf1+ftv7I/7PNtwuKJTPNN8h7mIQBcdpy8kJ2cVinO3jgLRVTyIfOe5dinaWfRPBbW+SKvpHcX4yGMXJiDAeQea5YSQymXPmd5z7MIbsagMBIMcAkofxx8bx/XfXjXFa20lttUxR1w247zadfcovh64nKg6DD/qhmiDXYyoRieiF/sWdINMjdERe0utJ6psQXQmToXz1eItD8cznqV0Zk3LYYhtRBO4wIC/czpxZt+fTM47rlNllxCersfaaPjqiQu8/4O8FvFZPPaR8crdMTafvN1ZawfsyPvJ2HvE75npEpWuMu3AZdgftY8ocoaQAP7+0B0/kko6pGCjks9bXVoRksVFofgm9MN/lWG9bMbzH4nsEilc6v14HbXwTqrnyqxFFIU9okWolesa4KJ2QTfg9iHRgd1GmY5qcpdik96WykNxvrebK26ZBM0XChmh7vtdppLgyWwCLmvqlHbHpl+UIUC+ZQZdpLsWsg84wON2bn79sY0ytsvn5HxIFcfiuvsinWuuZPizPgss2WESPZYOztzg/DnUdQdMys66Mv5Nc4toR74H3eZDe8hGbQRGfQcfZHBMTGdVw9OWB16EKN33ytufMbd84z5zVx+QjohG30t/QI4aP/vXV1gKiXOQmQPixXBGZ/ovszndYN4zlJzqN2sr/BVibXtVIB6tbejCDpXO3hjf9uhHEC6AKlxQFwZ7v5c/e48ow2N3wmxQqZTxL/sR+E1likrWCXiHf2xgP1ZNSgsCYT8MWniclie+HvoC/PXOOz62edczwoN83ujqkCH7IWOxHfr/ovl5SKkVs7x/vKk2gzjAiBx5MqwDg4bGjdXleapne1BpauAC2nW/Clwt81KePi5DTb/ip9liUUIxUnxFHi8eTIxjm4xF6d047KXk2TzPjTce/A17xDrFmBnAPpaIZo2AbiMrXc6ZKz4oETKmlgf7JVt3A/TAIBa7Zg5lMhQ6eHoyy29eLtqjhPcVb2jZlTAUy3nyTz+G1ncYqX5ymXld/0YYO19hK29DZV/1Ge+g4TrT5RdDQHYPFDEY5NDXH/lopVTsp51BOtMvus/qkXnwkENsY9/LGIg+vh8pFvCwEFOdLke31DP+jABAxnGVGvlxvab6Sm4hHtkoNCQ5PUK5qPp3ubHfIZlHsVd9Xq+TgzeArtVkaYvR8s4OjNYvT3A7kZgcvbs3yV+VaJ00Oxx2p0vzFn6hbLseQNGooHo50qbrH8JeJnJ25sKyV/GVtcM4XjcJYbcAA5o6k1okbrdH1JQIF/WsyvB9RO+qcP3/Okn6OLB/C+id8ym1w3NAJq+n6AFYuIE3dug5rlmOlBxUrjiMRE/Zr1j/+TYf/0xzeWFNR0pPaFufzo6JmQ683ctoK/9eGNiTFBLHa5VFmX5f6nAnWkIjRHFMneJ8XFf4pN388wvWvsls8IHhwnrzK1ZaChd5VfRSF5cnMbdhDEs1PiDTZ93S36hKTCaiPXCVc6VARgmx38ZsSh8du2QLoBOXRErEFNg9wCfviPZDdP9cb84yOSYCgQCnrLi1nYU8twKQfc4QwMY7Xioh9t0H0sDS6NaGoksy32eWSqudYAWvlrbQGOsyPdg5ZmdeV3W96We2n+z25vLQKw/DShZCL4p8UPDPQub/DjOeYreEBPnsX3//SfLkPTwLO8Hs8wz5PDrRdDQqCfDzSN3mx12zAfVYvrj61BEQCAiKrVTdShkhi+jGjMvHLY/uPjeoZeYYwqYngk4CjUy5cWHa/2DJ1QD0u3I2Xxy8AcpwL4bLPS/dd/Bb7tE+Zv3JQreIBrw/nHoPh2A2H6vy8x6H5x0DTAuLrAN6TT5qdi/+gJr44V8FSiR5OGikdENz/YMfAkIMIm9VTAqNi7VMMo3Ni2bWhWW3mKng7yiu6KyFj8TuCTXWlMkFgJkTIohpIMdvdmeHrX+Rz5SbeaOEX6k44bH9D3mlOlAYyDzTXToponuM4AGSnUQe4saGTy5UP8144t5jn5Ndu6s0xBlO9nF8MD2KNTjy/TKhInDmOoCButmCYOrzzEhYlghTNeykzyLCal6CMqfD/zja2P5g/fxlYCiiqQOmwk0Ptf1hgpkgcli/suoCWVKjfL+Fys25c/wHak+IQK2j9KNIVKAjW2kO/ilXXxS32ctBxKnoWS6VevQvD7Ps8CgxQNZurVqk12xvQ9gXDY3Y6kcPhdWnMNx+fmVPOV2W5IWCBft2JjLdog9+fhuqaOczvA3wNdKVZs17abqxrw+GkSLu0rg56Nj1zQMyFjvt5PeWLlER/3bM2/Cq3Xyu1b4G0p2lNK41DMAiNFbAmOvMnbyNCiPRa+3FrxAYPSMjs4BUXDXEeHNre4MPDBBQ9xdm+uuZyk71Hwe9iDv8cuv3dMX+OqS1aOnsvf+k+76XedQHGQECVVoDNjL9/pdpzB/Nm2Ebw2LBD0goLfjs5MHBpZzj3lzbsgEhSRcsyyKOj0kGu1RM3blzzldq1So64ocCznbUNEnKb80TB++DuxsUyFc1x7OWVT81jtr22++7HR+cUnIQxSL1z17DU+ojs1vqPjBtyvkZk79cmYEbaVhD+YkbMeu7LSQgVvDrlD4ML5zxpOD2EzXts3DlQPV15hMgHuyhNh7iQW1GX6uJh71+yATSdlAtWyCL+AXULrN5h2Pwe6cMbaQ6mS9p6lmEkiq7dukO+VAI+RCESOBJxY0CsFBiUCokj4vf18LskV4u1qtglkJ3pZR5SD2ZYqwynt2nooblUbdA3BNXosfwAqujNCG4chOAKWHkO2Gv+1No6vcNQjcPl8xx24Xn3pbrsxeMttUKLKlbvTPQA7RTL0TFjXA5B57Bgr1ZquRlNFUzX/l2rfgAAAAA","feat/dizzy_mouth.png":"data:image/webp;base64,UklGRiwDAABXRUJQVlA4WAoAAAAQAAAARgAAEQAAQUxQSEwBAAABkGvb1rE9+7dt27bZ2rZtxrbtpErl1LkAXc/fnVP9z3OeJ6wjYgLwP+sSXz+6urrUm+NmIbplbmNjrivRxK2spyXYyK/54A3xUbrY6mkQPf2clT9XwkS1l4j5a6rMo/4ii+8kSFzbn7HwbYPOZYL46D1vScQOseGnFl3gBstpQuW7zWpK0Dk3PmWLK66K1JtsvO0DIPwia5/6aFzHiK1ejQf8Rogtvmgq6HjB+kao3RfY+pljz/mXUyvUbhss/LI4NDh5SyD+OFreuGjjYja0/ax/NxAOAH59ZOFUCABUPDAad4U29JvubBS0BXdMaBjqwFMy6oUwi1Q05QVhwLbsZT70XvOS1+WQRh0qXpW7QezWRzo65Q2pa9trFV0IhLz0kIlGA2EcMfqCiOjHQhJMQzpOPHx6eSIXxqENZUGw6pFSUJjuBavunvi/BVZQOCC6AQAA0AkAnQEqRwASAD5RIo5FI6IhFNqttDgFBLKAYnrAQZrbc8+ieAMoHgnpApofjcot/WACzx0rqusCD5q+QgLFg7JXDHqBc6AvbJFJz0CJIDnqriunWFUQAP73eZ9aSRow1J3qAVlegvrpfhIS0u5OYdjV+Hl043Y5cbeIhDJMbuYlHmwjyzB2ra3Lj9kV2BQfoJTEqWhKZdsmE4Wz7sI4Zpp9SWaViAxa/krmfg+weknP9qlJ7aaMy0azijsxpZngPWQ5tiXLf0o3ET87Vwm8eCzxlsS6+r8951bhj5EzK9j8QGRXZ7k9nqOK4GIMVlPs1OnQpfQqdsKU4ZzWnEX99QNLT61iJOQJAjzqdz0rbxm8Bb1gI6XJuBDZp5GIISr8Vz9IuBAiuJUuKAFqRVKDcndbw/0Af3KbWh6lTz/TkZ12JjtZBdKf+m+HJvsOIOVHVHk3Sry2hJE+BJqjxwE2etjT8xZgmEeM0SR3mXfj5wakoU20zQvQiBzzHhHd+AA2dEXd6Fv5TbzlZIt/WePSOS555DiO/B9mBRLktbUh0CNak04me6gCE+6G5VQj89N/S6bDi4EUoAAAAA==","feat/surprised_eyeL.png":"data:image/webp;base64,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","feat/surprised_eyeR.png":"data:image/webp;base64,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","feat/surprised_mouth.png":"data:image/webp;base64,UklGRrIDAABXRUJQVlA4WAoAAAAQAAAAJwAALwAAQUxQSEQBAAABkELbtrFtp322bdtotm3btu3fSF/6lWzbtplsp1t4fvSImAD4byqqayjhKQb3bDh44vDWqUgFFL3q3e8J/fPueHkaVWcJ97thWSG7ifCAFOWOj0T8S7wEjSki9bi+kNo8kVwkojBJZG9REOgm0l+58mUTxFIu1wsYK3jUNhPMXVocpQT1nCnL7jTOIy9WF8F9E85wOI30IYZR9w3pTRjNZBtBfu5HS3mFdcORNk+wDxhQLI+irQdqxG+0JloJ2it/2ijB3g1UlY1oHTTDI1hf3GkW57C2Ad3sBFYhQ38n0iVNhuoSUjewJ3HuG3GU4dQDp/ddjO3Aq7QW4aUHFyS8kfY9A/hVlqQ1g6jHRUlDIB7/WsbvFpCZ81rseAzIDTss8LjdCGSb113iuNrqAphGGdP77758sKsnQgvQVU3MTBTg/whWUDggSAIAAPALAJ0BKigAMAA+USKNRCOiIRVdVqg4BQS2AF2ZuQVUsLxFCxee2wHmA/XLqc7wn6AHSR/uwWmJnIblj7T/4on6elljo9bcvDTVOWnPSh+vILhTXzoJTJm5T+J5KaLDdHKhvjn+qoyAAP7/VqkLxWCAFBZ4/PS01fTeSGcQYhJsLaO92299FVm5wGgX4H+SH37T24SlwjmuhIfhGGP/c/sPgf1iUtHH1auBMgeZQLoIAIxGf9ZFJ8O+1Wc9+3U4XLqJuIl16oqMCZyjoUidvapfuKQf+R3b/UV+1/w1y42d/JNM9v/xn6JMxj44sa0saaMFPA+ejL7jwqoiEGbAW0JQm8ziB5zpT3G033YpF8cVvvC/RCjVGVS20YdRefndaKzj1wWdMcVOVCURzYe7lEbHRD8H2wflfZLVflmUqX3UEoaTnS7S8w/6fG6kfMGnAvHD/J3JREvoc0AGAKc7d7cirj0J94zlP/h17/bFDYeCmn/SvBDmMVWXEv94iZTkYcYFs64GglIZlfIO0quBibTaaqR7oYqTxwfvDxS3qtx6Gx/JjR/dJEveEz+lO+eJoxrC6306oXmXip28LBaCU9EzFi8tpbmOMi4mxu3dPTPrXLquUbK0MN9TEWCfYvvntHtfP304clgx7rNmAWYUA85KETm9HuYblxoMHUqqe6VnxV+iF0qfXFcHBGMUPWs4mq16s48tLgQwxN82C4G3O1GCS/1Owd6yJwiAH5zX9M2j//4TlgxkBkbt3kK38f8XcaOOOq6DAAAA","feat/eyeL_lash.png":"data:image/webp;base64,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","feat/eyeL_ball.png":"data:image/webp;base64,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","feat/eyeL_iris.png":"data:image/webp;base64,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","feat/eyeR_lash.png":"data:image/webp;base64,UklGRs4FAABXRUJQVlA4WAoAAAAQAAAAVQAAUwAAQUxQSL0DAAABoLVtmyFJXtEb8cXM2rZtm2OcrTlc27Zt27Zt27ZtdMcX8R5UZlZkVETEBCBHI85ZK86JQSGNOOfQVMQUwDp0Dhx00GmPPHrJYeNWcgDE9JgIMPOQgw4/7X3Wv3vhoIHobWuAJU/6np3Be1XvNZJ8a/zAXhJgyB19pHrvA+uDBvKtMbZnBPNfRNJHdh+UfHXNHnFY42cGjUwbyHjRNL3gsI2nskUlP18tP4dtGAPbVfZtm5vDNtTIDI/Oy2EMNTLLk3ISrPRPCMwy8KB8LOb7lYGZ+rhJLsZO/hKV+f69BCQLweX0zDfwrUmNyUCwO/uZs/JkSHti16GPWVF1XUh7eIzKzOIT0ppgOyq7jFoZ0lG5NVw71qwQQmwUfGBtVI2JQvh4RmtaETxOZX3UQPKXJx7t/JIkNSYheRZaFQylsj6QfPuwQdOjcoqVtnm4jwxJIv1SbRg7yfsMdcr+SwZNAsBWAsCSl/ZTU5B83LQgGEtldQh8egkATgwqjYgF1nibISbhmHTGzPBdDFVK7j4ATgyaW8HA06ghQeRPMyUTHE7PSs9XBwEWCa3BNmTojuR1qYyZ8ecYK/p5w1RwBkmNw8a/MqTgBokcJlJJMiovFDgkd1jp5xC6C/xx1iTGuvdiIKnkpYBFiwMxmCF2RfIBm0KwE5Wk5x/jIQatOmxDTcHDExgz068xkp4vLgxB+5czady6O4etqaTn/dPBIcOpPk8R6bcETDOLR6NG5YWAIMvRKRgZDzJwpoFgPYYYuDusRab3p2Ak75kNcLbG2kfpA7eBGOS6QkxBBv66vQDWdFgs6D3DZnDI+IE0VPLtcdOgUnBE5H8j4ZDzqEQMSv5360oAjJniW/6yOhyylm8SMSh/2E4ACDbnTyvBIfNT00Rl34nToNPIF98vD4fc10oRPXnngoAAEKz/7uwQZO9+607Jj0cCzgCAwcozQtCDt3cTlX1HTgoIGhr04t5dBPKFJQBnUG8MenKdZp7+EAdn0PvTNlJ+tTpgUcRvm/C5WeBQyCebPDA5BKW8usEzk8GimCdXRf44G0q6fxW5FYq6Q82bpixjasajrJt1RP4zZWE26SBvRmE3q9q6NGMqwkyl2b7iBZR2n4pDinNsxZLFuajjHRT3ro4DyvMqSZ2zPL+QvBvFnZYkR5dnJZIf2/JsRXI3lPcE8repCnQfeSwK/AP/naVAc5NnosAb8f85S3Qaz0WJX/p/7hJN7c9FiUf/N2eRTj8TRX5jtiLNewqKvOMsZToKZZ6xUKZQGQIAVlA4IOoBAAAwDQCdASpWAFQAPlEkjkUjoiEU6u1wOAUEsobgLEADIuKGqaPO28fM5ahf6AHSxERaKMiTFZDG9OqWqwR6HeZeeuH75WLnnHnBqMQrc5W/yFWD1ctnMmlsFR/gc0ykMaBa2w/Kyak4TIh4Xvx5kJr49AAA/v85vV74ITjrvcw7b+/lFKk3iSXs/ubTG79ATPrea7XJBGe9ZGaYyWv7YX//gfNWxYAz0aBx3o8e0cILdP9rVAeRFDCRNyXTIM7HgiKBA+/9evGAYBn6RUUvmzXgUWRMDUK+T4E9sckMAnwx0CVWuYaqII9xtbmO6OcB8bbZxLa4zMLHAtHCL6AglHzokw5LskeqtOMNUSgXXv81lv3CnnOZVDEgYr9prwWqe0mypEZ8NDakOYd9AuaD3SC/wrtUx9fOZYskPoSq8i1iXiPsTfkuN5v2XNR+DUd7Wh5lYAJ/Z/47DFgkn/AGuV5gDMlL1M4q8mQozIPEjsi4Gq1+QwxZKJINLBO+iJozANjK9JZy8XiEBhRFxBr37hvJV/nd92C5AVKd+eOGlNAdVzueC/+YjwZc7C6H1dtjv/510Rfimf6AuNepuCAH7I1UdIUDATtn5zpBdUZlxVSEgElmuP1lSxEWdp//lbLBDwQQFy1Wh9IMAAAA","feat/eyeR_ball.png":"data:image/webp;base64,UklGRo4FAABXRUJQVlA4WAoAAAAQAAAAQgAAbQAAQUxQSGcEAAABsLRtmyHZ9pbe7/timb3tvWe2bZtjTW3bxsy912jbtm0c2+rTtbbREfG9g8rOyoyIiAlAgTKMekWDKYbVgkkNYhieM7Z4bBGG1aQwNSCsd/T4y38dDAYTrz9y3u7LAAhSkBiw4sW/imz9/8cPmgmYlGLA2rf/h2SKKbu7pxQzyS9PXwHQIkSxwk1fkSk7W3tK5D+OnQkrQIF9/0lGZ4c5kr/YHiZ9GcKtZHR27JHxZED7MSzzFpOzx0zevwysj4Atf8fEfj3yg5Wg3QVsOWBk71P81UrQrgxbDphYYOSvlhHpxrDhgJlFRr5rJl2ILvsFEwuNvAmhC8OLjCw28gjYaAEXcYrlZv/fSqqjKDadSl4QI5fARhANnzCxZM8/rSPaznAcE8uOvBPWSmSZQfbC3CeWh7Qx3MTE0hOPRmghstyke3n+NLRFwEVMLN45WA4yjcicP3ouj9l3gE1j2J+ZFUaeiNBiiccaEp+ANQnm/pNexyvQJsO2KbPGzL8uEGkIuIyxCufXy6BJ8RxTJZOLmwTz/8ZcydLlmhSbZmed2XeEDQUcy1QL95juGsY63L9ZHTqkeIapEk4uhAzJzF8xVzPWoFjrB/davlmmwbATM+vM/OUcGQo4iqmSxFegaLiGsZpHmhTPMlUSeSkCAMHcvzFXknhsg2LN790ryXlbGADDrsys0/nNChAAAScwVZL5q9kCAIZHq0l8FgpAMPcf9EoiL0YAYNg6ZVaauRcMQMB1jJU4v18DCkBm/Za5kszfzhQAhs2zs9LIcRiAgFMZ6zkJoeHSejxuDq3MObEQAsBwOFMlia+oAoBi1W/pdURejDAEsU+Y68i+K6zBcCdjFc7JZSANARdVkviKKBoNhzFXEXkxwnQ7VZJ9V9h0u9XhXLoMZLpd60h8ShSVRZ6EUJvnLaAtdqki87ezBC32qCLybth0ii2jV5C5fxvBokl6cc5/LoC0GRtUkPgYDK2WVnEMQqvFE+U5v1kJ0gIqrzOVlvgUFK3wWnmZB8BaGW5hLMz5nwWQVgFnFxd5BwytDfsyF5bzlqMo1v3Zy0r8UBXtBXP+ylzY0bARoHiOqSTnf+aJjBJwFWNJkXfCMKrhMKaC3H9cBzqSYtXv6eVE3gPD6DLrt8zlZO4iXRjGGYtJfBWKTg5mKiZzF1gXgtW+oxeS+CoUnYp9zFTMLrBuAq5nLCPxeSi6NWydcxGef1q7M8jM3zCXkLgEhq4DrmcswPNgJdHOFOtHLyDyeBi6V7zC1Fvip8GkB8Ou/Xn6eiMo+jQ8wdTTFM9FQK8qG32dvJfIhzSgZ8O5nOoj8U9jIn0h6Iuc6i775BZQ9C6y7AeMXWWmbWAoUDH2Fqe8k8R4JAKKVITbyegjeeRgexgKVeCYf5Ipt/JIvrcpAooVxSrjP5E5Jh/OKZI/XxxgKDkA61z0a7b9aXwDQFG2GDDroJtemxgMBoO/Pn/62oAJilcDgEVjixcvngPAFFWKBUWjBUXF0ogiAQBWUDggAAEAAPAJAJ0BKkMAbgA+UR6NRCahoRdd/NhoBQS0gGrB9AKdkEQAEH7ddeJtPj8AV1hv7dEffyelxjSQgQtNUphb/hjBtb6SCsdlStDYinZe0I15+SsT9X3eCgAA/vev//9Df//oWL//0ADP/JLRCV+gkGsWNB3EapjKNxQ8rR/ihbKREsjj/5W+zhp7/aFLND/RcgtUhED+qqI/ePUDBsGdviXnNeNMFpfS/hhZP7f15LTH3ThIS/i6KyBECE5P3fLO2OChjqx9w3uzSNriM2GuqH/xZl///oix5W+IE2WN8DscixXklousqPJ//opRu/n//07oFkkrbp/+in//6v8AAAA=","feat/eyeR_iris.png":"data:image/webp;base64,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"};
    var PET = (function () {
      'use strict';
      var rig = (function () {
    /**
     * A small Live2D-like renderer: textured grid meshes (parts) hang from a tree of deformers.
     *
     * Every coordinate is in one rig space (the pet's logo units: facing right, ground at y=256).
     * A part is a texture stretched over a box in that space, cut into a grid of quads. Each frame
     * the grid's rest points run through the part's deformer chain, innermost first:
     *   rot  – turn/scale/move about a pivot: p' = pivot + t + R(a)·S·(p − pivot)
     *   warp – a displacement field over a rect: p' = p + fn(u, v), u/v = p's place in the rect
     *            (points outside the rect take the field at the nearest edge)
     * Deformers are defined in rest space too, so a child always acts before its parent.
     *
     * A part may carry a second texture under `<tex>@mix` (same layout): `st.mix` (0..1) crossfades to it,
     * which is how a figure fades from one colour scheme to another.
     */
    
    const VS = `#version 300 es
    in vec2 aPos; in vec2 aUv;
    uniform vec4 uView; // x0, y0, 1/w, 1/h
    out vec2 vUv;
    void main() {
      vec2 n = (aPos - uView.xy) * uView.zw;
      gl_Position = vec4(n.x * 2.0 - 1.0, 1.0 - n.y * 2.0, 0.0, 1.0);
      vUv = aUv;
    }`;
    const FS = `#version 300 es
    precision mediump float;
    in vec2 vUv;
    uniform sampler2D uTex;
    uniform sampler2D uTex2;
    uniform float uMix;
    uniform float uAlpha;
    uniform vec4 uTint; // rgb multiply, a = mix toward it
    out vec4 o;
    void main() {
      vec4 c = mix(texture(uTex, vUv), texture(uTex2, vUv), uMix);
      c.rgb = mix(c.rgb, c.rgb * uTint.rgb, uTint.a);
      o = c * uAlpha;
    }`;
    
    function shader(gl, type, src) {
      const s = gl.createShader(type);
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    }
    
    function createRig(canvas, model) {
      // the canvas lives in an SVG foreignObject, which the browser may repaint from the canvas at any time: keep the
      // drawing buffer, or a repaint between our frames shows an empty canvas (flicker, worst in screen recordings)
      const gl = canvas.getContext('webgl2', { premultipliedAlpha: true, alpha: true, antialias: true, preserveDrawingBuffer: true });
      if (!gl) throw new Error('webgl2 unavailable');
      const defs = model.deformers;
      let view = model.view; // [x0, y0, x1, y1]
    
      // the source each texture was uploaded from: a lost context takes the GL textures with it,
      // so restoring means uploading them all again from what they came from
      const textures = new Map(), sources = new Map();
      function upload(key, src) {
        if (disposed) return null;
        sources.set(key, src);
        let t = textures.get(key);
        if (!t) { t = gl.createTexture(); textures.set(key, t); }
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
        gl.generateMipmap(gl.TEXTURE_2D);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        return t;
      }
    
      // deformer chain per part, innermost first
      const chainOf = id => { const c = []; for (let d = id; d; d = defs[d].parent) c.push(d); return c; };
    
      let prog, loc, meshes = [];
      let shaders = [];
      /** Builds every GL resource; called again on `webglcontextrestored`, where the old ones died with the context. */
      function buildGL() {
        shaders = [shader(gl, gl.VERTEX_SHADER, VS), shader(gl, gl.FRAGMENT_SHADER, FS)];
        prog = gl.createProgram();
        for (const s of shaders) gl.attachShader(prog, s);
        gl.linkProgram(prog);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
        loc = {
          aPos: gl.getAttribLocation(prog, 'aPos'), aUv: gl.getAttribLocation(prog, 'aUv'),
          uView: gl.getUniformLocation(prog, 'uView'), uTex: gl.getUniformLocation(prog, 'uTex'),
          uAlpha: gl.getUniformLocation(prog, 'uAlpha'), uTint: gl.getUniformLocation(prog, 'uTint'),
          uTex2: gl.getUniformLocation(prog, 'uTex2'), uMix: gl.getUniformLocation(prog, 'uMix'),
        };
        // parts: rest grid, uv, index buffer; `uvBox` picks a sub-rect of the texture (atlas), default whole
        meshes = model.parts.map(p => {
          const [nx, ny] = p.grid || [6, 6];
          const [x, y, w, h] = p.box;
          const [u0, v0, u1, v1] = p.uvBox || [0, 0, 1, 1];
          const rest = new Float32Array((nx + 1) * (ny + 1) * 2), uv = new Float32Array(rest.length);
          let k = 0;
          for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) {
            rest[k] = x + w * i / nx; rest[k + 1] = y + h * j / ny;
            uv[k] = u0 + (u1 - u0) * i / nx; uv[k + 1] = v0 + (v1 - v0) * j / ny;
            k += 2;
          }
          const idx = [];
          for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
            const a = j * (nx + 1) + i, b = a + 1, c = a + nx + 1, d = c + 1;
            idx.push(a, b, c, b, d, c);
          }
          const vao = gl.createVertexArray();
          gl.bindVertexArray(vao);
          const pos = gl.createBuffer();
          gl.bindBuffer(gl.ARRAY_BUFFER, pos);
          gl.bufferData(gl.ARRAY_BUFFER, rest.byteLength, gl.DYNAMIC_DRAW);
          gl.enableVertexAttribArray(loc.aPos);
          gl.vertexAttribPointer(loc.aPos, 2, gl.FLOAT, false, 0, 0);
          const uvb = gl.createBuffer();
          gl.bindBuffer(gl.ARRAY_BUFFER, uvb);
          gl.bufferData(gl.ARRAY_BUFFER, uv, gl.STATIC_DRAW);
          gl.enableVertexAttribArray(loc.aUv);
          gl.vertexAttribPointer(loc.aUv, 2, gl.FLOAT, false, 0, 0);
          const ib = gl.createBuffer();
          gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
          gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(idx), gl.STATIC_DRAW);
          gl.bindVertexArray(null);
          return { part: p, rest, out: new Float32Array(rest.length), vao, pos, uvb, ib, count: idx.length };
        });
        meshes.forEach(m => { m.chain = chainOf(m.part.parent); });
      }
    
      // a lost context blanks the canvas; unless the loss is preventDefault-ed the browser never
      // restores it, and it stays blank for good. On restoration every GL resource must be rebuilt
      // and the textures uploaded again from their sources.
      let lost = false;
      canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); lost = true; });
      canvas.addEventListener('webglcontextrestored', () => {
        // dispose() during a loss cannot reach WEBGL_lose_context, so the browser may still restore a disposed rig
        if (disposed) return;
        lost = false;
        textures.clear();
        buildGL();
        for (const [key, src] of sources) upload(key, src);
      });
      buildGL();
    
      /**
       * Frees every GL resource and kills the context. Without this the browser keeps the context
       * alive until GC collects the canvas, and Chromium caps live contexts per page (~16): swapping
       * figures back and forth could exhaust them and leave later mounts rendering nothing.
       */
      let disposed = false;
      function dispose() {
        if (disposed) return;
        disposed = true;
        lost = true;
        try {
          for (const t of textures.values()) gl.deleteTexture(t);
          for (const m of meshes) { gl.deleteBuffer(m.pos); gl.deleteBuffer(m.uvb); gl.deleteBuffer(m.ib); gl.deleteVertexArray(m.vao); }
          if (prog) gl.deleteProgram(prog);
          for (const s of shaders) gl.deleteShader(s);
        } finally {
          gl.getExtension('WEBGL_lose_context')?.loseContext();
        }
      }
    
      /** Moves a rest point through deformer `id` and its ancestors, with this frame's states. */
      function applyChain(chain, st, x, y) {
        for (const id of chain) {
          const d = defs[id], s = st[id];
          if (!s) continue;
          if (d.kind === 'rot') {
            const [px, py] = d.pivot, a = (s.a || 0) * Math.PI / 180, c = Math.cos(a), sn = Math.sin(a);
            const sx = s.sx ?? s.s ?? 1, sy = s.sy ?? s.s ?? 1;
            const lx = (x - px) * sx, ly = (y - py) * sy;
            x = px + (s.tx || 0) + lx * c - ly * sn;
            y = py + (s.ty || 0) + lx * sn + ly * c;
          } else if (d.kind === 'warp' && s.fn) {
            const [x0, y0, x1, y1] = d.rect;
            const u = Math.min(1, Math.max(0, (x - x0) / (x1 - x0))), v = Math.min(1, Math.max(0, (y - y0) / (y1 - y0)));
            const r = s.fn(u, v, x, y);
            x += r[0]; y += r[1];
          }
        }
        return [x, y];
      }
    
      function render(st, opts = {}) {
        if (lost || gl.isContextLost()) return;
        const W = canvas.width, H = canvas.height;
        gl.viewport(0, 0, W, H);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.useProgram(prog);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        gl.uniform4f(loc.uView, view[0], view[1], 1 / (view[2] - view[0]), 1 / (view[3] - view[1]));
        gl.uniform1i(loc.uTex, 0);
        gl.uniform1i(loc.uTex2, 1);
        const mixK = Math.min(1, Math.max(0, st.mix || 0));
        const order = meshes.filter(m => !(opts.hidden && opts.hidden[m.part.id]))
          .map(m => ({ m, z: st.z?.[m.part.id] ?? m.part.z })).sort((a, b) => a.z - b.z);
        for (const { m } of order) {
          const p = m.part, alpha = st.alpha?.[p.id] ?? p.alpha ?? 1;
          const tex = textures.get(p.tex);
          if (!tex || alpha <= 0.001) continue;
          for (let i = 0; i < m.rest.length; i += 2) {
            const q = applyChain(m.chain, st, m.rest[i], m.rest[i + 1]);
            m.out[i] = q[0]; m.out[i + 1] = q[1];
          }
          gl.bindBuffer(gl.ARRAY_BUFFER, m.pos);
          gl.bufferSubData(gl.ARRAY_BUFFER, 0, m.out);
          const tex2 = mixK > 0 ? textures.get(p.tex + '@mix') : null;
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, tex2 || tex);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, tex);
          gl.uniform1f(loc.uMix, tex2 ? mixK : 0);
          gl.uniform1f(loc.uAlpha, alpha);
          const tint = st.tint?.[p.id];
          gl.uniform4f(loc.uTint, ...(tint || [1, 1, 1, 0]));
          gl.bindVertexArray(m.vao);
          gl.drawElements(gl.TRIANGLES, m.count, gl.UNSIGNED_SHORT, 0);
        }
        gl.bindVertexArray(null);
      }
    
      return {
        gl, upload, render, dispose,
        /** Where a rest point lands this frame (for overlays and hit tests). */
        point(deformer, st, x, y) { return applyChain(chainOf(deformer), st, x, y); },
        setView(v) { view = v; },
        get view() { return view; },
      };
    }
    
        return { createRig: createRig };
      })();
      var figure = (function () {
        var createRig = rig.createRig; // 取代上游的 import 行
    /**
     * The DeepSeek whale maid as a pet-core figure: a sprite rig drawn with rig/rig.js.
     *
     * She stands the way Coo does, three-quarters on and facing right; pet-core mirrors the whole
     * group when she turns. pet-core runs the body (walking, jumping, dragging, faces); this file turns
     * each frame it hands over into rig parameters, runs springs for hair, skirt, tail, fins and ahoge,
     * paints the face (eyes, mouth, blush) into a live texture, and draws the rig into a canvas that
     * lives in the pet's own SVG group, so the stage's transform (position, squash, tilt, facing) applies.
     *
     * Every layer was cut from one master drawing, so at rest the parts line up pixel for pixel;
     * what each part hides (the dress under the arm, the hair behind the face, the legs under the
     * skirt) was painted in by edits of that same drawing.
     *
     * Rig space = pet-core's logo space: x=128 under the body, soles at y=256.
     * model.json keeps the master drawing's pixel frame for the face sprites; U/V convert.
     */
    
    
    const f1 = n => Math.round(n * 100) / 100;
    const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
    const lerp = (a, b, k) => a + (b - a) * k;
    const ease = (rate, dt) => 1 - Math.exp(-rate * dt);
    const bump = u => Math.sin(Math.PI * clamp(u, 0, 1));
    const smooth = (a, b, x) => { const k = clamp((x - a) / (b - a), 0, 1); return k * k * (3 - 2 * k); };
    const SVGNS = 'http://www.w3.org/2000/svg';
    
    // the face texture covers this rect of the master drawing, one texel per master pixel
    const FACE = { x: 520, y: 578, w: 390, h: 252 };
    // the head's parallax warps act over this rect (rig units); the long hair below it stays put
    const HEAD = [30, 12, 215, 168];
    
    /* ---------- springs ---------- */
    // `lim` bounds the output: a hard throw may overshoot, the hair must not fold over itself
    function spring(k, c, lim = Infinity) {
      return {
        x: 0, v: 0,
        step(target, dt) {
          this.v += ((target - this.x) * k - this.v * c) * dt;
          this.x += this.v * dt;
          if (Math.abs(this.x) > lim) { this.x = Math.sign(this.x) * lim; this.v = 0; }
          return this.x;
        },
      };
    }
    
    function loadImage(url) {
      return new Promise((ok, bad) => { const im = new Image(); im.onload = () => ok(im); im.onerror = bad; im.src = url; });
    }
    
    /**
     * Loads the model and textures; resolves to a figure object for createPet's `opts.figure`.
     * `opts.raster` shows each frame as an SVG <image> copied from the canvas instead of the canvas itself (slower;
     * for pages that are screen-recorded, where a WebGL canvas inside SVG is not always in the capture).
     * `opts.scheme` picks a colour scheme (model.schemes; default the original); `opts.model` (model.json
     * already parsed) and `opts.asset(path)` (a texture's URL) are for pages that bundle the files.
     */
    async function createWhaleFigure(base = './', opts = {}) {
      const model = opts.model || await (await fetch(new URL('model.json', base))).json();
      const asset = opts.asset || (p => new URL(p, base));
      const { S, X0, FEET } = model.units;
      const U = x => 128 + (x - X0) * S, V = y => 256 - (FEET - y) * S;
      const PV = model.pivots, feat = model.feat;
      const EYES = ['eyeL', 'eyeR'];  // near (left) eye, far (right) eye
      const featNames = [...Object.keys(feat.sprites), ...EYES.flatMap(k => ['lash', 'ball', 'iris', ...(feat.eyes[k].rim ? ['rim'] : [])].map(n => `${k}_${n}`))];
      // a scheme is a set of textures over the same geometry; the original's are at tex/ and feat/
      const SCHEMES = (model.schemes || [{ id: 'deepseek' }]).filter(sc => sc.ready !== false);
      const schemeInfo = id => SCHEMES.find(sc => sc.id === id) || SCHEMES[0];
      // the scheme's accent colours the listening arcs, thought bubbles and sleep z's
      const accent = () => schemeInfo(scheme).accent || '#4d6bfe';
      const loaded = {}, ready = {};
      function loadScheme(id) {
        if (loaded[id]) return loaded[id];
        const dir = id === SCHEMES[0].id ? '' : `schemes/${id}/`;
        const set = { tex: {}, img: {} };
        loaded[id] = Promise.all([
          ...model.parts.map(async p => { set.tex[p.tex] = await loadImage(asset(`${dir}tex/${p.tex}.png`)); }),
          ...featNames.map(async n => { set.img[n] = await loadImage(asset(`${dir}feat/${n}.png`)); }),
        ]).then(() => (ready[id] = set));
        return loaded[id];
      }
      let scheme = schemeInfo(opts.scheme).id;
      let { tex, img } = await loadScheme(scheme);
      const box = Object.fromEntries(model.parts.map(p => [p.id, p.box]));
      const rectOf = id => { const [x, y, w, h] = box[id]; return [x, y, x + w, y + h]; };
    
      /* deformers: each acts in rest space; parents act after children */
      const deformers = {
        body: { kind: 'rot', pivot: PV.body },
        skirt: { kind: 'warp', parent: 'body', rect: rectOf('skirt') },
        skirtSit: { kind: 'warp', parent: 'body', rect: rectOf('skirt_sit') },
        armNear: { kind: 'rot', parent: 'body', pivot: PV.armNear },
        armFar: { kind: 'rot', parent: 'body', pivot: PV.armFar },
        legBack: { kind: 'rot', parent: 'body', pivot: PV.legBack },
        legFront: { kind: 'rot', parent: 'body', pivot: PV.legFront },
        tail: { kind: 'rot', parent: 'body', pivot: PV.tail },
        tailBend: { kind: 'warp', parent: 'tail', rect: rectOf('tail') },
        neck: { kind: 'rot', parent: 'body', pivot: PV.neck },
        headBack: { kind: 'warp', parent: 'neck', rect: HEAD },
        headMid: { kind: 'warp', parent: 'neck', rect: HEAD },
        headFeat: { kind: 'warp', parent: 'neck', rect: HEAD },
        headFront: { kind: 'warp', parent: 'neck', rect: HEAD },
        hairSway: { kind: 'warp', parent: 'headBack', rect: rectOf('hair_back') },
        bangsSway: { kind: 'warp', parent: 'headFront', rect: rectOf('bangs') },
        finNear: { kind: 'rot', parent: 'headMid', pivot: PV.finNear },
        finFar: { kind: 'rot', parent: 'headBack', pivot: PV.finFar },
        ahoge: { kind: 'rot', parent: 'headFront', pivot: PV.ahoge },
      };
      const parts = model.parts.map(p => ({ ...p }));
      // the face features ride a little ahead of the face for the turn
      parts.push({ id: 'faceFx', tex: 'faceFx', box: [U(FACE.x), V(FACE.y), FACE.w * S, FACE.h * S], z: 9, parent: 'headFeat', grid: [4, 4] });
      // the brows lie on the skin under the fringe, and show through the hair: the same texture is drawn
      // again over the fringe, faint. Each brow lifts and tilts by the face (the warp below splits them).
      const brows = parts.find(p => p.id === 'brows');
      if (brows) {
        deformers.brows = { kind: 'warp', parent: 'headFeat', rect: rectOf('brows') };
        brows.parent = 'brows';
        parts.push({ ...brows, id: 'brows_through', z: 13.2, alpha: .4 });
      }
      // the lid creases follow each eye's upper lid down when the eye narrows, and go when it closes
      const creases = parts.find(p => p.id === 'eye_creases');
      if (creases) {
        deformers.creases = { kind: 'warp', parent: 'headFeat', rect: rectOf('eye_creases') };
        creases.parent = 'creases';
      }
    
      /* ---------- face painting (master pixels) ---------- */
      const faceCv = document.createElement('canvas');
      faceCv.width = FACE.w; faceCv.height = FACE.h;
      // while a scheme fades in, the face is painted a second time with the incoming scheme's sprites
      const faceCv2 = document.createElement('canvas');
      faceCv2.width = FACE.w; faceCv2.height = FACE.h;
      const fg1 = faceCv.getContext('2d'), fg2 = faceCv2.getContext('2d');
      let fg = fg1;
      const eyeCv = document.createElement('canvas');
      const INK = '#5a2330';
      const poly2 = (c, x) => c[0] * x * x + c[1] * x + c[2];
    
      // how far the lid travels to close: from the lid line down past the lower rim
      const EYE = Object.fromEntries(EYES.map(k => {
        const e = feat.eyes[k], [x0, , x1] = e.ball;
        let h = 0;
        for (let x = x0 + 4; x < x1 - 4; x += 2) h = Math.max(h, poly2(e.rimFit, x) - poly2(e.lidFit, x));
        const cx = (e.iris[0] + e.iris[2]) / 2;
        return [k, { ...e, travel: h + 2, cx, cy: poly2(e.lidFit, cx) }];
      }));
    
      /** The neutral eye with its lid at `open` (0 shut, 1 rest), iris moved by ix/iy, lid tilted by tilt (rad). */
      function paintOpenEye(k, open, ix, iy, tilt) {
        const e = EYE[k], [bx0, by0, bx1, by1] = e.ball, w = bx1 - bx0, h = by1 - by0;
        if (eyeCv.width !== w + 40 || eyeCv.height !== h + 40) { eyeCv.width = w + 40; eyeCv.height = h + 40; }
        const g = eyeCv.getContext('2d');
        g.setTransform(1, 0, 0, 1, 20 - bx0, 20 - by0);
        g.clearRect(bx0 - 20, by0 - 20, w + 40, h + 40);
        g.globalCompositeOperation = 'source-over';
        g.drawImage(img[`${k}_ball`], bx0, by0);
        g.globalCompositeOperation = 'source-atop';
        g.drawImage(img[`${k}_iris`], e.iris[0] + ix, e.iris[1] + iy);
        // the eye's outline over the iris, so a shifted iris tucks under it
        if (e.rim) { g.globalCompositeOperation = 'source-over'; g.drawImage(img[`${k}_rim`], e.rim[0], e.rim[1]); }
        // the lid hides everything above it
        const d = (1 - clamp(open, 0, 1)) * e.travel, tn = Math.tan(tilt);
        g.globalCompositeOperation = 'destination-out';
        g.beginPath();
        g.moveTo(bx0 - 20, by0 - 20);
        for (let x = bx0 - 20; x <= bx1 + 20; x += 3) g.lineTo(x, poly2(e.lidFit, clamp(x, bx0, bx1)) + d + tn * (x - e.cx) - 1);
        g.lineTo(bx1 + 20, by0 - 20);
        g.closePath(); g.fill();
        g.globalCompositeOperation = 'source-over';
        fg.drawImage(eyeCv, bx0 - 20 - FACE.x, by0 - 20 - FACE.y);
        // the lashes ride down with the lid and flatten as they close
        const L = e.lash, sy = .55 + .45 * clamp(open, 0, 1);
        fg.save();
        fg.translate(e.cx - FACE.x, e.cy + d - FACE.y);
        fg.rotate(tilt);
        fg.scale(1, sy);
        fg.drawImage(img[`${k}_lash`], L[0] - e.cx, L[1] - e.cy);
        fg.restore();
      }
    
      // Each mouth sprite sits where its expression edit drew it, and three of those edits drew the mouth
      // higher than the master's: these move them down (master pixels) so the middle of each visible mouth
      // is on the master's mouth line, y 769, as the neutral, love, dizzy and surprised mouths already are.
      const MOUTH_DY = { happy_mouth: 9, drag_mouth: 16, sleep_mouth: 4 };
    
      /** A whole drawn sprite (an expression's eye or mouth) at its place, optionally scaled/rotated about its centre. */
      function sprite(name, o = {}) {
        const b = feat.sprites[name];
        if (!b) return;
        const cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2;
        fg.save();
        fg.globalAlpha = o.alpha ?? 1;
        fg.translate(cx - FACE.x, cy + (MOUTH_DY[name] || 0) - FACE.y);
        if (o.rot) fg.rotate(o.rot);
        fg.scale(o.sx ?? o.s ?? 1, o.sy ?? o.s ?? 1);
        fg.drawImage(img[name], b[0] - cx, b[1] - cy);
        fg.restore();
      }
    
      const CHEEKS = [[618, 770, 40, 20], [852, 762, 22, 15]];
      function paintBlush(a) {
        if (a < .02) return;
        for (const [x, y, rx, ry] of CHEEKS) {
          fg.save();
          fg.translate(x - FACE.x, y - FACE.y); fg.scale(1, ry / rx);
          const gr = fg.createRadialGradient(0, 0, 0, 0, 0, rx);
          gr.addColorStop(0, `rgba(255,120,140,${f1(.55 * a)})`); gr.addColorStop(1, 'rgba(255,120,140,0)');
          fg.fillStyle = gr; fg.beginPath(); fg.arc(0, 0, rx, 0, Math.PI * 2); fg.fill();
          fg.restore();
        }
      }
    
      /** Small drawn mouths for the moods the sprites don't cover (form < 0 frowns). */
      function lineMouth(form, w = 1) {
        const cx = 766 - FACE.x, cy = 772 - FACE.y;
        fg.save(); fg.strokeStyle = INK; fg.lineWidth = 3; fg.lineCap = 'round';
        fg.beginPath(); fg.moveTo(cx - 9 * w, cy - form * 3); fg.quadraticCurveTo(cx, cy + form * 5, cx + 9 * w, cy - form * 3); fg.stroke();
        fg.restore();
      }
    
      const MOUTH = {
        neutral: 'neutral_mouth', happy: 'happy_mouth', wink: ['happy_mouth', .8], love: 'love_mouth', shy: ['drag_mouth', .7],
        surprised: 'surprised_mouth', sleepy: 'sleep_mouth', sleep: 'sleep_mouth', dizzy: 'dizzy_mouth', dragged: 'drag_mouth',
        content: 'neutral_mouth', waking: ['surprised_mouth', .6], squeeze: 'sleep_mouth', listening: 'neutral_mouth',
        thinking: 'sleep_mouth', run: ['happy_mouth', .7], angry: -1, sad: -1.2,
      };
    
      function paintFace(fc, face, o, t) {
        fg.setTransform(1, 0, 0, 1, 0, 0);
        fg.clearRect(0, 0, FACE.w, FACE.h);
        paintBlush(fc.blush || 0);
        const shut = Math.max(o.blink || 0, o.eyeClose || 0);
        const lx = clamp(o.look[0], -6, 6), ly = clamp(o.look[1], -5, 5);
        const tilt = fc.brows === 'angry' ? .2 : fc.brows === 'sad' ? -.16 : 0;
        fc.eyes.forEach((e, i) => {
          const k = EYES[i], side = k === 'eyeL' ? 1 : -1;  // the near eye's inner corner is to its right
          const squash = { sy: 1 - .85 * (o.eyeClose || 0) };
          if (face === 'surprised' && e.shape === 'ring') { sprite(`surprised_${k}`, squash); return; }
          switch (e.shape) {
            case 'ring': case 'lid': {
              const open = (e.shape === 'ring' ? clamp(e.ry / e.rx, 0, 1) * (tilt ? .8 : 1) : clamp(e.ry / 16, 0, 1)) * (1 - shut);
              // the iris fills most of the eye: it only shifts a little, less in the foreshortened far eye,
              // so the white never shows past the eye's outline
              const gx = k === 'eyeL' ? 1 : .35;
              const ix = clamp((lx + (e.dx || 0)) * gx, -6 * gx, 6 * gx), iy = clamp(ly * .7 + (e.dy || 0) * .7, -3.5, 3.5);
              paintOpenEye(k, open, ix, iy + (e.shape === 'lid' ? 3 : 0), tilt * side);
              break;
            }
            case 'up': sprite(`happy_${k}`, squash); break;
            case 'down': sprite(`sleep_${k}`, squash); break;
            case 'gt': case 'lt': sprite(`drag_${k}`, { s: 1 + .03 * Math.sin(t * 22 + i) }); break;
            case 'heart': sprite(`love_${k}`, { s: .94 + .06 * (e.s ?? 1) / .8 }); break;
            case 'spiral': sprite(`dizzy_${k}`, { rot: (e.rot || 0) * .6 }); break;
          }
        });
        // mouth: talking opens the happy mouth about its middle, which stays on the mouth line; otherwise the face's own
        const talk = o.talk || 0;
        const gapOpen = clamp((Math.max(fc.gap[0], fc.gap[1]) - 50) / 14, 0, 1);
        const m = MOUTH[face] ?? 'neutral_mouth';
        const open = Math.max(talk * (.45 + .45 * Math.abs(Math.sin(t * 17))), face === 'sleepy' || face === 'waking' ? gapOpen : 0);
        if (open > .12) sprite(face === 'surprised' ? 'surprised_mouth' : 'happy_mouth', { sy: .35 + .65 * open, sx: .85 + .15 * open });
        else if (typeof m === 'number') lineMouth(m);
        else if (Array.isArray(m)) sprite(m[0], { s: m[1] });
        else sprite(m);
      }
    
      /* ---------- mounting inside the pet's SVG group ---------- */
      const VIEW = model.view;
      let fo = null, canvas = null, fxG = null, rig = null, mountedIn = null, pxScale = 0, frameN = 0;
      function mount(petG) {
        petG.textContent = '';
        // the previous rig's GL context outlives its canvas until GC: release it or repeated
        // figure switches pile up live contexts (Chromium caps them per page)
        rig?.dispose();
        rig = null;
        const box = (el) => { el.setAttribute('x', VIEW[0]); el.setAttribute('y', VIEW[1]); el.setAttribute('width', VIEW[2] - VIEW[0]); el.setAttribute('height', VIEW[3] - VIEW[1]); return el; };
        canvas = document.createElementNS('http://www.w3.org/1999/xhtml', 'canvas');
        if (opts.raster) {
          // each frame is copied into a plain SVG image: screenshots and recordings then always see it
          fo = box(document.createElementNS(SVGNS, 'image'));
        } else {
          fo = box(document.createElementNS(SVGNS, 'foreignObject'));
          canvas.style.cssText = 'width:100%;height:100%;display:block';
          fo.appendChild(canvas);
        }
        fxG = document.createElementNS(SVGNS, 'g');
        petG.append(fo, fxG);
        rig = createRig(canvas, { deformers, parts, view: VIEW });
        for (const n in tex) rig.upload(n, tex[n]);
        if (fade) for (const n in fade.set.tex) rig.upload(n + '@mix', fade.set.tex[n]);
        mountedIn = petG; pxScale = 0;
      }
      // a fade in progress: the rig crossfades every part from `tex` to fade.set's textures over fade.dur seconds
      let fade = null;
      function endFade() {
        if (!fade) return;
        tex = fade.set.tex; img = fade.set.img; fade = null;
        if (rig) for (const n in tex) rig.upload(n, tex[n]);
      }
      /**
       * Switches the colour scheme: at once if its textures are loaded (see preload), else once they are.
       * `o.fade` (seconds) crossfades instead of cutting over; the clock is the frames' `t`, starting at `o.at`
       * (the pet's time now) or else at the next frame drawn.
       */
      function setScheme(id, o = {}) {
        const next = schemeInfo(id).id;
        const apply = set => {
          endFade();
          if (scheme === next && tex === set.tex) return;
          scheme = next;
          if (o.fade > 0 && rig) {
            fade = { set, dur: o.fade, t0: o.at ?? null };
            for (const n in set.tex) rig.upload(n + '@mix', set.tex[n]);
            return;
          }
          tex = set.tex; img = set.img;
          if (rig) for (const n in tex) rig.upload(n, tex[n]);
        };
        if (ready[next]) { apply(ready[next]); return Promise.resolve(); }
        return loadScheme(next).then(apply);
      }
      let decoded = null; // raster mode: settles once the last frame's image is decoded
      let fixedRes = 0; // canvas pixels per rig unit for a snapshot; 0 = follow the screen
      function fitCanvas() {
        const m = fixedRes ? null : mountedIn.getScreenCTM();
        if (!m && !fixedRes) return;
        // the vertical axis: turning round squeezes the horizontal one through zero, which would shrink the canvas to a few texels
        const k = fixedRes || Math.hypot(m.c, m.d) * (window.devicePixelRatio || 1) * 1.25;
        if (Math.abs(k - pxScale) / (pxScale || 1) < .08) return;
        pxScale = k;
        canvas.width = Math.max(16, Math.round((VIEW[2] - VIEW[0]) * Math.min(k, 6)));
        canvas.height = Math.max(16, Math.round((VIEW[3] - VIEW[1]) * Math.min(k, 6)));
      }
    
      /* ---------- per-frame state ---------- */
      const sp = {
        hair: spring(55, 7, 1.8), hairY: spring(50, 8, 1.2), bangs: spring(110, 10, 1.6),
        skirt: spring(100, 9, 1.6), skirtY: spring(90, 10, 1.1), tail: spring(40, 5, 32), fins: spring(90, 9, 30),
        ahoge: spring(140, 6, 38), head: spring(70, 10, 16), armN: spring(60, 9, 95), armF: spring(60, 9, 95),
        gest: spring(90, 11, 1.4), mood: spring(20, 7, 1),
      };
      let lastT = null, prevTilt = 0, prevLow = 0, headTilt = 0, fx = '';
      // pet-core tips Coo's whole round body to listen, nod, doze or wobble; she keeps her feet on the floor and
      // moves her head instead. Only flight, dragging and the jump's crouch and landing tip the whole group,
      // running keeps half its lean. The shares ease between modes so the group never snaps.
      const GROUP = { air: [1, 1], drag: [1, 1], crouch: [1, 1], land: [1, 1], walk: [1, .5], run: [1, .5] };
      let wTilt = 0, wLean = 0;
      const groupTilt = (mode, tilt, lean) => tilt * wTilt + lean * wLean;
      let finMood = 0, tailMood = 0, wagAmp = 0, sitK = 0;
      const st = { z: {}, alpha: {} };
    
      // fins and tail by face: fins up (+) or drooping (-), tail wag size
      const MOOD = {
        happy: [.8, 1], love: [.9, 1], wink: [.5, .7], surprised: [1, .2], angry: [.9, .15], sad: [-1, 0], shy: [-.5, .3],
        sleepy: [-.7, 0], sleep: [-.9, 0], dizzy: [-.3, 0], dragged: [.6, .6], content: [-.2, .25], listening: [.6, .2],
        thinking: [.1, .15], run: [.2, .4], waking: [-.4, 0], squeeze: [-.3, 0], neutral: [0, .25],
      };
      // brows by face, in master pixels: [lift of the whole brow, lift of its inner end (by the nose)];
      // a negative inner lift is the frown
      const BROW = {
        surprised: [6, 0], angry: [-1, -5], sad: [1, 5], shy: [1, 2.5], happy: [2, 0], love: [2, 0], wink: [1, 0],
        sleepy: [-1.5, 0], sleep: [-1.5, 0], dizzy: [1, 3], dragged: [2, 3.5], thinking: [0, 2], waking: [2, 1],
        listening: [1, 0], content: [-1, 0], squeeze: [-1, -2], run: [1, 0],
      };
      const BROW_SPLIT = U(765);  // the near brow is left of this, the far brow right of it
      let browLift = 0, browInner = 0;
      // how far an eye's upper lid sits below its rest line (master pixels), and whether it is an open eye at all
      // (the same openness paintFace gives the eye, over the lid's full travel; the crease keeps a little above the lid)
      const lidDrop = (e, k, tilt) => {
        const open = e.shape === 'ring' ? clamp((e.ry ?? 16) / (e.rx ?? 16), 0, 1) * (tilt ? .8 : 1) : e.shape === 'lid' ? clamp(e.ry / 16, 0, 1) : 1;
        return EYE[k].travel * (1 - open) * .75;
      };
      const lidOpen = e => e.shape === 'ring' || e.shape === 'lid' ? 1 : 0;
      const creaseDrop = [0, 0];
      let creaseA = 1;
    
      function draw(petG, fc, o) {
        if (mountedIn !== petG || !petG.contains(fo)) mount(petG);
        if (frameN++ % 20 === 0) fitCanvas();
        const t = o.t, dt = lastT == null ? 1 / 60 : clamp(t - lastT, 0, .05);
        lastT = t;
        const mode = o.mode || 'idle', face = o.face || 'neutral';
        const walking = mode === 'walk' || mode === 'run', held = mode === 'drag', airborne = mode === 'air';
    
        // pet-core names the gesture and eases how far through it she is; the spring here only smooths the
        // arrival, so a gesture ending takes the arms back down instead of snapping them to the rest pose
        const gest = o.gest || '';
        const gestK = clamp(sp.gest.step(gest ? 1 : 0, dt), 0, 1.2);
        // the mood the owner sets (how much she has been played with) rides its own slow spring
        const gestMood = clamp(sp.mood.step(clamp(o.mood ?? 0, 0, 1), dt), 0, 1);
    
        /* body: pet-core's `low` is how far the hips sink (sitting, the walk's bob), in these units */
        sitK = lerp(sitK, clamp(o.sit ?? 0, 0, 1), ease(12, dt));
        const low = o.low || 0;
        const lowV = (low - prevLow) / Math.max(dt, 1e-3); prevLow = low;
        const breath = Math.sin(t * (mode === 'sleep' ? 1.7 : 2.4));
    
        /* head: tilt toward what it looks at, nod with sleep, wobble with dizzy */
        let tiltT = o.look[0] * .7 + Math.sin(t * .9) * 1.2 - o.look[1] * .4;
        if (mode === 'sleep') tiltT += 6;
        if (face === 'shy') tiltT += 7;
        if (face === 'thinking') tiltT -= 8;
        if (face === 'dizzy') tiltT += 3 * Math.sin(t * 4.5);
        if (held) tiltT += o.swing * .25;
        headTilt = sp.head.step(tiltT, dt);
        // what pet-core meant for the whole body and the group did not take goes to the neck (forward +)
        const [gT, gL] = GROUP[mode] || [0, 0];
        const bend = (o.tilt ?? 0) * (1 - wTilt) + (o.lean ?? 0) * Math.sign(o.facing || 1) * (1 - wLean);
        wTilt = lerp(wTilt, gT, ease(10, dt)); wLean = lerp(wLean, gL, ease(10, dt));
        const tiltVel = (headTilt - prevTilt) / Math.max(dt, 1e-3); prevTilt = headTilt;
        const angleX = clamp(o.look[0] / 5, -1, 1) * .9;
        const angleY = clamp(-o.look[1] / 4, -1, 1) * .7 + (mode === 'sleep' ? -.8 : 0) + (face === 'sad' ? -.35 : 0);
    
        /* springs */
        const sway = clamp(o.swing / 26, -1.6, 1.6);
        const up = airborne || held ? 1 : 0;
        const hair = sp.hair.step(sway * 1.1 - tiltVel * .004 + (walking ? -.25 : 0), dt);
        const hairY = sp.hairY.step(up * -1 + lowV * .006, dt);
        const bangs = sp.bangs.step(sway * .7 - tiltVel * .004, dt);
        const skirt = sp.skirt.step(sway * .8 + (walking ? -.2 : 0), dt);
        const flare = sp.skirtY.step(up * .8 + sitK * .6 + clamp(-lowV * .01, -.3, .6), dt);
        const [fm, wg] = MOOD[face] || MOOD.neutral;
        finMood = lerp(finMood, fm, ease(6, dt));
        // the wag has two sources: how the face reads, and the mood the owner sets (how often you have been
        // playing with her). they add, so a happy face plus a good mood really does wag hard. asleep damps it.
        wagAmp = lerp(wagAmp, clamp(wg + gestMood * .55, 0, 1.5) * (mode === 'sleep' ? .15 : 1), ease(3, dt));
        tailMood = lerp(tailMood, mode === 'sleep' || face === 'sad' ? -1 : 0, ease(3, dt));
        const fins = sp.fins.step(finMood * 14 + sway * 10 + (face === 'angry' ? 3 * Math.sin(t * 40) : 0)
          + gestMood * 5 * Math.sin(t * 2.2), dt);
        // the ahoge is the one thing that shows she is pleased without her having to say anything: the
        // livelier her mood, the more it flicks about on its own
        const ahoge = sp.ahoge.step(-tiltVel * .12 + sway * 18 + (face === 'surprised' ? -16 : 0) + (mode === 'sleep' ? 22 : 0) - hairY * 12
          + gestMood * 9 * Math.sin(t * 3.1), dt);
        const tail = sp.tail.step(sway * 14 + tailMood * 12, dt) + wagAmp * 13 * Math.sin(t * (4 + 5 * wagAmp)) + Math.sin(t * 1.3) * 3;
    
        /* legs: pet-core hands hip→foot segments sized for Coo; keep their angle (forward = foot to the right) */
        const legA = o.legs.map(l => -Math.atan2(l[2] - l[0], Math.max(4, l[3] - l[1])) * 180 / Math.PI);
        const lift = o.legs.map(l => clamp(29 - Math.hypot(l[2] - l[0], l[3] - l[1]), -8, 20));
        // sitting swaps the lower body for its own drawing (skirt spread on the floor, legs forward) in a
        // couple of frames halfway down, under a little squash; a long crossfade would show both skirts at once
        const sitIn = smooth(.44, .54, sitK), plop = Math.sin(Math.PI * smooth(.3, .8, sitK));
    
        /* arms: swing against the legs when walking, out in the air, flailing when held */
        let aN = 4, aF = -2;
        if (walking) { aN = -legA[0] * 1.3 + 4; aF = -legA[1] * 1.3 - 2; }
        if (airborne) { aN = 40; aF = -30; }
        if (held) { aN = 70 + 16 * Math.sin(t * 13); aF = -45 - 12 * Math.sin(t * 13 + 1.3); }
        if (sitK > .5 && !walking) { aN = lerp(aN, -4, sitK); aF = lerp(aF, -6, sitK); }
        if (face === 'happy' || face === 'love') { aN += 12 + 5 * Math.sin(t * 8); aF -= 8 + 4 * Math.sin(t * 8); }
        if (face === 'angry') { aN = 20 + 3 * Math.sin(t * 30); aF = -18 - 3 * Math.sin(t * 30); }
    
        // gestures reach with the arms, not just the spine. pet-core drives the body (lean, sit, lift, the
        // legs) and names the gesture; these are the arm poses that finish it. Each one blends in on a
        // spring like everything else here, so a gesture that ends mid-pose lets the arms fall back.
        const gk = gestK, gm = gestMood;
        if (gk > .001) {
          switch (gest) {
            // both arms up and back over the head
            case 'stretch': aN += 58 * gk; aF -= 50 * gk; break;
            // one hand shading her eyes, the other pointing where she is looking
            case 'peek': aN += 30 * gk; aF -= 66 * gk; break;
            // forelegs flung out and shaking
            case 'shakeout': aN += 22 * gk * Math.sin(t * 26); aF -= 20 * gk * Math.sin(t * 26 + 1.1); break;
            // both forepaws up, pawing forward at you
            case 'beg': aN += 64 * gk + 10 * gk * Math.sin(t * 9); aF -= 58 * gk + 10 * gk * Math.sin(t * 9 + 1); break;
            // arms wrapped in tight, hugging herself
            case 'curl': aN -= 16 * gk; aF += 14 * gk; break;
            // both hands up, covering the face
            case 'peekaboo': aN += 74 * gk; aF -= 66 * gk; break;
            // one arm cocked back and swung round
            case 'swat': aN += 18 * gk + 52 * gk * Math.sin(t * 7); break;
            // shoulders pumping with the laugh, hands at the belly
            case 'giggle': aN += 26 * gk + 6 * gk * Math.sin(t * 12); aF -= 22 * gk; break;
            // arms up and out, guarding the head
            case 'brace': aN += 46 * gk; aF -= 40 * gk; break;
            // one hand out, the other folded in front, dipped together
            case 'curtsy': aN += 34 * gk; aF -= 30 * gk; break;
            // arms clamped to the sides
            case 'shiver': aN -= 22 * gk; aF += 20 * gk; break;
            // reaching forward to push
            case 'nudge': aN += 56 * gk + 16 * gk * Math.sin(t * 6); break;
            // hands to the mouth
            case 'lick': aN += 40 * gk; aF -= 36 * gk; break;
          }
        }
        // a lively mood makes the arms a touch more alive even at rest
        if (!walking && !held && !airborne) {
          aN += gestMood * 3 * Math.sin(t * 1.9); aF -= gestMood * 2.4 * Math.sin(t * 1.9 + .8);
        }
        const armN = sp.armN.step(aN, dt), armF = sp.armF.step(aF, dt);
    
        /* deformer states */
        // pet-core sinks the hips 29 when seated; the sitting drawing's lowest point is 19.4 above the soles
        st.body = { a: -sway * 1.2 + (held ? o.swing * .15 : 0), ty: low - 9.6 * sitK, sx: 1 + .006 * breath + .04 * plop, sy: 1 - .012 * breath - .06 * plop };
        st.skirt = {
          fn: (u, v) => {
            const k = v * v;
            // on the way down the hem spreads a little before the sitting skirt takes over
            return [skirt * 4 * k + flare * (u - .45) * 9 * v + sitK * (u - .45) * 10 * v, -flare * k * 3 - sitK * k * 8];
          },
        };
        // the sitting skirt breathes a little at its hem, and its front edge swings with the body
        st.skirtSit = { fn: (u, v) => [skirt * 1.5 * v * v, -Math.max(0, breath) * .4 * v] };
        st.alpha.skirt = st.alpha.waist_bow_front = 1 - sitIn;
        st.alpha.leg_back = st.alpha.leg_front = 1 - smooth(.42, .52, sitK);
        st.alpha.skirt_sit = st.alpha.waist_bow_sit_front = sitIn;
        st.armNear = { a: armN };
        st.armFar = { a: armF };
        st.legBack = { a: lerp(legA[0], -55, sitK), ty: -lift[0] * .9 * (1 - sitK) };
        st.legFront = { a: lerp(legA[1], -60, sitK), ty: -lift[1] * .9 * (1 - sitK) };
        st.tail = { a: tail - 10 * sitK };
        st.tailBend = { fn: u => [0, -tail * .5 * u * u] };
        st.neck = { a: headTilt + clamp(bend * .8, -10, 12), ty: (mode === 'sleep' ? 2.5 : 0) + breath * .35 };
        const parallax = (k, ky) => (u, v) => [angleX * k * bump(u) * (.4 + .6 * bump(v)), angleY * ky * bump(v) * (.4 + .6 * bump(u))];
        st.headFront = { fn: parallax(4.2, 2.8) };
        // the eyes and mouth move with the face: the eyes' outline is shared between the two layers
        st.headFeat = { fn: parallax(2, 1.4) };
        if (brows) {
          const [lift, inner] = BROW[face] || [0, 0];
          browLift = lerp(browLift, lift - 1.5 * (o.blink || 0), ease(14, dt));
          browInner = lerp(browInner, inner, ease(10, dt));
          const [bx0, , bx1] = deformers.brows.rect;
          st.brows = {
            fn: (u, v, x) => {
              // 0 at a brow's outer end, 1 at its inner end
              const k = x < BROW_SPLIT ? clamp((x - bx0) / (BROW_SPLIT - bx0), 0, 1) : clamp((bx1 - x) / (bx1 - BROW_SPLIT), 0, 1);
              return [0, -(browLift + browInner * k * k) * S];
            },
          };
        }
        if (creases) {
          fc.eyes.forEach((e, i) => { creaseDrop[i] = lerp(creaseDrop[i], lidDrop(e, EYES[i], fc.brows), ease(12, dt)); });
          creaseA = lerp(creaseA, (lidOpen(fc.eyes[0]) + lidOpen(fc.eyes[1])) / 2, ease(12, dt));
          st.alpha.eye_creases = creaseA;
          st.creases = { fn: (u, v, x) => [0, (x < BROW_SPLIT ? creaseDrop[0] : creaseDrop[1]) * S] };
        }
        st.headMid = { fn: parallax(2, 1.4) };
        st.headBack = { fn: parallax(-1.4, -1) };
        // the long hair hangs from the head but its lower half keeps to the body when the head tilts
        const nk = PV.neck, na = headTilt * Math.PI / 180;
        st.hairSway = {
          fn: (u, v, x, y) => {
            const w = smooth(.3, .8, v), a = -na * w, c = Math.cos(a), s = Math.sin(a);
            const dx = x - nk[0], dy = y - nk[1];
            const wv = Math.pow(v, 1.6);
            return [nk[0] + dx * c - dy * s - x + hair * 8 * wv + Math.sin(t * 1.6 + v * 3) * wv,
              nk[1] + dx * s + dy * c - y + hairY * 12 * wv * wv - Math.abs(hair) * 1.5 * wv];
          },
        };
        st.bangsSway = { fn: (u, v) => [bangs * 3.2 * v * v + Math.sin(t * 1.9 + u * 2) * .5 * v * v, hairY * 3 * v * v] };
        st.ahoge = { a: ahoge * .5 + Math.sin(t * 2.1) * 2 };
        st.finNear = { a: fins + Math.sin(t * 1.4) * 1.5 };
        st.finFar = { a: -fins * .8 - Math.sin(t * 1.4) * 1.2 };
    
        paintFace(fc, face, o, t);
        rig.upload('faceFx', faceCv);
        st.mix = 0;
        if (fade) {
          if (fade.t0 == null) fade.t0 = t;
          st.mix = smooth(0, 1, (t - fade.t0) / fade.dur);
          const own = img;
          img = fade.set.img; fg = fg2;
          paintFace(fc, face, o, t);
          img = own; fg = fg1;
          rig.upload('faceFx@mix', faceCv2);
        }
        rig.render(st);
        if (opts.raster) { fo.setAttribute('href', canvas.toDataURL('image/png')); decoded = fo.decode ? fo.decode().catch(() => {}) : null; }
        if (fade && st.mix >= 1) endFade();
        drawFx(fc, t);
      }
    
      /* ---------- effects over the figure (SVG, like the built-in figure's) ---------- */
      const at = (x, y) => rig.point('neck', st, x, y);
      function drawFx(fc, t) {
        let s = '';
        const ac = accent();
        const top = at(124, 34), side = at(204, 52);
        if (fc.orbit) {
          for (let i = 0; i < 3; i++) {
            const a = t * 3.2 + i * 2.094, sn = Math.sin(a);
            s += `<path fill="#ffd23f" stroke="#3a2f7a" stroke-width="1.6" stroke-linejoin="round" opacity="${sn < 0 ? .55 : 1}" transform="translate(${f1(top[0] + 56 * Math.cos(a))} ${f1(top[1] - 4 + 10 * sn)}) scale(${sn < 0 ? .7 : 1})" d="M0 -7L2 -2L7 -2L3 1L4.5 6.5L0 3.3L-4.5 6.5L-3 1L-7 -2L-2 -2Z"/>`;
          }
        }
        if (fc.listen) {
          for (let i = 0; i < 3; i++) {
            const p = (t * .9 + i / 3) % 1, r = 36 - 24 * p, c = at(214, 116);
            s += `<path fill="none" stroke="${ac}" stroke-width="5" stroke-linecap="round" opacity="${f1(Math.sin(Math.PI * p))}" d="M${f1(c[0] + r * Math.cos(-.55))} ${f1(c[1] + r * Math.sin(-.55))}A${f1(r)} ${f1(r)} 0 0 1 ${f1(c[0] + r * Math.cos(.55))} ${f1(c[1] + r * Math.sin(.55))}"/>`;
          }
        }
        if (fc.think) {
          for (let i = 0; i < 3; i++) {
            const k = (t * .8 + i / 3) % 1;
            s += `<circle fill="#e8f0ff" stroke="${ac}" stroke-width="3" cx="${f1(side[0] + 10 * i)}" cy="${f1(side[1] - 20 * i - 6 * k)}" r="${4 + 3 * i}" opacity="${f1(.4 + .6 * Math.sin(Math.PI * k))}"/>`;
          }
        }
        if (fc.sweat) {
          const c = at(196, 88 + 3 * Math.sin(t * 7));
          s += `<path fill="#8fd0ff" stroke="#2f5fae" stroke-width="1.4" transform="translate(${f1(c[0])} ${f1(c[1])}) scale(1.4)" d="M0 -9C4 -3 6 0 6 3.5A6 6 0 0 1 -6 3.5C-6 0 -4 -3 0 -9Z"/>`;
        }
        if (fc.anger) {
          const c = at(190, 62), k = 1 + .12 * Math.sin(t * 10);
          s += `<g transform="translate(${f1(c[0])} ${f1(c[1])}) scale(${f1(k)})" fill="none" stroke="#e5484d" stroke-width="5" stroke-linecap="round"><path d="M-11 -3Q-3 -3 -3 -11M3 -11Q3 -3 11 -3M11 3Q3 3 3 11M-3 11Q-3 3 -11 3"/></g>`;
        }
        if (fc.bang) {
          const c = at(206, 36);
          s += `<g transform="translate(${f1(c[0])} ${f1(c[1])})"><path fill="none" stroke="#252049" stroke-width="8" stroke-linecap="round" d="M0 -16V3"/><circle fill="#252049" cx="0" cy="14" r="4.5"/></g>`;
        }
        if (fx !== s) { fxG.innerHTML = s; fx = s; }
      }
    
      return {
        draw,
        groupTilt,
        setScheme,
        /** Forgets the motion state (springs, clocks), for callers that replay a timeline from its start. */
        /**
         * Renders `frames` frames of one pose (face `fc`, frame fields `o`, its clock starting at o.t) at `res` canvas
         * pixels per rig unit, then gives up the WebGL context; returns an SVG <image> for the result in rig space.
         * For pages showing many still figures, which would otherwise hold a GPU context each.
         */
        snapshot(fc, o, res = 3, frames = 60) {
          fixedRes = res;
          const g = document.createElementNS(SVGNS, 'g');
          for (let i = 0; i < frames; i++) draw(g, fc, { ...o, t: (o.t || 0) + i / 60 });
          const href = canvas.toDataURL('image/png');
          rig.dispose();
          rig = null; mountedIn = null; fixedRes = 0;
          return `<image href="${href}" x="${VIEW[0]}" y="${VIEW[1]}" width="${VIEW[2] - VIEW[0]}" height="${VIEW[3] - VIEW[1]}"/>`;
        },
        /**
         * Releases the WebGL context and drops the mounted DOM (what `setFigure` switching away from
         * this figure calls). The figure object stays usable: the next `draw` re-mounts from scratch.
         */
        dispose() {
          rig?.dispose();
          rig = null; canvas = null; fo = null; fxG = null; mountedIn = null;
        },
        reset() {
          endFade();
          for (const k in sp) { sp[k].x = 0; sp[k].v = 0; }
          lastT = null; prevTilt = 0; prevLow = 0; headTilt = 0; wTilt = 0; wLean = 0; finMood = 0; tailMood = 0; wagAmp = 0; sitK = 0;
        },
        /** Loads every scheme's textures, so later switches are immediate. */
        preload: () => Promise.all(SCHEMES.map(sc => loadScheme(sc.id))),
        get scheme() { return scheme; },
        /** Raster mode: a promise that settles once the last drawn frame is ready to be painted. */
        get painted() { return decoded || Promise.resolve(); },
        get colors() { return { z: accent() }; },
        schemes: SCHEMES,
        // points pet-core uses: eye tracking, tears, sleep z's, hearts [x from, x to, y], bubble
        anchors: {
          gaze: [U(745), V(690)], tear: [U(640), V(752)], z: [196, 44],
          hearts: [96, 176, 62], bubble: [128, 18],
        },
        model,
      };
    }
    
        return { createWhaleFigure: createWhaleFigure };
      })();
      var core = (function () {
    /**
     * The pet's body: geometry, faces, accessories, skin, synthesized sound, and the motion
     * simulation with pointer handling. Pages build on it: the desktop window (pet.html), the
     * dressing page (dress.html) and anything else that wants the same figure.
     *
     * Coordinates: the figure is drawn in logo units, facing right, ground at y=256. A stage places
     * it with translate(AX AY) rotate(rot) scale(kx ky) translate(-ax -ay); `toStage` maps a logo
     * point back to stage pixels for hit tests, particles and bubble placement.
     */
    
    const f = n => Math.round(n * 10) / 10;
    const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
    const lerp = (a, b, k) => a + (b - a) * k;
    const rnd = (a, b) => a + Math.random() * (b - a);
    const ease = (rate, dt) => 1 - Math.exp(-rate * dt);
    const smooth = k => k * k * (3 - 2 * k);
    
    /* ---------- figure geometry ---------- */
    const HIPS = [[104, 212], [150, 212]];
    const EYES = [[113, 117], [163, 117]];
    const BODY_W = 36, LEG_W = 30;
    // a foot's round cap touches the ground
    const FOOT_Y = 256 - LEG_W / 2;
    const STAND = HIPS.map(h => [h[0], h[1], h[0], FOOT_Y]);
    const DROP = 'M0 -9C4 -3 6 0 6 3.5A6 6 0 0 1 -6 3.5C-6 0 -4 -3 0 -9Z';
    const pol = (a, r) => [128 + r * Math.cos(a * Math.PI / 180), 128 - r * Math.sin(a * Math.PI / 180)];
    const pt = p => `${f(p[0])} ${f(p[1])}`;
    
    function cPath(gt, gb) {
      return `M${pt(pol(gt, 84))}A84 84 0 1 0 ${pt(pol(-gb, 84))}`;
    }
    function ellipse(cx, cy, rx, ry) {
      if (ry < 1.6) return `M${f(cx - rx)} ${f(cy)}L${f(cx + rx)} ${f(cy)}`;
      return `M${f(cx - rx)} ${f(cy)}A${f(rx)} ${f(ry)} 0 1 0 ${f(cx + rx)} ${f(cy)}A${f(rx)} ${f(ry)} 0 1 0 ${f(cx - rx)} ${f(cy)}Z`;
    }
    function heartD(cx, cy, s) {
      const p = (x, y) => `${f(cx + x * s)} ${f(cy + y * s)}`;
      return `M${p(0, 14)}C${p(-7, 8)} ${p(-19, 1)} ${p(-19, -6)}C${p(-19, -15)} ${p(-8, -18)} ${p(0, -9)}C${p(8, -18)} ${p(19, -15)} ${p(19, -6)}C${p(19, 1)} ${p(7, 8)} ${p(0, 14)}Z`;
    }
    function eyePath(e, cx, cy) {
      cx += e.dx || 0; cy += e.dy || 0;
      switch (e.shape) {
        case 'ring': return ellipse(cx, cy, e.rx, e.ry);
        case 'lid': return e.ry < 1.6 ? `M${f(cx - 16)} ${f(cy)}L${f(cx + 16)} ${f(cy)}` : `M${f(cx - 16)} ${f(cy)}A16 ${f(e.ry)} 0 0 0 ${f(cx + 16)} ${f(cy)}Z`;
        case 'up': return `M${f(cx - 15)} ${f(cy + 6)}Q${f(cx)} ${f(cy - 17)} ${f(cx + 15)} ${f(cy + 6)}`;
        case 'down': return `M${f(cx - 15)} ${f(cy - 3)}Q${f(cx)} ${f(cy + 15)} ${f(cx + 15)} ${f(cy - 3)}`;
        case 'gt': return `M${f(cx - 10)} ${f(cy - 13)}L${f(cx + 11)} ${f(cy)}L${f(cx - 10)} ${f(cy + 13)}`;
        case 'lt': return `M${f(cx + 10)} ${f(cy - 13)}L${f(cx - 11)} ${f(cy)}L${f(cx + 10)} ${f(cy + 13)}`;
        case 'heart': return heartD(cx, cy, e.s);
        case 'spiral': {
          let d = '';
          const max = Math.PI * 4.4;
          for (let i = 0; i <= 44; i++) {
            const a = max * i / 44, r = 2 + 15 * i / 44;
            d += (i ? 'L' : 'M') + f(cx + r * Math.cos(a + e.rot)) + ' ' + f(cy + r * Math.sin(a + e.rot));
          }
          return d;
        }
      }
      return '';
    }
    
    /* ---------- accessories ----------
       Solid shapes first; lines only where a piece is a line (band, stalk, frame), never thinner than 10.
       Every part is painted through a color channel: c-<slot>-main / c-<slot>-acc. */
    const PALETTES = [
      { id: 'mint',      label: '薄荷绿', l: ['#1B1626', '#00A870'], d: ['#FFFFFF', '#2FD59B'] },
      { id: 'mono',      label: '单色',   l: ['#1B1626', '#1B1626'], d: ['#FFFFFF', '#FFFFFF'] },
      { id: 'navigator', label: '领航员', l: ['#14213A', '#1F6FE0'], d: ['#FFFFFF', '#5EA3FF'] },
      { id: 'claude',    label: '克劳德', l: ['#2A1C16', '#C9623F'], d: ['#FFFFFF', '#E58B69'] },
      { id: 'fox',       label: '红狐狸', l: ['#26140F', '#DD3526'], d: ['#FFFFFF', '#FF6655'] },
      { id: 'purple',    label: '虚式茈', l: ['#1D1430', '#8B3DF0'], d: ['#FFFFFF', '#B98AFF'] },
      { id: 'lemon',     label: '柠檬黄', l: ['#252010', '#D9B300'], d: ['#FFFFFF', '#FFE14F'] },
    ];
    const HEADS = [['none', '无'], ['cat', '猫耳'], ['bear', '熊耳'], ['bunny', '兔耳'], ['antenna', '天线'], ['halo', '光环'], ['tophat', '礼帽'], ['party', '派对帽'], ['sailor', '水手帽']];
    const SIDES = [['none', '无'], ['headphones', '耳机'], ['feather', '耳羽'], ['earring', '耳环'], ['clip', '发夹'], ['bow', '蝴蝶结']];
    const GLASSES = [['none', '无'], ['round', '圆框'], ['square', '方框'], ['monocle', '单片镜']];
    const NECKS = [['none', '无'], ['bowtie', '领结'], ['bell', '铃铛'], ['scarf', '围巾']];
    const HEAD_TOP = { none: 12, cat: -14, bear: -4, bunny: -34, antenna: -34, halo: -8, tophat: -28, party: -34, sailor: -20 };
    
    /* color mapping: channel -> source. 'body' / 'eye' follow the palette; the rest are fixed accessory colors with a dark twin */
    const ACC_COLORS = [
      { id: 'mint',      label: '薄荷绿', l: '#00A870', d: '#2FD59B' },
      { id: 'leaf',      label: '叶绿',   l: '#3C9A2C', d: '#80D46B' },
      { id: 'lemon',     label: '柠檬黄', l: '#D9B300', d: '#FFE14F' },
      { id: 'fox',       label: '红狐狸', l: '#DD3526', d: '#FF6655' },
      { id: 'claude',    label: '克劳德', l: '#C9623F', d: '#E58B69' },
      { id: 'rose',      label: '樱粉',   l: '#DB3F76', d: '#FF85AE' },
      { id: 'purple',    label: '虚式茈', l: '#8B3DF0', d: '#B98AFF' },
      { id: 'navigator', label: '领航员', l: '#1F6FE0', d: '#5EA3FF' },
      { id: 'holo',      label: '全息蓝', l: '#1AA3D9', d: '#6FD3FF' },
    ];
    const LINKED = [{ id: 'body', label: '跟随身体' }, { id: 'eye', label: '跟随眼睛' }];
    const SLOTS = ['head', 'side', 'glasses', 'neck'];
    const SLOT_LISTS = { head: HEADS, side: SIDES, glasses: GLASSES, neck: NECKS };
    const CHANNEL_DEFAULT = { head: { main: 'body', acc: 'eye' }, side: { main: 'eye', acc: 'eye' }, glasses: { main: 'body', acc: 'eye' }, neck: { main: 'eye', acc: 'eye' } };
    // side and neck pieces lie on top of the body outline: mapping them to the body color would make them vanish
    const NO_BODY = { head: false, side: true, glasses: false, neck: true };
    // character pieces carry their original colors; picking one fills its channels, which stay editable afterwards
    const ITEM_COLORS = {
      sailor: { main: 'body', acc: 'navigator' },
      feather: { main: 'holo', acc: 'navigator' },
      headphones: { main: 'claude', acc: 'holo' },
    };
    const ROLES = {
      cat: ['main'], bear: ['main'], bunny: ['main'], antenna: ['main', 'acc'], halo: ['acc'],
      tophat: ['main', 'acc'], party: ['main', 'acc'], round: ['main'], square: ['main'], monocle: ['main'],
      bowtie: ['main'], bell: ['main', 'acc'], scarf: ['main'], sailor: ['main', 'acc'],
      headphones: ['main', 'acc'], feather: ['main', 'acc'], earring: ['main'], clip: ['main'], bow: ['main'],
    };
    
    const mount = (a, r = 96) => `translate(${pt(pol(a, r))}) rotate(${f(90 - a)})`;
    const stroke = (cls, w) => `class="${cls}" fill="none" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"`;
    // solid shape with rounded corners: filled and stroked in the same channel color
    const blob = (slot, ch, w) => `class="f-${slot}-${ch} c-${slot}-${ch}" stroke-width="${w}" stroke-linejoin="round" stroke-linecap="round"`;
    
    function headBack(id, sw) {
      switch (id) {
        case 'cat':
          return [126, 82].map(a => `<path ${blob('head', 'main', 10)} transform="${mount(a)}" d="M-17 8L0 -28L17 8Z"/>`).join('');
        case 'bear':
          return [128, 80].map(a => `<circle class="f-head-main" transform="${mount(a)}" cx="0" cy="-8" r="18"/>`).join('');
        case 'bunny':
          return [[116, -10, .7], [92, 6, 1]].map(([a, off, k]) =>
            `<g transform="${mount(a)} rotate(${f(off + sw * k)})"><ellipse class="f-head-main" cx="0" cy="-28" rx="14" ry="30"/></g>`).join('');
        case 'antenna':
          return `<g transform="${mount(98)} rotate(${f(sw)})"><path ${stroke('c-head-main', 14)} d="M0 0Q5 -20 0 -38"/><circle class="f-head-acc" cx="0" cy="-50" r="12"/></g>`;
      }
      return '';
    }
    function headFront(id, sw, t) {
      switch (id) {
        case 'sailor':
          return `<g transform="${mount(106)} rotate(${f(sw * .2)})"><path class="f-head-main" d="M-34 3L-38 -30Q0 -40 38 -30L34 3Q0 -3 -34 3Z"/><path class="f-head-acc" d="M-37.1 -23Q0 -31 37.1 -23L36.1 -15Q0 -23 -36.1 -15ZM-35.6 -11Q0 -19 35.6 -11L34.8 -4Q0 -12 -34.8 -4Z"/></g>`;
        case 'halo':
          return `<g transform="${mount(98)}"><ellipse ${stroke('c-head-acc', 12)} cx="0" cy="${f(-28 + 3 * Math.sin(t * 2.2))}" rx="36" ry="9"/></g>`;
        case 'tophat':
          return `<g transform="${mount(104)} rotate(${f(sw * .2)})"><rect class="f-head-main" x="-40" y="-7" width="80" height="12" rx="6"/><rect class="f-head-main" x="-22" y="-48" width="44" height="46" rx="7"/><rect class="f-head-acc" x="-22" y="-20" width="44" height="10"/></g>`;
        case 'party':
          return `<g transform="${mount(110)} rotate(${f(sw * .3)})"><path ${blob('head', 'main', 8)} d="M-24 2L0 -46L24 2Z"/><circle class="f-head-acc" cx="0" cy="-55" r="11"/></g>`;
      }
      return '';
    }
    // Side pieces sit where an ear would be on this profile: the back of the head, around 130–172°.
    function sideBack(id, sw) {
      if (id !== 'feather') return '';
      const blade = (L, w) => `M0 0C${-w} ${f(-L * .3)} ${f(-w * .8)} ${f(-L * .8)} ${f(-L * .14)} ${-L}C${f(w * .6)} ${f(-L * .75)} ${w} ${f(-L * .3)} 0 0Z`;
      return `<g transform="${mount(166, 92)} rotate(${f(sw * .6)})">` +
        `<path class="f-side-acc" transform="rotate(58)" d="${blade(66, 18)}"/>` +
        `<path class="f-side-main" transform="rotate(26)" d="${blade(56, 16)}"/>` +
        `<path class="f-side-main" d="${blade(42, 14)}"/></g>`;
    }
    function sideFront(id, sw) {
      switch (id) {
        case 'headphones':
          return `<path ${stroke('c-side-main', 16)} d="M${pt(pol(150, 113))}A113 113 0 0 1 ${pt(pol(76, 113))}"/>` +
            `<rect class="f-side-acc" transform="${mount(166, 98)}" x="-24" y="-17" width="48" height="34" rx="17"/>`;
        case 'earring':
          return `<g transform="translate(${pt(pol(172, 99))}) rotate(${f(sw * .8)})"><circle class="f-side-main" cx="0" cy="13" r="10"/></g>`;
        case 'clip':
          return `<rect class="f-side-main" transform="${mount(140, 86)}" x="-17" y="-6.5" width="34" height="13" rx="6.5"/>`;
        case 'bow':
          return `<g class="f-side-main" transform="${mount(132, 100)} rotate(${f(sw * .3)})"><path d="M-4 0L-24 -14Q-28 0 -24 14ZM4 0L24 -14Q28 0 24 14Z"/><circle r="7"/></g>`;
      }
      return '';
    }
    function glassesD(id, gx, gy) {
      // frames sit one ring-width outside the eyes so the two never touch
      const L = [113 + gx, 117 + gy], R = [163 + gx, 117 + gy], M = stroke('c-glasses-main', 10);
      switch (id) {
        case 'round':
          return `<circle ${M} cx="${f(L[0])}" cy="${f(L[1])}" r="31"/><circle ${M} cx="${f(R[0])}" cy="${f(R[1])}" r="31"/><path ${M} d="M${f(L[0] - 31)} ${f(L[1] - 6)}L62 106"/>`;
        case 'square':
          return `<rect ${M} x="${f(L[0] - 26)}" y="${f(L[1] - 22)}" width="52" height="44" rx="15"/><rect ${M} x="${f(R[0] - 26)}" y="${f(R[1] - 22)}" width="52" height="44" rx="15"/><path ${M} d="M${f(L[0] - 26)} ${f(L[1] - 6)}L62 106"/>`;
        case 'monocle':
          return `<circle ${M} cx="${f(R[0])}" cy="${f(R[1])}" r="31"/>`;
      }
      return '';
    }
    function neckD(id, sw) {
      switch (id) {
        case 'bowtie':
          return `<g ${blob('neck', 'main', 6)} transform="translate(176 206) rotate(-32)"><path d="M-4 0L-22 -13V13ZM4 0L22 -13V13Z"/><circle r="7"/></g>`;
        case 'bell': {
          const a = pol(-150, 84), b = pol(-60, 84);
          return `<path ${stroke('c-neck-main', 12)} d="M${pt(a)}A84 84 0 0 0 ${pt(b)}"/><g transform="translate(${pt(b)}) rotate(${f(sw * .6)})"><circle class="f-neck-acc" cx="0" cy="14" r="13"/></g>`;
        }
        case 'scarf': {
          const a = pol(-150, 84), b = pol(-72, 84), S2 = stroke('c-neck-main', 18);
          return `<path ${S2} d="M${pt(a)}A84 84 0 0 0 ${pt(b)}"/><g transform="rotate(${f(sw * .8)} ${pt(a)})"><path ${S2} d="M${pt(a)}q-12 22 -6 40"/></g>`;
        }
      }
      return '';
    }
    
    /* ---------- faces ---------- */
    const ring = o => ({ shape: 'ring', rx: 16, ry: 16, ...o });
    const yawn = t => { const p = (t % 4.2) / 1.6; return p < 1 ? Math.sin(Math.PI * p) ** 2 : 0; };
    
    const FACES = {
      neutral:   { label: '平静', kao: '(0 0',  f: () => ({ gap: [50, 50], eyes: [ring(), ring()] }) },
      happy:     { label: '开心', kao: '(^ ^',  f: () => ({ gap: [58, 58], eyes: [{ shape: 'up' }, { shape: 'up' }], blush: .45 }) },
      wink:      { label: '眨眼', kao: '(0 ^',  f: () => ({ gap: [56, 52], eyes: [ring(), { shape: 'up' }] }) },
      love:      { label: '喜欢', kao: '(♡ ♡',  f: t => { const s = .8 + .08 * Math.sin(t * 9); return { gap: [56, 56], eyes: [{ shape: 'heart', s, sw: 8 }, { shape: 'heart', s, sw: 8 }], blush: .7, emit: 'heart' }; } },
      shy:       { label: '害羞', kao: '(o o *', f: () => ({ gap: [40, 40], eyes: [ring({ rx: 13, ry: 12, dx: -3, dy: 5 }), ring({ rx: 13, ry: 12, dx: -3, dy: 5 })], blush: 1, lookLock: true }) },
      surprised: { label: '惊讶', kao: '(O O',  f: () => ({ gap: [62, 62], eyes: [ring({ rx: 20, ry: 21 }), ring({ rx: 20, ry: 21 })], bang: true }) },
      angry:     { label: '生气', kao: '(ò ó',  f: () => ({ gap: [36, 36], eyes: [ring({ ry: 11, dy: 4 }), ring({ ry: 11, dy: 4 })], brows: 'angry', anger: true, shake: true }) },
      sad:       { label: '难过', kao: '(ó ò',  f: () => ({ gap: [34, 40], eyes: [ring({ ry: 14, dy: 4 }), ring({ ry: 14, dy: 4 })], brows: 'sad', emit: 'tear' }) },
      sleepy:    { label: '犯困', kao: '(- -',  f: t => { const y = yawn(t); return { gap: [50 + 14 * y, 50 + 14 * y], eyes: [{ shape: 'lid', ry: 9 - 7 * y }, { shape: 'lid', ry: 9 - 7 * y }] }; } },
      sleep:     { label: '睡着', kao: '(u u',  f: t => { const b = 40 + 6 * Math.sin(t * 1.7); return { gap: [b, b], eyes: [{ shape: 'down' }, { shape: 'down' }], emit: 'z' }; } },
      dizzy:     { label: '晕乎', kao: '(@ @',  f: t => ({ gap: [54 + 5 * Math.sin(t * 5), 48], eyes: [{ shape: 'spiral', rot: t * 7 }, { shape: 'spiral', rot: t * 7 + 1.4 }], orbit: true }) },
      dragged:   { label: '被拎起', kao: '(> <', f: t => { const g = 55 + 3 * Math.sin(t * 22); return { gap: [g, g], eyes: [{ shape: 'gt' }, { shape: 'lt' }], sweat: true }; } },
      content:   { label: '惬意', f: (t, p) => { const r = 11 - 9 * (p ? p.drowse : 0); return { gap: [46, 46], eyes: [{ shape: 'lid', ry: r }, { shape: 'lid', ry: r }] }; } },
      waking:    { label: '醒来', f: (t, p) => {
        const mt = p ? p.modeT : 1;
        const k = clamp(mt / .5, 0, 1), y = mt > .5 ? Math.sin(clamp((mt - .5) / .9, 0, 1) * Math.PI) : 0;
        const r = Math.max(0, 10 * k * (1 - .7 * y));
        return { gap: [50 + 12 * y, 50 + 12 * y], eyes: [{ shape: 'lid', ry: r }, { shape: 'lid', ry: r }] };
      } },
      squeeze:   { label: '回神', f: () => ({ gap: [44, 44], eyes: [{ shape: 'lid', ry: 0 }, { shape: 'lid', ry: 0 }] }) },
      listening: { label: '倾听', f: () => ({ gap: [44, 44], eyes: [ring({ rx: 17, ry: 18, dy: -1 }), ring({ rx: 17, ry: 18, dy: -1 })], listen: true }) },
      thinking:  { label: '思考', f: t => ({ gap: [46, 46], eyes: [ring({ rx: 14, ry: 15, dx: 3, dy: -4 }), ring({ rx: 14, ry: 15, dx: 3, dy: -4 })], think: true }) },
      run:       { label: '冲刺', f: t => { const g = 55 + 4 * Math.sin(t * 16); return { gap: [g, g], eyes: [ring(), ring()], sweat: true }; } },
    };
    const GALLERY = ['neutral', 'happy', 'wink', 'love', 'shy', 'surprised', 'angry', 'sad', 'sleepy', 'sleep', 'dizzy', 'dragged'];
    
    /** One frame of the figure as SVG markup, in logo units. */
    function figure(fc, o) {
      const t = o.t, lx = o.look[0], ly = o.look[1], acc = o.acc, sw = o.swing || 0;
      let s = `<g class="ink" fill="none" stroke-width="${LEG_W}" stroke-linecap="round">`;
      for (const l of o.legs) s += `<path d="M${f(l[0])} ${f(l[1])}L${f(l[2])} ${f(l[3])}"/>`;
      s += `</g><g transform="translate(0 ${f(o.low)})">`;
      s += sideBack(acc.side, sw);
      s += headBack(acc.head, sw);
      s += `<path class="ink" fill="none" stroke-width="${BODY_W}" stroke-linecap="round" d="${cPath(fc.gap[0], fc.gap[1])}"/>`;
      s += neckD(acc.neck, sw);
      if (fc.blush > .02) {
        s += `<g class="blush" opacity="${f(fc.blush * .8)}"><ellipse cx="${f(99 + lx)}" cy="146" rx="11" ry="5.5"/><ellipse cx="${f(167 + lx)}" cy="146" rx="11" ry="5.5"/></g>`;
      }
      const close = o.eyeClose || 0;
      fc.eyes.forEach((e, i) => {
        const ee = { ...e };
        if ((ee.shape === 'ring' || ee.shape === 'lid') && o.blink) ee.ry *= (1 - o.blink);
        const cx = EYES[i][0] + lx, cy = EYES[i][1] + ly;
        const tr = close > .01 ? ` transform="translate(0 ${f(cy)}) scale(1 ${f(Math.max(.08, 1 - close) * 100) / 100}) translate(0 ${f(-cy)})"` : '';
        s += `<path class="eye" fill="none" stroke-width="${e.sw || 12}" stroke-linecap="round" stroke-linejoin="round"${tr} d="${eyePath(ee, cx, cy)}"/>`;
      });
      s += glassesD(acc.glasses, lx * .4, ly * .3);
      if (fc.brows) {
        const bx = lx * .5, by = ly * .4;
        const d = fc.brows === 'angry'
          ? `M${f(98 + bx)} ${f(88 + by)}L${f(124 + bx)} ${f(97 + by)}M${f(152 + bx)} ${f(97 + by)}L${f(178 + bx)} ${f(88 + by)}`
          : `M${f(98 + bx)} ${f(96 + by)}L${f(123 + bx)} ${f(88 + by)}M${f(153 + bx)} ${f(88 + by)}L${f(178 + bx)} ${f(96 + by)}`;
        s += `<path class="ink" fill="none" stroke-width="9" stroke-linecap="round" d="${d}"/>`;
      }
      s += sideFront(acc.side, sw);
      s += headFront(acc.head, sw, t);
      if (fc.orbit) {
        const top = HEAD_TOP[acc.head] ?? 12;
        for (let i = 0; i < 3; i++) {
          const a = t * 3.2 + i * 2.094, sn = Math.sin(a);
          s += `<circle class="eye" fill="none" stroke-width="4" cx="${f(128 + 62 * Math.cos(a))}" cy="${f(top + 12 * sn)}" r="${sn < 0 ? 5 : 7}" opacity="${sn < 0 ? .55 : 1}"/>`;
        }
      }
      if (fc.listen) {
        // sound waves drifting in toward the face
        for (let i = 0; i < 3; i++) {
          const p = (t * .9 + i / 3) % 1, r = 46 - 30 * p, a0 = -.55, a1 = .55;
          s += `<path class="eye" fill="none" stroke-width="7" stroke-linecap="round" opacity="${f(Math.sin(Math.PI * p))}" d="M${f(196 + r * Math.cos(a0))} ${f(104 + r * Math.sin(a0))}A${f(r)} ${f(r)} 0 0 1 ${f(196 + r * Math.cos(a1))} ${f(104 + r * Math.sin(a1))}"/>`;
        }
      }
      if (fc.think) {
        // three rings rising from the head, the eye's own shape
        for (let i = 0; i < 3; i++) {
          const k = ((t * .8 + i / 3) % 1);
          s += `<circle class="eye" fill="none" stroke-width="5" cx="${f(214 + 10 * i)}" cy="${f(46 - 22 * i - 6 * k)}" r="${4 + 3 * i}" opacity="${f(.4 + .6 * Math.sin(Math.PI * k))}"/>`;
        }
      }
      if (fc.sweat) s += `<path class="tearf" transform="translate(56 ${f(64 + 3 * Math.sin(t * 7))}) scale(1.3)" d="${DROP}"/>`;
      if (fc.anger) {
        const k = 1 + .12 * Math.sin(t * 10);
        s += `<g class="angry" transform="translate(210 44) scale(${f(k * 10) / 10})" fill="none" stroke-width="7" stroke-linecap="round"><path d="M-13 -4Q-4 -4 -4 -13M4 -13Q4 -4 13 -4M13 4Q4 4 4 13M-4 13Q-4 4 -13 4"/></g>`;
      }
      if (fc.bang) s += `<g transform="translate(222 30)"><path class="ink" fill="none" stroke-width="11" stroke-linecap="round" d="M0 -18V4"/><circle class="inkf" cx="0" cy="18" r="5.5"/></g>`;
      if (o.zmark) s += '<path class="eye" fill="none" stroke-width="6" stroke-linecap="round" stroke-linejoin="round" d="M204 22H220L204 42H220M226 4H236L226 16H236"/>';
      return s + '</g>';
    }
    
    /** A static figure for previews and tiles. */
    function mini(face, acc, t = 0, extra = {}) {
      return figure(FACES[face].f(t), { look: [0, 0], legs: STAND, low: 0, t, blink: 0, acc, ...extra });
    }
    
    /* ---------- skin ---------- */
    /** Bodies the pet can wear: Coo (drawn here) or the DeepSeek whale maid (web/whale, with its colour schemes). */
    const FIGURES = [['coo', 'Coo'], ['whale', 'DeepSeek 大肥鱼']];
    function defaultSkin() {
      return { figure: 'coo', scheme: 'deepseek', palette: 'mint', head: 'none', side: 'none', glasses: 'none', neck: 'none', colors: JSON.parse(JSON.stringify(CHANNEL_DEFAULT)) };
    }
    const validColor = (slot, v) => (v === 'eye' || (v === 'body' && !NO_BODY[slot]) || ACC_COLORS.some(c => c.id === v));
    /** Keeps what is valid in `raw`, defaults the rest. */
    function normalizeSkin(raw) {
      const skin = defaultSkin();
      if (!raw || typeof raw !== 'object') return skin;
      if (FIGURES.some(([id]) => id === raw.figure)) skin.figure = raw.figure;
      // the whale's schemes are listed in its model; the pet page falls back to the original for an unknown id
      if (typeof raw.scheme === 'string' && /^[a-z0-9-]{1,32}$/.test(raw.scheme)) skin.scheme = raw.scheme;
      if (PALETTES.some(p => p.id === raw.palette)) skin.palette = raw.palette;
      for (const slot of SLOTS) if (SLOT_LISTS[slot].some(h => h[0] === raw[slot])) skin[slot] = raw[slot];
      for (const slot of SLOTS) for (const ch of ['main', 'acc']) {
        const v = raw.colors?.[slot]?.[ch];
        if (validColor(slot, v)) skin.colors[slot][ch] = v;
      }
      return skin;
    }
    /** Picking an item: fills the character colors of pieces that carry them. */
    function wear(skin, slot, id) {
      const next = { ...skin, colors: JSON.parse(JSON.stringify(skin.colors)) };
      next[slot] = id;
      if (ITEM_COLORS[id]) Object.assign(next.colors[slot], ITEM_COLORS[id]);
      return next;
    }
    function channelValue(skin, slot, ch, dark) {
      const v = skin.colors[slot][ch];
      if (v === 'body') return 'var(--skin-ink)';
      if (v === 'eye') return 'var(--skin-eye)';
      const c = ACC_COLORS.find(x => x.id === v);
      return dark ? c.d : c.l;
    }
    /** CSS custom properties for one theme side. */
    function skinVars(skin, dark) {
      const p = PALETTES.find(x => x.id === skin.palette) || PALETTES[0];
      let s = `--skin-ink:${p[dark ? 'd' : 'l'][0]};--skin-eye:${p[dark ? 'd' : 'l'][1]};`;
      for (const slot of SLOTS) for (const ch of ['main', 'acc']) s += `--c-${slot}-${ch}:${channelValue(skin, slot, ch, dark)};`;
      return s;
    }
    /** A stylesheet applying `skin` under `selector`, following the page's light/dark choice. */
    function skinCss(skin, selector = 'html:root') {
      return `${selector}{${skinVars(skin, false)}}` +
        `@media (prefers-color-scheme: dark){${selector}:not([data-theme="light"]){${skinVars(skin, true)}}}` +
        `${selector}[data-theme="dark"]{${skinVars(skin, true)}}`;
    }
    
    /* ---------- the pages' round buttons: icons (24 units, currentColor) and the theme switch ---------- */
    const icon = d => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
    const ICONS = {
      chat: icon('<path d="M6 4.5h12a3 3 0 0 1 3 3v7a3 3 0 0 1-3 3h-6l-4.5 3.5v-3.5H6a3 3 0 0 1-3-3v-7a3 3 0 0 1 3-3z"/>'),
      moon: icon('<path d="M20 14.6A8.2 8.2 0 1 1 9.4 4a6.6 6.6 0 0 0 10.6 10.6z"/>'),
      sun: icon('<circle cx="12" cy="12" r="4"/><path d="M12 2.8v1.6M12 19.6v1.6M2.8 12h1.6M19.6 12h1.6M5.5 5.5l1.1 1.1M17.4 17.4l1.1 1.1M5.5 18.5l1.1-1.1M17.4 6.6l1.1-1.1"/>'),
      play: icon('<path d="M8 5.5v13l10.5-6.5z"/>'),
      pause: icon('<path d="M9 5.5v13M15 5.5v13"/>'),
      // eight flat teeth around a hub
      settings: icon(`<path d="${Array.from({ length: 32 }, (_, i) => {
        const a = (i - .5) * Math.PI / 16, r = i % 4 < 2 ? 9.6 : 7.2;
        return `${i ? 'L' : 'M'}${f(12 + r * Math.cos(a))} ${f(12 + r * Math.sin(a))}`;
      }).join('')}Z"/><circle cx="12" cy="12" r="3"/>`),
      power: icon('<path d="M12 3.5v8M7.2 6.3a8 8 0 1 0 9.6 0"/>'),
      mic: icon('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5v3"/>'),
      // the same microphone struck through
      micOff: icon('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5v3M4 4l16 16"/>'),
      sound: icon('<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/>'),
      soundOff: icon('<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M16 9.5l5 5M21 9.5l-5 5"/>'),
      // a T-shirt: the dressing page
      shirt: icon('<path d="M8.5 3.5 4 6l-1.5 4.5L6 12v8.5h12V12l3.5-1.5L20 6l-4.5-2.5a3.5 3.5 0 0 1-7 0z"/>'),
      eye: icon('<path d="M3 12s3.2-6 9-6 9 6 9 6-3.2 6-9 6-9-6-9-6z"/><circle cx="12" cy="12" r="3"/>'),
      // a page that opens in the browser
      external: icon('<path d="M14 4h6v6M20 4l-8.5 8.5M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/>'),
      eyeOff: icon('<path d="M3 12s3.2-6 9-6c1.6 0 3 .4 4.2 1M21 12s-3.2 6-9 6c-1.6 0-3-.4-4.2-1"/><path d="M9.9 14.1a3 3 0 0 1 4.2-4.2M4 4l16 16"/>'),
      // how much the pet walks on its own, as a gauge: low, middle, high
      roam_off: icon('<path d="M4 16a8 8 0 0 1 16 0"/><path d="M12 16 7 13.2"/><circle cx="12" cy="16" r="1.2" fill="currentColor"/>'),
      roam_calm: icon('<path d="M4 16a8 8 0 0 1 16 0"/><path d="M12 16V10"/><circle cx="12" cy="16" r="1.2" fill="currentColor"/>'),
      roam_free: icon('<path d="M4 16a8 8 0 0 1 16 0"/><path d="M12 16l5-2.8"/><circle cx="12" cy="16" r="1.2" fill="currentColor"/><path d="M19.5 6.5l1.5-1.5M21 10h1.5"/>'),
    };
    /** Sets `theme` ('dark' | 'light') on the page; `button`, when given, shows the mode a click switches to. */
    function applyTheme(theme, button) {
      document.documentElement.dataset.theme = theme;
      if (!button) return;
      const toLight = theme === 'dark';
      button.innerHTML = toLight ? ICONS.sun : ICONS.moon;
      button.title = toLight ? '切到白天模式' : '切到夜间模式';
      button.setAttribute('aria-label', button.title);
    }
    
    /* ---------- sound: synthesized with Web Audio, no files ---------- */
    /** Which kind each sound belongs to; a kind can be silenced on its own (`sfx.configure`). */
    const SOUND_KINDS = {
      move: ['step', 'skid', 'jump', 'land', 'whoosh', 'chirps', 'shake', 'nod', 'spin'],
      touch: ['grab', 'squeak', 'purr', 'poke'],
      face: ['happy', 'wink', 'love', 'surprised', 'angry', 'sad', 'shy', 'yawn'],
      snore: ['snore'],
      talk: ['babble', 'blub'],
      ui: ['tick', 'pop', 'sparkle', 'select', 'listenStart', 'listenEnd'],
    };
    function createSfx({ storageKey = 'cortico-pet.sound.v1', volume = .55 } = {}) {
      let ctx = null, master = null, unlocked = false, on = true, noiseBuf = null, gainValue = volume;
      // kinds turned off, and seconds of snoring per sleep (0 = the whole sleep)
      let muted = new Set(), snoreSeconds = 0;
      try { on = localStorage.getItem(storageKey) !== 'off'; } catch (e) { /* default on */ }
      const R = (a, b) => a + Math.random() * (b - a);
      function ready() {
        if (!on || !unlocked || document.hidden) return null;
        if (!ctx) {
          const C = window.AudioContext || window.webkitAudioContext;
          if (!C) return null;
          ctx = new C();
          master = ctx.createGain(); master.gain.value = gainValue;
          const comp = ctx.createDynamicsCompressor();
          master.connect(comp); comp.connect(ctx.destination);
        }
        if (ctx.state === 'suspended') ctx.resume();
        return ctx;
      }
      function tone({ type = 'sine', f0 = 440, f1 = f0, dur = .1, vol = .2, at = 0, attack = .005, vib = 0, vibRate = 0, filter = 0 }) {
        const c = ready(); if (!c) return;
        const t0 = c.currentTime + at, o = c.createOscillator(), g = c.createGain();
        o.type = type;
        o.frequency.setValueAtTime(f0, t0);
        o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t0 + dur);
        if (vib) {
          const l = c.createOscillator(), lg = c.createGain();
          l.frequency.value = vibRate; lg.gain.value = vib;
          l.connect(lg); lg.connect(o.frequency); l.start(t0); l.stop(t0 + dur + .05);
        }
        g.gain.setValueAtTime(.0001, t0);
        g.gain.exponentialRampToValueAtTime(vol, t0 + attack);
        g.gain.exponentialRampToValueAtTime(.0001, t0 + dur);
        let node = o;
        if (filter) { const bq = c.createBiquadFilter(); bq.type = 'lowpass'; bq.frequency.value = filter; o.connect(bq); node = bq; }
        node.connect(g); g.connect(master);
        o.start(t0); o.stop(t0 + dur + .03);
      }
      function noise({ type = 'bandpass', f0 = 1000, f1 = f0, q = 1, dur = .2, vol = .15, at = 0, attack = .01 }) {
        const c = ready(); if (!c) return;
        if (!noiseBuf) {
          noiseBuf = c.createBuffer(1, c.sampleRate, c.sampleRate);
          const d = noiseBuf.getChannelData(0);
          for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
        }
        const t0 = c.currentTime + at, s = c.createBufferSource(), bq = c.createBiquadFilter(), g = c.createGain();
        s.buffer = noiseBuf; bq.type = type; bq.Q.value = q;
        bq.frequency.setValueAtTime(f0, t0);
        bq.frequency.exponentialRampToValueAtTime(f1, t0 + dur);
        g.gain.setValueAtTime(.0001, t0);
        g.gain.exponentialRampToValueAtTime(vol, t0 + attack);
        g.gain.exponentialRampToValueAtTime(.0001, t0 + dur);
        s.connect(bq); bq.connect(g); g.connect(master);
        s.start(t0, Math.random() * .5); s.stop(t0 + dur + .03);
      }
      const api = {
        unlock() { unlocked = true; ready(); },
        isOn: () => on,
        set(v) { on = v; try { localStorage.setItem(storageKey, v ? 'on' : 'off'); } catch (e) { /* not persisted */ } },
        volume(v) { gainValue = v; if (master) master.gain.value = v; },
        /** `kinds`: kind → on (SOUND_KINDS); `snoreSeconds`: snoring stops this long into a sleep, 0 = never. */
        configure({ kinds, snoreSeconds: s } = {}) {
          if (kinds) muted = new Set(Object.keys(SOUND_KINDS).filter((k) => kinds[k] === false));
          if (typeof s === 'number' && s >= 0) snoreSeconds = s;
        },
        step(run, i) {
          const k = run ? 1.25 : 1;
          tone({ f0: (i ? 520 : 440) * k, f1: (i ? 380 : 330) * k, dur: .06, vol: run ? .07 : .05 });
          if (run) noise({ f0: 2500, q: .8, dur: .05, vol: .03 });
        },
        skid() { noise({ type: 'highpass', f0: 1800, f1: 900, dur: .22, vol: .08 }); },
        jump() { tone({ type: 'triangle', f0: 200, f1: 720, dur: .24, vol: .22, vib: 40, vibRate: 22 }); },
        land(hard) {
          tone({ f0: hard ? 160 : 190, f1: 48, dur: hard ? .28 : .16, vol: hard ? .4 : .25 });
          noise({ type: 'lowpass', f0: hard ? 700 : 500, f1: 120, dur: .12, vol: hard ? .25 : .12 });
          if (hard) tone({ type: 'square', f0: 420, f1: 300, dur: .08, vol: .06, at: .02, filter: 1600 });
        },
        grab() { tone({ type: 'triangle', f0: 680, f1: 1500, dur: .14, vol: .18, vib: 60, vibRate: 30 }); },
        squeak() { tone({ type: 'triangle', f0: R(900, 1200), f1: R(1300, 1700), dur: .09, vol: .08, vib: 40, vibRate: 35 }); },
        whoosh() { noise({ f0: 300, f1: 2400, q: 1.4, dur: .38, vol: .22, attack: .08 }); },
        chirps() { for (let i = 0; i < 3; i++) tone({ f0: 2300 + i * 120, f1: 3200, dur: .06, vol: .06, at: i * .11 }); },
        shake() { for (let i = 0; i < 5; i++) tone({ type: 'square', f0: 180, f1: 160, dur: .05, vol: .05, at: i * .06, filter: 900 }); },
        hmm() { tone({ type: 'triangle', f0: 330, f1: 360, dur: .12, vol: .08 }); tone({ type: 'triangle', f0: 392, f1: 470, dur: .16, vol: .08, at: .14 }); },
        yawn() { tone({ type: 'triangle', f0: 520, f1: 240, dur: 1, vol: .1, vib: 12, vibRate: 5, filter: 1500, attack: .15 }); },
        /** `asleepFor`: seconds since this sleep began. */
        snore(asleepFor = 0) {
          if (snoreSeconds > 0 && asleepFor > snoreSeconds) return;
          noise({ type: 'lowpass', f0: 250, f1: 700, dur: .7, vol: .09, attack: .35 });
        },
        purr() { tone({ type: 'sawtooth', f0: 62, f1: 58, dur: .9, vol: .08, vib: 6, vibRate: 24, filter: 320, attack: .1 }); },
        poke() { tone({ f0: 320, f1: 200, dur: .09, vol: .16 }); },
        nod() { tone({ type: 'triangle', f0: 520, f1: 440, dur: .07, vol: .08 }); tone({ type: 'triangle', f0: 520, f1: 440, dur: .07, vol: .08, at: .2 }); },
        spin() { tone({ type: 'triangle', f0: 300, f1: 1200, dur: .3, vol: .12, vib: 30, vibRate: 18 }); },
        happy() { tone({ type: 'triangle', f0: 660, f1: 700, dur: .1, vol: .14 }); tone({ type: 'triangle', f0: 990, f1: 1050, dur: .14, vol: .14, at: .09 }); },
        wink() { tone({ f0: 1760, dur: .5, vol: .1 }); tone({ f0: 2637, dur: .45, vol: .06, at: .04 }); },
        love() { tone({ f0: 480, f1: 820, dur: .1, vol: .14 }); tone({ f0: 600, f1: 1000, dur: .12, vol: .14, at: .13 }); },
        surprised() { tone({ f0: 380, f1: 1500, dur: .2, vol: .16, vib: 15, vibRate: 12 }); },
        angry() { tone({ type: 'sawtooth', f0: 120, f1: 95, dur: .5, vol: .12, vib: 12, vibRate: 14, filter: 700 }); },
        sad() { tone({ type: 'triangle', f0: 440, f1: 392, dur: .3, vol: .13, vib: 8, vibRate: 6 }); tone({ type: 'triangle', f0: 392, f1: 262, dur: .55, vol: .13, at: .3, vib: 10, vibRate: 5 }); },
        shy() { tone({ f0: 1300, f1: 1600, dur: .07, vol: .07 }); tone({ f0: 1450, f1: 1750, dur: .07, vol: .06, at: .1 }); },
        expr(n) {
          const m = { happy: 'happy', wink: 'wink', love: 'love', surprised: 'surprised', angry: 'angry', sad: 'sad', shy: 'shy', sleepy: 'yawn' };
          if (m[n]) api[m[n]]();
        },
        tick() { tone({ f0: 1200, f1: 1000, dur: .03, vol: .05 }); },
        pop() { tone({ f0: 240, f1: 720, dur: .07, vol: .14 }); },
        sparkle() { [1568, 2093, 2637].forEach((fr, i) => tone({ f0: fr, dur: .25, vol: .06, at: i * .06 })); },
        select() { tone({ type: 'triangle', f0: 520, f1: 1040, dur: .1, vol: .12 }); },
        babble(ch) {
          const fr = 330 + (ch.codePointAt(0) % 9) * 28;
          tone({ type: 'square', f0: fr, f1: fr * R(.85, 1.1), dur: .05, vol: .05, filter: 1800 });
        },
        blub() { tone({ f0: R(500, 700), f1: R(900, 1200), dur: .05, vol: .05 }); },
        listenStart() { tone({ f0: 880, dur: .12, vol: .1 }); tone({ f0: 1320, dur: .16, vol: .1, at: .1 }); },
        listenEnd() { tone({ f0: 1320, dur: .1, vol: .09 }); tone({ f0: 990, dur: .16, vol: .09, at: .09 }); },
      };
      for (const [kind, names] of Object.entries(SOUND_KINDS)) {
        for (const name of names) {
          const play = api[name];
          api[name] = (...args) => { if (!muted.has(kind)) play(...args); };
        }
      }
      return api;
    }
    
    /* ---------- actions the pet can be asked to do ---------- */
    /** Expressions: a face held for a few seconds. */
    const EXPRESSIONS = ['neutral', 'happy', 'wink', 'love', 'shy', 'surprised', 'angry', 'sad', 'sleepy', 'thinking'];
    /** Motions: things the body does. `sit` and `sleep` last until something else happens. */
    const MOTIONS = ['stand', 'jump', 'hop', 'look', 'turn', 'nod', 'shake', 'spin', 'sit', 'sleep', 'dizzy', 'walk', 'run'];
    /**
     * Gestures: short body-language bits layered **over** whatever mode the body is in, the way `pulse`
     * already is. Unlike a motion a gesture never claims the mode, so it plays over standing, sitting,
     * walking and even being carried, and it always ends by itself.
     *
     * Each entry is `{dur, min, face?, blocks?}`. `min` gates it on the body being available and calm
     * (it will not start on top of a jump or a drag), `face` holds an expression for its length,
     * `blocks` names the modes it will not interrupt.
     *
     * Why a layer of its own instead of more `pulse` kinds: `pulse` only reaches `lean`/`tilt`, which is
     * enough for a nod but not for a stretch or a tail swat — those need `sitK`, `sq`, the legs and the
     * arm angles, all of which the figure reads fresh every frame. Adding them as modes would mean a new
     * entry in the `step` switch and a new `faceName` branch; a gesture keeps them all in one table.
     */
    const GESTURES = {
      /** A quick stretch: arms up and back, chest out, spine unbends, a small hop off the ground. */
      stretch: { dur: 2.0, min: 'calm', face: 'sleepy', tone: .9 },
      /** Rising onto her toes to see over the desk edge. Lean forward, body tall, head up. */
      peek: { dur: 2.6, min: 'calm', tone: .8 },
      /** The whale-girl shakes herself dry: fast whole-body oscillation, tail flicking on the beat. */
      shakeout: { dur: 1.5, min: 'calm', face: 'happy', tone: 1 },
      /** Standing on hind legs to paw at your cursor. */
      beg: { dur: 2.2, min: 'calm', face: 'love', tone: 1 },
      /** A slow curl in on herself and back open. */
      curl: { dur: 2.4, min: 'calm', face: 'shy', tone: .7 },
      /** Covering her face with both hands because you said something nice. */
      peekaboo: { dur: 2.2, min: 'calm', face: 'shy', tone: .9 },
      /** One hard tail swat, then a slow suspicious look around. */
      swat: { dur: 1.6, min: 'calm', face: 'angry', tone: 1 },
      /** Wheeze of laughter: shoulders shaking, head tipped back. */
      giggle: { dur: 1.8, min: 'calm', face: 'happy', tone: .9 },
      /** Bracing for a shove. */
      brace: { dur: 1.4, min: 'any', tone: 1 },
      /** Sinking down onto one knee, then back up. */
      curtsy: { dur: 2.8, min: 'calm', face: 'shy', tone: .9 },
      /** A full-body shiver, start to finish. */
      shiver: { dur: 1.3, min: 'calm', tone: 1 },
      /** Nudging your cursor with her nose. */
      nudge: { dur: 2.0, min: 'calm', tone: .8 },
      /** Licking her lips over something she wants. */
      lick: { dur: 1.6, min: 'calm', face: 'thinking', tone: .8 },
    };
    /** How long a gesture is allowed to overlap the next one before the old one is dropped. */
    const GESTURE_OVERLAP = .55;
    /** Body modes in which the figure travels across the stage or squashes fast. */
    const MOVING_MODES = new Set(['drag', 'air', 'crouch', 'land', 'walk', 'run']);
    
    /* ---------- the live pet: simulation, rendering, pointer ---------- */
    /**
     * `els`: { svg, petG, shadowEl, fxG } inside a stage element that receives pointer events.
     * `opts.bounds()` returns { W, H, floorY, S } in stage pixels.
     * `opts.onEvent(kind, detail)` reports what happened to the body: arrived, interrupted, touch, mode.
     * `opts.enter: 'drop'` starts the pet above the top edge, falling to the floor.
     * `opts.figure`, when given, draws the body instead of the built-in one: `figure.draw(petG, face, frame)` keeps
     * its own elements inside `petG` (same logo space, feet at y=256). Its frame adds the face's name, the mode,
     * how long the mode has run, the talk level, drowsiness and how far the body sits.
     * `figure.groupTilt(mode, tilt, lean)`, if present, returns the rotation (degrees) the whole group gets
     * instead of tilt + lean; the frame carries tilt, lean and that rotation (groupRot) so the figure can bend the rest.
     * `figure.colors.z`, if present, colours the sleep z's (otherwise they take the skin's eye colour).
     */
    function createPet(els, opts) {
      const { petG, shadowEl, fxG } = els;
      let custom = opts.figure || null;
      const sfx = opts.sfx;
      const onEvent = opts.onEvent || (() => {});
      let W = 0, H = 0, floorY = 0, S = .42, T = 0;
      let roam = opts.roam ?? 'free';
      let skin = opts.skin || defaultSkin();
      let hold = 0; // until T: an order from outside is in progress, free roaming waits
      const pet = {
        x: 260, fy: 0, vx: 0, vy: 0, facing: 1, faceVis: 1, mode: 'idle', modeT: 0, dur: 0, target: 0,
        speed: 0, stride: 0, lift: 0, bob: 0, phase: 0, lastHalf: 0, lean: 0, tilt: 0, tiltV: 0,
        sq: 0, sqv: 0, sitK: 0, stretch: 0, low: 0, gap: [50, 50], look: [0, 0], drowse: 0,
        feet: STAND.map(l => [l[2], l[3]]), blinkT: 1.5, blinkAge: 9, expr: null, exprUntil: 0,
        nextAt: 1.2, emitAt: 0, airKind: 'jump', turned: false, startle: false, lastAct: '',
        turnAcc: 0, dx: 0, dy: 0, jumpV: 700, jumpVx: 0, xf: null, blushK: 0,
        eyeSig: '', eyeCur: null, eyePrev: null, eyeDims: [[16, 16, 0, 0], [16, 16, 0, 0]], swapAge: 9,
        glance: [0, 0], glanceAt: 0, swing: 0, swingV: 0, prevA: null, velX: 0, talkK: 0, sfxAt: 0, skid: false, cue: 0,
        pulse: null, walkId: 0, listening: false, thinking: false, placed: false, gest: null, gestName: '',
        mood: 0, moodTarget: 0, moodV: 0,
      };
      const pointer = { x: -1e4, y: -1e4, inside: false, vx: 0, samples: [] };
      let press = null, strokeAcc = 0, petCool = 0;
      const P = [];
    
      // points on the body in logo units: where the eyes look from, where tears, z's and hearts start, the bubble's spot
      const COO_ANCHORS = { gaze: [140, 117], tear: [166, 136], z: [196, 40], hearts: [90, 175, 34], bubble: [146, 0] };
      let A = { ...COO_ANCHORS, ...custom?.anchors };
      const minX = () => 104 * S + 8, maxX = () => W - 104 * S - 8;
    
      function resize() {
        const b = opts.bounds();
        W = b.W; H = b.H; floorY = b.floorY; S = b.S;
        if (!pet.placed && W > 0) {
          pet.x = opts.startX != null ? opts.startX : W * .7; pet.placed = true;
          if (opts.enter === 'drop') { pet.fy = -8; pet.vy = 0; pet.vx = 0; pet.airKind = 'drop'; setMode('air'); }
        }
        pet.x = clamp(pet.x, minX(), maxX());
        pet.target = clamp(pet.target, minX(), maxX());
        if (pet.mode !== 'air' && pet.mode !== 'drag') pet.fy = floorY;
      }
    
      function toStage(lx, ly) {
        const c = pet.xf;
        if (!c) return { x: pet.x, y: floorY };
        const x = (lx - c.ax) * c.kx, y = (ly - c.ay) * c.ky, r = c.rot * Math.PI / 180;
        return { x: c.AX + x * Math.cos(r) - y * Math.sin(r), y: c.AY + x * Math.sin(r) + y * Math.cos(r) };
      }
      function hitPet(p) {
        const c = toStage(128, 128);
        return Math.hypot(p.x - c.x, p.y - c.y) < 108 * S;
      }
    
      function setMode(m, o = {}) {
        const prev = pet.mode;
        if ((prev === 'walk' || prev === 'run') && m !== 'idle' && pet.walkId) {
          onEvent('interrupted', { walkId: pet.walkId, x: Math.round(pet.x), by: m });
          pet.walkId = 0;
        }
        pet.mode = m; pet.modeT = 0; pet.turned = false; pet.startle = false; pet.skid = false; pet.cue = 0;
        Object.assign(pet, o);
        if (prev !== m) onEvent('mode', { mode: m });
      }
      const busy = () => pet.mode === 'drag' || pet.mode === 'air' || pet.mode === 'crouch';
      function pickTarget(minDist) {
        for (let i = 0; i < 12; i++) {
          const x = rnd(minX(), maxX());
          if (Math.abs(x - pet.x) > minDist) return x;
        }
        return pet.x - minX() > maxX() - pet.x ? minX() : maxX();
      }
    
      /** Runs a motion. Returns false when the body cannot take it now (in the air, being dragged). */
      function act(a) {
        if (busy()) return false;
        pet.expr = null; pet.lastAct = a;
        const seated = pet.mode === 'sleep' || pet.mode === 'sit';
        switch (a) {
          case 'stand': setMode(seated ? 'wake' : 'idle', seated ? { startle: false } : {}); pet.nextAt = T + 3; break;
          case 'walk': setMode('walk', { target: pickTarget(160) }); break;
          case 'run': setMode('run', { target: pet.x < W / 2 ? maxX() - rnd(0, 30) : minX() + rnd(0, 30) }); break;
          case 'jump': setMode('crouch', { jumpV: 720, jumpVx: pet.facing * 40 }); break;
          case 'hop': setMode('crouch', { jumpV: 480, jumpVx: 0 }); break;
          case 'look': setMode('look'); break;
          case 'turn': if (!seated) setMode('idle'); pet.facing *= -1; sfx.tick(); break;
          case 'nod': pulse('nod', .7); sfx.nod(); break;
          case 'shake': pulse('shake', .7); sfx.shake(); break;
          case 'spin': if (!seated) setMode('idle'); pulse('spin', .6); sfx.spin(); break;
          case 'sit': setMode('sit', { dur: 1e9 }); break;
          case 'sleep': setMode('sleep', { dur: 1e9 }); break;
          case 'dizzy': setMode('dizzy'); break;
          default: return false;
        }
        return true;
      }
      function pulse(kind, dur) { pet.pulse = { kind, t0: T, dur }; }
    
      /**
       * Starts a gesture over whatever the body is doing. Returns false when it cannot start now.
       *
       * A gesture never takes the mode, so it cannot strand the body: whatever mode was running keeps
       * running underneath and reasserts itself the moment the gesture's time is up. The one thing it does
       * own is `expr`, and it restores that too, so a gesture that is cut short leaves no stray expression.
       */
      function gesture(name) {
        const g = GESTURES[name];
        if (!g) return false;
        // `any` is for reactions to your hands (a brace when she is picked up); the rest need a body that
        // is standing or sitting still, so they never land on top of a jump, a walk or a carry.
        if (g.min !== 'any' && (busy() || pet.mode === 'walk' || pet.mode === 'run')) return false;
        const left = pet.gest ? Math.max(0, pet.gest.dur - (T - pet.gest.t0)) : 0;
        // two gestures in a row read as fidgets, so a new one only takes over once the old is mostly done
        if (left > GESTURE_OVERLAP) return false;
        const wasSitting = pet.mode === 'sit' || pet.mode === 'sleep';
        pet.gest = { name, t0: T, dur: g.dur, prevExpr: pet.expr, prevExprUntil: pet.exprUntil, wasSitting };
        if (g.face) setExpr(g.face, g.dur);
        return true;
      }
      /** The name of the gesture running right now, or '' — the figure reads this to aim its arms and tail. */
      const gestureName = () => (pet.gest && T - pet.gest.t0 < pet.gest.dur ? pet.gest.name : '');
    
      /**
       * How expressive she is: 0 flat, 1 as animated as she gets. The owner sets it from how much you have
       * been playing with her; the spring in `step` carries it, so the mood itself never snaps.
       */
      function setMood(v) { pet.moodTarget = clamp(typeof v === 'number' && isFinite(v) ? v : 0, 0, 1); }
    
      function setExpr(n, seconds) {
        if (n === 'sleep') { act('sleep'); return; }
        if (busy()) return;
        if (n === 'dragged') {
          pet.expr = null;
          pet.vy = -1150; pet.vx = rnd(-120, 120); pet.airKind = 'throw'; pet.sqv -= 3;
          sfx.whoosh(); sfx.jump();
          setMode('air'); return;
        }
        if (n === 'dizzy') { pet.expr = null; setMode('dizzy'); return; }
        if (pet.mode === 'look' || pet.mode === 'land') setMode('idle');
        pet.expr = n; pet.exprUntil = T + (seconds ?? (n === 'sleepy' ? 4.4 : 3.2));
        pet.nextAt = Math.max(pet.nextAt, pet.exprUntil + .6);
        pet.sqv += n === 'surprised' ? -2.2 : .8;
        sfx.expr(n);
        if (n === 'love') for (let i = 0; i < 4; i++) emitHeart();
      }
    
      /** Walks (or runs) to stage x. Resolves the walk through onEvent('arrived' | 'interrupted'). */
      function walkTo(x, run, walkId) {
        if (busy()) return false;
        if (pet.mode === 'sleep' || pet.mode === 'sit') setMode('wake', { startle: true });
        const target = clamp(x, minX(), maxX());
        pet.expr = null;
        if (Math.abs(target - pet.x) < 2) { onEvent('arrived', { walkId, x: Math.round(pet.x) }); return true; }
        setMode(run ? 'run' : 'walk', { target, walkId });
        return true;
      }
    
      function faceName() {
        const m = pet.mode;
        if (m === 'drag') return 'dragged';
        if (m === 'air' && pet.airKind === 'throw') return pet.vy < 0 ? 'dragged' : 'surprised';
        if (m === 'air' && pet.airKind === 'drop') return 'surprised';
        if (m === 'dizzy') return pet.modeT < 2.4 ? 'dizzy' : 'squeeze';
        if (m === 'wake') return pet.startle ? 'surprised' : 'waking';
        if (pet.listening && m !== 'sleep') return 'listening';
        if (m === 'sleep') return 'sleep';
        if (pet.expr && T < pet.exprUntil) return pet.expr;
        if (pet.thinking) return 'thinking';
        if (m === 'sit') return 'content';
        if (m === 'run') return 'run';
        return 'neutral';
      }
    
      function decide() {
        const calm = roam === 'calm';
        const opts2 = [['walk', calm ? 10 : 28], ['run', calm ? 0 : 12], ['look', 14], ['jump', calm ? 2 : 8], ['sit', 16], ['expr', 12], ['wait', calm ? 30 : 10]]
          .filter(o => o[1] > 0 && (o[0] !== pet.lastAct || o[0] === 'wait'));
        let r = Math.random() * opts2.reduce((a, o) => a + o[1], 0), pick = 'wait';
        for (const o of opts2) { if ((r -= o[1]) < 0) { pick = o[0]; break; } }
        if (pick === 'look') { setMode('look'); pet.lastAct = 'look'; }
        else if (pick === 'expr') { setExpr(['happy', 'wink', 'love', 'sleepy', 'surprised', 'shy'][Math.floor(Math.random() * 6)]); pet.lastAct = 'expr'; }
        else if (pick === 'sit') { setMode('sit', { dur: rnd(6, 9) }); pet.lastAct = 'sit'; }
        else if (pick !== 'wait') act(pick);
        if (pet.mode === 'idle' && T >= pet.nextAt) pet.nextAt = T + rnd(2, 4);
      }
    
      /* particles */
      function emit(type, p, o = {}) { P.push({ type, x: p.x, y: p.y, vx: 0, vy: 0, age: 0, life: 1, ...o }); }
      function emitHeart() {
        emit('heart', toStage(rnd(A.hearts[0], A.hearts[1]), A.hearts[2] + pet.low), { vx: rnd(-20, 20), vy: rnd(-70, -45), life: 1.6 });
      }
      function dustAt(lx, n, spread) {
        for (let i = 0; i < n; i++) {
          emit('dust', toStage(lx, 250), { vx: rnd(-spread, spread) - pet.facing * rnd(10, 40), vy: rnd(-30, -8), life: rnd(.4, .65) });
        }
      }
    
      function step(dt) {
        T += dt; pet.modeT += dt;
        const m = pet.mode, mt = pet.modeT;
        let sqT = 0, strideT = 0, liftT = 0, leanT = 0, sitT = 0, bobT = 0, rate = 0, lookT = [0, 0], tiltT = 0;
        let tk = 160, tc = 12, drowseT = 0;
        const free = roam !== 'off' && T > hold && !opts.dialogOpen?.();
    
        pet.blinkT -= dt; pet.blinkAge += dt;
        if (pet.blinkT <= 0) { pet.blinkAge = 0; pet.blinkT = Math.random() < .2 ? .28 : rnd(2.2, 5.2); }
    
        const head = toStage(A.gaze[0], A.gaze[1]);
        const pdx = pointer.x - head.x, pdy = pointer.y - head.y, pm = Math.hypot(pdx, pdy) || 1;
        const track = () => {
          if (!pointer.inside) {
            if (T > pet.glanceAt) { pet.glance = Math.random() < .45 ? [0, 0] : [rnd(-3, 5), rnd(-3, 3)]; pet.glanceAt = T + rnd(1.2, 3); }
            return pet.glance;
          }
          const k = Math.min(1, pm / 120);
          return [pdx * pet.facing / pm * 5 * k, pdy / pm * 4 * k];
        };
    
        switch (m) {
          case 'idle': {
            lookT = track();
            if (pointer.inside && !press && pdx * pet.facing < -50 && pm < 600) {
              pet.turnAcc += dt;
              if (pet.turnAcc > .9) { pet.facing *= -1; pet.turnAcc = 0; }
            } else pet.turnAcc = 0;
            if (pet.listening) { lookT = [3, -4]; tiltT = -7; leanT = -2; }
            if (free && !pet.listening && T > pet.nextAt && !(pet.expr && T < pet.exprUntil)) decide();
            break;
          }
          case 'walk': case 'run': {
            const run = m === 'run', d = pet.target - pet.x, dist = Math.abs(d), dir = Math.sign(d) || pet.facing;
            pet.facing = dir;
            const vMax = run ? 250 : 78;
            const vT = Math.min(vMax, run ? dist * 4 + 20 : dist * 3 + 14);
            strideT = run ? 17 : 10; liftT = run ? 15 : 8; bobT = run ? 7 : 3; rate = run ? 4.4 : 2.1;
            leanT = run ? (dist < 50 && pet.speed > 120 ? -6 : 11) : 4;
            if (leanT < 0 && !pet.skid) { pet.skid = true; sfx.skid(); }
            const ramp = Math.min(1, mt / (run ? .35 : .25));
            pet.speed = lerp(pet.speed, vT * smooth(ramp), ease(run ? 6 : 9, dt));
            pet.x += dir * Math.min(dist, pet.speed * dt);
            const k = clamp(pet.speed / vMax, 0, 1);
            strideT *= .4 + .6 * k; liftT *= .4 + .6 * k;
            pet.phase += Math.PI * 2 * rate * dt * Math.max(.35, k);
            lookT = [run ? 4 : 3, run ? 1 : 0];
            const half = Math.floor(pet.phase / Math.PI);
            if (half !== pet.lastHalf) {
              sfx.step(run, half & 1);
              if (run && pet.speed > 120) dustAt(128, dist < 50 ? 3 : 1, 20);
            }
            pet.lastHalf = half;
            if (dist < 1.5) {
              pet.speed = 0;
              const id = pet.walkId; pet.walkId = 0;
              setMode('idle'); pet.nextAt = T + rnd(1.2, 3.2);
              if (id) onEvent('arrived', { walkId: id, x: Math.round(pet.x) });
            }
            break;
          }
          case 'look': {
            if (!pet.cue) { pet.cue = 1; sfx.hmm(); }
            if (mt < .9) lookT = [4, -4];
            else if (mt < 1.8) { if (!pet.turned) { pet.turned = true; pet.facing *= -1; } lookT = [5, 0]; }
            else if (mt < 2.6) lookT = [1, 4];
            else { setMode('idle'); pet.nextAt = T + rnd(1, 2.5); }
            break;
          }
          case 'sit': {
            sitT = 1;
            lookT = track().map(v => v * (1 - pet.drowse));
            if (pet.listening) { lookT = [3, -4]; tiltT = -7; }
            drowseT = clamp((mt - 1.5) / Math.max(1, Math.min(pet.dur, 60) - 1.5), 0, free ? 1 : .45);
            if (pet.drowse > .5) leanT = 7 * pet.drowse * Math.pow(Math.max(0, Math.sin(T * 1.3)), 6);
            if (free && mt > pet.dur) {
              if (Math.random() < .6) setMode('sleep', { dur: rnd(8, 12) });
              else { setMode('idle'); pet.sqv -= 1.2; pet.nextAt = T + rnd(1.5, 3); }
            }
            break;
          }
          case 'sleep': {
            sitT = 1; drowseT = 1; leanT = 5;
            if (free && mt > pet.dur) setMode('wake');
            break;
          }
          case 'wake': {
            if (pet.startle) {
              sitT = 0; lookT = [3, -2];
              if (mt > .9) { setMode('idle'); pet.nextAt = T + rnd(1.5, 3); }
            } else {
              sitT = mt < 1.1 ? 1 : 0;
              if (mt > .5 && !pet.cue) { pet.cue = 1; sfx.yawn(); }
              sqT = mt > .5 && mt < 1.3 ? -.1 : 0;
              leanT = mt < .5 ? 5 : mt < 1.2 ? -5 : 0;
              lookT = mt > 1.2 ? track() : [0, 0];
              if (mt > 1.8) { setMode('idle'); pet.nextAt = T + rnd(1, 2); }
            }
            break;
          }
          case 'crouch': {
            sqT = .24; sitT = .3;
            if (mt > .16) {
              pet.vy = -pet.jumpV; pet.vx = pet.jumpVx; pet.airKind = 'jump'; pet.sqv -= 2.6;
              sfx.jump();
              setMode('air');
            }
            break;
          }
          case 'air': {
            pet.vy += 2300 * dt;
            pet.vx *= Math.exp(-dt * .4);
            pet.x += pet.vx * dt; pet.fy += pet.vy * dt;
            if (pet.x < minX()) { pet.x = minX(); pet.vx = Math.abs(pet.vx) * .55; pet.sqv += .6; }
            if (pet.x > maxX()) { pet.x = maxX(); pet.vx = -Math.abs(pet.vx) * .55; pet.sqv += .6; }
            if (pet.fy - 250 * S < 0 && pet.vy < 0) { pet.fy = 250 * S; pet.vy = Math.abs(pet.vy) * .3; }
            sqT = -Math.min(.12, Math.abs(pet.vy) / 6000);
            tiltT = clamp(pet.vx * .025, -30, 30);
            tk = 70; tc = 8;
            if (pet.fy >= floorY && pet.vy > 0) land();
            break;
          }
          case 'land': {
            sitT = .35 * (1 - smooth(clamp(mt / .35, 0, 1)));
            lookT = [2, 2];
            if (mt > .4) setMode('idle');
            break;
          }
          case 'dizzy': {
            sitT = mt < 2.6 ? 1 : 0;
            if (mt < 2.4 && T > pet.sfxAt) { sfx.chirps(); pet.sfxAt = T + .9; }
            if (mt >= 2.4 && !pet.cue) { pet.cue = 1; sfx.shake(); }
            if (mt < 2.4) tiltT = 8 * Math.sin(T * 4.5) * Math.min(1, mt * 2);
            else if (mt < 3) { const k = (mt - 2.4) / .6; tiltT = 12 * Math.sin(mt * 34) * (1 - k); }
            else { setMode('idle'); pet.sqv -= 1; pet.nextAt = T + rnd(1.5, 3); }
            break;
          }
          case 'drag': {
            pet.dx = lerp(pet.dx, pointer.x, ease(28, dt));
            pet.dy = lerp(pet.dy, Math.min(pointer.y, floorY - 245 * S), ease(28, dt));
            tiltT = clamp(pointer.vx * .035, -40, 40); tk = 90; tc = 5;
            if (Math.abs(pointer.vx) > 500 && T > pet.sfxAt) { sfx.squeak(); pet.sfxAt = T + rnd(.4, .7); }
            break;
          }
        }
    
        // short gestures layered over whatever the body is doing
        if (pet.pulse) {
          const k = (T - pet.pulse.t0) / pet.pulse.dur;
          if (k >= 1) pet.pulse = null;
          else if (pet.pulse.kind === 'nod') leanT += 9 * Math.abs(Math.sin(k * Math.PI * 2));
          else if (pet.pulse.kind === 'shake') tiltT += 10 * Math.sin(k * Math.PI * 6) * (1 - k);
          else if (pet.pulse.kind === 'spin' && k > .5 && !pet.pulse.flipped) { pet.pulse.flipped = true; pet.facing *= -1; }
          else if (pet.pulse.kind === 'spin' && k < .5 && !pet.pulse.first) { pet.pulse.first = true; pet.facing *= -1; pet.sqv -= 1; }
        }
    
        // a gesture plays over the mode and over any pulse; when it ends it hands the body back untouched
        if (pet.gest) {
          const g = pet.gest, def = GESTURES[g.name], k = (T - g.t0) / g.dur;
          if (!def || k >= 1) {
            pet.gest = null;
            if (def) {
              // Hand the face back. `setExpr` pushed `exprUntil` past the gesture on purpose (the face has
              // to keep holding while she moves), so it must be pulled back here or the face outlives the
              // gesture and never clears — which is what a stray `expr` left on `pet` does: the same kind of
              // silent residue the sit-state bug had. Order matters: the old face first, so a face that was
              // already running is restored rather than cleared.
              if (g.prevExpr && T < g.prevExprUntil) { pet.expr = g.prevExpr; pet.exprUntil = g.prevExprUntil; }
              else if (def.face && pet.expr === def.face) { pet.expr = null; pet.exprUntil = 0; }
            }
          } else {
            // ease in over the first fifth and out over the last quarter, so nothing pops
            const env = smooth(clamp(k / .2, 0, 1)) * smooth(clamp((1 - k) / .25, 0, 1));
            const s = def.tone;
            const beat = Math.sin(k * Math.PI * 4);
            // Everything below **adds** to what the mode asked for, never replaces it: `sitT` is lerped
            // toward a depth and `lookT` is blended into the gaze the mode built for this frame (standing
            // tracks your cursor, sleeping tracks nothing). Writing over those instead would leave the body
            // holding a walking lean after the gesture was over.
            const gaze = (lx, ly) => { lookT = [lerp(lookT[0], lx, env), lerp(lookT[1], ly, env)]; };
            switch (g.name) {
              // front legs up, spine stretching back, then a small push off the floor
              case 'stretch':
                liftT += .35 * env; sitT = lerp(sitT, .12, env);
                leanT += -16 * env * s; tiltT += 6 * env * s; bobT += 6 * env * s;
                break;
              // up on the toes: the hips rise and the head comes forward and up
              case 'peek':
                liftT += .8 * env; sitT = lerp(sitT, 0, env * .5);
                leanT += 10 * env * s; gaze(4, -5); tiltT += -3 * env * s;
                break;
              // a fast full-body shiver; each beat throws the skirt and the tail out to the side
              case 'shakeout':
                tiltT += 16 * env * s * beat; leanT += 5 * env * s * beat;
                bobT += 3 * env * s * Math.abs(beat); sqT += .05 * env * s * Math.abs(beat);
                break;
              // standing up tall on the back legs, pawing forward
              case 'beg':
                liftT += .9 * env; sitT = lerp(sitT, 0, env);
                leanT += -6 * env * s; gaze(2, -6);
                tiltT += 4 * env * s * Math.sin(k * Math.PI * 6);
                break;
              // curling in, shoulders up, then opening back out
              case 'curl':
                sitT = lerp(sitT, .85, env); sqT -= .08 * env * s;
                leanT += 8 * env * s; tiltT += 4 * env * s; gaze(-3, 4);
                break;
              // both hands up over the face, peeking through the fingers
              case 'peekaboo':
                sitT = lerp(sitT, .3, env); gaze(0, 2); tiltT += 3 * env * s;
                break;
              // one hard swat to the side and a hard look round
              case 'swat':
                tiltT += 22 * env * s * Math.sin(k * Math.PI * 2);
                leanT += 10 * env * s * Math.cos(k * Math.PI * 2);
                bobT += 4 * env * s;
                break;
              // laughing: shoulders and head shake, chest out
              case 'giggle':
                tiltT += 7 * env * s * beat; leanT += 4 * env * s;
                bobT += 2.5 * env * s * Math.abs(beat);
                break;
              // bracing: pulled low and wide, chin down, waiting for the shove
              case 'brace':
                sitT = lerp(sitT, .7, env); sqT += .12 * env * s;
                leanT += -12 * env * s; tiltT += 5 * env * s;
                break;
              // down onto one knee and back up, head dipping on the way down
              case 'curtsy':
                sitT = lerp(sitT, .95, Math.sin(k * Math.PI) * env);
                leanT += 9 * env * s * Math.sin(k * Math.PI * 2);
                tiltT += 5 * env * s * Math.sin(k * Math.PI);
                gaze(0, 3);
                break;
              // a shiver that runs out from the head down
              case 'shiver':
                tiltT += 9 * env * s * Math.sin(k * Math.PI * 10) * (1 - k * .6);
                sqT += .04 * env * s;
                break;
              // leaning in to push your cursor along
              case 'nudge':
                leanT += 20 * env * s * Math.sin(k * Math.PI * 3);
                liftT += .3 * env; gaze(5, 0);
                break;
              // lick, then a hopeful look up
              case 'lick':
                tiltT += 4 * env * s * Math.sin(k * Math.PI * 6);
                gaze(3, -2); leanT += 5 * env * s;
                break;
            }
          }
        }
    
        const fname = faceName(), fc = FACES[fname].f(T, pet);
        if (fc.lookLock || pet.mode === 'sleep' || pet.mode === 'drag') lookT = [0, 0];
    
        // eye shape changes hide under a quick blink; same-shape changes (ring size) ease
        const sig = fc.eyes.map(e => e.shape).join();
        if (sig !== pet.eyeSig) {
          if (pet.eyeCur) { pet.eyePrev = pet.eyeCur; pet.swapAge = 0; }
          pet.eyeSig = sig;
          fc.eyes.forEach((e, i) => { pet.eyeDims[i] = [e.rx ?? 16, e.ry ?? 16, e.dx || 0, e.dy || 0]; });
        }
        pet.swapAge += dt;
        pet.eyeCur = fc.eyes.map((e, i) => {
          if (e.shape !== 'ring' && e.shape !== 'lid') return e;
          const d = pet.eyeDims[i], tgt = [e.rx ?? 16, e.ry ?? 16, e.dx || 0, e.dy || 0];
          for (let j = 0; j < 4; j++) d[j] = lerp(d[j], tgt[j], ease(16, dt));
          return { ...e, rx: d[0], ry: d[1], dx: d[2], dy: d[3] };
        });
        pet.blushK = lerp(pet.blushK, fc.blush || 0, ease(6, dt));
    
        // springs & easing
        pet.sqv += ((sqT - pet.sq) * 280 - pet.sqv * 14) * dt;
        pet.sq = clamp(pet.sq + pet.sqv * dt, -.35, .45);
        pet.tiltV += ((tiltT - pet.tilt) * tk - pet.tiltV * tc) * dt;
        pet.tilt += pet.tiltV * dt;
        pet.lean = lerp(pet.lean, leanT, ease(7, dt));
        pet.sitK = lerp(pet.sitK, sitT, ease(m === 'land' ? 18 : 6, dt));
        pet.drowse = lerp(pet.drowse, drowseT, ease(m === 'sit' || m === 'sleep' ? 1.5 : 6, dt));
        pet.stretch = lerp(pet.stretch, m === 'drag' ? 1 : 0, ease(8, dt));
        pet.stride = lerp(pet.stride, strideT, ease(10, dt));
        pet.lift = lerp(pet.lift, liftT, ease(10, dt));
        pet.bob = lerp(pet.bob, bobT, ease(10, dt));
        pet.look[0] = lerp(pet.look[0], lookT[0], ease(9, dt));
        pet.look[1] = lerp(pet.look[1], lookT[1], ease(9, dt));
        pet.gap[0] = lerp(pet.gap[0], fc.gap[0], ease(8, dt));
        pet.gap[1] = lerp(pet.gap[1], fc.gap[1], ease(8, dt));
        // turning reads as a quick card flip rather than a mirror snap
        pet.faceVis = lerp(pet.faceVis, pet.facing, ease(15, dt));
        if (m !== 'walk' && m !== 'run') pet.phase = lerp(pet.phase, Math.round(pet.phase / Math.PI) * Math.PI, ease(6, dt));
        pointer.vx *= Math.exp(-dt * 6);
    
        // secondary motion for ears/antenna/scarf: lags behind horizontal movement
        const AX = pet.mode === 'drag' ? pet.dx : pet.x;
        if (pet.prevA != null) pet.velX = lerp(pet.velX, (AX - pet.prevA) / dt, .25);
        pet.prevA = AX;
        const swingT = clamp(-pet.velX * .06 * Math.sign(pet.faceVis || 1), -28, 28);
        pet.swingV += ((swingT - pet.swing) * 110 - pet.swingV * 7) * dt;
        pet.swing = clamp(pet.swing + pet.swingV * dt, -40, 40);
    
        pet.low = pet.sitK * 29 + pet.bob * Math.abs(Math.sin(pet.phase));
        pet.feet.forEach((ft, i) => {
          const hx = HIPS[i][0], hy = HIPS[i][1] + pet.low;
          let tx, ty;
          if (m === 'drag') { tx = hx + 7 * Math.sin(T * 11 + i * 2.2); ty = hy + 36; }
          else if (m === 'air') { tx = hx + (i ? 9 : -9); ty = hy + 33; }
          else {
            const ph = pet.phase + i * Math.PI;
            const sx = hx + pet.stride * Math.sin(ph), sy = FOOT_Y - pet.lift * Math.max(0, Math.cos(ph));
            tx = lerp(sx, hx + 26, pet.sitK); ty = lerp(sy, FOOT_Y, pet.sitK);
          }
          const r = m === 'drag' || m === 'air' ? 14 : 40;
          ft[0] = lerp(ft[0], tx, ease(r, dt)); ft[1] = lerp(ft[1], ty, ease(r, dt));
        });
    
        if (fc.emit && T > pet.emitAt) {
          if (fc.emit === 'heart') { emitHeart(); pet.emitAt = T + .45; }
          if (fc.emit === 'z') { emit('z', toStage(A.z[0], A.z[1] + pet.low), { vx: pet.facing * 16, vy: -26, life: 2.4 }); pet.emitAt = T + 1.3; sfx.snore(pet.modeT); }
          if (fc.emit === 'tear') { emit('drop', toStage(A.tear[0] + pet.look[0], A.tear[1] + pet.low), { vx: pet.facing * rnd(10, 30), vy: -20, life: 3 }); pet.emitAt = T + .8; }
        }
        strokeAcc *= Math.exp(-dt * 1.5);
        petCool -= dt;
    
        for (let i = P.length - 1; i >= 0; i--) {
          const p = P[i];
          p.age += dt; p.x += p.vx * dt; p.y += p.vy * dt;
          if (p.type === 'drop') { p.vy += 900 * dt; if (p.y > floorY) p.age = p.life; }
          if (p.type === 'dust') p.vx *= Math.exp(-dt * 4);
          if (p.age >= p.life) P.splice(i, 1);
        }
        pet.talkK *= Math.exp(-dt * 12);
        // how lively she feels, 0..1: the owner sets it, the spring here keeps it from ever jumping
        pet.moodV += ((pet.moodTarget - pet.mood) * 90 - pet.moodV * 13) * dt;
        pet.mood = clamp(pet.mood + pet.moodV * dt, 0, 1);
        pet.gestName = gestureName();
        pet._fc = fc; pet._fname = fname;
      }
    
      function land() {
        const impact = pet.vy, kind = pet.airKind;
        pet.fy = floorY; pet.vy = 0; pet.vx = 0;
        pet.sqv += clamp(impact * .0024, .8, 4.5);
        sfx.land(kind !== 'jump' && impact > 1000);
        dustAt(128, impact > 900 ? 7 : 3, 70);
        if (kind === 'throw' && impact > 1000) { setMode('dizzy'); onEvent('touch', { kind: 'crash' }); return; }
        setMode('land');
        if (kind === 'throw') { pet.expr = 'surprised'; pet.exprUntil = T + .9; pet.nextAt = T + 2; }
        else if (kind === 'drop') { pet.expr = 'happy'; pet.exprUntil = T + 1.6; pet.nextAt = T + 2.6; }
        else pet.nextAt = T + rnd(.8, 2);
      }
    
      function render() {
        const fc = pet._fc || FACES.neutral.f(0), fname = pet._fname || 'neutral';
        const drag = pet.mode === 'drag';
        const br = Math.sin(T * (pet.mode === 'sleep' ? 1.7 : 2.4));
        const sx = (1 + pet.sq * .7) * (1 - .05 * pet.stretch) * (1 - .009 * br);
        const sy = (1 - pet.sq) * (1 + .09 * pet.stretch) * (1 + .016 * br);
        const ax = 128, ay = drag ? 36 : 256;
        let AX = drag ? pet.dx : pet.x, AY = drag ? pet.dy : pet.fy;
        if (fc.shake) AX += Math.sin(T * 60) * 1.4;
        // a custom figure may keep tilt and lean off the whole group and bend its own parts instead
        const kx = S * pet.faceVis * sx, ky = S * sy, lean = pet.lean * pet.faceVis;
        const rot = custom?.groupTilt ? custom.groupTilt(pet.mode, pet.tilt, lean) : pet.tilt + lean;
        pet.xf = { AX, AY, ax, ay, kx, ky, rot };
        petG.setAttribute('transform', `translate(${f(AX)} ${f(AY)}) rotate(${f(rot)}) scale(${kx.toFixed(4)} ${ky.toFixed(4)}) translate(${-ax} ${-ay})`);
    
        const legs = pet.feet.map((ft, i) => [HIPS[i][0], HIPS[i][1] + pet.low, ft[0], ft[1]]);
        const blink = pet.blinkAge < .16 ? Math.sin(Math.PI * pet.blinkAge / .16) : 0;
        let eyes = pet.eyeCur || fc.eyes, eyeClose = 0;
        if (pet.swapAge < .07 && pet.eyePrev) { eyes = pet.eyePrev; eyeClose = pet.swapAge / .07; }
        else if (pet.swapAge < .16) eyeClose = 1 - (pet.swapAge - .07) / .09;
        const face = { ...fc, eyes, gap: pet.gap.map(g => Math.min(64, g + pet.talkK * 12)), blush: pet.blushK };
        const frame = { look: pet.look, legs, low: pet.low, t: T, blink, eyeClose, acc: skin, swing: pet.swing };
        if (custom) custom.draw(petG, face, { ...frame, face: fname, mode: pet.mode, modeT: pet.modeT, talk: pet.talkK, drowse: pet.drowse, sit: pet.sitK, facing: pet.faceVis, tilt: pet.tilt, lean, groupRot: rot, gest: pet.gestName, mood: pet.mood });
        else petG.innerHTML = figure(face, frame);
    
        const footY = drag ? pet.dy + 220 * S * 1.09 : pet.fy;
        const k = clamp(1 - (floorY - footY) / 420, .3, 1);
        shadowEl.setAttribute('cx', f(AX)); shadowEl.setAttribute('cy', f(floorY - 2));
        shadowEl.setAttribute('rx', f(72 * S * k * (1 + pet.sq * .5))); shadowEl.setAttribute('ry', f(10 * S * k + 1));
        shadowEl.setAttribute('opacity', f(k));
    
        let s = '';
        const sc = S / .48;
        // sleep z's take the eye colour, or the custom figure's own colour for them
        const zPaint = custom?.colors?.z ? `stroke="${custom.colors.z}"` : 'class="eye"';
        for (const p of P) {
          const a = p.age / p.life;
          if (p.type === 'z') {
            const op = a < .15 ? a / .15 : 1 - (a - .15) / .85, z = (.7 + .9 * a) * sc;
            s += `<path ${zPaint} fill="none" stroke-width="${f(3 / z)}" stroke-linecap="round" stroke-linejoin="round" opacity="${f(op)}" transform="translate(${f(p.x + Math.sin(p.age * 2.5) * 6)} ${f(p.y)}) scale(${f(z)})" d="M-6 -7H6L-6 7H6"/>`;
          } else if (p.type === 'heart') {
            s += `<path class="p-heart" fill="none" stroke-width="5" stroke-linejoin="round" opacity="${f(1 - a * a)}" transform="translate(${f(p.x + Math.sin(p.age * 4) * 5)} ${f(p.y)}) scale(${f((.45 + .35 * a) * sc)})" d="${heartD(0, 0, 1)}"/>`;
          } else if (p.type === 'dust') {
            s += `<circle class="p-dust" fill="none" stroke-width="2" cx="${f(p.x)}" cy="${f(p.y)}" r="${f((3 + 8 * a) * sc)}" opacity="${f(.7 * (1 - a))}"/>`;
          } else if (p.type === 'drop') {
            s += `<path class="tearf" transform="translate(${f(p.x)} ${f(p.y)}) scale(${f(.9 * sc)})" d="${DROP}"/>`;
          }
        }
        fxG.innerHTML = s;
        return fname;
      }
    
      /* pointer: stage-pixel coordinates */
      function velocity() {
        const s = pointer.samples;
        if (s.length < 2) return { x: 0, y: 0 };
        const a = s[0], b = s[s.length - 1], dt = Math.max(.016, (b.t - a.t) / 1000);
        return { x: (b.x - a.x) / dt, y: (b.y - a.y) / dt };
      }
      function pointerDown(p) {
        Object.assign(pointer, p, { inside: true });
        if (!hitPet(p) || pet.mode === 'air') return false;
        press = { x: p.x, y: p.y, t: performance.now() };
        pointer.samples = [{ t: performance.now(), x: p.x, y: p.y }];
        return true;
      }
      /** Returns the cursor the stage should show. */
      function pointerMove(p) {
        const now = performance.now();
        const ddx = p.x - pointer.x, ddy = p.y - pointer.y;
        Object.assign(pointer, p, { inside: true });
        pointer.samples.push({ t: now, x: p.x, y: p.y });
        while (pointer.samples.length > 2 && now - pointer.samples[0].t > 110) pointer.samples.shift();
        pointer.vx = lerp(pointer.vx, velocity().x, .35);
    
        if (press && pet.mode !== 'drag' && Math.hypot(p.x - press.x, p.y - press.y) > 6) {
          const scruff = toStage(128, 36);
          pet.expr = null;
          setMode('drag', { dx: scruff.x, dy: scruff.y });
          sfx.grab();
          pet.sqv -= 1.2; pet.tiltV = 0;
          onEvent('touch', { kind: 'grab' });
        }
        if (press) return 'grabbing';
        const over = hitPet(p);
        if (over && ['idle', 'look', 'sit', 'sleep'].includes(pet.mode)) {
          strokeAcc += Math.hypot(ddx, ddy);
          if (strokeAcc > 320 && petCool <= 0) {
            strokeAcc = 0; petCool = 2.5;
            sfx.purr();
            if (pet.mode === 'sleep') emitHeart();
            else setExpr(Math.random() < .5 ? 'love' : 'shy');
            onEvent('touch', { kind: 'pet', asleep: pet.mode === 'sleep' });
          }
        }
        return over ? 'grab' : '';
      }
      function pointerUp() {
        if (!press) return;
        if (pet.mode === 'drag') {
          // hand over from the scruff anchor to the feet anchor without a visual jump
          const foot = toStage(128, 256);
          const v = velocity();
          pet.x = clamp(foot.x, minX(), maxX());
          pet.fy = Math.min(floorY, foot.y);
          pet.vx = clamp(v.x, -1800, 1800); pet.vy = clamp(v.y, -1800, 1400);
          pet.airKind = 'throw';
          const speed = Math.hypot(v.x, v.y);
          if (speed > 700) sfx.whoosh();
          setMode('air');
          onEvent('touch', { kind: speed > 700 ? 'throw' : 'drop', x: Math.round(pet.x) });
        } else if (performance.now() - press.t < 400) {
          if (pet.mode === 'sleep' || pet.mode === 'sit') {
            const wasAsleep = pet.mode === 'sleep';
            setMode('wake', { startle: true }); pet.sqv -= 2.2; pet.nextAt = T + 2.4;
            sfx.surprised();
            onEvent('touch', { kind: 'poke', woke: wasAsleep });
          } else if (pet.mode !== 'dizzy') {
            sfx.poke();
            const r = ['happy', 'wink', 'surprised', 'love', 'angry'][Math.floor(Math.random() * 5)];
            setExpr(r);
            if (Math.random() < .5 && pet.mode === 'idle') setMode('crouch', { jumpV: 480, jumpVx: 0 });
            onEvent('touch', { kind: 'poke' });
          }
        }
        press = null;
      }
      /**
       * Ends a drag with the body dropped from under stage point `p` with no throw: the pointer was let
       * go of on another display and the stage now covers that one. Call after `resize()` has taken the
       * new size.
       */
      function dropAt(p) {
        press = null;
        if (pet.mode !== 'drag') return;
        Object.assign(pointer, p, { vx: 0, samples: [] });
        pet.x = clamp(p.x, minX(), maxX());
        pet.fy = Math.min(floorY, p.y + 220 * S);
        pet.vx = 0; pet.vy = 0;
        pet.airKind = 'drop';
        setMode('air');
        onEvent('touch', { kind: 'drop', x: Math.round(pet.x) });
      }
      /**
       * Keeps a held body under the pointer when the stage moved to another display mid-drag: every
       * point on screen now sits (dx, dy) stage pixels from where it was.
       */
      function shiftDrag(dx, dy) {
        if (pet.mode !== 'drag') return;
        pet.dx += dx; pet.dy += dy; pet.x += dx;
        pointer.x += dx; pointer.y += dy;
        for (const s of pointer.samples) { s.x += dx; s.y += dy; }
        if (press) { press.x += dx; press.y += dy; }
      }
      function pointerLeave() { if (!press) pointer.inside = false; }
    
      resize();
      return {
        pet, step, render, resize, act, setExpr, walkTo, toStage, hitPet, busy,
        pointerDown, pointerMove, pointerUp, pointerLeave, dropAt, shiftDrag,
        gesture, gestureName, setMood, GESTURES,
        get pressing() { return !!press; },
        /** Pressed, carried, airborne, walking, running, turning round, or in a nod, shake or spin: motion that frames far apart show as jumps. */
        get moving() {
          return !!press || MOVING_MODES.has(pet.mode) || !!pet.pulse || Math.abs(pet.faceVis - pet.facing) > .05;
        },
        get time() { return T; },
        get bounds() { return { W, H, floorY, S, minX: minX(), maxX: maxX() }; },
        setSkin(s) { skin = s; },
        /** Swaps the body's drawing: a custom figure (see `opts.figure`) or null for the built-in Coo. */
        setFigure(fig) {
          if (fig === custom) return;
          // a swapped-out figure may hold a WebGL context; release it now instead of waiting for GC
          custom?.dispose?.();
          custom = fig || null;
          A = { ...COO_ANCHORS, ...custom?.anchors };
          petG.textContent = '';
          render();
        },
        get figure() { return custom; },
        get skin() { return skin; },
        setRoam(r) { roam = r; if (r !== 'off') pet.nextAt = T + 1; },
        get roam() { return roam; },
        /** Outside orders keep free roaming quiet for `seconds`. */
        holdRoam(seconds) { hold = Math.max(hold, T + seconds); },
        talk() { pet.talkK = 1; },
        setListening(on) { pet.listening = on; if (on && (pet.mode === 'walk' || pet.mode === 'run')) setMode('idle'); },
        setThinking(on) { pet.thinking = on; },
        /** Head top in stage pixels, for placing a speech bubble. */
        anchor() { return toStage(A.bubble[0], (custom ? A.bubble[1] : (HEAD_TOP[skin.head] ?? 12) - 8) + pet.low); },
        emitHeart,
      };
    }
    
        return { createPet: createPet, createSfx: createSfx, EXPRESSIONS: EXPRESSIONS, MOTIONS: MOTIONS, FACES: FACES, GESTURES: GESTURES };
      })();
      return {
        createWhaleFigure: figure.createWhaleFigure,
        createPet: core.createPet,
        createSfx: core.createSfx,
        EXPRESSIONS: core.EXPRESSIONS,
        MOTIONS: core.MOTIONS,
        FACES: core.FACES,
        GESTURES: core.GESTURES,
      };
    })();
    var WHALE_ICON_URI = "data:image/png;base64,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";
    /* __PET_RUNTIME_END__ */
    // ============================================================================

    var CSS = `
.pw-strip{display:flex;align-items:center;gap:6px;width:100%;box-sizing:border-box;
  padding:4px 6px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;
  background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);
  font:inherit;font-size:12px;line-height:18px;text-align:left;cursor:pointer;
  transition:border-color .15s ease,background .15s ease}
.pw-strip:hover{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l2)}
.pw-strip[data-tone="off"]{border-color:var(--dsw-alias-state-success-primary)}
.pw-strip[data-tone="peak"]{border-color:var(--dsw-alias-state-warn-primary)}
.pw-strip[data-wide="0"]{justify-content:center;padding:4px}
.pw-strip-icon{flex:0 0 auto;width:19px;height:20px;display:block;object-fit:contain;
  user-select:none;-webkit-user-drag:none;pointer-events:none}
.pw-title{font-weight:600;white-space:nowrap}
.pw-title[data-tone="off"]{color:var(--dsw-alias-state-success-primary)}
.pw-title[data-tone="peak"]{color:var(--dsw-alias-state-warn-primary)}
.pw-spacer{flex:1 1 auto;min-width:4px}
.pw-count{white-space:nowrap;font-variant-numeric:tabular-nums}
/* 状态条改成两行：上行还是「时段 + 倒计时」，下行是「余额 + 今日费用」。
   侧栏只有约 260px 宽，两行比挤在一行里更读得清。 */
.pw-body{flex:1 1 auto;min-width:0;display:flex;flex-direction:column}
.pw-row{display:flex;align-items:center;gap:6px;min-width:0}
/* 第二行**只在真拿到数据时渲染**：一条极细分隔线把它和倒计时分开，
   标签走次级色、数字走主色加粗并用等宽数字，读起来是一行数据而不是一句提示。 */
.pw-wallet{display:flex;align-items:center;gap:5px;min-width:0;
  margin-top:5px;padding-top:4px;
  border-top:1px solid var(--dsw-alias-border-l1);
  white-space:nowrap;overflow:hidden}
.pw-witem{display:inline-flex;align-items:baseline;gap:4px;min-width:0;
  font-size:11px;line-height:15px;color:var(--dsw-alias-label-secondary);
  font-variant-numeric:tabular-nums;overflow:hidden}
.pw-witem b{font-weight:600;color:var(--dsw-alias-label-primary)}
.pw-wlabel{white-space:nowrap}
.pw-wvalue{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pw-wsep{font-size:11px;line-height:15px;color:var(--dsw-alias-label-secondary);opacity:.75}
.pw-backdrop{position:fixed;inset:0;z-index:1190}
/* 竖长卡片：宽度对齐侧栏（340px），高度给到 560px —— 详细版内容超出就在卡片内滚动。
   价格表四列在窄卡片里用 11px + 收紧内边距，第一列允许折行（见下面 .pw-table）。
   亚克力（毛玻璃）：半透明底 + backdrop-filter；不支持的环境用 @supports 退回不透明底色。 */
.pw-pop{position:fixed;left:12px;bottom:56px;width:340px;max-width:calc(100vw - 24px);
  max-height:560px;display:flex;flex-direction:column;overflow:hidden;
  box-sizing:border-box;padding:12px 14px;border-radius:12px;
  border:1px solid var(--dsw-alias-border-l2);
  background:color-mix(in srgb, var(--dsw-alias-bg-overlay) 76%, transparent);
  -webkit-backdrop-filter:blur(18px) saturate(1.5);
  backdrop-filter:blur(18px) saturate(1.5);
  color:var(--dsw-alias-label-primary);box-shadow:0 10px 32px rgba(0,0,0,.28);
  font-size:12px;line-height:20px;z-index:1200}
@supports not ((backdrop-filter:blur(2px)) or (-webkit-backdrop-filter:blur(2px))){
  .pw-pop{background:var(--dsw-alias-bg-overlay)}
}
.pw-pop .pw-dim{opacity:.5}
.pw-pop b{font-weight:600}
/* 窄卡片（340px）里的四列表：11px 字号 + 3px 内边距 + 固定布局；
   第一列（模型名）允许折行，其余数字列仍然不换行，四列刚好排得下。 */
.pw-table{width:100%;border-collapse:collapse;margin:6px 0 2px;font-size:11px;table-layout:fixed}
.pw-table th,.pw-table td{padding:2px 3px;text-align:right;white-space:nowrap}
.pw-table th:first-child,.pw-table td:first-child{text-align:left;white-space:normal}
.pw-table thead th{color:var(--dsw-alias-label-primary);font-weight:600;
  border-bottom:1px solid var(--dsw-alias-border-l1)}
.pw-now{color:var(--dsw-alias-label-primary);font-weight:600}
.pw-dim{opacity:.42}
.pw-slash{opacity:.4}
.pw-link{color:var(--dsw-alias-brand-primary);text-decoration:none}
.pw-link:hover{text-decoration:underline}
.pw-foot{margin-top:6px;opacity:.75;font-size:11px;line-height:17px}
/* ── 账户卡片（详情浮层里的余额与今日费用）───────────────────── */
/* 底色也留一点透明度，毛玻璃才透得出来（不支持的浏览器只是看着更实，不影响可读性）。 */
.pw-wallet-card{margin-top:8px;padding:8px 10px;border-radius:9px;
  border:1px solid var(--dsw-alias-border-l1);
  background:color-mix(in srgb, var(--dsw-alias-bg-layer-1) 74%, transparent)}
.pw-wallet-row{display:flex;align-items:baseline;justify-content:space-between;gap:10px;
  line-height:19px}
.pw-wallet-row .pw-label{color:var(--dsw-alias-label-secondary);white-space:nowrap}
.pw-wallet-row .pw-value{font-weight:600;font-variant-numeric:tabular-nums;text-align:right}
/* 当日费用是这张卡片的主角：单独一段、细分隔线、标签转主色、数字放大一档 */
.pw-wallet-row--today{margin-top:7px;padding-top:7px;
  border-top:1px solid var(--dsw-alias-border-l1)}
.pw-wallet-row--today .pw-label{color:var(--dsw-alias-label-primary);font-weight:600}
.pw-wallet-row--today .pw-value{font-size:13px;line-height:18px}
.pw-wallet-sub{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:17px;
  font-variant-numeric:tabular-nums}
.pw-wallet-links{margin-top:4px;display:flex;gap:10px;font-size:11px;line-height:17px}
.pw-export-btn{margin-top:6px;padding:3px 10px;border:1px solid var(--dsw-alias-border-subtle);border-radius:4px;background:transparent;color:var(--dsw-alias-text-muted);font-size:11px;cursor:pointer;line-height:16px}
.pw-export-btn:hover{background:var(--dsw-alias-bg-hover);color:var(--dsw-alias-text-primary)}
.pw-wallet-note{margin-top:4px;opacity:.7;font-size:11px;line-height:17px}

/* ── 鲸鱼娘桌宠（全屏浮层）────────────────────────────────────
   整层点击穿透，只有 .pw-hitbox（跟随她身体的命中区）开回 pointer-events，
   所以她永远只挡住自己身体那一小块。SVG 由 pet-core 直接驱动：
   #pet 里 figure 会挂一个 <foreignObject> 画布（WebGL2），transform 由物理层设置；
   #shadow 是接地影子；#fx 是爱心 / z / 粒子等特效组。 */
.pw-roam{position:fixed;inset:0;z-index:1185;pointer-events:none}
/* petVisible=false 时整层隐身：visibility 保留布局（getBoundingClientRect
   仍有效，rAF 循环不用停），只是看不见也点不到 */
.pw-roam.is-hidden{visibility:hidden!important}
/* 拖拽时靠近输入框：给鲸鱼身体一圈主色辉光，提示「再近一点就能投递」。
   只挂在 .pw-roam 这一层（身体、影子都在它下面），松手时 class 被摘掉即消失。 */
.pw-roam.is-near-composer .pw-stage{filter:drop-shadow(0 0 8px var(--dsw-alias-brand-primary))}
.pw-roam.is-near-composer .pw-hitbox{box-shadow:0 0 14px 4px var(--dsw-alias-brand-primary);border-radius:50%}
.pw-stage{position:absolute;inset:0;width:100%;height:100%;overflow:visible}
.pw-hitbox{position:absolute;left:0;top:0;width:0;height:0;
  pointer-events:auto;cursor:grab;background:transparent;border:0;padding:0}

/* ── 右键菜单 ─────────────────────────────────────────────── */
/* 必须显式写 pointer-events:auto：父级 .pw-roam 是 none（防止挡住界面），
   不写的话菜单能显示但一个都点不动。 */
.pw-menu-backdrop{position:fixed;inset:0;z-index:1199;pointer-events:auto}
.pw-menu{position:fixed;z-index:1200;min-width:158px;padding:4px;
  border:1px solid var(--dsw-alias-border-l2);border-radius:10px;
  background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);
  box-shadow:0 8px 26px rgba(0,0,0,.26);font-size:12px;line-height:1;
  animation:pw-menu-in .12s ease-out}
.pw-menu button{display:block;width:100%;box-sizing:border-box;padding:7px 10px;
  border:0;border-radius:7px;background:transparent;color:inherit;font:inherit;
  text-align:left;cursor:pointer;white-space:nowrap}
.pw-menu button:hover{background:var(--dsw-alias-bg-layer-2)}
.pw-menu hr{margin:4px 8px;border:0;border-top:1px solid var(--dsw-alias-border-l1)}
.pw-menu-note{padding:6px 10px 4px;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:15px}
@keyframes pw-menu-in{from{opacity:0;transform:scale(.94)}to{opacity:1;transform:scale(1)}}

/* ── 优化气泡：挂在小鲸鱼头顶（位置由 anchor 每帧写入） ─────────────────────
   五种态：busy 优化中（无按钮）/ pick 三版三行（整行替换 / 行内只复制 / 底部
   不优化 + 关闭，对话框语义，不设时限，等你选）/ paste 写不进去时摊正文
   + 复制 / 关闭 / info 已换好（纯文本，6 秒自收）/ error 原因（知道了，8 秒自收）。
   和右键菜单同一个坑：父层 .pw-roam 是 pointer-events:none，
   不显式写 auto 就是「看得见点不动」。 */
.pw-opt{position:absolute;left:0;top:0;transform:translate(-50%,-100%);margin-top:-6px;
  z-index:6;display:flex;flex-direction:column;gap:6px;box-sizing:border-box;
  max-width:min(280px,calc(100vw - 24px));padding:9px 12px;border-radius:12px;
  pointer-events:auto;border:1px solid var(--dsw-alias-border-l2);
  background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);
  box-shadow:0 6px 20px rgba(0,0,0,.22);font-size:12px;line-height:17px;
  animation:pw-pop .2s ease-out}
.pw-opt:after{content:'';position:absolute;left:50%;top:100%;margin-left:-4px;
  border:4px solid transparent;border-top-color:var(--dsw-alias-bg-overlay)}
.pw-opt[data-kind="busy"]{color:var(--dsw-alias-label-secondary)}
.pw-opt[data-kind="info"]{border-color:var(--dsw-alias-state-success-primary)}
.pw-opt[data-kind="error"]{border-color:var(--dsw-alias-state-error-primary)}
.pw-opt[data-kind="error"] .pw-opt-text{white-space:normal}
.pw-opt-ask{display:flex;flex-direction:column;gap:2px;color:var(--dsw-alias-label-primary)}
.pw-opt-actions{display:flex;align-items:center;justify-content:flex-end;gap:8px;width:100%}
.pw-opt-paste-note{flex:1;font-size:11px;color:var(--dsw-alias-label-secondary)}
/* 底部动作行里的「关闭」：从列底右对齐改成行内居中，别掉到行底去 */
.pw-opt-actions .pw-opt-close{align-self:center}
/* 「还是不优化了吧」：左占满、右「关闭」——一个表态一个收摊，同一个动作两种语气 */
.pw-opt-pick-skip{flex:1;min-width:0;text-align:left;background:transparent;border:0;
  padding:4px 0;font-weight:500;color:var(--dsw-alias-label-secondary)}
.pw-opt-pick-skip:hover{color:var(--dsw-alias-label-primary);filter:none}
.pw-opt button{flex:none;border:0;border-radius:999px;padding:4px 12px;cursor:pointer;
  font:inherit;font-weight:600}
/* v0.5.4：√撤销 / ×保留 两个按钮的样式删掉了。
   撤销询问整个取消后，已经没有任何元素带那两个 class，留着就是没人能验的死 CSS ——
   而且日后有人看到它很容易以为"撤销功能还在"，顺手把 UI 接回去。
   .pw-opt-close 还在用（失败态的「知道了」），所以保留。 */
.pw-opt button.pw-opt-close{background:transparent;color:var(--dsw-alias-label-secondary);
  font-weight:500;padding:4px 6px;align-self:flex-end}
.pw-opt button:hover{filter:brightness(1.08)}
.pw-opt[data-kind="pick"]{max-width:min(320px,calc(100vw - 24px));gap:8px}
.pw-opt-pick{display:flex;flex-direction:column;gap:6px;width:100%}
/* 一行 = 一版：整行是「替换」（点哪都写回框里），右边那个小按钮是「只复制」 */
.pw-opt-pick-row{display:flex;align-items:stretch;gap:6px}
.pw-opt-pick-btn{display:flex;flex:1;min-width:0;align-items:center;justify-content:space-between;gap:8px;
  border:1px solid var(--dsw-alias-border-l2);border-radius:10px;
  padding:7px 10px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);
  font-weight:600;text-align:left;cursor:pointer}
.pw-opt-pick-btn:hover{border-color:var(--dsw-alias-brand-primary);filter:none}
.pw-opt-pick-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pw-opt-pick-note{font-size:11px;font-weight:500;color:var(--dsw-alias-label-secondary)}
/* 动作词：整行可点不等于看得出在干什么，「替换」两个字得摆出来 */
.pw-opt-pick-act{flex:none;font-size:11px;font-weight:600;color:var(--dsw-alias-brand-primary)}
.pw-opt-pick-copy{flex:none;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;
  padding:0 10px;cursor:pointer;font:inherit;font-size:11px;font-weight:600;
  background:transparent;color:var(--dsw-alias-label-secondary)}
.pw-opt-pick-copy:hover{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary);filter:none}
/* 字数 / 耗时的注脚：抓没抓好、这一版想了几秒，一眼看得见（原来只有三个标签，
   正文是空是残、这版到底跑没跑上游，全都看不出来） */
.pw-opt-pick-len,.pw-opt-pick-ms{flex:none;font-size:11px;font-weight:500;
  color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
/* 「看正文」折叠区：正文被截断/被代码块包住/混进标题，当场就能发现 */
.pw-opt-preview{width:100%;font-size:11px;color:var(--dsw-alias-label-secondary)}
.pw-opt-preview>summary{cursor:pointer;user-select:none;padding:2px 0;opacity:.85}
.pw-opt-preview>summary:hover{color:var(--dsw-alias-label-primary);filter:none}
.pw-opt-preview-item{margin-top:6px;padding-top:6px;border-top:1px solid var(--dsw-alias-border-l1)}
.pw-opt-preview-label{font-weight:600;margin-bottom:2px;color:var(--dsw-alias-label-primary)}
.pw-opt-preview-body,.pw-opt-paste-body{margin:0;padding:6px 8px;max-height:180px;overflow:auto;
  border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);
  font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;
  line-height:1.5;white-space:pre-wrap;word-break:break-word;user-select:text}
.pw-opt[data-kind="paste"]{max-width:min(380px,calc(100vw - 24px));gap:8px}
.pw-opt-copy{flex:none;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;
  padding:4px 14px;cursor:pointer;font:inherit;font-size:12px;font-weight:600;
  background:var(--dsw-alias-brand-primary);color:#fff}

/* ── 详情浮层：分节标题与底部动作 ──────────────────────────────────────── */
/* 模式切换只在「设置 → 插件 → 小鲸鱼」里改，浮层顶部不再摆开关（v0.4.0 起）。 */
.pw-sec{margin:12px 0 6px;padding-bottom:4px;border-bottom:1px solid var(--dsw-alias-border-l1);
  font-size:11px;font-weight:600;letter-spacing:.06em;color:var(--dsw-alias-label-secondary)}
.pw-sec:first-child{margin-top:0}
/* 详细版底部的「设置」按钮：跳到内置「插件」设置面板（我们的 tab 就在那）。
   吸底：详细版内容比卡片高、要在卡片内滚动，按钮必须**始终露在下沿**而不是被顶出视野。 */
/* 内容区自己滚（面板本体 overflow:hidden）：「设置」按钮因此**独立占位**，
   滚过的文字不会从它下面透出来（曾经用 sticky 叠着，半透明底把字糊成一团）。 */
.pw-pop-body{flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain}
.pw-actions{position:static;flex:none;z-index:1;display:flex;justify-content:flex-end;
  margin:10px -14px -12px;padding:8px 14px 10px;
  background:color-mix(in srgb, var(--dsw-alias-bg-overlay) 96%, transparent);
  border-top:1px solid var(--dsw-alias-border-l1);border-radius:0 0 11px 11px}
.pw-set-btn{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:4px 14px;
  cursor:pointer;font:inherit;font-size:12px;font-weight:500;line-height:18px;
  background:color-mix(in srgb, var(--dsw-alias-bg-layer-1) 72%, transparent);
  color:var(--dsw-alias-label-primary)}
.pw-set-btn:hover{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.pw-usage-btn{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:4px 14px;
  cursor:pointer;font:inherit;font-size:12px;font-weight:500;line-height:18px;
  background:color-mix(in srgb, var(--dsw-alias-bg-layer-1) 72%, transparent);
  color:var(--dsw-alias-label-primary)}
.pw-usage-btn:hover{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}

/* ── 设置页（设置 → 插件 → 小鲸鱼） ─────────────────────────────────────── */
.pw-settings{max-width:640px;display:flex;flex-direction:column;gap:16px;padding:4px 0 16px}
.pw-settings h3{margin:0;font-size:18px;font-weight:600}
.pw-settings h4{margin:0 0 8px;font-size:13px;font-weight:600}
.pw-settings .pw-dim{color:var(--dsw-alias-label-secondary);margin:4px 0 0}
.pw-set-sec{padding:12px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;
  background:var(--dsw-alias-bg-layer-1)}
.pw-set-modes{display:flex;flex-direction:column;gap:8px}
.pw-set-mode{display:flex;align-items:baseline;gap:8px;cursor:pointer;padding:8px 10px;
  border:1px solid var(--dsw-alias-border-l2);border-radius:8px}
.pw-set-mode.is-on{border-color:var(--dsw-alias-brand-primary)}
.pw-set-mode-name{font-weight:600;min-width:56px}
.pw-set-mode-note{color:var(--dsw-alias-label-secondary);font-size:12px}
.pw-set-switch{display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px}
.pw-set-field{display:flex;align-items:center;justify-content:space-between;gap:10px;min-width:0}
.pw-set-label{color:var(--dsw-alias-label-secondary);font-size:12px;white-space:nowrap}
.pw-set-value{font-weight:600;font-variant-numeric:tabular-nums;font-size:12px;text-align:right}
.pw-set-range{flex:1 1 auto;min-width:0;accent-color:var(--dsw-alias-brand-primary);cursor:pointer}
.pw-set-select{flex:1 1 auto;min-width:0;max-width:240px;padding:5px 8px;
  border:1px solid var(--dsw-alias-border-l2);border-radius:8px;
  background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);
  font:inherit;font-size:13px;cursor:pointer}
.pw-set-select:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}
.pw-set-help{margin:0;padding-left:18px;display:flex;flex-direction:column;gap:6px;
  color:var(--dsw-alias-label-secondary);font-size:12px;line-height:17px}
.pw-set-state{color:var(--dsw-alias-label-secondary);font-size:12px;margin:0}
.pw-set-error{color:var(--dsw-alias-state-error-primary)}

/* 说话气泡：位置由 ctl.anchor()（头顶）每帧写入 left/top，所以这里只管外观。
   她走动时气泡跟着走，不需要额外的位移动画。 */
.pw-bubble{position:absolute;left:0;top:0;transform:translate(-50%,-100%);
  margin-top:-6px;padding:5px 10px;border-radius:11px;white-space:pre-wrap;
  max-width:240px;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);
  border:1px solid var(--dsw-alias-border-l1);
  font-size:11px;line-height:16px;font-weight:500;pointer-events:none;
  box-shadow:0 4px 16px rgba(0,0,0,.18);animation:pw-pop .24s ease-out;z-index:3}
.pw-bubble:after{content:'';position:absolute;left:50%;top:100%;margin-left:-4px;
  border:4px solid transparent;border-top-color:var(--dsw-alias-bg-overlay)}

/* 气泡入场：基础 transform 是 translate(-50%,-100%)，关键帧必须带上它 */
@keyframes pw-pop{from{opacity:0;transform:translate(-50%,-100%) translateY(5px) scale(.92)}
  to{opacity:1;transform:translate(-50%,-100%) translateY(0) scale(1)}}
@media (prefers-reduced-motion:reduce){
  .pw-menu,.pw-bubble{animation:none}
}
`;

    // ============================================================================
    //  工具
    // ============================================================================
    function pickOne(list) {
      return list[Math.floor(Math.random() * list.length)];
    }

    /** 取 localStorage；隐私模式 / 沙箱里访问会抛，一律降级为 null。 */
    function safeStorage() {
      try {
        return typeof localStorage !== 'undefined' ? localStorage : null;
      } catch (error) {
        return null;
      }
    }

    /**
     * 鲸鱼娘会说的话（纯函数，便于测试）。
     *
     * ★ 她的性格照着「纸鸢」塑的：甜美、温柔、内敛冷静，说话短、直、具体，
     *   不装乖也不讨好；被夸会嘴上顶回来，被冷落会小声抱怨，能顶嘴也能干活。
     *   所以台词里**不许**出现客服腔、俏皮卖萌腔、"主人～"这类称呼，
     *   也不许长篇大论——她说话跟真人闲聊一样，一句就够。
     *
     * @returns {{ price: string[], idle: string[], greet: string[], care: string[],
     *            sit: string[], rise: string[], sitIdle: string[],
     *            gesture: object, react: object }}
     */
    function roamLines(date) {
      var t = date === undefined ? new Date() : date;
      var price;
      try {
        var s = summary(t);
        if (!s.isPeak) {
          if (s.isHoliday && s.holiday) {
            price = ['今天' + s.holiday.name + '，半价哦', '假期打折，随便用', '这会儿便宜，放心跑'];
          } else if (s.isWeekend) {
            price = ['周末半价，别客气', '周末打折啦', '现在便宜一半，冲'];
          } else {
            price = ['谷时，便宜一半', '这会儿便宜，跑吧', '趁便宜多干点活', '半价时段，够你造的'];
          }
        } else {
          price = ['峰时…省着点', '现在全价，贵一倍', '要不等半价再跑', '哼，峰时也不许浪费'];
        }
      } catch (error) {
        price = ['我在看着你的 token 呢'];
      }
      return {
        price: price,
        // 待机闲话。重复了「摸鱼中…」和「发呆…」是有意的：v0.5.3 把菜单里的
        // 「说句价格」删掉后，闲话的分母变大了，得靠重复把重复感压下去 ——
        // 同一个池子里 7 选 1 和 9 选 1，撞车频率差一大截。
        idle: ['摸鱼中…', '有点困', '好久没理我了', '转个圈～', 'zzz…', '发呆…', '你忙你的，我就待会儿', '摸鱼中…', '发呆…'],
        greet: ['我出来啦～', '巡场中…', '来看看你烧了多少 token', '巡逻！', '在的在的', '嗯，我看着呢'],
        // 「陪你说句话」用的：不谈 token，只关心人。短、具体、不说教。
        care: [
          '你还好吗',
          '别硬撑着，累了就歇会儿',
          '喝口水去，别一直坐着',
          '你今天吃饭了没',
          '我觉得你最近挺累的',
          '有事说一声，我一直在',
          '我不催你，慢慢来',
          '你不用一直很强，真的',
          '别对自己那么狠',
          '我在呢，哪儿也不去',
        ],
        // 「坐好」/「起来」用的：短、认命、带点小脾气。照 Minecraft 里那条
        // /sit 命令的口吻塑的 —— 你下令，她服从，但会顶一句。
        sit: ['坐好了，不动', '嗯，坐着', '坐着呢，跑不了', '好，我不动', '待这儿了', '不乱跑了，放心'],
        rise: ['好嘛，起来就起来', '活动活动筋骨', '那我撒欢儿啦', '自由！', '别后悔把我放出来'],
        sitIdle: ['我就这么坐着', '不急，你忙你的', '嗯…挺好的', '看着你呢', '不吵你', '累了就靠会儿'],
        // 「逗她玩」时她说的。照纸鸢塑：短、具体、可以顶嘴、不卖萌不装乖。
        // 台词必须和动作对得上 —— 说"抖抖毛"的那句不能配一个捂脸的动作。
        gesture: {
          stretch: ['唔——伸个懒腰', '嗯，舒展一下', '骨头都要酥了'],
          peek: ['让我看看…', '那边有啥', '踮个脚'],
          shakeout: ['抖抖毛', '甩干净了', '别靠近，我在抖'],
          beg: ['要抱抱…不给你', '想要点什么', '看我看我'],
          curl: ['不想动', '缩一会儿', '窝着舒服'],
          peekaboo: ['别看', '没看见没看见', '…别笑'],
          swat: ['拍你哦', '尾巴不是给你玩的', '哼'],
          giggle: ['哈哈哈', '笑死我了', '别问，问就是好玩'],
          brace: ['要摔就摔吧', '我准备好了', '别晃我'],
          curtsy: ['行了个礼', '这样行了吧', '讲究吧你'],
          shiver: ['冷…', '抖一下', '别丢下我一个人太久'],
          nudge: ['推推你', '醒醒', '在忙吗'],
          lick: ['有点饿', '馋了', '你手上是啥'],
        },
        // 她自己看场景有反应时说的。
        react: {
          back: ['你回来啦', '诶，你还在', '我以为你不回来了'],
          typing: ['你打了好久', '歇会儿？', '我看着呢'],
          idle: ['好安静', '在吗', '你好久没理我了'],
          done: ['好了！', '搞定', '写好了'],
          wake: ['醒了', '唔…几点了', '你还在啊'],
          // 「坐好」10 分钟没人管就自动解除 —— 这不是你的指令，是她自己待不住了
          rise: ['坐太久了我腿麻', '我自己活动活动', '坐了这么久，腿都不听使唤了'],
        },
      };
    }

    // ============================================================================
    //  打字回避：你在输入框里打字时，她要离开文本框区域
    //
    //  判定全在下面这几个纯函数里（视口坐标，不碰全局），所以能直接单测；
    //  真正的「喊她走」由 WhaleRoamer 每帧调一次 avoidWhileTyping 完成。
    // ============================================================================
    /** 文本框左右各留出的缝隙：她贴着这一侧站，就不压住输入框与旁边的按钮。 */
    var AVOID_MARGIN_X = 40;
    /** 纵向余量：输入框所在的卡片比框本身高（上沿标题、下沿工具行）。 */
    var AVOID_MARGIN_TOP = 24;
    var AVOID_MARGIN_BOTTOM = 72;
    /**
     * 停下时与回避区再留出的间隙。
     *
     * 她的包围盒**随走姿晃动**（跨步/前倾时能宽出十几像素），只按规划那一刻的半宽
     * 算「刚好贴边」，走到位时往往会往回压进区里几个像素——真实浏览器里就是这样翻车的
     * （pet-harness 的行为断言抓到过：x 807 → 473，差 6px 没出去）。
     * 留 24px 余量把这层晃动吃掉，界面上也更像「让开了」而不是「贴着站」。
     */
    var AVOID_CLEARANCE = 24;
    /** 打字停止后，回避状态再保持这么久（写完一句停顿一下，她不会立刻走回来）。 */
    var TYPING_GRACE_MS = 3000;
    /** 她离窗口边缘的最小留白（与 pet-core 的 `104*S + 8` 同一口径）。 */
    var AVOID_EDGE = 8;
    /** 目标位置相差不到这个数就不重新下令 —— 否则每帧 walkTo 会把步态重置成原地踏步。 */
    var AVOID_TARGET_TOLERANCE = 16;
    /** 这个距离以上就跑过去，不然走过去太慢，你一句话都打完了她还没让开。 */
    var AVOID_RUN_DISTANCE = 160;

    /**
     * 「现在算不算正在打字」：最后一次按键的宽限期内，**或者焦点还留在文本框里**。
     *
     * 只看按键会漏掉「打完一句停在那儿」的情况——光标还在框里，
     * 你随时会接着写，所以她得一直在外面等着。
     *
     * @param {object|null} activeElement - `document.activeElement`。
     * @param {number} until - 宽限截止时刻（毫秒）。
     * @param {number} now - 当前时刻（毫秒）。
     * @returns {boolean}
     */
    function typingActive(activeElement, until, now) {
      return now < until || isEditable(activeElement);
    }

    /**
     * 这个元素是不是「能打字的地方」（input / textarea / contenteditable）。
     * 只读属性、不碰全局，所以测试里塞个普通对象就能覆盖。
     *
     * @param {object|null} el - 候选元素。
     * @returns {boolean}
     */
    function isEditable(el) {
      if (!el || typeof el !== 'object') return false;
      const tag = String(el.tagName || '').toUpperCase();
      if (tag === 'TEXTAREA') return el.disabled !== true;
      if (tag === 'INPUT') {
        if (el.disabled === true) return false;
        const type = String(el.type || 'text').toLowerCase();
        return ['hidden', 'checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'image', 'range', 'color']
          .indexOf(type) === -1;
      }
      return el.isContentEditable === true;
    }

    /**
     * 从事件目标往上找一个能打字的元素（焦点有时落在编辑器的子节点上，
     * 比如 contenteditable 里的 `<p>`，那一层自己 `isContentEditable === false`）。
     *
     * @param {object|null} node - 起点（事件目标或 `document.activeElement`）。
     * @returns {object|null} 找到的文本框元素；最多往上走 5 层。
     */
    function editableAncestor(node) {
      var el = node;
      for (var i = 0; el && i < 5; i += 1) {
        if (isEditable(el)) return el;
        el = el.parentElement || el.parentNode || null;
      }
      return null;
    }

    /**
     * 文本框（连同它所在卡片的余量）在视口里的矩形。
     *
     * 横向放 `AVOID_MARGIN_X`，纵向上浅下深——下面那截是工具行，
     * 而她贴地走，判定要贴近「真实会被她挡住的可点区域」。
     *
     * @param {object} el - 文本框元素。
     * @returns {{left:number, right:number, top:number, bottom:number}|null}
     */
    function editableZone(el) {
      if (!isEditable(el) || typeof el.getBoundingClientRect !== 'function') return null;
      let rect;
      try {
        rect = el.getBoundingClientRect();
      } catch (error) {
        return null;
      }
      if (!rect || (rect.right - rect.left) <= 0) return null;
      return {
        left: rect.left - AVOID_MARGIN_X,
        right: rect.right + AVOID_MARGIN_X,
        top: rect.top - AVOID_MARGIN_TOP,
        bottom: rect.bottom + AVOID_MARGIN_BOTTOM,
      };
    }

    /** 两个矩形有没有重叠（`pad` 是四边各放宽多少）。 */
    function rectsOverlap(a, b, pad) {
      const p = typeof pad === 'number' ? pad : 0;
      return a.left < b.right + p
        && a.right > b.left - p
        && a.top < b.bottom + p
        && a.bottom > b.top - p;
    }

    /**
     * 两个矩形之间的最近距离（相交时为 0）。
     * 拖拽反馈用它算「她离输入框还有多远」——只看 x 会漏掉上下方向，
     * 而用户拖动时最常发生的就是「在框的正上方/正下方」。
     */
    function rectDistance(a, b) {
      if (!a || !b) return Infinity;
      const dx = Math.max(0, Math.max(a.left - b.right, b.left - a.right));
      const dy = Math.max(0, Math.max(a.top - b.bottom, b.top - a.bottom));
      return Math.sqrt(dx * dx + dy * dy);
    }

    /**
     * 挡路时该走到哪个 x：文本框**外侧最近**的一边，并保证真的落在框外。
     *
     * 两侧都塞不下（窗口太窄 / 她太宽）时返回 null —— 与其在框里来回蹭，
     * 不如下次再试。
     *
     * @param {{left:number,right:number}} petRect - 她的身体矩形（视口坐标）。
     * @param {{left:number,right:number}} zone - `editableZone` 给的回避区。
     * @param {number} width - 舞台宽度（= 视口宽度）。
     * @returns {number|null} 目标 x；不挡路或无处可去时为 null。
     */
    function escapeTargetX(petRect, zone, width, petX) {
      const half = Math.max(1, (petRect.right - petRect.left) / 2);
      // 精灵随 pet.x 刚性平移，但它的中心不一定落在 pet.x 上（VIEW 不对称时
      // 会偏）。DOM 包围盒只给出当前跨度，不告诉你偏了多少 —— 不修正这个
      // 偏移，右侧目标会算近：她走到位身体仍压着框，下一帧又算出同一个
      // 目标，她就被钉在框边"走不动"。petX 是当前 pet.x，用来算偏移。
      const offset = typeof petX === 'number' && Number.isFinite(petX)
        ? (petRect.left + petRect.right) / 2 - petX
        : 0;
      const center = (petRect.left + petRect.right) / 2;
      const lo = half + AVOID_EDGE;
      const hi = width - half - AVOID_EDGE;
      if (!(hi > lo)) return null;
      const clampX = (x) => (x < lo ? lo : x > hi ? hi : x);
      // 必须留出 AVOID_CLEARANCE：走姿会让包围盒晃动，「刚好贴边」= 到位时又压回去
      // 精灵在 pet.x = x 时的实际跨度 = [x + offset - half, x + offset + half]
      const clear = (x) => x + offset + half + AVOID_CLEARANCE <= zone.left
        || x + offset - half - AVOID_CLEARANCE >= zone.right;
      const options = [zone.left - half - AVOID_CLEARANCE - offset, zone.right + half + AVOID_CLEARANCE - offset]
        .map(clampX)
        .filter(clear)
        .sort((a, b) => Math.abs(a - center) - Math.abs(b - center));
      return options.length > 0 ? options[0] : null;
    }

    /**
     * 每帧的走位决策：**不挡路就什么都不做**（返回 null）。
     *
     * @param {{left:number,right:number,top:number,bottom:number}|null} petRect - 她的矩形。
     * @param {object|null} zone - 当前回避区。
     * @param {number} width - 舞台宽度。
     * @returns {number|null} 需要前往的 x。
     */
    function escapePlan(petRect, zone, width, petX) {
      if (!petRect || !zone) return null;
      if (!rectsOverlap(petRect, zone, 0)) return null;
      return escapeTargetX(petRect, zone, width, petX);
    }

    // ============================================================================
    //  提示词优化：把她拖到文本框上 → 一次回三版，挑一版替换进框里（也可只复制）
    // ============================================================================
    /** Host 侧的优化路由（POST `{text}`）。key 只待在 Host，永远不进这个 bundle。 */
    var OPTIMIZE_ROUTE = '/dsh-deepseek-peak-whale/api/optimize';
    /** 三版优化路由：一次回三版（更详细/更专业/AI 自主+建议），界面一版一行。 */
    var OPTIMIZE3_ROUTE = '/dsh-deepseek-peak-whale/api/optimize3';
    /** 「拖到文本框上」的判定余量 —— 比回避区（40px）小，投递要更笃定一点。 */
    var DROP_PAD = 16;
    /**
     * 纵向的"差不多就在框那儿"容差：松手点离框最近那条边这么近以内、且 x 落在框的
     * 横向范围内，就算投递。理由见 `isDropInside`。
     */
    var DROP_SLACK_Y = 90;
    /** 写回后的归一化宽限：编辑器可能自己 trim/规范化，这 800ms 内不算「用户改过」。 */
    var UNDO_GRACE_MS = 800;

    /** 读文本框正文：textarea/input 读 value，contenteditable 读 innerText。 */
    function readComposer(el) {
      if (!el || typeof el !== 'object') return '';
      try {
        const tag = String(el.tagName || '').toUpperCase();
        if (tag === 'TEXTAREA' || tag === 'INPUT') {
          return typeof el.value === 'string' ? el.value : '';
        }
        if (typeof el.innerText === 'string') return el.innerText;
        return typeof el.textContent === 'string' ? el.textContent : '';
      } catch (error) {
        return '';
      }
    }

    /**
     * 写回文本框正文并派发 `input`。
     *
     * 三个坑都在这里，每一个都对应一次真实的事故：
     *
     * ① **React 的受控输入**要走**原型上的原生 setter**（`el.value = x` 会被它下一次
     *    渲染盖回去）。
     *
     * ② **contenteditable 不能用 `innerText = value`**（DSH 的输入框就是这种，diag 里
     *    `tag=DIV` 记的就是它）。富文本编辑器（Lexical / ProseMirror / Slate /
     *    Quill）都把自己的状态存在内存里，`innerText` 是一次「绕过编辑器直接改 DOM」的
     *    外部写入 —— 编辑器下一帧 reconciliation 时会认为这段文字是外来的脏数据，
     *    **当帧或下一帧就回滚成原文**。界面上看起来正好是：气泡说「已换成『更详细』那版」，
     *    而框里纹丝不动。这不是"写入失败"，是"写成功了又被撤销"。
     *
     *    所以对 contenteditable 必须走**编辑器自己的输入管线**：`selectAll` +
     *    `execCommand('insertText')`（它会触发 `beforeinput:inputType=insertText`，
     *    所有主流编辑器都监听这个当作用户输入），删不掉的段落再拆成多个节点打进去。
     *
     * ③ 必须派发事件 —— 不派发的话框里看着改了、应用以为你没动，一回车就丢。
     *
     * @returns {boolean} 有没有写成功。
     */
    function writeComposer(el, text) {
      if (!el || typeof el !== 'object') return false;
      const tag = String(el.tagName || '').toUpperCase();
      const value = String(text === null || text === undefined ? '' : text);
      if (tag === 'TEXTAREA' || tag === 'INPUT') {
        let proto = null;
        try {
          if (typeof window !== 'undefined') {
            if (tag === 'TEXTAREA' && window.HTMLTextAreaElement) proto = window.HTMLTextAreaElement.prototype;
            if (tag === 'INPUT' && window.HTMLInputElement) proto = window.HTMLInputElement.prototype;
          }
        } catch (error) {
          proto = null;
        }
        const descriptor = proto ? Object.getOwnPropertyDescriptor(proto, 'value') : null;
        if (descriptor && typeof descriptor.set === 'function') descriptor.set.call(el, value);
        else el.value = value;
        dispatchInput(el);
        return true;
      }
      // contenteditable（含 DSH 那个 DIV 编辑器）：走编辑器的输入管线
      return writeEditable(el, value);
    }

    /** 派发 `input`（有 `InputEvent` 就用带 data 的，它才带 isComposing 这类属性）。 */
    function dispatchInput(el) {
      try {
        if (typeof el.dispatchEvent !== 'function') return;
        if (typeof InputEvent === 'function') {
          el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: null }));
          return;
        }
        if (typeof Event === 'function') el.dispatchEvent(new Event('input', { bubbles: true }));
      } catch (error) { /* 派发不了就当纯 DOM 写入 */ }
    }

    /**
     * 往 contenteditable 里写一段多行文本。
     *
     * 按段落（空行）拆开，逐段 `execCommand('insertText')`：编辑器收到的是一串
     * 「用户输入」，而不是一次性塞进去的整块 DOM，所以它会老老实实建自己的节点、
     * 同步自己的历史栈，撤销键也还在。
     *
     * 全选 + insertText 的组合还有个副作用要注意：部分编辑器在 `selectAll` 之后
     * 不删旧内容、直接把新文本插到选区开头。所以先显式 `delete` 一次。
     */
    function writeEditable(el, value) {
      let doc = null;
      try {
        doc = el.ownerDocument || (typeof document !== 'undefined' ? document : null);
      } catch (error) {
        doc = null;
      }
      if (!doc || typeof doc.execCommand !== 'function') {
        // 没有 execCommand（jsdom / 老浏览器）：退回 DOM 写入 + 事件，至少别静默失败
        try {
          el.textContent = value;
          dispatchInput(el);
          return true;
        } catch (error) {
          return false;
        }
      }
      try {
        el.focus();
      } catch (error) { /* 聚焦失败不致命，execCommand 仍可能work */ }
      const run = (cmd, ui) => {
        try { return doc.execCommand(cmd, false, ui); } catch (error) { return false; }
      };
      run('selectAll');
      run('delete');
      const paragraphs = String(value).split('\n');
      let inserted = false;
      for (let i = 0; i < paragraphs.length; i += 1) {
        if (i > 0) run('insertParagraph');
        const part = paragraphs[i];
        if (part === '') continue;
        // 逐行 insertText；execCommand 对长文本可能被截断，截断就补写 remainder
        inserted = run('insertText', part) || inserted;
      }
      // 编辑器把内容弹回去（它不认这次外部输入）时，兜底写 DOM —— 至少看得见。
      // 顺序刻意反过来：先让编辑器自己处理，只在它没反应时兜底。
      if (readComposer(el).trim() === '' && value.trim() !== '') {
        try {
          el.textContent = value;
          dispatchInput(el);
          return true;
        } catch (error) {
          /* 落到下面的返回 */
        }
      }
      dispatchInput(el);
      return inserted || readComposer(el).trim() !== '';
    }

    /** 投递区：文本框本体 ±`DROP_PAD`（视口坐标）。取不到就 null。 */
    function dropZone(el) {
      if (!isEditable(el) || typeof el.getBoundingClientRect !== 'function') return null;
      let rect;
      try {
        rect = el.getBoundingClientRect();
      } catch (error) {
        return null;
      }
      if (!rect || (rect.right - rect.left) <= 0) return null;
      return {
        left: rect.left - DROP_PAD,
        right: rect.right + DROP_PAD,
        top: rect.top - DROP_PAD,
        bottom: rect.bottom + DROP_PAD,
      };
    }

    /** 点是否落在矩形里（视口坐标）。 */
    function pointInRect(point, rect) {
      return !!(point && rect
        && point.x >= rect.left && point.x <= rect.right
        && point.y >= rect.top && point.y <= rect.bottom);
    }

    /**
     * 松手点算不算"投递到文本框上"——比 `pointInRect` 宽容一档。
     *
     * 为什么不能只看矩形：DSH 的输入框是 contenteditable，**拿到的
     * `getBoundingClientRect()` 是整块编辑器面板**（顶到输入区上沿、底部含工具行），
     * 往往比眼睛看到的"输入框"大一圈；可反过来，编辑器内部的滚动/折叠也会让它
     * 比看起来**高**。于是"明明松在输入框里"被判成 outside，而且**静默失败** ——
     * diag 里只有一行 `drop-miss`，界面上一个字的提示都没有（2026-10-12 连撞 5 次）。
     *
     * 判据（任一成立即算命中）：
     *   ① 点落在矩形内 —— 老规矩；
     *   ② 点的 x 在框的横向范围内，且 y 离框**最近那条边**不超过 `DROP_SLACK_Y`
     *      —— 覆盖"看着在框里、实际差一点"的绝大多数情况。取最近边而不是中心，
     *      因为人拖过去的直觉就是"往框那儿放"，不是"往框正中心放"。
     *
     * @param {{x:number, y:number}} point - 松手点（视口坐标）。
     * @param {{left:number, right:number, top:number, bottom:number}|null} zone - `dropZone` 的结果。
     * @returns {boolean}
     */
    function isDropInside(point, zone) {
      if (!point || !zone) return false;
      if (pointInRect(point, zone)) return true;
      if (point.x < zone.left || point.x > zone.right) return false;
      const dyTop = point.y - zone.top;
      const dyBottom = point.y - zone.bottom;
      const nearest = dyTop < 0 ? -dyTop : dyBottom > 0 ? dyBottom : 0;
      return nearest <= DROP_SLACK_Y;
    }

    /**
     * 撤销胶囊什么时候该自己收起：写回已过归一化宽限，而框里的内容**不再是
     * 当初优化出来的那版**（你自己改过、或应用换过）——绝不能拿旧稿盖掉你的新输入。
     */
    function shouldDismissUndo(undo, currentText, nowMs) {
      if (!undo) return false;
      if (!(nowMs - undo.since >= UNDO_GRACE_MS)) return false;
      return currentText !== undo.optimized;
    }

    /**
     * 当前上下文（apply 时记下）：sessionRoute 要读会话服务，而 optimizePrompt
     * 这些发送器是模块级函数，拿不到闭包里的 ctx。
     */
    var clientCtx = null;

    /**
     * 读「当前对话框」的模型选择（provider/model/effort），拖鲸鱼时随请求带给 Host，
     * Host 就用**和这个对话框完全相同的路由**去优化——不同对话框用不同模型，
     * 各自的优化也各走各的模型，互不干扰。
     *
     * 判定「当前会话」用官方 ui-session 同一条口径：retainInfo(id) 的
     * retainedBy.mainView > 0（主视图正在展示的会话）。模型选择读
     * binding.session.projections 的 modelSelection face（next ?? lastUsed），
     * 与会话提交消息时的数据源完全一致（conversation 的 submissionState 同款读法）。
     *
     * 任何一步读不到都返回 null：Host 侧会依次回落 webToken / 全局默认模型 /
     * 网关配置——这条路是增强，任何失败都不该让拖鲸鱼变砖。
     */
    function sessionRoute() {
      try {
        var ctx = clientCtx;
        if (!ctx) return null;
        var sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : ctx.sessions;
        if (!sessions || typeof sessions.binding !== 'function') return null;
        var activeId = null;
        try {
          var snap = sessions.list && typeof sessions.list.getSnapshot === 'function'
            ? sessions.list.getSnapshot() : null;
          var byId = snap && snap.byId ? snap.byId : null;
          if (byId) {
            var ids = Object.keys(byId);
            for (var i = 0; i < ids.length; i++) {
              var info = null;
              try {
                info = typeof sessions.retainInfo === 'function' ? sessions.retainInfo(ids[i]) : null;
              } catch (e2) { info = null; }
              var shot = info && typeof info.getSnapshot === 'function' ? info.getSnapshot() : null;
              if (shot && shot.retainedBy && (shot.retainedBy.mainView || 0) > 0) {
                activeId = ids[i];
                break;
              }
            }
            // 一个 mainView 都没有（快照时序的空窗）：只有唯一个会话就大胆用它，
            // 多个分不清就返回 null 交给 Host 回落——猜错对话框比回落更糟。
            if (activeId === null && ids.length === 1) activeId = ids[0];
          }
        } catch (e3) { activeId = null; }
        if (activeId === null) return null;
        var binding = sessions.binding(activeId);
        if (!binding || !binding.session || !binding.session.projections
          || typeof binding.session.projections.faceOf !== 'function') return null;
        var face = binding.session.projections.faceOf('modelSelection');
        var model = face && typeof face.getSnapshot === 'function' ? face.getSnapshot() : null;
        if (!model) return null;
        var sel = model.next || model.lastUsed;
        if (!sel || typeof sel.provider !== 'string' || typeof sel.model !== 'string') return null;
        var route = { provider: sel.provider, model: sel.model, sessionId: activeId };
        if (typeof sel.reasoningEffort === 'string' && sel.reasoningEffort !== '') {
          route.reasoningEffort = sel.reasoningEffort;
        }
        return route;
      } catch (error) {
        return null;
      }
    }

    /**
     * 打一次 Host 的优化路由。**永不 reject**：失败一律变成 `{ok:false, message}`，
     * 由界面显示给人看（拖一次不该在控制台留一个未处理的 rejection）。
     *
     * @param {string} text - 文本框里的原文。
     * @returns {Promise<{ok: boolean, optimized?: string, message?: string, cached?: boolean,
     *          unchanged?: boolean, usage?: {prompt: number, completion: number, total: number}|null}>}
     */
    function optimizePrompt(text) {
      try {
        if (typeof fetch !== 'function') {
          return Promise.resolve({ ok: false, message: '这个环境没有 fetch，接不到 Host' });
        }
        if (typeof window === 'undefined' || !window.location || !window.location.origin) {
          return Promise.resolve({ ok: false, message: '非浏览器环境，接不到 Host' });
        }
        return fetch(window.location.origin + OPTIMIZE_ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          // route = 当前对话框的模型选择（读不到为 null，Host 自行回落）。
          body: JSON.stringify({ text: text, route: sessionRoute() }),
        }).then(
          function (response) {
            if (!response) throw new Error('没有响应');
            return response.json().then(
              function (payload) {
                if (!payload || payload.ok !== true) {
                  return { ok: false, message: (payload && payload.message) || `HTTP ${response.status}` };
                }
                return {
                  ok: true,
                  optimized: payload.optimized,
                  cached: payload.cached === true,
                  unchanged: payload.unchanged === true,
                  rounds: typeof payload.rounds === 'number' ? payload.rounds : 1,
                  usage: payload.usage && typeof payload.usage === 'object' ? payload.usage : null,
                  model: payload.model,
                };
              },
              function () {
                return { ok: false, message: `Host 返回的不是 JSON（HTTP ${response.status}）` };
              },
            );
          },
          function (error) {
            return { ok: false, message: `连不上 Host：${error && error.message ? error.message : String(error)}` };
          },
        );
      } catch (error) {
        return Promise.resolve({ ok: false, message: String(error && error.message ? error.message : error) });
      }
    }

    /**
     * 打一次 Host 的**三版优化**路由。同样永不 reject。
     *
     * @returns {Promise<{ok: boolean, variants?: Array<{key:string,label:string,
     *           optimized:string,unchanged:boolean,usage:object|null,cached:boolean,
     *           ms:number|null}>, message?: string}>} ms = 这一版想了多久（缓存命中为 null）。
     */
    function optimizePrompt3(text) {
      try {
        if (typeof fetch !== 'function') {
          return Promise.resolve({ ok: false, message: '这个环境没有 fetch，接不到 Host' });
        }
        if (typeof window === 'undefined' || !window.location || !window.location.origin) {
          return Promise.resolve({ ok: false, message: '非浏览器环境，接不到 Host' });
        }
        return fetch(window.location.origin + OPTIMIZE3_ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          // route = 当前对话框的模型选择（读不到为 null，Host 自行回落）。
          body: JSON.stringify({ text: text, route: sessionRoute() }),
        }).then(
          function (response) {
            if (!response) throw new Error('没有响应');
            return response.json().then(
              function (payload) {
                if (!payload || payload.ok !== true) {
                  return { ok: false, message: (payload && payload.message) || `HTTP ${response.status}` };
                }
                return { ok: true, variants: Array.isArray(payload.variants) ? payload.variants : [] };
              },
              function () {
                return { ok: false, message: `Host 返回的不是 JSON（HTTP ${response.status}）` };
              },
            );
          },
          function (error) {
            return { ok: false, message: `连不上 Host：${error && error.message ? error.message : String(error)}` };
          },
        );
      } catch (error) {
        return Promise.resolve({ ok: false, message: String(error && error.message ? error.message : error) });
      }
    }

    /**
     * 完成气泡里的 token 注脚：`· 约 2.1k tokens`。
     *
     * 只在 Host 真的报了 usage 时显示——缓存命中没花钱，报一个「上次的」数字
     * 反而是误导；上游没给 usage（老端点/被网关剥过）就安静省略。
     */
    function usageNote(usage) {
      if (!usage || typeof usage !== 'object') return '';
      const total = Number(usage.total);
      if (!Number.isFinite(total) || total <= 0) return '';
      return ' · 约 ' + formatTokens(total) + ' tokens';
    }

    /**
     * 耗时写法：`12.3s` / `840ms`。不是正数就返回空串。
     *
     * 缓存命中的那一版**根本没跑上游**（Host 不给 ms），显示「0.0s」等于在说
     * "它想过，只是没花时间" —— 没数据就安静省略，绝不编一个 0 出来。
     */
    function formatThinking(ms) {
      const n = Number(ms);
      if (!Number.isFinite(n) || n <= 0) return '';
      if (n < 1000) return Math.round(n) + 'ms';
      const s = n / 1000;
      return (s < 10 ? s.toFixed(1) : String(Math.round(s))) + 's';
    }

    /** 完成气泡里的耗时注脚：`· 思考 12.3s`。没数据就空串。 */
    function thinkingNote(ms) {
      const text = formatThinking(ms);
      return text ? ' · 思考 ' + text : '';
    }

    // ============================================================================
    //  账户钱包：余额 + 当日费用（数据由 Host 半身的 HTTP 路由提供）
    // ============================================================================
    /**
     * Host 半身用 `webServer` 注册的路由。**相对路径 = 同源请求**，
     * Host 侧刻意不发 CORS 头：余额是账户数据，不能让任意网页读到。
     *
     * 为什么不走 `host.call`：那是**动态插件**（cordis_define）才有的内建，
     * 安装型包没有它；官方插件同样以 webServer 路由对外提供 Host 数据。
     */
    var WALLET_ROUTE = '/dsh-deepseek-peak-whale/api/wallet';
    /** Host 对余额有 45 秒缓存；客户端 60 秒拉一次既够跟手也不打扰。 */
    var WALLET_POLL_MS = 60000;
    /** UI 设置（详情页模式 / 优化开关）：GET 读取、POST 写入；key 永远不经过这里。 */
    var SETTINGS_ROUTE = '/dsh-deepseek-peak-whale/api/settings';
    /** 设置页与详情浮层共享一份 UI 设置（wallet 载荷没带时回落默认值：默认简洁版）。 */
    // `promptStyle` / `promptStyles` 是提示词风格那项：清单由 Host 随设置一起回传，
    // 客户端**不硬编码任何风格名**（用户明确要求风格清单未指定时不自行编造）。
    var uiSettingsState = {
      uiMode: 'concise',
      optimizeEnabled: true,
      petVisible: true,
      apiKeyConfigured: false,
      promptStyle: 'default',
      promptStyles: null,
      /** 鲸鱼娘配色（第二档 #6）：'mint' | 'mono' | 'navigator' | ... 见 WHALE_PALETTES。 */
      palette: 'mint',
    };
    var uiSettingsListeners = [];
    /**
     * `layout` 客户端服务：**按需解析，绝不在 apply 时抓一次缓存**。
     *
     * 老代码在 apply 里 `ctx.get('layout')` 拿不到就退到 `ctx.layout` 属性访问，
     * 并在那时缓存结果。开机瞬间 layout 可能还没注册，而服务缺失时的属性访问
     * **会抛异常**——异常顺着 apply 冒到外层 catch，把整个挂载一起带走（真机表现：
     * 重启后小鲸鱼完全不出现，去插件页关掉再打开才出来，因为那时 layout 已就绪）。
     * 现在两条取值路径各自 try 住、点击时才解析、空结果不缓存。
     */
    var layoutOverride = null; // 测试 / 二次开发注入（见 exports.setLayoutService）
    var pluginCtx = null; // apply 时记下，供按需解析 layout

    function resolveLayout() {
      if (layoutOverride) return layoutOverride;
      var ctx = pluginCtx;
      if (!ctx) return null;
      var layout;
      try {
        layout = typeof ctx.get === 'function' ? ctx.get('layout') : undefined;
      } catch (error) {
        pwBeacon('layout-get-threw', errText(error));
        layout = undefined;
      }
      if (!layout) {
        try {
          layout = ctx.layout;
        } catch (error) {
          pwBeacon('layout-prop-threw', errText(error));
          layout = undefined;
        }
      }
      return layout && typeof layout.selectPanel === 'function' ? layout : null;
    }

    /**
     * 打开内置「插件」设置面板 —— 我们的「小鲸鱼」tab 就挂在那一页
     * （`settings.plugins.tab` 槽位）。面板键 `plugins` 取自内置侧栏的同名入口。
     * 拿不到 layout 服务或面板没注册就安静地什么都不做，绝不抛错。
     */
    function openPluginsSettings() {
      try {
        var layout = resolveLayout();
        if (layout) {
          layout.selectPanel('plugins');
          return true;
        }
      } catch (error) {
        if (typeof console !== 'undefined') {
          console.warn('[peak-whale] 打开设置面板失败:', error);
        }
      }
      return false;
    }

    /** 更新 UI 设置并通知订阅者；永不 reject（失败静默，下一轮 wallet 轮询会纠正）。 */
    // ⚠️ 这里是**合并**而不是整份替换：乐观更新只带被改的那一个字段
    // （比如 `{promptStyle: 'x'}`）。整份替换会把 uiMode / promptStyles 一起抹掉，
    // 于是「刚点一下风格，下面整行连同选项就消失了」—— 下一次 wallet 轮询才回来，
    // 表现为控件闪一下又出现。这是个只在一闪而过时才看得见的 bug。
    function publishUiSettings(next) {
      if (next && typeof next === 'object') {
        uiSettingsState = { ...uiSettingsState, ...next };
      }
      for (var i = 0; i < uiSettingsListeners.length; i += 1) {
        try {
          uiSettingsListeners[i](uiSettingsState);
        } catch (error) { /* 忽略 */ }
      }
    }

    /** 从 wallet 载荷里同步 UI 设置（Host 每轮轮询都带）。 */
    function syncUiSettingsFromWallet(wallet) {
      if (wallet && wallet.settings && typeof wallet.settings === 'object') {
        publishUiSettings(wallet.settings);
      }
    }

    /**
     * POST 写一项 UI 设置（白名单字段）。**永不 reject**：成功就发布新值，
     * 失败只打一行 warn——界面乐观更新，Host 是最终裁决。
     */
    function saveUiSettings(patch) {
      if (typeof fetch !== 'function') return Promise.resolve(false);
      if (typeof window === 'undefined' || !window.location || !window.location.origin) return Promise.resolve(false);
      return fetch(window.location.origin + SETTINGS_ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(patch),
      })
        .then(function (response) {
          if (!response || !response.ok) throw new Error('HTTP ' + (response ? response.status : 0));
          return response.json();
        })
        .then(
          function (payload) {
            if (payload && payload.ok === true && payload.settings) {
              publishUiSettings(payload.settings);
              return true;
            }
            return false;
          },
          function () {
            return false;
          },
        );
    }

    /** 最近一次载荷（null = 还没拉过）。模块级共享，状态条与浮层读同一份。 */
    var walletState = null;
    var walletListeners = [];
    var walletTimer = null;
    var walletInFlight = false;

    /**
     * 拉取地址。非浏览器环境（测试里的 window 桩没有 location）
     * 返回 null —— 这也是「不给测试进程排定时任务」的闸门。
     */
    function walletUrl() {
      try {
        if (typeof fetch !== 'function') return null;
        if (typeof window === 'undefined' || !window.location || !window.location.origin) return null;
        var locale = 'zh-CN';
        try {
          if (typeof navigator !== 'undefined' && navigator && navigator.language) locale = navigator.language;
        } catch (error) { /* 取不到就用默认值 */ }
        return window.location.origin + WALLET_ROUTE + '?locale=' + encodeURIComponent(locale);
      } catch (error) {
        return null;
      }
    }

    /** 换数据并通知所有订阅者（单个订阅者抛错不影响别人）。 */
    function publishWallet(next) {
      walletState = next;
      for (var i = 0; i < walletListeners.length; i += 1) {
        try {
          walletListeners[i](next);
        } catch (error) { /* 忽略 */ }
      }
    }

    /**
     * 拉一次。失败时**保留上一份数据**——余额没刷新不等于余额没了；
     * 一份都还没有时才记下失败原因，让浮层给一句**可操作**的提示
     * （尤其 404：说明 Host 半身还是旧代码，重启一次就好）。
     */
    function refreshWallet() {
      if (walletInFlight) return;
      var url = walletUrl();
      if (url === null) return;
      walletInFlight = true;
      fetch(url, { headers: { accept: 'application/json' } })
        .then(function (response) {
          if (!response) throw new Error('no response');
          if (!response.ok) {
            var failure = new Error('HTTP ' + response.status);
            failure.status = response.status;
            throw failure;
          }
          return response.json();
        })
        .then(
          function (payload) {
            walletInFlight = false;
            if (payload && payload.ok === true) {
              publishWallet(payload);
              syncUiSettingsFromWallet(payload);
            }
          },
          function (error) {
            walletInFlight = false;
            if (walletState === null) {
              publishWallet({
                ok: false,
                unavailable: true,
                status: typeof error === 'object' && error !== null && typeof error.status === 'number'
                  ? error.status
                  : 0,
              });
            }
            // 有旧数据就静默：下一轮轮询会重试。
          },
        );
    }

    /** 订阅：第一个订阅者开轮询，最后一个退订时关掉。返回退订函数。 */
    function subscribeWallet(listener) {
      walletListeners.push(listener);
      // 拉不到地址（非浏览器 / 测试桩）就压根不开定时器：没有可轮询的目标。
      if (walletTimer === null && walletUrl() !== null) {
        refreshWallet();
        walletTimer = setInterval(refreshWallet, WALLET_POLL_MS);
      }
      return function () {
        var index = walletListeners.indexOf(listener);
        if (index >= 0) walletListeners.splice(index, 1);
        if (walletListeners.length === 0 && walletTimer !== null) {
          clearInterval(walletTimer);
          walletTimer = null;
        }
      };
    }

    /** 订阅钱包数据的 hook（配合上面的订阅表，组件一挂载就能拿到最新值）。 */
    function useWallet() {
      var pair = react.useState(walletState);
      var setValue = pair[1];
      react.useEffect(function () {
        return subscribeWallet(setValue);
      }, []);
      return pair[0];
    }

    /** 订阅 UI 设置的 hook（详情页模式 / 优化开关；wallet 轮询与设置页写回都会推新值）。 */
    function useUiSettings() {
      var pair = react.useState(uiSettingsState);
      var setValue = pair[1];
      react.useEffect(function () {
        uiSettingsListeners.push(setValue);
        return function () {
          var index = uiSettingsListeners.indexOf(setValue);
          if (index >= 0) uiSettingsListeners.splice(index, 1);
        };
      }, []);
      return pair[0];
    }

    /**
     * 状态条第二行的分段数据（纯函数，便于测试）。
     *
     * 关键取舍：**拿不到数据就返回空数组**，于是这一行整行不渲染——
     * 宁可侧栏底部暂时保持原样，也不要挂一句「账户数据不可用」把界面搞成半成品。
     * 说明与重试提示交给详情浮层去说（那里有地方写清楚为什么、怎么办）。
     *
     * @param {object|null} wallet - 最近一次载荷。
     * @returns {Array<{label: string, value: string}>}
     */
    function walletItems(wallet) {
      if (!wallet || wallet.unavailable === true || wallet.ok === false) return [];
      var acc = wallet.account || {};
      var bal = wallet.balance || {};
      var items = [];

      if (acc.status === 'signed-out') {
        items.push({ label: '账户', value: '未登录' });
      } else if (bal.status === 'ready') {
        var wallets = Array.isArray(bal.wallets) ? bal.wallets : [];
        if (wallets.length > 0) {
          items.push({ label: '余额', value: formatMoney(wallets[0].balance, wallets[0].currency) });
        }
      } else if (bal.status === 'failed') {
        items.push({ label: '余额', value: '查询失败' });
      }
      // 账户服务缺席 / 还没查到：不摆一个「—」占位，直接不显示这一段。

      if (wallet.today) items.push({ label: '今日', value: formatCnyAmount(wallet.today.cny) });
      return items;
    }

    /**
     * 第二行的一行文本（悬停提示用）。
     * @returns {string|null} null = 这一行不显示。
     */
    function walletSummary(wallet) {
      var items = walletItems(wallet);
      if (items.length === 0) return null;
      var parts = [];
      for (var i = 0; i < items.length; i += 1) parts.push(items[i].label + ' ' + items[i].value);
      return parts.join(' · ');
    }

    /**
     * 详情浮层里的账户卡片（返回元素数组，键由调用方拼接）。
     * @param {object|null} wallet - 最近一次载荷。
     * @returns {Array<object>} 元素列表。
     */
    function walletDetails(wallet) {
      if (!wallet) {
        return [h('div', { key: 'w-load', className: 'pw-foot' }, '账户余额与今日费用读取中…')];
      }
      if (wallet.unavailable === true || wallet.ok === false) {
        // 404 = 路由压根不在，几乎一定是 Host 半身还没换成新代码（要重启）；
        // 其余（断网、服务缺席、500）都是「等一下会自己好」。
        var statusCode = typeof wallet.status === 'number' ? wallet.status : 0;
        var message = statusCode === 404
          ? '账户余额与今日费用要重启一次 DSH 才会出现——Host 侧的新半身还没加载；之后每分钟自动刷新。'
          : '账户余额与今日费用暂时取不到，每分钟会自动重试。';
        return [h('div', { key: 'w-na', className: 'pw-foot' }, message)];
      }

      var acc = wallet.account || {};
      var bal = wallet.balance || {};
      var today = wallet.today || null;
      var rows = [];

      var balanceText;
      if (acc.status === 'signed-out') balanceText = '未登录';
      else if (bal.status === 'ready') balanceText = '已登录';
      else if (bal.status === 'failed') balanceText = '查询失败';
      // 账户服务还没到（开机竞态）与「真的未知」要分开说：前者会自己好，
      // 后者才是异常。摆一个「—」等于什么都不告诉用户（实测反馈）。
      else if (acc.status === 'unavailable') balanceText = '服务未就绪';
      else balanceText = '—';
      rows.push(
        h(
          'div',
          { key: 'b', className: 'pw-wallet-row' },
          h('span', { className: 'pw-label' }, '账户'),
          h('span', { className: 'pw-value' }, balanceText),
        ),
      );

      if (bal.status === 'ready') {
        var wallets = Array.isArray(bal.wallets) ? bal.wallets : [];
        for (var i = 0; i < wallets.length; i += 1) {
          // 币种取接口给的；缺字段时回落 CNY —— 本插件已全面按人民币计价，
          // 标签与符号必须用同一个值，否则会出现「余额（CNY）$240.98」这种自相矛盾的行。
          var wCur = wallets[i].currency || 'CNY';
          rows.push(
            h(
              'div',
              { key: 'w' + i, className: 'pw-wallet-row' },
              h('span', { className: 'pw-label' }, '余额（' + wCur + '）'),
              h('span', { className: 'pw-value' }, formatMoney(wallets[i].balance, wCur)),
            ),
          );
        }
        var bonus = Array.isArray(bal.bonus) ? bal.bonus : [];
        for (var j = 0; j < bonus.length; j += 1) {
          var bCur = bonus[j].currency || 'CNY';
          rows.push(
            h(
              'div',
              { key: 'g' + j, className: 'pw-wallet-row' },
              h('span', { className: 'pw-label' }, '赠送（' + bCur + '）'),
              h('span', { className: 'pw-value' }, formatMoney(bonus[j].balance, bCur)),
            ),
          );
        }
      }

      if (today) {
        var tokens = today.tokens || {};
        rows.push(
          h(
            'div',
            { key: 't', className: 'pw-wallet-row pw-wallet-row--today' },
            h('span', { className: 'pw-label' }, '今日费用 · ' + today.date),
            h('span', { className: 'pw-value' }, formatCnyAmount(today.cny)),
          ),
        );
        rows.push(
          h(
            'div',
            { key: 'tm', className: 'pw-wallet-sub' },
            (today.isPeak ? '按峰时全价档' : '按谷时半价档')
              + ' · ' + today.requests + ' 次请求'
              + ' · 输入 ' + formatTokens(tokens.uncachedInputTokens)
              + ' · 缓存命中 ' + formatTokens(tokens.cacheReadTokens)
              + ' · 输出 ' + formatTokens(tokens.outputTokens),
          ),
        );
      }

      if (acc.status === 'unavailable') {
        rows.push(
          h('div', { key: 'na', className: 'pw-wallet-sub' }, '账户服务还没就绪，每分钟自动重试。'),
        );
      }

      var links = [];
      if (acc.topUpUrl) {
        links.push(
          h('a', { key: 'top', className: 'pw-link', href: acc.topUpUrl, target: '_blank', rel: 'noreferrer' }, '充值'),
        );
      }
      if (acc.usageUrl) {
        links.push(
          h('a', { key: 'usage', className: 'pw-link', href: acc.usageUrl, target: '_blank', rel: 'noreferrer' }, '官方用量'),
        );
      }
      if (links.length > 0) rows.push(h('div', { key: 'lk', className: 'pw-wallet-links' }, links));

      // 导出账单按钮
      rows.push(
        h(
          'button',
          {
            key: 'exp',
            className: 'pw-export-btn',
            onClick: function () {
              try {
                var base = walletUrl();
                if (base === null) return;
                var href = base + '/export?format=csv';
                if (typeof window !== 'undefined' && typeof window.open === 'function') {
                  window.open(href, '_blank', 'noopener,noreferrer');
                } else {
                  // 降级：直接跳转
                  window.location.href = href;
                }
              } catch (error) { /* 打不开就忽略 */ }
            },
          },
          '导出账单 CSV',
        ),
      );

      return [h('div', { key: 'card', className: 'pw-wallet-card' }, rows)];
    }

    // ============================================================================
    //  价格状态条（侧栏脚部）
    // ============================================================================
    /** 每秒重渲染一次，让倒计时走动。 */
    function useTicker() {
      var state = react.useState(0);
      var setTick = state[1];
      react.useEffect(function () {
        var timer = setInterval(function () {
          setTick(function (n) {
            return (n + 1) % 1000000;
          });
        }, 1000);
        return function () {
          clearInterval(timer);
        };
      }, []);
      return state[0];
    }

    /** 一个价目格：`谷 / 峰`，当前生效的一档高亮。 */
    function priceCell(key, bucket, isPeak) {
      return h(
        'td',
        { key: key },
        h('span', { className: isPeak ? 'pw-dim' : 'pw-now' }, formatCny(bucket.off)),
        h('span', { className: 'pw-slash' }, ' / '),
        h('span', { className: isPeak ? 'pw-now' : 'pw-dim' }, formatCny(bucket.peak)),
      );
    }

    /**
     * 「距下次谷时/峰时」倒计时文案 —— 价格条与详情浮层共用一份，
     * 保证窄轨、宽轨、浮层三处说法一致（第二档 #7）。
     * s.nextIsPeak 为真表示下一个切换点是峰时（全价），否则是谷时（半价）。
     */
    function nextCountdownText(s) {
      return '距下次' + (s.nextIsPeak ? '峰时' : '谷时') + ' ' + formatDuration(s.minutesLeft);
    }

    /** 弹出详情的内容（外壳卡片由 .pw-pop 提供）。`mode`：'concise' 简洁版 / 其余详细版。 */
    function details(now, s, desc, wallet, mode, onOpenSettings) {
      var concise = mode === 'concise';
      var p = beijingParts(now);

      /** 「当前时段」块：两种模式共用；简洁版的内容就是它 + 账户两块的全部。 */
      var periodBlock = [
        h('div', { key: 't' }, '北京时间 ', h('b', null, formatBeijingFull(now)), ' （', WEEKDAY_CN[p.weekday], '）'),
        h('div', { key: 'c' }, '当前：', h('b', null, desc.title), ' —— ', desc.note),
        h('div', { key: 'n' }, '下次切换：', h('b', null, boundaryLabel(now, s.next)), ' → ', s.nextIsPeak ? '峰时（全价）' : '谷时（半价）'),
        // 倒计时单列一行：简洁版与详细版共用这块，所以两处都会显示「距下次谷时 X」。
        h('div', { key: 'd' }, '距下次', h('b', null, s.nextIsPeak ? '峰时' : '谷时'), '：', h('b', null, formatDuration(s.minutesLeft))),
      ];

      // 底部动作行：两种模式都挂（吸底）。「设置」跳内置插件设置页；
      // 「token 消耗详情」直接打开官方用量页——明细只能在那看，本地算不出来。
      // 只在详细版给「设置」入口会形成死循环（切模式本身要去设置页，简洁版用户就永远进不去）。
      var usageHref = (wallet && wallet.acc && typeof wallet.acc.usageUrl === 'string' && wallet.acc.usageUrl !== '')
        ? wallet.acc.usageUrl
        : 'https://platform.deepseek.com/usage';
      var settingsActions = h(
        'div',
        { key: 'act', className: 'pw-actions' },
        h(
          'button',
          {
            key: 'set',
            type: 'button',
            className: 'pw-set-btn',
            onClick: function () {
              openPluginsSettings();
              if (typeof onOpenSettings === 'function') onOpenSettings();
            },
          },
          '设置',
        ),
        h(
          'button',
          {
            key: 'usage',
            type: 'button',
            className: 'pw-usage-btn',
            title: '打开 DeepSeek 开放平台用量页（官方明细）',
            onClick: function () {
              try {
                if (typeof window !== 'undefined' && typeof window.open === 'function') {
                  window.open(usageHref, '_blank', 'noopener,noreferrer');
                }
              } catch (error) { /* 打不开就忽略，用户还能复制链接 */ }
            },
          },
          'token 消耗详情',
        ),
      );

      if (concise) {
        // 简洁版：只显示余额、今日费用、当前价格档与持续时间（不再挂指路文案）。
        return [
          h('div', { key: 'body', className: 'pw-pop-body' }, [...periodBlock, ...walletDetails(wallet)]),
          settingsActions,
        ];
      }

      var rows = MODELS.map(function (model) {
        return h(
          'tr',
          { key: model.id },
          h('td', { title: model.version }, model.name),
          priceCell('hit', model.cacheHit, s.isPeak),
          priceCell('miss', model.cacheMiss, s.isPeak),
          priceCell('out', model.output, s.isPeak),
        );
      });

      return [
        h(
          'div',
          { key: 'body', className: 'pw-pop-body' },
          [
        h('div', { key: 's1', className: 'pw-sec' }, '当前时段'),
        ...periodBlock,
        h('div', { key: 's2', className: 'pw-sec' }, '账户'),
        ...walletDetails(wallet),
        h('div', { key: 's3', className: 'pw-sec' }, '官方价格表'),
        h(
          'table',
          { key: 'tb', className: 'pw-table' },
          h(
            'thead',
            null,
            h('tr', null, h('th', null, '模型'), h('th', null, '输入·命中'), h('th', null, '输入·未命中'), h('th', null, '输出')),
          ),
          h('tbody', null, rows),
        ),
        h(
          'div',
          { key: 'u' },
          '单位：人民币元 / 100 万 tokens，格式为 ',
          h('span', { className: 'pw-now' }, '当前档'),
          ' / ',
          h('span', { className: 'pw-dim' }, '另一档'),
          '。谷时价格恰为峰时的一半。',
        ),
        h(
          'div',
          { key: 'r', className: 'pw-foot' },
          '峰时：UTC 01:00–04:00、06:00–10:00（北京时间 09:00–12:00、14:00–18:00），',
          '周一至周五且非法定节假日；其余时段（含整个周末与节假日）均为谷时半价。',
        ),
        h('div', { key: 'hh', className: 'pw-foot' }, '节假日表：国务院办公厅《2026 年部分节假日安排》（内置 2026 年，跨年需更新插件）。'),
        h(
          'div',
          { key: 'src', className: 'pw-foot' },
          '数据来源 ',
          h('a', { className: 'pw-link', href: PRICING_URL_CN, target: '_blank', rel: 'noreferrer' }, 'api-docs.deepseek.com/zh-cn/quick_start/pricing'),
          '（抓取于 ',
          PRICING_AS_OF,
          '）',
        ),
          ],
        ),
        // 详细版底部同样挂「设置」：切简洁/详细、开关提示词优化、看帮助都在那一页。
        settingsActions,
      ];
    }

    /** 侧栏脚部的价格状态条。 */
    function PeakWhaleStrip(props) {
      useTicker();
      var wallet = useWallet();
      var ui = useUiSettings();
      var openState = react.useState(false);
      var open = openState[0];
      var setOpen = openState[1];

      var mode = ui && ui.uiMode === 'detailed' ? 'detailed' : 'concise';

      var now = new Date();
      var s;
      try {
        s = summary(now);
      } catch (error) {
        return null;
      }

      var desc = describePeriod(s);
      var off = s.isHalfPrice;
      var wide = !!(props && props.wide);
      var countdown = nextCountdownText(s);
      /** 第二行的「余额 · 今日费用」分段：窄轨态与**没数据**时整行都不渲染。 */
      var segments = wide ? walletItems(wallet) : [];
      var walletText = wide ? walletSummary(wallet) : null;

      var title =
        'DeepSeek 峰谷计价（北京时间 ' + formatBeijingFull(now) + '）\n' +
        '当前：' + desc.title + ' —— ' + desc.note + '\n' +
        '下次切换：' + boundaryLabel(now, s.next) + '（' + (s.nextIsPeak ? '峰时' : '谷时') + '）\n' +
        nextCountdownText(s) +
        (walletText === null ? '' : '\n' + walletText) +
        '\n点击展开今日价格表';

      var body = [h('img', {
        key: 'icon',
        className: 'pw-strip-icon',
        src: WHALE_ICON_URI,
        alt: '',
        'aria-hidden': 'true',
        draggable: false,
      })];
      if (wide) {
        // 数字拆成 `<b>`，标签留次级色：一行数据，而不是一句提示语。
        var walletChildren = [];
        for (var wi = 0; wi < segments.length; wi += 1) {
          if (wi > 0) walletChildren.push(h('span', { key: 'sep' + wi, className: 'pw-wsep' }, '·'));
          walletChildren.push(
            h(
              'span',
              { key: 'item' + wi, className: 'pw-witem' },
              h('span', { className: 'pw-wlabel' }, segments[wi].label),
              h('b', { className: 'pw-wvalue' }, segments[wi].value),
            ),
          );
        }
        body.push(
          h(
            'span',
            { key: 'body', className: 'pw-body' },
            h(
              'span',
              { className: 'pw-row' },
              h('span', { className: 'pw-title', 'data-tone': off ? 'off' : 'peak' }, desc.title),
              h('span', { className: 'pw-spacer' }),
              h('span', { className: 'pw-count' }, countdown),
            ),
            segments.length === 0 ? null : h('span', { className: 'pw-wallet' }, walletChildren),
          ),
        );
      }

      var button = h(
        'button',
        {
          type: 'button',
          className: 'pw-strip',
          'data-tone': off ? 'off' : 'peak',
          'data-wide': wide ? '1' : '0',
          title: title,
          'aria-label': title,
          'aria-expanded': open,
          onClick: function () {
            // 打开详情时顺手刷新一次：详情页要的是「现在」的余额
            if (!open) refreshWallet();
            setOpen(!open);
          },
        },
        ...body,
      );

      if (!open) return button;

      // 模式切换只在设置页里做（v0.4.0 起浮层顶部不再摆开关）。
      return h(
        react.Fragment,
        null,
        button,
        h(
          'div',
          {
            className: 'pw-backdrop',
            onClick: function () {
              setOpen(false);
            },
          },
          h(
            'div',
            {
              className: 'pw-pop',
              role: 'dialog',
              'aria-label': 'DeepSeek 峰谷计价详情',
              onClick: function (event) {
                event.stopPropagation();
              },
            },
            details(now, s, desc, wallet, mode, function () {
              setOpen(false);
            }),
          ),
        ),
      );
    }

    // ============================================================================
    //  鲸鱼娘桌宠（全屏浮层）
    // ============================================================================
    /** 她的"家"：出生位置，也是菜单「回家」的目标。 */
    var HOME_X = 110;
    /** 首次开口前先安静一会儿。 */
    var GREET_DELAY_MS = 9000;
    /** 自动念台词的间隔区间（大多数是价格台词）。 */
    var SPEECH_MIN_MS = 75000;
    var SPEECH_MAX_MS = 150000;
    /** 台词逐字揭示的节奏，以及说完后的停留。 */
    var SPEECH_CHAR_MS = 70;
    var SPEECH_HOLD_MS = 1700;
    /** 亲密度存储键；每 5 次互动升一级，10 级封顶。 */
    var AFFINITY_KEY = 'dsh-peak-whale.affinity.v1';
    var PETS_PER_LEVEL = 5;
    var MAX_LEVEL = 10;
    /** 活力度的存储键（存 0~1 的值 + 是否手动改过）；独立于亲密度存档。 */
    var MOOD_KEY = 'dsh-peak-whale.mood.v1';
    /** 拖拽时「靠近输入框」的判定距离（视口像素）。 */
    var NEAR_COMPOSER_PX = 80;
    /**
     * 「坐好」的存储键 —— 照 Minecraft 里狗的 `sit` 命令那个逻辑：
     * 你说一声「坐好」，她就地坐下并且**不再自己乱跑**，一直坐到你说「起来」。
     * 存进 localStorage，所以刷新页面 / 重开 DSH 她还是坐着的（狗也这样）。
     */
    var SIT_KEY = 'dsh-peak-whale.sit.v1';
    /** 音效开关的存储键（createSfx 读它，值为 'off' 即静音）。 */
    var SOUND_KEY = 'dsh-peak-whale.sound.v1';
    /** 亲密度档位（活动强度档）的存储键，v1 与 sit 一样存本机。 */
    var STYLE_KEY = 'dsh-peak-whale.style.v1';
    /** 窗口很高时别让她长得太大。 */
    var PET_SCALE_MAX = 0.6;
    /** 菜单「换个姿势」的候选：去掉 walk / run —— 那是自由漫游自己会做的事。 */
    var POSE_MOTIONS = (
      PET && PET.MOTIONS ? PET.MOTIONS : ['jump', 'hop', 'look', 'turn', 'nod', 'shake', 'spin', 'sit', 'sleep', 'dizzy', 'stand']
    ).filter(function (m) {
      return m !== 'walk' && m !== 'run';
    });

    /**
     * 三档活动强度 —— 她到底闹不闹。
     *
     * 这是唯一控制她动作多少的旋钮，三档**不是把同一套动作开关掉**，而是各自有不同的
     * 候选池与不同的触发节奏：
     *   quiet  —— 只有微动作，场景反应也只在「久到离谱」时才给，不吵你干活；
     *   daily  —— 默认。日常动作 + 完整场景反应；
     *   lively —— 多两个大动作（打滚、扒拉），触发更频繁，会打断你。
     *
     * `tempo` 是**所有**触发器共用的乘数：她每次决定「现在要不要动」之前都要过它。
     * 写成纯函数是因为它同时被设置面板、菜单和测试用到。
     */
    var STYLE_TIERS = [
      { id: 'quiet', name: '安静', note: '几乎不动：眨眼、耳朵抖、呼吸起伏。只在你真的离开很久之后才有反应。', tempo: 0.55, gestureEvery: [42, 78], idleMs: [240, 420], motions: ['stretch', 'peek', 'peekaboo', 'curl'], reactions: 0.5, idleGestures: 0 },
      { id: 'daily', name: '日常', note: '默认。逗她有十几个小动作，她也会看场景自己动，但不打扰你干活。', tempo: 1, gestureEvery: [16, 34], idleMs: [110, 240], motions: ['stretch', 'peek', 'shakeout', 'beg', 'curl', 'peekaboo', 'swat', 'giggle', 'curtsy', 'nudge', 'lick'], reactions: 1, idleGestures: 1 },
      // 候选池里**不能有重复项**：`pickGesture` 是按下标随机抽的，重复项等于给那个
      // 动作加权两次 —— 活泼档里 swat/shakeout 各写了两遍，结果她会莫名其妙地偏爱这两个动作。
      // 窗口要跟着 tempo 一起缩：`styleDelay` 是拿区间**除以** tempo，所以想让活泼档
      // 的最短间隔也快过日常档的最短间隔，光加 tempo 是不够的，区间本身也得收窄。
      { id: 'lively', name: '活泼', note: '她就是个桌宠，该闹就闹：加打滚和扒拉，触发更频繁，会抢你的注意力。', tempo: 1.6, gestureEvery: [9, 20], idleMs: [40, 95], motions: ['stretch', 'peek', 'shakeout', 'beg', 'curl', 'peekaboo', 'swat', 'giggle', 'curtsy', 'shiver', 'nudge', 'lick', 'brace'], reactions: 1.5, idleGestures: 2 },
    ];

    /** 取一档；认不出就回 daily（默认档），绝不因为一个坏值就让她变成另一个人。 */
    function styleTier(id) {
      for (var i = 0; i < STYLE_TIERS.length; i++) if (STYLE_TIERS[i].id === id) return STYLE_TIERS[i];
      return STYLE_TIERS[1];
    }
    function loadStyle(storage) {
      try {
        if (!storage || typeof storage.getItem !== 'function') return 'daily';
        var raw = storage.getItem(STYLE_KEY);
        return raw ? styleTier(raw).id : 'daily';
      } catch (error) { return 'daily'; }
    }
    function saveStyle(storage, id) {
      try {
        if (!storage || typeof storage.setItem !== 'function') return;
        storage.setItem(STYLE_KEY, styleTier(id).id);
      } catch (error) { /* 存不上不影响使用 */ }
    }
    /**
     * 配色（第二档 #6）。
     *
     * 与 pet-core 的 7 套 PALETTES 同构（id/label/l/d）。这里必须自带一份：
     * 鲸鱼娘是**贴图渲染**（vendor/figure.js 用 scheme 的贴图 + accent），皮肤对象的
     * palette 只影响 pet-core 内置 Coo 的 CSS 变量，管不到她。所以切换配色实际改的是
     * 「特效主色」——把当前 scheme 的 accent 换成所选配色的主色，立刻影响竖耳弧 /
     * 思考气泡 / 睡 z（正是 #8 的 setListening/setThinking 会点亮的东西）；同时把
     * palette 写回 pet-core 的 skin，保持皮肤对象一致，以后换内置人偶也能用。
     */
    var WHALE_PALETTES = [
      { id: 'mint', label: '薄荷绿', l: ['#1B1626', '#00A870'], d: ['#FFFFFF', '#2FD59B'] },
      { id: 'mono', label: '单色', l: ['#1B1626', '#1B1626'], d: ['#FFFFFF', '#FFFFFF'] },
      { id: 'navigator', label: '领航员', l: ['#14213A', '#1F6FE0'], d: ['#FFFFFF', '#5EA3FF'] },
      { id: 'claude', label: '克劳德', l: ['#2A1C16', '#C9623F'], d: ['#FFFFFF', '#E58B69'] },
      { id: 'fox', label: '红狐狸', l: ['#26140F', '#DD3526'], d: ['#FFFFFF', '#FF6655'] },
      { id: 'purple', label: '虚式茈', l: ['#1D1430', '#8B3DF0'], d: ['#FFFFFF', '#B98AFF'] },
      { id: 'lemon', label: '柠檬黄', l: ['#252010', '#D9B300'], d: ['#FFFFFF', '#FFE14F'] },
    ];
    /** 配色本机存档键（与活力度/坐好一样走 localStorage；Host 设置用于跨设备同步）。 */
    var PALETTE_KEY = 'dsh-peak-whale.palette.v1';
    /** 认配色；认不出就回第一套（绝不因为一个坏值让特效主色消失）。 */
    function paletteById(id) {
      for (var i = 0; i < WHALE_PALETTES.length; i++) if (WHALE_PALETTES[i].id === id) return WHALE_PALETTES[i];
      return WHALE_PALETTES[0];
    }
    /** 某套配色的主色（浅色侧用 l[1]，深色侧用 d[1]）。 */
    function paletteAccent(id, dark) {
      var p = paletteById(id);
      return dark ? p.d[1] : p.l[1];
    }
    function loadPalette(storage) {
      try {
        if (!storage || typeof storage.getItem !== 'function') return 'mint';
        var raw = storage.getItem(PALETTE_KEY);
        return raw ? paletteById(raw).id : 'mint';
      } catch (error) { return 'mint'; }
    }
    function savePalette(storage, id) {
      try {
        if (!storage || typeof storage.setItem !== 'function') return;
        storage.setItem(PALETTE_KEY, paletteById(id).id);
      } catch (error) { /* 存不上不影响使用 */ }
    }
    /**
     * 在 `[lo, hi]` 秒的窗口里按档位缩放取一个数。
     *
     * tempo < 1 时**把窗口拉长**而不是取中间值：安静档的「20~40 秒来一次」
     * 变成「36~73 秒来一次」，这样安静是真的安静，而不是「照样频繁地做小事」。
     */
    function styleDelay(range, tempo) {
      var t = typeof tempo === 'number' && tempo > 0 ? tempo : 1;
      var lo = range[0] / t, hi = range[1] / t;
      return lo + Math.random() * (hi - lo);
    }
    /** 从候选池里挑一个；池子空或全被过滤掉时返回 null（宁可不动，也不要演一个不存在的动作）。 */
    function pickGesture(pool, allowed) {
      var list = [];
      for (var i = 0; i < pool.length; i++) if (!allowed || allowed.indexOf(pool[i]) >= 0) list.push(pool[i]);
      if (!list.length) return null;
      return list[Math.floor(Math.random() * list.length)];
    }

    // ============================================================================
    //  场景反应：她看情况自己动
    //
    //  判定全在下面这个纯状态机里（吃「上一次输入是什么时候 / 现在在不在打字 /
    //  刚跑完优化没」，吐出「该演哪个动作、没有就什么都不做」），所以能直接单测；
    //  真正的「让她演」由主循环每帧调一次 driveReactions 完成 —— 就像打字回避那样。
    //
    //  为什么要有冷却：没有的话，一段长按不放手、或者光标停着不动，
    //  会让她每帧都判定「你还在打字」然后每帧都想演 —— 表现就是不停抽搐。
    // ============================================================================
    /** 各反应的门槛（毫秒）与冷却。阈值差异很大是有原因的，见下面注释。 */
    var REACT = {
      // 你回来：从「完全没有输入」变成「有输入」的那一刻，一次性的
      back: { after: 25000, cool: 12000 },
      // 你打字打太久：靠**连续**时长，所以只有真的在写才算，跑一会儿鼠标不算
      typing: { after: 90000, cool: 60000 },
      // 电脑太久没动静（你在想事情或者离开了）：这个是"待机"，阈值给得长
      idle: { after: 180000, cool: 45000 },
      // 久到离谱，连招呼都不打了，她自己打哈欠躺下
      idleSleep: { after: 600000, cool: 1 },
      // 坐好过期：电脑这么久没人管，「坐好」就没有意义了，解除它让她自己活动
      autoRise: { after: 600000, cool: 1000 },
      // 优化刚跑完
      done: { after: 0, cool: 30000 },
    };
    /** 冷却到期之前，再来同样的情况也不许演。 */
    var REACT_COOLDOWN = 1;

    /**
     * 场景反应状态机（纯函数，不碰 DOM / 不碰 ctl）。
     *
     * @param {object} s  上一次返回的状态（第一次传 null）
     * @param {object} n  现在的观察值：
     *   now        当前时刻（ms）
     *   inputAt    你上一次有输入（键盘/鼠标/滚轮）的时刻
     *   typing     你现在是不是在打字
     *   justDone   刚刚跑完一次提示词优化（消费掉会自己置 false）
     *   tier       活动强度档对象
     * @returns {{gesture?: string, say?: string, sleep?: boolean, state: object}}
     *
     * `state` **必须**每次都带在返回值里（哪怕这一帧什么都没演）：调用方是
     * `driveReactions`，它只认返回值里的 state。早先只在 return 前顺手写
     * `st.cd = cd` 忘了写 `out.state = st`，于是调用方的 `plan.state || reactState`
     * 每帧都拿到 undefined、跨帧记忆全丢 —— 冷却与"你回来了"永远不生效，
     * 而且因为不报错，测试还一度以为它在工作。
     */
    function reactionStep(s, n) {
      var st = s || { doneAt: 0, sleeping: false };
      var t = n.tier;
      var now = n.now;
      var out = {};
      // 冷却表跟着状态走：记录每个反应上次**判下来要演**的时刻
      var cd = st.cd || {};
      var cool = function (key) {
        return !(cd[key] != null && now - cd[key] < REACT[key].cool * REACT_COOLDOWN);
      };
      var mark = function (key) { cd[key] = now; };

      // 活动强度低的档位把反应整体压掉一部分：安静档只保留"睡"和久到离谱的回神
      var reactScale = t.reactions;

      // 0. 坐好过期 → 自己站起来活动。这是**状态修正**，不是表演，所以：
      //    · 排在最前面（就算她正睡着、就算这一档很安静，也照样要修）；
      //    · 不查 reactScale（安静 ≠ 卡死）。
      //
      //  ⚠️ 这里**不能只靠冷却**去重。`n.sitting` 来自 React 的 store，而 `setSit(false)`
      //    → commit → 重渲染要等下一帧才生效；冷却又是 1 秒，于是一次起身会连着喊十几次
      //    （第一版就是这样，对着你连说"坐太久了我腿麻"）。
      //
      //    去重要靠**边沿**：只有「没坐 → 坐」的那一下才重新允许起身（`wasSitting` 记边沿），
      //    报过一次就把 `canRise` 记死。若写成「只要在坐就重新允许」，那它在坐着期间每帧都会
      //    自我重新武装，等于没记 —— 这也是第一版的第二个错。
      if (n.sitting && !st.wasSitting) st.canRise = true;
      if (!n.sitting) st.canRise = false;
      st.wasSitting = !!n.sitting;
      if (st.canRise && n.inputAt != null && (now - n.inputAt) > REACT.autoRise.after) {
        mark('autoRise'); st.cd = cd; st.canRise = false;
        out.rise = true; out.say = 'react.rise';
        out.state = st;
        return out;
      }

      // 1. 刚跑完优化 → 蹦一下。这是她唯一"有确切理由兴奋"的时刻。
      //    放在 sleeping 检查**之前**是有意的：她睡得正香，你把活干完了，
      //    她应该被吵起来告诉你，而不是继续装睡。
      if (n.justDone && cool('done') && reactScale >= 1) {
        mark('done'); out.gesture = 'beg'; out.say = 'react.done';
        st.cd = cd; st.doneAt = now; st.sleeping = false;
        out.state = st;
        return out;
      }
      // 已经睡了就只等「你回来了」，别的都别做
      if (st.sleeping) {
        if (n.inputAt != null && st.lastInput != null && n.inputAt !== st.lastInput && (now - st.lastInput) > REACT.back.after) {
          st.sleeping = false; st.lastInput = n.inputAt;
          st.cd = cd; out.gesture = 'stretch'; out.say = 'react.wake';
          out.state = st;
          return out;
        }
        st.lastInput = n.inputAt; st.cd = cd;
        out.state = st;
        return out;
      }
      var quiet = n.inputAt != null && (now - n.inputAt) > REACT.idle.after;

      // 2. 你回来了：断过很久之后又开始有输入
      if (n.inputAt != null && st.lastInput != null && n.inputAt !== st.lastInput
          && (now - st.lastInput) > REACT.back.after && cool('back') && reactScale >= 1) {
        mark('back'); st.lastInput = n.inputAt; st.cd = cd;
        out.gesture = 'peek'; out.say = 'react.back';
        out.state = st;
        return out;
      }
      // 3. 打字太久 → 趴下来看你
      if (n.typing && st.typingSince != null && (now - st.typingSince) > REACT.typing.after
          && cool('typing') && reactScale >= 1) {
        mark('typing'); st.cd = cd; out.gesture = 'peek'; out.say = 'react.typing';
        out.state = st;
        return out;
      }
      if (n.typing) { if (st.typingSince == null) st.typingSince = now; }
      else st.typingSince = null;

      // 4. 待机：电脑很久没动静，她自己伸懒腰 / 抖抖毛
      //    注意这里**不查 reactScale**：安静档也该有点"活着的痕迹"，
      //    它安静是靠 idleGestures=0（见第 5 条之前的分支）与更慢的节奏，
      //    而不是靠"什么都不做" —— 后者那不叫安静，那叫坏了。
      if (quiet && cool('idle') && t.idleGestures > 0) {
        mark('idle'); st.cd = cd;
        out.gesture = pickGesture(['stretch', 'shakeout', 'peekaboo'], t.motions) || 'stretch';
        out.say = 'react.idle';
        out.state = st;
        return out;
      }
      // 5. 久到离谱 → 她自己躺下（睡觉不是手势，是模式）
      if (quiet && cool('idleSleep')) {
        mark('idleSleep'); st.cd = cd; st.sleeping = true; st.lastInput = n.inputAt;
        out.sleep = true; out.say = 'react.idle';
        out.state = st;
        return out;
      }

      st.lastInput = n.inputAt; st.cd = cd;
      out.state = st;
      return out;
    }

    /** 互动次数 → 亲密度等级（纯函数，便于测试）。 */
    function affinityLevel(pets) {
      var n = typeof pets === 'number' && pets > 0 ? Math.floor(pets) : 0;
      return Math.min(MAX_LEVEL, 1 + Math.floor(n / PETS_PER_LEVEL));
    }

    /** 从 storage 读亲密度（storage 以参数传入，便于测试；读取失败一律当 0）。 */
    function loadAffinity(storage) {
      try {
        if (!storage || typeof storage.getItem !== 'function') return 0;
        var raw = storage.getItem(AFFINITY_KEY);
        if (!raw) return 0;
        var parsed = JSON.parse(raw);
        var pets = parsed && typeof parsed.pets === 'number' ? parsed.pets : 0;
        return pets > 0 ? Math.floor(pets) : 0;
      } catch (error) {
        return 0;
      }
    }

    /** 写亲密度；隐私模式 / 配额满都会抛，一律吞掉（存不上不影响使用）。 */
    function saveAffinity(storage, pets) {
      try {
        if (!storage || typeof storage.setItem !== 'function') return false;
        storage.setItem(AFFINITY_KEY, JSON.stringify({ pets: pets, at: Date.now() }));
        return true;
      } catch (error) {
        return false;
      }
    }

    /**
     * 读「是否坐好」——和 Minecraft 里那条 sit 命令同一套心智模型：
     * 坐下 = 一个**持续状态**，不是一次动作。所以它要被记住，刷新了也得还在。
     * 读取失败一律当 false（站着），绝不因为读不到就让她卡在坐姿。
     */
    function loadSit(storage) {
      try {
        if (!storage || typeof storage.getItem !== 'function') return false;
        var parsed = JSON.parse(storage.getItem(SIT_KEY));
        return !!(parsed && parsed.sit);
      } catch (error) {
        return false;
      }
    }

    /** 写「是否坐好」；存不上也不影响本次会话内的行为（只是下次刷新不记得）。 */
    function saveSit(storage, sit) {
      try {
        if (!storage || typeof storage.setItem !== 'function') return false;
        storage.setItem(SIT_KEY, JSON.stringify({ sit: !!sit, at: Date.now() }));
        return true;
      } catch (error) {
        return false;
      }
    }

    // ============================================================================
    //  活力度（mood）与亲密度的实时镜像
    //
    //  setMood 上游只有一个 0~1 的目标值，而亲密度每涨一次都会去同步它 ——
    //  于是你在设置页拖好的滑块，下一次摸头就被亲密度冲掉了。所以要在模块级记两件事：
    //    whaleMood.value   —— 当前生效的活力度
    //    whaleMood.manual  —— 用户有没有手动拖过（true 之后亲密度不再自动覆盖）
    //  两者都落 localStorage（独立于亲密度存档），刷新页面后手动值还在。
    //
    //  WhaleRoamer 的 store 是组件私有的，设置页读不到，所以这里再留一份**镜像**，
    //  用极简订阅把亲密度变化推给设置页（订阅者抛错一律忽略，绝不影响桌宠）。
    // ============================================================================
    var whaleMood = { value: 0, manual: false };
    var whaleMoodListeners = [];
    var whaleAffinity = { pets: 0, level: 1 };
    var whaleAffinityListeners = [];

    /** 读活力度存档；读不到 / 坏数据一律当「未手动设定」（回落到亲密度换算）。 */
    function loadWhaleMood(storage) {
      try {
        if (!storage || typeof storage.getItem !== 'function') return null;
        var raw = storage.getItem(MOOD_KEY);
        if (!raw) return null;
        var parsed = JSON.parse(raw);
        var v = parsed && typeof parsed.value === 'number' ? parsed.value : null;
        if (v === null || !isFinite(v)) return null;
        return { value: Math.min(1, Math.max(0, v)), manual: !!(parsed && parsed.manual) };
      } catch (error) {
        return null;
      }
    }

    /** 写活力度存档；存不上不影响本次会话（只是下次刷新不记住）。 */
    function saveWhaleMood(storage, value, manual) {
      try {
        if (!storage || typeof storage.setItem !== 'function') return false;
        storage.setItem(MOOD_KEY, JSON.stringify({
          value: value, manual: !!manual, at: Date.now(),
        }));
        return true;
      } catch (error) {
        return false;
      }
    }

    /** 亲密度 → 活力度（0~1）。纯函数，便于测试。 */
    function moodFromPets(pets) {
      return Math.min(1, Math.log(1 + (pets || 0)) / Math.log(121));
    }

    /** 启动时把存档读进模块状态。 */
    (function initWhaleMood() {
      var saved = loadWhaleMood(safeStorage());
      if (saved) whaleMood = saved;
    })();

    /** 取当前活力度（0~1）。 */
    function getWhaleMood() { return whaleMood; }

    /** 订阅活力度变化（设置页的滑块靠它自动跟随亲密度）。 */
    function subscribeWhaleMood(fn) {
      whaleMoodListeners.push(fn);
      return function () {
        var i = whaleMoodListeners.indexOf(fn);
        if (i >= 0) whaleMoodListeners.splice(i, 1);
      };
    }
    function notifyWhaleMood() {
      for (var i = 0; i < whaleMoodListeners.length; i += 1) {
        try { whaleMoodListeners[i](whaleMood); } catch (error) { /* 订阅者炸了不影响别人 */ }
      }
    }

    /** 取亲密度的实时镜像（设置页显示用）。 */
    function getWhaleAffinity() { return whaleAffinity; }

    /** 订阅亲密度变化。 */
    function subscribeWhaleAffinity(fn) {
      whaleAffinityListeners.push(fn);
      return function () {
        var i = whaleAffinityListeners.indexOf(fn);
        if (i >= 0) whaleAffinityListeners.splice(i, 1);
      };
    }
    function notifyWhaleAffinity() {
      for (var i = 0; i < whaleAffinityListeners.length; i += 1) {
        try { whaleAffinityListeners[i](whaleAffinity); } catch (error) { /* 同上 */ }
      }
    }

    /** 把活力度同步给 pet-core（它没有独立状态，只能被外部设值）。 */
    function syncWhaleMoodToPet() {
      var api = exports.__whaleApi;
      var ctl = api && api.ctl;
      if (ctl && typeof ctl.setMood === 'function') {
        try { ctl.setMood(whaleMood.value); } catch (error) { /* 忽略 */ }
      }
    }

    /**
     * 应用活力度。
     * manual=true：用户手动拖动 —— 写存档、置手动标志、同步宠物、通知订阅者。
     * manual=false：恢复自动跟随 —— 值由亲密度换算，只清掉手动标志。
     */
    function applyWhaleMood(value, manual) {
      var v = Math.min(1, Math.max(0, Number(value) || 0));
      whaleMood = { value: v, manual: !!manual };
      saveWhaleMood(safeStorage(), v, !!manual);
      syncWhaleMoodToPet();
      notifyWhaleMood();
      return v;
    }

    /**
     * 亲密度进度（纯函数，便于测试与设置页共用）。
     * 到满级时 toNext = 0（没有「再互动 N 次」这回事了），用 max 区分。
     */
    function affinityProgress(pets) {
      var n = typeof pets === 'number' && pets > 0 ? Math.floor(pets) : 0;
      var level = affinityLevel(n);
      if (level >= MAX_LEVEL) return { pets: n, level: level, toNext: 0, max: true };
      return { pets: n, level: level, toNext: PETS_PER_LEVEL - (n % PETS_PER_LEVEL), max: false };
    }

    /** 订阅亲密度镜像（设置页用）。 */
    function useWhaleAffinity() {
      var pair = react.useState(whaleAffinity);
      var setValue = pair[1];
      react.useEffect(function () {
        whaleAffinityListeners.push(setValue);
        return function () {
          var index = whaleAffinityListeners.indexOf(setValue);
          if (index >= 0) whaleAffinityListeners.splice(index, 1);
        };
      }, []);
      return pair[0];
    }

    /** 订阅活力度（设置页滑块用）。 */
    function useWhaleMood() {
      var pair = react.useState(whaleMood);
      var setValue = pair[1];
      react.useEffect(function () {
        whaleMoodListeners.push(setValue);
        return function () {
          var index = whaleMoodListeners.indexOf(setValue);
          if (index >= 0) whaleMoodListeners.splice(index, 1);
        };
      }, []);
      return pair[0];
    }

    function WhaleRoamer() {
      // 可变 store + 手动重渲染：rAF 闭包永远读到最新值，不会踩 stale state。
      var store = react.useState(function () {
        var saved = loadAffinity(safeStorage());
        // 同步亲密度镜像：设置页可能在桌宠之前挂载，不能只靠 bumpAffinity 更新。
        whaleAffinity = { pets: saved, level: affinityLevel(saved) };
        return {
          ready: false,
          pets: saved,
          level: affinityLevel(saved),
          /** 拖拽时是否贴着输入框（辉光反馈）；松手即清，不落盘。 */
          near: false,
          /**
           * 「坐好」：就地坐下并且不再自己乱跑，一直坐到你说「起来活动」。
           * 是**持续状态**（照 Minecraft 里狗的 sit 命令），所以刷新页面也还在。
           */
          sit: loadSit(safeStorage()),
          /**
           * 活动强度档（quiet / daily / lively）：决定她有多少动作、触发多频繁。
           * 也存本机 —— 你选了「安静」，下次开 DSH 她还是安静的。
           */
          style: loadStyle(safeStorage()),
          menu: null,
          /** 提示词优化：进行中（拖投递后等上游返回） */
          busy: false,
          /**
           * 优化流程的气泡（**挂在小鲸鱼身上**，跟着她走）：
           *   busy  「正在优化提示词中…」（无按钮）
           *   pick  三版选一：整行替换 / 行内只复制 / 底部不优化+关闭（不设消失时间）
           *   paste 写不进框：摊正文 + 复制 / 关闭
           *   info  「已换成「X」那版…」（6 秒后自收）
           *   error 失败原因 + 「知道了」，8 秒后自动收起
           */
          opt: null,
          /** 可撤销的原稿：{ el, original, optimized, since } */
          undo: null,
        };
      })[0];
      var counter = react.useState(0);
      var draw = counter[1];
      var api = react.useState(function () {
        return {
          store: store,
          commit: null,
          ctl: null,
          pointOf: null,
          startSpeech: null,
          /** 最近一次打字的文本框：拖她过来时往哪儿投递就看它 */
          composer: null,
          /** 按下时的指针状态 `{x, y, moved}` —— 用来区分「拖动」和「点一下」 */
          press: null,
          /** 投递之后让她离开文本框区域的截止时刻（打字回避那套逻辑复用） */
          avoidUntil: 0,
        };
      })[0];
      var stageRef = react.useRef(null);
      var petRef = react.useRef(null);
      var shadowRef = react.useRef(null);
      var fxRef = react.useRef(null);
      var hitRef = react.useRef(null);
      var bubbleRef = react.useRef(null);
      /** 优化气泡的 DOM：位置每帧钉在小鲸鱼头顶（拖着她跑时气泡跟着走）。 */
      var optRef = react.useRef(null);
      /** 人偶显示开关（设置页 → 显示/关闭小鲸鱼人偶）。 */
      var uiSettings = useUiSettings();

      function commit(patch) {
        for (var key in patch) {
          if (Object.prototype.hasOwnProperty.call(patch, key)) store[key] = patch[key];
        }
        // busy 状态反馈（第二档 #8）：优化进行中让她「思考」（思考气泡亮起），
        // 完成 / 失败（busy 变 false）就收掉。这是 busy 唯一的变化入口，
        // 所以挂在 commit 上比在每个调用点各写一遍更不容易漏。
        if (Object.prototype.hasOwnProperty.call(patch, 'busy') && api.ctl && typeof api.ctl.setThinking === 'function') {
          try { api.ctl.setThinking(!!store.busy); } catch (error) { /* 忽略 */ }
        }
        draw(function (n) {
          return (n + 1) % 1000000;
        });
      }
      api.commit = commit;
      // 测试 / 二次开发钩子：真正的 api 对象（commit、ctl、store、undoOptimize…）。
      // UI 状态全靠 commit 驱动，所以从这里能断言整条「投递 → 优化 → 撤销」链路。
      exports.__whaleApi = api;

      /** 她身上发生的每一次互动（拎起/放下/抛出/戳/摸）都会调这里。 */
      function bumpAffinity(n) {
        var pets = store.pets + (n || 1);
        var level = affinityLevel(pets);
        var leveledUp = level > store.level;
        saveAffinity(safeStorage(), pets);
        commit({ pets: pets, level: level });
        // 亲密度的实时镜像：设置页（另一个组件）靠订阅它刷新「Lv.X · 再互动 M 次」。
        whaleAffinity = { pets: pets, level: level };
        notifyWhaleAffinity();
        // 心情跟着亲密度走：被摸得越多，她尾巴摇得越勤。亲密度是累计的，
        // 所以 mood 走的是它的对数而不是线性 —— 摸到 100 次不该比摸到 10 次激动十倍。
        // 用户手动拖过活力度滑块时不再自动覆盖（否则滑块形同虚设）。
        if (!whaleMood.manual) {
          whaleMood.value = moodFromPets(pets);
          if (api.ctl && typeof api.ctl.setMood === 'function') {
            api.ctl.setMood(whaleMood.value);
          }
          notifyWhaleMood();
        }
        if (leveledUp) {
          if (api.cueSound) api.cueSound('sparkle');
          if (api.startSpeech) api.startSpeech('又摸我了… Lv.' + level);
        }
      }

      /**
       * 演一个手势。返回有没有真的演起来。
       *
       * 三层防护，一个都不能少：
       *   1. 这一档允许这个动作吗（安静档没有 beg / swat）；
       *   2. pet-core 自己判断身体此刻能不能演（空中、被拎着、走路中）；
       *   3. 演不起来就**说出来**，不能静默 —— 上次「拖过去没反应」就是这么查了半天的。
       */
      api.playGesture = function (name, opts) {
        var ctl = api.ctl;
        if (!ctl || typeof ctl.gesture !== 'function') return false;
        var tier = styleTier(store.style);
        var allowed = tier.motions;
        var picked = pickGesture(allowed.indexOf(name) >= 0 ? [name] : allowed, allowed);
        if (!picked) {
          if (api.startSpeech) api.startSpeech('这个档位我不做这个动作');
          return false;
        }
        var played = false;
        try { played = ctl.gesture(picked) === true; } catch (error) { played = false; }
        if (played) {
          bumpAffinity(1);
          pwBeacon('gesture', picked);
          if (api.cueSound) api.cueSound('pop');
          if (api.startSpeech) {
            var lines = roamLines(new Date());
            var g = lines.gesture[picked];
            api.startSpeech(g && g.length ? pickOne(g) : null);
          }
        } else if (opts && opts.quiet !== true && api.startSpeech) {
          api.startSpeech('现在动不了，等一下');
        }
        return played;
      };

      /** 「逗她玩」：从这一档的候选池里随机抽一个。 */
      api.playRandomGesture = function () {
        var tier = styleTier(store.style);
        var pool = tier.motions.slice();
        if (store.sit) pool = pool.concat(['curl', 'curtsy', 'peekaboo']); // 坐着也能演的小动作
        var name = pickGesture(pool, null);
        if (!name) return false;
        return api.playGesture(name);
      };

      /**
       * 切换活动强度档位。存本机，并立刻让 pet-core 知道新的心情基准。
       *
       * 换档**不打断她正在演的动作** —— 正在演的让它演完，不然会出现
       * 「你刚点活泼，她手里那个伸懒腰被腰斩」的半吊子状态。
       */
      api.setStyle = function (next) {
        var tier = styleTier(next);
        if (store.style === tier.id) return;
        commit({ style: tier.id });
        saveStyle(safeStorage(), tier.id);
        if (api.ctl && typeof api.ctl.setMood === 'function') {
          var pets = store.pets || 0;
          api.ctl.setMood(Math.min(1, Math.log(1 + pets) / Math.log(121)));
        }
        pwBeacon('style', tier.id);
        if (api.cueSound) api.cueSound('select');
        if (api.startSpeech) {
          api.startSpeech(tier.id === 'quiet' ? '那我小声点' : tier.id === 'lively' ? '那我可撒欢儿了啊' : '好，知道了');
        }
      };

      /**
       * 切换配色（第二档 #6）。
       *
       * 鲸鱼娘是**贴图渲染**，皮肤对象的 palette 管不到她，所以这里做两件事：
       *   1. 把 palette 写回 pet-core 的 skin（皮肤对象保持一致，以后换内置人偶能用）；
       *   2. 把当前 scheme 的 accent 换成所选配色的主色 —— 特效（竖耳弧 / 思考气泡 /
       *      睡 z）是每帧读 accent 的，改完立刻生效，不需要重建 figure。
       * 返回实际生效的配色 id（认不出就回第一套）。
       */
      api.applyPalette = function (id) {
        var p = paletteById(id);
        // 注意：ctl / figure 是 useEffect 里声明的局部变量，组件作用域里读不到，
        // 必须走 api 上的引用（api.ctl / api.figure）。
        var pet = api.ctl;
        if (pet && typeof pet.setSkin === 'function') {
          try {
            var skin = (pet.skin && typeof pet.skin === 'object') ? pet.skin : {};
            var next = {};
            for (var k in skin) {
              if (Object.prototype.hasOwnProperty.call(skin, k)) next[k] = skin[k];
            }
            next.palette = p.id;
            pet.setSkin(next);
          } catch (error) { /* 换肤失败不该影响主流程 */ }
        }
        var fig = api.figure;
        if (fig && Array.isArray(fig.schemes) && typeof fig.scheme === 'string') {
          for (var i = 0; i < fig.schemes.length; i += 1) {
            var sc = fig.schemes[i];
            if (sc && sc.id === fig.scheme) sc.accent = paletteAccent(p.id, false);
          }
        }
        return p.id;
      };

      function localPoint(event) {
        return api.pointOf ? api.pointOf(event) : { x: event.clientX, y: event.clientY };
      }

      /**
       * 这次投递该往哪个文本框去：聚焦的 → 最近打字的那个 → 页面上最大的可见文本框。
       *
       * 第三条兜底是给「插件加载之前你就已经写好提示词了」这种情况：那会儿
       * `api.composer` 还是空的，靠焦点也找不回来，就按大小猜底部那个大框。
       */
      function findComposer() {
        try {
          const focused = editableAncestor(typeof document !== 'undefined' ? document.activeElement : null);
          if (focused) return focused;
        } catch (error) { /* 继续往下找 */ }
        if (api.composer && api.composer.isConnected !== false) return api.composer;
        try {
          if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return null;
          const nodes = document.querySelectorAll('textarea, input, [contenteditable]');
          let best = null;
          let bestArea = 0;
          for (let i = 0; i < nodes.length; i += 1) {
            const el = nodes[i];
            if (!isEditable(el)) continue;
            const r = el.getBoundingClientRect();
            const area = Math.max(0, r.right - r.left) * Math.max(0, r.bottom - r.top);
            if (area > bestArea) {
              best = el;
              bestArea = area;
            }
          }
          return best;
        } catch (error) {
          return null;
        }
      }

      /**
       * 投递：读原文 → 打 Host 的三版优化路由 → 弹三版可选气泡。
       * 气泡都**挂在小鲸鱼身上**（拖着她跑气泡跟着走）：
       *   busy → 「正在优化提示词中…」（无按钮，完成即收）
       *   pick → 三版优化结果，每行=替换 / 行内复制 / 底部不优化+关闭（不设消失时间，等你选）
       *   失败 → 失败原因 + 「知道了」，8 秒后自动收起
       */
      api.deliverToComposer = function (box) {
        if (!box || store.busy) {
          pwBeacon('deliver', !box ? 'no-box' : 'busy');
          return;
        }
        const text = readComposer(box);
        if (text.trim() === '') {
          pwBeacon('deliver', 'empty-text');
          if (api.startSpeech) api.startSpeech('框里空着呢，先写点什么');
          return;
        }
        pwBeacon('deliver', 'len=' + text.length + ' tag=' + (box.tagName || '?'));
        commit({
          busy: true,
          undo: null,
          opt: { kind: 'busy', text: '正在优化提示词中…' },
        });
        // busy 气泡本身就是提示，不再抢话——两个气泡叠一起会打架。
        optimizePrompt3(text).then(function (result) {
          pwBeacon('deliver-result', result && result.ok ? 'ok variants=' + (result.variants ? result.variants.length : 0) : ('fail:' + (result && result.message ? 'msg' : '?')));
          if (result && result.ok && Array.isArray(result.variants) && result.variants.length > 0) {
            commit({
              busy: false,
              undo: null,
              // 三版气泡：不设消失时间，等你选。box 留着（选中那版要写回去）。
              // original 仍带上：v0.5.4 起它**不再有任何显示入口**，只是留在内存里，
              // 万一以后要恢复对照/回退能力不必重新设计数据结构。
              opt: { kind: 'pick', variants: result.variants, original: text, box: box, until: 0 },
            });
          } else {
            const message = (result && result.message) || '优化失败了';
            commit({
              busy: false,
              undo: null,
              opt: { kind: 'error', text: message, until: Date.now() + 8000 },
            });
          }
        });
      };

      /**
       * 选中某一版优化结果：**直接把改写后的正文写回文本框**，然后气泡收掉。
       *
       * v0.5.4 起不再留可撤销的原稿，也不再问"要不要回退"—— 只在完成提示里
       * 带一句「原文已移除，如需保留请说明」，剩下的由你决定。
       * 传 `null` = 「还是不优化了吧」——什么都不写，直接收气泡。
       *
       * **写回后必须复查**：DSH 的输入框是 contenteditable 富文本编辑器，
       * 富文本编辑器会把「绕过它直接改 DOM」当外部脏数据在下一帧回滚 —— 所以
       * 「已换成『更详细』那版」这句话可能是假的。这里读回来对一次，对不上就
       * 把正文摊在气泡上让你能复制，同时明说没写进去，绝不假装成功。
       */
      api.pickVariant = function (variant) {
        const opt = store.opt;
        if (!opt || opt.kind !== 'pick') return;
        if (variant === null || variant === undefined) {
          pwBeacon('pick', 'skip');
          commit({ opt: null, busy: false, undo: null });
          if (api.startSpeech) api.startSpeech('嗯，不动它');
          return;
        }
        pwBeacon('pick', variant.key || '?');
        const box = opt.box;
        const want = String(variant.optimized === null || variant.optimized === undefined ? '' : variant.optimized);
        const wrote = writeComposer(box, want);
        // 富文本编辑器回滚是异步的（下一帧 reconciliation），所以立刻读一次不够，
        // 留一份「等一会儿再验」的定时器：两次都失败才算真失败。
        const verify = function () {
          const got = readComposer(box);
          const good = got.trim() === want.trim();
          pwBeacon('pick-write', variant.key + ' ok=' + (wrote && good));
          if (good) {
            // 成功写进去了：这是她唯一"有确切理由兴奋"的时刻（见 reactionStep 的 done 分支）
            api.markOptimizeDone();
            commit({
              opt: {
                kind: 'info',
                // ⚠️ 这里**不能**再说"右键我可以撤销" —— 原文已经不再对你呈现了
                //（v0.5.4 起），提一个不存在的入口就是在骗人。
                text: '已换成「' + (variant.label || '优化') + '」那版。原文已移除，如需保留请说明'
                  + (variant.rounds && variant.rounds > 1 ? '（迭代 ' + variant.rounds + ' 轮）' : '')
                  + usageNote(variant.usage) + thinkingNote(variant.ms),
                until: Date.now() + 6000,
              },
              busy: false,
              // ⚠️ 原稿**仍然留在内存里**（userVisibleOriginal === false）：
              //   显示层已经不再提供任何看/撤原文的入口，但这份数据留着，
              //   万一以后要恢复对照/回退能力，不必重新设计数据结构。
              //   它不进 undo 态 → 右键菜单、shouldDismissUndo 都碰不到它。
              undo: null,
            });
            return;
          }
          // 没写进去：别装成功。正文直接摊在气泡上，够你点「复制」。
          commit({
            opt: {
              kind: 'paste',
              label: variant.label || '优化',
              optimized: want,
              until: 0,
            },
            busy: false,
            undo: null,
          });
          if (api.startSpeech) api.startSpeech('这个框不让我写，我把正文放气泡上了，你复制一下');
        };
        if (readComposer(box).trim() === want.trim()) verify();
        else setTimeout(verify, 120);
      };

      /** 撤销：把原稿写回去，气泡一起收掉。 */
      api.undoOptimize = function () {
        const undo = store.undo;
        if (!undo) return;
        writeComposer(undo.el, undo.original);
        commit({ undo: null, opt: null, busy: false });
        if (api.startSpeech) api.startSpeech('换回来了');
      };

      /** 关掉优化气泡（「关闭」/「知道了」/ pick 的「还是不优化了吧」都会走到这）。 */
      api.dismissOpt = function () {
        if (store.opt) commit({ opt: null });
      };

      /**
       * 把一段文本塞进剪贴板：`navigator.clipboard` 优先，失败退回 `execCommand('copy')`。
       *
       * 后者在非 https 的本地源（127.0.0.1 之外的局域网地址）上才有，DSH 就是
       * `http://127.0.0.1:19387`，clipboard API 偶尔会被权限策略挡掉。
       * 回调 `(ok, why)`，**永不 reject**。
       */
      function writeClipboard(text, cb) {
        const done = cb || function () {};
        try {
          if (typeof navigator !== 'undefined' && navigator.clipboard
              && typeof navigator.clipboard.writeText === 'function') {
            navigator.clipboard.writeText(text).then(function () { done(true); }, function (e) { done(false, e && e.message); });
            return;
          }
        } catch (error) { /* 落到 execCommand */ }
        try {
          const doc = typeof document !== 'undefined' ? document : null;
          const ta = doc && doc.createElement ? doc.createElement('textarea') : null;
          if (ta && doc.body && doc.execCommand) {
            ta.value = text;
            ta.style.position = 'fixed';
            ta.style.left = '-9999px';
            doc.body.appendChild(ta);
            ta.select();
            const ok = doc.execCommand('copy');
            doc.body.removeChild(ta);
            done(!!ok);
            return;
          }
        } catch (error2) { /* 落到失败 */ }
        done(false, 'no-clipboard');
      }

      /**
       * 把「写不进去那版」的正文复制走（paste 态的「复制」按钮）。
       *
       * 复制成功/失败**都要说清楚**，失败时正文继续摊着 —— 这一态存在的意义就是
       * 「写不进框里，至少让你手动搬得走」，静默失败等于把最后一条路也堵死。
       */
      api.copyOptimized = function () {
        const opt = store.opt;
        if (!opt || opt.kind !== 'paste') return;
        const text = String(opt.optimized || '');
        writeClipboard(text, function (ok, why) {
          pwBeacon('copy', ok ? 'ok' : ('fail:' + (why || '?')));
          commit({
            opt: {
              kind: 'paste',
              label: opt.label,
              optimized: text,
              until: Date.now() + (ok ? 4000 : 9000),
              note: ok ? '复制好了，粘到框里就行～' : '复制没成功，手动选中下面这段也行',
            },
          });
          if (api.startSpeech) api.startSpeech(ok ? '复制好了' : '复制没成，手动选中下面那段');
        });
      };

      /**
       * 只复制某一版，**不动文本框**（pick 每行右边那个「复制」）。
       *
       * 和「替换」分开：有时候框里那段还要留着对照，硬写进去就把原文顶掉了。
       * 复制完气泡原样留着（kind/until 都不改），你还能接着选别的版本。
       */
      api.copyVariant = function (variant) {
        const opt = store.opt;
        if (!opt || opt.kind !== 'pick' || !variant) return;
        const text = String(variant.optimized === null || variant.optimized === undefined ? '' : variant.optimized);
        writeClipboard(text, function (ok, why) {
          pwBeacon('copy-variant', (variant.key || '?') + (ok ? ' ok' : (' fail:' + (why || '?'))));
          if (api.startSpeech) {
            api.startSpeech(ok ? ('「' + (variant.label || '这版') + '」复制好了') : '复制没成，手动选中「看正文」里那段');
          }
        });
      };

      // ── 指针接线：全部转发给 pet-core，它自己判断命中与动作 ──────────────
      api.onPointerDown = function (event) {
        var ctl = api.ctl;
        if (!ctl || !event) return;
        if (event.button !== undefined && event.button !== 0) return;
        var hit = false;
        try {
          hit = ctl.pointerDown(localPoint(event));
        } catch (error) {
          hit = false;
        }
        if (hit) {
          // 记下按下点：松手时靠它区分「拖过来的」还是「点一下」
          api.press = { x: event.clientX, y: event.clientY, moved: false };
          try {
            if (event.currentTarget && event.currentTarget.setPointerCapture && event.pointerId !== undefined) {
              event.currentTarget.setPointerCapture(event.pointerId);
            }
          } catch (error) { /* 捕获失败不影响拖动 */ }
        }
        if (event.preventDefault) event.preventDefault();
      };

      api.onPointerUp = function (event) {
        var ctl = api.ctl;
        if (!ctl) return;
        var press = api.press;
        api.press = null;
        // 松手（含 pointercancel）：摘掉拖拽辉光，无论这次投没投递成功。
        if (store.near) commit({ near: false });
        // ── 投递判定：确实拖动过 + 松手点落在文本框上 → 就地放下 + 优化 ──────
        // 「就地放下」用的是 pet-core 自带的 `dropAt()`（官方注释：no throw），
        // 所以她不会被甩飞出去——原样保留 vendor，不改上游一行。
        if (press && press.moved && event && typeof event.clientX === 'number') {
          const box = findComposer();
          const zone = box ? dropZone(box) : null;
          // 投递判定 = 指针在框上 **或鲸鱼身体压在框上**。
          // 为什么必须看身体：拖拽时指针抓的是后颈（scruff），身体 pivot 挂在指针
          // 下方约 220*S——用户看到她压在输入框上松手时，指针其实还在框上方。
          // 只看指针会系统性 miss（2026-10-23 diag 三次 drop-miss 全是 box=DIV
          // inside=false pressing=true 这个形状），每次 miss 还会触发抛飞，
          // 落地又压框 → 回避逻辑把她往右赶 → 循环。
          const pointerInside = isDropInside({ x: event.clientX, y: event.clientY }, zone);
          const bodyInside = !!(lastPetRect && zone && rectsOverlap(lastPetRect, zone, 0));
          const inside = pointerInside || bodyInside;
          if (inside && typeof ctl.dropAt === 'function' && ctl.pressing) {
            try {
              // 落点：指针在框上就用指针（现有行为）；身体压住框而指针在框上方时，
              // 落在身体当前 scruff 高度（pet.dy）——她站在框边地上，而不是被扔回框上方。
              if (bodyInside && !pointerInside && ctl.pet) {
                const s = stageEl.getBoundingClientRect();
                const feetX = (lastPetRect.left + lastPetRect.right) / 2;
                const pet = ctl.pet;
                ctl.dropAt({
                  x: feetX - s.left,
                  y: typeof pet.dy === 'number' ? pet.dy : lastPetRect.bottom - s.top,
                });
              } else {
                ctl.dropAt(localPoint(event));
              }
              api.avoidUntil = Date.now() + 6000; // 站住别挡着你，先让开
              api.deliverToComposer(box);
            } catch (error) {
              try {
                ctl.pointerUp();
              } catch (error2) { /* 忽略 */ }
            }
            return;
          }
          // 拖了但没投递：**不能静默**。原来这里只记 diag，界面上一个字的提示都没有，
          // 于是只能靠猜（2026-10-12 连撞 5 次 drop-miss 还以为功能没触发）。
          pwBeacon('drop-miss', 'box=' + (box ? (box.tagName || '?') : 'null')
            + ' inside=' + (!!inside) + ' pointer=' + pointerInside + ' body=' + bodyInside
            + ' pressing=' + (!!ctl.pressing));
          if (api.startSpeech) {
            api.startSpeech(box
              ? '诶…没放准，再往输入框那儿拖近一点'
              : '诶…没找到能打字的地方，先点一下输入框');
          }
        }
        // 点一下（没拖动）= 戳她。**必须先记 wasHeld 再 pointerUp** —— pointerUp 会把
        // pressing 清掉，事后再读永远是 false，被拎起来那条分支就成了死代码。
        var wasHeld = !!ctl.pressing;
        try {
          ctl.pointerUp();
        } catch (error) { /* 忽略 */ }

        if (press && !press.moved && typeof ctl.gesture === 'function') {
          // 安静档不演"捂脸"这种大反应，只让她抬头看一眼；被拎起来时一律 brace
          var name = wasHeld ? 'brace' : (store.style === 'quiet' ? 'peek' : 'peekaboo');
          try {
            if (ctl.gesture(name)) {
              bumpAffinity(1);
              pwBeacon('poke', name);
            }
          } catch (error2) { /* 手势失败不该影响松手 */ }
        }
      };

      api.onPointerLeave = function () {
        var ctl = api.ctl;
        if (!ctl || ctl.pressing) return; // 拖动中不要标记"离开"
        try {
          ctl.pointerLeave();
        } catch (error) { /* 忽略 */ }
      };

      api.closeMenu = function () {
        if (store.menu) commit({ menu: null });
      };

      api.onContextMenuClose = function (event) {
        if (event && event.preventDefault) event.preventDefault();
        api.closeMenu();
      };

      api.onContextMenu = function (event) {
        if (!event) return;
        if (event.preventDefault) event.preventDefault();
        if (event.stopPropagation) event.stopPropagation();
        var menuW = 190;
        // 菜单高度只是用来把浮层**夹回屏幕内**的估算，所以宁可高估：低估会让最后几项
        // 跑到屏幕外点不到（这菜单是往右下角长的，右下角最容易被切掉）。
        var menuH = 400; // 10 项 + 亲密度头 + 两道分隔线
        commit({
          menu: {
            x: Math.round(Math.max(8, Math.min(event.clientX, window.innerWidth - menuW))),
            y: Math.round(Math.max(8, Math.min(event.clientY, window.innerHeight - menuH))),
          },
        });
      };

      /**
       * 「坐好」/「起来活动」的唯一入口（照 Minecraft 里那条 /sit 命令）。
       *
       * 定义在组件作用域而不是 useEffect 闭包里：菜单项在 effect 提前 return 时
       * （初始化失败 / 测试环境没有真实 DOM）也必须还能用，绝不能变成 undefined。
       *
       * 坐着的时候必须同时压住**三样**东西，只关漫游是不够的：
       *   1. pet-core 的自由漫游 → `setRoam('off')`，`decide()` 不再派活，
       *      且 `sit` / `sleep` 到期不会自己站起来（pet-core 里都判了 `free`）；
       *   2. 打字回避 → 每帧的 `avoidWhileTyping()` 会 `walkTo` 把你支开，
       *      那正好是「坐好」的反面，所以坐着时它整段短路；
       *   3. 自动台词 → 坐着还每隔一两分钟报价格太吵，改成偶尔冒一句闲话。
       */
      api.setSit = function (next) {
        var want = !!next;
        if (store.sit === want) return;
        commit({ sit: want });
        saveSit(safeStorage(), want);
        var ctl = api.ctl;
        if (!ctl) return;
        // 心情基准与档位无关，只要 pet-core 在就得同步一次。
        // （原来只在 setStyle / bumpAffinity 里同步，于是"刷新页面 + 你已经摸过她了"
        //   这条最常见的路径上，pet-core 的 mood 还是 0，尾巴要摸到下一次互动才摇起来。）
        if (typeof ctl.setMood === 'function') {
          var pets0 = store.pets || 0;
          ctl.setMood(Math.min(1, Math.log(1 + pets0) / Math.log(121)));
        }
        if (want) {
          // 就地坐下：先打断可能正在进行的拖拽/空中姿态，再落 sit
          ctl.act('sit');
          ctl.setRoam('off');
        } else {
          ctl.act('stand');
          ctl.setRoam('free');
          // 起来之后重新给她派活，不然她会一直 idle 到下次手动指令
          if (typeof ctl.holdRoam === 'function') ctl.holdRoam(0.1);
        }
        pwBeacon(want ? 'sit' : 'rise', 'sit=' + want);
      };

      api.menuAction = function (kind) {
        commit({ menu: null });
        var ctl = api.ctl;
        var lines = roamLines(new Date());
        if (kind === 'sit' || kind === 'rise') {
          // ★「坐好」是持续状态，不是动作：坐下 = roam 关掉 + sit 姿势 + 不许被打扰；
          //   起来 = roam 打开 + stand。走哪一步都要落到 saveSit，刷新页面她还在原地。
          api.setSit(kind === 'sit');
          if (api.startSpeech) api.startSpeech(pickOne(kind === 'sit' ? lines.sit : lines.rise));
        } else if (kind === 'action') {
          if (!ctl) return;
          ctl.holdRoam(5);
          ctl.act(pickOne(POSE_MOTIONS));
        } else if (kind === 'play') {
          // 「逗她玩」：从当前档位的候选池里随机抽一个手势。
          // 坐着也能演 —— 坐着不该等于"什么都不能做"。
          if (!ctl) return;
          ctl.holdRoam(5);
          api.playRandomGesture();
        } else if (kind === 'style') {
          // 三档活动强度循环切换。走 setStyle 是为了存本机 + 同步心情基准。
          var tiers = ['quiet', 'daily', 'lively'];
          var at = tiers.indexOf(store.style);
          api.setStyle(tiers[(at + 1) % tiers.length]);
        } else if (kind === 'pet') {
          if (!ctl) return;
          ctl.holdRoam(4);
          ctl.setExpr('love', 2.5);
          bumpAffinity(1);
        } else if (kind === 'heart') {
          // 撒爱心：让她站住看一眼（别被漫游抢走），头顶冒爱心，亲密度 +1。
          if (!ctl) return;
          ctl.holdRoam(3);
          if (typeof ctl.emitHeart === 'function') ctl.emitHeart();
          bumpAffinity(1);
        } else if (kind === 'expr') {
          // 换个表情：在表情池里循环取下一个（当前表情优先），保持 2 秒后自动回落。
          if (!ctl || typeof ctl.setExpr !== 'function') return;
          var exprPool = (PET && Array.isArray(PET.EXPRESSIONS)) ? PET.EXPRESSIONS
            : ['neutral', 'happy', 'wink', 'love', 'shy', 'surprised', 'angry', 'sad', 'sleepy', 'thinking'];
          var exprNow = 'neutral';
          try { exprNow = (ctl.pet && ctl.pet.expr) || 'neutral'; } catch (exprErr) { exprNow = 'neutral'; }
          var exprAt = exprPool.indexOf(exprNow);
          if (exprAt < 0) exprAt = 0;
          ctl.setExpr(exprPool[(exprAt + 1) % exprPool.length], 2);
        } else if (kind === 'care') {
          // 不谈 token、不谈钱，就问你一句。她是这个插件里唯一会这么说话的部分。
          if (!ctl) return;
          // love 表情 = 爱心眼，是现有表情里最贴"在乎你"的那个；v0.5.0 没有新表情。
          ctl.setExpr('love', 3);
          ctl.holdRoam(4);
          if (api.startSpeech) api.startSpeech(pickOne(lines.care));
        } else if (kind === 'roam') {
          if (!ctl) return;
          // 自由活动 = 明确解除「坐好」，两者是互斥的持续状态。
          if (store.sit) api.setSit(false);
          ctl.setRoam('free');
          if (api.startSpeech) api.startSpeech(pickOne(lines.greet));
        } else if (kind === 'home') {
          if (!ctl) return;
          // 坐好时"回家" = 走回家然后继续坐着，不是解除坐姿。
          // （用户点"回家"是想换地方，不是想让她重新开始乱跑。）
          ctl.holdRoam(3);
          ctl.walkTo(HOME_X, false);
          if (api.startSpeech && !store.sit) api.startSpeech('我回家啦');
        } else if (kind === 'optimize') {
          // 右键菜单「优化提示词」：不依赖拖拽检测，直接找输入框投递。
          // 这是「拖过去没反应」的可靠兜底——点一下菜单就优化。
          var box = findComposer();
          if (box) {
            pwBeacon('menu-optimize', 'box=' + (box.tagName || '?'));
            api.deliverToComposer(box);
          } else {
            pwBeacon('menu-optimize', 'no-composer');
            if (api.startSpeech) api.startSpeech('没找到能打字的地方，先点一下输入框');
          }
        } else if (kind === 'undo') {
          // ⚠️ v0.5.4：菜单里已没有这一项，也没有别的入口能发出 'undo'。
          //   分支与 api.undoOptimize 一起留着 —— 恢复对照/回退能力时接回去即可，
          //   而现在删掉它们等于把恢复成本从"接回去"抬到"重做一遍"。
          api.undoOptimize();
        }
      };

      react.useEffect(function () {
        var alive = true;
        var ctl = null;
        var figure = null;
        var raf = 0;
        var last = 0;
        var warned = false;
        var speech = null;
        var nextSpeechAt = 0;
        var unlockSfx = null;
        /**
         * 音效句柄。**必须**声明在 effect 这一层，不能留在异步 init 闭包里：
         * `driveReactions` 的呼噜与 `cueSound` 都在 effect 作用域，看不见 init 的局部变量。
         * 顺带这也保证了卸载后 sfx 仍可被读到（init 早退时它是 null，两处都有 `if (sfx)` 兜底）。
         */
        var sfx = null;
        var onResize = null;
        var stageEl = stageRef.current;
        var petEl = petRef.current;
        var shadowEl = shadowRef.current;
        var fxEl = fxRef.current;
        var hitEl = hitRef.current;
        var bubbleEl = bubbleRef.current;
        if (!stageEl || !petEl || !hitEl || !bubbleEl) return undefined;

        api.pointOf = function (event) {
          var rect = stageEl.getBoundingClientRect();
          return { x: event.clientX - rect.left, y: event.clientY - rect.top };
        };

        api.startSpeech = function (text) {
          if (!text) return;
          speech = { text: text, i: 0, nextAt: 0 };
        };

        // ── 打字回避：判定在模块级的 escapePlan 里（可单测），这里只负责驱动 ──
        /** 「正在打字」的截止时刻；最近打字的文本框存在 `api.composer`（组件体的投递逻辑也读它）。 */
        var typingUntil = 0;
        /** 每帧从 layout() 存下来的身体矩形，回避判定直接读它，不多做一次布局读取。 */
        var lastPetRect = null;
        /** 上一次下达的走位目标：目标没变就绝不重复 walkTo（否则步态会被重置成原地踏步）。 */
        var escape = { target: null };
        // ── 拖拽时的「靠近输入框」辉光反馈 ──────────────────────────────────
        /** 上一次查「离输入框多近」的时刻（节流用）。 */
        var nearCheckAt = 0;
        /**
         * 拖拽时判断她离输入框有多近：取她身体包围盒到**最近**输入框的最近边距离，
         * 小于 NEAR_COMPOSER_PX 就打开辉光 class —— 「再拖近一点就能投递」有了肉眼
         * 可见的反馈（原来只有松手后才知道够不够近）。
         *
         * 只用最近一次 layout() 存的身体矩形，不在拖拽中再读布局；只在真正拖动
         * （press.moved）时调用。松手由组件体的 onPointerUp 摘掉，卸载由 effect 的
         * 清理函数摘掉（两处都直接 commit near:false，effect 里的局部状态不跨作用域）。
         */
        function updateNearComposer(now) {
          // 拖拽时每帧都可能触发 pointermove，查 DOM 有成本：节流到 ~80ms 一次足够。
          // event.timeStamp 在老浏览器里可能从 0 开始，所以非正数一律退回 Date.now()。
          var t = typeof now === 'number' && isFinite(now) && now > 0 ? now : Date.now();
          if (t - nearCheckAt < 80) return;
          nearCheckAt = t;
          try {
            if (!lastPetRect) return;
            var nodes = (typeof document !== 'undefined' && document.querySelectorAll)
              ? document.querySelectorAll('textarea, input, [contenteditable]')
              : [];
            var best = Infinity;
            for (var i = 0; i < nodes.length; i += 1) {
              var el = nodes[i];
              if (!isEditable(el)) continue;
              var zone = dropZone(el);
              if (!zone) continue;
              var d = rectDistance(lastPetRect, zone);
              if (d < best) best = d;
            }
            var near = best < NEAR_COMPOSER_PX;
            if (near === store.near) return;
            commit({ near: near });
          } catch (error) {
            // 视觉反馈失败绝不能影响拖拽主流程。
          }
        }
        // ── 场景反应 / 待机 ──────────────────────────────────────────────
        /** 你最后一次有输入的时刻（键盘、鼠标、滚轮都算）。判定"你还在不在"用。 */
        var lastInputAt = Date.now();
        /** 场景反应状态机的上一次结果；纯状态，跨帧保留。 */
        var reactState = null;
        /** 优化刚跑完的那一刻，消费掉就置 0（只用一次）。 */
        var doneAt = 0;
        /** 下一轮"她想自己动一动"的时间戳（毫秒）。0 = 现在就想动。 */
        var nextIdleGestureAt = 0;
        /** 下一声呼噜的时间戳（毫秒）。0 = 还没排上。 */
        var nextPurrAt = 0;

        /** 任何输入都续上"你还在线"的窗口。 */
        function markInput() { lastInputAt = Date.now(); }

        /** 优化成功写入后由组件体调用：给"她该蹦一下"这件事一个确切时刻。 */
        api.markOptimizeDone = function () { doneAt = Date.now(); };
        // 组件体（摸头 / 逗她玩 / 换档）要放一次性音效，但 sfx 只活在 effect 里，
        // 所以这里挂一个转发口 —— 组件体不直接碰 sfx，避免闭包外的空引用。
        api.cueSound = cueSound;

        /**
         * 每帧驱动：场景反应（你回来/打字太久/久无动静）+ 待机小动作。
         *
         * 为什么要限流：她有自己的想法，但你的注意力比她的想法重要。
         * 所以这里有两道闸：动作**不打断**你正在做的事（optimize 气泡在位时不演），
         * 以及一个独立的"下一轮自己动"时钟，免得每隔几秒就跳一下。
         */
        function driveReactions(now) {
          if (!ctl) return;
          var tier = styleTier(store.style);
          // 坐好 = 你说了别动。坐着可以演小动作（她还是活的），但绝不能自己睡过去。
          var canAct = !store.opt && !store.busy;

          var plan = reactionStep(reactState, {
            now: now,
            inputAt: lastInputAt,
            sitting: store.sit,
            typing: typingActive(editableAncestor(typeof document !== 'undefined' ? document.activeElement : null), typingUntil, now),
            justDone: doneAt != null && (now - doneAt) < 1500,
            tier: tier,
          });
          reactState = plan.state || reactState;
          doneAt = 0;

          // 坐好过期：**不受 canAct 限制**。
          // 这是状态修正，不是表演 —— 就算你正开着优化气泡、她正忙着，
          // 10 分钟没人管就得起身；把它压在 canAct 里等于"忙着就一直坐着"，
          // 而"坐好"本来的承诺是"一直坐到起来活动"，不是"一直坐到下次优化结束"。
          if (plan.rise) {
            api.setSit(false);
            if (plan.say && api.startSpeech) api.startSpeech(pickOne(roamLines(new Date()).react.rise));
            return;
          }

          if (canAct) {
            if (plan.sleep) {
              ctl.act('sleep');
              if (api.startSpeech) api.startSpeech(pickOne(roamLines(new Date()).react.idle));
            } else if (plan.gesture && !store.sit) {
              if (ctl.gesture(plan.gesture)) {
                if (plan.say) api.startSpeech(pickOne(roamLines(new Date()).react[plan.say.split('.').pop()]));
              }
            }
          }

          // 待机小动作：她没事干的时候自己伸个懒腰、抖抖毛
          if (canAct && tier.idleGestures > 0 && !store.sit && (ctl.pet.mode === 'idle')) {
            if (!nextIdleGestureAt) nextIdleGestureAt = now + styleDelay(tier.idleMs, tier.tempo) * 1000;
            else if (now >= nextIdleGestureAt) {
              nextIdleGestureAt = 0;
              var pool = tier.motions.filter(function (m) { return m !== 'beg' && m !== 'swat' && m !== 'brace'; });
              var name = pickGesture(pool, null);
              if (name && ctl.gesture(name)) nextIdleGestureAt = now + styleDelay(tier.idleMs, tier.tempo) * 1000;
            }
          } else if (store.sit || !canAct) {
            nextIdleGestureAt = 0;
          }

          /**
           * 闲着的时候的零碎声音。
           *
           * 这些音效方法上游写好了却从来没被调用过（purr / sparkle / pop / select），
           * 所以是白捡的 —— 不用新增任何音频代码，只是把它们放对地方：
           *   purr    坐着且心情不错 → 呼噜（隔一阵一声，别连成一片）
           *   sparkle 心情明显涨上去 → 小星星
           *   pop     换档 / 升级这类"状态变了"的一瞬间
           *
           * 全都过 `sfx &&`，因为没有音频上下文的环境（测试、静音）里它是空的。
           */
          if (sfx && typeof sfx.purr === 'function') {
            if (!nextPurrAt) nextPurrAt = now + 9000;
            else if (now >= nextPurrAt) {
              nextPurrAt = now + 14000 + Math.random() * 14000;
              // 只有"她真的在那儿待着"才呼噜：被拎着 / 睡着 / 忙着都不该有
              var settled = ctl.pet && (ctl.pet.mode === 'sit' || ctl.pet.mode === 'idle');
              if (settled && (store.sit || now - lastInputAt > 6000)) {
                try { sfx.purr(); } catch (error) { /* 音效失败不该影响界面 */ }
              }
            }
          }
        }

        /** 心情涨上去 / 状态变化时的一次性音效（换档、升级、逗她玩成功）。 */
        function cueSound(kind) {
          if (!sfx) return;
          var fn = sfx[kind];
          if (typeof fn !== 'function') return;
          try { fn(); } catch (error) { /* 音效失败不该影响界面 */ }
        }

        /** 当前回避区：优先正在聚焦的文本框，其次最近打字的那个。 */
        function activeZone() {
          var focused = typeof document !== 'undefined' ? document.activeElement : null;
          return editableZone(editableAncestor(focused) || api.composer);
        }

        /**
         * 打字 / 失焦时给鲸鱼娘接上「竖耳听」状态（第二档 #8）。
         * pet-core 没这个能力时静默跳过 —— 接线失败绝不能影响打字回避主流程。
         */
        function setListening(on) {
          if (ctl && typeof ctl.setListening === 'function') {
            try { ctl.setListening(!!on); } catch (error) { /* 忽略 */ }
          }
        }

        /** 打字（含把焦点点进文本框）就续上回避窗口；只读事件，不 preventDefault。 */
        function onTyping(event) {
          markInput();
          var box = editableAncestor(event && event.target !== undefined ? event.target : null);
          if (box) api.composer = box;
          var focused = typeof document !== 'undefined' ? document.activeElement : null;
          if (box || editableAncestor(focused)) {
            typingUntil = Date.now() + TYPING_GRACE_MS;
            // 你正在输入框里：她竖耳听。
            setListening(true);
          }
        }

        /** 焦点离开文本框只再宽限一小会儿，别让她对着空框傻等三秒。 */
        function onFocusOut(event) {
          if (editableAncestor(event && event.target)) {
            typingUntil = Math.min(typingUntil, Date.now() + 600);
            // 你不在输入框了：竖耳听收掉。
            setListening(false);
          }
        }

        var canListen = typeof document !== 'undefined' && typeof document.addEventListener === 'function';
        if (canListen) {
          document.addEventListener('keydown', onTyping, true);
          document.addEventListener('input', onTyping, true);
          document.addEventListener('focusin', onTyping, true);
          document.addEventListener('focusout', onFocusOut, true);
        }

        /** 逐字揭示台词；每揭示一个字就调一次 ctl.talk()，她的嘴会跟着动。 */
        function speak(now) {
          if (!speech) {
            if (nextSpeechAt && now >= nextSpeechAt) {
              // 优化气泡 / 撤销对话框在位时不自动抢台词（两个气泡会叠一起）
              if (!store.opt) {
                var lines = roamLines(new Date());
                // 台词轮换。价格**不再是菜单里的一个按钮**（v0.5.3 去掉「说句价格」），
                // 而是并进待机池：她自己在待机时报一句，比你专门点一下要自然得多。
                // 坐着的时候少报一点价 —— 你让她安静待着，她还老报"谷时便宜一半"太吵。
                var pool = store.sit
                  ? (Math.random() < 0.18 ? lines.price : pickOne(lines.sitIdle))
                  : (Math.random() < 0.55 ? pickOne(lines.price) : pickOne(lines.idle));
                api.startSpeech(typeof pool === 'string' ? pool : pickOne(pool));
              }
              nextSpeechAt = now + SPEECH_MIN_MS + Math.random() * (SPEECH_MAX_MS - SPEECH_MIN_MS);
            }
            return;
          }
          if (now < speech.nextAt) return;
          if (speech.i < speech.text.length) {
            speech.i += 1;
            if (ctl) ctl.talk();
            bubbleEl.hidden = false;
            bubbleEl.textContent = speech.text.slice(0, speech.i);
            speech.nextAt = now + SPEECH_CHAR_MS;
          } else if (now > speech.nextAt + SPEECH_HOLD_MS) {
            bubbleEl.hidden = true;
            bubbleEl.textContent = '';
            speech = null;
          }
        }

        /** 命中区贴住她的身体；气泡钉在头顶。每帧直接改 DOM，不走 React 状态。 */
        function layout() {
          if (!ctl) return;
          var r = petEl.getBoundingClientRect();
          lastPetRect = r; // 打字回避的判定直接用这一份（同一帧的同一矩形）
          var s = stageEl.getBoundingClientRect();
          hitEl.style.left = (r.left - s.left) + 'px';
          hitEl.style.top = (r.top - s.top) + 'px';
          hitEl.style.width = Math.max(0, r.width) + 'px';
          hitEl.style.height = Math.max(0, r.height) + 'px';
          if (!bubbleEl.hidden) {
            var a = ctl.anchor();
            bubbleEl.style.left = a.x + 'px';
            // 优化气泡在位时，台词气泡往上挪一挪，两个别叠一起
            bubbleEl.style.top = (store.opt ? a.y - 56 : a.y) + 'px';
          }
          // 优化气泡钉在小鲸鱼头顶：拖着她跑的时候，气泡跟着她走
          if (optRef.current && store.opt) {
            var a2 = ctl.anchor();
            optRef.current.style.left = a2.x + 'px';
            optRef.current.style.top = a2.y + 'px';
          }
          // v0.5.4 起 store.undo 恒为 null（选版时不再留撤销态），所以"你改过提示词
          // 就自动收起撤销"这条规则已经没有触发场景，这里把调用点去掉，别留死分支。
          // shouldDismissUndo 本身仍在（纯函数、仍有测试），将来要恢复对照/回退时直接接回去。
          // 到期自动收起：失败说明（8 秒）与「无改动」提示（6 秒）。
          if (store.opt && store.opt.until && Date.now() > store.opt.until) {
            commit({ opt: null });
          }
        }

        /**
         * 你打字时（以及刚把她投递进文本框之后），她离开文本框区域 ——
         * 无论她此刻在屏幕哪个位置。
         *
         * 每帧三步：
         *   1. 期间持续 `holdRoam`：自由漫游（`decide()`）不会把她重新派回这里，
         *      她会让开后待在原地；
         *   2. 取回避区（聚焦的文本框，连它所在卡片的余量一起算）；
         *   3. **不挡路就什么都不做**；挡路才 `walkTo`，而且只在目标真的变了才下令
         *      —— 每帧重复 walkTo 会把步态重置成原地踏步，她反而走不动。
         *
         * 第二个触发条件 `api.avoidUntil` 来自投递：她被放进文本框时刚点了「让开」，
         * 那会儿你多半还没把焦点点回去，只看打字状态会让她就站在框上。
         */
        function avoidWhileTyping() {
          if (!ctl) return;
          // ★ 坐好 = 你明确说了「别动」。这时连打字回避都不许把她支走——
          //   否则你让她坐下、转头打字，她立刻自己跑开，那这个功能等于没做。
          if (store.sit) {
            escape.target = null;
            return;
          }
          var focused = typeof document !== 'undefined' ? document.activeElement : null;
          var now = Date.now();
          var active = typingActive(editableAncestor(focused), typingUntil, now)
            || now < (api.avoidUntil || 0);
          if (!active) {
            escape.target = null;
            return;
          }
          ctl.holdRoam(0.5);
          var target = escapePlan(lastPetRect, activeZone(), window.innerWidth, ctl.pet ? ctl.pet.x : null);
          if (target === null) {
            escape.target = null;
            return;
          }
          // ★ 已经在走（walk/run）且目标没大变：**别重新下令**。
          //   走姿会让 DOM 包围盒晃动（lean 旋转 + bob 缩放），每帧重算的目标
          //   抖动超过容差就会 walkTo 重置步态 —— 她原地踏步，看着"一直向右边
          //   走不动"。这条守卫让她稳稳走到位；到了之后（idle）再重算，
          //   如果还压着框就换个目标继续走。
          var isWalking = ctl.pet && (ctl.pet.mode === 'walk' || ctl.pet.mode === 'run');
          if (isWalking && escape.target !== null
            && Math.abs(target - escape.target) <= AVOID_TARGET_TOLERANCE * 2) {
            return;
          }
          if (escape.target !== null && Math.abs(target - escape.target) <= AVOID_TARGET_TOLERANCE) return;
          var center = lastPetRect ? (lastPetRect.left + lastPetRect.right) / 2 : target;
          // 远了就跑过去：走的 78px/s 太慢，你一句话打完她还没让开。
          if (ctl.walkTo(target, Math.abs(target - center) > AVOID_RUN_DISTANCE)) {
            escape.target = target;
          }
        }

        /**
         * 坐好期间每帧确认她还坐着。
         *
         * 为什么需要：她被拎起来/被抛出去再放下，走的是 `air → land → idle`
         * （pet-core 的 land() 不看 roam），落地就站起来了 —— 但 `store.sit` 还是 true，
         * 于是菜单上写着"坐好"、实际站着不再坐回去，出现"命令失效"。
         * 这里只在**落地静止**时补一次 `act('sit')`，不影响空中与行走的手感。
         */
        function keepSitting() {
          if (!ctl || !store.sit) return;
          var mode = ctl.pet && ctl.pet.mode;
          if (mode !== 'idle') return; // sit / sleep / wake / walk 都放行
          if (ctl.act('sit')) pwBeacon('sit-restore', 'mode=' + mode);
        }

        function loop(now) {
          raf = 0;
          if (!alive || !ctl) return;
          if (!last) last = now;
          var dt = Math.min(0.05, Math.max(0.001, (now - last) / 1000));
          last = now;
          try {
            ctl.step(dt);
            ctl.render();
            layout();
            avoidWhileTyping();
            keepSitting();
            driveReactions(now);
            speak(now);
          } catch (error) {
            if (!warned) {
              warned = true;
              console.warn('[peak-whale] 桌宠渲染循环出错（只报一次）:', error);
            }
          }
          raf = window.requestAnimationFrame(loop);
        }

        /**
         * 鼠标在页面上任何地方移动都要喂给 pet-core：
         * 她的视线会跟着光标转，而且拖动时（指针已被命中区捕获）也能持续拿到位置。
         * 只挂在命中区上会让"跟着鼠标看"只在碰到她时才生效。
         */
        function onPointerMove(event) {
          if (!ctl) return;
          markInput();
          // 拖动阈值与 pet-core 一致（>6px 才算 drag）：松手时靠它判断是不是「拖过来的」
          if (api.press && typeof event.clientX === 'number') {
            if (Math.abs(event.clientX - api.press.x) > 6 || Math.abs(event.clientY - api.press.y) > 6) {
              api.press.moved = true;
            }
            if (api.press.moved) updateNearComposer(event.timeStamp);
          }
          var cursor = '';
          try {
            cursor = ctl.pointerMove(api.pointOf(event)) || '';
          } catch (error) { /* 忽略 */ }
          if (hitEl) hitEl.style.cursor = cursor;
        }

        (async function init() {
          try {
            figure = await PET.createWhaleFigure('pet:///', {
              model: PET_MODEL,
              asset: function (p) {
                return PET_TEX[p];
              },
            });
            if (!alive) {
              if (figure && figure.dispose) figure.dispose();
              return;
            }
            sfx = PET.createSfx({ storageKey: SOUND_KEY });
            unlockSfx = function () {
              if (sfx && typeof sfx.unlock === 'function') sfx.unlock();
            };
            ctl = PET.createPet(
              { petG: petEl, shadowEl: shadowEl, fxG: fxEl },
              {
                sfx: sfx,
                figure: figure,
                roam: 'free',
                enter: 'drop',
                startX: HOME_X,
                bounds: function () {
                  var w = window.innerWidth;
                  var h = window.innerHeight;
                  return {
                    W: w,
                    H: h,
                    floorY: h - 26,
                    S: Math.min(PET_SCALE_MAX, 0.42 * Math.min(1.4, h / 420)),
                  };
                },
                onEvent: function (kind) {
                  // 一切发生在身体上的事（拎起 / 放下 / 抛出 / 戳 / 摸 / 摔晕）都算互动
                  if (kind === 'touch') bumpAffinity(1);
                  // 走到位了：清掉上一次的回避目标。下一帧如果还压着框
                  // （目标算错/被钳位），avoidWhileTyping 会重新算并再走一次；
                  // 不清的话她会一直被"已经在朝这个目标走"的守卫钉在原地。
                  if (kind === 'arrived') escape.target = null;
                },
              },
            );
            api.ctl = ctl;
            api.figure = figure;
            // 配色（第二档 #6）：优先用 Host 设置里存的，没有就回本机存档，再不行用默认。
            // 走 api.applyPalette 而不是直接 setSkin —— 只有那条路会同步改特效主色
            // （竖耳弧 / 思考气泡 / 睡 z），皮肤对象自己改是看不到效果的。
            api.applyPalette(uiSettings.palette || loadPalette(safeStorage()));
            // 活力度：手动存过就用用户拖的值，否则按亲密度换算（刷新页面后尾巴照样摇）。
            if (!whaleMood.manual) whaleMood.value = moodFromPets(store.pets || 0);
            // 心情基准在这里也同步一次（而不是只在互动/换档/坐好切换时）：
            // 那三条都是"状态变化"，而**刷新页面**不是变化 —— 不在这里补一次的话，
            // 「上次摸过她了、这次刚打开 DSH」会一直停在 mood=0，直到你再摸她一下。
            if (typeof ctl.setMood === 'function') {
              try { ctl.setMood(whaleMood.value); } catch (error) { /* 忽略 */ }
            }
            // 上次会话她是被"坐好"的：初始化就让她坐下，别先站两秒再自己坐。
            // 走的是 setSit 的同一条路径，只是绕过 store 比较（状态本来就是 true）。
            if (store.sit) {
              try {
                ctl.act('sit');
                ctl.setRoam('off');
              } catch (error) { /* 忽略 */ }
            }
            // 浏览器要求先有用户手势才允许出声；捕获阶段挂，任何点击都能解锁
            window.addEventListener('pointerdown', unlockSfx, true);
            window.addEventListener('keydown', unlockSfx, true);
            window.addEventListener('pointermove', onPointerMove, { passive: true });
            onResize = function () {
              try {
                if (ctl) ctl.resize();
              } catch (error) { /* 忽略 */ }
            };
            window.addEventListener('resize', onResize);
            nextSpeechAt = performance.now() + GREET_DELAY_MS;
            last = 0;
            if (typeof window.requestAnimationFrame === 'function') {
              raf = window.requestAnimationFrame(loop);
            }
            commit({ ready: true });
          } catch (error) {
            if (alive) {
              commit({ ready: false });
              console.warn('[peak-whale] 鲸鱼娘初始化失败（此环境可能没有 WebGL2 / Image）:', error);
            }
          }
        })();

        return function () {
          alive = false;
          api.ctl = null;
          api.startSpeech = null;
          // 卸载时把拖拽辉光摘掉，别让 class 留在已经消失的 DOM 上。
          if (store.near) commit({ near: false });
          if (raf && typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(raf);
          if (onResize) window.removeEventListener('resize', onResize);
          window.removeEventListener('pointermove', onPointerMove);
          if (canListen) {
            document.removeEventListener('keydown', onTyping, true);
            document.removeEventListener('input', onTyping, true);
            document.removeEventListener('focusin', onTyping, true);
            document.removeEventListener('focusout', onFocusOut, true);
          }
          if (unlockSfx) {
            window.removeEventListener('pointerdown', unlockSfx, true);
            window.removeEventListener('keydown', unlockSfx, true);
          }
          // setFigure(null) 会释放自定义 figure 持有的 WebGL 上下文。
          // Chromium 每页的上下文数量有上限（约 16 个），HMR 反复重载时泄漏会
          // 让画布整片变空白——所以卸载时必须显式释放。
          try {
            if (ctl) ctl.setFigure(null);
            else if (figure && figure.dispose) figure.dispose();
          } catch (error) { /* 忽略 */ }
        };
      }, []);

      // 右键菜单：点空白处关闭
      var menu = null;
      if (store.menu) {
        var item = function (kind, text) {
          return h(
            'button',
            {
              key: kind,
              type: 'button',
              onClick: function () {
                api.menuAction(kind);
              },
            },
            text,
          );
        };
        menu = h(
          'div',
          {
            className: 'pw-menu-backdrop',
            onClick: api.closeMenu,
            onContextMenu: api.onContextMenuClose,
          },
          h(
            'div',
            {
              className: 'pw-menu',
              role: 'menu',
              style: { left: store.menu.x + 'px', top: store.menu.y + 'px' },
              onClick: function (event) {
                if (event && event.stopPropagation) event.stopPropagation();
              },
            },
            h(
              'div',
              { className: 'pw-menu-note' },
              '亲密度 Lv.' + store.level + ' · 互动 ' + store.pets + ' 次',
            ),
            h('hr'),
            item('action', '换个姿势'),
            // 「逗她玩」走的是手势层（叠加在当前姿势之上），所以她坐着也能演。
            item('play', '逗她玩'),
            item('pet', '摸摸头'),
            item('heart', '撒爱心'),
            item('expr', '换个表情'),
            item('care', '陪我说句话'),
            item('home', '回家'),
            item('optimize', '优化提示词'),
            h('hr'),
            // ★「坐好」= 持续状态（照 Minecraft 里狗的 sit 命令）：坐下就一直不动，
            //   菜单这一项跟着状态翻转，所以永远显示"你点了会发生什么"。
            store.sit ? item('rise', '起来活动') : item('sit', '坐好'),
            // 活动强度档：显示当前档 + 点一下切到下一档，所以不用进设置页也能改。
            item('style', '活泼程度：' + styleTier(store.style).name),
            item('roam', '自由活动'),
            // ⚠️ v0.5.4：这里**不再有**「撤销提示词优化」。
            //   优化完直接给出改写后的正文，不呈现原稿、不再问你要不要回退。
            //   （api.undoOptimize 仍留着，只是不再有任何入口能触发它。）
          ),
        );
      }

      // ── 优化胶囊：贴在文本框上方，是这块浮层里唯一会自己挪窝的 UI ──────────
      // ── 优化气泡 / 撤销对话框：挂在小鲸鱼头顶，位置每帧由 rAF 钉着 ──────────
      // busy：「正在优化提示词中…」（无按钮）；
      // pick：三版三行，整行=替换、行内「复制」只复制、底部「还是不优化了吧」/「关闭」
      //       （对话框语义，不设消失时间，等你选）；
      // paste：写不进框时摊正文 + 复制 / 关闭；info：无改动说明（6 秒自收）；
      // error：原因 + 「知道了」（8 秒自收）。
      // 拖着她跑的时候，这个气泡跟她的头顶一起走（layout() 里每帧对齐 anchor）。
      var optEl = null;
      if (store.opt) {
        var optKind = store.opt.kind;
        optEl = h(
          'div',
          {
            className: 'pw-opt',
            'data-kind': optKind,
            ref: optRef,
            role: optKind === 'pick' ? 'dialog' : 'status',
            'aria-label': optKind === 'pick' ? '选择一版优化后的提示词' : store.opt.text,
            onClick: function (event) {
              // 气泡自己不吞点击语义，但别让它一路冒泡到浮层
              if (event && event.stopPropagation) event.stopPropagation();
            },
          },
          optKind === 'pick'
            ? [
              h('span', { key: 't', className: 'pw-opt-text' }, '优化好了，选哪一版？'),
              h(
                'div',
                { key: 'list', className: 'pw-opt-pick' },
                (store.opt.variants || []).map(function (v) {
                  // ★ 一行 = 一版，整行是「替换」（写回框里），右边那个是「只复制」。
                  //   点整行的语义就是替换 —— 这是最常用的动作，也是「点一下就用上」的直觉。
                  //   想留个对照组（框里原文先不丢）就走「复制」，别把两件事挤在一个按钮上。
                  const ms = formatThinking(v.ms);
                  return h(
                    'div',
                    { key: v.key, className: 'pw-opt-pick-row' },
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'pw-opt-pick-btn',
                        title: '把框里原文换成这一版' + (v.unchanged ? '（与原文相同）' : ''),
                        onClick: function () { api.pickVariant(v); },
                      },
                      h('span', { className: 'pw-opt-pick-label' }, v.label),
                      // ★ 字数 / 耗时注脚：抓没抓好、这版到底跑没跑上游，一眼看得见。
                      //   2026-10-12「抓取没抓好」之所以查不出来，就是因为界面上只有三个标签，
                      //   看不出回来的正文是空的、被截断的还是完整的。
                      h('span', { className: 'pw-opt-pick-len' }, String(v.optimized || '').length + ' 字'),
                      // 缓存命中那版没有 ms → 空串，不写「0.0s」（那是编数据）
                      ms ? h('span', { className: 'pw-opt-pick-ms' }, ms) : null,
                      (v.rounds && v.rounds > 1) ? h('span', { className: 'pw-opt-pick-note' }, '迭代 ' + v.rounds + ' 轮') : null,
                      v.unchanged ? h('span', { className: 'pw-opt-pick-note' }, '无改动') : null,
                      h('span', { className: 'pw-opt-pick-act' }, '替换'),
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'pw-opt-pick-copy',
                        title: '只复制这一版，不动框里原文',
                        onClick: function () { api.copyVariant(v); },
                      },
                      '复制',
                    ),
                  );
                }),
              ),
              // 底部动作：不优化（什么都不写）/ 关闭（同样什么都不写，只是收气泡）。
              // 两个都给：一个是"我决定不要"，一个是"我先关掉待会儿再说"，语气不同。
              h(
                'div',
                { key: 'acts', className: 'pw-opt-actions' },
                h(
                  'button',
                  { type: 'button', className: 'pw-opt-pick-skip', onClick: function () { api.pickVariant(null); } },
                  '还是不优化了吧',
                ),
                h(
                  'button',
                  { key: 'close', type: 'button', className: 'pw-opt-close', onClick: api.dismissOpt },
                  '关闭',
                ),
              ),
              // 看正文：被截断、被代码块包住、混进标题时，当场就能发现
              h(
                'details',
                { key: 'preview', className: 'pw-opt-preview' },
                h('summary', null, '看正文'),
                (store.opt.variants || []).map(function (v) {
                  return h(
                    'div',
                    { key: v.key, className: 'pw-opt-preview-item' },
                    h('div', { className: 'pw-opt-preview-label' }, v.label),
                    h('pre', { className: 'pw-opt-preview-body' }, String(v.optimized || '')),
                  );
                }),
              ),
            ]
            : optKind === 'paste'
            ? [
              h('span', { key: 't', className: 'pw-opt-text' },
                '唔…这个框不让我写进去，我把「' + (store.opt.label || '优化') + '」那版正文放这了，你复制一下'),
              h('pre', { key: 'body', className: 'pw-opt-paste-body' }, String(store.opt.optimized || '')),
              h(
                'div',
                { key: 'acts', className: 'pw-opt-actions' },
                // 复制成功/失败都要回话：note 是唯一的反馈位，静默失败等于把最后一条路堵死
                store.opt.note ? h('span', { className: 'pw-opt-paste-note' }, store.opt.note) : null,
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'pw-opt-copy',
                    onClick: function () { api.copyOptimized(); },
                  },
                  '复制',
                ),
                h(
                  'button',
                  { key: 'close', type: 'button', className: 'pw-opt-close', onClick: api.dismissOpt },
                  '关闭',
                ),
              ),
            ]
            : h('span', { className: 'pw-opt-text' }, store.opt.text),
          optKind === 'error'
            ? h('button', { key: 'close', type: 'button', className: 'pw-opt-close', onClick: api.dismissOpt }, '知道了')
            : null,
        );
      }

      // petVisible=false：整层隐身（visibility:hidden），但组件照常挂载、
      // rAF 循环照常跑 —— 关掉再打开无需重新初始化 WebGL/精灵。
      var petHidden = !!(uiSettings && uiSettings.petVisible === false);
      return h(
        'div',
        { className: 'pw-roam' + (petHidden ? ' is-hidden' : '') + (store.near ? ' is-near-composer' : ''), 'data-ready': store.ready ? '1' : '0' },
        h(
          'svg',
          { className: 'pw-stage', ref: stageRef, 'aria-hidden': 'true' },
          h('ellipse', { className: 'pw-shadow', ref: shadowRef }),
          // pet-core 会往这两个组里写 DOM（foreignObject 画布 / 特效），
          // 我们不渲染子节点，所以 React 不会去动它们。
          h('g', { className: 'pw-pet', ref: petRef }),
          h('g', { className: 'pw-fx', ref: fxRef }),
        ),
        h('div', {
          className: 'pw-hitbox',
          ref: hitRef,
          onPointerDown: api.onPointerDown,
          onPointerUp: api.onPointerUp,
          onPointerCancel: api.onPointerUp,
          onPointerLeave: api.onPointerLeave,
          onContextMenu: api.onContextMenu,
        }),
        h('div', { className: 'pw-bubble', ref: bubbleRef, hidden: true }),
        optEl,
        menu,
      );
    }

    // ============================================================================
    //  设置页（设置 → 插件 → 小鲸鱼）
    // ============================================================================
    /** 详情页模式的说明文案。 */
    /**
     * 「提示词风格」那一行（系统提示词底稿）。
     *
     * 选项全部来自 Host 回传的 `ui.promptStyles`；Host 没给（比如旧版 Host）就
     **整行不渲染** —— 显示一个空的单选组比不显示更糟，那会让人以为功能坏了。
     * 这里绝不内置风格名或"暂无更多风格"之类的占位说法：清单没定就是没定。
     */
    function promptStyleRow(ui, applyPatch) {
      var list = ui && Array.isArray(ui.promptStyles) ? ui.promptStyles : null;
      if (!list || list.length === 0) return null;
      var current = (ui && ui.promptStyle) || 'default';
      // 当前 id 不在清单里（Host 升级后换了清单）：认第一个，别静默显示成别的。
      if (!list.some(function (s) { return s.id === current; })) current = list[0].id;
      // applyPatch 由 PeakWhaleSettingsTab 传进来（它才有 publish/save + 报错提示）
  var apply = applyPatch || function () {};
      return h(
        'div',
        { className: 'pw-set-field' },
        h('span', { className: 'pw-set-label' }, '提示词风格'),
        h(
          'div',
          { className: 'pw-set-modes' },
          list.map(function (s) {
            var active = s.id === current;
            return h(
              'label',
              { key: s.id, className: 'pw-set-mode' + (active ? ' is-on' : '') },
              h('input', {
                type: 'radio',
                name: 'pw-prompt-style',
                checked: active,
                onChange: function () {
                  if (!active) apply({ promptStyle: s.id });
                },
              }),
              h('span', { className: 'pw-set-mode-name' }, s.name),
              s.note ? h('span', { className: 'pw-set-mode-note' }, s.note) : null,
            );
          }),
        ),
        h('p', { className: 'pw-dim' }, '风格是提示词的整份底稿；「更详细 / 更专业 / AI 自主」那三版仍各自照原样叠加在上面。换风格只换底稿，不改那三版的取向。'),
      );
    }

    var UI_MODES = [
      { id: 'detailed', name: '详细版', note: '完整价格表、时段规则与节假日说明。' },
      { id: 'concise', name: '简洁版', note: '只显示余额、今日费用与当前峰谷及持续时间。' },
    ];

    /**
     * 设置页 tab 组件。注册进 `settings.plugins.tab` 槽位，
     * 由内置的「插件」设置页渲染成「小鲸鱼」标签页。
     *
     * 契约要点（与 dsh-client-ui-settings-plugin-inventory 一致）：
     *   slots.inject("settings.plugins.tab", () => slots.register({ name, id, order, label }, 组件))
     * 数据走自己的 HTTP 设置路由；API key 只留在 Host，这里只看得到「是否已配置」。
     */
    function PeakWhaleSettingsTab() {
      var ui = useUiSettings();
      var savingState = react.useState(false);
      var setSaving = savingState[1];
      var errorState = react.useState('');
      var setError = errorState[1];
      var error = errorState[0];
      var mode = ui && ui.uiMode === 'detailed' ? 'detailed' : 'concise';
      // 活动强度档只存在本机（localStorage），不走 Host —— 它跟你换台机器、
      // 换个 profile 都无关，是这台机器上你跟她的相处方式。
      var styleState = react.useState(function () { return loadStyle(safeStorage()); });
      var style = styleState[0];
      var setStyle = styleState[1];
      // 配色（第二档 #6）：优先用 Host 设置里存的（跨设备同步），没有就回本机存档。
      var paletteState = react.useState(function () {
        return ui && ui.palette ? ui.palette : loadPalette(safeStorage());
      });
      var palette = paletteState[0];
      var setPalette = paletteState[1];
      // 亲密度与活力度是**桌宠侧**的状态（存在本机），设置页订阅它们的镜像。
      var whale = useWhaleAffinity();
      var mood = useWhaleMood();
      var progress = affinityProgress(whale.pets);

      /** 乐观更新 + 写回 Host；失败亮出来（下一轮 wallet 轮询会用 Host 的值纠正显示）。 */
      var applyPatch = function (patch) {
        setSaving(true);
        setError('');
        publishUiSettings(patch); // 界面立即生效
        saveUiSettings(patch).then(function (ok) {
          setSaving(false);
          if (!ok) setError('设置保存失败——Host 半身可能还是旧版，重启 DSH 或稍后重试。');
        });
      };

      /**
       * 换档。走 `api.setStyle` 而不是直接 commit —— 只有那条路会写本机、
       * 同步心情基准，并**立刻**让正在跑的那个鲸鱼娘知道新档位。
       */
      var changeStyle = function (id) {
        var api = exports.__whaleApi;
        if (api && typeof api.setStyle === 'function') api.setStyle(id);
        else { setStyle(id); saveStyle(safeStorage(), id); }
      };

      /**
       * 换配色。走 api.applyPalette 而不是直接 commit —— 那条路才会立刻改特效主色，
       * 并写回 pet-core 的皮肤对象。Host 设置用 applyPatch 存（跨设备同步）。
       */
      var changePalette = function (id) {
        var next = paletteById(id).id;
        if (next === palette) return;
        var api = exports.__whaleApi;
        if (api && typeof api.applyPalette === 'function') api.applyPalette(next);
        savePalette(safeStorage(), next);
        setPalette(next);
        applyPatch({ palette: next });
      };

      var modeBtn = function (item) {
        var active = mode === item.id;
        return h(
          'label',
          { key: item.id, className: 'pw-set-mode' + (active ? ' is-on' : '') },
          h('input', {
            type: 'radio',
            name: 'pw-ui-mode',
            checked: active,
            onChange: function () {
              if (!active) applyPatch({ uiMode: item.id });
            },
          }),
          h('span', { className: 'pw-set-mode-name' }, item.name),
          h('span', { className: 'pw-set-mode-note' }, item.note),
        );
      };

      return h(
        'div',
        { className: 'pw-settings' },
        h(
          'div',
          { className: 'pw-settings-head' },
          h('h3', null, '小鲸鱼（DeepSeek 峰谷计价）'),
          h('p', { className: 'pw-dim' }, '侧栏价格状态条 + 桌宠小鲸鱼娘。所有设置即时生效并保存在本机。'),
        ),

        h(
          'section',
          { className: 'pw-set-sec' },
          h('h4', null, '详情页模式'),
          h('div', { className: 'pw-set-modes' }, UI_MODES.map(modeBtn)),
        ),

        h(
          'section',
          { className: 'pw-set-sec' },
          h('h4', null, '提示词优化'),
          h(
            'label',
            { className: 'pw-set-switch' },
            h('input', {
              type: 'checkbox',
              checked: !!(ui && ui.optimizeEnabled),
              onChange: function (event) {
                applyPatch({ optimizeEnabled: event.target.checked === true });
              },
            }),
            '把鲸鱼娘拖到输入框上时，自动用你的 DeepSeek API key 优化提示词',
          ),
          ui && ui.apiKeyConfigured
            ? h('p', { className: 'pw-dim' }, 'API key：已配置 ✓（key 只存在本机，不会显示在页面里）')
            : h('p', { className: 'pw-dim' }, 'API key：还没配置——把 key 填进 ~/.dsh/peak-whale/settings.json 的 deepseekApiKey 后即可使用。'),
          promptStyleRow(ui, applyPatch),
        ),

        h(
          'section',
          { className: 'pw-set-sec' },
          h('h4', null, '小鲸鱼人偶'),
          h(
            'label',
            { className: 'pw-set-switch' },
            h('input', {
              type: 'checkbox',
              checked: !!(ui && ui.petVisible),
              onChange: function (event) {
                applyPatch({ petVisible: event.target.checked === true });
              },
            }),
            '显示小鲸鱼人偶（关掉后她不再出现，侧栏价格条不受影响）',
          ),
        ),

        h(
          'section',
          { className: 'pw-set-sec' },
          h('h4', null, '小鲸鱼的配色'),
          h(
            'div',
            { className: 'pw-set-field' },
            h('span', { className: 'pw-set-label' }, '配色'),
            h(
              'select',
              {
                className: 'pw-set-select',
                value: palette,
                onChange: function (event) { changePalette(event.target.value); },
              },
              WHALE_PALETTES.map(function (p) {
                return h('option', { key: p.id, value: p.id }, p.label);
              }),
            ),
          ),
          h('p', { className: 'pw-dim' }, '换配色会立刻改变她竖耳听、思考、睡觉时特效的主色。她的贴图本身不变（当前只打包了原版贴图），所以身体颜色不动。'),
        ),

        h(
          'section',
          { className: 'pw-set-sec' },
          h('h4', null, '小鲸鱼的动作'),
          h('div', { className: 'pw-set-modes' }, STYLE_TIERS.map(function (tier) {
            var active = style === tier.id;
            return h(
              'label',
              { key: tier.id, className: 'pw-set-mode' + (active ? ' is-on' : '') },
              h('input', {
                type: 'radio',
                name: 'pw-pet-style',
                checked: active,
                onChange: function () {
                  if (!active) changeStyle(tier.id);
                },
              }),
              h('span', { className: 'pw-set-mode-name' }, tier.name),
              h('span', { className: 'pw-set-mode-note' }, tier.note),
            );
          })),
          h('p', { className: 'pw-dim' }, '右键菜单里也有「活泼程度」，点一下切到下一档；「逗她玩」会从当前档的动作里随机抽一个。价格她自己待机时会顺口说一句，不用专门点。'),
        ),

        h(
          'section',
          { className: 'pw-set-sec' },
          h('h4', null, '小鲸鱼的心情'),
          h(
            'div',
            { className: 'pw-set-field' },
            h('span', { className: 'pw-set-label' }, '亲密度'),
            h(
              'span',
              { className: 'pw-set-value' },
              'Lv.' + progress.level + ' / ' + MAX_LEVEL
                + ' · 互动 ' + progress.pets + ' 次'
                + (progress.max
                  ? ' · 已满级'
                  : ' · 再互动 ' + progress.toNext + ' 次升级'),
            ),
          ),
          h(
            'div',
            { className: 'pw-set-field' },
            h('span', { className: 'pw-set-label' }, '活力度'),
            h('input', {
              type: 'range',
              min: 0,
              max: 100,
              step: 1,
              value: Math.round(mood.value * 100),
              className: 'pw-set-range',
              onChange: function (event) {
                applyWhaleMood((Number(event.target.value) || 0) / 100, true);
              },
            }),
            h('span', { className: 'pw-set-value' }, Math.round(mood.value * 100) + '%'),
          ),
          h(
            'label',
            { className: 'pw-set-switch' },
            h('input', {
              type: 'checkbox',
              checked: !!mood.manual,
              onChange: function (event) {
                var manual = event.target.checked === true;
                applyWhaleMood(manual ? mood.value : moodFromPets(whale.pets), manual);
              },
            }),
            '手动设定活力度（不勾则跟随亲密度自动变化）',
          ),
          h('p', { className: 'pw-dim' },
            '亲密度每 ' + PETS_PER_LEVEL + ' 次互动升一级，' + MAX_LEVEL + ' 级封顶；摸她、逗她、撒爱心都会涨。活力度默认由亲密度换算，你也可以拖滑块手动调——拖过之后就不再被亲密度覆盖。'),
        ),

        h(
          'section',
          { className: 'pw-set-sec' },
          h('h4', null, '帮助 / 使用说明'),
          h(
            'ul',
            { className: 'pw-set-help' },
            h('li', null, '侧栏底部：当前峰 / 谷时段与距切换倒计时；侧栏够宽时还显示「余额 · 今日费用」，点击展开详情。'),
            h('li', null, '详情浮层：顶部开关切换「简洁版 / 详细版」——简洁版只留余额、今日费用、当前档与持续时间。'),
            h('li', null, '小鲸鱼娘：点击、抚摸、拖动互动；右键菜单可换姿势、逗她玩、摸摸头、撒爱心、换表情、陪她说句话、回家。'),
            h('li', null, '「坐好」让她就地坐下并且不再自己乱跑，一直坐到「起来活动」；刷新页面她还是坐着的。电脑 10 分钟没人操作，她就自己起来活动了 —— 坐久了腿麻。'),
            h('li', null, '她会看情况自己动：你打字太久会趴下来看你，你离开一会儿她会伸懒腰，长时间没人理就自己打哈欠躺下。'),
            h('li', null, '摸得越多她越活跃（尾巴摇得更勤、待机动作更频繁）；这个亲密度是累计的，存在本机，设置页里能看等级与进度。活力度默认跟着亲密度走，也可以在设置页拖滑块手动调。'),
            h('li', null, '把鲸鱼娘拖到输入框上 = 优化提示词。靠近输入框时她身体会亮起主色辉光，提示再拖近一点就能投递；优化完成后她直接把改写后的正文写进框里，不再保留原文、也不再问你要不要回退（想对照请自己在别处留一份）。期间仍可拖动她，气泡会跟着走。'),
            h('li', null, '「提示词风格」是优化器用的整份底稿：换风格只换底稿，「更详细 / 更专业 / AI 自主」那三版的取向不变，也不会改变优化器要做什么。'),
            h('li', null, '「今日费用」是按官方牌价折算会话用量得出的估算，不含赠送抵扣，不是账单。'),
            h('li', null, '余额与登录态来自 DeepSeek 账户服务；查不到时详情页会写明原因。'),
          ),
        ),

        savingState[0] ? h('p', { className: 'pw-set-state' }, '保存中…') : null,
        error ? h('p', { className: 'pw-set-state pw-set-error' }, error) : null,
      );
    }

    // ============================================================================
    //  注册
    // ============================================================================
    /** 幂等：装样式的一步炸了会走直装兜底，重复调用不能插出第二份样式表。 */
    var stylesInstalled = false;
    function installStyles() {
      if (stylesInstalled) return function () {};
      stylesInstalled = true;
      var style = document.createElement('style');
      style.setAttribute('data-plugin', 'dsh-deepseek-peak-whale');
      style.textContent = CSS;
      document.head.appendChild(style);
      return function () {
        stylesInstalled = false;
        style.remove();
      };
    }

    var inject = ['slots'];

    /**
     * 把三个挂载点都注册上。`slots` 还没就绪就返回 false，交给 inject / 退避重试。
     * 拆出来是为了让「立即试 / inject 回调 / 迟到重试」三条路共用同一份注册代码。
     */
    function mountSlots(ctx) {
      var slots = ctx && typeof ctx.get === 'function' ? ctx.get('slots') : undefined;
      if (!slots && ctx) slots = ctx.slots;
      if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') {
        return false;
      }

      var label = function () {
        try {
          return periodAt(new Date()).isPeak ? '峰时（全价）' : '谷时（半价）';
        } catch (error) {
          return 'DeepSeek 峰谷计价';
        }
      };

      slots.inject(STRIP_SLOT, function () {
        return slots.register(
          { name: STRIP_SLOT, id: 'peak-whale', order: STRIP_ORDER, label: label },
          PeakWhaleStrip,
        );
      });

      slots.inject(ROAM_SLOT, function () {
        return slots.register(
          { name: ROAM_SLOT, id: 'peak-whale-critter', order: ROAM_ORDER, label: label },
          WhaleRoamer,
        );
      });

      // 设置页 tab：内置「插件」设置页会把我们渲染成「小鲸鱼」标签页。
      // 契约与 dsh-client-ui-settings-plugin-inventory 一致；label 用函数即可，
      // 不需要注册 locale（settings 外壳用 resolveSlotLabel 处理）。
      slots.inject('settings.plugins.tab', function () {
        return slots.register(
          { name: 'settings.plugins.tab', id: 'peak-whale', order: 60, label: function () { return '小鲸鱼'; } },
          PeakWhaleSettingsTab,
        );
      });

      pwBeacon('mounted', 'strip+roam+settings-tab 已注册');
      return true;
    }

    /**
     * 开机自启的关键一步。
     *
     * 老写法是「拿不到 slots 就 console.warn 然后 return」——看着安全，其实是**静默放弃**：
     * 客户端 `slots` 服务有时比本插件晚就绪，于是重启后小鲸鱼根本不出现，
     * 得去插件页把插件关掉再打开（重新挂载）才出来。真机上就是这么表现的。
     *
     * 现在三层保证：① 立即试一次；② `ctx.inject(['slots'], …)` 服务就绪才回调；
     * ③ 退避重试兜底（inject 不回调也能补上）。三条路共用 mounted 闸门，不会重复注册。
     */
    function apply(ctx) {
      clientCtx = ctx;
      try {
        /** 把当下的上下文能力写成一行短诊断（开机竞态排查全靠它）。 */
        var describe = function (target) {
          var t = target || {};
          var report = function (name) {
            try {
              return typeof t[name];
            } catch (error) {
              return 'throw';
            }
          };
          var slots = null;
          try {
            slots = typeof t.get === 'function' ? t.get('slots') : undefined;
            if (!slots) slots = t.slots;
          } catch (error) {
            slots = 'throw';
          }
          return 'get=' + report('get') + ' inject=' + report('inject') + ' effect=' + report('effect')
            + ' slots=' + (slots === 'throw' ? 'throw' : (slots ? (typeof slots.inject === 'function' && typeof slots.register === 'function' ? 'usable' : 'partial') : 'none'));
        };
        pwBeacon('apply-start', describe(ctx));

        // 记下 ctx：layout 改成「点击时按需解析」。
        // 老代码在 apply 里抓一次并缓存 —— 开机瞬间 layout 若还没注册，
        // `ctx.layout` 属性访问会抛，异常冒到外层 catch，三个挂载点**全都挂不上**。
        pluginCtx = ctx;

        // 以下两步都是「锦上添花」：各自 try，谁炸了都不许拦住挂载（见 pwStep 注释）。
        pwStep('styles', function () {
          if (ctx && typeof ctx.effect === 'function') {
            try {
              ctx.effect(installStyles, 'peak-whale: styles');
              return 'effect';
            } catch (error) {
              // effect 通道炸了就直装：样式装不上会让整个界面裸奔（无样式 = 不可用）
              pwBeacon('effect-threw', errText(error));
            }
          }
          installStyles();
          return 'direct';
        });
        pwBeacon('styles-done', 'installed=' + (stylesInstalled ? 'yes' : 'no'));

        // 探一次 layout 就绪度：这条打点是「开机时 layout 在不在」的直接证据。
        pwStep('layout-probe', function () {
          var probed = resolveLayout();
          pwBeacon('layout-probe', probed ? 'available' : 'missing');
          return probed;
        });

        var mounted = false;
        var tryMount = function (target) {
          if (mounted) return true;
          try {
            mounted = mountSlots(target || ctx) === true;
          } catch (error) {
            mounted = false;
            pwBeacon('mount-threw', (error && (error.message || error.name)) || String(error));
            if (typeof console !== 'undefined') console.warn('[peak-whale] 挂载失败:', error);
          }
          if (!mounted) pwBeacon('mount-failed', describe(target || ctx));
          return mounted;
        };

        if (tryMount(ctx)) return;

        if (ctx && typeof ctx.inject === 'function') {
          try {
            ctx.inject(['slots'], function (host) {
              pwBeacon('inject-callback', describe(host && host.slots ? host : ctx));
              tryMount(host && host.slots ? host : ctx);
            });
          } catch (error) {
            pwBeacon('inject-threw', (error && error.message) || String(error));
            if (typeof console !== 'undefined') console.warn('[peak-whale] inject([slots]) 不可用:', error);
          }
        }

        var delays = [120, 400, 1200, 3000, 8000, 20000];
        var step = 0;
        var retry = function () {
          if (tryMount(ctx) || step >= delays.length) return;
          var delay = delays[step];
          step += 1;
          pwBeacon('retry-scheduled', 'delay=' + delay + ' step=' + step);
          var setFn = ctx && typeof ctx.setTimeout === 'function'
            ? ctx.setTimeout
            : (typeof setTimeout === 'function' ? setTimeout : null);
          if (typeof setFn === 'function') {
            try {
              setFn(retry, delay);
            } catch { /* 没有定时器就到此为止 */ }
          } else {
            pwBeacon('no-timer', 'ctx.setTimeout 与全局 setTimeout 都不可用');
          }
        };
        retry();
      } catch (error) {
        // 这行打点是关键：apply 抛异常时，老版本只 console.warn，
        // Host 侧只看到「有 apply-start、没有 mounted」，查不出是哪一步炸的。
        pwBeacon('apply-threw', errText(error));
        if (typeof console !== 'undefined') {
          console.warn('[peak-whale] 客户端插件注册失败:', error);
        }
      }
    }

    exports.apply = apply;
    exports.inject = inject;
    // 供测试与二次开发使用（bundles 只读 apply/inject）
    exports.PeakWhaleStrip = PeakWhaleStrip;
    exports.WhaleRoamer = WhaleRoamer;
    exports.PeakWhaleSettingsTab = PeakWhaleSettingsTab;
    exports.details = details;
    exports.roamLines = roamLines;
    // 设置页（模式 / 开关）
    exports.SETTINGS_ROUTE = SETTINGS_ROUTE;
    exports.getUiSettings = function () {
      return uiSettingsState;
    };
    exports.publishUiSettings = publishUiSettings;
    exports.saveUiSettings = saveUiSettings;
    exports.UI_MODES = UI_MODES;
    // 账户钱包（余额 + 当日费用）
    exports.walletItems = walletItems;
    exports.walletSummary = walletSummary;
    exports.walletDetails = walletDetails;
    exports.setWalletState = publishWallet;
    exports.getWalletState = function () {
      return walletState;
    };
    exports.refreshWallet = refreshWallet;
    exports.subscribeWallet = subscribeWallet;
    exports.walletUrl = walletUrl;
    exports.WALLET_ROUTE = WALLET_ROUTE;
    exports.WALLET_POLL_MS = WALLET_POLL_MS;
    exports.periodAt = periodAt;
    exports.summary = summary;
    exports.describePeriod = describePeriod;
    exports.holidayAt = holidayAt;
    exports.affinityLevel = affinityLevel;
    // 亲密度进度 / 活力度（纯函数与模块级镜像，设置页与测试共用）
    exports.affinityProgress = affinityProgress;
    exports.moodFromPets = moodFromPets;
    exports.loadWhaleMood = loadWhaleMood;
    exports.saveWhaleMood = saveWhaleMood;
    exports.getWhaleMood = getWhaleMood;
    exports.applyWhaleMood = applyWhaleMood;
    exports.getWhaleAffinity = getWhaleAffinity;
    exports.subscribeWhaleAffinity = subscribeWhaleAffinity;
    exports.subscribeWhaleMood = subscribeWhaleMood;
    exports.useWhaleAffinity = useWhaleAffinity;
    exports.useWhaleMood = useWhaleMood;
    exports.MOOD_KEY = MOOD_KEY;
    exports.NEAR_COMPOSER_PX = NEAR_COMPOSER_PX;
    // 拖拽辉光用的矩形距离（纯函数）
    exports.rectDistance = rectDistance;
    // 「设置」按钮：面板跳转（测试可注入假 layout 服务）
    exports.openPluginsSettings = openPluginsSettings;
    exports.setLayoutService = function (next) {
      layoutOverride = next && typeof next.selectPanel === 'function' ? next : null;
    };
    // 打字回避（纯判定，供测试与二次开发）
    exports.isEditable = isEditable;
    exports.editableAncestor = editableAncestor;
    exports.editableZone = editableZone;
    exports.rectsOverlap = rectsOverlap;
    exports.escapeTargetX = escapeTargetX;
    exports.escapePlan = escapePlan;
    exports.typingActive = typingActive;
    // 提示词优化（拖投递 / 写回 / 选版的纯逻辑）
    exports.readComposer = readComposer;
    exports.writeComposer = writeComposer;
    exports.dropZone = dropZone;
    exports.pointInRect = pointInRect;
    exports.isDropInside = isDropInside;
    exports.shouldDismissUndo = shouldDismissUndo;
    exports.optimizePrompt = optimizePrompt;
    exports.sessionRoute = sessionRoute;
    exports.usageNote = usageNote;
    exports.formatThinking = formatThinking;
    exports.thinkingNote = thinkingNote;
    exports.OPTIMIZE_ROUTE = OPTIMIZE_ROUTE;
    exports.DROP_PAD = DROP_PAD;
    exports.DROP_SLACK_Y = DROP_SLACK_Y;
    exports.UNDO_GRACE_MS = UNDO_GRACE_MS;
    exports.AVOID_MARGIN_X = AVOID_MARGIN_X;
    exports.AVOID_CLEARANCE = AVOID_CLEARANCE;
    exports.TYPING_GRACE_MS = TYPING_GRACE_MS;
    exports.loadAffinity = loadAffinity;
    exports.saveAffinity = saveAffinity;
    exports.loadSit = loadSit;
    exports.saveSit = saveSit;
    exports.STYLE_TIERS = STYLE_TIERS;
    exports.STYLE_KEY = STYLE_KEY;
    exports.styleTier = styleTier;
    exports.loadStyle = loadStyle;
    exports.saveStyle = saveStyle;
    // 配色（第二档 #6：多配色切换）
    exports.WHALE_PALETTES = WHALE_PALETTES;
    exports.PALETTE_KEY = PALETTE_KEY;
    exports.paletteById = paletteById;
    exports.paletteAccent = paletteAccent;
    exports.loadPalette = loadPalette;
    exports.savePalette = savePalette;
    exports.styleDelay = styleDelay;
    exports.pickGesture = pickGesture;
    exports.reactionStep = reactionStep;
    exports.REACT = REACT;
    exports.safeStorage = safeStorage;
    exports.AFFINITY_KEY = AFFINITY_KEY;
    exports.SIT_KEY = SIT_KEY;
    exports.SOUND_KEY = SOUND_KEY;
    exports.POSE_MOTIONS = POSE_MOTIONS;
    exports.HOME_X = HOME_X;
    exports.PET = PET;
    exports.PET_MODEL = PET_MODEL;
    exports.PET_TEX = PET_TEX;
    exports.WHALE_ICON_URI = WHALE_ICON_URI;
    exports.CSS = CSS;
    exports.MODELS = MODELS;
    exports.HOLIDAYS = HOLIDAYS;
    return module.exports;
  },
});
