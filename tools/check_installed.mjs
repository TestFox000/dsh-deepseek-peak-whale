// 校验「安装副本」是否可用：跑着的是这份，不是工作区源码。
//
// 为什么不能只查一个路径（2026-10-11 血泪）：这个插件在磁盘上有**两份**独立副本，
// 而 Host 真正 import 的是 pnpm-lock 里 `file:` 指向的那个**源目录**
// （`~/.dsh/local-packages/…`），不是 `profiles/desktop/node_modules/…`。
// 上一版只验后者 → 报 OK ✓ → 实际上线跑的是前者（旧代码，压根没有 deleteSession）
// → 会话一条都没删，还白绿了一整轮。
//
// 所以这里改成：枚举 ~/.dsh 下**所有**副本，逐个和工作区比哈希，
// 任何一处不一致就非 0 退出。
//
// 用法: node tools/check_installed.mjs
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const HOME = process.env.USERPROFILE || process.env.HOME;
const WS = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const FILES = ['index.js', 'client.js', 'package.json', 'src/optimize.js', 'src/webchat.js'];

const sha = (f) => {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex').slice(0, 16);
  } catch {
    return null;
  }
};

/** 递归找 ~/.dsh 下所有名为 dsh-deepseek-peak-whale 的目录（跳过备份目录）。 */
function findCopies(root) {
  const out = [];
  const stack = [root];
  let guard = 0;
  while (stack.length && guard < 20000) {
    guard += 1;
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const full = path.join(dir, e.name);
      if (e.name === 'dsh-deepseek-peak-whale') {
        out.push(full);
        continue; // 不再往里钻
      }
      if (e.name.startsWith('_bak-') || e.name === '.git' || e.name === 'vendor') continue;
      stack.push(full);
    }
  }
  return out;
}

const wsHashes = new Map(FILES.map((f) => [f, sha(path.join(WS, f))]));

console.log(`工作区真源 = ${WS}`);
console.log('');

/** pnpm-lock 告诉我们 Host 到底 import 哪份 —— 这才是「运行中」的那一个。 */
let resolvedFrom = null;
try {
  const lock = fs.readFileSync(path.join(HOME, '.dsh', 'profiles', 'desktop', 'pnpm-lock.yaml'), 'utf8');
  const m = lock.match(/specifier:\s*file:(\S*dsh-deepseek-peak-whale)/);
  if (m) resolvedFrom = m[1].replace(/\//g, path.sep);
} catch { /* 没 lock 文件就算了 */ }
if (resolvedFrom) console.log(`pnpm 解析源（Host 实际加载） = ${resolvedFrom}\n`);

const copies = findCopies(path.join(HOME, '.dsh')).filter((c) => path.resolve(c) !== WS);
if (copies.length === 0) {
  console.log('❌ 没找到任何安装副本');
  process.exit(1);
}

let bad = 0;
for (const copy of copies) {
  const rel = path.relative(path.join(HOME, '.dsh'), copy);
  const isRuntime = resolvedFrom && path.resolve(copy) === path.resolve(resolvedFrom);
  const tag = isRuntime ? ' ★RUNTIME' : '';
  const diffs = [];
  for (const f of FILES) {
    const h = sha(path.join(copy, f));
    if (h === null) { diffs.push(`${f}: 缺失`); continue; }
    if (h !== wsHashes.get(f)) diffs.push(`${f}: ${h} ≠ 工作区 ${wsHashes.get(f)}`);
  }
  if (diffs.length) bad += 1;
  console.log(`${diffs.length ? 'STALE' : 'SYNCED'} ${rel}${tag}`);
  for (const d of diffs) console.log(`        ${d}`);
}

// 功能自检：必须在 **RUNTIME 那份**（或第一份）上跑，验的是真会被执行的代码。
const target = (resolvedFrom && fs.existsSync(resolvedFrom) && copies.includes(path.resolve(resolvedFrom)))
  ? path.resolve(resolvedFrom)
  : copies[0];
console.log(`\n--- 在 ${path.relative(HOME, target)} 上验导出 ---`);

const index = await import(pathToFileURL(path.join(target, 'index.js')).href);
const optimize = await import(pathToFileURL(path.join(target, 'src', 'optimize.js')).href);
const webchat = await import(pathToFileURL(path.join(target, 'src', 'webchat.js')).href);

const CMD = "copy(JSON.parse(localStorage.getItem('userToken')).value)";
const REAL = 'a'.repeat(64);

/** 用桩构造 caller（solver + fetch 全假），只验方法存在，绝不联网。 */
async function callerSurface(webchat) {
  const caller = await webchat.createWebChatCaller({
    token: REAL,
    solver: { solve: async () => ({}) },
    fetchImpl: async () => { throw new Error('检查脚本不该联网'); },
  });
  return caller;
}

const caller = await callerSurface(webchat);
const checks = [
  ['index.createOptimize3Handler', typeof index.createOptimize3Handler === 'function'],
  ['optimize.tokenLooksLikeSnippet', typeof optimize.tokenLooksLikeSnippet === 'function'],
  ['optimize.readSettings', typeof optimize.readSettings === 'function'],
  ['webchat.createWebChatCaller', typeof webchat.createWebChatCaller === 'function'],
  ['webchat.optimize3ViaWebChat', typeof webchat.optimize3ViaWebChat === 'function'],
  ['caller.deleteSession', typeof caller.deleteSession === 'function'],
  ['caller.listSessions', typeof caller.listSessions === 'function'],
  ['粘错的命令被识别', optimize.tokenLooksLikeSnippet(CMD) === true],
  ['真 token 不被误伤', optimize.tokenLooksLikeSnippet(REAL) === false],
  ['appKit 包装能剥掉', optimize.unwrapStoredToken(`{"value":"${REAL}"}`) === REAL],
];
for (const [label, ok] of checks) {
  if (!ok) bad += 1;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}`);
}

// 直接读真 settings.json，报告当前配置状态（不打印 token 内容）
const settingsFile = path.join(HOME, '.dsh', 'peak-whale', 'settings.json');
try {
  const s = optimize.readSettings(settingsFile);
  console.log('');
  console.log(`settings.webToken        : len=${s.webToken.length} invalid=${s.webTokenInvalid}`);
  console.log(`settings.apiKey          : ${s.apiKey ? 'configured' : 'EMPTY'}`);
  console.log(`settings.keepWebSessions : ${s.keepWebSessions}`);
} catch (error) {
  console.log(`\nsettings 读取失败: ${error.message}`);
  bad += 1;
}

console.log('');
console.log(bad === 0 ? 'INSTALL COPY OK ✓' : `INSTALL COPY 有 ${bad} 项不对`);
process.exit(bad === 0 ? 0 : 1);
