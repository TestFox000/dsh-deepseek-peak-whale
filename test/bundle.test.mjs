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

const { registration, exports, doc, source, React } = loadClientBundle();

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
assert.ok(css.includes('.pw-opt-yes'), '撤销对话框要有 √ 按钮样式');
assert.ok(css.includes('.pw-opt-no'), '撤销对话框要有 × 按钮样式');
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
const DATA_URI_PREFIX = 'data:image/png;base64,';
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
  assert.ok(typeof uri === 'string' && uri.startsWith(DATA_URI_PREFIX), `${key} 应是 PNG data URI`);
}
{
  // 抽查两张：data URI 必须真的能解出 PNG（防「路径写对了但内容是空」）
  for (const key of ['tex/face.png', `feat/${featNames[0]}.png`]) {
    const raw = Buffer.from(exports.PET_TEX[key].slice(DATA_URI_PREFIX.length), 'base64');
    assert.deepEqual(
      [...raw.subarray(0, 8)],
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
      `${key} 解出来必须是 PNG`,
    );
    assert.ok(raw.length > 500, `${key} 不应为空图（实得 ${raw.length} 字节）`);
  }
}

assert.ok(
  typeof exports.WHALE_ICON_URI === 'string' && exports.WHALE_ICON_URI.startsWith(DATA_URI_PREFIX),
  '侧栏图标应是 PNG data URI',
);
{
  const raw = Buffer.from(exports.WHALE_ICON_URI.slice(DATA_URI_PREFIX.length), 'base64');
  assert.ok(raw.length > 5000, '侧栏图标不应为空图');
}

// ── 5. 价格条：宽/窄两态都能渲染 ──────────────────────────────────────────────
assert.equal(typeof exports.PeakWhaleStrip, 'function');
const wideOff = withFakeNow('2026-10-03T12:00:00Z', () => exports.PeakWhaleStrip({ wide: true }));
const wideOffText = collectText(wideOff).join('');
assert.ok(wideOffText.includes('谷时 · 半价'), `谷时文案缺失：${wideOffText}`);
assert.ok(wideOffText.includes('距峰时'), '谷时应显示距峰时倒计时');
assert.equal(findByClass(wideOff, 'pw-strip-icon').length, 1, '价格条应带鲸鱼娘小图标');

const widePeak = withFakeNow('2026-10-08T02:00:00Z', () => exports.PeakWhaleStrip({ wide: true }));
const widePeakText = collectText(widePeak).join('');
assert.ok(widePeakText.includes('峰时 · 全价'), `峰时文案缺失：${widePeakText}`);
assert.ok(widePeakText.includes('距半价'), '峰时应显示距半价倒计时');

