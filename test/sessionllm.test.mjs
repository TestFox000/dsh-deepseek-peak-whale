/**
 * 会话同路由通道测试：routeHintOf / normalizeRoute / usageOf / runner 的完整链路，
 * 以及两个 HTTP 路由的通道选择（route → webToken → 默认模型 → 网关回落）。
 *
 * 全部用假 llm（记录调用、按构造吐 chunk 流），不联网、不花钱。
 * 假 llm 的形状（prepareCall → {config, stream(options)}）与内核 LlmRuntime 的
 * 契约一致（callConfigEquals 校验：stream options 必须原样带上 call.config 的字段）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createOptimizeHandler,
  createOptimize3Handler,
  OPTIMIZE3_ROUTE,
} from '../index.js';
import {
  createSessionRouteRunner,
  normalizeRoute,
  routeHintOf,
  usageOf,
} from '../src/sessionllm.js';
import { settingsTemplate } from '../src/optimize.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'peak-whale-sr-'));
const settingsFile = path.join(tmp, 'settings.json');
fs.writeFileSync(settingsFile, JSON.stringify({ ...settingsTemplate(), iterateRounds: 1 }));

/** 假 llm：记录全部调用，按构造返回 chunk 流。 */
function fakeLlm(chunks = [], overrides = {}) {
  const calls = [];
  const llm = {
    prepareCall(config, _signal, configure) {
      const controls = {};
      const modelInfo = overrides.modelInfo ?? { reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] } };
      const merged = configure ? configure(controls, modelInfo) : controls;
      const resolved = Object.freeze({ ...config, ...merged });
      const call = {
        config: resolved,
        stream(options) {
          calls.push(options);
          // 迭代测试要第 2 轮返回不同的 chunks：按调用次数选
          const roundChunks = overrides.second && calls.length >= 2 ? overrides.second : chunks;
          const it = roundChunks[Symbol.iterator]();
          return {
            [Symbol.asyncIterator]() { return this; },
            async next() {
              const row = it.next();
              return row.done ? { done: true } : { value: row.value };
            },
          };
        },
      };
      return Promise.resolve(call);
    },
  };
  llm.calls = calls;
  return llm;
}

/** 一次成功的优化流（带标记、带 usage、带 finish）。 */
function okChunks(content, usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }) {
  return [
    { type: 'text-delta', index: 0, text: '<<<PROMPT>>>' },
    { type: 'text-delta', index: 0, text: content },
    { type: 'text-delta', index: 0, text: '<<<END>>>' },
    { type: 'usage', usage },
    { type: 'finish', reason: { kind: 'stop' } },
  ];
}

/** 假响应（与 wallet.test.mjs 同款）。 */
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

/** 假请求（POST + JSON body）。 */
function fakeReq(body) {
  return {
    method: 'POST',
    url: OPTIMIZE3_ROUTE,
    [Symbol.asyncIterator]: async function* () { yield JSON.stringify(body); },
  };
}

// ── 1. 纯函数 ───────────────────────────────────────────────────────────────
{
  assert.equal(normalizeRoute(null), null);
  assert.equal(normalizeRoute('x'), null);
  assert.deepEqual(normalizeRoute({ provider: 'p', model: 'm' }), { provider: 'p', model: 'm' });
  assert.deepEqual(
    normalizeRoute({ provider: 'p', model: 'm', reasoningEffort: 'low', sessionId: 's1' }),
    { provider: 'p', model: 'm', reasoningEffort: 'low', sessionId: 's1' },
  );
  // 超长/空白字段：拒绝，不截断（截断会静默换一个模型）
  assert.equal(normalizeRoute({ provider: 'x'.repeat(121), model: 'm' }), null);
  assert.equal(normalizeRoute({ provider: ' ', model: 'm' }), null);
  // 原型污染：__proto__ 不是自有属性，不认
  assert.equal(normalizeRoute(JSON.parse('{"__proto__": {"provider": "p"}, "model": "m"}')), null);

  assert.deepEqual(routeHintOf({ route: { provider: 'a', model: 'b' } }), { provider: 'a', model: 'b' });
  assert.equal(routeHintOf({}), null);
  assert.equal(routeHintOf(null), null);

  assert.deepEqual(usageOf({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }), { prompt: 10, completion: 5, total: 15 });
  assert.deepEqual(usageOf({ input: 3, output: 4 }), { prompt: 3, completion: 4, total: 7 });
  assert.equal(usageOf(null), null);
  assert.equal(usageOf({}), null);
}

