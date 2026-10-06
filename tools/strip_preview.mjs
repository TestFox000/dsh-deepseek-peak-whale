/**
 * 状态条 + 账户卡片的可视化验证页（`node tools/strip_preview.mjs`）。
 *
 * 为什么要它：状态条是侧栏里巴掌大一块地方，「排版行不行」没法靠断言看出来——
 * 断言只能保证文字在，保证不了好不好看。这个脚本把组件用**测试里那套 React 桩**
 * 渲染成元素树，再序列化成静态 HTML（插件 CSS + 主题变量 + 真实数据），
 * 用无头 Edge 截图肉眼验收：
 *
 *   & '…\msedge.exe' --headless --disable-gpu --screenshot=… `
 *     --window-size=980,1240 --hide-scrollbars 'file:///…/assets/strip-preview.html'
 *
 * 覆盖四个状态：有数据（浅色/深色）、Host 半身还没加载（第二行应整行消失）、
 * 详情浮层的账户卡片、以及 404 时的提示文案。
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadClientBundle, withFakeNow } from '../test/helpers.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const { exports: plugin, React } = loadClientBundle();

/** 转义 HTML 文本与属性。 */
function esc(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const VOID = new Set(['img', 'br', 'hr', 'input']);

/** 把 React 桩的元素树序列化成 HTML（只认 DOM 类型，Fragment 展开）。 */
function serialize(node) {
  if (node === null || node === undefined || node === false || node === true) return '';
  if (typeof node === 'string' || typeof node === 'number') return esc(String(node));
  if (Array.isArray(node)) return node.map(serialize).join('');
  if (typeof node !== 'object') return '';
  const { type, props, children } = node;
  if (type === React.Fragment) return serialize(children);
  if (typeof type !== 'string') return `<!-- 非 DOM 组件 -->`;

  const attrs = [];
  for (const [key, value] of Object.entries(props || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'children' || key === 'ref') continue;
    if (typeof value === 'function') continue;
    if (key === 'className') {
      attrs.push(`class="${esc(value)}"`);
    } else if (key === 'style') {
      const css = Object.entries(value).map(([p, v]) => `${p}:${v}`).join(';');
      attrs.push(`style="${esc(css)}"`);
    } else if (value === true) {
      attrs.push(esc(key));
    } else {
      attrs.push(`${esc(key)}="${esc(String(value))}"`);
    }
  }
  const open = `<${type}${attrs.length ? ' ' + attrs.join(' ') : ''}>`;
  if (VOID.has(type)) return open;
  const inner = (children || []).map(serialize).join('');
  return `${open}${inner}</${type}>`;
}

/** 渲染状态条（wide=展开态）。 */
function strip({ wallet, wide = true, at = '2026-10-05T06:30:00Z' }) {
  plugin.setWalletState(wallet);
  return serialize(withFakeNow(at, () => plugin.PeakWhaleStrip({ wide })));
}

/** 渲染详情浮层里的内容（价格表 + 账户卡片）。`mode` 不传 = 详细版。 */
function popup(wallet, at = '2026-10-05T06:30:00Z', mode) {
  plugin.setWalletState(wallet);
  const nodes = withFakeNow(at, () => {
    const now = new Date(at);
    const state = plugin.summary(now);
    return plugin.details(now, state, plugin.describePeriod(state), wallet, mode);
  });
  return serialize(nodes);
}

const ready = {
  ok: true,
  nowMs: 0,
  profile: 'desktop',
  account: { status: 'credential-stored', topUpUrl: 'https://platform.deepseek.com/top_up', usageUrl: 'https://platform.deepseek.com/usage' },
  balance: {
    status: 'ready',
    wallets: [{ currency: 'USD', balance: '12.3456' }],
    bonus: [{ currency: 'USD', balance: '1.0000' }],
  },
  today: {
    date: '2026-10-05',
    usd: 0.0042,
    requests: 5,
    tokens: { uncachedInputTokens: 12000, outputTokens: 3400, cacheReadTokens: 800, cacheWriteTokens: 0 },
    isPeak: false,
  },
  note: 'estimate',
};

const notLoaded = { ok: false, unavailable: true, status: 404 };

const signedOut = {
  ok: true,
  account: { status: 'signed-out', topUpUrl: 'https://platform.deepseek.com/top_up', usageUrl: 'https://platform.deepseek.com/usage' },
  balance: { status: 'unknown' },
  today: ready.today,
};

const blocks = [
  ['A · 有数据（浅色）· 详细版', strip({ wallet: ready }), popup(ready), ''],
  ['B · 有数据（深色）· 详细版', strip({ wallet: ready }), popup(ready), ' dark'],
  ['A2 · 有数据（浅色）· 简洁版', strip({ wallet: ready }), popup(ready, undefined, 'concise'), ''],
  ['B2 · 有数据（深色）· 简洁版', strip({ wallet: ready }), popup(ready, undefined, 'concise'), ' dark'],
  ['C · Host 半身未加载（第二行应整行消失，而不是「不可用」）', strip({ wallet: notLoaded }), popup(notLoaded), ''],
  ['D · 未登录但有当日费用', strip({ wallet: signedOut }), popup(signedOut), ''],
];

const THEME = `
:root{
  --dsw-alias-bg-base:#ffffff; --dsw-alias-bg-layer-1:#f6f7f9; --dsw-alias-bg-layer-2:#eceef1;
  --dsw-alias-bg-overlay:#ffffff; --dsw-alias-border-l1:#e2e4e8; --dsw-alias-border-l2:#cfd3d9;
  --dsw-alias-brand-primary:#4d6bfe; --dsw-alias-label-primary:#16181d; --dsw-alias-label-secondary:#6b7280;
  --dsw-alias-state-error-primary:#e02b2b; --dsw-alias-state-idle-primary:#9aa0a8;
  --dsw-alias-state-success-primary:#1f9d55; --dsw-alias-state-warn-primary:#d9930a;
  --dsw-specific-sidebar-fill:#f5f6f8;
}
.dark{
  --dsw-alias-bg-base:#101114; --dsw-alias-bg-layer-1:#17191d; --dsw-alias-bg-layer-2:#1f2227;
  --dsw-alias-bg-overlay:#1b1e23; --dsw-alias-border-l1:#2a2e35; --dsw-alias-border-l2:#3a3f47;
  --dsw-alias-brand-primary:#7d93ff; --dsw-alias-label-primary:#eceef2; --dsw-alias-label-secondary:#9aa2ad;
  --dsw-alias-state-error-primary:#ff6b6b; --dsw-alias-state-idle-primary:#6b727d;
  --dsw-alias-state-success-primary:#3ddc84; --dsw-alias-state-warn-primary:#f0b429;
  --dsw-specific-sidebar-fill:#141619;
}
*{box-sizing:border-box}
body{margin:0;padding:18px;background:#dfe2e6;font-family:"Segoe UI","Microsoft YaHei",system-ui,sans-serif;font-size:13px}
section{margin-bottom:16px}
h2{font-size:12px;margin:0 0 8px;color:#3d434b;font-weight:600}
.side{width:264px;padding:8px;background:var(--dsw-specific-sidebar-fill);
  border:1px solid var(--dsw-alias-border-l1);border-radius:10px}
.dark .side{background:var(--dsw-specific-sidebar-fill)}
/* 与 .pw-pop 同尺寸（border-box、同内边距），这样预览里的表格宽度和真实浮层一致 */
.pop.pw-pop{position:static;left:auto;bottom:auto;z-index:auto}
.pop{width:420px;padding:12px 14px;box-sizing:border-box;
  border:1px solid var(--dsw-alias-border-l2);border-radius:12px;
  background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);
  font-size:12px;line-height:20px;box-shadow:0 10px 32px rgba(0,0,0,.18)}
.row{display:flex;gap:14px;align-items:flex-start;flex-wrap:wrap}
`;

const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>peak-whale strip preview</title>
<style>${THEME}${plugin.CSS}</style>
</head><body>
${blocks.map(([title, stripHtml, popHtml, theme]) => `
<section class="${theme.trim()}">
  <h2>${esc(title)}</h2>
  <div class="row">
    <div class="side">${stripHtml}</div>
    <div class="pw-pop pop">${popHtml}</div>
  </div>
</section>`).join('')}
</body></html>`;

const out = join(root, 'assets', 'strip-preview.html');
writeFileSync(out, html, 'utf8');
console.log('strip_preview.mjs: 已生成', out);
console.log('  截图：msedge --headless --disable-gpu --screenshot=… --window-size=980,1500 --hide-scrollbars file:///' + out.replace(/\\/g, '/'));
