/**
 * webchat.js 单元测试：假 fetch + 假 PoW 求解器，不联网、不花钱。
 *
 * 覆盖：
 *   1. createWebChatCaller.chat —— 完整流程（建会话 → 取 challenge → 解 PoW → completion SSE → 抽正文）
 *   2. SSE 解析 —— SET/APPEND 增量、多事件、心跳行
 *   3. optimize3ViaWebChat —— 三版并行、部分失败、全挂
 *   4. 错误 —— 没 token / challenge biz_code≠0 / completion HTTP 错
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWebChatCaller, optimize3ViaWebChat, WebChatError } from '../src/webchat.js';

/** 假 PoW 求解器：不管 challenge 是啥，都返回一个合法形状的 answer。 */
function fakeSolver() {
  return {
    solve: async (challenge) => ({
      algorithm: challenge.algorithm,
      challenge: challenge.challenge,
      salt: challenge.salt,
      answer: 12345,
      signature: challenge.signature,
    }),
  };
}

/**
 * 造一个假 fetch，按 URL 分流：
 *   - /api/v0/chat_session/create → {data:{biz_data:{chat_session:{id}}}}
 *   - /api/v0/chat/create_pow_challenge → {data:{biz_code:0, biz_data:{challenge}}}
 *   - /api/v0/chat/completion → SSE 流（用 ReadableStream）
 */
function fakeFetch(opts = {}) {
  const calls = [];
  const sessionId = opts.sessionId ?? 'sess-fake-001';
  const sseEvents = opts.sseEvents ?? [
    { event: 'delta', data: { o: 'APPEND', p: 'response/content', v: '你好' } },
    { event: 'delta', data: { o: 'APPEND', p: 'response/content', v: '，这是优化后的提示词' } },
    { event: 'finish', data: {} },
  ];
  const challengeBizCode = opts.challengeBizCode ?? 0;
  const completionStatus = opts.completionStatus ?? 200;

  const f = async (url, init) => {
    const u = String(url);
    calls.push({ url: u, method: init?.method, headers: init?.headers, body: init?.body });
    const body = init?.body ? JSON.parse(init.body) : {};

    if (u.includes('/chat_session/create')) {
      return makeJsonResp({ data: { biz_data: { chat_session: { id: sessionId, title: '新对话' } } } });
    }
    if (u.includes('/create_pow_challenge')) {
      return makeJsonResp({
        data: {
          biz_code: challengeBizCode,
          biz_msg: challengeBizCode === 0 ? 'ok' : 'fail',
          biz_data: challengeBizCode === 0 ? {
            challenge: {
              algorithm: 'DeepSeekHashV1',
              challenge: 'fake_challenge_string',
              salt: 'fake_salt',
              difficulty: 5,
              signature: 'fake_sig',
              expire_at: 1700000000,
              expire_after: 60000,
            },
          } : null,
        },
      });
    }
    if (u.includes('/chat/completion')) {
      if (completionStatus !== 200) {
        return { ok: false, status: completionStatus, text: async () => 'error body', json: async () => ({}) };
      }
      // 造 SSE 流
      const chunks = sseEvents.map(e => `data: ${JSON.stringify(e)}\n\n`).join('');
      return makeSseResp(chunks);
    }
    return makeJsonResp({ data: {} });
  };
  f.calls = calls;
  return f;
}

function makeJsonResp(json) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: async () => json,
    text: async () => JSON.stringify(json),
  };
}

function makeSseResp(text) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
  return {
    ok: true,
    status: 200,
    headers: { get: (h) => h.toLowerCase() === 'content-type' ? 'text/event-stream' : null },
    body: stream,
    text: async () => text,
  };
}

