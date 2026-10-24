/**
 * 网页端会话取证 + 精确清理。
 *
 * 为什么需要：DSH 的 Host 日志不落盘（走 IPC），删除回执也不回传，所以
 * 「用完即删到底删没删」在本机毫无痕迹 —— 唯一权威裁判是服务端自己的列表。
 * 2026-10-11 就是靠这个才发现 Host 一直加载旧副本、会话一条都没删。
 *
 * 只碰 fetch_page / chat_session/delete 两个接口 ⇒ 不解 PoW、不耗对话额度。
 *
 * 用法：
 *   node tools/cleanup_web_sessions.mjs --list [分钟数]     # 只列最近 N 分钟的会话（默认 45）
 *   node tools/cleanup_web_sessions.mjs <id> [<id> ...]     # 精确删除指定 id，然后复查
 *
 * 故意不支持「按标题批量删」：标题是服务端自动生成的，撞车就会误删用户真对话。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createWebChatCaller } from '../src/webchat.js';

const sf = path.join(process.env.USERPROFILE, '.dsh', 'peak-whale', 'settings.json');
const s = JSON.parse(fs.readFileSync(sf, 'utf8'));
const raw = String(s.webToken || '').trim();
const token = raw.startsWith('{') ? (JSON.parse(raw).value || raw) : raw;
if (!token) { console.log('❌ webToken 为空'); process.exit(1); }

const caller = await createWebChatCaller({
  token,
  log: () => {},
  // 本工具绝不该走到 PoW：给个会抛的桩，一旦代码偷偷调 completion 就立刻暴露。
  solver: { solve() { throw new Error('不该解 PoW'); } },
});

const args = process.argv.slice(2);

if (args[0] === '--list') {
  const mins = Number(args[1]) || 45;
  const list = await caller.listSessions({ count: 100 });
  const now = Date.now() / 1000;
  const fresh = list.filter((x) => now - x.updatedAt < mins * 60);
  console.log(`服务端可见会话总数 = ${list.length}；最近 ${mins} 分钟 = ${fresh.length}`);
  for (const x of fresh) {
    console.log(`  ${x.id}  ${Math.round(now - x.updatedAt)}s前  ${x.title}`);
  }
  if (!fresh.length) console.log('  （无）');
  process.exit(0);
}

const ids = args.filter((a) => /[0-9a-f]{8}-/i.test(a));
if (!ids.length) {
  console.log('用法：--list [分钟]   或   <会话id...>');
  process.exit(1);
}

const before = await caller.listSessions({ count: 100 });
const beforeIds = new Set(before.map((x) => x.id));
console.log(`删除前：服务端 ${before.length} 条`);
let okCount = 0;
for (const id of ids) {
  const existed = beforeIds.has(id);
  const ok = await caller.deleteSession(id);
  if (ok) okCount += 1;
  console.log(`  ${ok ? '✅ 已删' : '❌ 失败'}  ${id}${existed ? '' : '  （服务端本来就没有）'}`);
}

await new Promise((r) => setTimeout(r, 1200));
const after = await caller.listSessions({ count: 100 });
const afterIds = new Set(after.map((x) => x.id));
const still = ids.filter((id) => afterIds.has(id));
console.log('');
console.log(`删除后：服务端 ${after.length} 条（${before.length} → ${after.length}）`);
console.log(still.length === 0
  ? `✅ 服务端复查：${ids.length} 条全部确认消失`
  : `❌ 仍有 ${still.length} 条在：${still.join(', ')}`);
process.exit(still.length === 0 ? 0 : 1);
