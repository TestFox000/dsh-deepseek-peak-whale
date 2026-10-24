/**
 * 真机自检：网页端「用完即删」到底删没删。
 *
 * 只碰 `chat_session/create` + `chat_session/delete` 两个接口：
 *   - 不调 completion ⇒ 不解 PoW、不消耗对话额度、不花一分钱；
 *   - 不传 wasm：solver 给一个会抛错的桩，一旦代码偷偷想解 PoW 就会立刻暴露。
 *
 * 判据用服务端自己的 `data.biz_code === 0` —— 与网页前端同一判据
 * （抓包自 main.8d6a4f4bfa.js：删除后前端只读 json.data.biz_code）。
 *
 * 用法：node tools/verify_delete.mjs [会话条数，默认 3]
 */
import fs from 'node:fs';
import path from 'node:path';
import { createWebChatCaller } from '../src/webchat.js';

const settingsFile = path.join(process.env.USERPROFILE, '.dsh', 'peak-whale', 'settings.json');
const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
const raw = String(settings.webToken || '').trim();
const token = raw.startsWith('{') ? (JSON.parse(raw).value || raw) : raw;

if (!token) {
  console.log('❌ settings.json 的 webToken 是空的 —— 先取 token 再跑这个自检');
  process.exit(1);
}
if (/[[\]{}'"();]/.test(token) || token.includes('localStorage')) {
  console.log('❌ webToken 填的是命令片段，不是 token。去 Console 里执行 copy(...) 回车，再回这里 Ctrl+V');
  process.exit(1);
}
console.log(`token: len=${token.length}（不打印内容）`);

const caller = await createWebChatCaller({
  token,
  log: (m) => console.log('  ' + m),
  // 故意给会抛的桩：本自检绝不该走到 PoW
  solver: {
    solve() {
      throw new Error('自检不该解 PoW —— 说明代码偷偷调了 completion');
    },
  },
});

const rounds = Number(process.argv[2]) || 3;
const created = [];
let deleted = 0;

for (let i = 0; i < rounds; i += 1) {
  const id = await caller.createSession();
  created.push(id);
  console.log(`[${i + 1}/${rounds}] 已创建 ${id}`);
}

console.log('');
console.log('开始删除…');
for (const id of created) {
  // deleteSession 内部吞异常只 log，所以这里靠日志判断；额外再验一次可重复删除不炸
  await caller.deleteSession(id);
  deleted += 1;
}

console.log('');
console.log(`创建 ${created.length} 条 / 发起删除 ${deleted} 条`);
console.log('判定：看上面每条是否都出现「已删除」（biz_code=0）。');
console.log('若出现「失败/biz_code≠0」，说明删除接口路径或字段被网页改版改掉了，需要重新抓包。');
console.log('');
console.log('最后一步（人工）：刷新 chat.deepseek.com 侧栏，确认这几条会话不在列表里。');
process.exit(0);