// ── 2. runner：成功路径 ────────────────────────────────────────────────────
{
  const llm = fakeLlm(okChunks('优化后的稿子'));
  const runner = createSessionRouteRunner({
    file: settingsFile,
    llm: () => llm,
    fallbackRoute: () => ({ provider: 'deepseek', model: 'chat' }),
    now: () => 1000,
  });
  const r = await runner('帮我看日志', 'detailed', { provider: 'our-free-model', model: 'glm', reasoningEffort: 'low' });
  assert.equal(r.ok, true);
  assert.equal(r.optimized, '优化后的稿子');
  assert.equal(r.model, 'glm');
  assert.deepEqual(r.usage, { prompt: 10, completion: 5, total: 15 });
  assert.equal(typeof r.ms, 'number');
  assert.equal(llm.calls.length, 1);
  const opts = llm.calls[0];
  assert.equal(opts.provider, 'our-free-model');
  assert.equal(opts.model, 'glm');
  assert.equal(opts.system.includes('更详细'), true, 'variant 指令要进 system');
  assert.equal(Array.isArray(opts.messages) && opts.messages[0].role, 'user');
  assert.equal(opts.messages[0].content[0].text.includes('帮我看日志'), true);
  assert.equal(opts.purpose, 'peak-whale-optimize');
  // effort 透传（模型声明支持 low/high，route 带了 low）
  assert.equal(opts.reasoningEffort, 'low');
  // sessionId 透传（适配器按会话取上游凭据/做粘性）
  assert.equal(opts.sessionId, undefined, 'route 没带 sessionId 就不塞');

  // 缓存：同一路由同一段原文 5 分钟内不打第二次
  const r2 = await runner('帮我看日志', 'detailed', { provider: 'our-free-model', model: 'glm', reasoningEffort: 'low' });
  assert.equal(r2.cached, true);
  assert.equal(llm.calls.length, 1);
  // 换路由 = 换模型：缓存不串味
  await runner('帮我看日志', 'detailed', { provider: 'our-free-model', model: 'other' });
  assert.equal(llm.calls.length, 2);
}