// ── 1. 完整 chat 流程 ──────────────────────────────────────────────
test('webchat: chat() 走完建会话→PoW→completion→SSE，抽出正文', async () => {
  const f = fakeFetch();
  const caller = await createWebChatCaller({
    token: 'fake-token-abc',
    fetchImpl: f,
    solver: fakeSolver(),
    log: () => {},
  });
  const text = await caller.chat('请优化这个提示词');
  assert.equal(text, '你好，这是优化后的提示词');
  // 验证调用顺序
  assert.ok(f.calls.some(c => c.url.includes('/chat_session/create')), '应调建会话');
  assert.ok(f.calls.some(c => c.url.includes('/create_pow_challenge')), '应调取 challenge');
  const completion = f.calls.find(c => c.url.includes('/chat/completion'));
  assert.ok(completion, '应调 completion');
  // 验证 PoW header 在
  assert.ok(completion.headers['x-ds-pow-response'], 'completion 请求应带 X-DS-PoW-Response');
  // 验证 Authorization
  assert.equal(completion.headers.authorization, 'Bearer fake-token-abc');
  // 验证 body 有 prompt + chat_session_id
  const body = JSON.parse(completion.body);
  assert.equal(body.prompt, '请优化这个提示词');
  assert.equal(body.chat_session_id, 'sess-fake-001');
});

// ── 2. SSE 解析：SET + APPEND 混合、心跳行、多事件 ────────────────
test('webchat: SSE SET/APPEND 混合 + 心跳行都能正确抽正文', async () => {
  const f = fakeFetch({
    sseEvents: [
      { event: 'ready', data: {} },
      { event: 'delta', data: { o: 'SET', p: 'response/content', v: '第一段' } },
      { event: 'delta', data: { o: 'APPEND', p: 'response/content', v: '第二段' } },
      { event: 'delta', data: { o: 'APPEND', p: 'response/content', v: '第三段' } },
      { event: 'finish', data: {} },
    ],
  });
  const caller = await createWebChatCaller({
    token: 'tok',
    fetchImpl: f,
    solver: fakeSolver(),
    log: () => {},
  });
  const text = await caller.chat('test');
  assert.equal(text, '第一段第二段第三段');
});

test('webchat: SSE 非 data 行（心跳 : comment）被跳过', async () => {
  // 手造含心跳的 SSE
  const sseText = `: heartbeat\n\ndata: ${JSON.stringify({ event: 'delta', data: { o: 'APPEND', p: 'response/content', v: '正文' } })}\n\n`;
  const f = async (url, init) => {
    if (String(url).includes('/chat/completion')) return makeSseResp(sseText);
    if (String(url).includes('/chat_session/create')) return makeJsonResp({ data: { biz_data: { chat_session: { id: 's1' } } } });
    if (String(url).includes('/create_pow_challenge')) return makeJsonResp({ data: { biz_code: 0, biz_data: { challenge: { algorithm: 'DeepSeekHashV1', challenge: 'c', salt: 's', difficulty: 1, signature: 'sig', expire_at: 1, expire_after: 1 } } } });
    return makeJsonResp({});
  };
  const caller = await createWebChatCaller({ token: 't', fetchImpl: f, solver: fakeSolver(), log: () => {} });
  const text = await caller.chat('x');
  assert.equal(text, '正文');
});

test('webchat: SSE delta data 是操作数组时也能抽正文', async () => {
  const f = fakeFetch({
    sseEvents: [
      { event: 'delta', data: [
        { o: 'SET', p: 'response/content', v: '第一句' },
        { o: 'APPEND', p: 'response/content', v: '第二句' },
      ] },
      { event: 'delta', data: [{ o: 'APPEND', p: 'response/content', v: '第三句' }] },
      { event: 'finish', data: {} },
    ],
  });
  const caller = await createWebChatCaller({ token: 't', fetchImpl: f, solver: fakeSolver(), log: () => {} });
  const text = await caller.chat('x');
  assert.equal(text, '第一句第二句第三句');
});

test('webchat: SSE 隐式 delta（没 event 字段，只有 data）也能抽正文', async () => {
  const f = fakeFetch({
    sseEvents: [
      { data: { o: 'APPEND', p: 'response/content', v: '隐式 delta 正文' } },
      { event: 'finish', data: {} },
    ],
  });
  const caller = await createWebChatCaller({ token: 't', fetchImpl: f, solver: fakeSolver(), log: () => {} });
  const text = await caller.chat('x');
  assert.equal(text, '隐式 delta 正文');
});

