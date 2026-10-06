/**
 * 线上验证脚本：对小鲸鱼插件（v0.3.0+）的运行中实例做一轮只读+可控回滚的检查。
 *
 * 用法：node tools/verify_live.mjs [--base http://127.0.0.1:19387]
 *
 * 检查项：
 *   1. wallet 路由 200，且含余额 / 今日费用 / settings.uiMode；
 *   2. settings 路由 GET 200，字段完整（uiMode / optimizeEnabled / apiKeyConfigured）；
 *   3. settings POST 白名单：uiMode 往返（concise ↔ detailed）落盘并回读一致；
 *   4. 优化开关拦截：关 → optimize 返回 error:"disabled"；开 → 恢复；
 *   5. optimize 方法限定：GET → 405；空文本 → error:"empty"；
 *
 * 所有写操作最后都会恢复原值（round-trip + restore），对线上配置零残留。
 * 退出码：0 = 全过；1 = 有 FAIL；2 = 前置条件不满足（应用还没重启 → settings 404）。
 */
const base = (process.argv.includes('--base')
  ? process.argv[process.argv.indexOf('--base') + 1]
  : 'http://127.0.0.1:19387').replace(/\/+$/, '');

const PREFIX = '/dsh-deepseek-peak-whale/api';
const results = [];
const note = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? ` :: ${detail}` : ''}`);
};

const request = async (path, { method = 'GET', body } = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* 非 JSON */ }
  return { status: res.status, json };
};

const getSettings = async () => {
  const r = await request(`${PREFIX}/settings`);
  return r.status === 200 && r.json?.ok ? r.json.settings : null;
};
const postSettings = (patch) => request(`${PREFIX}/settings`, { method: 'POST', body: patch });

// ── 1. wallet ────────────────────────────────────────────────────────────────
{
  const r = await request(`${PREFIX}/wallet?locale=zh-CN`);
  if (r.status !== 200 || !r.json?.ok) {
    note('wallet 路由', false, `status=${r.status}`);
    console.log('\n应用尚未重启（或插件没挂上）：重启 DSH 后再跑一次。');
    process.exit(2);
  }
  const w = r.json;
  const bal = w.balance?.wallets?.find((x) => x.currency === 'CNY');
  note('wallet 路由 200 + 余额', !!bal, `CNY ${bal?.balance} / 今日 $${w.today?.usd} (${w.today?.requests} 次)`);
  note('wallet 载荷含 settings.uiMode', typeof w.settings?.uiMode === 'string', `uiMode=${w.settings?.uiMode}`);
}

// ── 2. settings GET ──────────────────────────────────────────────────────────
{
  const r = await request(`${PREFIX}/settings`);
  if (r.status !== 200 || !r.json?.ok) {
    note('settings GET 200', false, `status=${r.status}（待重启）`);
    console.log('\n前置条件不满足：settings 路由 404 —— 请重启 DSH 应用后重跑。');
    process.exit(2);
  }
  const s = r.json.settings;
  const keys = ['uiMode', 'optimizeEnabled', 'apiKeyConfigured'];
  note('settings GET 200 + 字段完整', keys.every((k) => k in s), JSON.stringify(s));
  if (typeof s.deepseekApiKey !== 'undefined') {
    note('API key 不回传浏览器', false, 'GET 载荷里出现了 deepseekApiKey！');
  } else {
    note('API key 不回传浏览器', true, '载荷里没有 deepseekApiKey ✓');
  }
  const original = { uiMode: s.uiMode, optimizeEnabled: s.optimizeEnabled };

  try {
    // ── 3. uiMode 往返 ───────────────────────────────────────────────────────
    {
      const w1 = await postSettings({ uiMode: 'concise' });
      const g1 = await getSettings();
      const w2 = await postSettings({ uiMode: 'detailed' });
      const g2 = await getSettings();
      note(
        'uiMode 往返（concise→detailed）落盘回读一致',
        w1.status === 200 && g1?.uiMode === 'concise' && w2.status === 200 && g2?.uiMode === 'detailed',
        `concise→${g1?.uiMode}，detailed→${g2?.uiMode}`,
      );
    }

    // ── 4. 开关拦截 ──────────────────────────────────────────────────────────
    {
      await postSettings({ optimizeEnabled: false });
      const g = await getSettings();
      const off = await request(`${PREFIX}/optimize`, { method: 'POST', body: { text: '测试' } });
      await postSettings({ optimizeEnabled: true });
      const g2 = await getSettings();
      note(
        '优化开关拦截（关→disabled→开恢复）',
        g?.optimizeEnabled === false && off.status === 200 && off.json?.error === 'disabled' && g2?.optimizeEnabled === true,
        `关时 optimize → ${off.json?.error}`,
      );
    }

    // ── 5. 方法限定与空文本 ──────────────────────────────────────────────────
    {
      const getOpt = await request(`${PREFIX}/optimize`);
      note('optimize 只收 POST（GET→405）', getOpt.status === 405, `status=${getOpt.status}`);
      const empty = await request(`${PREFIX}/optimize`, { method: 'POST', body: { text: '' } });
      note('空文本 → error:"empty"（不花钱）', empty.status === 200 && empty.json?.error === 'empty', `error=${empty.json?.error}`);
    }
  } finally {
    // ── 恢复原值（零残留）───────────────────────────────────────────────────
    await postSettings(original);
    const back = await getSettings();
    console.log(`\n  恢复原设置: uiMode=${back?.uiMode}, optimizeEnabled=${back?.optimizeEnabled}`);
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n结果: ${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length > 0 ? 1 : 0);