// ── 3. runner：回落与失败 ──────────────────────────────────────────────────
{
  // 3a. 没有 llm 服务 → no-llm（路由层据此回落网关）
  const r1 = await createSessionRouteRunner({ file: settingsFile, llm: () => null })('原文');
  assert.equal(r1.ok, false);
  assert.equal(r1.error, 'no-llm');

  // 3b. 有 llm 但读不到任何路由 → no-route
  const r2 = await createSessionRouteRunner({ file: settingsFile, llm: () => fakeLlm([]) })('原文');
  assert.equal(r2.ok, false);
  assert.equal(r2.error, 'no-route');

  // 3c. finish: max-tokens → finish-length + 中文提示（与网关通道同码）
  const llm3 = fakeLlm([
    { type: 'text-delta', index: 0, text: '半截' },
    { type: 'finish', reason: { kind: 'max-tokens' } },
  ]);
  const r3 = await createSessionRouteRunner({
    file: settingsFile,
    llm: () => llm3,
    fallbackRoute: () => ({ provider: 'p', model: 'm' }),
  })('原文');
  assert.equal(r3.error, 'finish-length');
  assert.ok(r3.message.includes('截断'));

  // 3d. finish: error（NO_ADAPTER）→ 说人话
  const llm4 = fakeLlm([
    { type: 'finish', reason: { kind: 'error', failure: { code: 'NO_ADAPTER', message: 'no adapter' } } },
  ]);
  const r4 = await createSessionRouteRunner({
    file: settingsFile,
    llm: () => llm4,
    fallbackRoute: () => ({ provider: 'p', model: 'm' }),
  })('原文');
  assert.equal(r4.error, 'llm-NO_ADAPTER');
  assert.ok(r4.message.includes('适配器'));

  // 3e. prepareCall 抛 NO_ADAPTER（通道级）→ llm-NO_ADAPTER，可回落
  const boom = { prepareCall() { const e = new Error('no adapter'); e.code = 'NO_ADAPTER'; return Promise.reject(e); } };
  const r5 = await createSessionRouteRunner({
    file: settingsFile,
    llm: () => boom,
    fallbackRoute: () => ({ provider: 'p', model: 'm' }),
  })('原文');
  assert.equal(r5.error, 'llm-NO_ADAPTER');

  // 3f. 不支持的 effort：模型声明只有 low/high，route 要 low 以外的 → 走默认档不报错
  const llm6 = fakeLlm(okChunks('ok text'));
  const r6 = await createSessionRouteRunner({
    file: settingsFile,
    llm: () => llm6,
    fallbackRoute: () => ({ provider: 'p', model: 'm' }),
  })('原文', undefined, { provider: 'p', model: 'm', reasoningEffort: 'medium' });
  assert.equal(r6.ok, true);
  assert.equal('reasoningEffort' in llm6.calls[0], false, '不支持的档位不该被硬塞');

  // 3g. thinking 混进 content 的旧病：cleanOptimized 兜底剥掉
  const llm7 = fakeLlm([
    { type: 'text-delta', index: 0, text: '思考中… <<<PROMPT>>>真正正文<<<END>>>' },
    { type: 'finish', reason: { kind: 'stop' } },
  ]);
  const r7 = await createSessionRouteRunner({
    file: settingsFile,
    llm: () => llm7,
    fallbackRoute: () => ({ provider: 'p', model: 'm' }),
  })('原文');
  assert.equal(r7.optimized, '真正正文');
}

// ── 4. 单发 optimize 路由：通道选择 ────────────────────────────────────────
{
  const mk = (routeBody, sessionRunner, optimize) => createOptimizeHandler({
    sessionRunner,
    optimize,
    log: () => {},
  });

  // 4a. body 带 route → sessionRunner 收到 route，网关 runner 不被调用
  let seenRoute = 'unset';
  let gwCalled = 0;
  let res = fakeResponse();
  await mk(null, async (t, _k, route) => {
    seenRoute = route;
    return { ok: true, optimized: 'session-版本' };
  }, async () => { gwCalled += 1; return { ok: true, optimized: 'gw' }; })(fakeReq({ text: '原文', route: { provider: 'a', model: 'b' } }), res);
  let payload = JSON.parse(res.body);
  assert.equal(payload.ok, true);
  assert.equal(payload.optimized, 'session-版本');
  assert.deepEqual(seenRoute, { provider: 'a', model: 'b' });
  assert.equal(gwCalled, 0);

  // 4b. sessionRunner 报 no-llm → 回落网关
  res = fakeResponse();
  await mk(null, async () => ({ ok: false, error: 'no-llm', message: 'x' }),
    async () => ({ ok: true, optimized: 'gw-版本' }))(fakeReq({ text: '原文', route: { provider: 'a', model: 'b' } }), res);
  payload = JSON.parse(res.body);
  assert.equal(payload.optimized, 'gw-版本');

  // 4c. 模型自己的失败（如限流）→ **不**回落，原样透出
  res = fakeResponse();
  await mk(null, async () => ({ ok: false, error: 'llm-RATE_LIMIT', message: '限流' }),
    async () => ({ ok: true, optimized: 'gw-版本' }))(fakeReq({ text: '原文', route: { provider: 'a', model: 'b' } }), res);
  payload = JSON.parse(res.body);
  assert.equal(payload.ok, false);
  assert.equal(payload.error, 'llm-RATE_LIMIT');

  // 4d. 都没有 sessionRunner（旧部署/测试桩）→ 网关直走，行为与改造前完全一致
  res = fakeResponse();
  await mk(null, null, async () => ({ ok: true, optimized: 'gw-版本' }))(fakeReq({ text: '原文' }), res);
  payload = JSON.parse(res.body);
  assert.equal(payload.optimized, 'gw-版本');

  // 4e. 两个 runner 都没有 → 503（旧行为）
  res = fakeResponse();
  await mk(null, null, null)(fakeReq({ text: '原文' }), res);
  assert.equal(res.statusCode, 503);
}