const rail = withFakeNow('2026-10-03T12:00:00Z', () => exports.PeakWhaleStrip({ wide: false }));
assert.equal(collectText(rail).join(''), '', '轨道态不应渲染文字');

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
    balance: {
      status: 'ready',
      wallets: [{ currency: 'USD', balance: '12.3456' }],
      bonus: [{ currency: 'USD', balance: '1.0000' }],
    },
    today: {
      date: '2026-10-03',
      usd: 0.0042,
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
  assert.ok(summaryText.includes('余额 $12.35'), `摘要应含余额：${summaryText}`);
  assert.ok(summaryText.includes('今日 $0.0042'), `摘要应含当日费用：${summaryText}`);
  assert.ok(!summaryText.includes('赠'), '赠送余额只进浮层，状态条保持一行清爽');

  const segments = exports.walletItems(payload);
  assert.deepEqual(
    segments.map((item) => `${item.label}:${item.value}`),
    ['余额:$12.35', '今日:$0.0042'],
    '分段数据决定第二行渲染出什么',
  );

  const signedOutSummary = exports.walletSummary({
    ok: true,
    account: { status: 'signed-out' },
    balance: { status: 'unknown' },
    today: payload.today,
  });
  assert.ok(signedOutSummary.includes('未登录'), `未登录要说人话：${signedOutSummary}`);
  assert.ok(signedOutSummary.includes('今日 $0.0042'), '未登录也照样显示当日费用');
  assert.equal(
    exports.walletSummary({ ok: false, unavailable: true }),
    null,
    '取不到数据时整行不显示（而不是挂一句「账户数据不可用」）',
  );

  // ── 状态条渲染 ──
  const wideWallet = withFakeNow('2026-10-03T12:00:00Z', () => exports.PeakWhaleStrip({ wide: true }));
  const wideWalletText = collectText(wideWallet).join('');
  assert.ok(wideWalletText.includes('谷时 · 半价'), '价格条文案不能被挤掉');
  assert.ok(wideWalletText.includes('距峰时'), '倒计时不能被挤掉');
  // DOM 文本里标签与数字之间不带空格（视觉间距由 CSS 的 gap 负责），
  // 带空格的那份在悬停提示里（下面一行断言）。
  assert.ok(wideWalletText.includes('余额$12.35'), `第二行应显示余额：${wideWalletText}`);
  assert.ok(wideWalletText.includes('今日$0.0042'), `第二行应显示当日费用：${wideWalletText}`);

  const stripButton = findByClass(wideWallet, 'pw-strip');
  assert.equal(stripButton.length, 1);
  assert.ok(stripButton[0].props.title.includes('余额 $12.35'), '悬停提示里也要有余额');

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
  assert.ok(cardText.includes('余额（USD）'), `应列出钱包币种：${cardText}`);
  assert.ok(cardText.includes('$12.35'), '卡片应显示余额');
  assert.ok(cardText.includes('赠送（USD）'), '赠送钱包单独一行');
  assert.ok(cardText.includes('今日费用 · 2026-10-03'), '卡片应标注当日');
  assert.ok(cardText.includes('$0.0042'), '卡片应显示当日费用');
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
    assert.ok(conciseText.includes('还需'), '简洁版要有持续时间');
    assert.ok(conciseText.includes('余额（USD）'), '简洁版要有余额');
    assert.ok(conciseText.includes('今日费用'), '简洁版要有今日费用');
    assert.equal(findByClass(concise, 'pw-table').length, 0, '简洁版不显示价格表');
    assert.ok(!conciseText.includes('详细版'), 'v0.4.0：简洁版不再挂「切到详细版」的指路小字');
    // v0.4.1：入口死锁修复 —— 切模式要去设置页，简洁版若没有入口就永远进不去
    assert.equal(findByClass(concise, 'pw-set-btn').length, 1, '简洁版底部也要有「设置」入口');
    assert.equal(findByClass(concise, 'pw-actions').length, 1, '简洁版的按钮同样放在 pw-actions 容器里');

    const detailed = exports.details(now, state, exports.describePeriod(state), payload, 'detailed');
    assert.equal(findByClass(detailed, 'pw-table').length, 1, '详细版要有价格表');
    assert.equal(findByClass(detailed, 'pw-sec').length, 3, '详细版三个分节：时段 / 账户 / 价格表');
    assert.ok(collectText(detailed).join('').includes('官方价格表'), '分节标题要可读');

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

// ── 6c. 优化气泡：busy → done（√ 撤销 / × 保留）→ error（知道了） ──────────
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

  // ② done：问「需要撤销吗？」+ √ / × 两个按钮，**不设消失时间**（v0.4.1）
  whaleApi.commit({
    busy: false,
    undo: { el: fakeBox, original: '原稿', optimized: '新稿', since: Date.now() },
    opt: { kind: 'done', text: '提示词优化好了', ask: '需要撤销这次优化吗？', until: 0 },
  });
  const done = findByClass(roamer.current, 'pw-opt')[0];
  assert.equal(done.props['data-kind'], 'done');
  assert.equal(done.props.role, 'dialog', '撤销询问是对话框语义');
  const doneText = collectText(done).join('');
  assert.ok(doneText.includes('需要撤销这次优化吗'), '要问清楚问题');
  assert.ok(!doneText.includes('秒后自动收起'), 'v0.4.1：撤销询问不再有倒计时文案');
  assert.equal(findByClass(done, 'pw-opt-left').length, 0, '倒计时元素要整块拿掉');
  const yesBtn = findAll(done, 'button').find((b) => collectText(b).join('').includes('√'));
  const noBtn = findAll(done, 'button').find((b) => collectText(b).join('').includes('×'));
  assert.ok(yesBtn && noBtn, '√ 与 × 两个选项都要有');

  // × 保留：只收对话框，不动文本框
  fakeBox.value = '新稿';
  noBtn.props.onClick();
  assert.equal(whaleApi.store.opt, null, '× 后对话框收掉');
  assert.equal(fakeBox.value, '新稿', '× 表示保留优化结果，不能改文本框');
  assert.equal(opts().length, 0, 'DOM 里也不该再有气泡');

  // √ 撤销：原稿写回，对话框收掉
  whaleApi.commit({
    undo: { el: fakeBox, original: '原稿', optimized: '新稿', since: Date.now() },
    opt: { kind: 'done', text: '提示词优化好了', ask: '需要撤销这次优化吗？', until: 0 },
  });
  findAll(findByClass(roamer.current, 'pw-opt')[0], 'button')
    .find((b) => collectText(b).join('').includes('√'))
    .props.onClick();
  assert.equal(fakeBox.value, '原稿', '√ 要把原稿写回文本框');
  assert.equal(whaleApi.store.undo, null, '撤销后不再有待撤销态');
  assert.equal(whaleApi.store.opt, null, '对话框一起收掉');

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

  // ④ 右键菜单里也有撤销入口（气泡被改字 / 超时收掉之后还能救回来）
  whaleApi.commit({ opt: null, undo: { el: fakeBox, original: 'A', optimized: 'B', since: Date.now() } });
  const hitForMenu = () => findByClass(roamer.current, 'pw-hitbox')[0];
  hitForMenu().props.onContextMenu.call(
    { setPointerCapture() {}, releasePointerCapture() {} },
    { clientX: 300, clientY: 200, preventDefault() {}, stopPropagation() {} },
  );
  const menuLabels = findAll(roamer.current, 'button').map((b) => collectText(b).join(''));
  assert.ok(
    menuLabels.includes('撤销提示词优化'),
    `右键菜单要有撤销入口：${menuLabels.join(' / ')}`,
  );
  findAll(roamer.current, 'button')
    .find((b) => collectText(b).join('').includes('撤销提示词优化'))
    .props.onClick();
  assert.equal(fakeBox.value, 'A', '菜单里的撤销也要能把原稿写回');
  assert.equal(whaleApi.store.undo, null, '菜单撤销同样清掉待撤销态');
  assert.equal(findByClass(roamer.current, 'pw-menu').length, 0, '菜单点完要关');
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
  assert.equal(exports.saveAffinity(boom, 1), false, 'setItem 抛错要吞掉');
}

