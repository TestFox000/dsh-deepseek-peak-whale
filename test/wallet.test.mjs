/**
 * 账户钱包测试：余额 + 当日费用这条链路的每一环。
 *
 * 为什么要专门测「记账语义」：它必须与 DSH 内置的 `tokenUsage` 投影
 * **同口径**（同 (turn, step) 的重复样本不改账、重试叠加、替换按 delta 调整），
 * 否则界面里的「今日费用」和 Harness 自己那颗用量甜甜圈会各说各话。
 * 这里用一份独立写出来的参照实现逐事件比对 —— 两边算不出同一个总数就红。
 *
 * 其余覆盖：非 DeepSeek 路由不入账、持久化能读回来、坏账本不抛、
 * 余额归一化、报告文案、以及 apply() 的整条接线（命令 / 路由 / 记账监听）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DIAG_ROUTE,
  OPTIMIZE_ROUTE,
  OPTIMIZE3_ROUTE,
  SETTINGS_ROUTE,
  WALLET_ROUTE,
  WALLET_EXPORT_ROUTE,
  accountClientMetadata,
  apply,
  buildBalanceReport,
  buildWalletPayload,
  clearDiagEntries,
  createAccountReader,
  createDiagHandler,
  createOptimizeHandler,
  createOptimize3Handler,
  createSettingsHandler,
  createWalletHandler,
  diagEntries,
  ledgerFile,
  normalizeBalance,
  name,
} from '../index.js';
import { readUiSettings, writeUiSettings } from '../src/optimize.js';
import {
  KEEP_DAYS,
  LEDGER_VERSION,
  applyEvent,
  createLedger,
  daySnapshot,
  emptyState,
  emptyTokens,
  normalizeState,
  pruneDays,
  usageFromStream,
} from '../src/wallet.js';
import { createOfficialTracker, emptyOfficialState, daySpend } from '../src/official.js';
import { beijingDateKey } from '../src/peak.js';
import { MODELS, costCny, formatCny, formatCnyAmount, formatMoney, formatTokens, resolveModel } from '../src/peak.js';

// ── 1. 模型解析与计价 ────────────────────────────────────────────────────────
assert.equal(resolveModel('deepseek', 'deepseek-v4-pro')?.id, 'deepseek-v4-pro', 'pro 归 V4-Pro');
assert.equal(resolveModel('deepseek', 'deepseek-chat')?.id, 'deepseek-flash', '其余 DeepSeek 型号归 Flash');
assert.equal(resolveModel('deepseek-provider', 'deepseek-reasoner')?.id, 'deepseek-flash', '拿不准的回落到 Flash');
assert.equal(resolveModel('openai', 'gpt-5'), null, '非 DeepSeek 路由不计价');
assert.equal(resolveModel('', ''), null, '空路由不计价');

{
  const buckets = { uncachedInputTokens: 1e6, outputTokens: 1e6, cacheReadTokens: 1e6, cacheWriteTokens: 0 };
  const route = { provider: 'deepseek', model: 'deepseek-chat' };
  // 2026-10-09 是周五、国庆假期已过 → 峰时；2026-10-03 在国庆假期内 → 谷时
  // Flash 峰时牌价（元/百万 tokens）：命中 0.04 + 未命中 2 + 输出 8 = 10.04
  const peak = costCny(buckets, route, new Date('2026-10-09T02:00:00Z'));
  const off = costCny(buckets, route, new Date('2026-10-03T02:00:00Z'));
  assert.ok(Math.abs(peak - 10.04) < 1e-12, `峰时合计应为 10.04 元，实得 ${peak}`);
  assert.ok(Math.abs(off * 2 - peak) < 1e-12, '谷时必须恰为峰时的一半');
  assert.equal(costCny(buckets, { provider: 'openai', model: 'gpt-5' }, Date.now()), null, '别的厂商不进 DeepSeek 的账');
  assert.equal(costCny({}, route, Date.now()), 0, '空桶计价为 0');
  assert.equal(costCny({ uncachedInputTokens: -5 }, route, Date.now()), 0, '负数按 0 处理，不产生负账');
}

// ── 1b. 官方人民币牌价必须逐格对上（改价时这一节就是台账）─────────────────────
{
  const flash = MODELS.find((m) => m.id === 'deepseek-flash');
  const pro = MODELS.find((m) => m.id === 'deepseek-v4-pro');
  // 官方中文定价页（元 / 百万 tokens）：命中 / 未命中 / 输出，谷 · 峰
  assert.deepEqual(
    { hit: flash.cacheHit, miss: flash.cacheMiss, out: flash.output },
    { hit: { off: 0.02, peak: 0.04 }, miss: { off: 1, peak: 2 }, out: { off: 4, peak: 8 } },
    'Flash 牌价应与官方中文页一致',
  );
  assert.deepEqual(
    { hit: pro.cacheHit, miss: pro.cacheMiss, out: pro.output },
    { hit: { off: 0.15, peak: 0.3 }, miss: { off: 4.5, peak: 9 }, out: { off: 13.5, peak: 27 } },
    'V4-Pro 牌价应与官方中文页一致',
  );
  // 人民币不是美元按汇率换算出来的：官方中英两页的隐含汇率并不相等
  // （0.02/0.003 = 6.67，0.15/0.022 = 6.82），所以这里钉住「用的是中文页原值」，
  // 防止有人又改回「美元价 × 某个猜的汇率」。
  assert.ok(Math.abs(flash.cacheMiss.off - 1) < 1e-12, 'Flash 未命中谷时价就是 1 元，不是 $0.15 × 汇率');
}

// ── 2. 金额与 token 的显示格式 ──────────────────────────────────────────────
assert.equal(formatMoney('12.3456', 'USD'), '$12.35', '余额接口给什么币种就显示什么币种');
assert.equal(formatMoney('0.0037', 'USD'), '$0.0037', '小于 1 的余额要保留 4 位，不能被四舍五入成 0');
assert.equal(formatMoney('8.5', 'CNY'), '¥8.50');
assert.equal(formatMoney('240.98267744', 'CNY'), '¥240.98', '人民币余额取 2 位');
assert.equal(formatMoney('不是数'), '$—');
// 当日费用（人民币）：档位按日常量级给，末尾多余的 0 掐掉但至少留 2 位
assert.equal(formatCnyAmount(0), '¥0.00');
assert.equal(formatCnyAmount(4.694929), '¥4.69');
assert.equal(formatCnyAmount(1), '¥1.00');
assert.equal(formatCnyAmount(0.042), '¥0.042', '花了几分钱时也要看得见数字');
assert.equal(formatCnyAmount(0.0042), '¥0.0042');
assert.equal(formatCnyAmount(0.5), '¥0.50', '钱至少留 2 位，不写成 ¥0.5');
assert.equal(formatCnyAmount('不是数'), '¥—');
// 价格表格：固定位数，同一列小数点对齐（不做掐零美化）
assert.equal(formatCny(0.02), '¥0.020', '缓存命中最低档不能被舍成 0');
assert.equal(formatCny(0.04), '¥0.040');
assert.equal(formatCny(0.15), '¥0.150');
assert.equal(formatCny(0.3), '¥0.300');
assert.equal(formatCny(1), '¥1.00');
assert.equal(formatCny(4.5), '¥4.50');
assert.equal(formatCny(13.5), '¥13.50');
assert.equal(formatCny(27), '¥27.00');
assert.equal(formatCny(null), '—');
assert.equal(formatCny('不是数'), '—');
assert.equal(formatTokens(0), '0');
assert.equal(formatTokens(950), '950');
assert.equal(formatTokens(12400), '12.4k');
assert.equal(formatTokens(1280000), '1.28M');

// ── 3. usage 样本解析 ───────────────────────────────────────────────────────
{
  assert.equal(usageFromStream(null), null, '没有流就没有样本');
  assert.equal(usageFromStream([{}, { type: 'text', text: 'hi' }]), null, '流里没有 usage 就是 null');
  const fromTyped = usageFromStream([
    { type: 'text', text: 'a' },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 3 } },
    { type: 'text', text: 'b' },
  ]);
  assert.deepEqual(fromTyped, { uncachedInputTokens: 10, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 0 });
  // 倒着找：最后一个 usage 才算数
  const lastWins = usageFromStream([
    { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
    { type: 'usage', usage: { inputTokens: 7, outputTokens: 7 } },
  ]);
  assert.equal(lastWins.uncachedInputTokens, 7, '应取最后一个 usage 样本');
  // 兜底形状：分片本身长得像 usage
  assert.equal(usageFromStream([{ inputTokens: 5, outputTokens: 1 }]).uncachedInputTokens, 5);
  assert.equal(usageFromStream([{ type: 'usage' }]), null, '缺 input/output 的 usage 不算数');
}

// ── 4. 记账语义与 DSH 投影同口径 ────────────────────────────────────────────

const usage = (input, output) => ({ inputTokens: input, outputTokens: output });
const header = (seq, provider, model, time) => ({
  type: 'request/header',
  seq,
  time,
  data: { header: { config: { provider, model } } },
});
const message = (seq, turn, step, sample, time) => ({
  type: 'assistant/message',
  seq,
  time,
  data: { turn, step, usage: sample, message: { id: `m${seq}`, role: 'assistant', source: { provider: 'deepseek', model: 'deepseek-v4-pro' } } },
});
const attempt = (seq, turn, step, sample, time) => ({
  type: 'assistant/attempt',
  seq,
  time,
  data: { turn, step, stream: [{ type: 'usage', usage: sample }] },
});
const retryStarted = (seq, turn, step, time) => ({ type: 'llm/retry-started', seq, time, data: { turn, step } });

/** 参照实现：照抄 DSH `tokenUsage` 投影的折算规则（故意另写一份，用来比对）。 */
function referenceProjection(events) {
  const zeros = emptyTokens();
  let totals = { ...zeros };
  let last = null;
  const fromUsage = (sample) => ({
    uncachedInputTokens: sample.inputTokens,
    outputTokens: sample.outputTokens,
    cacheReadTokens: sample.cacheReadTokens ?? 0,
    cacheWriteTokens: sample.cacheWriteTokens ?? 0,
  });
  const same = (a, b) => a.uncachedInputTokens === b.uncachedInputTokens
    && a.outputTokens === b.outputTokens
    && a.cacheReadTokens === b.cacheReadTokens
    && a.cacheWriteTokens === b.cacheWriteTokens;
  for (const event of events) {
    if (event.type === 'llm/retry-started') {
      if (last && last.turn === event.data.turn && last.step === event.data.step) last = null;
      continue;
    }
    if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') continue;
    const sample = event.type === 'assistant/message' ? (event.data.usage ?? null) : event.data.stream[0].usage;
    if (!sample) continue;
    const buckets = fromUsage(sample);
    const previous = last && last.turn === event.data.turn && last.step === event.data.step ? last.buckets : null;
    if (previous && same(previous, buckets)) continue;
    totals = {
      uncachedInputTokens: totals.uncachedInputTokens - (previous?.uncachedInputTokens ?? 0) + buckets.uncachedInputTokens,
      outputTokens: totals.outputTokens - (previous?.outputTokens ?? 0) + buckets.outputTokens,
      cacheReadTokens: totals.cacheReadTokens - (previous?.cacheReadTokens ?? 0) + buckets.cacheReadTokens,
      cacheWriteTokens: totals.cacheWriteTokens - (previous?.cacheWriteTokens ?? 0) + buckets.cacheWriteTokens,
    };
    last = { turn: event.data.turn, step: event.data.step, buckets };
  }
  return totals;
}