// ── 5. optimize3 路由：通道选择（三版聚合 + 回落只在通道级错误时）─────────
{
  const call = async (deps, body) => {
    const res = fakeResponse();
    await createOptimize3Handler(deps)(fakeReq(body), res);
    return JSON.parse(res.body);
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peak-whale-o3-'));
  const sf = path.join(dir, 'settings.json');
  fs.writeFileSync(sf, JSON.stringify({ webToken: '', deepseekApiKey: 'k' }));

  // 5a. route → 三版全走 sessionRunner
  let srCalls = 0;
  let gwCalls = 0;
  let p = await call({
    settingsFile: sf,
    sessionRunner: async (t, key) => { srCalls += 1; return { ok: true, optimized: 'sr-' + key, unchanged: false }; },
    optimize: async () => { gwCalls += 1; return { ok: true, optimized: 'gw' }; },
  }, { text: '原文', route: { provider: 'a', model: 'b' } });
  assert.equal(p.ok, true);
  assert.equal(p.variants.length, 3);
  assert.equal(srCalls, 3);
  assert.equal(gwCalls, 0);
  assert.equal(p.variants[0].optimized, 'sr-detailed');

  // 5b. route 缺失 → 先默认模型；sessionRunner 收到 route=null → no-route → 回落网关
  srCalls = 0; gwCalls = 0;
  p = await call({
    settingsFile: sf,
    sessionRunner: async (t, k, route) => { srCalls += 1; return route === null ? { ok: false, error: 'no-route', message: 'x' } : { ok: true, optimized: 'sr-' + k }; },
    optimize: async () => { gwCalls += 1; return { ok: true, optimized: 'gw-' + Math.random() }; },
  }, { text: '原文' });
  assert.equal(p.ok, true);
  assert.equal(gwCalls, 3, 'no-route 要回落网关打满三版');
  assert.equal(srCalls, 3, 'sessionRunner 先被试过');

  // 5c. route 缺失但全局默认模型可用 → 全走 llm（网关零调用）
  srCalls = 0; gwCalls = 0;
  p = await call({
    settingsFile: sf,
    sessionRunner: async (t, k) => { srCalls += 1; return { ok: true, optimized: 'sr-' + k }; },
    optimize: async () => { gwCalls += 1; return { ok: true, optimized: 'gw' }; },
  }, { text: '原文' });
  assert.equal(p.ok, true);
  assert.equal(srCalls, 3);
  assert.equal(gwCalls, 0);

  // 5d. 三版全挂且为通道级错误 → 回落网关打满三版
  srCalls = 0; gwCalls = 0;
  p = await call({
    settingsFile: sf,
    sessionRunner: async () => { srCalls += 1; return { ok: false, error: 'no-llm', message: 'x' }; },
    optimize: async (t, key) => { gwCalls += 1; return { ok: true, optimized: 'gw-' + key }; },
  }, { text: '原文' });
  assert.equal(p.ok, true);
  assert.equal(gwCalls, 3);

  // 5e. 模型级失败不回落（限流三连挂 → 全挂透出，网关零调用）
  srCalls = 0; gwCalls = 0;
  p = await call({
    settingsFile: sf,
    sessionRunner: async () => { srCalls += 1; return { ok: false, error: 'llm-RATE_LIMIT', message: '限流' }; },
    optimize: async () => { gwCalls += 1; return { ok: true, optimized: 'gw' }; },
  }, { text: '原文' });
  assert.equal(p.ok, false);
  assert.equal(gwCalls, 0, '模型级失败不该回落网关重打三版');

  // 5f. webToken 优先级低于 route：带 route 时网页端通道完全不被触碰
  let webCalled = 0;
  p = await call({
    settingsFile: sf,
    sessionRunner: async (t, key) => ({ ok: true, optimized: 'sr-' + key }),
    optimize: null,
    optimize3ViaWebChat: async () => { webCalled += 1; return { ok: true, variants: [] }; },
  }, { text: '原文', route: { provider: 'a', model: 'b' } });
  assert.equal(p.ok, true);
  assert.equal(p.variants[0].optimized, 'sr-detailed');
  assert.equal(webCalled, 0, 'route 在场时 webToken 通道不该被碰');

  // 5g. 旧 client（无 route）+ webToken 配了 → 走网页端（旧行为保留）
  fs.writeFileSync(sf, JSON.stringify({ webToken: 't'.repeat(64), deepseekApiKey: 'k' }));
  webCalled = 0; srCalls = 0;
  p = await call({
    settingsFile: sf,
    sessionRunner: async (t, key) => { srCalls += 1; return { ok: true, optimized: 'sr-' + key }; },
    optimize: null,
    optimize3ViaWebChat: async () => { webCalled += 1; return { ok: true, variants: [{ key: 'detailed', optimized: 'web', unchanged: false, usage: null, cached: false, ms: 1 }], deletedSessions: ['x'], deleteFailures: [] }; },
  }, { text: '原文' });
  assert.equal(p.ok, true);
  assert.equal(webCalled, 1);
  assert.equal(srCalls, 0, 'webToken 在场时 sessionRunner 不被调用（旧优先级语义保留）');

  fs.rmSync(dir, { recursive: true, force: true });
}


// ── 3. 迭代打磨（2026-10-23 用户要求）─────────────────────────────────────
{
  const iterFile = path.join(tmp, 'settings-iter.json');
  fs.writeFileSync(iterFile, JSON.stringify({ ...settingsTemplate(), iterateRounds: 2 }));

  // 两轮假 llm：第 1 轮返回 A 稿，第 2 轮收到 A 稿后返回 B 稿
  const chunks1 = okChunks('背景：A', { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
  const chunks2 = okChunks('背景：B', { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 });
  const llm = fakeLlm(chunks1, { second: chunks2 });
  const runner = createSessionRouteRunner({
    file: iterFile,
    llm: () => llm,
    fallbackRoute: () => ({ provider: 'deepseek', model: 'chat' }),
    now: () => 1000,
  });
  const r = await runner('原文', 'detailed', { provider: 'our-free-model', model: 'glm', reasoningEffort: 'low' });
  assert.equal(r.ok, true);
  assert.equal(r.optimized, '背景：B', '最终稿是第 2 轮的输出');
  assert.equal(r.rounds, 2, '要报迭代轮数');
  assert.equal(llm.calls.length, 2, '两轮 = 两次 prepareCall');
  // usage 累加：15 + 30 = 45
  assert.deepEqual(r.usage, { prompt: 30, completion: 15, total: 45 }, '两轮 usage 要累加');
  // 第 2 轮的 system 要追加 ITERATION_SUFFIX
  assert.equal(llm.calls[1].system.includes('迭代打磨'), true, '迭代轮 system 要含 ITERATION_SUFFIX');
  assert.equal(llm.calls[1].messages[0].content[0].text.includes('【上一轮优化稿】'), true, '迭代轮 user 消息要用 ITERATION_USER_PREFIX');
  assert.equal(llm.calls[1].messages[0].content[0].text.includes('背景：A'), true, '第 2 轮的输入是第 1 轮的优化稿');
}

console.log('sessionllm.test.mjs: 路由收敛 / usage 多形态 / runner 全链路 / 两个路由的通道选择 全部通过');
console.log('  通道优先级: route → webToken → 默认模型 → 网关回落；模型级失败不回落');
