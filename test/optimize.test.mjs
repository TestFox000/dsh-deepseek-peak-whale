/**
 * 提示词优化器测试：配置、请求体、输出收敛、错误翻译、缓存与并发。
 *
 * 为什么值得单独一套：这里**真的会花钱**——每拖一次就是一次模型调用
 * + `reasoning_effort: max` 的调用。所以「同一段原文不重复扣费」「没配 key 时
 * 给人一句能照做的话」「401 不被当成空结果」这几条必须钉死。
 * 所有上游交互都用假 fetch，测试从不联网。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DEFAULTS,
  SYSTEM_PROMPT,
  VARIANT_KEYS,
  VARIANT_LABELS,
  VARIANT_PROMPTS,
  buildRequestBody,
  cacheKeyFor,
  cleanOptimized,
  createOptimizeRunner,
  describeHttpError,
  ensureSettingsFile,
  hashText,
  optimize3,
  pickUsage,
  PROMPT_CLOSE,
  PROMPT_OPEN,
  readSettings,
  settingsPath,
  settingsTemplate,
  systemPromptFor,
  tokenLooksLikeSnippet,
  unwrapStoredToken,
} from '../src/optimize.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'peak-whale-opt-'));
const file = path.join(tmp, 'settings.json');

/** 写一份 settings.json（内容由调用方给）。 */
function writeSettings(value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

/** 假的上游：记录调用，按构造返回。 */
function fakeFetch(reply) {
  const calls = [];
  const fn = async (url, options) => {
    calls.push({ url, options });
    return reply(url, options);
  };
  fn.calls = calls;
  return fn;
}

const okResponse = (content) => ({
  ok: true,
  status: 200,
  json: async () => ({ choices: [{ message: { content } }] }),
});

const errorResponse = (status, message) => ({
  ok: false,
  status,
  json: async () => ({ error: { message } }),
});

// ── 1. 配置读写 ─────────────────────────────────────────────────────────────
{
  assert.equal(settingsPath('/x'), path.join('/x', 'settings.json'));

  // 文件不存在 → 全默认；key 走环境变量兜底
  const missing = readSettings(path.join(tmp, 'nope.json'), { DEEPSEEK_API_KEY: ' sk-env ' });
  assert.equal(missing.model, DEFAULTS.model);
  assert.equal(missing.reasoningEffort, DEFAULTS.reasoningEffort);
  assert.equal(missing.apiKey, 'sk-env', '环境变量兜底要 trim');

  // 损坏的 JSON → 不抛，回落默认
  fs.writeFileSync(file, '{ 坏掉的');
  const broken = readSettings(file, {});
  assert.equal(broken.model, DEFAULTS.model, '坏文件不能让插件崩');

  // 文件优先于环境变量
  writeSettings({ deepseekApiKey: 'sk-file', model: 'm2', reasoningEffort: 'off', timeoutMs: 5 , iterateRounds: 1 });
  const filled = readSettings(file, { DEEPSEEK_API_KEY: 'sk-env' });
  assert.equal(filled.apiKey, 'sk-file', '文件优先');
  assert.equal(filled.model, 'm2');
  assert.equal(filled.reasoningEffort, 'off', '可以关掉思考字段');
  assert.equal(filled.timeoutMs, 5);
  assert.equal(readSettings(file, {}).baseUrl, DEFAULTS.baseUrl);
  // 没配 key → 兜底读本机网关的 key（这时读到的是真实文件，所以只断言「不空」）
  assert.ok(typeof readSettings(path.join(tmp, 'nope.json'), {}).apiKey === 'string');

  // baseUrl 的尾斜杠要吃掉，否则拼出 //chat/completions
  writeSettings({ baseUrl: 'https://x.example/' , iterateRounds: 1 });
  assert.equal(readSettings(file, {}).baseUrl, 'https://x.example');

  // 模板：该有的字段都有，key 是空的
  const template = settingsTemplate();
  assert.equal(template.deepseekApiKey, '');
  assert.equal(template.model, DEFAULTS.model);
  assert.equal(template.reasoningEffort, DEFAULTS.reasoningEffort);
  assert.ok(Object.keys(template).some((k) => k.startsWith('_')), '模板里要有一句说明');
  assert.equal(template.keepWebSessions, false, '默认用完即删网页端会话');
}

// ── 1b. webToken 剥包装 + keepWebSessions 读取 ───────────────────────────────
{
  // 浏览器 localStorage 里的 userToken 被 appKit 包成 {"value":"…"}；
  // 原样粘进 settings 会当 Bearer 发出，换来一句费解的 40003。必须剥掉。
  assert.equal(unwrapStoredToken('{"value":"LVqNAKk2abc"}'), 'LVqNAKk2abc', '剥掉 appKit 包装');
  assert.equal(unwrapStoredToken('  {"value":" tok ","__version":"0"}  '), 'tok', '包装内也要 trim');
  assert.equal(unwrapStoredToken('plain-token-64chars'), 'plain-token-64chars', '裸 token 原样返回');
  assert.equal(unwrapStoredToken('{"other":"x"}'), '{"other":"x"}', '没有 value 字段就别乱动');
  assert.equal(unwrapStoredToken('{ 坏掉的'), '{ 坏掉的', '非法 JSON 原样交给上游');
  assert.equal(unwrapStoredToken(''), '', '空就是空');

  writeSettings({ webToken: '{"value":"wrapped-abc","__version":"0"}' , iterateRounds: 1 });
  assert.equal(readSettings(file, {}).webToken, 'wrapped-abc', 'readSettings 要自动剥包装');
  writeSettings({ webToken: 'bare-abc' , iterateRounds: 1 });
  assert.equal(readSettings(file, {}).webToken, 'bare-abc', '裸值不受影响');

  // keepWebSessions：只有显式 true 才保留会话
  writeSettings({ webToken: 'bare-abc' , iterateRounds: 1 });
  assert.equal(readSettings(file, {}).keepWebSessions, false, '默认删除');
  writeSettings({ keepWebSessions: true , iterateRounds: 1 });
  assert.equal(readSettings(file, {}).keepWebSessions, true, '显式 true 才保留');
  writeSettings({ keepWebSessions: 'yes' , iterateRounds: 1 });
  assert.equal(readSettings(file, {}).keepWebSessions, false, '字符串 "yes" 不算 true');
}

// ── 1c. 把「取 token 的命令」粘成 token 必须被抓出来 ─────────────────────────
{
  // 真实事故：用户复制了我消息里的 copy(...) 这行文字，粘进了 settings.json。
  // 拦不住的话要么 40003 看不懂，要么被当没填→静默走计费的 API 通道。
  const CMD = "copy(JSON.parse(localStorage.getItem('userToken')).value)";
  assert.equal(tokenLooksLikeSnippet(CMD), true, '命令片段必须判为无效');
  assert.equal(tokenLooksLikeSnippet('  ' + CMD + '  '), true, '带空白也要抓到');
  assert.equal(tokenLooksLikeSnippet('LVqNAKk2vGw79o7KN9HLuaJPYgnb1hJuvEUMA2rPReR63lZfCg'), false, '真 token（纯字母数字）不能误判');
  assert.equal(tokenLooksLikeSnippet('a+b/c=='), false, 'base64 符号 + / = 是合法的');
  assert.equal(tokenLooksLikeSnippet('has-dash_and.dot'), false, '常见分隔符合法');
  assert.equal(tokenLooksLikeSnippet('two\nlines'), true, '换行绝不可能是 token');
  assert.equal(tokenLooksLikeSnippet(''), false, '空串交给"未配置"分支，不算无效');

  writeSettings({ webToken: CMD , iterateRounds: 1 });
  const bad = readSettings(file, {});
  assert.equal(bad.webTokenInvalid, true, 'readSettings 要带出无效标记');
  assert.equal(bad.webToken, CMD, '但不要把值改掉——报错时原样回显才有用');

  writeSettings({ webToken: 'LVqNAKk2vGw79o7KN9HLuaJPYgnb1hJuvEUMA2rPReR63lZfCg' , iterateRounds: 1 });
  assert.equal(readSettings(file, {}).webTokenInvalid, false, '正常 token 不能误伤');
  writeSettings({ webToken: '{"value":"LVqNAKk2vGw79o7KN9HLuaJPYgnb1hJuvEUMA2rPReR63lZfCg"}' , iterateRounds: 1 });
  assert.equal(readSettings(file, {}).webTokenInvalid, false, '剥完包装的 appKit 值也不能误伤');
}

// ── 2. 模板文件：只创建、不覆盖 ─────────────────────────────────────────────
{
  const fresh = path.join(tmp, 'created', 'settings.json');
  assert.equal(fs.existsSync(fresh), false);
  assert.equal(ensureSettingsFile(fresh), true, '第一次应当创建');
  assert.equal(fs.existsSync(fresh), true);
  const parsed = JSON.parse(fs.readFileSync(fresh, 'utf8'));
  assert.equal(parsed.deepseekApiKey, '', '创建出来的 key 是空的（等用户填）');
  assert.equal(ensureSettingsFile(fresh), false, '第二次不该覆盖——用户已经填过 key 了');
  assert.equal(JSON.parse(fs.readFileSync(fresh, 'utf8')).deepseekApiKey, '');
}

// ── 3. 请求体 ───────────────────────────────────────────────────────────────
{
  const settings = readSettings(path.join(tmp, 'nope.json'), {});
  const body = buildRequestBody(settings, '帮我写个脚本');
  assert.equal(body.model, DEFAULTS.model, '默认就是本机网关那条会话路由');
  assert.equal(body.reasoning_effort, DEFAULTS.reasoningEffort, '思考档位默认 deep');
  assert.equal(body.stream, false, '不开流：要一次拿完整结果');
  assert.equal(body.messages.length, 2);
  assert.equal(body.messages[0].role, 'system');
  assert.ok(body.messages[0].content === SYSTEM_PROMPT, '系统提示词就是导出的那一份');
  assert.ok(body.messages[1].content.includes('帮我写个脚本'), '原文要进 user 消息');
  assert.ok(!body.messages[1].content.includes('优化后的提示词'), '原文不该被塞进说明');

  // 思考字段留空 → 不带这个键（有人的账户不认它）
  const off = buildRequestBody({ ...settings, reasoningEffort: '   ' }, 'x');
  assert.equal('reasoning_effort' in off, false, '空 effort 不发字段');
}

// ── 4. 输出收敛：模型爱加的壳都要剥掉 ───────────────────────────────────────
{
  assert.equal(cleanOptimized(null), null, '非字符串给 null');
  assert.equal(cleanOptimized(''), null, '空串给 null');
  assert.equal(cleanOptimized('   \n  '), null, '全空白给 null');

  const plain = '背景：...\n任务：写一个脚本\n输出：Markdown';
  assert.equal(cleanOptimized(plain), plain, '干净的正文原样返回');

  assert.equal(
    cleanOptimized('```\n背景：A\n任务：B\n```'),
    '背景：A\n任务：B',
    '整段包在代码块里要剥出来',
  );
  assert.ok(
    cleanOptimized('好的，以下是优化后的提示词：\n\n背景：A\n任务：B').startsWith('背景'),
    '开头的引导语要删掉',
  );
  assert.ok(
    !cleanOptimized('背景：A\n任务：B\n\n希望这对你有帮助！').includes('希望这对你有帮助'),
    '结尾的客套要删掉',
  );
  // 提示词本身含代码块时：正文一个字都不能丢（不能「取最长的那块」）
  const withSnippet = '任务：改这个函数\n```js\nfunction a() {\n' + 'x'.repeat(80) + '\n}\n```\n要求：保持签名';
  const cleaned = cleanOptimized(withSnippet);
  assert.ok(cleaned.includes('function a()'), '带代码的正文要留下');
  assert.ok(cleaned.includes('任务：改这个函数'), '正文不能被代码块吃掉');
  assert.ok(cleaned.includes('要求：保持签名'), '代码块后面的内容也要留下');
}

// ── 4b. 标记区与思考块：文本框里只许有正文 ─────────────────────────────────
{
  const O = '<<<PROMPT>>>';
  const C = '<<<END>>>';

  // 主路径：标记外的思考/解释一律不要
  assert.equal(
    cleanOptimized(`${O}\n背景：A\n任务：B\n${C}`),
    '背景：A\n任务：B',
    '标记之间就是正文',
  );
  assert.equal(
    cleanOptimized(`用户想让我把这段改清楚。\n\n${O}\n背景：A\n${C}\n\n我已经补上了约束，希望有用。`),
    '背景：A',
    '标记外的思考和结语都要丢掉',
  );
  assert.equal(
    cleanOptimized(`${O}\n背景：A`),
    '背景：A',
    '模型漏写 END 也要保底给出正文',
  );
  // 标记自己带了代码块包裹 → 剥壳顺序要对（先取标记区）
  assert.equal(
    cleanOptimized('```\n' + O + '\n背景：A\n' + C + '\n```'),
    '背景：A',
    '标记区之外还包了代码块也要剥干净',
  );
  // 正文里自然出现 <<<PROMPT>>> 时不该把后面全丢掉 —— 取到第一个 END 为止
  assert.equal(
    cleanOptimized(`${O}\n提到 ${O} 这个写法\n${C}\n之后的解释`),
    `提到 ${O} 这个写法`,
    '正文里出现标记也只当正文',
  );

  // ② 模型没听（没打标记）时，成对思考块要剥掉
  assert.equal(
    cleanOptimized(' thinking先分析一下需求……</think>\n背景：A\n任务：B'),
    '背景：A\n任务：B',
    '成对思考块要剥掉',
  );
  assert.equal(
    cleanOptimized('正文前的碎念\n</thinking>\n背景：A'),
    '背景：A',
    '只剩闭标签就砍掉它前面的全部',
  );
  assert.equal(
    cleanOptimized('思考过程：\n先看看用户要什么\n\n背景：A\n任务：B'),
    '背景：A\n任务：B',
    '「思考过程：」整段要剥掉',
  );
  // 剥完是空的 → 当失败，不能写回空串
  assert.equal(cleanOptimized(' thinking只有思考，没有正文</think>'), null, '剥干净就返回 null');
}

// ── 5. HTTP 错误翻译：要能直接显示给人看 ───────────────────────────────────
{
  assert.ok(describeHttpError(401, null).includes('API key'));
  assert.ok(describeHttpError(402, null).includes('余额不足'));
  assert.ok(describeHttpError(404, null).includes('model'), '模型 id 写错要提示改哪里');
  assert.ok(describeHttpError(429, null).includes('太频繁'));
  assert.ok(describeHttpError(400, { error: { message: 'reasoning_effort 不受支持' } }).includes('reasoning_effort'));
  assert.ok(
    describeHttpError(400, { error: { message: 'reasoning_effort 不受支持' } }).includes('reasoningEffort'),
    '400 提到 reasoning 时要顺手告诉用户改哪个配置字段',
  );
  assert.ok(
    !describeHttpError(400, { error: { message: 'messages 太长' } }).includes('reasoningEffort'),
    '别的 400 不该乱给 hint',
  );
  assert.ok(describeHttpError(500, null).includes('HTTP 500'));
  assert.ok(
    describeHttpError(400, { error: { message: 'x'.repeat(400) } }).length < 300,
    '上游长报错要截断，别把整屏糊上',
  );
}

// ── 6. 运行器：没配 key / 空 / 太长 ────────────────────────────────────────
{
  const noKey = createOptimizeRunner({ file: path.join(tmp, 'nope.json'), env: {} });
  const denied = await noKey('帮我写个脚本');
  assert.equal(denied.ok, false);
  assert.equal(denied.error, 'no-api-key');
  assert.ok(denied.message.includes('deepseekApiKey'), `要告诉用户改哪个字段：${denied.message}`);
  assert.ok(
    denied.message.includes(path.join(tmp, 'nope.json')),
    `要给出配置文件的完整位置：${denied.message}`,
  );

  const empty = await noKey('   ');
  assert.equal(empty.error, 'empty');

  writeSettings({ deepseekApiKey: 'sk-x', maxInputChars: 10 , iterateRounds: 1 });
  const withKey = createOptimizeRunner({ file, env: {} });
  const long = await withKey('这是一段超过十个字符的提示词');
  assert.equal(long.error, 'too-long');
  assert.ok(long.message.includes('10'), '要说清上限');

  // 乱码（U+FFFD）：传输编码错了就挡在打上游之前——模型看见乱码照样回一句话，
  // 钱花了还拿到垃圾（真踩过：PowerShell 发请求没按 UTF-8 编码）。
  const mojibake = await withKey('帮我写个脚本�');
  assert.equal(mojibake.error, 'encoding', '乱码要挡在打上游之前');
  assert.ok(mojibake.message.includes('乱码'), `要说人话：${mojibake.message}`);
}

// ── 7. 运行器：真的调上游（假 fetch） ──────────────────────────────────────
{
  writeSettings({ deepseekApiKey: 'sk-test', model: 'deepseek-v4-pro', reasoningEffort: 'max', iterateRounds: 1 });

  const fetchOk = fakeFetch(async () => okResponse('好的，以下是优化后的提示词：\n\n背景：A\n任务：B'));
  const run = createOptimizeRunner({ file, env: {}, fetchImpl: fetchOk });
  const result = await run('原始提示词');
  assert.equal(result.ok, true);
  assert.equal(result.optimized, '背景：A\n任务：B', '壳要剥干净再交给用户');
  assert.equal(result.model, 'deepseek-v4-pro');
  assert.equal(fetchOk.calls.length, 1);
  assert.equal(fetchOk.calls[0].url, `${DEFAULTS.baseUrl}/chat/completions`, '拼的是 baseUrl 那条路由');
  assert.equal(fetchOk.calls[0].options.headers.authorization, 'Bearer sk-test');
  assert.equal(fetchOk.calls[0].options.headers['content-type'], 'application/json');
  assert.match(fetchOk.calls[0].options.headers.authorization, /^Bearer /);

  // 同一段原文 5 分钟内不再扣费
  const again = await run('原始提示词');
  assert.equal(again.ok, true);
  assert.equal(again.cached, true, '第二次要命中缓存');
  assert.equal(fetchOk.calls.length, 1, '缓存命中就不能再打上游');

  // 换一段原文 → 重新调用
  await run('另一段提示词');
  assert.equal(fetchOk.calls.length, 2);

  // 并发拖两次同一段 → 只打一次上游
  const fetchSlow = fakeFetch(() => new Promise((resolve) => {
    setTimeout(() => resolve(okResponse('背景：C')), 20);
  }));
  fs.writeFileSync(path.join(tmp, 'slow.json'), JSON.stringify({ deepseekApiKey: 'sk-slow', iterateRounds: 1 }));
  const slowRun = createOptimizeRunner({ file: path.join(tmp, 'slow.json'), env: {}, fetchImpl: fetchSlow });
  const [a, b] = await Promise.all([slowRun('并发原文'), slowRun('并发原文')]);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(fetchSlow.calls.length, 1, '同一段文字并发只打一次');
}

// ── 8. 运行器：上游的各种失败都要变成一句人话 ───────────────────────────────
{
  writeSettings({ deepseekApiKey: 'sk-test' , iterateRounds: 1 });

  const run401 = createOptimizeRunner({ file, env: {}, fetchImpl: fakeFetch(async () => errorResponse(401, 'Invalid API key')) });
  const r401 = await run401('提示词 A');
  assert.equal(r401.ok, false);
  assert.equal(r401.error, 'http-401');
  assert.ok(r401.message.includes('API key'), '401 要说 key 的问题');

  const runNet = createOptimizeRunner({
    file,
    env: {},
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED');
    },
  });
  const rNet = await runNet('提示词 B');
  assert.equal(rNet.ok, false);
  assert.equal(rNet.error, 'network');
  assert.ok(rNet.message.includes('ECONNREFUSED'));

  const runEmpty = createOptimizeRunner({ file, env: {}, fetchImpl: fakeFetch(async () => okResponse('')) });
  const rEmpty = await runEmpty('提示词 C');
  assert.equal(rEmpty.ok, false);
  assert.equal(rEmpty.error, 'empty-result', '模型没吐东西要单独一个码');

  // 超时：10ms 的 settings + **完全不理会 signal、永不 settle 的**上游。
  // 这是最阴的一种：只靠 abort() 是掐不断的，必须由内部的 guard 兜底 ——
  // 没有它这条 await 会永远悬着（整套测试就挂在这一行上）。
  writeSettings({ deepseekApiKey: 'sk-test', timeoutMs: 10 , iterateRounds: 1 });
  const runTimeout = createOptimizeRunner({
    file,
    env: {},
    fetchImpl: () => new Promise(() => {}),
  });
  const rTimeout = await runTimeout('提示词 D');
  assert.equal(rTimeout.ok, false);
  assert.equal(rTimeout.error, 'timeout');
  assert.ok(rTimeout.message.includes('秒'), '超时要说清等了多久');

  // 没有 fetch 的运行环境
  const noFetch = createOptimizeRunner({ file, env: {}, fetchImpl: null });
  const rNoFetch = await noFetch('提示词 E');
  assert.equal(rNoFetch.ok, false);
  assert.equal(rNoFetch.error, 'no-fetch');
}

