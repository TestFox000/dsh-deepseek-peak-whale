/**
 * 把 Coopanion（AGPL-3.0）的鲸鱼桌宠运行时打包成一个自包含的 `vendor/pet-runtime.js`。
 *
 * 输入（全部在 vendor/ 下，已从上游复制）：
 *   rig.js      —— Live2D 式 WebGL2 渲染器（贴图网格 + 变形器链）
 *   figure.js   —— 鲸鱼模型（骨架、表情绘制、弹簧）
 *   pet-core.js —— 桌宠控制器（物理、动作、表情、漫游、指针交互、音效）
 *   model.json  —— 部件几何 / 枢轴 / 贴图清单
 *   tex/*.png   —— 默认配色（deepseek 蓝）的部件贴图
 *   feat/*.png  —— 眼睛 / 嘴 / 各表情贴图
 *
 * 输出 pet-runtime.js：
 *   var PET_MODEL = {...}   model.json 原样注入
 *   var PET_TEX   = {...}   50 张 WebP 的 data URI（key 与 figure.js 的 asset() 路径一致）
 *   var PET       = {createWhaleFigure, createPet, createSfx, MOTIONS, EXPRESSIONS, FACES}
 *
 * 为什么要手工拼而不是留 ESM：
 *   1. DSH 的浏览器半身是手写 factory（非模块），`import`/`import.meta` 是语法错误；
 *   2. 上游三个模块顶层名字会互相冲突（如 pet-core 的 `f`/`clamp`），各自包 IIFE 隔离；
 *   3. 贴图必须内联（页面没有文件系统，也不能起服务器），data URI 对 WebGL 不污染画布。
 *
 * 守卫：拼完仍出现行首 import/export、贴图缺失、PNG 魔数不对 —— 任一发生直接抛错，
 * 绝不产出一个「能在浏览器里静默坏掉」的 bundle。
 *
 * 用法：node tools/vendor_pet.mjs
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const vendor = join(root, 'vendor');
const outPath = join(vendor, 'pet-runtime.js');

function read(name) {
  return readFileSync(join(vendor, name), 'utf8');
}

/** 行首 import/export 必须清零——模块语法在 factory 里是解析错误。 */
function assertNoModuleSyntax(source, label) {
  const bad = source.match(/^[ \t]*(import|export)[ \t]/m);
  if (bad) {
    const line = source.split('\n').find((l) => /^[ \t]*(import|export)[ \t]/.test(l));
    throw new Error(`${label} 仍残留模块语法: ${line.slice(0, 120)}`);
  }
}

// ── 1. rig.js：只剥 export ---------------------------------------------------
let rig = read('rig.js');
rig = rig.replace(/^export (?=(?:async )?(?:function|const|class|let)\b)/m, '');
assertNoModuleSyntax(rig, 'rig.js');

// ── 2. figure.js：剥 import/export，并处理唯一的 import.meta -----------------
let figure = read('figure.js');
figure = figure.replace(/^[ \t]*import \{[^}]*\} from '[^']*';[ \t]*$/m, '');
// import.meta.url 只出现在默认参数里；我们总是显式传 base，把默认值换成字符串（解析安全）
figure = figure.replace(/new URL\('\.\/', import\.meta\.url\)/g, "'./'");
figure = figure.replace(/^export (?=(?:async )?(?:function|const|class|let)\b)/m, '');
if (/import\.meta/.test(figure)) throw new Error('figure.js 仍有未处理的 import.meta');
if (/^[ \t]*import[ \t]/m.test(figure)) throw new Error('figure.js 仍有 import 语句');
assertNoModuleSyntax(figure, 'figure.js');

// ── 3. pet-core.js：剥所有 export 前缀 ---------------------------------------
let core = read('pet-core.js');
core = core.replace(/^export (?=(?:async )?(?:function|const|class|let)\b)/gm, '');
assertNoModuleSyntax(core, 'pet-core.js');

// 导出面：client 只用这几个，缺一个就抛（防止上游改名导致静默失效）
for (const name of ['createPet', 'createSfx', 'MOTIONS', 'EXPRESSIONS', 'FACES']) {
  if (!new RegExp(`\\b(const|function) ${name}\\b`).test(core)) {
    throw new Error(`pet-core.js 里找不到 ${name}（上游改名了？）`);
  }
}

// ── 4. model.json + 贴图清单（与 figure.js 的 featNames 推导完全一致）---------
const model = JSON.parse(read('model.json'));
if (!Array.isArray(model.parts) || model.parts.length === 0) throw new Error('model.json 没有 parts');

const featNames = [
  ...Object.keys(model.feat.sprites),
  ...['eyeL', 'eyeR'].flatMap((k) =>
    ['lash', 'ball', 'iris', ...(model.feat.eyes[k].rim ? ['rim'] : [])].map((n) => `${k}_${n}`),
  ),
];
const wanted = [
  ...model.parts.map((p) => `tex/${p.tex}.png`),
  ...featNames.map((n) => `feat/${n}.png`),
];

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** WebP 魔数：RIFF....WEBP（第 0-3 字节 RIFF，第 8-11 字节 WEBP）。 */
const WEBP_MAGIC = Buffer.from([0x52, 0x49, 0x46, 0x46]);
const WEBP_BRAND = Buffer.from([0x57, 0x45, 0x42, 0x50]);
const WEBP_DATA_PREFIX = 'data:image/webp;base64,';