{
  const at = Date.parse('2026-10-09T02:30:00Z'); // 峰时
  const events = [
    header(1, 'deepseek', 'deepseek-v4-pro', at),
    attempt(2, 1, 0, usage(1000, 100), at),
    message(3, 1, 0, usage(1200, 150), at), // 同 turn/step 的替换：按 delta 调整
    retryStarted(4, 1, 0, at), // 与投影一致：清掉上一个样本 → 下一次叠加
    message(5, 1, 0, usage(800, 90), at),
    header(6, 'deepseek', 'deepseek-v4-pro', at),
    message(7, 2, 0, usage(50, 10), at),
    { type: 'user/message', seq: 8, time: at, data: { id: 'u1', role: 'user', content: [] } },
  ];
  const state = emptyState();
  const routes = new Map();
  let changed = 0;
  for (const event of events) if (applyEvent(state, routes, 'sess-1', event)) changed += 1;

  const expected = referenceProjection(events);
  const day = daySnapshot(state, at);
  assert.deepEqual(day.tokens, expected, '账本 token 总数必须与 tokenUsage 投影逐桶一致');
  assert.equal(day.tokens.uncachedInputTokens, 2050, '替换 + 叠加的期望值应为 2050');
  assert.equal(day.requests, 4, '4 次计费样本（attempt/message/重试后 message/第二步）');
  assert.ok(changed >= 4);

  // 同一秒、同一模型 → 总花费应等于「总桶 × 单价」
  const wantCny = costCny(expected, { provider: 'deepseek', model: 'deepseek-v4-pro' }, at);
  assert.ok(Math.abs(day.cny - wantCny) < 1e-9, `今日费用应为 ${wantCny}，实得 ${day.cny}`);

  // 重复投递同一条事件：不改账
  const before = JSON.stringify(state.days);
  assert.equal(applyEvent(state, routes, 'sess-1', message(7, 2, 0, usage(50, 10), at)), false, '重复样本不应改账');
  assert.equal(JSON.stringify(state.days), before);
}

// 非 DeepSeek 路由：整条被跳过
{
  const at = Date.parse('2026-10-09T02:30:00Z');
  const state = emptyState();
  const routes = new Map();
  applyEvent(state, routes, 'sess-openai', header(1, 'openai', 'gpt-5', at));
  const changed = applyEvent(state, routes, 'sess-openai', {
    type: 'assistant/message',
    seq: 2,
    time: at,
    data: { turn: 0, step: 0, usage: usage(1e6, 1e6), message: { id: 'm', role: 'assistant', source: { provider: 'openai', model: 'gpt-5' } } },
  });
  assert.equal(changed, false, '别的厂商不入账');
  assert.equal(daySnapshot(state, at).cny, 0);
  assert.equal(daySnapshot(state, at).requests, 0);
}

// 没有路由的 attempt：跳过；拿到 header 之后才认
{
  const at = Date.parse('2026-10-09T02:30:00Z');
  const state = emptyState();
  const routes = new Map();
  assert.equal(applyEvent(state, routes, 's', attempt(1, 0, 0, usage(10, 10), at)), false, '没有路由先不记');
  applyEvent(state, routes, 's', header(2, 'deepseek', 'deepseek-v4-pro', at));
  assert.equal(applyEvent(state, routes, 's', attempt(3, 0, 0, usage(10, 10), at)), true, '有路由后记上');
  assert.equal(daySnapshot(state, at).requests, 1);
}

// 事件缺字段 / 类型不认识：一律安静跳过
{
  const state = emptyState();
  const routes = new Map();
  for (const junk of [null, undefined, {}, { type: 42 }, { type: 'assistant/message' }, { type: 'assistant/message', data: null }]) {
    assert.doesNotThrow(() => applyEvent(state, routes, 's', junk), `坏事件不应抛：${JSON.stringify(junk)}`);
  }
  assert.equal(applyEvent(state, routes, '', { type: 'assistant/message', data: {} }), false, '空会话 id 不记账');
}