// ── 8. 右键菜单：能开、能关，动作在 ctl 缺席时也不能崩 ────────────────────────
{
  const node = { setPointerCapture() {}, releasePointerCapture() {} };
  const hitNow = () => findByClass(roamer.current, 'pw-hitbox')[0];
  const openMenu = () =>
    hitNow().props.onContextMenu.call(node, {
      clientX: 300,
      clientY: 200,
      preventDefault() {},
      stopPropagation() {},
    });
  const buttonLabels = () => findAll(roamer.current, 'button').map((b) => collectText(b).join(''));

  openMenu();
  assert.equal(findByClass(roamer.current, 'pw-menu').length, 1, '右键后应弹出菜单');
  const labels = buttonLabels();
  for (const expected of ['换个姿势', '摸摸头', '念句价格', '回家', '安静一会儿', '自由活动']) {
    assert.ok(labels.includes(expected), `菜单应有「${expected}」，实得：${labels.join(' / ')}`);
  }
  assert.ok(
    collectText(findByClass(roamer.current, 'pw-menu-note')).join('').includes('亲密度'),
    '菜单应显示亲密度与互动次数',
  );

  // 菜单里的动作在没有 ctl（初始化失败）时也必须安全：逐个点一遍
  for (const button of findAll(roamer.current, 'button')) {
    button.props.onClick();
    assert.equal(findByClass(roamer.current, 'pw-menu').length, 0, '点任一项都应关闭菜单');
    openMenu();
  }
  // 「念句价格」即使没有 ctl 也应该把气泡点亮（它是纯前端文案）
  findAll(roamer.current, 'button')
    .find((b) => collectText(b).join('').includes('念句价格'))
    .props.onClick();

  // 点空白处关闭
  openMenu();
  findByClass(roamer.current, 'pw-menu-backdrop')[0].props.onClick();
  assert.equal(findByClass(roamer.current, 'pw-menu').length, 0, '点空白处应关闭菜单');
}