// ── 3. optimize3ViaWebChat ────────────────────────────────────────
test('webchat: optimize3ViaWebChat 三版并行，都成功', async () => {
  const f = fakeFetch({
    sseEvents: [
      { event: 'delta', data: { o: 'APPEND', p: 'response/content', v: '优化后的版本' } },
      { event: 'finish', data: {} },
    ],
  });
  const result = await optimize3ViaWebChat(
    { token: 'tok', fetchImpl: f, solver: fakeSolver(), log: () => {} },
    '原始提示词',
  );
  assert.equal(result.ok, true);
  assert.equal(result.variants.length, 3);
  assert.deepEqual(result.variants.map(v => v.key), ['detailed', 'professional', 'auto']);
  for (const v of result.variants) {
    assert.equal(v.optimized, '优化后的版本');
    assert.equal(v.usage, null);
    assert.equal(v.cached, false);
  }
});

test('webchat: optimize3ViaWebChat 部分失败（2/3 成功）只返回成功的', async () => {
  let callCount = 0;
  const f = async (url, init) => {
    const u = String(url);
    if (u.includes('/chat_session/create')) return makeJsonResp({ data: { biz_data: { chat_session: { id: 's' + (++callCount) } } } });
    if (u.includes('/create_pow_challenge')) return makeJsonResp({ data: { biz_code: 0, biz_data: { challenge: { algorithm: 'DeepSeekHashV1', challenge: 'c', salt: 's', difficulty: 1, signature: 'sig', expire_at: 1, expire_after: 1 } } } });
    if (u.includes('/chat/completion')) {
      // 第二版（professional）返回 HTTP 500
      if (callCount === 2) return { ok: false, status: 500, text: async () => 'err', json: async () => ({}) };
      return makeSseResp(`data: ${JSON.stringify({ event: 'delta', data: { o: 'APPEND', p: 'response/content', v: '好的版本' } })}\n\n`);
    }
    return makeJsonResp({});
  };
  const result = await optimize3ViaWebChat(
    { token: 'tok', fetchImpl: f, solver: fakeSolver(), log: () => {} },
    '原文',
  );
  assert.equal(result.ok, true);
  assert.ok(result.variants.length >= 1, '至少一版成功');
});

test('webchat: optimize3ViaWebChat 全挂返回 ok:false + message', async () => {
  const f = fakeFetch({ completionStatus: 500 });
  const result = await optimize3ViaWebChat(
    { token: 'tok', fetchImpl: f, solver: fakeSolver(), log: () => {} },
    '原文',
  );
  assert.equal(result.ok, false);
  assert.ok(typeof result.message === 'string' && result.message !== '');
});

// ── 4. 错误处理 ────────────────────────────────────────────────────
test('webchat: 没 token 抛错', async () => {
  await assert.rejects(
    () => createWebChatCaller({ token: '', fetchImpl: () => {}, log: () => {} }),
    /userToken/,
  );
});

test('webchat: challenge biz_code≠0 抛错', async () => {
  const f = fakeFetch({ challengeBizCode: 40002 });
  const caller = await createWebChatCaller({ token: 't', fetchImpl: f, solver: fakeSolver(), log: () => {} });
  await assert.rejects(
    () => caller.chat('test'),
    /PoW challenge/,
  );
});

test('webchat: completion HTTP 错抛 WebChatError', async () => {
  const f = fakeFetch({ completionStatus: 403 });
  const caller = await createWebChatCaller({ token: 't', fetchImpl: f, solver: fakeSolver(), log: () => {} });
  await assert.rejects(
    () => caller.chat('test'),
    (err) => err instanceof WebChatError && err.status === 403,
  );
});

// ── 5. 真实抓包格式（2026-10 commit 4955e097，线上实测）──────────────

