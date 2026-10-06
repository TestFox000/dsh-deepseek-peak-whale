/**
 * 发布自检（+ 可选打包）。
 *
 *   node tools/pack.mjs --check    只自检
 *   node tools/pack.mjs            自检通过后打 tar.gz
 *
 * 为什么要它：发布事故里最贵的两类是「把用户密钥发上去」和「改了源码
 * 却忘了重建 client.js」。这个脚本把两者变成**可执行的红线**，
 * 而不只写在文档里。
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const checkOnly = process.argv.includes('--check');

const problems = [];
const notes = [];
const fail = (msg) => problems.push(msg);

// ── 1. 许可 ────────────────────────────────────────────────────────────────
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
if (pkg.license !== 'AGPL-3.0-or-later') {
  fail(`package.json 的 license 是 ${pkg.license}，应为 AGPL-3.0-or-later`);
}
for (const f of ['LICENSE', 'vendor/LICENSE-Coopanion-AGPL-3.0.txt']) {
  if (!existsSync(join(root, f))) fail(`缺少 ${f}`);
}

// ── 2. 遍历仓库文件（尊重 .gitignore 的关键几条） ──────────────────────────
const SKIP_DIRS = new Set(['.git', 'node_modules', '.idea', '.vscode']);
const SKIP_FILES = new Set(['.DS_Store', 'Thumbs.db']);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name) || SKIP_FILES.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const files = walk(root).map((f) => ({
  path: relative(root, f).split(sep).join('/'),
  full: f,
  size: statSync(f).size,
}));

// ── 3. 用户数据绝不入库 ────────────────────────────────────────────────────
const USER_DATA = [
  /^settings(\..+)?\.json$/i,
  /^wallet\..+\.json$/i,
  /\.corrupt-/i,
  /^\.env(\..+)?$/i,
  /\.pem$/i,
  /\.p12$/i,
  /^id_rsa/i,
  /^credentials\.json$/i,
  /^secrets\.json$/i,
];
for (const f of files) {
  const base = f.path.split('/').pop();
  if (USER_DATA.some((re) => re.test(base))) {
    fail(`疑似用户数据/凭据：${f.path}（必须从仓库移除）`);
  }
}

// ── 4. 硬编码密钥形态 ──────────────────────────────────────────────────────
// 只在**文本文件**里扫，且排除 vendor（上游原样内容）、client.js（由
// base64 data URI 组成，正则会误报）和测试（测试里的 key 都是显式假桩，
// 但仍要求它们看起来像假桩）。
const TEXT_EXT = /\.(js|mjs|json|yml|yaml|md|html|txt)$/i;
const VENDOR_RE = /^vendor\//;
const DERIVED = new Set(['client.js', 'vendor/pet-runtime.js']);
// DeepSeek 官方 key 前缀是 sk-；下面对每个命中做人工判定的注释理由。
const SECRET_RE = /sk-[A-Za-z0-9_\-]{20,}/g;
const KNOWN_FAKE = /sk-(secret|hacker|test|fake|env|example|dummy|not-a-real)[A-Za-z0-9_\-]*/i;

for (const f of files) {
  if (!TEXT_EXT.test(f.path)) continue;
  if (VENDOR_RE.test(f.path) || DERIVED.has(f.path)) continue;
  if (f.size > 4 * 1024 * 1024) continue;
  const text = readFileSync(f.full, 'utf8');
  for (const m of text.matchAll(SECRET_RE)) {
    const value = m[0];
    if (KNOWN_FAKE.test(value)) continue;
    const line = text.slice(0, m.index).split('\n').length;
    fail(`疑似硬编码真实 API key：${f.path}:${line}（${value.slice(0, 8)}…）`);
  }
}

// ── 5. client.js 必须与源码构建产物一致 ────────────────────────────────────
// 用户改 src/ 或 client.template.js 后忘了 rebuild，就会发布一份与源码
// 不符的产物——AGPL 要求的「对应源码」也就对不上了。
const before = readFileSync(join(root, 'client.js'));
execFileSync(process.execPath, ['build.mjs'], { cwd: root, stdio: 'pipe' });
const after = readFileSync(join(root, 'client.js'));
if (!before.equals(after)) {
  fail('client.js 与 `npm run build` 的产物不一致：请提交前跑一次 build');
}
notes.push(
  `client.js 与源码一致（sha256 ${createHash('sha256').update(after).digest('hex').slice(0, 16)}）`,
);

// ── 6. 测试 ────────────────────────────────────────────────────────────────
try {
  const out = execFileSync(process.execPath, ['test/run-all.mjs'], {
    cwd: root,
    encoding: 'utf8',
    stdio: 'pipe',
  });
  if (!/全部测试通过/.test(out)) {
    fail('测试输出里没有「全部测试通过」');
  } else {
    notes.push('全部测试通过');
  }
} catch (error) {
  fail(`测试失败：${(error.stdout || '') + (error.stderr || error.message)}`.slice(-600));
}

// ── 报告 ───────────────────────────────────────────────────────────────────
const total = files.reduce((n, f) => n + f.size, 0);
console.log('pack.mjs —— 发布自检');
console.log(`  版本    : ${pkg.name}@${pkg.version}`);
console.log(`  许可    : ${pkg.license}`);
console.log(`  仓库    : ${files.length} 个文件 / ${(total / 1024 / 1024).toFixed(1)} MB`);
for (const n of notes) console.log(`  ✓ ${n}`);

if (problems.length) {
  console.error('\n发布自检未通过：');
  for (const p of problems) console.error(`  ✗ ${p}`);
  process.exit(1);
}
console.log('\n发布自检通过 ✓');

if (checkOnly) process.exit(0);

// ── 打包 ───────────────────────────────────────────────────────────────────
const outDir = join(root, 'dist');
mkdirSync(outDir, { recursive: true });
const tarball = join(outDir, `${pkg.name}-${pkg.version}.tgz`);
execFileSync('tar', ['-czf', tarball, '-C', root,
  '--exclude=dist', '--exclude=.git', '--exclude=node_modules',
  '.'], { stdio: 'inherit' });
console.log(`\n已打包：${tarball}`);