// ── 5. 日账快照与裁剪 ───────────────────────────────────────────────────────
{
  const empty = daySnapshot(emptyState(), Date.parse('2026-10-03T12:00:00Z'));
  assert.equal(empty.date, '2026-10-03', '日键按北京时间算');
  assert.equal(empty.cny, 0);
  assert.equal(empty.requests, 0);
  assert.equal(empty.isPeak, false, '国庆假期是谷时');

  const state = emptyState();
  for (let i = 1; i <= KEEP_DAYS + 5; i += 1) {
    state.days[`2026-01-${String(i).padStart(2, '0')}`] = { cny: i, requests: 1, tokens: emptyTokens() };
  }
  assert.equal(pruneDays(state), true, '超量应裁剪');
  assert.equal(Object.keys(state.days).length, KEEP_DAYS, `只留 ${KEEP_DAYS} 天`);
  assert.equal(pruneDays(state), false, '没超量时不动');

  assert.deepEqual(normalizeState({ version: 999 }), emptyState(), '版本不对就重建');
  assert.deepEqual(normalizeState('坏数据'), emptyState(), '非对象入参给空账本');
  // v1（美元）账本必须被丢弃：那套数是倒推汇率算出来的，与人民币牌价不是同一个数，
  // 沿用会把错数当对账继续累加。这正是 LEDGER_VERSION 升到 2 的原因。
  assert.deepEqual(
    normalizeState({ version: 1, days: { '2026-10-03': { usd: 8.5, requests: 2 } } }),
    emptyState(),
    'v1 美元账本整份丢弃（版本闸门）',
  );
  const restored = normalizeState({ version: LEDGER_VERSION, days: { '2026-10-03': { cny: '不是数', requests: 2 } } });
  assert.equal(restored.days['2026-10-03'].cny, 0, '坏字段按 0 兜底');
  assert.equal(restored.days['2026-10-03'].requests, 2);
}

// ── 6. 账本持久化 ───────────────────────────────────────────────────────────
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peak-whale-'));
  const file = path.join(dir, 'wallet.test.json');
  const at = Date.parse('2026-10-09T02:30:00Z');

  const ledger = createLedger({ file });
  const routesSeen = [];
  assert.equal(typeof ledger.observe, 'function');
  ledger.observe('s1', header(1, 'deepseek', 'deepseek-v4-pro', at));
  ledger.observe('s1', message(2, 0, 0, usage(1e6, 1e6), at));
  assert.equal(ledger.snapshot(at).cny > 0, true, '记账后当日有费用');
  routesSeen.push(ledger.snapshot(at).date);
  ledger.flush();

  assert.ok(fs.existsSync(file), 'flush 应把账本写到磁盘');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(raw.version, LEDGER_VERSION, '落盘要带版本号');
  assert.equal(raw.version, 2, 'v2 = 人民币账本');
  assert.ok(raw.days[routesSeen[0]].cny > 0);
  assert.equal(raw.days[routesSeen[0]].usd, undefined, '落盘不能再有旧的 usd 字段');

  // 重新打开：今日费用还在（重启 DSH 不会把当天账清零）
  const reopened = createLedger({ file });
  assert.equal(reopened.snapshot(at).cny, ledger.snapshot(at).cny, '重开账本要读回当日费用');

  // 坏账本：留备份、给空账，不抛
  fs.writeFileSync(file, '{ 这不是 JSON');
  const broken = createLedger({ file });
  assert.equal(broken.snapshot(at).cny, 0, '坏账本回落到空账');
  assert.equal(fs.readdirSync(dir).some((n) => n.includes('.corrupt-')), true, '损坏文件应留一份备份');
  broken.dispose();

  // 没给文件 → 纯内存账本
  const memory = createLedger({});
  memory.observe('s1', message(2, 0, 0, usage(10, 10), at));
  assert.equal(memory.snapshot(at).requests, 1);
  memory.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── 7. 账户侧：客户端身份与余额归一化 ──────────────────────────────────────
{
  const meta = accountClientMetadata();
  assert.equal(meta.locale, 'zh-CN', '没给语言就用默认值');
  assert.equal(meta.timezoneOffsetSeconds, -new Date().getTimezoneOffset() * 60, '东为正的秒数');
  assert.equal(typeof meta.version, 'string');
  assert.notEqual(meta.version, '', 'version 不能为空');
  assert.equal(accountClientMetadata('  ').locale, 'zh-CN', '空白语言回落默认值');
  assert.equal(accountClientMetadata('en-US').locale, 'en-US');
}

{
  assert.deepEqual(normalizeBalance(null), { status: 'unknown' });
  assert.deepEqual(normalizeBalance({ status: 'failed' }), { status: 'failed' });
  assert.deepEqual(normalizeBalance({ status: 'ready', value: [] }), { status: 'ready', wallets: [], bonus: [] });
  const ready = normalizeBalance({
    status: 'ready',
    value: [{ currency: 'USD', balance: '12.3456' }],
    bonusWallets: [{ currency: 'CNY', balance: '3.00' }],
  });
  assert.equal(ready.wallets[0].balance, '12.3456', '十进制字符串原样保留，不能先转数字丢精度');
  assert.equal(ready.bonus[0].currency, 'CNY');
}

// ── 8. 余额读取器：缓存、登出不打余额、服务缺席 ────────────────────────────
{
  let balanceCalls = 0;
  let stateCalls = 0;
  let clock = 1000;
  const account = {
    async getState() {
      stateCalls += 1;
      return { status: 'credential-stored', links: { topUpUrl: 'https://x/top_up', usageUrl: 'https://x/usage' } };
    },
    async getBalance() {
      balanceCalls += 1;
      return { status: 'ready', value: [{ currency: 'USD', balance: '1.5' }], bonusWallets: [] };
    },
  };
  const reader = createAccountReader(account, { ttl: 45000, now: () => clock });
  const first = await reader('zh-CN');
  const second = await reader('zh-CN');
  assert.equal(first.balance.status, 'ready');
  assert.equal(second, first, 'TTL 内第二次读要命中缓存（同一个对象）');
  assert.equal(stateCalls, 1);
  assert.equal(balanceCalls, 1);

  clock += 46000;
  await reader('zh-CN');
  assert.equal(balanceCalls, 2, '过期后重新查余额');

  // 登出：只问状态，不打余额接口
  let signedOutBalanceCalls = 0;
  const signedOut = createAccountReader(
    { async getState() { return { status: 'signed-out', links: { topUpUrl: 'u', usageUrl: 'v' } }; }, async getBalance() { signedOutBalanceCalls += 1; return null; } },
    { ttl: 0, now: () => 0 },
  );
  const out = await signedOut();
  assert.equal(out.state.status, 'signed-out');
  assert.equal(signedOutBalanceCalls, 0, '未登录不查余额');

  // 余额接口抛错：不影响状态返回
  const flaky = createAccountReader(
    { async getState() { return { status: 'credential-stored', links: {} }; }, async getBalance() { throw new Error('网络'); } },
    { ttl: 0, now: () => 0 },
  );
  assert.equal((await flaky()).balance, null, '查询失败返回 null，而不是把插件搞崩');

  // 服务缺席
  const missing = createAccountReader(undefined);
  assert.equal((await missing()).unavailable, true, '没有账户服务要如实上报 unavailable');

  // ── 服务**迟到**（2026-10-06 线上回归）──────────────────────────────────
  // 症状：自启修好之后余额**永久消失**。原因是老写法在挂载那一刻把
  // 「此刻还没有 deepseekAccount」当成了「永远没有账户服务」。
  let late = null;
  const lateReader = createAccountReader(() => late, { ttl: 45000, now: () => clock });
  const beforeArrival = await lateReader('zh-CN');
  assert.equal(beforeArrival.unavailable, true, '服务还没到：如实上报 unavailable');
  assert.equal(beforeArrival.state, null);
  assert.equal(beforeArrival.balance, null);
  // 关键：unavailable **不能进缓存** —— 服务一到，同一次 TTL 窗口内就得恢复
  late = account;
  const afterArrival = await lateReader('zh-CN');
  assert.equal(afterArrival.unavailable, false, '服务到位后必须立刻自行恢复（unavailable 不进缓存）');
  assert.equal(afterArrival.state.status, 'credential-stored');
  assert.equal(afterArrival.balance.status, 'ready');

  // 端到端：载荷里的账户状态也要跟着恢复（界面看到的就是它）
  const latePayload = await buildWalletPayload({ reader: lateReader, ledger: null, locale: 'zh-CN', profile: 'desktop' });
  assert.equal(latePayload.account.status, 'credential-stored', '载荷的 account.status 必须不再是 unavailable');
  assert.equal(latePayload.balance.wallets[0].balance, '1.5');

  // 反例（就是踩过的坑）：传**服务本体**时，服务迟到 → 永久不可用。
  let serviceObject = null;
  const latched = createAccountReader(serviceObject, { ttl: 0, now: () => clock });
  assert.equal((await latched()).unavailable, true);
  serviceObject = account;
  assert.equal((await latched()).unavailable, true, '传本体＝老写法：服务迟到就永久失效（线上症状）');

  // 解析函数自己抛错：退化成 unavailable，绝不把路由带崩
  const brokenResolver = createAccountReader(() => { throw new Error('容器已销毁'); });
  const brokenResult = await brokenResolver();
  assert.equal(brokenResult.unavailable, true, '解析函数抛错要退化成 unavailable');
  assert.equal(brokenResult.balance, null);
}

