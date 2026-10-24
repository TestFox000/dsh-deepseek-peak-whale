/**
 * 服务端取证：网页端「用完即删」到底删干净没有。
 *
 * 为什么需要它：删除只写 Host 日志、不回传字段，而 DSH 的日志不落盘（走 IPC），
 * 所以「删了」这件事在本机没有任何可查痕迹。唯一权威裁判是服务端自己的会话列表。
 *
 * 做法：拉一次 history_sessions，把里面所有 chat_session_id 收集起来，
 *      再和「我们已知创建过的 id」求交集。交集为空 = 真的删干净了。
 *
 * 只读接口，不建会话、不调 completion ⇒ 不解 PoW、不消耗对话额度。
 *
 * 用法：
 *   node tools/verify_sessions_gone.mjs                 # 只看列表里有没有可疑残留
 *   node tools/verify_sessions_gone.mjs id1 id2 id3     # 精确判定这几个 id 是否已消失
 */
import fs from 'node:fs';
import path from 'node:path';
import { createWebChatCaller } from '../src/webchat.js';

const settingsFile = path.join(process.env.USERPROFILE, '.dsh', 'peak-whale', 'settings.json');
const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
const rawToken = String(settings.webToken || '').trim();
const token = rawToken.startsWith('{') ? (JSON.parse(rawToken).value || rawToken) : rawToken;

if (!token) {
  console.log('❌ webToken 为空，先填 token');
  process.exit(1);
}
if (/[[\]{}'"();]/.test(token) || token.includes('localStorage')) {
  console.log('❌ webToken 填的是命令片段，不是 token');
  process.exit(1);
}

const caller = await createWebChatCaller({
  token,
  log: () => {},
  solver: { solve() { throw new Error('本自检不该解 PoW'); } },
});

/** 直接复用 caller 内部的 fetch 封装：它已带好 Authorization / User-Agent / 重试。 */
const list = await caller.listSessions?.() ?? null;

if (!list) {
  console.log('⚠️ webchat.js 还没导出 listSessions —— 无法从服务端取证。');
  console.log('   退路：刷新 chat.deepseek.com 侧栏人工确认。');
  process.exit(2);
}

const ids = new Set();
const walk = (node) => {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) return node.forEach(walk);
  for (const [k, v] of Object.entries(node)) {
    if ((k === 'chat_session_id' || k === 'id') && typeof v === 'string') ids.add(v);
    else walk(v);
  }
};
walk(list);

const wanted = process.argv.slice(2).filter((a) => a.includes('-'));
console.log(`服务端当前可见会话数 = ${ids.size}`);

if (wanted.length === 0) {
  console.log('（未指定 id，只报总数。指定 id 可精确判定：node tools/verify_sessions_gone.mjs <id...>）');
  process.exit(0);
}

let stillThere = 0;
for (const id of wanted) {
  const alive = ids.has(id);
  if (alive) stillThere += 1;
  console.log(`  ${alive ? '❌ 仍在' : '✅ 已消失'}  ${id}`);
}
console.log('');
console.log(stillThere === 0
  ? `✅ 全部 ${wanted.length} 条已确认删除（服务端权威）`
  : `❌ ${stillThere}/${wanted.length} 条仍在服务端 —— 删除没生效`);
process.exit(stillThere === 0 ? 0 : 1);