/** 真流的骨架：ready → update_session → 快照 → 显式 APPEND → 一串裸 {v} → BATCH → status → title → close */
const REAL_SSE = [
  'event: ready',
  'data: {"request_message_id":1,"response_message_id":2,"model_type":"default"}',
  '',
  'event: update_session',
  'data: {"updated_at":1791544329.72}',
  '',
  'data: {"v":{"response":{"message_id":2,"parent_id":1,"role":"ASSISTANT","status":"WIP","fragments":[{"id":2,"type":"RESPONSE","content":"提示","references":[],"stage_id":1}]}}}',
  '',
  'data: {"p":"response/fragments/-1/content","o":"APPEND","v":"词"}',
  '',
  'data: {"v":"工程是指"}',
  '',
  'data: {"v":"通过设计"}',
  '',
  'data: {"p":"response","o":"BATCH","v":[{"p":"accumulated_token_usage","v":150},{"p":"quasi_status","v":"FINISHED"}]}',
  '',
  'data: {"p":"response/status","o":"SET","v":"FINISHED"}',
  '',
  'event: title',
  'data: {"content":"提示词工程介绍"}',
  '',
  'event: close',
  'data: {"click_behavior":"none","auto_resume":false}',
  '',
].join('\n');

test('webchat: 真实 SSE 格式（快照+APPEND+裸{v}）拼出完整正文，且不含标题', async () => {
  const f = async (url) => {
    const u = String(url);
    if (u.includes('/chat/completion')) return makeSseResp(REAL_SSE);
    if (u.includes('/chat_session/create')) return makeJsonResp({ data: { biz_data: { id: 'sess-1' } } });
    if (u.includes('/create_pow_challenge')) return makeJsonResp({ data: { biz_code: 0, biz_data: { challenge: { algorithm: 'DeepSeekHashV1', challenge: 'c', salt: 's', difficulty: 1, signature: 'sig', expire_at: 1, expire_after: 1, target_path: '/api/v0/chat/completion' } } } });
    return makeJsonResp({});
  };
  const caller = await createWebChatCaller({ token: 't', fetchImpl: f, solver: fakeSolver(), log: () => {} });
  const text = await caller.chat('x');
  assert.equal(text, '提示词工程是指通过设计');
  // event:title 的 content 是标题，绝不能混进正文
  assert.ok(!text.includes('提示词工程介绍'), '标题不能混进正文');
});

test('webchat: hint 错误（parallel_chat_limit）在无正文时抛 WebChatError 且带 finishReason', async () => {
  const hintSSE = [
    'event: ready',
    'data: {"request_message_id":1,"response_message_id":2,"model_type":"default"}',
    '',
    'event: hint',
    'data: {"type":"error","content":"A message is being generated, please try again later.","clear_response":true,"finish_reason":"parallel_chat_limit"}',
    '',
    'event: close',
    'data: {"click_behavior":"retry","auto_resume":false}',
    '',
  ].join('\n');
  const f = async (url) => {
    const u = String(url);
    if (u.includes('/chat/completion')) return makeSseResp(hintSSE);
    if (u.includes('/chat_session/create')) return makeJsonResp({ data: { biz_data: { id: 's' } } });
    if (u.includes('/create_pow_challenge')) return makeJsonResp({ data: { biz_code: 0, biz_data: { challenge: { algorithm: 'DeepSeekHashV1', challenge: 'c', salt: 's', difficulty: 1, signature: 'sig', expire_at: 1, expire_after: 1 } } } });
    return makeJsonResp({});
  };
  const caller = await createWebChatCaller({ token: 't', fetchImpl: f, solver: fakeSolver(), log: () => {} });
  await assert.rejects(
    () => caller.chat('x'),
    (err) => err instanceof WebChatError && err.finishReason === 'parallel_chat_limit',
  );
});