/**
 * 把一张 PNG 编码成 WebP（quality=85）。
 * 优先 sharp（本机 `npm install sharp`）；sharp 不可用时退回系统的 cwebp 命令行。
 * 两者都失败就抛——绝不产出一张「浏览器里静默坏掉」的贴图。
 */
async function encodeWebp(buf, key) {
  const errors = [];
  try {
    const sharpMod = await import('sharp');
    return await sharpMod.default(buf).webp({ quality: 85 }).toBuffer();
  } catch (error) {
    errors.push('sharp: ' + (error?.message ?? error));
  }
  try {
    return execFileSync('cwebp', ['-quiet', '-q', '85', '-stdout'], {
      input: buf,
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    errors.push('cwebp: ' + (error?.message ?? error));
  }
  throw new Error('贴图 ' + key + ' 转 WebP 失败 —— ' + errors.join('；'));
}

const tex = {};
let bytes = 0;
for (const key of wanted) {
  const file = join(vendor, key);
  if (!existsSync(file)) throw new Error('贴图缺失: ' + key);
  const buf = readFileSync(file);
  // 上游给的源图只认 PNG / WebP；魔数不对就报错，不猜。
  const isPng = buf.subarray(0, 8).equals(PNG_MAGIC);
  const isWebp = buf.subarray(0, 4).equals(WEBP_MAGIC) && buf.subarray(8, 12).equals(WEBP_BRAND);
  if (!isPng && !isWebp) throw new Error(key + ' 既不是 PNG 也不是 WebP（魔数不对）');
  // 内联前必须转成 WebP：PET_TEX 里的 data URI 一律是 image/webp。
  const webp = await encodeWebp(buf, key);
  if (!webp.subarray(0, 4).equals(WEBP_MAGIC) || !webp.subarray(8, 12).equals(WEBP_BRAND)) {
    throw new Error(key + ' 编码后不是 WebP（魔数不对）');
  }
  tex[key] = WEBP_DATA_PREFIX + webp.toString('base64');
  bytes += buf.length;
}
// 上游若新增/删除贴图，清单必须跟着动
const onDisk = [
  ...readdirSync(join(vendor, 'tex')).filter((f) => f.endsWith('.png')).map((f) => `tex/${f}`),
  ...readdirSync(join(vendor, 'feat')).filter((f) => f.endsWith('.png')).map((f) => `feat/${f}`),
];
const missing = onDisk.filter((k) => !wanted.includes(k));
if (missing.length) throw new Error(`vendor 里有未被 model.json 引用的贴图（清单要更新）: ${missing.join(', ')}`);

// ── 5. 拼装：三个模块各包 IIFE，顶层名字互不干扰 ----------------------------
const runtime = `/* 由 tools/vendor_pet.mjs 生成 —— 请勿手改。
 * 来源：github.com/Pal-AI-Lab/Coopanion（AGPL-3.0-or-later），
 * rig.js / figure.js / pet-core.js 原样拼接（仅剥 import/export），
 * 贴图为 data URI 内联。仅本机个人使用；对外分发需遵守 AGPL。 */
var PET_MODEL = ${JSON.stringify(model)};
var PET_TEX = ${JSON.stringify(tex)};
var PET = (function () {
  'use strict';
  var rig = (function () {
${rig}
    return { createRig: createRig };
  })();
  var figure = (function () {
    var createRig = rig.createRig; // 取代上游的 import 行
${figure}
    return { createWhaleFigure: createWhaleFigure };
  })();
  var core = (function () {
${core}
    return { createPet: createPet, createSfx: createSfx, EXPRESSIONS: EXPRESSIONS, MOTIONS: MOTIONS, FACES: FACES, GESTURES: GESTURES };
  })();
  return {
    createWhaleFigure: figure.createWhaleFigure,
    createPet: core.createPet,
    createSfx: core.createSfx,
    EXPRESSIONS: core.EXPRESSIONS,
    MOTIONS: core.MOTIONS,
    FACES: core.FACES,
    GESTURES: core.GESTURES,
  };
})();
`;

writeFileSync(outPath, runtime, 'utf8');
console.log('vendor_pet.mjs: 已生成 ' + outPath);
console.log(`  模块拼接 : rig ${(rig.length / 1024).toFixed(1)}KB + figure ${(figure.length / 1024).toFixed(1)}KB + pet-core ${(core.length / 1024).toFixed(1)}KB`);
console.log(`  贴图     : ${wanted.length} 张，源图 ${(bytes / 1024).toFixed(0)}KB → WebP base64 ${(Buffer.byteLength(JSON.stringify(tex)) / 1024).toFixed(0)}KB`);
console.log(`  产物大小 : ${(Buffer.byteLength(runtime, 'utf8') / 1024).toFixed(0)}KB`);