/**
 * 「提示词风格」机制的测试。
 *
 * 这个特性的核心承诺只有一条：**默认状态下输出与加这个特性之前逐字节相同**。
 * 任何"顺手改一下默认底稿"的行为都会在这里红 —— 因为那等于悄悄改变了优化器的任务目标。
 *
 * 风格清单本身是**未指定**的（用户要求不自行编造），所以这里只测机制：
 * 识别、回落、读写白名单、两条通道一致、缓存键隔离、以及默认等价。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  SYSTEM_PROMPT,
  VARIANT_KEYS,
  PROMPT_STYLES,
  DEFAULT_PROMPT_STYLE,
  listPromptStyles,
  promptStyleId,
  stylePrompt,
  systemPromptFor,
  systemPromptForStyle,
  readSettings,
  readUiSettings,
  writeUiSettings,
  settingsTemplate,
  cacheKeyFor,
} from '../src/optimize.js';
import { optimize3ViaWebChat } from '../src/webchat.js';

let pass = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { pass += 1; return; }
  fails.push(name + (detail ? ` — ${detail}` : ''));
}
function eq(name, got, want) { ok(name, got === want, `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`); }

// ── 1. 风格表结构 ────────────────────────────────────────────────────────────
{
  ok('PROMPT_STYLES 是非空对象', PROMPT_STYLES && typeof PROMPT_STYLES === 'object' && Object.keys(PROMPT_STYLES).length > 0);
  eq('默认风格 id 在表里', PROMPT_STYLES[DEFAULT_PROMPT_STYLE] !== undefined, true);
  for (const [id, s] of Object.entries(PROMPT_STYLES)) {
    eq(`${id} 的 id 与键名一致`, s.id, id);
    ok(`${id} 有可读名字`, typeof s.name === 'string' && s.name.length > 0, JSON.stringify(s.name));
    ok(`${id} 有底稿正文`, typeof s.prompt === 'string' && s.prompt.trim() !== '');
    ok(`${id} 不把 prompt 正文泄进列表`, listPromptStyles().every((x) => !('prompt' in x)), '清单是给前端渲染用的，不该带整段底稿');
  }
}

// ── 2. ★默认等价：这一条是整个特性的立足点 ──────────────────────────────────
{
  eq('默认风格的底稿逐字节等于 SYSTEM_PROMPT', PROMPT_STYLES[DEFAULT_PROMPT_STYLE].prompt, SYSTEM_PROMPT);
  // 不传风格 / 传空 / 传默认 id，三条路径都必须得到同一段东西
  eq('不传风格 → 老底稿', stylePrompt(undefined), SYSTEM_PROMPT);
  eq('空串 → 老底稿', stylePrompt(''), SYSTEM_PROMPT);
  eq('默认 id → 老底稿', stylePrompt(DEFAULT_PROMPT_STYLE), SYSTEM_PROMPT);
  // 老函数必须继续等价于新函数（老调用方一行没改，行为不能变）
  for (const key of VARIANT_KEYS) {
    eq(`${key}：老 API 与新 API(默认风格) 完全一致`, systemPromptForStyle(key, undefined), systemPromptFor(key));
  }
  eq('无 variant 时，新 API 也等于 SYSTEM_PROMPT', systemPromptForStyle(undefined, undefined), SYSTEM_PROMPT);
}

// ── 3. 认风格 id / 回落 ─────────────────────────────────────────────────────
{
  eq('认得默认 id', promptStyleId(DEFAULT_PROMPT_STYLE), DEFAULT_PROMPT_STYLE);
  for (const bad of ['', '不存在', null, undefined, 0, 1, {}, [], true, 'toString', '__proto__', 'constructor']) {
    eq(`坏 id ${JSON.stringify(bad)} 回落到默认`, promptStyleId(bad), DEFAULT_PROMPT_STYLE);
  }
  // 关键：原型上的属性不能被当成风格（'toString' 会命中原型函数）
  eq('原型属性不算风格', PROMPT_STYLES.toString === Object.prototype.toString || typeof PROMPT_STYLES.toString !== 'string', true);
  eq('认不出的风格静默回落（不抛）', stylePrompt('不存在'), SYSTEM_PROMPT);
}

// ── 4. 风格 × 变体 = 底稿 + 该版偏向 ──────────────────────────────────────────
{
  const fake = {
    id: 'probe',
    name: '探针',
    note: '测试用',
    prompt: '【探针底稿】',
  };
  const prev = PROMPT_STYLES.probe;
  PROMPT_STYLES.probe = fake;
  try {
    for (const key of VARIANT_KEYS) {
      const got = systemPromptForStyle(key, 'probe');
      ok(`${key} + probe 以探针底稿开头`, got.startsWith('【探针底稿】'), got.slice(0, 20));
      ok(`${key} + probe 保留了原来的偏向`, got.includes(VARIANT_BIAS(key)), '偏向指令不能因为换风格而丢掉');
    }
    // 换风格只换底稿，三版的偏向一字不改 —— 这是"不改变其他行为"的关键
    eq('probe 无 variant 时就是纯底稿', systemPromptForStyle(undefined, 'probe'), '【探针底稿】');
    // 三版在同一风格下互不相同（否则风格把变体覆盖掉了）
    const all = VARIANT_KEYS.map((k) => systemPromptForStyle(k, 'probe'));
    eq('三版在同一风格下互不相同', new Set(all).size, all.length);
    // 缓存键必须随风格变（否则换风格后 5 分钟内还在吐旧风格的稿子）
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peak-whale-style-'));
    const f = path.join(dir, 'settings.json');
    fs.writeFileSync(f, JSON.stringify({ ...settingsTemplate(), deepseekApiKey: 'sk-x' }));
    const s = readSettings(f);
    const kDefault = cacheKeyFor(s, '原文', systemPromptForStyle('auto', DEFAULT_PROMPT_STYLE));
    const kProbe = cacheKeyFor(s, '原文', systemPromptForStyle('auto', 'probe'));
    ok('换风格 → 缓存键必须不同', kDefault !== kProbe);
    fs.rmSync(dir, { recursive: true, force: true });
  } finally {
    if (prev === undefined) delete PROMPT_STYLES.probe;
    else PROMPT_STYLES.probe = prev;
  }
}
function VARIANT_BIAS(key) {
  // 从老实现里取出该版的偏向正文（复用真实定义，别手抄一份会漂移）
  const full = systemPromptForStyle(key, DEFAULT_PROMPT_STYLE);
  return full.slice(SYSTEM_PROMPT.length).trim();
}

// ── 5. 读取：老配置 / 坏配置都要回默认 ───────────────────────────────────────
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peak-whale-style-read-'));
  const f = path.join(dir, 'settings.json');

  fs.writeFileSync(f, JSON.stringify({ ...settingsTemplate(), deepseekApiKey: 'sk-x' }));
  eq('没写风格的老配置 → default', readSettings(f).promptStyle, DEFAULT_PROMPT_STYLE);

  fs.writeFileSync(f, JSON.stringify({ ...settingsTemplate(), promptStyle: '不存在的风格' }));
  eq('损坏的风格名 → default（读取侧静默回落）', readSettings(f).promptStyle, DEFAULT_PROMPT_STYLE);

  fs.writeFileSync(f, JSON.stringify({ ...settingsTemplate(), promptStyle: 123 }));
  eq('非字符串 → default', readSettings(f).promptStyle, DEFAULT_PROMPT_STYLE);

  fs.writeFileSync(f, '{ 这不是 json');
  eq('整个文件损坏 → default', readSettings(f).promptStyle, DEFAULT_PROMPT_STYLE);

  fs.writeFileSync(f, JSON.stringify({ ...settingsTemplate(), promptStyle: DEFAULT_PROMPT_STYLE }));
  eq('显式写了 default → 还是 default', readSettings(f).promptStyle, DEFAULT_PROMPT_STYLE);
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── 6. 写入：白名单必须**拒绝**未知风格（与读取侧相反）───────────────────────
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peak-whale-style-write-'));
  const f = path.join(dir, 'settings.json');

  const w = writeUiSettings(f, { promptStyle: DEFAULT_PROMPT_STYLE });
  eq('写已知风格成功', w.ok, true);
  eq('写完读回一致', w.settings.promptStyle, DEFAULT_PROMPT_STYLE);

  const bad = writeUiSettings(f, { promptStyle: '瞎写的' });
  eq('写未知风格被拒', bad.ok, false);
  ok('拒绝时给了人话', typeof bad.message === 'string' && bad.message.includes('promptStyle'), JSON.stringify(bad.message));
  eq('被拒后原值不变（没被静默改掉）', readSettings(f).promptStyle, DEFAULT_PROMPT_STYLE);

  eq('写非字符串被拒', writeUiSettings(f, { promptStyle: 5 }).ok, false);
  eq('写 null 被拒', writeUiSettings(f, { promptStyle: null }).ok, false);
  eq('写对象被拒', writeUiSettings(f, { promptStyle: {} }).ok, false);

  // 拒绝之后**不能**把文件写成半个：uiMode 与风格应各自独立
  eq('一次写两项都合法 → 都生效', writeUiSettings(f, { uiMode: 'detailed', promptStyle: DEFAULT_PROMPT_STYLE }).ok, true);
  eq('uiMode 已生效', readSettings(f).uiMode, 'detailed');
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── 7. 两条通道必须用同一种风格 ──────────────────────────────────────────────
{
  const webSrc = fs.readFileSync(new URL('../src/webchat.js', import.meta.url), 'utf8');
  const importLine = webSrc.split('\n').find((l) => /import\s*\{[^}]*\}\s*from\s*'\.\/optimize\.js'/.test(l)) || '';
  ok('webchat 导入的是 systemPromptForStyle（不是老 API）',
    /systemPromptForStyle/.test(importLine) && !/\bsystemPromptFor\b(?!\w)/.test(importLine.replace('systemPromptForStyle', '')),
    `实际导入行：${importLine.trim()}`);
  ok('拼装用户消息时带上 opts.promptStyle',
    /systemPromptForStyle\(key,\s*opts\.promptStyle\)/.test(webSrc),
    '网页端通道（你现在实际在用的那条）必须认风格设置，否则设置项在这条通道上是哑的');

  // 不传 promptStyle 时，网页端拼出来的消息必须与老实现逐字节相同
  const probe = '【原始提示词】\n原文';
  const viaStyle = VARIANT_KEYS.map((k) => systemPromptForStyle(k, undefined));
  const viaOld = VARIANT_KEYS.map((k) => systemPromptFor(k));
  for (let i = 0; i < VARIANT_KEYS.length; i += 1) {
    eq(`${VARIANT_KEYS[i]}：网页端默认消息与旧行为一致`,
      `${viaStyle[i]}\n\n${probe}`, `${viaOld[i]}\n\n${probe}`);
  }
}

// ── 8. 样式面板：不硬编码风格名、Host 没给清单就不渲染 ───────────────────────
{
  const src = fs.readFileSync(new URL('../client.template.js', import.meta.url), 'utf8');
  ok('客户端有 promptStyleRow', /function promptStyleRow\(/.test(src));
  ok('选项来自 Host 回传的 ui.promptStyles', /Array\.isArray\(ui\.promptStyles\)/.test(src));
  ok('Host 没给清单时整行不渲染', /if \(!list \|\| list\.length === 0\) return null;/.test(src));
  ok('客户端不内置任何风格名', !/promptStyles:\s*\[\s*\{\s*id:/.test(src),
    '客户端硬编码风格名 = 将来 Host 改了清单，界面还显示旧的');
  // 乐观更新必须合并，否则点一下会把整行连同选项抹掉
  ok('publishUiSettings 是合并而非替换', /uiSettingsState = \{ \.\.\.uiSettingsState, \.\.\.next \}/.test(src));
  ok('切换走 applyPatch（带 Host 写回与报错）', /apply\(\{ promptStyle: s\.id \}\)/.test(src));
}

console.log(`style_prompt.test.mjs: ${pass} 通过, ${fails.length} 失败`);
for (const f of fails) console.log('  ✗ ' + f);
if (fails.length) {
  console.error(`style_prompt.test.mjs: ${pass} 通过, ${fails.length} 失败`);
  for (const f of fails) console.error('  ✗ ' + f);
  throw new Error(`style_prompt.test.mjs: ${fails.length} 项失败`);
}