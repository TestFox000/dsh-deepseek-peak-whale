/**
 * 构建：把两个「单一源」注入 client.template.js，产出 client.js。
 *
 *   1. `src/peak.js`           —— 峰谷判定逻辑。必须与 Host 半身的 /price 命令同源，
 *                                 手抄两份迟早漂移，所以由构建注入同一份源码。
 *   2. `vendor/pet-runtime.js` —— 鲸鱼桌宠运行时（rig + figure + pet-core + model.json
 *                                 + 50 张贴图的 data URI）。由 tools/vendor_pet.mjs 生成。
 *                                 这里再附加侧栏小图标的 data URI。
 *
 * 两个产物都必须是自包含的：浏览器半身不能 fetch（页面没有文件系统，也不起服务器）。
 *
 * 用法：node build.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const templatePath = join(here, 'client.template.js');
const outPath = join(here, 'client.js');

/** 在模板里用标记替换：把 build() 的产物塞进 begin/end 两个标记之间。 */
function inject(template, begin, end, build) {
  const beginIdx = template.indexOf(begin);
  const endIdx = template.indexOf(end);
  if (beginIdx === -1 || endIdx === -1 || endIdx < beginIdx) {
    throw new Error(`client.template.js 缺少 ${begin} / ${end} 注入标记`);
  }
  return (
    template.slice(0, beginIdx + begin.length) +
    '\n' +
    build() +
    '\n    ' +
    template.slice(endIdx)
  );
}

// ── 1. 峰谷核心逻辑 ──────────────────────────────────────────────────────────
const coreRaw = readFileSync(join(here, 'src', 'peak.js'), 'utf8');
// 去掉 ESM 的 `export ` 前缀：内联后这些声明就活在 factory 的函数作用域里。
const core = coreRaw.replace(/^export\s+(?=(const|let|var|function|class)\b)/gm, '');

const strayExport = core.split('\n').findIndex((line) => /^\s*export\b/.test(line));
if (strayExport !== -1) {
  throw new Error(
    `src/peak.js 第 ${strayExport + 1} 行仍有未被剥离的 export；` +
      '请只使用 `export const` / `export function` 形式',
  );
}
if (/^\s*import\b/m.test(core)) {
  throw new Error('src/peak.js 必须自包含：内联进浏览器 bundle 的代码不能有 import');
}

// ── 2. 鲸鱼桌宠运行时（vendor/pet-runtime.js）+ 侧栏图标 ─────────────────────
const runtimePath = join(here, 'vendor', 'pet-runtime.js');
let runtime;
try {
  runtime = readFileSync(runtimePath, 'utf8');
} catch (error) {
  throw new Error('缺少 vendor/pet-runtime.js，请先跑 `node tools/vendor_pet.mjs`');
}
// 运行时自带守卫，但这里再确认一次关键符号，避免「注入了空气」还能构建成功
for (const symbol of ['var PET_MODEL =', 'var PET_TEX =', 'var PET = (function']) {
  if (!runtime.includes(symbol)) {
    throw new Error(`vendor/pet-runtime.js 里找不到 ${symbol}，请重新运行 tools/vendor_pet.mjs`);
  }
}
if (/^\s*(import|export)\b/m.test(runtime)) {
  throw new Error('vendor/pet-runtime.js 不能含模块语法（必须是自包含脚本）');
}

const iconPath = join(here, 'vendor', 'icon.png');
const iconBuf = readFileSync(iconPath);
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
if (!iconBuf.subarray(0, 8).equals(PNG_MAGIC)) {
  throw new Error('vendor/icon.png 不是 PNG');
}
const iconUri = 'data:image/png;base64,' + iconBuf.toString('base64');

// 注入内容 = 运行时（缩进对齐）+ 图标
const runtimeLiteral =
  runtime
    .trimEnd()
    .split('\n')
    .map((line) => '    ' + line)
    .join('\n') +
  `\n    var WHALE_ICON_URI = ${JSON.stringify(iconUri)};`;

let out = readFileSync(templatePath, 'utf8');
out = inject(out, '/* __PEAK_CORE_BEGIN__ */', '/* __PEAK_CORE_END__ */', () => core.trimEnd());
out = inject(out, '/* __PET_RUNTIME_BEGIN__ */', '/* __PET_RUNTIME_END__ */', () => runtimeLiteral);

// ── 语法闸门（写盘之前） ──────────────────────────────────────────────────────
// CSS 是**模板字面量**：样式注释里打一个反引号就会把整个 bundle 截断成语法错误，
// 而这种错误在浏览器里表现为「同一个组合请求里的无辜包一起挂掉」，报错还指不到这里。
// `new Function` 只编译不执行，正好当构建期的一票否决。
try {
  // eslint-disable-next-line no-new-func
  new Function(out);
} catch (error) {
  throw new Error(
    `client.js 语法错误（多半是注释里的反引号把 CSS 模板字面量截断了）：${error.message}`,
  );
}

writeFileSync(outPath, out);

console.log('build.mjs: 已生成 client.js');
console.log(`  注入核心 : ${core.trim().split('\n').length} 行（src/peak.js）`);
console.log(`  注入桌宠 : ${(Buffer.byteLength(runtime) / 1024).toFixed(0)} KB（vendor/pet-runtime.js）`);
console.log(`  侧栏图标 : ${(iconBuf.length / 1024).toFixed(0)} KB（vendor/icon.png）`);
console.log(`  产物大小 : ${(Buffer.byteLength(out, 'utf8') / 1024).toFixed(0)} KB`);