// ── 9. 载荷与报告 ───────────────────────────────────────────────────────────
const fakePayloadReader = async (locale) => ({
  state: { status: 'credential-stored', links: { topUpUrl: 'https://x/top_up', usageUrl: 'https://x/usage' } },
  balance: { status: 'ready', value: [{ currency: 'USD', balance: '12.3456' }], bonusWallets: [{ currency: 'USD', balance: '1.0000' }] },
  unavailable: false,
  locale,
});

{
  const ledger = { snapshot: () => ({ date: '2026-10-03', cny: 0.123456, requests: 3, tokens: { uncachedInputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 }, isPeak: false }) };
  const payload = await buildWalletPayload({ reader: fakePayloadReader, ledger, locale: 'zh-CN', profile: 'desktop' });
  assert.equal(payload.ok, true);
  assert.equal(payload.account.status, 'credential-stored');
  assert.equal(payload.account.topUpUrl, 'https://x/top_up');
  assert.equal(payload.balance.wallets[0].balance, '12.3456');
  // 今日消费现在是官方口径：没传 official 跟踪器 → 空快照（当天日期、0 消费、available=false）
  assert.equal(payload.today.date, beijingDateKey(new Date()), 'today 用北京时间当天');
  assert.equal(payload.today.cny, 0, '没有官方采样时今日消费为 0');
  assert.equal(payload.today.available, false, '没采样不算 available');
  assert.equal(payload.note, 'official-balance-delta', '界面据此标官方口径');
  // 本地牌价估算降级到 session（只作参考，不占金额位）
  assert.equal(payload.session.date, '2026-10-03');
  assert.equal(payload.session.estimateCny, 0.123456);
  assert.equal(payload.session.requests, 3);
  assert.equal(payload.profile, 'desktop');

  const text = buildBalanceReport(payload);
  assert.ok(text.includes('余额：'), '报告要有余额段');
  assert.ok(text.includes('$12.35'), '余额要按接口给的币种格式化');
  assert.ok(text.includes('赠送 $1.00'), '赠送钱包单独列');
  assert.ok(text.includes('今日消费'), '报告要有当日消费段');
  assert.ok(text.includes('暂无采样'), '没有官方采样要照实说，不编 0');
  assert.ok(text.includes('¥0.123'), `本地估算仍出现在 session 段：${text}`);
  assert.ok(text.includes('不是账单'), '必须声明这不是账单');
  assert.ok(text.includes('https://x/top_up'), '带充值链接');

  // 传了 official 跟踪器 → 今日消费 = 官方余额的下降量累计
  const official = createOfficialTracker({});
  const cnyReader = async (locale) => ({
    state: { status: 'credential-stored', links: {} },
    balance: { status: 'ready', value: [{ currency: 'CNY', balance: '250.49' }], bonusWallets: [] },
    unavailable: false, locale,
  });
  await buildWalletPayload({ reader: cnyReader, official, locale: 'zh-CN' });
  const cnyReader2 = async (locale) => ({
    state: { status: 'credential-stored', links: {} },
    balance: { status: 'ready', value: [{ currency: 'CNY', balance: '238.15' }], bonusWallets: [] },
    unavailable: false, locale,
  });
  const payload2 = await buildWalletPayload({ reader: cnyReader2, official, locale: 'zh-CN' });
  assert.equal(payload2.today.available, true, '有采样就算 available');
  assert.ok(Math.abs(payload2.today.cny - 12.34) < 1e-6, `余额 250.49→238.15 应消费 12.34，实得 ${payload2.today.cny}`);
  assert.equal(payload2.today.samples, 2, '两次读数两次采样');
  assert.equal(payload2.today.topUps, 0, '余额只降不升，没有充值');

  // 余额上升算充值、不算消费
  const cnyReader3 = async (locale) => ({
    state: { status: 'credential-stored', links: {} },
    balance: { status: 'ready', value: [{ currency: 'CNY', balance: '300.00' }], bonusWallets: [] },
    unavailable: false, locale,
  });
  const payload3 = await buildWalletPayload({ reader: cnyReader3, official, locale: 'zh-CN' });
  assert.equal(payload3.today.cny, 12.34, '充值不改变已记的消费');
  assert.ok(Math.abs(payload3.today.topUps - 61.85) < 1e-6, `余额 238.15→300 应记充值 61.85，实得 ${payload3.today.topUps}`);

  // 未登录
  const signedOut = await buildWalletPayload({
    reader: async () => ({ state: { status: 'signed-out', links: { topUpUrl: 'u', usageUrl: 'v' } }, balance: null, unavailable: false }),
    ledger,
  });
  assert.equal(signedOut.account.status, 'signed-out');
  assert.equal(signedOut.balance.status, 'unknown');
  const signedOutText = buildBalanceReport(signedOut);
  assert.ok(signedOutText.includes('未登录'), '未登录要说人话');

  // 服务缺席
  const unavailable = await buildWalletPayload({ reader: null, ledger: null });
  assert.equal(unavailable.account.status, 'unavailable');
  assert.equal(unavailable.today.cny, 0, '没有账本也要给出当日结构');
}

// ── 10. HTTP 路由处理器 ─────────────────────────────────────────────────────
function fakeResponse() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers ?? {};
    },
    end(chunk) {
      if (typeof chunk === 'string') this.body += chunk;
    },
  };
}

{
  const ledger = { snapshot: () => ({ date: '2026-10-03', cny: 0.5, requests: 1, tokens: emptyTokens(), isPeak: true }) };
  const handler = createWalletHandler({ reader: fakePayloadReader, ledger, profile: 'desktop' });

  const res = fakeResponse();
  await handler({ method: 'GET', url: `${WALLET_ROUTE}?locale=zh-CN` }, res);
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'], /application\/json/);
  assert.equal(res.headers['cache-control'], 'no-store', '余额不许被缓存');
  const payload = JSON.parse(res.body);
  assert.equal(payload.ok, true);
  assert.equal(payload.today.cny, 0, '没传 official 跟踪器 → 今日消费为 0');
  assert.equal(payload.session.estimateCny, 0.5, '本地估算在 session 段');
  assert.equal(payload.profile, 'desktop');

  const bad = fakeResponse();
  await handler({ method: 'POST', url: WALLET_ROUTE }, bad);
  assert.equal(bad.statusCode, 405, '只读路由要拒绝写方法');

  // 语言要能从查询串带过来
  let seenLocale;
  const localeHandler = createWalletHandler({
    reader: async (locale) => { seenLocale = locale; return { state: null, balance: null, unavailable: true }; },
    ledger: null,
    profile: 'default',
  });
  await localeHandler({ method: 'GET', url: `${WALLET_ROUTE}?locale=ja-JP` }, fakeResponse());
  assert.equal(seenLocale, 'ja-JP');

  // reader 抛错 → 降级成 unavailable，仍然是 200（fail-soft：界面不该转圈）
  const boom = createWalletHandler({ reader: async () => { throw new Error('炸了'); }, ledger: null, profile: 'default' });
  const boomRes = fakeResponse();
  await boom({ method: 'GET', url: WALLET_ROUTE }, boomRes);
  assert.equal(boomRes.statusCode, 200, '读取失败要降级，不要把错误丢给界面');
  const boomPayload = JSON.parse(boomRes.body);
  assert.equal(boomPayload.ok, true);
  assert.equal(boomPayload.account.status, 'unavailable');

  // 载荷序列化不了 → 最后一道防线给 500，而不是发出半个 200
  // 现在 session 是投影后的扁平对象，要触发不可序列化得让 official 快照自带环引用。
  const circular = {};
  circular.self = circular;
  const unserializable = createWalletHandler({
    reader: fakePayloadReader,
    ledger: null,
    official: { record() { return false; }, snapshot() { return circular; } },
    profile: 'default',
  });
  const unsRes = fakeResponse();
  await unserializable({ method: 'GET', url: WALLET_ROUTE }, unsRes);
  assert.equal(unsRes.statusCode, 500, '序列化失败要能改口 500');
  assert.equal(JSON.parse(unsRes.body).ok, false);
}