// ── 9. 缓存 key：不同原文不串、相同原文稳定 ────────────────────────────────
{
  assert.equal(hashText('abc'), hashText('abc'), '同样的原文 hash 要稳定');
  assert.notEqual(hashText('abc'), hashText('abd'), '差一个字就不能串缓存');
  assert.notEqual(hashText('abc'), hashText('abcabc'), '长度参与 hash');
}

// ── 10. 缓存键必须含配置：换了模型/思考档/端点都不能吃到旧结果 ──────────────
// 曾经的真 bug：键只散列原文 → 用户改完 model，5 分钟内拖同一段文字，
// 拿到的还是旧模型的稿子，而且完全看不出哪里错了。
{
  const settingsA = readSettings(path.join(tmp, 'nope.json'), {});
  const settingsB = { ...settingsA, model: 'deepseek-flash' };
  const settingsC = { ...settingsA, reasoningEffort: '' };
  const settingsD = { ...settingsA, baseUrl: 'https://other.example' };

  assert.equal(
    cacheKeyFor(settingsA, '同一段'),
    cacheKeyFor(settingsA, '同一段'),
    '同配置同原文：键必须稳定（否则缓存永远不命中，等于没缓存）',
  );
  assert.notEqual(cacheKeyFor(settingsA, '同一段'), cacheKeyFor(settingsB, '同一段'), '换 model 必须失效');
  assert.notEqual(cacheKeyFor(settingsA, '同一段'), cacheKeyFor(settingsC, '同一段'), '换 reasoningEffort 必须失效');
  assert.notEqual(cacheKeyFor(settingsA, '同一段'), cacheKeyFor(settingsD, '同一段'), '换 baseUrl 必须失效');
  assert.notEqual(cacheKeyFor(settingsA, '同一段'), cacheKeyFor(settingsA, '另一段'), '换原文当然也失效');

  // 端到端：真的换一次 settings 文件，同一段原文必须重新打上游
  writeSettings({ deepseekApiKey: 'sk-test', model: 'model-A' , iterateRounds: 1 });
  const fetchSwap = fakeFetch(async () => okResponse('背景：换了模型的稿子'));
  const swapRun = createOptimizeRunner({ file, env: {}, fetchImpl: fetchSwap });
  const first = await swapRun('可复用的原文');
  assert.equal(first.ok, true);
  assert.equal(fetchSwap.calls.length, 1);

  const cachedHit = await swapRun('可复用的原文');
  assert.equal(cachedHit.cached, true, '同配置要命中缓存');
  assert.equal(fetchSwap.calls.length, 1);

  writeSettings({ deepseekApiKey: 'sk-test', model: 'model-B' , iterateRounds: 1 });
  const afterSwap = await swapRun('可复用的原文');
  assert.equal(afterSwap.cached, undefined, '换模型后不能自称 cached');
  assert.equal(fetchSwap.calls.length, 2, '换模型必须重新打上游（旧模型的结果不能串过来）');
}

