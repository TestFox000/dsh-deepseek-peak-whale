// 端到端验证：直接调用真正的 createOptimize3Handler（不是 DSH 里的路由），
// 用真实 settings.json 的 webToken 打真 DeepSeek 网页端，确认 webToken 分支生效。
import fs from 'node:fs';
import { Readable } from 'node:stream';
import { createOptimize3Handler } from '../index.js';

const settingsFile = process.env.USERPROFILE + '/.dsh/peak-whale/settings.json';
const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
console.log('settings.webToken 已配置:', settings.webToken ? 'YES (len=' + settings.webToken.length + ')' : 'NO');
console.log('settings.deepseekApiKey 已配置:', settings.deepseekApiKey ? 'YES' : 'NO');

const handler = createOptimize3Handler({
  // 故意给 optimize=null：如果处理器走错分支（回落 API-key 路径）会返回 503 unavailable。
  // 能拿到 200 + 3 版 = 说明确实走的是 webToken 网页端分支。
  optimize: null,
  settingsFile,
  wasmPath: process.env.TEMP + '/ds_pow.wasm',
  log: (m) => console.log('  [log] ' + m),
});

function makeReq(body) {
  const req = Readable.from([Buffer.from(JSON.stringify(body), 'utf8')]);
  req.method = 'POST';
  return req;
}

function runOnce(text) {
  return new Promise((resolve) => {
    const state = { status: 0, chunks: [] };
    const res = {
      writeHead(c) { state.status = c; return res; },
      setHeader() { return res; },
      end(chunk) {
        if (chunk) state.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8'));
        resolve({ status: state.status, body: Buffer.concat(state.chunks).toString('utf8') });
      },
    };
    handler(makeReq({ text }), res).catch((e) => resolve({ status: 500, body: JSON.stringify({ thrown: e.message }) }));
  });
}

const t0 = Date.now();
const r = await runOnce('帮我写个周报开头');
const ms = Date.now() - t0;

console.log('');
console.log('=== 处理器端到端：HTTP ' + r.status + '  耗时 ' + (ms / 1000).toFixed(1) + 's ===');
let parsed = null;
try { parsed = JSON.parse(r.body); } catch { /* ignore */ }
if (!parsed) { console.log('body:', r.body.slice(0, 500)); process.exit(1); }
console.log('ok =', parsed.ok);
if (parsed.variants) {
  console.log('variants =', parsed.variants.length, '→', parsed.variants.map((v) => v.key).join(','));
  for (const v of parsed.variants) {
    console.log('');
    console.log('【' + v.label + '】' + v.optimized.length + ' 字 | unchanged=' + v.unchanged);
    console.log(v.optimized.slice(0, 200).replace(/\n/g, ' ⏎ '));
  }
} else {
  console.log('message =', parsed.message);
}
console.log('');
console.log('判定:', r.status === 200 && parsed.ok && parsed.variants && parsed.variants.length === 3 ? '✅ PASS — webToken 网页端分支生效，3/3 版' : '❌ 未达预期');