// ── 11. apply() 的整条接线 ──────────────────────────────────────────────────
function makeContext(services = {}) {
  const commands = new Map();
  const routes = new Map();
  const listeners = new Map();
  const logs = [];
  /** 排队的重试回调（apply 里的「服务没就绪」退避重试用 ctx.setTimeout 挂） */
  const timers = [];
  const ctx = {
    logger: {
      info: (m) => logs.push(['info', m]),
      warn: (m) => logs.push(['warn', m]),
      error: (m) => logs.push(['error', m]),
    },
    get(key) {
      return services[key];
    },
    on(event, listener) {
      listeners.set(event, listener);
      return () => listeners.delete(event);
    },
    effect(factory) {
      return typeof factory === 'function' ? factory() : undefined;
    },
    setTimeout(fn) {
      timers.push(fn);
      return timers.length;
    },
    clearTimeout() {},
    commands: {
      register(definition) {
        commands.set(definition.name, definition);
        return () => commands.delete(definition.name);
      },
    },
  };
  return { ctx, commands, routes, listeners, logs, timers };
}

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peak-whale-apply-'));
  const file = path.join(dir, 'wallet.json');
  // 路由按「现在」快照，所以事件也要落在今天这一格（用真实时间，测试才不挑日期）
  const at = Date.now();
  let balanceCalls = 0;

  const routes = new Map();
  const services = {
    commands: undefined, // 走 ctx.commands 这条老路
    webServer: {
      register(route) {
        assert.equal(route.kind, 'exact');
        assert.ok(
          route.path === WALLET_ROUTE || route.path === OPTIMIZE_ROUTE || route.path === SETTINGS_ROUTE,
          `注册了一条不认识的路由：${route.path}`,
        );
        assert.equal(typeof route.handler, 'function', '路由必须有 handler');
        routes.set(route.path, route);
        return () => routes.delete(route.path);
      },
    },
    deepseekAccount: {
      async getState() {
        return { status: 'credential-stored', links: { topUpUrl: 'https://x/top_up', usageUrl: 'https://x/usage' } };
      },
      async getBalance() {
        balanceCalls += 1;
        return { status: 'ready', value: [{ currency: 'USD', balance: '9.99' }], bonusWallets: [] };
      },
    },
    profileContext: { name: 'desktop' },
  };
  const fake = makeContext(services);

  // settingsFile 也指到临时目录：测试绝不能碰真实的 key，也不能真去打上游
  apply(fake.ctx, { ledgerFile: file, settingsFile: path.join(dir, 'settings.json') });
  assert.equal(name, 'peak-whale');

  const registered = [...fake.commands.keys()].sort();
  assert.deepEqual(registered, ['balance', 'price'], '应注册 /price 与 /balance');
  assert.equal(typeof fake.commands.get('price').handler, 'function');
  const priceText = fake.commands.get('price').handler().text;
  assert.ok(priceText.includes('峰谷计价'), '/price 报告仍在');
  assert.ok(priceText.includes('/balance'), '/price 里应提示余额命令');

  assert.ok(routes.has(WALLET_ROUTE), 'wallet 路由应已注册');
  assert.equal(typeof fake.listeners.get('session/event'), 'function', '应监听 session/event 记账');

  // ── 提示词优化路由：没配 key 时要给人一句能照做的话，而不是一个状态码 ────
  assert.ok(routes.has(OPTIMIZE_ROUTE), 'optimize 路由应已注册');
  {
    const post = fakeResponse();
    await routes.get(OPTIMIZE_ROUTE).handler(
      { method: 'POST', url: OPTIMIZE_ROUTE, [Symbol.asyncIterator]: async function* () { yield JSON.stringify({ text: '帮我写个脚本' }); } },
      post,
    );
    assert.equal(post.statusCode, 200, '业务失败也要 200（原因要给人看）');
    const payload = JSON.parse(post.body);
    assert.equal(payload.ok, false);
    assert.equal(payload.error, 'no-api-key', '临时 settings 里没有 key，应报 no-api-key');
    assert.ok(payload.message.includes('settings.json'), `提示里要给出配置文件：${payload.message}`);
    assert.ok(payload.message.includes('deepseekApiKey'), `提示里要给出字段名：${payload.message}`);

    const get = fakeResponse();
    await routes.get(OPTIMIZE_ROUTE).handler({ method: 'GET', url: OPTIMIZE_ROUTE }, get);
    assert.equal(get.statusCode, 405, '只接受 POST');

    const empty = fakeResponse();
    await routes.get(OPTIMIZE_ROUTE).handler(
      { method: 'POST', url: OPTIMIZE_ROUTE, [Symbol.asyncIterator]: async function* () { yield '{"text":""}'; } },
      empty,
    );
    assert.equal(JSON.parse(empty.body).error, 'empty', '空文本要单独一个错误码');

    const badJson = fakeResponse();
    await routes.get(OPTIMIZE_ROUTE).handler(
      { method: 'POST', url: OPTIMIZE_ROUTE, [Symbol.asyncIterator]: async function* () { yield '这不是 JSON'; } },
      badJson,
    );
    assert.equal(JSON.parse(badJson.body).error, 'empty', '坏 JSON 按空文本处理，不抛');
  }

  // 一路事件 → 账本 → 路由响应
  const handler = routes.get(WALLET_ROUTE).handler;
  const before = fakeResponse();
  await handler({ method: 'GET', url: WALLET_ROUTE }, before);
  const beforePayload = JSON.parse(before.body);
  assert.equal(beforePayload.ok, true);
  assert.equal(beforePayload.session.requests, 0, '还没产生用量');
  assert.equal(beforePayload.balance.status, 'ready');

  const emit = fake.listeners.get('session/event');
  emit({ id: 'sess-1' }, header(1, 'deepseek', 'deepseek-v4-pro', at));
  emit({ id: 'sess-1' }, message(2, 0, 0, usage(1e6, 1e6), at));

  const after = fakeResponse();
  await handler({ method: 'GET', url: WALLET_ROUTE }, after);
  const afterPayload = JSON.parse(after.body);
  assert.equal(afterPayload.session.requests, 1, '会话事件要进账（session 段）');
  assert.equal(afterPayload.session.estimateCny > 0, true, '本地估算今日费用不应为 0');
  assert.ok(balanceCalls >= 1, '余额应查过');

  // 坏会话 / 坏事件不许把插件搞崩
  assert.doesNotThrow(() => emit(null, message(3, 0, 0, usage(1, 1), at)));
  assert.doesNotThrow(() => emit({ id: 'sess-1' }, null));
  assert.doesNotThrow(() => emit({ id: 'sess-1' }, { type: 'assistant/message', data: '坏的' }));

  // /balance 命令是异步的，返回纯文本
  const balanceResult = await fake.commands.get('balance').handler();
  assert.equal(balanceResult.kind, 'success');
  assert.ok(balanceResult.text.includes('今日消费'), '/balance 要有当日消费段');
  assert.ok(balanceResult.text.includes('余额'), '/balance 要有余额');

  fs.rmSync(dir, { recursive: true, force: true });
}