// ── 11. 截断守卫：finish_reason 非 stop 的结果一律不交付 ────────────────────
// 半截提示词写回文本框是静默事故——用户拿着残缺的稿子去问模型，错查不到优化器头上。
{
  writeSettings({ deepseekApiKey: 'sk-test' , iterateRounds: 1 });

  const finishResponse = (finish, content) => ({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ finish_reason: finish, message: { content } }] }),
  });

  const runLen = createOptimizeRunner({
    file,
    env: {},
    fetchImpl: fakeFetch(async () => finishResponse('length', '写到一半的提示词')),
    retryDelayMs: -1,
  });
  const rLen = await runLen('会超长的原文');
  assert.equal(rLen.ok, false, 'finish_reason=length 不能交付');
  assert.equal(rLen.error, 'finish-length');
  assert.ok(rLen.message.includes('截断'), `要说是截断：${rLen.message}`);

  const runFilter = createOptimizeRunner({
    file,
    env: {},
    fetchImpl: fakeFetch(async () => finishResponse('content_filter', '')),
    retryDelayMs: -1,
  });
  const rFilter = await runFilter('被过滤的原文');
  assert.equal(rFilter.ok, false);
  assert.equal(rFilter.error, 'finish-content_filter');
  assert.ok(rFilter.message.includes('finish_reason'), '要给出可诊断的字段');

  // finish_reason=stop（正常收束）与老端点不回该字段 → 照常交付
  const runStop = createOptimizeRunner({
    file,
    env: {},
    fetchImpl: fakeFetch(async () => finishResponse('stop', '背景：A\n任务：B')),
    retryDelayMs: -1,
  });
  const rStop = await runStop('正常收束的原文');
  assert.equal(rStop.ok, true, 'finish_reason=stop 要照常交付');

  const runNoFinish = createOptimizeRunner({
    file,
    env: {},
    fetchImpl: fakeFetch(async () => okResponse('背景：A')),
    retryDelayMs: -1,
  });
  const rNoFinish = await runNoFinish('不回 finish_reason 的老端点');
  assert.equal(rNoFinish.ok, true, '缺 finish_reason 不能误杀（兼容老端点）');
}

