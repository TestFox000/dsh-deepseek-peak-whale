// 端到端探针：直接打正在运行的 Host 的 optimize3 路由，打印**完整**响应体。
// 之前的教训：只看 payload.error 时，「成功」和「神秘失败」长得一模一样（都是 undefined）。
// 用法：node tools/probe_optimize3.mjs ["要优化的文本"]
const base = process.env.PEAK_WHALE_BASE || 'http://127.0.0.1:19387';
const text = process.argv[2] || '帮我看看这个日志文件里有什么问题';

const res = await fetch(`${base}/dsh-deepseek-peak-whale/api/optimize3`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ text }),
});

const raw = await res.text();
console.log('HTTP :', res.status);
let payload;
try {
  payload = JSON.parse(raw);
} catch {
  console.log('非 JSON 响应：');
  console.log(raw);
  process.exit(2);
}

// 逐版本打印，长文本不截断——要判断「有没有思考过程混进来」必须看全文。
console.log('ok    :', payload.ok);
if (payload.ok === false) {
  console.log('error :', payload.error);
  console.log('message:', payload.message);
}

const variants = Array.isArray(payload.variants) ? payload.variants : [];
console.log('variants:', variants.length);
const MARK = /<<<PROMPT>>>|<<<END>>>/;
const THINK = /<\/?think(?:ing)?>|思考过程|优化后的提示词/;
for (const v of variants) {
  const s = String(v.optimized ?? '');
  console.log('');
  console.log('── ' + (v.key ?? v.label ?? '?') + ' ──');
  console.log('len      :', s.length);
  console.log('有标记   :', MARK.test(s) ? '是 ← 不合格' : '否 ✓');
  console.log('有思考块 :', THINK.test(s) ? '是 ← 不合格' : '否 ✓');
  console.log('开头     :', JSON.stringify(s.slice(0, 40)));
  console.log('结尾     :', JSON.stringify(s.slice(-60)));
  console.log('全文 >>>');
  console.log(s);
}

if (Array.isArray(payload.deletedSessions)) {
  console.log('');
  console.log('deletedSessions:', payload.deletedSessions.length);
}