// ── 9. 台词随峰谷变化（纯函数） ──────────────────────────────────────────────
assert.equal(typeof exports.roamLines, 'function');
{
  const off = exports.roamLines(new Date('2026-10-03T12:00:00Z')); // 国庆假期 → 半价
  const offText = off.price.join('|');
  assert.ok(/半价|便宜|打折/.test(offText), `谷时台词应提到便宜：${offText}`);
  assert.ok(off.price.length >= 2 && off.idle.length >= 3 && off.greet.length >= 1);

  const peak = exports.roamLines(new Date('2026-10-08T02:00:00Z')); // 工作日峰时
  const peakText = peak.price.join('|');
  assert.ok(/全价|峰时|贵/.test(peakText), `峰时台词应提到贵：${peakText}`);
  // 峰时可以劝人「等半价再跑」，但不能声称现在就是半价
  assert.ok(!/现在是谷时|便宜一半|半价时段/.test(peakText), `峰时台词不该说现在半价：${peakText}`);
  assert.ok(!/全价|峰时/.test(offText), `谷时台词不该说全价/峰时：${offText}`);
}

// ── 9b. 打字回避：你在输入框里打字时她要离开文本框区域（纯判定） ─────────────
{
  // 哪些元素算「能打字的地方」
  assert.equal(exports.isEditable({ tagName: 'TEXTAREA' }), true, 'textarea 算');
  assert.equal(exports.isEditable({ tagName: 'INPUT', type: 'text' }), true, '文本框算');
  assert.equal(exports.isEditable({ tagName: 'input', type: 'SEARCH' }), true, '大小写与默认类型都要认');
  assert.equal(exports.isEditable({ tagName: 'INPUT', type: 'checkbox' }), false, '勾选框不算');
  assert.equal(exports.isEditable({ tagName: 'INPUT', type: 'hidden' }), false, '隐藏框不算');
  assert.equal(exports.isEditable({ tagName: 'INPUT', type: 'text', disabled: true }), false, '禁用的不算');
  assert.equal(exports.isEditable({ tagName: 'DIV', isContentEditable: true }), true, 'contenteditable 算');
  assert.equal(exports.isEditable({ tagName: 'DIV' }), false, '普通容器不算');
  assert.equal(exports.isEditable(null), false, '空值不算');

  // 焦点落在编辑器的子节点上时，要往上找到真正的文本框
  const editor = { tagName: 'DIV', isContentEditable: true, parentElement: null };
  const innerNode = { tagName: 'P', parentElement: editor };
  assert.equal(exports.editableAncestor(innerNode), editor, '子节点要能向上找到文本框');
  assert.equal(exports.editableAncestor(editor), editor, '本身就是文本框时直接返回');
  assert.equal(exports.editableAncestor({ tagName: 'P', parentElement: null }), null, '一路找不到 → null');
  assert.equal(exports.editableAncestor(null), null, '空值 → null');
  {
    let deep = { tagName: 'SPAN', parentElement: null };
    for (let i = 0; i < 8; i += 1) deep = { tagName: 'SPAN', parentElement: deep };
    assert.equal(exports.editableAncestor(deep), null, '向上查找层数封顶，不会一路爬到 document');
  }

  // 「算不算正在打字」：宽限期内，或者焦点还留在文本框里（打完一句停着也算）
  assert.equal(exports.typingActive(null, 1000, 999), true, '宽限期内算打字');
  assert.equal(exports.typingActive(null, 1000, 1001), false, '过了宽限期且没焦点 → 不算');
  assert.equal(exports.typingActive({ tagName: 'TEXTAREA' }, 0, 99999), true, '光标还在框里就一直算');
  assert.equal(exports.typingActive({ tagName: 'DIV', isContentEditable: true }, 0, 99999), true, 'contenteditable 同理');
  assert.equal(exports.typingActive({ tagName: 'DIV' }, 0, 99999), false, '焦点在普通元素上不算');
  assert.equal(exports.typingActive(null, 0, 0), false, '没宽限没焦点就不回避');

  // 回避区：横向留缝（别压住输入框旁边的按钮），纵向上浅下深（下面还有工具行）
  const box = {
    tagName: 'TEXTAREA',
    getBoundingClientRect: () => ({ left: 400, right: 900, top: 500, bottom: 560, width: 500, height: 60 }),
  };
  const zone = exports.editableZone(box);
  assert.equal(zone.left, 400 - exports.AVOID_MARGIN_X, '左沿外扩');
  assert.equal(zone.right, 900 + exports.AVOID_MARGIN_X, '右沿外扩');
  assert.ok(zone.top < 500 && zone.bottom > 560, '纵向上浅下深');
  assert.ok(zone.bottom - 560 >= 60, '下沿要盖住输入框下面的工具行');
  assert.equal(exports.editableZone({ tagName: 'DIV' }), null, '没有 rect 的元素给 null');
  assert.equal(
    exports.editableZone({ tagName: 'TEXTAREA', getBoundingClientRect() { throw new Error('拿不到'); } }),
    null,
    '取 rect 抛错要吞掉',
  );
  assert.equal(exports.editableZone({ tagName: 'DIV', isContentEditable: true }), null, '非文本框直接 null');

  // 矩形相交
  const a = { left: 0, right: 10, top: 0, bottom: 10 };
  assert.equal(exports.rectsOverlap(a, { left: 5, right: 15, top: 5, bottom: 15 }, 0), true);
  assert.equal(exports.rectsOverlap(a, { left: 20, right: 30, top: 0, bottom: 10 }, 0), false);
  assert.equal(exports.rectsOverlap(a, { left: 12, right: 30, top: 0, bottom: 10 }, 3), true, 'pad 会放宽判定');

  // 走位：不挡路就别动她；挡路就走到框外**最近**的一侧
  const pet = (left) => ({ left, right: left + 148, top: 600, bottom: 745 }); // 身高 145，贴地
  assert.equal(exports.escapePlan(pet(100), zone, 1280), null, '站在文本框左边不挡路 → 不动');
  assert.equal(exports.escapePlan(pet(1100), zone, 1280), null, '站在右边也不挡路 → 不动');
  assert.equal(exports.escapePlan(null, zone, 1280), null, '还没有身体矩形时不动');
  assert.equal(exports.escapePlan(pet(600), null, 1280), null, '没有文本框时不动');

  const clear = (target, half) => target + half <= zone.left || target - half >= zone.right;
  const inside = exports.escapePlan(pet(600), zone, 1280); // 正站在框里
  assert.ok(inside !== null, '挡路必须给出目标');
  assert.ok(clear(inside, 74), `目标必须真的在回避区外（实得 x=${inside}）`);

  const leftWay = exports.escapePlan(pet(430), zone, 1280); // 在框的左半边
  assert.ok(leftWay !== null && leftWay + 74 <= zone.left, `框的左半边应往左让（实得 x=${leftWay}）`);
  const rightWay = exports.escapePlan(pet(860), zone, 1280); // 在框的右半边
  assert.ok(rightWay !== null && rightWay - 74 >= zone.right, `右半边应往右让（实得 x=${rightWay}）`);

  // 必须留出间隙：她的包围盒随走姿晃动，「刚好贴边」走到位时又会压回区里
  // （真实浏览器里翻过车：差 6px 没出去 → pet-harness 的行为断言抓住的）
  assert.ok(exports.AVOID_CLEARANCE >= 16, '间隙要能吃掉走姿晃动');
  {
    const target = exports.escapeTargetX(pet(600), zone, 1280);
    const half = 74;
    const gap = target + half <= zone.left
      ? zone.left - (target + half)
      : (target - half) - zone.right;
    assert.ok(
      gap >= exports.AVOID_CLEARANCE,
      `目标要留足 ${exports.AVOID_CLEARANCE}px 间隙，实得 ${gap}px`,
    );
  }

  // 窗口太窄、两侧都塞不下：返回 null（与其在框里来回蹭，不如下次再试）
  assert.equal(
    exports.escapePlan(pet(300), { left: 100, right: 600, top: 476, bottom: 632 }, 700),
    null,
    '两侧都塞不下时不硬挤',
  );
  // 目标不能越过窗口边界
  const edgeTarget = exports.escapeTargetX(pet(30), { left: 200, right: 900, top: 0, bottom: 10 }, 1280);
  assert.ok(edgeTarget === null || edgeTarget - 74 >= 8, `目标不能穿墙（实得 x=${edgeTarget}）`);
}