// ── 12. HTTP 429 自动重试一次；其他错误不重试 ──────────────────────────────
// 限流请求没被计费 → 重试零成本；retryDelayMs: 0 = 立即重试（测试不等真实延迟）。
{
  writeSettings({ deepseekApiKey: 'sk-test' , iterateRounds: 1 });

  // 第一次 429、第二次成功 → 用户什么都不用做
  let sequence = 0;
  const flaky = fakeFetch(async () => {
    sequence += 1;
    return sequence === 1 ? errorResponse(429, 'Rate limit') : okResponse('背景：重试成功');
  });
  const runRetry = createOptimizeRunner({ file, env: {}, fetchImpl: flaky, retryDelayMs: 0 });
  const rRetry = await runRetry('限流一次的原文');
  assert.equal(rRetry.ok, true, '429 后自动重试要成功');
  assert.equal(flaky.calls.length, 2, '恰好重试一次');
  assert.equal(rRetry.optimized, '背景：重试成功');

  // 连续两次 429 → 放弃并报「太频繁」，总共只打两次
  const always429 = fakeFetch(async () => errorResponse(429, 'Rate limit'));
  const runDouble = createOptimizeRunner({ file, env: {}, fetchImpl: always429, retryDelayMs: 0 });
  const rDouble = await runDouble('一直限流的原文');
  assert.equal(rDouble.ok, false);
  assert.equal(rDouble.error, 'http-429');
  assert.ok(rDouble.message.includes('太频繁'), '两次都限流要说人话');
  assert.equal(always429.calls.length, 2, '只重试一次，不能无限打');

  // 401 不重试（重试也没用，还多打一次）
  const fail401 = fakeFetch(async () => errorResponse(401, 'Invalid API key'));
  const runNoRetry401 = createOptimizeRunner({ file, env: {}, fetchImpl: fail401, retryDelayMs: 0 });
  await runNoRetry401('key 错的原文');
  assert.equal(fail401.calls.length, 1, '401 不该重试');

  // retryDelayMs 负数 = 显式禁用重试
  const offRetry = fakeFetch(async () => errorResponse(429, 'Rate limit'));
  const runOff = createOptimizeRunner({ file, env: {}, fetchImpl: offRetry, retryDelayMs: -1 });
  const rOff = await runOff('禁用重试的原文');
  assert.equal(rOff.error, 'http-429');
  assert.equal(offRetry.calls.length, 1, '负延迟要禁用重试');
}