// ── 11b. 热重载幂等：apply 连跑两次，不能留下重复注册 ──────────────────────
// 这是「路由双双 404、插件却显示已启用」的真凶：新的先注册、旧的再卸载，
// 同名路由重复注册会抛错，把后面的注册全带走。加固后重挂前会先撤掉上一批。
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peak-whale-reapply-'));
  const registered = [];
  const disposed = [];
  const services = {
    webServer: {
      register(route) {
        registered.push(route.path);
        return () => disposed.push(route.path);
      },
    },
    profileContext: { name: 'desktop' },
  };
  const fake = makeContext(services);
  const config = {
    ledgerFile: path.join(dir, 'wallet.json'),
    settingsFile: path.join(dir, 'settings.json'),
  };
  apply(fake.ctx, config);
  assert.deepEqual(registered, [WALLET_ROUTE, WALLET_EXPORT_ROUTE, SETTINGS_ROUTE, DIAG_ROUTE, OPTIMIZE_ROUTE, OPTIMIZE3_ROUTE], '第一次注册六条路由（含导出）');
  assert.deepEqual(disposed, [], '第一次没有旧路由可撤');

  apply(fake.ctx, config);
  assert.deepEqual(
    disposed,
    [OPTIMIZE3_ROUTE, OPTIMIZE_ROUTE, DIAG_ROUTE, SETTINGS_ROUTE, WALLET_EXPORT_ROUTE, WALLET_ROUTE],
    '第二次注册前必须先把上一批撤掉（否则重复注册会抛）',
  );
  assert.deepEqual(
    registered,
    [
      WALLET_ROUTE, WALLET_EXPORT_ROUTE, SETTINGS_ROUTE, DIAG_ROUTE, OPTIMIZE_ROUTE, OPTIMIZE3_ROUTE,
      WALLET_ROUTE, WALLET_EXPORT_ROUTE, SETTINGS_ROUTE, DIAG_ROUTE, OPTIMIZE_ROUTE, OPTIMIZE3_ROUTE,
    ],
    '重挂就是「撤掉旧的、注册新的」，不会累积',
  );
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── 11c. 一条路由注册失败，不能把其余注册全带走 ─────────────────────────────
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peak-whale-routefail-'));
  const okPaths = [];
  const services = {
    webServer: {
      register(route) {
        if (route.path === WALLET_ROUTE) throw new Error('duplicate route');
        okPaths.push(route.path);
        return () => {};
      },
    },
    profileContext: { name: 'desktop' },
  };
  const fake = makeContext(services);
  apply(fake.ctx, {
    ledgerFile: path.join(dir, 'wallet.json'),
    settingsFile: path.join(dir, 'settings.json'),
  });
  assert.ok(
    fake.logs.some(([, message]) => message.includes('wallet 路由注册失败')),
    '注册失败要留下一条告警（否则现场只剩 404，什么都查不到）',
  );
  assert.deepEqual(okPaths, [WALLET_EXPORT_ROUTE, SETTINGS_ROUTE, DIAG_ROUTE, OPTIMIZE_ROUTE, OPTIMIZE3_ROUTE], '其余路由照样注册 —— 不能一起陪葬');
  assert.deepEqual([...fake.commands.keys()].sort(), ['balance', 'price'], '命令也要照常注册');
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── 11c2. UI 设置：读 / 写 / 白名单 / key 绝不外泄 ──────────────────────────
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peak-whale-uisettings-'));
  const file = path.join(dir, 'settings.json');

  // 直接函数级：缺文件回落默认（v0.4.1 起默认简洁版）
  // 提示词风格那项：默认是 `default`，且清单随设置一起回传（客户端不硬编码风格名）。
  assert.deepEqual(readUiSettings(file), {
    uiMode: 'concise',
    optimizeEnabled: true,
    petVisible: true,
    palette: 'mint',
    apiKeyConfigured: false,
    promptStyle: 'default',
    promptStyles: [{ id: 'default', name: '默认', note: '不改底稿：只改写、不增删任务目标、篇幅与原文同量级。' }],
  });

  // 合法写（文件不存在 → 自动按模板补齐其余键）
  let w = writeUiSettings(file, { uiMode: 'concise', optimizeEnabled: false });
  assert.equal(w.ok, true, '合法写要成功');
  assert.equal(w.settings.uiMode, 'concise');
  assert.equal(w.settings.optimizeEnabled, false);
  let raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(typeof raw.deepseekApiKey, 'string', '自动补上模板键（含 key 槽位）');

  // key 在场时写入不得动它；响应里绝不能带出 key；未知字段忽略
  fs.writeFileSync(file, `${JSON.stringify({ deepseekApiKey: 'sk-secret-123', uiMode: 'detailed', optimizeEnabled: true }, null, 2)}\n`);
  assert.equal(readUiSettings(file).apiKeyConfigured, true);
  w = writeUiSettings(file, { uiMode: 'concise', optimizeEnabled: false, deepseekApiKey: 'sk-hacker', unknown: 1 });
  assert.equal(w.ok, true);
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(after.deepseekApiKey, 'sk-secret-123', '写入不得动 key');
  assert.equal(after.unknown, undefined, '未知字段直接忽略');
  assert.equal(after.uiMode, 'concise');
  assert.ok(!JSON.stringify(w.settings).includes('sk-'), '回读对象里没有 key（连前缀都没有）');

  // 非法值要拒绝
  assert.equal(writeUiSettings(file, { uiMode: 'fancy' }).ok, false, 'uiMode 只认枚举');
  assert.equal(writeUiSettings(file, { optimizeEnabled: 'yes' }).ok, false, '开关必须是布尔');
  assert.equal(writeUiSettings(file, {}).ok, false, '空 patch 直接拒绝');

  // 路由级：GET / POST 全链路
  const handler = createSettingsHandler({ settingsFile: file });
  const get = fakeResponse();
  await handler({ method: 'GET', url: SETTINGS_ROUTE }, get);
  assert.equal(get.statusCode, 200);
  // 提示词风格也在载荷里：当前值 + 可选清单（前端据此渲染，不硬编码风格名）
  assert.deepEqual(JSON.parse(get.body), {
    ok: true,
    settings: {
      uiMode: 'concise',
      optimizeEnabled: false,
      petVisible: true,
      palette: 'mint',
      apiKeyConfigured: true,
      promptStyle: 'default',
      promptStyles: [{ id: 'default', name: '默认', note: '不改底稿：只改写、不增删任务目标、篇幅与原文同量级。' }],
    },
  });

  // 配色（第二档 #6）：合法值写入并回读；非法值拒绝（不静默存成上一档）
  assert.equal(writeUiSettings(file, { palette: 'fox' }).ok, true, '合法配色要写成功');
  assert.equal(readUiSettings(file).palette, 'fox');
  assert.equal(writeUiSettings(file, { palette: 'nope' }).ok, false, '未知配色要拒绝');
  assert.equal(readUiSettings(file).palette, 'fox', '非法写入不得改动已有值');

  const badStyle = fakeResponse();
  await handler({ method: 'POST', url: SETTINGS_ROUTE, [Symbol.asyncIterator]: async function* () { yield JSON.stringify({ promptStyle: '瞎写的' }); } }, badStyle);
  assert.equal(badStyle.statusCode, 400, '未知风格必须 400，不能静默存成上一档（那是最难查的"看着能改其实没改"）');
  assert.equal(JSON.parse(badStyle.body).ok, false);

  const post = fakeResponse();
  await handler({ method: 'POST', url: SETTINGS_ROUTE, [Symbol.asyncIterator]: async function* () { yield JSON.stringify({ uiMode: 'detailed' }); } }, post);
  assert.equal(post.statusCode, 200);
  assert.equal(JSON.parse(post.body).settings.uiMode, 'detailed');

  const bad = fakeResponse();
  await handler({ method: 'POST', url: SETTINGS_ROUTE, [Symbol.asyncIterator]: async function* () { yield JSON.stringify({ uiMode: 'fancy' }); } }, bad);
  assert.equal(bad.statusCode, 400, '非法值 400 而不是静默吞掉');
  assert.equal(JSON.parse(bad.body).ok, false);

  const notPost = fakeResponse();
  await handler({ method: 'DELETE', url: SETTINGS_ROUTE }, notPost);
  assert.equal(notPost.statusCode, 405, '只认 GET/POST');

  fs.rmSync(dir, { recursive: true, force: true });
}

