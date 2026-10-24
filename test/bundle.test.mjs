/**
 * Bundle 形态测试：这些失败在浏览器里最难诊断，因为每种都表现为「别的东西坏了」。
 *
 *   · 少了 `__ModuleLoader__.load(...)` → 整个组合请求失败，报错会指向同组合里
 *     无辜的其它包，而不是这个文件。
 *   · 把「手写的 factory」而不是「插件的 apply」导出去 → 模块加载正常、factory 正常
 *     物化，Loader 调 `exports.apply(ctx)` 只是构造了个对象然后丢掉。不报错、不渲染。
 *   · 挂错插槽 → 组件写对了也不出现在界面上。
 *   · 运行时/贴图没真的注入 → 界面里只会看到一只透明的东西，或干脆什么都没有。
 *
 * 另外验证：桌面宠物组件在**没有 WebGL / Image 的环境**里必须优雅降级（只告警不抛），
 * 否则整个 shell.overlay 会跟着挂掉。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  NAME,
  ROOT,
  collectText,
  findAll,
  findByClass,
  loadClientBundle,
  withFakeNow,
} from './helpers.mjs';

const { registration, exports, doc, source, React, windowStub } = loadClientBundle();

// ── 1. 握手 ──────────────────────────────────────────────────────────────────
assert.ok(registration !== null, 'bundle 必须调用 window.__ModuleLoader__.load');
assert.equal(registration.id, NAME, '必须用包名注册');
assert.equal(typeof registration.factory, 'function', 'registration 必须有 factory');
assert.ok(source.includes('__PEAK_CORE_BEGIN__'), 'client.js 应保留核心注入标记');
assert.ok(source.includes('__PET_RUNTIME_BEGIN__'), 'client.js 应保留桌宠运行时注入标记');

// 开机自启问题的诊断信标：脚本执行 / 工厂物化 / apply / 每次挂载尝试都要打点。
// 真机「重启后不自启、开关插件才有」这类问题只能靠它定位（Host 侧 /api/diag 收）。
for (const phase of ['script-executed', 'factory-materialized', 'apply-start', 'mount-failed', 'mount-threw', 'inject-callback', 'retry-scheduled', 'mounted', 'apply-threw', 'step-threw', 'styles-done', 'layout-probe']) {
  assert.ok(source.includes(phase), `client.js 必须带上「${phase}」打点`);
}
assert.ok(source.includes('/dsh-deepseek-peak-whale/api/diag'), '打点要发到 Host 的诊断路由');
assert.ok(source.includes('keepalive'), '打点用 keepalive，页面切换也不丢');

// ── 2. 导出的是插件本身，不是手写 factory ─────────────────────────────────────
assert.ok(exports, 'factory 必须返回 module.exports');
assert.equal(typeof exports.apply, 'function', 'exports.apply 必须是函数');
assert.ok(Array.isArray(exports.inject), 'exports.inject 必须是数组');
assert.ok(exports.inject.includes('slots'), '插件需要 slots 服务');

// ── 3. 驱动 apply，观察三个挂载点都注册了 ──────────────────────────────────────
const seen = [];
const registeredOptions = {};
const slots = {
  inject(key, callback) {
    seen.push(`inject:${key}`);
    callback();
  },
  register(options) {
    seen.push(`register:${options.id}@${options.name}`);
    registeredOptions[options.name] = options;
    return () => {};
  },
};
let effects = 0;
const ctx = {
  get: (name) => (name === 'slots' ? slots : undefined),
  effect(fn) {
    effects += 1;
    return fn();
  },
};

exports.apply(ctx);

assert.equal(effects, 1, 'apply 应只装一个 effect（样式表）');
assert.ok(seen.includes('inject:sidebar.footer.action'), '必须挂载侧栏脚部价格条');
assert.ok(seen.includes('inject:shell.overlay'), '必须挂载全屏浮层里的鲸鱼娘');
assert.ok(seen.includes('register:peak-whale@sidebar.footer.action'), '价格条要注册到脚部动作区');
assert.ok(seen.includes('register:peak-whale-critter@shell.overlay'), '鲸鱼娘要注册到 shell.overlay');

// ── 3b. 设置页 tab：契约与 dsh-client-ui-settings-plugin-inventory 一致 ───────
assert.ok(seen.includes('inject:settings.plugins.tab'), '必须往「插件」设置页注册 tab');
assert.ok(seen.includes('register:peak-whale@settings.plugins.tab'), 'tab 的 id 与槽位名要对');
{
  const tab = registeredOptions['settings.plugins.tab'];
  assert.ok(tab, 'settings.plugins.tab 的注册项要留档');
  assert.equal(tab.id, 'peak-whale', 'tab id 唯一且稳定');
  assert.equal(typeof tab.order, 'number', 'tab 要有排序号');
  assert.equal(typeof tab.label, 'function', 'label 用函数（resolveSlotLabel 兼容）');
  assert.equal(tab.label(), '小鲸鱼', '标签文案');
}
assert.equal(doc.styles.length, 1, '样式表应被插入一次');
assert.equal(doc.styles[0].attrs['data-plugin'], 'dsh-deepseek-peak-whale', '样式表要带 data-plugin');
const css = doc.styles[0].textContent;

// ── 3c. 开机自启：清单形状 + slots 迟到/inject 两条路都要挂上，且不重复注册 ──// 真机症状：重启后小鲸鱼完全不出现，去插件页把插件关掉再打开才出来。
// 两个坑，一个已经踩实：
//   ① apply 里「拿不到 slots 就静默 return」——现在改成 立即试 → ctx.inject → 退避重试；
//   ② 清单里给 `immediately: true` 的客户端半身写非空 `inject`——**会让整个 bundle 的
//      组合层静默失败**（loader 里 include:peak-whale 直接消失，Host 路由与浏览器半身
//      一起没了）。2026-10-06 用「改字段→重挂→看 loader entries」A/B 实测确认，
//      所以这条不改逻辑，只把清单形状钉死。
{
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const client = manifest?.dsh?.client ?? {};
  assert.equal(client.platform, 'web', '客户端半身跑在 web 平台');
  assert.equal(client.immediately, true, '客户端半身要 immediately（浏览器一加载就投递）');
  assert.deepEqual(
    client.inject,
    [],
    'dsh.client.inject 必须为空：非空会让整个 bundle 组合静默失败（开机全不挂载）',
  );
}
{
  // ① slots 晚到：排队的重试要把它补上
  const lateSeen = [];
  const timers = [];
  const lateSlots = {
    inject(key, callback) { lateSeen.push(`inject:${key}`); callback(); },
    register(options) { lateSeen.push(`register:${options.id}@${options.name}`); return () => {}; },
  };
  const services = {}; // 一开始没有 slots
  const lateCtx = {
    get: (name) => services[name],
    effect: (fn) => fn(),
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
  };
  exports.apply(lateCtx);
  assert.equal(lateSeen.length, 0, 'slots 没就绪时先不注册');
  assert.ok(timers.length >= 1, '要排上迟到补挂的定时器（绝不能静默放弃）');

  services.slots = lateSlots;
  const queued = timers.splice(0);
  for (const run of queued) run();
  assert.ok(
    lateSeen.includes('register:peak-whale@sidebar.footer.action')
      && lateSeen.includes('register:peak-whale-critter@shell.overlay')
      && lateSeen.includes('register:peak-whale@settings.plugins.tab'),
    'slots 就绪后，三个挂载点都要补上',
  );
}
{
  // ② inject 路径：槽位树里服务名要对，且不会和重试打架重复注册
  const injSeen = [];
  const timers = [];
  let injected = null;
  const injSlots = {
    inject(key, callback) { injSeen.push(`inject:${key}`); callback(); },
    register(options) { injSeen.push(`register:${options.id}@${options.name}`); return () => {}; },
  };
  const injCtx = {
    get: () => undefined,
    effect: (fn) => fn(),
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    inject(names, callback) {
      injected = names;
      callback({ slots: injSlots });
    },
  };
  exports.apply(injCtx);
  assert.deepEqual(injected, ['slots'], 'inject 请求的正是 slots 服务');
  assert.equal(
    injSeen.filter((x) => x === 'register:peak-whale@sidebar.footer.action').length,
    1,
    'inject 挂上后，重试不能再来一遍（重复注册会在槽位里出现两份）',
  );
  const queued = timers.splice(0);
  for (const run of queued) run();
  assert.equal(
    injSeen.filter((x) => x === 'register:peak-whale@sidebar.footer.action').length,
    1,
    '迟到重试也不能重复注册（mounted 闸门）',
  );
}

// ── 3d. 开机自启的真凶：apply 里「可选步骤」抛异常把整个挂载带走 ──────────────
// 真机证据（2026-10-06 16:52 开机信标）：/api/diag 里只有 script-executed →
// factory-materialized → apply-start，既没有 mounted 也没有 mount-failed ——
// 说明 apply 在 apply-start 之后抛了，被外层 catch 静默吞掉，于是价格条 / 鲸鱼娘 /
// 设置页 tab 一个都没挂上；事后去插件页关掉再打开就好，因为那时 layout 已就绪。
// 下面用「恶意 ctx」把这个场景钉死在测试里：get('layout') 抛、layout 属性访问也抛。
function withBeaconCapture(fn) {
  const saved = globalThis.fetch;
  const beacons = [];
  globalThis.fetch = (url, init) => {
    try {
      beacons.push(JSON.parse(init.body));
    } catch {
      /* 打点体解析失败无所谓 */
    }
    return Promise.resolve({ ok: true });
  };
  try {
    return fn(beacons);
  } finally {
    globalThis.fetch = saved;
  }
}