// ── 13. usage 透传与「无改动」检测 ─────────────────────────────────────────
{
  writeSettings({ deepseekApiKey: 'sk-test' , iterateRounds: 1 });

  // pickUsage：官方非流式响应必有 usage；取不到给 null，坏数据不炸
  assert.deepEqual(
    pickUsage({ usage: { prompt_tokens: 120, completion_tokens: 80, total_tokens: 200 } }),
    { prompt: 120, completion: 80, total: 200 },
  );
  assert.deepEqual(
    pickUsage({ usage: { prompt_tokens: 10, completion_tokens: 5 } }),
    { prompt: 10, completion: 5, total: 15 },
    '缺 total_tokens 时自己加出来',
  );
  assert.equal(pickUsage({}), null, '没有 usage → null');
  assert.equal(pickUsage(null), null);
  assert.equal(pickUsage({ usage: '不是对象' }), null, '坏 usage → null 而不是炸');
  assert.deepEqual(
    pickUsage({ usage: { prompt_tokens: '12', completion_tokens: null, total_tokens: 20 } }),
    { prompt: 12, completion: 0, total: 20 },
    '字段类型不对时容错（字符串数字能收，null 归 0）',
  );

  // 运行器：上游给了 usage → 结果带出来；没给 → null
  const withUsage = fakeFetch(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ finish_reason: 'stop', message: { content: '背景：A' } }],
      usage: { prompt_tokens: 300, completion_tokens: 150, total_tokens: 450 },
    }),
  }));
  const runUsage = createOptimizeRunner({ file, env: {}, fetchImpl: withUsage, retryDelayMs: -1 });
  const rUsage = await runUsage('带用量的原文');
  assert.equal(rUsage.ok, true);
  assert.deepEqual(rUsage.usage, { prompt: 300, completion: 150, total: 450 });
  assert.equal(rUsage.unchanged, false, '内容变了就不是 unchanged');

  // 缓存命中：不带 usage（没花钱，显示一个「上次的」数字是误导）
  const rCachedUsage = await runUsage('带用量的原文');
  assert.equal(rCachedUsage.cached, true);
  assert.equal(rCachedUsage.usage, undefined, '缓存命中不带 usage');

  // 无改动：模型原样返回 → unchanged，客户端不写回也不问撤销
  const sameText = '背景：清晰的提示词';
  const noChange = fakeFetch(async () => okResponse(sameText));
  const runSame = createOptimizeRunner({ file, env: {}, fetchImpl: noChange, retryDelayMs: -1 });
  const rSame = await runSame(sameText);
  assert.equal(rSame.ok, true);
  assert.equal(rSame.unchanged, true, '原文照返要标 unchanged');
  assert.equal(rSame.optimized, sameText);

  const rSameCached = await runSame(sameText);
  assert.equal(rSameCached.cached, true, '无改动的结果也进缓存（省一次钱）');
  assert.equal(rSameCached.unchanged, true, '缓存命中也要把 unchanged 带出去');
}