// ── 9c. 提示词优化：投递判定、写回、撤销的纯逻辑 ────────────────────────────
{
  assert.equal(exports.OPTIMIZE_ROUTE, '/dsh-deepseek-peak-whale/api/optimize', '要打 Host 的优化路由');
  assert.equal(exports.DROP_PAD, 16, '投递判定的余量比回避区小（要笃定）');

  // 读
  assert.equal(exports.readComposer({ tagName: 'TEXTAREA', value: '帮我写个脚本' }), '帮我写个脚本');
  assert.equal(exports.readComposer({ tagName: 'DIV', innerText: '正文' }), '正文');
  assert.equal(exports.readComposer({ tagName: 'DIV', textContent: '备选' }), '备选', 'innerText 缺席时退回 textContent');
  assert.equal(exports.readComposer(null), '', '没有元素给空串');
  assert.equal(exports.readComposer({ tagName: 'DIV' }), '', '空容器给空串');

  // 写：textarea —— 必须派发 input，否则应用以为你没改，一回车就丢
  const dispatched = [];
  const target = {
    tagName: 'TEXTAREA',
    value: 'old',
    dispatchEvent(event) {
      dispatched.push(event.type);
    },
  };
  assert.equal(exports.writeComposer(target, 'new text'), true);
  assert.equal(target.value, 'new text');
  assert.deepEqual(dispatched, ['input'], '必须派发 input');

  // 写：contenteditable
  const editable = { tagName: 'DIV', innerText: 'old' };
  assert.equal(exports.writeComposer(editable, '新正文'), true);
  assert.equal(editable.innerText, '新正文');

  assert.equal(exports.writeComposer(null, 'x'), false, '没有元素写不了');
  assert.equal(exports.writeComposer({ tagName: 'TEXTAREA' }, 'x'), true, '没有 dispatchEvent 也要能写进去');

  // 投递区：文本框本体 ±16px
  const box = {
    tagName: 'TEXTAREA',
    getBoundingClientRect: () => ({ left: 400, right: 900, top: 500, bottom: 560, width: 500, height: 60 }),
  };
  const zone = exports.dropZone(box);
  assert.equal(zone.left, 400 - exports.DROP_PAD, '投递区左沿外扩');
  assert.equal(zone.right, 900 + exports.DROP_PAD, '投递区右沿外扩');
  assert.equal(exports.dropZone({ tagName: 'TEXTAREA' }), null, '没有 rect → null');
  assert.equal(exports.dropZone({ tagName: 'DIV' }), null, '非文本框 → null');

  assert.equal(exports.pointInRect({ x: 400, y: 520 }, zone), true, '框内算投递');
  assert.equal(exports.pointInRect({ x: 390, y: 520 }, zone), true, '外扩 16px 内也算');
  assert.equal(exports.pointInRect({ x: 300, y: 520 }, zone), false, '离远了不算投递（该正常抛出去）');
  assert.equal(exports.pointInRect({ x: 400, y: 100 }, zone), false, '垂直方向也不算');
  assert.equal(exports.pointInRect(null, zone), false);

  // 撤销的收起规则：用户改过就绝不拿旧稿盖新输入
  const undo = { since: 1000, optimized: 'B 版', original: 'A 版' };
  assert.equal(exports.shouldDismissUndo(undo, 'B 版', 1000 + 100), false, '写回宽限期内不动');
  assert.equal(exports.shouldDismissUndo(undo, 'B 版', 1000 + 900), false, '内容没变就一直能撤');
  assert.equal(exports.shouldDismissUndo(undo, '我自己改过的', 1000 + 900), true, '改过 → 收起撤销');
  assert.equal(exports.shouldDismissUndo(null, 'x', 99999), false, '没有撤销态就不折腾');

  // 浏览器外调优化路由：不抛，给一句能看懂的原因
  const pending = exports.optimizePrompt('测试文本');
  assert.equal(typeof pending.then, 'function', '要返回 Promise');
  const outcome = await pending;
  assert.equal(outcome.ok, false);
  assert.ok(typeof outcome.message === 'string' && outcome.message.length > 0, '失败必须带 message');
}