// ── 11c3. 优化开关关掉后：optimize 路由不碰上游，给一句指路的话 ────────────
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peak-whale-optoff-'));
  const settingsFile = path.join(dir, 'settings.json');
  fs.writeFileSync(
    settingsFile,
    `${JSON.stringify({ deepseekApiKey: 'sk-1', uiMode: 'detailed', optimizeEnabled: false }, null, 2)}\n`,
  );
  const services = {
    webServer: {
      register(route) {
        if (route.path === OPTIMIZE_ROUTE) routes.set(route.path, route);
        return () => routes.delete(route.path);
      },
    },
    profileContext: { name: 'desktop' },
  };
  const routes = new Map();
  const fake = makeContext(services);
  apply(fake.ctx, { ledgerFile: path.join(dir, 'wallet.json'), settingsFile });

  const post = fakeResponse();
  await routes.get(OPTIMIZE_ROUTE).handler(
    { method: 'POST', url: OPTIMIZE_ROUTE, [Symbol.asyncIterator]: async function* () { yield JSON.stringify({ text: '帮我写个脚本' }); } },
    post,
  );
  const payload = JSON.parse(post.body);
  assert.equal(payload.ok, false, '开关关掉就拒绝');
  assert.equal(payload.error, 'disabled');
  assert.ok(payload.message.includes('设置'), `提示要指路到设置页：${payload.message}`);

  fs.rmSync(dir, { recursive: true, force: true });
}

// ── 11c4. optimize 成功载荷：usage / unchanged 要透传给浏览器 ───────────────
// 这两个字段是 v0.4.7 的新语言：usage → 完成气泡里的 token 注脚；
// unchanged → 客户端不写回、不问撤销，改说「原文已经很清晰」。
{
  const post = () => fakeResponse();
  const call = async (response, result) => {
    const handler = createOptimizeHandler({ optimize: async () => result });
    await handler(
      { method: 'POST', url: OPTIMIZE_ROUTE, [Symbol.asyncIterator]: async function* () { yield JSON.stringify({ text: '原文' }); } },
      response,
    );
    return JSON.parse(response.body);
  };

  // ① 正常成功：usage 与 unchanged 都要出现在载荷里
  const okRes = post();
  const okPayload = await call(okRes, {
    ok: true,
    optimized: '改好的稿子',
    model: 'deepseek-v4-pro',
    usage: { prompt: 120, completion: 80, total: 200 },
    unchanged: false,
  });
  assert.equal(okRes.statusCode, 200);
  assert.equal(okPayload.ok, true);
  assert.deepEqual(okPayload.usage, { prompt: 120, completion: 80, total: 200 }, 'usage 要透传');
  assert.equal(okPayload.unchanged, false);

  // ② 无改动：unchanged=true 透传（客户端靠它跳过写回与撤销询问）
  const samePayload = await call(post(), {
    ok: true,
    optimized: '原文一字未动',
    unchanged: true,
  });
  assert.equal(samePayload.unchanged, true, 'unchanged=true 要透传');
  assert.equal(samePayload.usage, null, '没给 usage 时是 null，不是 undefined 键消失');

  // ③ usage 坏数据：不许把 NaN/字符串直接漏到 JSON 里
  const dirtyPayload = await call(post(), {
    ok: true,
    optimized: 'x',
    usage: { prompt: '12', completion: 'abc', total: undefined },
  });
  assert.equal(dirtyPayload.usage.prompt, 12, '字符串数字要收编');
  assert.equal(dirtyPayload.usage.completion, 0, '不可解析的归 0');
  assert.equal(dirtyPayload.usage.total, 0);

  // ④ 截断失败：error 码与 message 原样给人看
  const truncPayload = await call(post(), {
    ok: false,
    error: 'finish-length',
    message: '优化结果被输出长度上限截断了',
  });
  assert.equal(truncPayload.ok, false);
  assert.equal(truncPayload.error, 'finish-length', '新错误码不能被吞成 failed');
  assert.ok(truncPayload.message.includes('截断'));
}

// ── 11c5. optimize3 路由：webToken 粘成命令时必须说人话，且绝不偷走 API 通道 ──
// 真实事故：用户把 `copy(JSON.parse(localStorage...))` 这行**文字**粘进了 settings.json。
// 若当没填 → 静默回落到按 token 计费的 API 通道（白花钱）；若照发 → 40003 看不懂。
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peak-whale-badtok-'));
  const settingsFile = path.join(dir, 'settings.json');
  const CMD = "copy(JSON.parse(localStorage.getItem('userToken')).value)";

  const callOptimize3 = async (res, deps) => {
    await createOptimize3Handler(deps)(
      { method: 'POST', url: OPTIMIZE3_ROUTE, [Symbol.asyncIterator]: async function* () { yield JSON.stringify({ text: '原文' }); } },
      res,
    );
    return JSON.parse(res.body);
  };

  fs.writeFileSync(settingsFile, JSON.stringify({ webToken: CMD, deepseekApiKey: 'sk-money' }));
  let optimizeCalled = 0;
  const payload = await callOptimize3(fakeResponse(), {
    settingsFile,
    optimize: async () => { optimizeCalled += 1; return { ok: true, variants: [] }; },
  });
  assert.equal(payload.ok, false, '配置错了不能假装成功');
  assert.equal(payload.error, 'bad_web_token', '要有专属错误码，方便客户端指路');
  assert.ok(payload.message.includes('命令'), `提示要说明是粘错了命令：${payload.message}`);
  assert.equal(optimizeCalled, 0, '绝不能静默改用计费的 API 通道');

  // 对照组 ①：webToken 留空 + 优化器没装 → 503，这是「没配后端」的合法语义
  fs.writeFileSync(settingsFile, JSON.stringify({ webToken: '', deepseekApiKey: 'sk-money' }));
  const offRes = fakeResponse();
  const offPayload = await callOptimize3(offRes, { settingsFile, optimize: null });
  assert.equal(offRes.statusCode, 503, '没装优化器又没配 token → 503');
  assert.equal(offPayload.ok, false);

  // 对照组 ②：webToken 留空 → 正常走 API 通道，三版齐全
  const okPayload = await callOptimize3(fakeResponse(), {
    settingsFile,
    optimize: async (_text, key) => ({ ok: true, optimized: '改好的-' + key, unchanged: false }),
  });
  assert.equal(okPayload.ok, true, '没填 webToken 时照常走 API 通道');
  assert.equal(okPayload.variants.length, 3, '三版都要有');

  fs.rmSync(dir, { recursive: true, force: true });
}

// ── 11c6. 网页端删除回执必须透传（2026-10-11 真事故）────────────────
// Host 加载到旧版 webchat.js 时，会话一条都没删，但响应体 / 日志 / 本机文件
// 三处都看不出任何异常 —— 因为 deleteSession 的结果被丢弃了。现在回执进了
// 响应，且「零回执」要告警，这类哑失败才看得见。
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peak-whale-receipt-'));
  const settingsFile = path.join(dir, 'settings.json');
  fs.writeFileSync(settingsFile, JSON.stringify({ webToken: 'a'.repeat(64) }));

  const callOptimize3 = async (deps) => {
    const res = fakeResponse();
    const warns = [];
    await createOptimize3Handler({ settingsFile, optimize: null, log: (m) => warns.push(m), ...deps })(
      { method: 'POST', url: OPTIMIZE3_ROUTE, [Symbol.asyncIterator]: async function* () { yield JSON.stringify({ text: '原文' }); } },
      res,
    );
    return { payload: JSON.parse(res.body), warns };
  };

  // ① 正常：三条回执原样透传到响应
  const seen = [];
  const ok1 = await callOptimize3({
    optimize3ViaWebChat: async (opts, text) => {
      seen.push(opts.autoDelete);
      return { ok: true, variants: [{ key: 'detailed' }], deletedSessions: ['s1', 's2', 's3'], deleteFailures: [] };
    },
  });
  assert.deepEqual(ok1.payload.deletedSessions, ['s1', 's2', 's3'], '回执必须透传');
  assert.equal(ok1.payload.deleteFailures.length, 0);
  assert.equal(seen[0], true, '默认要传 autoDelete:true');
  assert.ok(!ok1.warns.some((w) => w.includes('未确认删除')), '有回执就不该告警');

  // ② 哑失败：一条都没删 → 必须告警（这正是旧副本的症状）
  const bad = await callOptimize3({
    optimize3ViaWebChat: async () => ({ ok: true, variants: [{ key: 'detailed' }], deletedSessions: [], deleteFailures: [] }),
  });
  assert.ok(bad.warns.some((w) => w.includes('未确认删除')), '零回执要告警');

  // ③ keepWebSessions:true：保留会话是用户主动选的，不该被当成失败告警
  fs.writeFileSync(settingsFile, JSON.stringify({ webToken: 'a'.repeat(64), keepWebSessions: true }));
  const kept = await callOptimize3({
    optimize3ViaWebChat: async (opts) => {
      assert.equal(opts.autoDelete, false, '保留模式要传 autoDelete:false');
      return { ok: true, variants: [{ key: 'detailed' }], deletedSessions: [], deleteFailures: [] };
    },
  });
  assert.ok(!kept.warns.some((w) => w.includes('未确认删除')), '主动保留时不该告警');

  fs.rmSync(dir, { recursive: true, force: true });
}