// ── 14. 系统提示词 v2：关键约束必须在场 ────────────────────────────────────
// 这些句子是优化质量的护栏；哪天手滑删掉一条，这里会立刻红。
{
  const p = SYSTEM_PROMPT;
  assert.ok(p.includes('不改变原意'), '第 1 条：不改原意');
  assert.ok(p.includes('一律不添'), '第 2 条：不编造事实');
  assert.ok(p.includes('列出'), '第 3 条：可选路径列出而非暗自选定');
  assert.ok(p.includes('同量级'), '第 4 条：篇幅同量级');
  assert.ok(p.includes('不许丢'), '第 4 条：细节不许丢');
  assert.ok(p.includes('背景 / 任务 / 要求 / 输出'), '第 5 条：分层骨架');
  assert.ok(p.includes('代码片段') && p.includes('代码块'), '第 6 条：代码要保留且放回代码块');
  assert.ok(p.includes('只输出改写后的提示词正文'), '最后一条：只输出正文');
  assert.ok(!p.includes('```'), '系统提示词自己不能带代码块（会诱导模型包壳）');
  assert.ok(p.includes(PROMPT_OPEN) && p.includes(PROMPT_CLOSE), '第 7 条：要求用标记包住正文');
  assert.ok(p.includes('思考过程'), '第 8 条：明确思考要放标记外');
}

