// 把工作区真源**同步到磁盘上的每一份安装副本**（先备份，再逐份校验）。
//
// 为什么需要单独一个同步脚本（2026-10-11 血泪）：
// 这个插件在磁盘上有**两份**独立副本 —— `~/.dsh/local-packages/…`（pnpm-lock 里
// `file:` 指向的源目录，**Host 真正 import 它**）与
// `~/.dsh/profiles/desktop/node_modules/…`。上一轮只改了后者 → 跑的还是前者
// → 会话一条没删、日志一切正常、`check_installed` 还报 OK ✓（因为它也只查一份）。
//
// 所以这里默认**同步所有副本**（不是"主要那个"），同步完逐份比哈希，
// 差一份就非 0 退出。备份目录名带时间戳，回滚直接整份覆盖回去。
//
// 用法:
//   node tools/sync_installed.mjs           备份 + 覆盖所有副本 + 校验
//   node tools/sync_installed.mjs --dry-run 只报告要改哪些，不动文件
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const WS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = process.env.USERPROFILE || process.env.HOME;
const DRY = process.argv.includes('--dry-run');

/** 要同步的文件：Host 半身全量 + 客户端产物 + 资源。vendor/ 是上游文件，不动。 */
const FILES = [
  'index.js',
  'client.js',
  'client.template.js',
  'package.json',
  'cordis.patch.yml',
  'icon.png',
  'README.md',
  'LICENSE',
  'src/optimize.js',
  'src/sessionllm.js',
  'src/webchat.js',
  'src/peak.js',
  'src/wallet.js',
  'src/official.js',
  'src/pow-solver.mjs',
];

const sha = (f) => {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex').slice(0, 16);
  } catch {
    return null;
  }
};

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

// pnpm-lock 告诉我们 Host 到底 import 哪份 —— 那一份标 ★RUNTIME 提醒别漏。
let runtime = null;
try {
  const lock = fs.readFileSync(path.join(HOME, '.dsh', 'profiles', 'desktop', 'pnpm-lock.yaml'), 'utf8');
  const m = lock.match(/specifier:\s*file:(\S*dsh-deepseek-peak-whale)/);
  if (m) runtime = m[1].replace(/\//g, path.sep);
} catch { /* 没 lock 文件就算了 */ }

const copies = findCopies(path.join(HOME, '.dsh')).filter((c) => path.resolve(c) !== WS);
if (copies.length === 0) {
  console.log('❌ 没找到任何安装副本');
  process.exit(1);
}

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
let touched = 0;
let bad = 0;

for (const copy of copies) {
  const rel = path.relative(path.join(HOME, '.dsh'), copy);
  const isRuntime = runtime && path.resolve(copy) === path.resolve(runtime);
  const tag = isRuntime ? ' ★RUNTIME' : '';

  const stale = FILES.filter((f) => sha(path.join(copy, f)) !== sha(path.join(WS, f)));
  if (stale.length === 0) {
    console.log(`SKIP   ${rel}${tag}（已一致）`);
  } else if (DRY) {
    console.log(`WOULD  ${rel}${tag} → ${stale.length} 个文件：${stale.join(', ')}`);
    touched += 1;
  } else {
    // 先备份**将要被覆盖**的那些文件（整目录备份太重，只留真正会变的）
    const bakDir = path.join(path.dirname(copy), `_bak-whale-${stamp}-${path.basename(path.dirname(copy))}`);
    for (const f of stale) {
      const src = path.join(copy, f);
      if (!fs.existsSync(src)) continue;
      const dst = path.join(bakDir, f);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
    }
    for (const f of stale) {
      const src = path.join(WS, f);
      const dst = path.join(copy, f);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
    }
    touched += 1;
    console.log(`SYNC   ${rel}${tag} → ${stale.length} 个文件（备份 ${path.basename(bakDir)}）`);
  }

  // 同步完立刻逐份校验：**不看退出码，看哈希**
  if (!DRY) {
    const diffs = FILES.filter((f) => sha(path.join(copy, f)) !== sha(path.join(WS, f)));
    if (diffs.length > 0) {
      bad += 1;
      console.log(`        ✗ 仍不一致：${diffs.join(', ')}`);
    }
  }
}

console.log('');
if (DRY) {
  console.log(`DRY-RUN：${touched} 份需要同步（没动任何文件）`);
} else if (bad > 0) {
  console.log(`❌ 同步了 ${touched} 份，但有 ${bad} 份仍不一致`);
  process.exit(1);
} else {
  console.log(`✓ 已同步并校验 ${copies.length} 份副本（其中 ${touched} 份本次更新）`);
}