// ── 10. Host 半身必须是普通 ESM ──────────────────────────────────────────────
const hostSource = readFileSync(join(ROOT, 'index.js'), 'utf8');
assert.ok(!hostSource.includes('__ModuleLoader__'), 'Host 半身不能带浏览器包装');
assert.ok(hostSource.includes("export const name = 'peak-whale'"), 'Host 半身要导出稳定插件名');
assert.ok(hostSource.includes('export function apply'), 'Host 半身要导出 apply');

// ── 10b. 撤销询问不设消失时间（v0.4.1）───────────────────────────────────────
// 需求：计时不能从「发起优化」就开始，对话框更不该自己消失 —— 完成态一律 until: 0，
// 只有「你自己改了提示词」那条安全网和失败说明（8 秒）还会自动收起。
const clientSource = readFileSync(join(ROOT, 'client.template.js'), 'utf8');
assert.ok(
  /kind: 'done'[\s\S]{0,240}until: 0/.test(clientSource),
  '完成态必须写 until: 0（不设消失时间）',
);
assert.ok(!clientSource.includes('30000'), '不该再留 30 秒的自动收起源码');
assert.ok(
  !/store\.opt\.ask[\s\S]{0,240}自动收起/.test(clientSource),
  '撤销询问旁边不该再有自动收起文案（失败说明的 8 秒保留）',
);
assert.ok(clientSource.includes('pw-opt-left') === false, '倒计时的 DOM/CSS 都要拿掉');
// 默认排版是简洁版（v0.4.1）：客户端初始 state 与两处模式回落都要跟着走
assert.ok(
  clientSource.includes("uiSettingsState = { uiMode: 'concise'"),
  '客户端设置初始值应为简洁版',
);
assert.ok(
  !clientSource.includes("uiMode === 'concise' ? 'concise' : 'detailed'"),
  '模式回落不能再默认详细版',
);