// ── 15. 三版优化（optimize3）：并行、三偏向、部分失败也要把成功的带出来 ──────
{
  assert.deepEqual(VARIANT_KEYS, ['detailed', 'professional', 'auto'], '三版顺序固定');
  assert.equal(VARIANT_LABELS.detailed, '更详细');
  assert.equal(VARIANT_LABELS.professional, '更专业');
  assert.ok(VARIANT_LABELS.auto.includes('建议'), 'auto 版标签要带「建议」');
  // 三版系统提示词都在 SYSTEM_PROMPT 之上各自追加，且互不相同
  const sp = VARIANT_KEYS.map(systemPromptFor);
  assert.ok(sp.every((s) => s.startsWith(SYSTEM_PROMPT)), '每版都以基础提示词打底');
  assert.equal(new Set(sp).size, 3, '三版系统提示词互不相同');
  assert.ok(systemPromptFor('nope') === SYSTEM_PROMPT, '不认识的 key 回落基础提示词');
  // auto 版那句「建议：」必须被要求写在标记之内，否则会被 cleanOptimized 当标记外内容丢掉
  assert.ok(
    systemPromptFor('auto').includes('标记**之内**') && systemPromptFor('auto').includes('建议：'),
    'auto 版的建议行必须指明写在标记内',
  );

  // 假上游：按调用顺序回三版不同的稿子，记录每版的 system content
  let callIdx = 0;
  const seenSystem = [];
  const fakeFetch3 = async (url, opts) => {
    const body = JSON.parse(opts.body);
    seenSystem.push(body.messages[0].content);
    callIdx += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ finish_reason: 'stop', message: { content: `第${callIdx}版稿子` } }],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      }),
    };
  };
  writeSettings({ deepseekApiKey: 'sk-test', model: 'deepseek-v4-pro', reasoningEffort: 'max', iterateRounds: 1 });
  const run = createOptimizeRunner({ file, fetchImpl: fakeFetch3, now: () => 0, retryDelayMs: -1 });

  const result = await optimize3(run, '帮我写个脚本');
  assert.equal(result.ok, true, '三版都成功 → ok');
  assert.equal(result.variants.length, 3, '正好三版');
  assert.equal(result.variants[0].key, 'detailed');
  assert.equal(result.variants[0].label, '更详细');
  assert.equal(result.variants[1].key, 'professional');
  assert.equal(result.variants[2].key, 'auto');
  // 三版各打了一次上游（并行，但调用数 = 3）
  assert.equal(seenSystem.length, 3, '三版各打一次上游');
  assert.equal(new Set(seenSystem).size, 3, '三版用了三个不同的系统提示词');
  // 每版都带了 usage
  assert.ok(result.variants.every((v) => v.usage && v.usage.total === 30), '每版带 usage');

  // 部分失败：第二版挂了，第一、三版成功 → ok:true，variants 只含成功的两版
  let callIdx2 = 0;
  const fakeFetch3b = async () => {
    callIdx2 += 1;
    if (callIdx2 === 2) {
      return { ok: false, status: 429, json: async () => ({ error: { message: 'rate limited' } }) };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: `ok${callIdx2}` } }], usage: null }),
    };
  };
  const run2 = createOptimizeRunner({ file, fetchImpl: fakeFetch3b, now: () => 0, retryDelayMs: -1 });
  const r2 = await optimize3(run2, '另一段原文');
  assert.equal(r2.ok, true, '有一版成功就 ok');
  assert.equal(r2.variants.length, 2, '挂掉那版不进 variants');
  assert.ok(r2.variants.every((v) => v.key !== 'professional'), '挂掉的是 professional 那版');

  // 全挂：ok:false + 一句能看懂的话
  const fakeFetch3c = async () => ({ ok: false, status: 401, json: async () => ({ error: { message: 'bad key' } }) });
  const run3 = createOptimizeRunner({ file, fetchImpl: fakeFetch3c, now: () => 0, retryDelayMs: -1 });
  const r3 = await optimize3(run3, '再一段');
  assert.equal(r3.ok, false, '三版全挂 → ok:false');
  assert.ok(typeof r3.message === 'string' && r3.message.length > 0, '全挂要带 message');
}

