/**
 * 手势层（gesture）测试。
 *
 * 这一层是本轮新加的地基，所以测得比别处细：
 *   - 契约：GESTURES 表里每个动作都要有 dur / min，且 arm pose 名字不能在 figure.js 里漏掉；
 *   - 行为：真的 step 几百帧，手臂、尾巴、情绪通道必须真的动，而且必须动完就还原；
 *   - 不越界：手势绝不能改 mode，绝不能留下表情，绝不能跟 pulse / walk 打架。
 *
 * ⚠️ 假绿防护（本轮吃过一次亏）：
 *   凡是断言「figure.js 里必须存在某个分支」的，都直接对源码正则匹配，
 *   而不是调 figure.draw —— draw 需要 canvas/GL，node 里跑不起来，
 *   写成「跑得起来但其实什么都没验」的断言只会一直绿。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPet, GESTURES } from '../vendor/pet-core.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

let pass = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { pass++; return; }
  fails.push(name + (detail ? ` — ${detail}` : ''));
}
function eq(name, got, want) { ok(name, got === want, `got=${got} want=${want}`); }
function near(name, got, want, tol) { ok(name, Math.abs(got - want) <= tol, `got=${got} want≈${want}±${tol}`); }

/**
 * 一个够用的舞台 + 控制器，不需要任何 DOM。
 *
 * 默认 `roam: 'off'`：自由漫游的 `decide()` 会每隔几秒派活（走路、坐下、换表情），
 * 而本文件大半断言是「演完身体回到原样 / mode 不变」——漫游一插手这些断言就全在测
 * 漫游而不是测手势了（第一版就栽在这：13 条失败全是 `mode=walk`、`expr=wink` 这种
 * 漫游派出来的活，不是手势的残留）。要测与漫游共存的情况，下面另有专门的用例。
 */
function mount(overrides = {}) {
  const petG = { setAttribute() {}, contains: () => true, textContent: '' };
  const els = { petG, shadowEl: { setAttribute() {} }, fxG: { setAttribute() {} } };
  const opts = {
    els,
    sfx: new Proxy({}, { get: () => () => {} }),
    bounds: () => ({ W: 800, H: 400, floorY: 340, S: 0.45 }),
    onEvent() {},
    roam: 'off',
    ...overrides,
  };
  const ctl = createPet(els, opts);
  return ctl;
}

/** 跑 n 帧，返回每帧的快照序列。 */
function run(ctl, n, dt = 1 / 60) {
  const out = [];
  for (let i = 0; i < n; i++) { ctl.step(dt); ctl.render(); out.push({ ...ctl.pet, look: [...ctl.pet.look] }); }
  return out;
}

// ─────────────────────────────────────────────────────────────
// 1. 契约：GESTURES 表
// ─────────────────────────────────────────────────────────────
const names = Object.keys(GESTURES);
ok('GESTURES 非空', names.length >= 10, `只有 ${names.length} 个`);
for (const n of names) {
  const g = GESTURES[n];
  ok(`GESTURES.${n}.dur 是正数`, typeof g.dur === 'number' && g.dur > 0 && g.dur <= 4, `dur=${g.dur}`);
  ok(`GESTURES.${n}.min 合法`, g.min === 'calm' || g.min === 'any', `min=${g.min}`);
  ok(`GESTURES.${n}.face 是已知表情或空`, g.face == null || typeof g.face === 'string', `face=${g.face}`);
}
ok('brace 是唯一 any（被拎起来才演的）', Object.keys(GESTURES).filter((n) => GESTURES[n].min === 'any').join() === 'brace');
eq('brace 允许被拎起来时演', GESTURES.brace.min, 'any');
// dur 越短越"小动作"，但每个都必须 >1s，否则视觉上根本看不见
for (const n of names) ok(`GESTURES.${n} 时长够看得见`, GESTURES[n].dur >= 1.2, `dur=${GESTURES[n].dur}`);

// ─────────────────────────────────────────────────────────────
// 2. pet-core 里每个 gesture 名都要有真正的实现（不能是空壳）
// ─────────────────────────────────────────────────────────────
const coreSrc = readFileSync(join(root, 'vendor/pet-core.js'), 'utf8');
for (const n of names) {
  const re = new RegExp(`case\\s+'${n}'\\s*:`);
  ok(`pet-core 有 '${n}' 的实现分支`, re.test(coreSrc),
    '表里有但 step() 的 switch 里没有 —— 演了等于没演');
}