test('webchat: 会话 id 在 data.biz_data.id（实测形状，非 chat_session.id）', async () => {
  const f = async (url) => {
    const u = String(url);
    if (u.includes('/chat_session/create')) {
      return makeJsonResp({ code: 0, data: { biz_code: 0, biz_data: { id: 'real-id-123', seq_id: 213707453, agent: 'chat' } } });
    }
    if (u.includes('/create_pow_challenge')) return makeJsonResp({ data: { biz_code: 0, biz_data: { challenge: { algorithm: 'DeepSeekHashV1', challenge: 'c', salt: 's', difficulty: 1, signature: 'sig', expire_at: 1, expire_after: 1 } } } });
    if (u.includes('/chat/completion')) return makeSseResp('data: {"v":"ok"}\n\n');
    return makeJsonResp({});
  };
  const caller = await createWebChatCaller({ token: 't', fetchImpl: f, solver: fakeSolver(), log: () => {} });
  const text = await caller.chat('x');
  assert.equal(text, 'ok');
});

// ── 6. 并发限流与重试（线上实测的账号级限制）────────────────────────

test('webchat: 三版并发不超过 2 路（DeepSeek parallel_chat_limit 实测上限）', async () => {
  let active = 0;
  let maxActive = 0;
  const f = async (url, init) => {
    const u = String(url);
    if (u.includes('/chat_session/create')) return makeJsonResp({ data: { biz_data: { id: 's-' + Math.random() } } });
    if (u.includes('/create_pow_challenge')) return makeJsonResp({ data: { biz_code: 0, biz_data: { challenge: { algorithm: 'DeepSeekHashV1', challenge: 'c', salt: 's', difficulty: 1, signature: 'sig', expire_at: 1, expire_after: 1 } } } });
    if (u.includes('/chat/completion')) {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 20));
      active -= 1;
      return makeSseResp('data: {"v":"正文"}\n\n');
    }
    return makeJsonResp({});
  };
  const result = await optimize3ViaWebChat(
    { token: 't', fetchImpl: f, solver: fakeSolver(), log: () => {}, concurrency: 2 },
    '原文',
  );
  assert.equal(result.ok, true);
  assert.equal(result.variants.length, 3);
  assert.ok(maxActive <= 2, `并发峰值 ${maxActive} 超过 2`);
  assert.ok(maxActive >= 2, `并发峰值 ${maxActive} 没有用满 2（限流器没生效）`);
});

test('webchat: 撞 parallel_chat_limit 会退避重试并最终成功', async () => {
  let completionCalls = 0;
  const hintSSE = [
    'event: hint',
    'data: {"type":"error","content":"A message is being generated, please try again later.","finish_reason":"parallel_chat_limit"}',
    '',
  ].join('\n');
  const okSSE = 'data: {"v":"重试后的正文"}\n\n';
  const f = async (url) => {
    const u = String(url);
    if (u.includes('/chat_session/create')) return makeJsonResp({ data: { biz_data: { id: 's' } } });
    if (u.includes('/create_pow_challenge')) return makeJsonResp({ data: { biz_code: 0, biz_data: { challenge: { algorithm: 'DeepSeekHashV1', challenge: 'c', salt: 's', difficulty: 1, signature: 'sig', expire_at: 1, expire_after: 1 } } } });
    if (u.includes('/chat/completion')) {
      completionCalls += 1;
      return makeSseResp(completionCalls === 1 ? hintSSE : okSSE);
    }
    return makeJsonResp({});
  };
  const result = await optimize3ViaWebChat(
    { token: 't', fetchImpl: f, solver: fakeSolver(), log: () => {}, concurrency: 1 },
    '原文',
  );
  assert.equal(result.ok, true);
  assert.equal(result.variants.length, 3);
  assert.ok(completionCalls > 3, `应发生重试，实际 completion 调用 ${completionCalls} 次`);
});

// ── 7. 用完即删（不给用户 chat.deepseek.com 侧栏留垃圾对话）─────────

/**
 * 造一个记录 delete 调用的假 fetch，返回指定 biz_code / HTTP 状态。
 * `uniqueIds: true` 时每次 create 返回不同 id —— 验「三版各删各的」必须开，
 * 否则 id 恒定，Set 大小永远是 1，看不出漏删。（默认关，保持上面几条断言不变。）
 */