console.log('optimize.test.mjs: 配置 / 请求体 / 输出收敛 / 错误翻译 / 缓存与并发 全部通过');
console.log('  上游       : 全程假 fetch，测试不联网、不花钱');
console.log('  key 来源   : settings.json 优先，DEEPSEEK_API_KEY 兜底');
console.log(`  默认       : ${DEFAULTS.model} + reasoning_effort=${DEFAULTS.reasoningEffort}`);
console.log('  新增覆盖   : 缓存键含配置 / finish_reason 截断守卫 / 429 重试一次 / usage 透传 / unchanged / SYSTEM_PROMPT v2 / 三版并行 optimize3');
// ── 8. 迭代打磨（2026-10-23 用户要求）─────────────────────────────────────
{
  writeSettings({ deepseekApiKey: 'sk-iter', model: 'deepseek-v4-pro', iterateRounds: 2 });

  // 假上游：第 1 轮返回 A 稿，第 2 轮收到 A 稿后返回 B 稿
  let round = 0;
  const fetchIter = fakeFetch(async (url, options) => {
    round += 1;
    const body = JSON.parse(options.body);
    if (round === 1) {
      assert.match(body.messages[1].content, /【原始提示词】/, '首轮用户消息要用【原始提示词】前缀');
      return okResponse('<<<PROMPT>>>\n背景：A\n<<<END>>>');
    }
    assert.match(body.messages[1].content, /【上一轮优化稿】/, '迭代轮用户消息要用【上一轮优化稿】前缀');
    assert.match(body.messages[0].content, /迭代打磨/, '迭代轮系统提示词要追加 ITERATION_SUFFIX');
    return okResponse('<<<PROMPT>>>\n背景：B\n<<<END>>>');
  });
  const runIter = createOptimizeRunner({ file, env: {}, fetchImpl: fetchIter });
  const result = await runIter('原始提示词');
  assert.equal(result.ok, true);
  assert.equal(result.optimized, '背景：B', '最终稿是第 2 轮的输出');
  assert.equal(result.rounds, 2, '要报迭代轮数');
  assert.equal(fetchIter.calls.length, 2, '两轮 = 两次上游调用');

  // 第 1 轮 unchanged → 不再迭代
  round = 0;
  const fetchStop = fakeFetch(async () => okResponse('<<<PROMPT>>>\n原文\n<<<END>>>'));
  writeSettings({ deepseekApiKey: 'sk-iter', model: 'deepseek-v4-pro', iterateRounds: 2 });
  const runStop = createOptimizeRunner({ file, env: {}, fetchImpl: fetchStop });
  const stopResult = await runStop('原文');
  assert.equal(stopResult.ok, true);
  assert.equal(stopResult.rounds, 1, '首轮 unchanged 就停，不再迭代');
  assert.equal(fetchStop.calls.length, 1, 'unchanged 后不再打上游');

  // iterateRounds=1 → 旧行为（只一轮）
  round = 0;
  writeSettings({ deepseekApiKey: 'sk-iter', model: 'deepseek-v4-pro', iterateRounds: 1 });
  const fetchOne = fakeFetch(async () => okResponse('<<<PROMPT>>>\n单轮\n<<<END>>>'));
  const runOne = createOptimizeRunner({ file, env: {}, fetchImpl: fetchOne });
  const oneResult = await runOne('原文');
  assert.equal(oneResult.rounds, 1, 'iterateRounds=1 只跑一轮');
  assert.equal(fetchOne.calls.length, 1);

  // usage 累加：两轮各报 100/50 → 总和 200/100
  round = 0;
  const fetchUsage = fakeFetch(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content: '<<<PROMPT>>>\n稿\n<<<END>>>' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    }),
  }));
  writeSettings({ deepseekApiKey: 'sk-iter', model: 'deepseek-v4-pro', iterateRounds: 2 });
  const runUsage = createOptimizeRunner({ file, env: {}, fetchImpl: fetchUsage });
  const usageResult = await runUsage('原文');
  assert.equal(usageResult.usage.total, 300, '两轮 usage 要累加（150+150）');
}


fs.rmSync(tmp, { recursive: true, force: true });