{
  const hostileSeen = [];
  const hostileSlots = {
    inject(key, callback) { hostileSeen.push(`inject:${key}`); callback(); },
    register(options) { hostileSeen.push(`register:${options.id}@${options.name}`); return () => {}; },
  };
  const hostileCtx = {
    get(name) {
      if (name === 'slots') return hostileSlots;
      throw new Error(`service "${name}" is not available`);
    },
    effect() { throw new Error('effect 不可用'); },
    setTimeout() { return 0; },
  };
  Object.defineProperty(hostileCtx, 'layout', {
    get() { throw new Error('layout 属性访问炸了'); },
  });

  const beacons = withBeaconCapture((list) => {
    // 这一步**故意**让 effect 炸，pwStep 会 console.warn —— 测试期间静音，别刷屏
    const realWarn = console.warn;
    console.warn = () => {};
    try {
      exports.apply(hostileCtx);
    } finally {
      console.warn = realWarn;
    }
    return list.slice();
  });

  assert.ok(
    hostileSeen.includes('register:peak-whale@sidebar.footer.action'),
    '样式 / layout 步骤炸了，价格条也必须挂上（可选步骤不许拦住挂载）',
  );
  assert.ok(hostileSeen.includes('register:peak-whale-critter@shell.overlay'), '鲸鱼娘也必须挂上');
  assert.ok(hostileSeen.includes('register:peak-whale@settings.plugins.tab'), '设置页 tab 也必须挂上');
  const phases = beacons.map((b) => b.phase);
  assert.ok(phases.includes('mounted'), '挂载成功要打点 mounted');
  assert.ok(
    beacons.some((b) => b.phase === 'effect-threw'),
    'effect 通道炸了要有 effect-threw 打点（并直装样式兜底，界面不能裸奔）',
  );
  assert.equal(doc.styles.length, 1, '样式表仍然只有一份（幂等：兜底不能插出第二份）');
  const layoutThrew = beacons
    .filter((b) => b.phase === 'layout-get-threw' || b.phase === 'layout-prop-threw')
    .map((b) => b.phase);
  assert.ok(layoutThrew.length >= 2, `layout 两条取值路径都要各自 try 住，实际：${layoutThrew.join(',') || '(无)'}`);
  assert.ok(
    !phases.includes('apply-threw'),
    '可选步骤被各自 try 住后 apply 本体不该再往外抛 —— 抛了宿主只 console.warn，谁都看不见',
  );
}

// ── 3e. 槽位注册本身炸了：apply 必须活下来，并留下 mount-threw / mount-failed ──
{
  const throwingSlots = {
    inject() { throw new Error('slots.inject 炸了'); },
    register() { return () => {}; },
  };
  const throwingCtx = {
    get: (name) => (name === 'slots' ? throwingSlots : undefined),
    effect: (fn) => fn(),
    setTimeout: () => 0,
  };
  const beacons = withBeaconCapture((list) => {
    const realWarn = console.warn;
    console.warn = () => {};
    try {
      exports.apply(throwingCtx);
    } finally {
      console.warn = realWarn;
    }
    return list.slice();
  });
  const phases = beacons.map((b) => b.phase);
  assert.ok(phases.includes('mount-threw'), '挂载抛异常必须打点 mount-threw');
  assert.ok(phases.includes('mount-failed'), '挂载失败必须打点 mount-failed');
  assert.ok(!phases.includes('mounted'), '没挂上就不能谎报 mounted');
  assert.ok(!phases.includes('apply-threw'), 'apply 本体依然不能往外抛');
}

// ── 3e. layout 迟到：开机时没注册，之后才就绪 —— 按需解析必须那时才好用 ────────
{
  const services = {
    slots: {
      inject(key, callback) { callback(); },
      register() { return () => {}; },
    },
  };
  const lateCtx = {
    get: (name) => services[name],
    effect: (fn) => fn(),
    setTimeout: () => 0,
  };
  exports.apply(lateCtx);
  assert.equal(exports.openPluginsSettings(), false, 'layout 还没就绪时安静返回 false');

  const panelCalls = [];
  services.layout = { selectPanel: (id) => panelCalls.push(id) };
  assert.equal(exports.openPluginsSettings(), true, 'layout 就绪后要能按需解析到（不能缓存空结果）');
  assert.deepEqual(panelCalls, ['plugins'], '要跳到内置「插件」设置面板');

  // 收尾：把 ctx 换成中性的，别影响后面「没有 layout 服务」的断言
  exports.apply({ get: () => undefined, effect: (fn) => fn(), setTimeout: () => 0 });
  assert.equal(exports.openPluginsSettings(), false, '中性 ctx 下依旧安静失败');
}