// ── 11. 核心源码必须自包含 ────────────────────────────────────────────────────
const coreSource = readFileSync(join(ROOT, 'src', 'peak.js'), 'utf8');
assert.ok(!/^\s*import\b/m.test(coreSource), 'src/peak.js 不能有 import（要能被内联进浏览器）');

// ── 12. vendored 运行时必须自带出处与许可说明 ─────────────────────────────────
const runtimeSource = readFileSync(join(ROOT, 'vendor', 'pet-runtime.js'), 'utf8');
assert.ok(runtimeSource.includes('Coopanion'), '运行时文件应保留上游出处');
assert.ok(runtimeSource.includes('AGPL'), '运行时文件应标明 AGPL 许可');
assert.ok(!/^\s*(import|export)\b/m.test(runtimeSource), '运行时必须是自包含脚本，不能有模块语法');

// ── 13. 卸载：打字回避的监听要摘干净（漏一份就是每次换组件都多挂一个全局监听） ─
assert.equal(doc.document.removed.length, 0, '卸载前监听一个都不该被摘');
React.__unmount();
for (const type of ['keydown', 'input', 'focusin', 'focusout']) {
  assert.ok(doc.document.removed.includes(type), `卸载时必须摘掉 ${type}`);
}

console.log('bundle.test.mjs: 握手 / 双挂载点 / 运行时与贴图 / 价格条 / 打字回避 / 桌宠组件 / 菜单 / 台词 全部通过');
console.log('  registered id :', registration.id);
console.log('  apply trace   :', seen.join(' -> '));
console.log('  谷时文本      :', wideOffText);
console.log('  峰时文本      :', widePeakText);
console.log('  运行时        :', `部件 ${model.parts.length} 个，贴图 ${expectedKeys.length} 张`);
console.log('  打字回避      :', '监听 ' + doc.document.listeners.join('/') + ' → 卸载摘除 ' + doc.document.removed.join('/'));
console.log('  降级行为      :', warnings[0] ? warnings[0].slice(0, 60) + '…' : '(无告警)');