// ── 11d. 开机竞态：webServer 后到，退避重试要自动补挂 ───────────────────────
// 这是「重启后路由全 404、重新挂载一次又好了」的真凶：apply 跑在服务就绪之前，
// 老式 ctx.get() 只会静默拿到 undefined。现在挂不上就先排队重试。
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peak-whale-latews-'));
  const registered = [];
  const services = { profileContext: { name: 'desktop' } }; // 一开始没有 webServer
  const fake = makeContext(services);
  apply(fake.ctx, {
    ledgerFile: path.join(dir, 'wallet.json'),
    settingsFile: path.join(dir, 'settings.json'),
  });
  assert.equal(registered.length, 0, 'webServer 没就绪时不注册任何路由');
  assert.ok(fake.timers.length >= 1, '要挂上重试定时器，等服务就绪');
  assert.ok(
    fake.logs.some(([, message]) => message.includes('webServer 服务还没就绪')),
    '留一句告警说明为什么现在没有路由',
  );

  // 服务就绪，把排队的重试跑掉
  services.webServer = {
    register(route) {
      registered.push(route.path);
      return () => {};
    },
  };
  const runnable = fake.timers.splice(0);
  for (const run of runnable) run();
  assert.deepEqual(registered, [WALLET_ROUTE, WALLET_EXPORT_ROUTE, SETTINGS_ROUTE, DIAG_ROUTE, OPTIMIZE_ROUTE, OPTIMIZE3_ROUTE], '服务就绪后，重试要自动把路由补上');
  assert.deepEqual([...fake.commands.keys()].sort(), ['balance', 'price'], '命令也一起补上');
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── 11e. inject 路径：webServer 经 ctx.inject 注入（开机竞态的正确解药）──────
// ctx.get('webServer') 在开机瞬间可能拿到一个「还没接管端口」的内置 server，
// register 成功却不服务对外端口（真机上踩过：重启后全 404，重挂一次又好了）。
// 首选路径应走 ctx.inject(['webServer'])，与内置插件 dsh-plugin 同一契约。
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peak-whale-inject-'));
  const registered = [];
  let disposer = null;
  const ws = {
    register(route) {
      registered.push(route.path);
      return () => {
        const at = registered.indexOf(route.path);
        if (at >= 0) registered.splice(at, 1);
      };
    },
  };
  const ctx = {
    logger: { info: () => {}, warn: () => {} },
    // webServer 明确拿不到 —— 只有 inject 能把路由挂上去
    get: () => undefined,
    on: () => () => {},
    effect: () => undefined,
    setTimeout() {},
    clearTimeout() {},
    commands: { register: (definition) => () => {} },
    inject(names, callback) {
      assert.deepEqual(names, ['webServer'], 'inject 请求的正是 webServer');
      callback({
        webServer: ws,
        effect(factory) {
          disposer = factory(); // host.effect 立即执行，记下撤销函数
        },
      });
    },
  };
  apply(ctx, {
    ledgerFile: path.join(dir, 'wallet.json'),
    settingsFile: path.join(dir, 'settings.json'),
  });
  assert.deepEqual(
    [...registered].sort(),
    [WALLET_ROUTE, WALLET_EXPORT_ROUTE, SETTINGS_ROUTE, DIAG_ROUTE, OPTIMIZE_ROUTE, OPTIMIZE3_ROUTE].sort(),
    '六条路由经 inject 挂上（ctx.get 拿不到 webServer 也能挂）',
  );
  assert.equal(typeof disposer, 'function', 'host.effect 要返回撤销函数');
  disposer();
  assert.deepEqual(registered, [], '卸载时路由全部移除');
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── 11f. 诊断路由：浏览器半身的开机打点落点（有界、同源、不炸）──────────────
{
  clearDiagEntries();
  const handler = createDiagHandler();
  const call = async (method, body) => {
    const res = {};
    const request = {
      method,
      async *[Symbol.asyncIterator]() {
        if (body !== undefined) yield typeof body === 'string' ? body : JSON.stringify(body);
      },
    };
    await handler(request, { writeHead: (s) => { res.status = s; }, end: (b) => { res.body = b; } });
    return { status: res.status, json: res.body ? JSON.parse(res.body) : null };
  };

  const empty = await call('GET');
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.json.entries, [], '一开始是空的');

  const post = await call('POST', { phase: 'script-executed', detail: 'facade=yes' });
  assert.equal(post.status, 200);
  assert.equal(post.json.count, 1, '打点被收下');
  assert.equal(diagEntries()[0].phase, 'script-executed');

  const read = await call('GET');
  assert.equal(read.json.entries.length, 1);
  assert.equal(read.json.entries[0].detail, 'facade=yes');

  const badJson = await call('POST', '{ 这不是 JSON');
  assert.equal(badJson.status, 400, '坏 JSON 要 400，不能 500');

  const wrongMethod = await call('DELETE');
  assert.equal(wrongMethod.status, 405);

  // 超长字段要被截断；缓冲有上界，不会被刷爆
  const long = await call('POST', { phase: 'x'.repeat(200), detail: 'y'.repeat(2000) });
  assert.equal(long.status, 200);
  const last = diagEntries().at(-1);
  assert.equal(last.phase.length, 40, 'phase 截到 40 字符');
  assert.equal(last.detail.length, 300, 'detail 截到 300 字符');
  for (let i = 0; i < 120; i += 1) await call('POST', { phase: 'flood' });
  assert.ok(diagEntries().length <= 60, '环形缓冲有上界');
  clearDiagEntries();
  assert.deepEqual(diagEntries(), [], '可清空');
}

// ── 12. 服务全缺时：不抛错，只是少两个功能 ─────────────────────────────────
{
  const fake = makeContext({});
  const settingsFile = path.join(os.tmpdir(), `peak-whale-none-${Date.now()}.json`);
  assert.doesNotThrow(() => apply(fake.ctx, {
    ledgerFile: path.join(os.tmpdir(), `peak-whale-ledger-${Date.now()}.json`),
    settingsFile,
  }));
  assert.deepEqual([...fake.commands.keys()].sort(), ['balance', 'price'], 'commands 还在就该注册命令');
  assert.equal(fake.routes.size, 0, '没有 webServer 就不注册路由');
  assert.equal(fake.logs.some(([, m]) => m.includes('webServer 服务还没就绪')), true, '要说清是哪个服务缺了');
  assert.equal(fs.existsSync(settingsFile), true, '配置模板应当被补出来（否则用户没地方填 key）');
  fs.rmSync(settingsFile, { force: true });
}

// ── 13. 账本文件的默认落点 ──────────────────────────────────────────────────
{
  const file = ledgerFile('desktop');
  assert.ok(file.includes('peak-whale'), `账本应落在插件目录：${file}`);
  assert.ok(file.endsWith('wallet.desktop.json'), '按 profile 分文件，避免多进程互相覆盖');
  assert.equal(ledgerFile(undefined).endsWith('wallet.default.json'), true, '读不到 profile 用 default');
  assert.equal(ledgerFile('a/b c').endsWith('wallet.a-b-c.json'), true, 'profile 名要做文件名安全处理');
}

console.log('wallet.test.mjs: 记账语义 / 余额 / 当日费用 / 路由与命令 全部通过');
console.log('  记账口径   : 与 tokenUsage 投影逐桶一致（替换 + 重试叠加）');
console.log('  持久化     : 写盘 → 重开读回 → 坏账本留备份');
console.log('  接线       : /price + /balance + wallet 路由 + session/event 监听');