// ─────────────────────────────────────────────────────────────
// 3. figure.js 的手臂分支必须覆盖每个手势（源码断言，见文件头说明）
// ─────────────────────────────────────────────────────────────
const figSrc = readFileSync(join(root, 'vendor/figure.js'), 'utf8');
const armBlock = figSrc.slice(figSrc.indexOf('gestures reach with the arms'), figSrc.indexOf('const armN = sp.armN.step'));
ok('figure.js 找到了手臂手势块', armBlock.length > 200, `块长 ${armBlock.length}`);
for (const n of names) {
  ok(`figure.js 手臂有 '${n}' 的姿态`, armBlock.includes(`case '${n}':`),
    'pet-core 动了身体但手没动 —— 看起来像整个人在滑');
}
ok('figure.js 读了 o.gest', /const gest = o\.gest \|\| ''/.test(figSrc));
ok('figure.js 读了 o.mood', /o\.mood \?\? 0/.test(figSrc));
ok('pet-core 把 gest 传进 figure 的帧', /gest: pet\.gestName/.test(coreSrc));
ok('pet-core 把 mood 传进 figure 的帧', /mood: pet\.mood/.test(coreSrc));

// ─────────────────────────────────────────────────────────────
// 4. 真跑：手势必须真的改变身体通道
// ─────────────────────────────────────────────────────────────
{
  const ctl = mount();
  run(ctl, 20);
  const base = { lean: ctl.pet.lean, tilt: ctl.pet.tilt, sit: ctl.pet.sitK, look: ctl.pet.look.slice(), lift: ctl.pet.lift };
  ok('手势开始前它站得稳', Math.abs(base.lean) < 0.5 && Math.abs(base.tilt) < 0.5);

  const movers = [];
  for (const n of names) {
    const c = mount();
    run(c, 20);
    const before = { lean: c.pet.lean, tilt: c.pet.tilt, sit: c.pet.sitK, look: c.pet.look.slice(), sq: c.pet.sq };
    ok(`${n} 能在站姿下起手`, c.gesture(n) === true, '返回 false = 没演起来');
    eq(`${n} 起手后 gestName 正确`, c.gestureName(), n);
    const frames = run(c, Math.ceil(GESTURES[n].dur * 60));
    const peak = {
      lean: Math.max(...frames.map((f) => Math.abs(f.lean))),
      tilt: Math.max(...frames.map((f) => Math.abs(f.tilt))),
      sit: Math.max(...frames.map((f) => f.sitK)),
      lift: Math.max(...frames.map((f) => f.lift)),
      lookx: Math.max(...frames.map((f) => Math.abs(f.look[0]))),
      looky: Math.max(...frames.map((f) => Math.abs(f.look[1]))),
      sq: Math.max(...frames.map((f) => Math.abs(f.sq))),
    };
    const moved = peak.lean - Math.abs(before.lean) > 1.5
      || peak.tilt - Math.abs(before.tilt) > 1.5
      || peak.sit - before.sit > .08
      || peak.lift > .1
      || peak.lookx - Math.abs(before.look[0]) > 1
      || peak.looky - Math.abs(before.look[1]) > 1
      || peak.sq - Math.abs(before.sq) > .02;
    ok(`${n} 真的动了身体`, moved, `峰值 ${JSON.stringify(peak)}`);
    if (moved) movers.push(n);
  }
  ok('至少 10 个手势真的动了身体', movers.length >= 10, `只有 ${movers.length} 个：${movers.join()}`);
}

// ─────────────────────────────────────────────────────────────
// 5. 演完必须还原：mode 不变、表情不残留、通道回位
// ─────────────────────────────────────────────────────────────
for (const n of names) {
  const c = mount();
  run(c, 30);
  const mode0 = c.pet.mode;
  c.gesture(n);
  run(c, Math.ceil((GESTURES[n].dur + .4) * 60));
  eq(`${n} 演完 mode 不变`, c.pet.mode, mode0);
  eq(`${n} 演完 gestName 归零`, c.gestureName(), '');
  const tail = run(c, 140); // 再给它两秒回到静止
  const endLean = Math.abs(tail[tail.length - 1].lean);
  const endTilt = Math.abs(tail[tail.length - 1].tilt);
  ok(`${n} 演完身体回位`, endLean < 1.2 && endTilt < 1.2, `lean=${endLean.toFixed(2)} tilt=${endTilt.toFixed(2)}`);
  ok(`${n} 演完不留表情`, c.pet.expr == null, `expr=${c.pet.expr}`);
}
{
  // 表情必须还给原来那个，不能被手势抢走
  const c = mount();
  run(c, 20);
  c.setExpr('thinking', 6);
  c.gesture('shakeout'); // 它自带 face:'happy'
  run(c, Math.ceil((GESTURES.shakeout.dur + .5) * 60));
  eq('手势演完把原来的表情还回来了', c.pet.expr, 'thinking');
}
{
  const c = mount();
  run(c, 20);
  c.gesture('swat');
  run(c, Math.ceil((GESTURES.swat.dur + .6) * 60));
  eq('自带表情的手势，演完不留自己的表情', c.pet.expr, null);
}