// 桌宠层：整层穿透，只有命中区开回指针事件
assert.ok(/\.pw-roam\{[^}]*pointer-events:none/.test(css), '浮层根节点必须点击穿透');
assert.ok(
  /\.pw-hitbox\{[^}]*pointer-events:auto/.test(css),
  '命中区必须显式开回 pointer-events，否则拖不动她',
);
assert.ok(css.includes('.pw-stage{'), '应有 SVG 舞台样式');
// 右键菜单：同样必须显式开回指针事件（父级是 none）
assert.ok(css.includes('.pw-menu{'), '应有右键菜单样式');
assert.ok(css.includes('pw-menu-in'), '菜单应有入场动画');
assert.ok(
  /\.pw-menu-backdrop\{[^}]*pointer-events:auto/.test(css),
  '菜单必须显式打开 pointer-events —— 父级 .pw-roam 是 none，否则菜单能显示却点不动',
);
// 气泡位置由 ctl.anchor() 每帧写入，基础 transform 必须带位移
assert.ok(/\.pw-bubble\{[^}]*transform:translate\(-50%,-100%\)/.test(css), '气泡应锚在头顶上方');
assert.ok(/@keyframes pw-pop\{from\{[^}]*translate\(-50%,-100%\)/.test(css), '气泡入场帧要保留锚定位移');
// 旧的剪纸骨架 CSS 必须清干净，否则会留下永不生效的死样式
assert.ok(!css.includes('pwL-'), '旧的骨架关键帧应当已全部移除');
assert.ok(!css.includes('pw-layer'), '旧的骨架层样式应当已全部移除');
assert.ok(!css.includes('.pw-critter'), '旧的立绘容器样式应当已全部移除');

// 排版回归闸门：v0.4.1 起卡片改成**竖长**比例（宽度对齐侧栏 340px，高度 560px）。
// 价格表四列曾经在 340px 下被挤出卡片，所以现在靠「11px 字号 + 3px 内边距 + 第一列折行」
// 把它压进窄卡片里（肉眼验收见 tools/strip_preview.mjs 的截图）。
const popWidth = /\.pw-pop\{[^}]*width:(\d+)px/.exec(css);
assert.ok(popWidth !== null, '详情浮层必须写死宽度');
assert.equal(Number(popWidth[1]), 340, `竖长卡片宽度应为 340px，实际 ${popWidth && popWidth[1]}`);
const popHeight = /\.pw-pop\{[^}]*max-height:(\d+)px/.exec(css);
assert.ok(popHeight !== null, '详情浮层必须写死高度');
assert.ok(
  Number(popHeight[1]) > Number(popWidth[1]) * 1.4,
  `卡片要是竖长比例：高 ${popHeight && popHeight[1]}px 应明显大于宽 ${popWidth[1]}px`,
);
assert.ok(/\.pw-table\{[^}]*font-size:11px/.test(css), '窄卡片里的价格表要用 11px 字号');
assert.ok(/\.pw-table\{[^}]*table-layout:fixed/.test(css), '价格表要固定布局，四列才排得进 340px');
assert.ok(
  /\.pw-table th:first-child,\.pw-table td:first-child\{[^}]*white-space:normal/.test(css),
  '窄卡片里模型名要允许折行（数字列仍然 nowrap）',
);
// 账户第二行与卡片的样式也在（渲染断言在 5b 段）
assert.ok(/\.pw-wallet\{[^}]*border-top:1px solid/.test(css), '状态条第二行应有一条细分隔线');
assert.ok(css.includes('.pw-wallet-card{'), '详情浮层要有账户卡片样式');
assert.ok(css.includes('.pw-wallet-row--today{'), '当日费用行要有单独的强调样式');
// 优化气泡 / 撤销对话框和右键菜单是同一个坑：父层 .pw-roam 是 none，不显式开就是「看得见点不动」
assert.ok(
  /\.pw-opt\{[^}]*pointer-events:auto/.test(css),
  '优化气泡必须显式打开 pointer-events（√/× 才点得到）',
);
assert.ok(css.includes('.pw-opt[data-kind="error"]'), '失败态要能折行显示整句原因');
// v0.5.4：√撤销 / ×保留 两条样式已删，**并且要钉住它们不回来**。
// ⚠️ 断言必须剥掉 CSS 里的注释再查：否则"删掉了,因为…"这段解释文字本身
//    就含有那两个 class 名，断言会匹配到自己 —— 第一版就是这么写的，
//    结果永远红（自己给自己下的套）。同理，改文案时别把 class 名写进注释。
const CSS_NO_COMMENT = css.replace(/\/\*[\s\S]*?\*\//g, '');
assert.ok(!CSS_NO_COMMENT.includes('.pw-opt-yes'), '√ 撤销按钮样式不该回来（撤销询问已取消）');
assert.ok(!CSS_NO_COMMENT.includes('.pw-opt-no'), '× 保留按钮样式不该回来');
assert.ok(CSS_NO_COMMENT.includes('.pw-opt-close'), '「知道了」按钮的样式必须留着（它还在用）');
// 详情浮层：分节标题 + v0.4.0 的三点改版（开关挪进设置页 / 固定尺寸 / 亚克力 / 底部设置按钮）
assert.ok(!css.includes('.pw-seg-btn'), '浮层顶部不该再有简洁/详细模式开关样式（改到设置页里切）');
assert.ok(css.includes('.pw-set-btn'), '详细版底部要有「设置」按钮样式');
assert.ok(css.includes('.pw-actions'), '「设置」按钮要有摆位容器样式');
assert.ok(/\.pw-pop\{[^}]*max-height:\d+px/.test(css), '浮层要钉死高度（内容超出就在卡片内滚动）');
assert.ok(
  /\.pw-pop\{[^}]*backdrop-filter:blur\(\d+px\)/.test(css),
  '浮层要有亚克力效果（backdrop-filter 毛玻璃）',
);
assert.ok(css.includes('@supports not ((backdrop-filter'), '不支持 backdrop-filter 的浏览器要有兜底底色');
assert.ok(/\.pw-wallet-card\{[^}]*color-mix\(in srgb/.test(css), '账户卡片要半透明，毛玻璃才透得出来');
assert.ok(css.includes('.pw-sec{'), '详细版要有分节标题样式');
// 设置页样式
assert.ok(css.includes('.pw-settings'), '设置页要有样式');
assert.ok(css.includes('.pw-set-mode'), '设置页要有模式单选项样式');

// ── 4. 桌宠运行时与贴图真的被内联进 bundle ────────────────────────────────────
const PET_TEX_PREFIX = 'data:image/webp;base64,';
const ICON_PREFIX = 'data:image/png;base64,';
assert.ok(exports.PET && typeof exports.PET === 'object', 'PET 运行时必须存在');
for (const fn of ['createWhaleFigure', 'createPet', 'createSfx']) {
  assert.equal(typeof exports.PET[fn], 'function', `PET.${fn} 必须是函数`);
}
assert.ok(Array.isArray(exports.PET.MOTIONS) && exports.PET.MOTIONS.length > 5, 'PET.MOTIONS 应是动作清单');
for (const motion of ['walk', 'run', 'jump', 'spin', 'sit', 'sleep', 'dizzy']) {
  assert.ok(exports.PET.MOTIONS.includes(motion), `动作清单应含 ${motion}`);
}

const model = exports.PET_MODEL;
assert.ok(model && Array.isArray(model.parts) && model.parts.length > 0, 'PET_MODEL.parts 不能为空');
assert.ok(model.feat && model.feat.sprites, 'PET_MODEL 应带五官贴图清单');
assert.ok(model.units && typeof model.units.S === 'number', 'PET_MODEL 应带单位换算');

// 贴图清单必须与 model.json 严格一致（构建工具是按同一套规则推导的）
const featNames = [
  ...Object.keys(model.feat.sprites),
  ...['eyeL', 'eyeR'].flatMap((k) =>
    ['lash', 'ball', 'iris', ...(model.feat.eyes[k].rim ? ['rim'] : [])].map((n) => `${k}_${n}`),
  ),
];
const expectedKeys = [
  ...model.parts.map((p) => `tex/${p.tex}.png`),
  ...featNames.map((n) => `feat/${n}.png`),
];
assert.equal(
  Object.keys(exports.PET_TEX).length,
  expectedKeys.length,
  `贴图数量应为 ${expectedKeys.length}（部件 ${model.parts.length} + 五官 ${featNames.length}）`,
);
for (const key of expectedKeys) {
  const uri = exports.PET_TEX[key];
  assert.ok(typeof uri === 'string' && uri.startsWith(PET_TEX_PREFIX), `${key} 应是 WebP data URI`);
}
{
  // 抽查两张：data URI 必须真的能解出 WebP（防「路径写对了但内容是空」）
  for (const key of ['tex/face.png', `feat/${featNames[0]}.png`]) {
    const raw = Buffer.from(exports.PET_TEX[key].slice(PET_TEX_PREFIX.length), 'base64');
    assert.deepEqual(
      [...raw.subarray(0, 4)],
      [0x52, 0x49, 0x46, 0x46],
      `${key} 解出来必须是 WebP（RIFF）`,
    );
    assert.deepEqual(
      [...raw.subarray(8, 12)],
      [0x57, 0x45, 0x42, 0x50],
      `${key} 的 WebP 品牌标记必须是 WEBP`,
    );
    assert.ok(raw.length > 200, `${key} 不应为空图（实得 ${raw.length} 字节）`);
  }
  // 第三档 #9：贴图 WebP 化必须带来实实在在的体积收益（源图 50 张约 1.2MB）
  const texBytes = Object.values(exports.PET_TEX).reduce((n, uri) => n + uri.length, 0);
  assert.ok(texBytes < 500 * 1024, `PET_TEX 的 WebP 内联总量应明显小于 500KB（实得 ${(texBytes / 1024).toFixed(0)}KB）`);
  assert.ok(!exports.PET_TEX['tex/face.png'].includes('image/png'), 'PET_TEX 里不能再出现 PNG data URI');
}

assert.ok(
  typeof exports.WHALE_ICON_URI === 'string' && exports.WHALE_ICON_URI.startsWith(ICON_PREFIX),
  '侧栏图标应是 PNG data URI',
);
{
  const raw = Buffer.from(exports.WHALE_ICON_URI.slice(ICON_PREFIX.length), 'base64');
  assert.ok(raw.length > 5000, '侧栏图标不应为空图');
}

// ── 5. 价格条：宽/窄两态都能渲染 ──────────────────────────────────────────────
assert.equal(typeof exports.PeakWhaleStrip, 'function');
const wideOff = withFakeNow('2026-10-03T12:00:00Z', () => exports.PeakWhaleStrip({ wide: true }));
const wideOffText = collectText(wideOff).join('');
assert.ok(wideOffText.includes('谷时 · 半价'), `谷时文案缺失：${wideOffText}`);
assert.ok(wideOffText.includes('距下次峰时'), '谷时应显示「距下次峰时」倒计时');
assert.equal(findByClass(wideOff, 'pw-strip-icon').length, 1, '价格条应带鲸鱼娘小图标');

const widePeak = withFakeNow('2026-10-08T02:00:00Z', () => exports.PeakWhaleStrip({ wide: true }));
const widePeakText = collectText(widePeak).join('');
assert.ok(widePeakText.includes('峰时 · 全价'), `峰时文案缺失：${widePeakText}`);
assert.ok(widePeakText.includes('距下次谷时'), '峰时应显示「距下次谷时」倒计时');

const rail = withFakeNow('2026-10-03T12:00:00Z', () => exports.PeakWhaleStrip({ wide: false }));
assert.equal(collectText(rail).join(''), '', '轨道态不应渲染文字');

// 详细版详情浮层也要显示倒计时（第二档 #7：不只状态条有）
{
  const d = new Date('2026-10-08T02:00:00Z'); // 峰时
  const s = exports.summary(d);
  const desc = exports.describePeriod(s);
  const out = exports.details(d, s, desc, null, 'detailed', null);
  const text = collectText(out).join('');
  assert.ok(text.includes('距下次谷时'), '详细版详情浮层要显示「距下次谷时」倒计时');
  assert.ok(/距下次谷时[：:]\s*\d+\s*小时/.test(text), '倒计时要用完整时分格式：' + text.slice(0, 200));
}

// ── 5b. 账户钱包：状态条第二行 + 详情浮层里的账户卡片 ────────────────────────
assert.equal(typeof exports.walletItems, 'function', 'walletItems 必须导出以便测试');
assert.equal(typeof exports.walletSummary, 'function', 'walletSummary 必须导出以便测试');
assert.equal(typeof exports.walletDetails, 'function');
assert.equal(typeof exports.setWalletState, 'function');
assert.equal(exports.getWalletState(), null, '初始应还没有钱包数据');
assert.equal(exports.walletSummary(null), null, '没数据就不显示第二行');
assert.deepEqual(exports.walletItems(null), [], '没数据就一个分段都不给');
assert.deepEqual(
  exports.walletItems({ ok: false, unavailable: true, status: 404 }),
  [],
  '取不到数据时必须是空数组 —— 状态条宁可不显示，也不挂一句「不可用」',
);
assert.equal(exports.walletUrl(), null, '测试桩没有 location —— 绝不能真的发请求');
assert.equal(exports.WALLET_ROUTE, '/dsh-deepseek-peak-whale/api/wallet', '客户端要打 Host 注册的那条路由');

{
  const payload = {
    ok: true,
    nowMs: 0,
    profile: 'desktop',
    account: { status: 'credential-stored', topUpUrl: 'https://x/top_up', usageUrl: 'https://x/usage' },
    // 真实账户就是人民币钱包（余额接口返回 CNY），所以按现实取值；
    // 美元钱包的显示另有 wallet.test.mjs 的 formatMoney 覆盖。
    balance: {
      status: 'ready',
      wallets: [{ currency: 'CNY', balance: '240.98267744' }],
      bonus: [{ currency: 'CNY', balance: '1.0000' }],
    },
    today: {
      date: '2026-10-03',
      cny: 4.694929,
      requests: 5,
      tokens: { uncachedInputTokens: 12000, outputTokens: 3400, cacheReadTokens: 800, cacheWriteTokens: 0 },
      isPeak: false,
    },
    note: 'estimate',
  };
  exports.setWalletState(payload);
  assert.equal(exports.getWalletState(), payload, 'setWalletState 要写进共享状态');

  // ── 状态条摘要（纯函数） ──
  const summaryText = exports.walletSummary(payload);
  assert.ok(summaryText.includes('余额 ¥240.98'), `摘要应含余额：${summaryText}`);
  assert.ok(summaryText.includes('今日 ¥4.69'), `摘要应含当日费用：${summaryText}`);
  assert.ok(!summaryText.includes('$'), `人民币账户下摘要不该出现 $：${summaryText}`);
  assert.ok(!summaryText.includes('赠'), '赠送余额只进浮层，状态条保持一行清爽');

  const segments = exports.walletItems(payload);
  assert.deepEqual(
    segments.map((item) => `${item.label}:${item.value}`),
    ['余额:¥240.98', '今日:¥4.69'],
    '分段数据决定第二行渲染出什么',
  );

  const signedOutSummary = exports.walletSummary({
    ok: true,
    account: { status: 'signed-out' },
    balance: { status: 'unknown' },
    today: payload.today,
  });
  assert.ok(signedOutSummary.includes('未登录'), `未登录要说人话：${signedOutSummary}`);
  assert.ok(signedOutSummary.includes('今日 ¥4.69'), '未登录也照样显示当日费用');
  assert.equal(
    exports.walletSummary({ ok: false, unavailable: true }),
    null,
    '取不到数据时整行不显示（而不是挂一句「账户数据不可用」）',
  );

  // ── 状态条渲染 ──
  const wideWallet = withFakeNow('2026-10-03T12:00:00Z', () => exports.PeakWhaleStrip({ wide: true }));
  const wideWalletText = collectText(wideWallet).join('');
  assert.ok(wideWalletText.includes('谷时 · 半价'), '价格条文案不能被挤掉');
  assert.ok(wideWalletText.includes('距下次峰时'), '倒计时不能被挤掉');
  // DOM 文本里标签与数字之间不带空格（视觉间距由 CSS 的 gap 负责），
  // 带空格的那份在悬停提示里（下面一行断言）。
  assert.ok(wideWalletText.includes('余额¥240.98'), `第二行应显示余额：${wideWalletText}`);
  assert.ok(wideWalletText.includes('今日¥4.69'), `第二行应显示当日费用：${wideWalletText}`);

  const stripButton = findByClass(wideWallet, 'pw-strip');
  assert.equal(stripButton.length, 1);
  assert.ok(stripButton[0].props.title.includes('余额 ¥240.98'), '悬停提示里也要有余额');

  assert.equal(findByClass(wideWallet, 'pw-body').length, 1, '宽态应把两行内容收进 .pw-body');
  assert.equal(findByClass(wideWallet, 'pw-wallet').length, 1, '应渲染余额行');
  assert.equal(findByClass(wideWallet, 'pw-witem').length, 2, '第二行应渲染出两个数据段');
  assert.equal(findByClass(wideWallet, 'pw-wsep').length, 1, '两段之间一个分隔点');
  assert.equal(findByClass(wideWallet, 'pw-wvalue').length, 2, '数字要包在 <b> 里强调');
  assert.equal(findByClass(wideWallet, 'pw-wlabel').length, 2, '标签单独一层，走次级色');

  // 窄轨态（侧栏收起成图标轨道）：只有鲸鱼头，一个字都不能有
  const railWallet = withFakeNow('2026-10-03T12:00:00Z', () => exports.PeakWhaleStrip({ wide: false }));
  assert.equal(collectText(railWallet).join(''), '', '轨道态不显示余额');
  assert.equal(findByClass(railWallet, 'pw-body').length, 0, '轨道态不该有两行容器');

  // 没数据（Host 半身还没重启 / 断网）：状态条回到原来的一行，绝不摆出「不可用」
  exports.setWalletState({ ok: false, unavailable: true, status: 404 });
  const failedStrip = withFakeNow('2026-10-03T12:00:00Z', () => exports.PeakWhaleStrip({ wide: true }));
  const failedText = collectText(failedStrip).join('');
  assert.equal(findByClass(failedStrip, 'pw-wallet').length, 0, '取不到数据时不渲染第二行');
  assert.equal(findByClass(failedStrip, 'pw-witem').length, 0, '一个数据段都不该有');
  assert.ok(!failedText.includes('不可用'), `不能把「不可用」摆到侧栏：${failedText}`);
  assert.ok(failedText.includes('谷时 · 半价'), '价格条本身照常显示');
  assert.ok(
    !findByClass(failedStrip, 'pw-strip')[0].props.title.includes('不可用'),
    '悬停提示里也不该出现「不可用」',
  );
  exports.setWalletState(payload); // 恢复，后面的浮层断言还要用

  // ── 详情浮层里的账户卡片 ──
  const now = new Date('2026-10-03T12:00:00Z');
  const state = exports.summary(now);
  const cardText = collectText(exports.details(now, state, exports.describePeriod(state), payload)).join('');
  assert.ok(cardText.includes('账户'), '卡片应有账户行');
  assert.ok(cardText.includes('余额（CNY）'), `应列出钱包币种：${cardText}`);
  assert.ok(cardText.includes('¥240.98'), '卡片应显示余额');
  assert.ok(cardText.includes('赠送（CNY）'), '赠送钱包单独一行');
  assert.ok(cardText.includes('今日费用 · 2026-10-03'), '卡片应标注当日');
  assert.ok(cardText.includes('¥4.69'), '卡片应显示当日费用（人民币）');
  assert.ok(cardText.includes('按谷时半价档'), '要说清这一档是怎么算的');
  assert.ok(cardText.includes('5 次请求'), '应给出请求次数');
  assert.ok(cardText.includes('充值') && cardText.includes('官方用量'), '应带上充值与官方用量入口');
  assert.ok(!cardText.includes('不是账单'), 'v0.4.0：卡片里那行免责小字已按需求移除');
  assert.ok(!cardText.includes('读取中'), '有数据时不该显示占位文案');

  const loadingText = collectText(exports.details(now, state, exports.describePeriod(state), null)).join('');
  assert.ok(loadingText.includes('读取中'), `没数据时要有占位说明：${loadingText}`);
  const unavailableText = collectText(
    exports.details(now, state, exports.describePeriod(state), { ok: false, unavailable: true }),
  ).join('');
  assert.ok(unavailableText.includes('取不到'), `取不到要明说：${unavailableText}`);

  // 404 = Host 半身还是旧代码：浮层要给出「怎么办」，而不是一句不知所云的失败
  const restartHint = collectText(
    exports.details(now, state, exports.describePeriod(state), { ok: false, unavailable: true, status: 404 }),
  ).join('');
  assert.ok(restartHint.includes('重启'), `404 要给出可操作的提示：${restartHint}`);

  // 账户服务还没到（开机竞态，余额消失的现场）：要说清「未就绪、会自己好」，
  // 而不是只摆一个「—」让用户猜（2026-10-06 实测反馈）。
  const notReadyText = collectText(
    exports.details(now, state, exports.describePeriod(state), {
      ok: true,
      account: { status: 'unavailable', topUpUrl: null, usageUrl: null },
      balance: { status: 'unknown' },
      today: payload.today,
    }),
  ).join('');
  assert.ok(
    !notReadyText.includes('账户—'),
    `账户服务未就绪时不能只摆一个破折号：${notReadyText}`,
  );
  assert.ok(notReadyText.includes('服务未就绪'), `要写明账户服务未就绪：${notReadyText}`);
  assert.ok(notReadyText.includes('自动重试'), `要说明它会自己恢复：${notReadyText}`);
  assert.ok(notReadyText.includes('今日费用'), '当日费用不依赖账户服务，照常显示');

  // 当日费用是卡片主角：单独一段、带分隔线
  const todayRow = findByClass(
    exports.details(now, state, exports.describePeriod(state), payload),
    'pw-wallet-row--today',
  );
  assert.equal(todayRow.length, 1, '当日费用行要单独强调');

  // ── 详情页模式：简洁版 = 余额 + 今日费用 + 当前档与持续时间，没有价格表 ──
  {
    const concise = exports.details(now, state, exports.describePeriod(state), payload, 'concise');
    const conciseText = collectText(concise).join('');
    assert.ok(conciseText.includes('当前'), '简洁版要有当前档');
    assert.ok(/距下次[谷峰]时[：:]\s*\d+/.test(conciseText), '简洁版要有「距下次谷时/峰时」的持续时间');
    assert.ok(conciseText.includes('余额（CNY）'), '简洁版要有余额');
    assert.ok(conciseText.includes('今日费用'), '简洁版要有今日费用');
    assert.equal(findByClass(concise, 'pw-table').length, 0, '简洁版不显示价格表');
    assert.ok(!conciseText.includes('详细版'), 'v0.4.0：简洁版不再挂「切到详细版」的指路小字');
    // v0.4.1：入口死锁修复 —— 切模式要去设置页，简洁版若没有入口就永远进不去
    assert.equal(findByClass(concise, 'pw-set-btn').length, 1, '简洁版底部也要有「设置」入口');
    assert.equal(findByClass(concise, 'pw-usage-btn').length, 1, '简洁版底部也要有「token 消耗详情」入口');
    assert.equal(findByClass(concise, 'pw-actions').length, 1, '简洁版的按钮同样放在 pw-actions 容器里');

    const detailed = exports.details(now, state, exports.describePeriod(state), payload, 'detailed');
    assert.equal(findByClass(detailed, 'pw-table').length, 1, '详细版要有价格表');
    assert.equal(findByClass(detailed, 'pw-sec').length, 3, '详细版三个分节：时段 / 账户 / 价格表');
    assert.ok(collectText(detailed).join('').includes('官方价格表'), '分节标题要可读');
    // 价格表按官方**中文**页的人民币牌价渲染（不是倒推美元）：谷/峰两档都要在，
    // 且单位说明必须写人民币——否则读者会拿它跟充值的 ¥ 对不上。
    const tableText = collectText(detailed).join('');
    assert.ok(tableText.includes('¥0.020') && tableText.includes('¥0.040'), `Flash 缓存命中两档：${tableText.slice(0, 200)}`);
    assert.ok(tableText.includes('¥4.50') && tableText.includes('¥9.00'), 'V4-Pro 未命中两档');
    assert.ok(tableText.includes('¥13.50') && tableText.includes('¥27.00'), 'V4-Pro 输出两档');
    assert.ok(tableText.includes('人民币元 / 100 万 tokens'), '单位说明必须写人民币');
    assert.ok(!tableText.includes('单位：美元'), '不该再出现美元单位说明');
    assert.ok(tableText.includes('zh-cn/quick_start/pricing'), '数据来源指向中文定价页');

    // ── v0.4.0：详细版底部的「设置」按钮 → 跳内置「插件」设置面板 ──
    const setBtn = findByClass(detailed, 'pw-set-btn');
    assert.equal(setBtn.length, 1, '详细版底部要有且只有一个「设置」按钮');
    assert.equal(collectText(setBtn).join(''), '设置', '按钮文案就是「设置」');
    const panelCalls = [];
    exports.setLayoutService({ selectPanel: (id) => panelCalls.push(id) });
    setBtn[0].props.onClick();
    assert.deepEqual(panelCalls, ['plugins'], '「设置」要跳到内置「插件」面板（我们的 tab 在那）');
    // 拿不到 layout 服务时必须安静失败，不能把浮层点崩
    exports.setLayoutService(null);
    assert.equal(exports.openPluginsSettings(), false, '没有 layout 服务时返回 false 而不是抛错');
    assert.doesNotThrow(() => setBtn[0].props.onClick(), '点「设置」永远不能抛错');
  }

  // 恢复初始状态，别影响后面的断言
  exports.setWalletState(null);
  assert.equal(exports.getWalletState(), null);
  const cleared = withFakeNow('2026-10-03T12:00:00Z', () => collectText(exports.PeakWhaleStrip({ wide: true })).join(''));
  assert.equal(cleared.includes('余额'), false, '清空后第二行应消失');
}

// ── 6. 桌宠组件：结构正确，且在没有 WebGL/Image 的环境里优雅降级 ──────────────
assert.equal(typeof exports.WhaleRoamer, 'function', 'WhaleRoamer 必须导出以便测试');
const realWarn = console.warn;
const warnings = [];
console.warn = (...args) => {
  warnings.push(args.map(String).join(' '));
};
const roamer = withFakeNow('2026-10-03T12:00:00Z', () => React.__mount(() => exports.WhaleRoamer()));
// 初始化是异步的（要等贴图解码），等一个宏任务让它走到失败分支
await new Promise((resolve) => setTimeout(resolve, 20));
console.warn = realWarn;

const tree = roamer.current;
assert.ok(tree, '组件必须始终渲染出结构（初始化失败时也不能返回 null）');
const roots = findByClass(tree, 'pw-roam');
assert.equal(roots.length, 1, '应渲染一个 .pw-roam 浮层根');
assert.equal(roots[0].props['data-ready'], '0', '测试环境没有 WebGL/Image，data-ready 应为 0');

const stage = findByClass(tree, 'pw-stage');
assert.equal(stage.length, 1, '应有一个 SVG 舞台');
assert.equal(findByClass(tree, 'pw-shadow').length, 1, '舞台里应有接地影子');
assert.equal(findByClass(tree, 'pw-pet').length, 1, '舞台里应有宠物组（figure 往这里挂画布）');
assert.equal(findByClass(tree, 'pw-fx').length, 1, '舞台里应有特效组');
// 舞台里必须「没有子元素被 React 管理」——DOM 由 pet-core 独占写入
assert.equal(stage[0].children.length, 3, '舞台应只有 shadow / pet / fx 三个空元素');

const hit = findByClass(tree, 'pw-hitbox');
assert.equal(hit.length, 1, '应有一个命中区');
for (const handler of ['onPointerDown', 'onPointerUp', 'onPointerCancel', 'onPointerLeave', 'onContextMenu']) {
  assert.equal(typeof hit[0].props[handler], 'function', `命中区应挂上 ${handler}`);
}

const bubble = findByClass(tree, 'pw-bubble');
assert.equal(bubble.length, 1, '应有一个说话气泡');
assert.equal(bubble[0].props.hidden, true, '气泡初始应是隐藏的');

assert.ok(
  warnings.some((line) => line.includes('鲸鱼娘初始化失败')),
  `初始化失败应告警而不是抛错，实得：${JSON.stringify(warnings)}`,
);

// ── 6b. 打字回避的接线：挂载后必须监听输入，卸载时必须摘干净 ──────────────────
{
  for (const type of ['keydown', 'input', 'focusin', 'focusout']) {
    assert.ok(doc.document.listeners.includes(type), `挂载后必须监听 ${type}（打字回避的入口）`);
  }
  assert.equal(doc.document.removed.length, 0, '挂载期间不该摘监听');
}

// ── 6c. 优化气泡：busy → pick（三版选一）→ info / error ────────────────────
// v0.5.4：优化完**直接写回改写后的正文**，不再留可撤销原稿、不再问要不要回退。
{
  const whaleApi = exports.__whaleApi;
  assert.ok(whaleApi && typeof whaleApi.commit === 'function', '挂载后应能拿到 api（测试钩子）');
  assert.ok(whaleApi.store, 'api 上要挂着 store（UI 状态都在里面）');

  const fakeBox = { tagName: 'TEXTAREA', value: '新稿' };
  const opts = () => findByClass(roamer.current, 'pw-opt');

  // ① busy：只有一句「正在优化」，没有按钮
  whaleApi.commit({ busy: true, undo: null, opt: { kind: 'busy', text: '正在优化提示词中…' } });
  assert.equal(opts().length, 1, '优化中要渲染气泡');
  assert.equal(opts()[0].props['data-kind'], 'busy');
  assert.ok(collectText(opts()[0]).join('').includes('正在优化提示词中'), '气泡要说清在干什么');
  assert.equal(findAll(opts()[0], 'button').length, 0, 'busy 态不该有按钮');

  // ② pick：三版一行一版（整行替换 / 行内复制）+ 「还是不优化了吧」 + 「关闭」，
  //     **不设消失时间**，是对话框语义
  fakeBox.value = '原稿'; // 摆回原文，下面才验得了「复制不动框、替换才动框」
  whaleApi.commit({
    busy: false,
    undo: null,
    opt: {
      kind: 'pick',
      variants: [
        { key: 'detailed', label: '更详细', optimized: '详细稿', unchanged: false, usage: null, cached: false, ms: null },
        { key: 'professional', label: '更专业', optimized: '专业稿', unchanged: false, usage: null, cached: false, ms: 12345 },
        { key: 'auto', label: 'AI 自主 + 建议', optimized: '自主稿', unchanged: false, usage: null, cached: false, ms: 800 },
      ],
      original: '原稿',
      box: fakeBox,
      until: 0,
    },
  });
  const pick = findByClass(roamer.current, 'pw-opt')[0];
  assert.equal(pick.props['data-kind'], 'pick');
  assert.equal(pick.props.role, 'dialog', '选版是对话框语义');
  const pickText = collectText(pick).join('');
  assert.ok(pickText.includes('更详细') && pickText.includes('更专业') && pickText.includes('AI 自主'), '三版标签都要在');
  assert.ok(pickText.includes('还是不优化了吧'), '要有「不优化」选项');
  assert.ok(!pickText.includes('秒后自动收起'), '选版气泡不该有倒计时文案');
  const pickBtns = findAll(pick, 'button');
  assert.equal(
    pickBtns.length, 8,
    '正好八个按钮：三行「替换」+ 三行「复制」+ 不优化 + 关闭',
  );
  assert.equal(findByClass(pick, 'pw-opt-pick-row').length, 3, '一版一行');
  // 行内按钮的文本是「标签 + 字数 + 耗时 + 替换」拼起来的，所以只能 includes
  assert.equal(pickBtns.filter((b) => collectText(b).join('').includes('替换')).length, 3, '每行一个「替换」');
  assert.equal(pickBtns.filter((b) => collectText(b).join('') === '复制').length, 3, '每行一个「复制」');
  const closeInPick = pickBtns.find((b) => collectText(b).join('') === '关闭');
  assert.ok(closeInPick, 'pick 态要有「关闭」');
  // 思考时间：有 ms 才显示，没有（缓存命中）就安静省略，绝不编「0ms」
  const msCells = findByClass(pick, 'pw-opt-pick-ms').map((n) => collectText(n).join(''));
  assert.deepEqual(msCells, ['12s', '800ms'], `只给有 ms 的版本显示思考时间：${msCells.join(' / ')}`);

  // 每行的「复制」按钮：只进剪贴板，**绝不动文本框**，气泡也留着让你接着挑
  {
    const copied = [];
    const dom = doc.document;
    const savedCreate = dom.createElement;
    const savedBody = dom.body;
    const savedExec = dom.execCommand;
    dom.createElement = () => ({ style: {}, select() {} });
    dom.body = { appendChild() {}, removeChild() {} };
    dom.execCommand = (cmd) => { copied.push(cmd); return true; };
    try {
      const copyBtn = findAll(pick, 'button').find(
        (b) => collectText(b).join('') === '复制' && b.props.title.includes('只复制'),
      );
      assert.ok(copyBtn, '每行都要有「只复制」');
      copyBtn.props.onClick();
      // navigator.clipboard 没桩 → 走 execCommand 兜底，同步回调
      assert.deepEqual(copied, ['copy'], '「复制」要真的往剪贴板写');
      assert.equal(fakeBox.value, '原稿', '「复制」绝不能碰文本框');
      assert.equal(whaleApi.store.opt.kind, 'pick', '「复制」后气泡留着，还能接着选');
    } finally {
      dom.createElement = savedCreate;
      dom.body = savedBody;
      dom.execCommand = savedExec;
    }
  }

  // 「关闭」：什么都不写、什么都不复制，只收气泡
  {
    const closeBtn = findAll(pick, 'button').find((b) => collectText(b).join('') === '关闭');
    assert.ok(closeBtn, 'pick 态要有「关闭」');
    const before = fakeBox.value;
    closeBtn.props.onClick();
    assert.equal(whaleApi.store.opt, null, '「关闭」要收掉气泡');
    assert.equal(fakeBox.value, before, '「关闭」不能动文本框');
  }

  // 重新摆出 pick，供下面「选更专业」继续用
  whaleApi.commit({
    opt: {
      kind: 'pick',
      variants: [
        { key: 'detailed', label: '更详细', optimized: '详细稿', unchanged: false, usage: null, cached: false, ms: null },
        { key: 'professional', label: '更专业', optimized: '专业稿', unchanged: false, usage: null, cached: false, ms: 12345 },
        { key: 'auto', label: 'AI 自主 + 建议', optimized: '自主稿', unchanged: false, usage: null, cached: false, ms: 800 },
      ],
      original: '原稿',
      box: fakeBox,
      until: 0,
    },
    undo: null,
  });

  // 选「更专业」那版：写回文本框，**不留撤销态**，气泡换成 info
  fakeBox.value = '原稿';
  const proBtn = pickBtns.find((b) => collectText(b).join('').includes('更专业'));
  proBtn.props.onClick();
  assert.equal(fakeBox.value, '专业稿', '选中那版要写回文本框');
  assert.equal(whaleApi.store.undo, null, '选中后不留撤销态（原文不再对你呈现）');
  assert.equal(whaleApi.store.opt && whaleApi.store.opt.kind, 'info', '气泡换成 info 提示');
  const doneText = collectText(findByClass(roamer.current, 'pw-opt')[0]).join('');
  assert.ok(doneText.includes('原文已移除'), '完成提示要说明原文已移除');
  assert.ok(
    !doneText.includes('右键我可以撤销'),
    '完成提示不许再提"右键撤销"—— 那个入口已经没了，提了就是骗人',
  );

  // 选「不优化」：什么都不写，气泡收掉
  whaleApi.commit({
    opt: {
      kind: 'pick',
      variants: [
        { key: 'detailed', label: '更详细', optimized: '详细稿', unchanged: false, usage: null, cached: false },
      ],
      original: '原稿',
      box: fakeBox,
      until: 0,
    },
    undo: null,
  });
  fakeBox.value = '原稿';
  const skipBtn = findAll(findByClass(roamer.current, 'pw-opt')[0], 'button')
    .find((b) => collectText(b).join('').includes('还是不优化了吧'));
  skipBtn.props.onClick();
  assert.equal(fakeBox.value, '原稿', '「不优化」不能动文本框');
  assert.equal(whaleApi.store.opt, null, '「不优化」后气泡收掉');
  assert.equal(whaleApi.store.undo, null, '「不优化」不留撤销态');

  // ③ 失败态：整句原因（含配置文件路径）+ 「知道了」
  whaleApi.commit({
    opt: {
      kind: 'error',
      text: '还没配置 API key：把 key 填进 /x/settings.json 的 deepseekApiKey',
      until: Date.now() + 8000,
    },
  });
  const errOpt = findByClass(roamer.current, 'pw-opt')[0];
  assert.equal(errOpt.props['data-kind'], 'error', '失败态要有自己的 kind');
  assert.ok(collectText(errOpt).join('').includes('deepseekApiKey'), '失败原因要完整显示出来');
  const dismiss = findAll(errOpt, 'button').find((b) => collectText(b).join('').includes('知道了'));
  assert.ok(dismiss, '失败态要有「知道了」');
  dismiss.props.onClick();
  assert.equal(opts().length, 0, '点「知道了」要收掉');

  // ④ 右键菜单**不再有**撤销入口（v0.5.4）。
  //    这几条是"钉住删除"，不是"钉住存在" —— 没有它们，日后有人看到
  //    api.undoOptimize 还挂在 api 上，就很容易顺手把菜单项接回去。
  whaleApi.commit({ opt: null, undo: null });
  const hitForMenu = () => findByClass(roamer.current, 'pw-hitbox')[0];
  hitForMenu().props.onContextMenu.call(
    { setPointerCapture() {}, releasePointerCapture() {} },
    { clientX: 300, clientY: 200, preventDefault() {}, stopPropagation() {} },
  );
  const menuLabels = findAll(roamer.current, 'button').map((b) => collectText(b).join(''));
  const hit = (needle) => menuLabels.some((t) => t.includes(needle));
  assert.ok(!hit('撤销提示词'), `右键菜单不该再有撤销入口：${menuLabels.filter(hit).join(' / ') || '（无）'}`);
  assert.ok(!hit('安静一会儿'), '「安静一会儿」已被活泼程度档取代，不该回来');
  assert.ok(!hit('说句价格'), '价格改由待机时自己说，菜单不该再有手动触发项');
  assert.ok(
    menuLabels.includes('逗她玩') && menuLabels.some((t) => t.startsWith('活泼程度')),
    '但「逗她玩」和「活泼程度」必须在',
  );
  whaleApi.closeMenu();
}

// ── 7. 亲密度与动作候选 ───────────────────────────────────────────────────────
assert.equal(typeof exports.affinityLevel, 'function');
assert.equal(exports.affinityLevel(0), 1);
assert.equal(exports.affinityLevel(4), 1);
assert.equal(exports.affinityLevel(5), 2, '满 5 次升一级');
assert.equal(exports.affinityLevel(49), 10);
assert.equal(exports.affinityLevel(100000), 10, '等级要有上限');
assert.equal(exports.affinityLevel(-3), 1, '异常输入回落到 1 级');

assert.ok(Array.isArray(exports.POSE_MOTIONS), 'POSE_MOTIONS 应是数组');
assert.ok(exports.POSE_MOTIONS.length > 3, '菜单姿势候选不能为空');
assert.ok(!exports.POSE_MOTIONS.includes('walk'), '走路是漫游自己的事，不该出现在姿势菜单里');
assert.ok(!exports.POSE_MOTIONS.includes('run'), '跑步同上');
for (const motion of exports.POSE_MOTIONS) {
  assert.ok(exports.PET.MOTIONS.includes(motion), `${motion} 必须是上游真实存在的动作`);
}

// 亲密度持久化：坏数据与抛异常的 storage 都不能把插件搞崩
assert.equal(typeof exports.loadAffinity, 'function');
assert.equal(typeof exports.saveAffinity, 'function');
{
  const map = new Map();
  const fake = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, v),
  };
  assert.equal(exports.loadAffinity(null), 0, '没有 storage 时回落 0');
  assert.equal(exports.loadAffinity(fake), 0, '空存储读到 0');
  assert.equal(exports.saveAffinity(fake, 7), true, '正常写入应成功');
  assert.equal(exports.loadAffinity(fake), 7, '存进去要能读回来');
  map.set(exports.AFFINITY_KEY, '{坏掉的 JSON');
  assert.equal(exports.loadAffinity(fake), 0, 'JSON 坏了要回落 0 而不是抛错');
  const boom = {
    getItem() {
      throw new Error('隐私模式');
    },
    setItem() {
      throw new Error('配额满');
    },
  };
  assert.equal(exports.loadAffinity(boom), 0, 'getItem 抛错要吞掉');
}

// ── 8. 第三档 #10：节假日表续期 ─────────────────────────────────────────────
// HOLIDAYS 必须覆盖到 2027 年，否则明年 1 月起的价格判定会失准
const holidays = exports.HOLIDAYS || [];
assert.ok(Array.isArray(holidays) && holidays.length > 0, 'HOLIDAYS 必须是数组');
const holidayDates = holidays.map((h) => h.start);
const has2027 = holidays.some((h) => h.start.startsWith('2027-'));
assert.ok(has2027, 'HOLIDAYS 必须包含 2027 年条目');
// 2027 元旦必须在表里
assert.ok(
  holidayDates.includes('2027-01-01'),
  '2027 元旦必须登记（2027-01-01 是法定假日）',
);

// ── 9. 第三档 #11：账单导出 ──────────────────────────────────────────────────
// 导出功能在 Host 侧（wallet.js 的 exportLedgerCSV），客户端通过按钮打开导出路由
// 验证：源码中包含导出按钮
assert.ok(
  source.includes('导出账单 CSV'),
  '源码中必须有「导出账单 CSV」按钮',
);
assert.ok(
  source.includes('/export?format=csv'),
  '源码中必须引用导出路由（/export?format=csv）',
);