function fetchWithDelete(deleteOpts = {}) {
  const { status = 200, bizCode = 0, uniqueIds = false } = deleteOpts;
  const deletes = [];
  let seq = 0;
  const f = async (url, init) => {
    const u = String(url);
    if (u.includes('/chat_session/create')) {
      seq += 1;
      return makeJsonResp({ data: { biz_data: { id: uniqueIds ? `sess-del-${seq}` : 'sess-to-delete' } } });
    }
    if (u.includes('/create_pow_challenge')) return makeJsonResp({ data: { biz_code: 0, biz_data: { challenge: { algorithm: 'DeepSeekHashV1', challenge: 'c', salt: 's', difficulty: 1, signature: 'sig', expire_at: 1, expire_after: 1 } } } });
    if (u.includes('/chat/completion')) return makeSseResp('data: {"v":"正文"}\n\n');
    if (u.includes('/chat_session/delete')) {
      deletes.push({ url: u, method: init?.method, headers: init?.headers, body: init?.body });
      if (status !== 200) return { ok: false, status, text: async () => 'boom', json: async () => ({}) };
      return makeJsonResp({ data: { biz_code: bizCode } });
    }
    return makeJsonResp({});
  };
  f.deletes = deletes;
  return f;
}

test('webchat: chat() 默认用完即删 —— 调 delete 且 body 是 {chat_session_ids:[id]}', async () => {
  const f = fetchWithDelete();
  const caller = await createWebChatCaller({ token: 'tok', fetchImpl: f, solver: fakeSolver(), log: () => {} });
  const text = await caller.chat('x');
  assert.equal(text, '正文', '正文照常返回');
  assert.equal(f.deletes.length, 1, '应恰好删一次');
  const d = f.deletes[0];
  assert.equal(d.method, 'POST');
  assert.deepEqual(JSON.parse(d.body), { chat_session_ids: ['sess-to-delete'] }, 'body 形状要和网页端一致');
  assert.equal(d.headers.authorization, 'Bearer tok', 'delete 也要带登录态');
  assert.ok(!d.headers['x-ds-pow-response'], 'delete 不需要 PoW header');
});

test('webchat: chat({autoDelete:false}) 保留会话，一次都不删', async () => {
  const f = fetchWithDelete();
  const caller = await createWebChatCaller({ token: 'tok', fetchImpl: f, solver: fakeSolver(), log: () => {} });
  const text = await caller.chat('x', { autoDelete: false });
  assert.equal(text, '正文');
  assert.equal(f.deletes.length, 0, '显式保留时不能删');
});

test('webchat: delete 失败（HTTP 500）不影响已拿到的正文 —— 吞异常只 log', async () => {
  const f = fetchWithDelete({ status: 500 });
  const caller = await createWebChatCaller({ token: 'tok', fetchImpl: f, solver: fakeSolver(), log: () => {} });
  const text = await caller.chat('x');
  assert.equal(text, '正文', '扫尾动作绝不能毁掉这次优化');
  assert.equal(f.deletes.length, 1);
});

test('webchat: delete 返回非 0 biz_code 也不抛', async () => {
  const f = fetchWithDelete({ bizCode: 40004 });
  const caller = await createWebChatCaller({ token: 'tok', fetchImpl: f, solver: fakeSolver(), log: () => {} });
  assert.equal(await caller.chat('x'), '正文');
});