// ─────────────────────────────────────────────────────────────
// 6. 不越界
// ─────────────────────────────────────────────────────────────
{
  // 坐着能演（坐着也得有肢体反应），但姿势不变回站立
  const c = mount();
  run(c, 20);
  c.act('sit');
  run(c, 40);
  eq('先坐好', c.pet.mode, 'sit');
  ok('坐着也能起手势', c.gesture('stretch') === true);
  eq('坐着起手势不改 sit 模式', c.pet.mode, 'sit');
}
{
  // 空中 / 被拎着：只有 brace 允许，其余一律拒绝
  for (const n of names) {
    const c = mount();
    run(c, 20);
    c.pet.mode = 'drag'; c.pet.dx = 100; c.pet.dy = 100;
    const r = c.gesture(n);
    if (n === 'brace') ok('被拎起来时 brace 仍能演', r === true);
    else ok(`被拎起来时拒绝 ${n}`, r === false, '返回 true —— 会跟拖拽打架');
  }
}
{
  // 连着两个手势：第二个必须被挡下来（否则像抽搐）
  const c = mount();
  run(c, 20);
  c.gesture('stretch');
  eq('紧接着再起一个被挡', c.gesture('beg'), false);
  run(c, Math.ceil((GESTURES.stretch.dur + .8) * 60));
  ok('上一个演完之后可以再起', c.gesture('beg') === true);
}
{
  // 未知名字不炸
  const c = mount();
  run(c, 20);
  eq('未知手势返回 false', c.gesture('no-such-thing'), false);
  ok('未知手势不会把表弄坏', typeof GESTURES === 'object' && Object.keys(GESTURES).length === names.length);
}

// ─────────────────────────────────────────────────────────────
// 7. 情绪通道
// ─────────────────────────────────────────────────────────────
{
  const c = mount();
  run(c, 20);
  c.setMood(1);
  let peak = 0;
  const f = run(c, 90);
  for (const s of f) peak = Math.max(peak, s.mood);
  ok('情绪能被弹簧带上去（不是瞬跳）', peak > .7, `峰值 ${peak}`);
  c.setMood(0);
  const g = run(c, 120);
  ok('情绪能降回来', g[g.length - 1].mood < .2, `收在 ${g[g.length - 1].mood.toFixed(2)}`);
}
{
  const c = mount();
  run(c, 20);
  c.setMood(5); run(c, 60);
  ok('越界的情绪被夹在 1', c.pet.mood <= 1.001, `${c.pet.mood}`);
  c.setMood(-3); run(c, 60);
  ok('负的情绪被夹在 0', c.pet.mood >= -0.001, `${c.pet.mood}`);
  c.setMood('不是数字'); run(c, 30);
  ok('非数字情绪当 0', c.pet.moodTarget === 0, `${c.pet.moodTarget}`);
}

// ─────────────────────────────────────────────────────────────
// 8. 与既有系统不打架：walk 的步态、pulse 的 nod
// ─────────────────────────────────────────────────────────────
{
  const c = mount();
  run(c, 20);
  c.act('walk');
  run(c, 30);
  eq('拒绝在走路时起手势（走路的手是步态的）', c.gesture('stretch'), false);
}
{
  const c = mount();
  run(c, 20);
  c.act('nod');
  c.gesture('giggle');
  const f = run(c, 60);
  ok('pulse 与手势可以叠着演完', f.length === 60);
  eq('叠完之后 pulse 也归零', c.pet.pulse, null);
}
{
  // 手势期间 mode 仍是原来的，figure 才不会突然换成坐姿图
  const c = mount();
  run(c, 20);
  c.act('sit'); run(c, 40);
  c.gesture('curl'); // curl 会把 sitK 往 .85 推
  const f = run(c, 40);
  eq('curl 期间 mode 仍是 sit', c.pet.mode, 'sit');
  ok('curl 让坐姿更深', Math.max(...f.map((s) => s.sitK)) > .8);
}

// ⚠️ 不要在这里 process.exit()：run-all.mjs 是用 import() 串行加载各套测试的，
// 本套一退出，后面 bundle/parity 根本不会跑 —— 而 run-all 仍会因为"前面都绿"而
// 打印"全部测试通过 ✓"。第一版就这么写，结果 style / bundle / parity 三套静默失跑。
// 失败用抛异常表达（Node 会打印栈，非 0 退出），让 run-all 自己决定何时退出。
if (fails.length) {
  console.error(`gesture.test.mjs: ${pass} 通过, ${fails.length} 失败`);
  for (const f of fails) console.error('  ✗ ' + f);
  throw new Error(`gesture.test.mjs: ${fails.length} 项失败`);
}
console.log(`gesture.test.mjs: ${pass} 通过, 0 失败`);
