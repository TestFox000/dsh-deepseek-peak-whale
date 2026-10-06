/**
 * 提示词优化器测试：配置、请求体、输出收敛、错误翻译、缓存与并发。
 *
 * 为什么值得单独一套：这里**真的会花钱**——每拖一次就是一次 `deepseek-v4-pro`
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
  buildRequestBody,
  cleanOptimized,
  createOptimizeRunner,
  describeHttpError,
  ensureSettingsFile,
  hashText,
  readSettings,
  settingsPath,
  settingsTemplate,
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
  writeSettings({ deepseekApiKey: 'sk-file', model: 'm2', reasoningEffort: 'off', timeoutMs: 5 });
  const filled = readSettings(file, { DEEPSEEK_API_KEY: 'sk-env' });
  assert.equal(filled.apiKey, 'sk-file', '文件优先');
  assert.equal(filled.model, 'm2');
  assert.equal(filled.reasoningEffort, 'off', '可以关掉思考字段');
  assert.equal(filled.timeoutMs, 5);
  assert.equal(readSettings(file, {}).baseUrl, 'https://api.deepseek.com');
  assert.equal(readSettings(path.join(tmp, 'nope.json'), {}).apiKey, '', '没配就是空串');

  // baseUrl 的尾斜杠要吃掉，否则拼出 //chat/completions
  writeSettings({ baseUrl: 'https://x.example/' });
  assert.equal(readSettings(file, {}).baseUrl, 'https://x.example');

  // 模板：该有的字段都有，key 是空的
  const template = settingsTemplate();
  assert.equal(template.deepseekApiKey, '');
  assert.equal(template.model, DEFAULTS.model);
  assert.equal(template.reasoningEffort, DEFAULTS.reasoningEffort);
  assert.ok(Object.keys(template).some((k) => k.startsWith('_')), '模板里要有一句说明');
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
  assert.equal(body.model, 'deepseek-v4-pro');
  assert.equal(body.reasoning_effort, 'max', 'max 思考就是这个字段');
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

  writeSettings({ deepseekApiKey: 'sk-x', maxInputChars: 10 });
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
  writeSettings({ deepseekApiKey: 'sk-test', model: 'deepseek-v4-pro', reasoningEffort: 'max' });

  const fetchOk = fakeFetch(async () => okResponse('好的，以下是优化后的提示词：\n\n背景：A\n任务：B'));
  const run = createOptimizeRunner({ file, env: {}, fetchImpl: fetchOk });
  const result = await run('原始提示词');
  assert.equal(result.ok, true);
  assert.equal(result.optimized, '背景：A\n任务：B', '壳要剥干净再交给用户');
  assert.equal(result.model, 'deepseek-v4-pro');
  assert.equal(fetchOk.calls.length, 1);
  assert.equal(fetchOk.calls[0].url, 'https://api.deepseek.com/chat/completions');
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
  fs.writeFileSync(path.join(tmp, 'slow.json'), JSON.stringify({ deepseekApiKey: 'sk-slow' }));
  const slowRun = createOptimizeRunner({ file: path.join(tmp, 'slow.json'), env: {}, fetchImpl: fetchSlow });
  const [a, b] = await Promise.all([slowRun('并发原文'), slowRun('并发原文')]);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(fetchSlow.calls.length, 1, '同一段文字并发只打一次');
}

// ── 8. 运行器：上游的各种失败都要变成一句人话 ───────────────────────────────
{
  writeSettings({ deepseekApiKey: 'sk-test' });

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
  writeSettings({ deepseekApiKey: 'sk-test', timeoutMs: 10 });
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

fs.rmSync(tmp, { recursive: true, force: true });

console.log('optimize.test.mjs: 配置 / 请求体 / 输出收敛 / 错误翻译 / 缓存与并发 全部通过');
console.log('  上游       : 全程假 fetch，测试不联网、不花钱');
console.log('  key 来源   : settings.json 优先，DEEPSEEK_API_KEY 兜底');
console.log('  默认       : deepseek-v4-pro + reasoning_effort=max');