test('webchat: completion 抛错时同样删干净（不留半截垃圾会话）', async () => {
  const f = async (url, init) => {
    const u = String(url);
    if (u.includes('/chat_session/create')) return makeJsonResp({ data: { biz_data: { id: 'sess-dangling' } } });
    if (u.includes('/create_pow_challenge')) return makeJsonResp({ data: { biz_code: 0, biz_data: { challenge: { algorithm: 'DeepSeekHashV1', challenge: 'c', salt: 's', difficulty: 1, signature: 'sig', expire_at: 1, expire_after: 1 } } } });
    if (u.includes('/chat/completion')) return { ok: false, status: 500, text: async () => 'err', json: async () => ({}) };
    const deletes = (f.deletes ??= []);
    if (u.includes('/chat_session/delete')) { deletes.push(init?.body); return makeJsonResp({ data: { biz_code: 0 } }); }
    return makeJsonResp({});
  };
  const caller = await createWebChatCaller({ token: 'tok', fetchImpl: f, solver: fakeSolver(), log: () => {} });
  await assert.rejects(() => caller.chat('x'), WebChatError);
  assert.deepEqual(f.deletes, ['{"chat_session_ids":["sess-dangling"]}'], '失败了也要把会话删掉');
});

test('webchat: optimize3ViaWebChat 默认删掉全部 3 条会话；autoDelete:false 一条不删', async () => {
  const del = fetchWithDelete();
  const r1 = await optimize3ViaWebChat({ token: 't', fetchImpl: del, solver: fakeSolver(), log: () => {}, iterateRounds: 1 }, '原文');
  assert.equal(r1.ok, true);
  assert.equal(r1.variants.length, 3);
  assert.equal(del.deletes.length, 3, '三版各建一条会话 ⇒ 应删 3 条');

  const keep = fetchWithDelete();
  const r2 = await optimize3ViaWebChat({ token: 't', fetchImpl: keep, solver: fakeSolver(), log: () => {}, autoDelete: false, iterateRounds: 1 }, '原文');
  assert.equal(r2.ok, true);
  assert.equal(keep.deletes.length, 0);
});

// ── 8. 删除回执 + 服务端取证（2026-10-11：Host 加载到旧副本、会话一条没删，
//      而本机毫无可查痕迹 ⇒ 必须有「能证明删干净」的手段，且失败要能被上层看见）──

test('webchat: deleteSession 返回真实成败（true=biz_code 0）', async () => {
  const okCaller = await createWebChatCaller({ token: 'tok', fetchImpl: fetchWithDelete(), solver: fakeSolver(), log: () => {} });
  assert.equal(await okCaller.deleteSession('s1'), true, 'biz_code 0 应返回 true');

  const badCaller = await createWebChatCaller({ token: 'tok', fetchImpl: fetchWithDelete({ bizCode: 40004 }), solver: fakeSolver(), log: () => {} });
  assert.equal(await badCaller.deleteSession('s2'), false, '非 0 biz_code 必须返回 false');

  const httpCaller = await createWebChatCaller({ token: 'tok', fetchImpl: fetchWithDelete({ status: 500 }), solver: fakeSolver(), log: () => {} });
  assert.equal(await httpCaller.deleteSession('s3'), false, 'HTTP 非 2xx 必须返回 false');

  const emptyCaller = await createWebChatCaller({ token: 'tok', fetchImpl: fetchWithDelete(), solver: fakeSolver(), log: () => {} });
  assert.equal(await emptyCaller.deleteSession(''), false, '空 id 不发请求、返回 false');
});

test('webchat: optimize3ViaWebChat 把删除回执回传（deletedSessions / deleteFailures）', async () => {
  const good = fetchWithDelete({ uniqueIds: true });
  const r1 = await optimize3ViaWebChat({ token: 't', fetchImpl: good, solver: fakeSolver(), log: () => {}, iterateRounds: 1 }, '原文');
  assert.equal(r1.ok, true);
  assert.equal(r1.deletedSessions.length, 3, '三版三条会话都该有删除回执');
  assert.equal(r1.deleteFailures.length, 0);
  assert.equal(new Set(r1.deletedSessions).size, 3, '回执必须是三条不同的会话');

  const bad = fetchWithDelete({ bizCode: 40004 });
  const r2 = await optimize3ViaWebChat({ token: 't', fetchImpl: bad, solver: fakeSolver(), log: () => {}, iterateRounds: 1 }, '原文');
  assert.equal(r2.ok, true, '删除失败不该影响正文');
  assert.equal(r2.deletedSessions.length, 0, '服务端没确认删除 ⇒ 不能谎报删了');
  assert.equal(r2.deleteFailures.length, 3, '三条都要进失败清单');

  const keep = fetchWithDelete();
  const r3 = await optimize3ViaWebChat({ token: 't', fetchImpl: keep, solver: fakeSolver(), log: () => {}, autoDelete: false, iterateRounds: 1 }, '原文');
  assert.equal(r3.deletedSessions.length, 0, '保留模式不该有删除回执');
});

/** 假 fetch：只服务 fetch_page，形状可配。 */
function fetchWithList(resp) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url: String(url), method: init?.method, headers: init?.headers });
    return resp;
  };
  f.calls = calls;
  return f;
}

test('webchat: listSessions 用 GET + query，解析 biz_data.chat_sessions', async () => {
  const f = fetchWithList(makeJsonResp({
    data: {
      biz_code: 0,
      biz_data: {
        has_more: true,
        chat_sessions: [
          { id: 'aaa', title: '优化车辆不动提示词', updated_at: 1791676924.686 },
          { id: 'bbb', title: '提示词优化改写', updated_at: 1791676922.546 },
        ],
      },
    },
  }));
  const caller = await createWebChatCaller({ token: 'tok', fetchImpl: f, solver: fakeSolver(), log: () => {} });
  const list = await caller.listSessions({ count: 50 });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].method, 'GET', '网页端是 http.get —— 用 POST 会被兜底成 HTML');
  assert.ok(f.calls[0].url.includes('fetch_page?count=50'), `URL 应带 count query，实际 ${f.calls[0].url}`);
  assert.equal(f.calls[0].headers.authorization, 'Bearer tok');
  assert.deepEqual(list.map((s) => s.id), ['aaa', 'bbb']);
  assert.equal(list[0].title, '优化车辆不动提示词');
  assert.equal(list[0].updatedAt, 1791676924.686, 'updated_at 要转成数字');
});

test('webchat: listSessions 看穿 SPA 兜底页（HTTP 200 + HTML 必须抛错，不能当空列表）', async () => {
  // 实测：路径或方法不对时，服务端返回 200 + 9824 字节的 index.html。
  // 若只判 resp.ok，这里会静默返回空数组 ⇒ 取证结论变成「一条都没残留」的假绿。
  const html = {
    ok: true,
    status: 200,
    headers: { get: () => 'text/html; charset=utf-8' },
    json: async () => { throw new Error('not json'); },
    text: async () => '<!doctype html><html><head><title>DeepSeek</title></head><body></body></html>',
  };
  const caller = await createWebChatCaller({ token: 'tok', fetchImpl: fetchWithList(html), solver: fakeSolver(), log: () => {} });
  await assert.rejects(() => caller.listSessions(), WebChatError, '兜底页必须报错而不是当成"没有会话"');
});

test('webchat: listSessions 在非 0 biz_code 时抛错', async () => {
  const f = fetchWithList(makeJsonResp({ data: { biz_code: 2, biz_msg: 'invalid cursor', biz_data: null } }));
  const caller = await createWebChatCaller({ token: 'tok', fetchImpl: f, solver: fakeSolver(), log: () => {} });
  await assert.rejects(() => caller.listSessions(), WebChatError);
});

test('webchat: listSessions 是只读的 —— 不建会话、不碰 completion', async () => {
  const f = fetchWithList(makeJsonResp({ data: { biz_code: 0, biz_data: { has_more: false, chat_sessions: [] } } }));
  const caller = await createWebChatCaller({ token: 'tok', fetchImpl: f, solver: fakeSolver(), log: () => {} });
  await caller.listSessions();
  assert.equal(f.calls.length, 1, '取证接口自身必须零副作用');
  assert.ok(!f.calls.some((c) => /completion|session\/create/.test(c.url)), '绝不能偷偷调 completion 花钱');
});

console.log('webchat.test.mjs: 网页端对话 / PoW / SSE / 三版优化 / 用完即删 全部通过');