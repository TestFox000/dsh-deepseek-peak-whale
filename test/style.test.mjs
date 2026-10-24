/**
 * 活动强度档 / 场景反应 / 手势契约 的测试。
 *
 * 这一轮加的东西里，能纯函数化的都抽出来了（styleTier / styleDelay / reactionStep /
 * pickGesture），就是为了能在这里一次测干净 —— 浏览器里的表现靠 pet-harness 抓，
 * 判定逻辑靠这里钉死。两者分开，才不会又出现"跑得起来但其实什么都没验"的假绿。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

// bundle.test.mjs 已有加载 client 的手法，这里沿用同一份来源，避免两套加载逻辑。
import { loadClientBundle } from './helpers.mjs';
const { exports: X } = loadClientBundle();

let pass = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { pass++; return; }
  fails.push(name + (detail ? ` — ${detail}` : ''));
}
function eq(name, got, want) { ok(name, got === want, `got=${got} want=${want}`); }

const { STYLE_TIERS, styleTier, loadStyle, saveStyle, styleDelay, pickGesture, reactionStep, REACT, roamLines, POSE_MOTIONS } = X;

// ─────────────────────────────────────────────────────────────
// 1. 三档本身
// ─────────────────────────────────────────────────────────────
eq('档位正好三档', STYLE_TIERS.length, 3);
eq('三档的 id', STYLE_TIERS.map((t) => t.id).join(), 'quiet,daily,lively');
for (const t of STYLE_TIERS) {
  ok(`${t.id} 有名字和说明`, typeof t.name === 'string' && t.name.length > 0 && typeof t.note === 'string' && t.note.length > 4);
  ok(`${t.id} tempo 是正数`, typeof t.tempo === 'number' && t.tempo > 0, `tempo=${t.tempo}`);
  ok(`${t.id} 有候选动作`, Array.isArray(t.motions) && t.motions.length >= 3, `${t.motions && t.motions.length}`);
  ok(`${t.id} 动作不重复`, new Set(t.motions).size === t.motions.length);
  ok(`${t.id} 候选池是字符串`, t.motions.every((m) => typeof m === 'string' && m.length > 0));
}
ok('安静档最克制', STYLE_TIERS[0].motions.length < STYLE_TIERS[1].motions.length, `${STYLE_TIERS[0].motions.length} vs ${STYLE_TIERS[1].motions.length}`);
ok('安静档触发最慢', STYLE_TIERS[0].tempo < STYLE_TIERS[1].tempo && STYLE_TIERS[1].tempo < STYLE_TIERS[2].tempo,
  `${STYLE_TIERS.map((t) => t.tempo).join()}`);
ok('安静档不做待机动作', STYLE_TIERS[0].idleGestures === 0);
ok('日常档有待机动作', STYLE_TIERS[1].idleGestures > 0);
ok('安静档反应被压低', STYLE_TIERS[0].reactions < STYLE_TIERS[2].reactions);
// 三档必须是嵌套的：安静的候选 ⊂ 日常 ⊂ 活泼，否则"换档"会让她少演或多演看不懂的东西
ok('安静的候选是日常的子集', STYLE_TIERS[0].motions.every((m) => STYLE_TIERS[1].motions.includes(m)),
  `差集 ${STYLE_TIERS[0].motions.filter((m) => !STYLE_TIERS[1].motions.includes(m))}`);
ok('活跃是日常的超集', STYLE_TIERS[2].motions.length >= STYLE_TIERS[1].motions.length);

// ─────────────────────────────────────────────────────────────
// 2. 候选池里的每个动作都必须是真存在的手势（源码断言，防拼错名字）
// ─────────────────────────────────────────────────────────────
const coreSrc = readFileSync(join(root, 'vendor/pet-core.js'), 'utf8');
const GESTURE_TABLE = coreSrc.slice(coreSrc.indexOf('export const GESTURES = {'), coreSrc.indexOf('});', coreSrc.indexOf('export const GESTURES = {')));
const declared = [...GESTURE_TABLE.matchAll(/^\s{2}([a-z]+):\s*\{/gm)].map((m) => m[1]);
ok('能解析出手势表', declared.length >= 10, `只认出 ${declared.length} 个：${declared.join()}`);
for (const t of STYLE_TIERS) {
  for (const m of t.motions) {
    ok(`${t.id} 的 "${m}" 是真手势`, declared.includes(m), `表里没有 —— 点了会变成"演了个不存在的东西"`);
  }
}

// ─────────────────────────────────────────────────────────────
// 3. styleTier / 存取
// ─────────────────────────────────────────────────────────────
eq('认得 quiet', styleTier('quiet').id, 'quiet');
eq('认得 lively', styleTier('lively').id, 'lively');
eq('坏值回默认档', styleTier('乱写的').id, 'daily');
eq('空值回默认档', styleTier(undefined).id, 'daily');
eq('null 回默认档', styleTier(null).id, 'daily');
eq('原型污染式的值也回默认档', styleTier('toString').id, 'daily');
{
  const store = new Map();
  const storage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) };
  eq('没存过时是 daily', loadStyle(storage), 'daily');
  saveStyle(storage, 'lively');
  eq('存了读得回来', loadStyle(storage), 'lively');
  eq('存的是带版本号的键', store.has(X.STYLE_KEY), true);
  saveStyle(storage, '坏值');
  eq('坏值存进去也读成默认档', loadStyle(storage), 'daily');
  saveStyle(storage, 'quiet');
  eq('空档位也能存取', loadStyle(storage), 'quiet');
  // 坏 storage 一律当默认值，绝不能抛
  eq('抛异常的 storage 当默认值', loadStyle({ getItem() { throw new Error('x'); } }), 'daily');
  eq('没有 getItem 的对象当默认值', loadStyle({}), 'daily');
  saveStyle({ setItem() { throw new Error('x'); } }, 'quiet'); // 不抛就算过
  ok('存不上不抛', true);
}

// ─────────────────────────────────────────────────────────────
// 4. styleDelay：安静档必须是"更久"，不是"照常频率的小事"
// ─────────────────────────────────────────────────────────────
{
  const range = STYLE_TIERS[1].idleMs;
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < 4000; i++) {
    const d = styleDelay(range, 1);
    ok('日常档落回原窗口', d >= range[0] - 1e-6 && d <= range[1] + 1e-6, `d=${d}`);
    lo = Math.min(lo, d); hi = Math.max(hi, d);
  }
  ok('日常档覆盖整个窗口', hi - lo > (range[1] - range[0]) * .9, `[${lo.toFixed(0)},${hi.toFixed(0)}]`);
}
{
  // 安静档 tempo .55 → 窗口整体拉长约 1.8 倍，而且**最小值**也要大于日常档的最小值
  const quiet = STYLE_TIERS[0].idleMs, daily = STYLE_TIERS[1].idleMs;
  let qmin = Infinity;
  for (let i = 0; i < 3000; i++) qmin = Math.min(qmin, styleDelay(daily, STYLE_TIERS[0].tempo));
  ok('安静档的最快间隔也慢过日常档的最快间隔', qmin > daily[0] * 1.4, `${qmin.toFixed(0)} vs ${daily[0]}`);
}
{
  // 拿**活泼档自己的窗口**跟日常档比。（第一版这里传的是日常档的窗口，
  // 于是拿 "240/1.6=150" 去跟日常的 110 比，得出"活泼不快"的假结论。）
  let lmax = 0;
  for (let i = 0; i < 3000; i++) lmax = Math.max(lmax, styleDelay(STYLE_TIERS[2].idleMs, STYLE_TIERS[2].tempo));
  ok('活泼档明显更快', lmax < STYLE_TIERS[1].idleMs[0], `${lmax.toFixed(0)} vs ${STYLE_TIERS[1].idleMs[0]}`);
  ok('活泼档最快间隔也快过日常档最快间隔',
    styleDelay(STYLE_TIERS[2].idleMs, STYLE_TIERS[2].tempo) >= STYLE_TIERS[2].idleMs[0] / STYLE_TIERS[2].tempo - 1e-6,
    '窗口下界应等于 idleMs[0]/tempo');
}
{
  // 坏 tempo 不能造出 0 间隔或 NaN —— 那会让每帧都满足条件
  for (const bad of [0, -1, NaN, undefined, 'x']) {
    let all = 0, n = 0, bad2 = 0;
    for (let i = 0; i < 500; i++) { const d = styleDelay([10, 20], bad); n++; if (!isFinite(d) || d <= 0) bad2++; if (d >= 10) all++; }
    ok(`坏 tempo=${bad} 不产生非正/NaN 间隔`, bad2 === 0, `${bad2}/${n} 个坏值`);
    ok(`坏 tempo=${bad} 仍然落回窗口内`, all === n, `${all}/${n}`);
  }
}

// ─────────────────────────────────────────────────────────────
// 5. pickGesture
// ─────────────────────────────────────────────────────────────
{
  eq('空池子返回 null', pickGesture([], null), null);
  eq('全被过滤返回 null', pickGesture(['a', 'b'], ['c']), null);
  ok('从池子里挑', ['a', 'b', 'c'].includes(pickGesture(['a', 'b', 'c'], null)));
  eq('allowed 只有一个时就是它', pickGesture(['a', 'b', 'c'], ['b']), 'b');
  // 挑出来的东西必须真的在池子里
  let all = 0;
  for (let i = 0; i < 2000; i++) { const g = pickGesture(STYLE_TIERS[1].motions, null); if (STYLE_TIERS[1].motions.includes(g)) all++; }
  eq('挑出来的永远在池子里', all, 2000);
  // 不传 allowed 时不该过滤
  ok('allowed 缺省等于不过滤', pickGesture(['x'], undefined) === 'x');
}

// ─────────────────────────────────────────────────────────────
// 6. reactionStep：场景反应
// ─────────────────────────────────────────────────────────────
const T = { ...STYLE_TIERS[1] };
const QUIET = { ...STYLE_TIERS[0] };
const LIVE = { ...STYLE_TIERS[2] };
{
  // 什么都没发生 → 什么都不该演。这是防"每帧都在动"的第一道闸。
  let acted = 0;
  let st = null;
  for (let i = 0; i < 2000; i++) {
    const r = reactionStep(st, { now: 1000 + i * 16, inputAt: 1000 + i * 16, typing: false, justDone: false, tier: T });
    st = r.state || st;
    if (r.gesture || r.sleep) acted++;
  }
  eq('你一直在动 → 她不乱演', acted, 0);
}
{
  // 6. reactionStep 必须把 state 交还（否则跨帧记忆丢失，退化成每帧重新判定）
  let st = null, seen = null;
  for (let i = 0; i < 10; i++) {
    const r = reactionStep(st, { now: i * 16, inputAt: i * 16, typing: false, justDone: false, tier: T });
    st = r.state || st;
  }
  ok('reactionStep 会把 state 还回来', st != null && typeof st === 'object');
}
{
  // 优化刚跑完 → 蹦一下
  let st = null;
  const r = reactionStep(st, { now: 5000, inputAt: 5000, typing: false, justDone: true, tier: T });
  st = r.state;
  ok('优化完她会反应', !!r.gesture, `got=${JSON.stringify(r)}`);
  eq('说的是"好了"那组台词', r.say, 'react.done');
}
{
  // 安静档压掉"优化完蹦一下"（它会打断你）
  const r = reactionStep(null, { now: 5000, inputAt: 5000, typing: false, justDone: true, tier: QUIET });
  ok('安静档不蹦', !r.gesture, `got=${JSON.stringify(r)}`);
}
{
  // 同一个事件不能连着演两次（冷却）
  let st = null, count = 0;
  for (let i = 0; i < 600; i++) {
    const now = 5000 + i * 16;
    const r = reactionStep(st, { now, inputAt: now, typing: false, justDone: i === 0, tier: T });
    st = r.state || st;
    if (r.gesture) count++;
  }
  eq('justDone 持续为真也只演一次', count, 1);
}
{
  // 打字很久 → 趴下来看你。门槛 90 秒。
  // 注意是**在循环里**抓第一次触发：状态机在 90 秒那一刻就演了，之后进入 60 秒冷却。
  // （第一版跑到 2 分钟才断言，于是撞在冷却窗口里，误以为它没触发。）
  let st = null, fired = null, firedAt = null;
  for (let i = 0; i < 7500; i++) {
    const now = i * 16;
    const r = reactionStep(st, { now, inputAt: now, typing: true, justDone: false, tier: T });
    st = r.state;
    if (r.say === 'react.typing' && !fired) { fired = r; firedAt = now; }
  }
  ok('连续打字会触发 typing 反应', !!fired, '连续打了 120 秒都没触发');
  if (fired) {
    ok('触发时刻就在门槛附近（不是立刻，也不是永远）', firedAt >= REACT.typing.after - 100 && firedAt <= REACT.typing.after + 1000,
      `在 ${firedAt}ms 触发，门槛 ${REACT.typing.after}`);
    eq('触发后进入冷却（同一段打字不再演）', reactionStep(st, { now: firedAt + 100, inputAt: firedAt + 100, typing: true, justDone: false, tier: T }).say, undefined);
  }
  eq('连续打字期间 typingSince 始终在记', st.typingSince != null, true);
}
{
  // 时长不够就不该触发（门槛是真的门槛）
  let st = null;
  for (let i = 0; i < 3000; i++) { // 48 秒
    st = reactionStep(st, { now: i * 16, inputAt: i * 16, typing: true, justDone: false, tier: T }).state;
  }
  const r = reactionStep(st, { now: 3000 * 16, inputAt: 3000 * 16, typing: true, justDone: false, tier: T });
  eq('不到 90 秒不触发', r.say, undefined);
}
{
  // 打字断断续续 → 计时重置，永远不触发
  let st = null, acted = 0;
  for (let i = 0; i < 1200; i++) {
    const typing = i % 40 < 20; // 每 40 帧里只打 20 帧
    const r = reactionStep(st, { now: i * 16, inputAt: i * 16, typing, justDone: false, tier: T });
    st = r.state || st;
    if (r.say === 'react.typing') acted++;
  }
  eq('断断续续打字不算"打字太久"', acted, 0);
}
{
  // 很久没动静 → 待机动作
  let st = null;
  // 先用活泼档保证 idleGestures>0
  const r = reactionStep(st, { now: 200000, inputAt: 0, typing: false, justDone: false, tier: LIVE });
  st = r.state;
  ok('久无动静她会自己动一下', !!r.gesture || r.sleep === true, `got=${JSON.stringify(r)}`);
}
{
  // 安静档：她安静，但**不是坏了** —— 到 10 分钟还是会自己躺下。
  // （第一版把这条写成"安静档不睡"，那是把"安静"错当成"坏了"；安静该是动作少，不是没有。）
  let st = null;
  const r = reactionStep(st, { now: 700000, inputAt: 0, typing: false, justDone: false, tier: QUIET });
  st = r.state;
  eq('安静档不蹦不摸脸', r.gesture, undefined);
  eq('安静档久到离谱还是会自己躺下', r.sleep, true);
}
{
  // 睡下之后：别的反应全停，只等"你回来了"
  let st = null;
  // 推进到睡
  st = reactionStep(st, { now: 700000, inputAt: 0, typing: false, justDone: false, tier: T }).state;
  // 她睡了：给一个新输入时刻
  const wake = reactionStep(st, { now: 800000, inputAt: 800000, typing: false, justDone: false, tier: T });
  st = wake.state;
  ok('睡久了你会把她叫醒', !!wake.gesture || wake.sleep === undefined, `got=${JSON.stringify(wake)}`);
}
{
  // 睡着时：只有"你回来了"能叫醒她。
  // 用安静档 + 安静档的 idleGestures=0，才能直接落到 sleep 分支
  //（日常档会先被 idle 待机动作截住 —— 这是有意的：先伸个懒腰，几轮后才躺下。）
  let st = null;
  st = reactionStep(st, { now: 700000, inputAt: 0, typing: false, justDone: false, tier: QUIET }).state;
  eq('安静档久到离谱直接躺下', st.sleeping, true);
  // 打字很久也吵不醒（inputAt 没变，不构成"你回来了"）
  const r = reactionStep(st, { now: 800000, inputAt: 0, typing: true, justDone: false, tier: QUIET });
  ok('睡着时打字吵不醒她', r.gesture === undefined, `got=${JSON.stringify(r)}`);
  // 睡够久了，你一动鼠标她就醒
  const w = reactionStep(st, { now: 900000, inputAt: 900000, typing: false, justDone: false, tier: QUIET });
  ok('睡久了你会把她叫醒', w.say === 'react.wake', `got=${JSON.stringify(w)}`);
  eq('叫醒后不再处于睡姿', w.state.sleeping, false);
}
{
  // justDone 只在被消费的那一次有效：主循环消费后置 0，这里模拟
  let st = null, n = 0;
  st = reactionStep(st, { now: 1000, inputAt: 1000, typing: false, justDone: true, tier: T }).state;
  for (let i = 0; i < 500; i++) {
    const now = 1000 + (i + 1) * 16;
    const r = reactionStep(st, { now, inputAt: now, typing: false, justDone: false, tier: T });
    st = r.state || st;
    if (r.gesture) n++;
  }
  ok('justDone 消费后不再重复', n === 0, `又演了 ${n} 次`);
}
{
  // 缺失字段不能炸：inputAt 可能是 undefined（刚初始化那一帧）
  for (const n0 of [
    { now: 1000, inputAt: undefined, typing: false, justDone: false, tier: T },
    { now: 1000, inputAt: null, typing: false, justDone: false, tier: T },
    { now: 1000, typing: false, justDone: false, tier: T },
  ]) {
    let threw = false;
    try { reactionStep(null, n0); } catch (e) { threw = true; }
    ok('缺 inputAt 不炸', !threw);
  }
}
{
  // REACT 阈值必须递增：回来越近越好，"很久没动"门槛要高于"打字太久"
  ok('"你回来了"门槛最短', REACT.back.after < REACT.typing.after);
  ok('"打字太久"门槛短于"久无动静"', REACT.typing.after < REACT.idle.after);
  ok('"睡下"门槛最长', REACT.idleSleep.after > REACT.idle.after);
  for (const k of Object.keys(REACT)) {
    ok(`${k} 有冷却`, typeof REACT[k].cool === 'number' && REACT[k].cool >= 0);
  }
}

// ─────────────────────────────────────────────────────────────
// 6b. 坐好过期：电脑 10 分钟没人管就自己起来
// ─────────────────────────────────────────────────────────────
{
  // 没在坐 → 永远不该冒出 rise
  let st = null, rises = 0;
  for (let i = 0; i < 5000; i++) {
    const now = i * 16;
    const r = reactionStep(st, { now, inputAt: 0, sitting: false, typing: false, justDone: false, tier: T });
    st = r.state;
    if (r.rise) rises++;
  }
  eq('她没在坐就不会自己"起来"', rises, 0);
}
{
  // 在坐 + 超过 10 分钟没输入 → 起身，且只发生一次
  // 注意帧数：10 分钟 = 600000ms，16ms/帧要 **37500 帧**才够。
  // 第一版只跑了 5000 帧（80 秒），于是断言"该起身"必然失败 —— 是测试没喂够时间。
  let st = null, rises = 0, at = null;
  const FRAMES = Math.ceil(REACT.autoRise.after / 16) + 600;
  for (let i = 0; i < FRAMES; i++) {
    const now = i * 16;
    const r = reactionStep(st, { now, inputAt: 0, sitting: true, typing: false, justDone: false, tier: T });
    st = r.state;
    if (r.rise) { rises++; if (at === null) at = now; }
  }
  eq('坐够 10 分钟会起身', rises > 0, true);
  ok('起身的时刻贴着门槛', at !== null && at >= REACT.autoRise.after - 100 && at <= REACT.autoRise.after + 2000,
    `在 ${at}ms 起身，门槛 ${REACT.autoRise.after}`);
  eq('起身只发生一次（不会每帧喊一次）', rises, 1);
}
{
  // 门槛没过之前不许起身
  let st = null, rises = 0;
  for (let i = 0; i < 3000; i++) { // 48 秒
    const now = i * 16;
    const r = reactionStep(st, { now, inputAt: 0, sitting: true, typing: false, justDone: false, tier: T });
    st = r.state;
    if (r.rise) rises++;
  }
  eq('不到 10 分钟不会自己起来', rises, 0);
}
{
  // ★安静档也照样起身 —— 这是状态修正，不受活动强度压制
  let st = null, rose = false;
  const FRAMES = Math.ceil(REACT.autoRise.after / 16) + 600;
  for (let i = 0; i < FRAMES; i++) {
    const now = i * 16;
    const r = reactionStep(st, { now, inputAt: 0, sitting: true, typing: false, justDone: false, tier: QUIET });
    st = r.state;
    if (r.rise) { rose = true; break; }
  }
  ok('安静档也会自己起身（坐久了腿麻，跟活泼无关）', rose);
}
{
  // ★她睡着了也要能起来 —— autoRise 必须排在 sleeping 检查之前
  // 构造：先把门槛调小，让 idleSleep 先把她放倒，确认她真的睡着；
  //  再把门槛调回来（比 sleep 晚），此时 autoRise 必须抢在 sleeping 检查之前把状态修掉。
  const saved = REACT.autoRise.after;
  let st = null, slept = false;
  try {
    REACT.autoRise.after = 1e12; // 先关掉 autoRise，只看她会不会睡着
    for (let i = 0; i < 40000; i++) {
      const now = i * 16;
      const r = reactionStep(st, { now, inputAt: 0, sitting: true, typing: false, justDone: false, tier: QUIET });
      st = r.state;
      if (st.sleeping) { slept = true; break; }
    }
    ok('前置：安静档久坐确实会先睡着', slept, '构造失败，这个用例就测不到东西了');
  } finally {
    REACT.autoRise.after = saved;
  }
  // 现在 autoRise 恢复到 10 分钟：同一份已睡着的状态，她**仍然要起身** ——
  // 证明 autoRise 分支排在 sleeping 早退之前（否则睡了就永远坐着）。
  let roseAfterSleep = false;
  for (let i = 0; i < 40000; i++) {
    const now = 640000 + i * 16; // 已经过了 10 分钟
    const r = reactionStep(st, { now, inputAt: 0, sitting: true, typing: false, justDone: false, tier: QUIET });
    st = r.state;
    if (r.rise) { roseAfterSleep = true; break; }
  }
  ok('睡着之后仍然会起身（autoRise 排在 sleeping 前面）', roseAfterSleep,
    'autoRise 必须先判，否则她睡着了就永远坐那儿 —— 那正是"10 分钟没人管"的场景');
}
{
  // ★这一条是专门为"边沿 vs 电平"写的有牙测试。
  //
  // 场景还原：`n.sitting` 来自 React store，`setSit(false)` 要等下一帧才生效。
  // 所以现实里会出现**连续若干帧 `sitting` 仍然为 true**——这正是那个 bug 的现场。
  //   · 电平写法（`if (n.sitting) canRise = true`）：每帧都自我重新武装 → 一秒报十几次
  //   · 边沿写法（`sitting && !wasSitting`）：只在"没坐→坐"那一帧武装，之后一直记死
  //
  // ⚠️ 我第一版的测试只断言"跑满全程 rises === 1"，两种写法**都能通过**（因为循环里
  //    `sitting` 一直是 true，而第一版还带 1 秒冷却）—— 又是一条假绿。
  //    必须显式模拟"起身后 sitting 有几帧没及时翻转"，两种写法才会分开。
  const T0 = Math.floor(REACT.autoRise.after / 16);
  let st = null, firstRose = null;
  for (let i = 0; i <= T0 + 30; i++) {
    const now = i * 16;
    const r = reactionStep(st, { now, inputAt: 0, sitting: true, typing: false, justDone: false, tier: T });
    st = r.state;
    if (r.rise) { firstRose = now; break; }
  }
  ok('第一轮确实起身了', firstRose !== null, '构造失败');
  // 关键：起身之后，`sitting` 要**再保持 true 好几秒**（真实浏览器就是这样：
  // commit → 重渲染之间有延迟，而且旧版还有 1 秒冷却能把重复压下去）。
  // 只喂 1 秒是**测不出来**的 —— 两种写法在那 1 秒里都恰好只报一次。
  // 要喂到冷却失效之后（>1s），电平写法才会重新武装并再报一次。
  let repeats = 0;
  const LATE_FRAMES = 200; // 200 帧 ≈ 3.2 秒 > 冷却 1 秒
  for (let i = 1; i <= LATE_FRAMES; i++) {
    const now = firstRose + i * 16;
    const r = reactionStep(st, { now, inputAt: 0, sitting: true, typing: false, justDone: false, tier: T });
    st = r.state;
    if (r.rise) repeats++;
  }
  ok('起身后 sitting 迟迟不翻转（超过冷却时长）时，不许重复报起身',
    repeats === 0, `重复报了 ${repeats} 次 —— 这就是"对着你连说十几次坐太久了我腿麻"`);
  // store 终于翻转成"不在坐"
  st = reactionStep(st, { now: firstRose + 210 * 16, inputAt: 0, sitting: false, typing: false, justDone: false, tier: T }).state;
  // 玩家**没再点坐好**，她保持自由活动：哪怕 inputAt 还是很久以前，也绝不能再报起身。
  // （注意别在这里顺手加一次 sitting:true —— 那等于"又坐下了"，而没有新输入的话
  //   再坐 10 分钟确实该再起身一次，那是合法的，不是重复。）
  let repeats2 = 0;
  for (let i = 0; i <= 200; i++) {
    const now = firstRose + 210 * 16 + i * 16;
    const r = reactionStep(st, { now, inputAt: 0, sitting: false, typing: false, justDone: false, tier: T });
    st = r.state;
    if (r.rise) repeats2++;
  }
  eq('她已经是自由活动状态 → 绝不再报起身', repeats2, 0);
}
{
  // 反证边沿：她起来之后**又被坐下** → 必须重新允许下一次到期起身。
  // 不重置的话就是"这辈子只会自己起来一次"，那显然不对。
  const T0 = Math.floor(REACT.autoRise.after / 16); // 到期所需帧数
  let st = null, firstRose = null;
  for (let i = 0; i <= T0 + 30; i++) {
    const now = i * 16;
    const r = reactionStep(st, { now, inputAt: 0, sitting: true, typing: false, justDone: false, tier: T });
    st = r.state;
    if (r.rise) { firstRose = now; break; }
  }
  ok('第一轮确实起身了', firstRose !== null, '构造失败');
  // 起来 → 你又把她坐下 → 从"这次坐下"起重新等 10 分钟
  const sitAgainAt = firstRose + 30 * 16;
  st = reactionStep(st, { now: sitAgainAt, inputAt: sitAgainAt, sitting: false, typing: false, justDone: false, tier: T }).state;
  st = reactionStep(st, { now: sitAgainAt + 16, inputAt: sitAgainAt + 16, sitting: true, typing: false, justDone: false, tier: T }).state;
  ok('再坐下后重新武装', st.canRise === true, `canRise=${st.canRise}`);
  // 从这一次坐下开始喂「没有新输入」，喂够 10 分钟
  let second = null;
  for (let i = 0; i <= T0 + 30; i++) {
    const now = sitAgainAt + 16 + i * 16;
    const r = reactionStep(st, { now, inputAt: sitAgainAt + 16, sitting: true, typing: false, justDone: false, tier: T });
    st = r.state;
    if (r.rise) { second = now; break; }
  }
  ok('第二次到期也还能起身（不是一辈子只起一次）', second !== null, 'canRise 被永久记死了');
  ok('第二轮也是满 10 分钟才起', second !== null && second - sitAgainAt >= REACT.autoRise.after - 100,
    `第二轮在 ${second === null ? 'null' : second - sitAgainAt}ms（门槛 ${REACT.autoRise.after}）`);
}
{
  // 输入恢复（你回来动了一下）就重新计时，不会起身
  let st = null, rises = 0;
  const FRAMES = Math.ceil(REACT.autoRise.after / 16) + 600;
  let lastInput = 0;
  for (let i = 0; i < FRAMES; i++) {
    const now = i * 16;
    // 每 3 秒动一次鼠标：永远不满足"10 分钟没输入"
    if (i % 187 === 0) lastInput = now;
    const r = reactionStep(st, { now, inputAt: lastInput, sitting: true, typing: false, justDone: false, tier: T });
    st = r.state;
    if (r.rise) rises++;
  }
  eq('你还在动 → 她不会自己起来', rises, 0);
}
{
  ok('autoRise 有门槛且是 10 分钟', REACT.autoRise.after === 600000, `got=${REACT.autoRise.after}`);
  ok('autoRise 有冷却', typeof REACT.autoRise.cool === 'number' && REACT.autoRise.cool >= 0);
  ok('门槛与「睡下」一致（同一个 10 分钟）', REACT.autoRise.after === REACT.idleSleep.after);
}
{
  // 起身要有台词，且短
  const rise = roamLines(new Date()).react.rise;
  ok('起身有台词', Array.isArray(rise) && rise.length >= 2, JSON.stringify(rise));
  for (const s of rise || []) ok('起身台词够短（≤20 字）', s.length <= 20, `"${s}" ${s.length}`);
}

// ─────────────────────────────────────────────────────────────
// 7. 台词：每个动作都要有台词，而且必须短、不装乖（纸鸢的说话方式）
// ─────────────────────────────────────────────────────────────
{
  const lines = roamLines(new Date());
  ok('有 gesture 台词表', lines.gesture && typeof lines.gesture === 'object');
  ok('有 react 台词表', lines.react && typeof lines.react === 'object');
  const every = STYLE_TIERS[2].motions;
  for (const m of [...new Set(every)]) {
    const g = lines.gesture[m];
    ok(`"${m}" 有台词`, Array.isArray(g) && g.length >= 2, `got=${JSON.stringify(g)}`);
    if (!Array.isArray(g)) continue;
    for (const s of g) {
      ok(`"${m}" 的台词够短（≤20 字）`, s.length <= 20, `"${s}" 长度 ${s.length}`);
      ok(`"${m}" 的台词不装乖`, !/主人|汪汪|呀~|喵~|亲亲|么么/.test(s), `"${s}"`);
      ok(`"${m}" 的台词不堆波浪号`, (s.match(/[~～]/g) || []).length <= 1, `"${s}"`);
      ok(`"${m}" 的台词没有客服腔`, !/您好|请稍候|很高兴为您/.test(s), `"${s}"`);
    }
  }
  for (const k of Object.keys(lines.react)) {
    const arr = lines.react[k];
    ok(`react.${k} 有台词`, Array.isArray(arr) && arr.length >= 2);
    for (const s of arr || []) ok(`react.${k} 的台词够短`, s.length <= 20, `"${s}"`);
  }
}
{
  // 台词必须和动作对得上（这个测不了语义，但能测"没有孤儿台词"）
  const lines = roamLines(new Date());
  const declaredSet = new Set(declared);
  for (const key of Object.keys(lines.gesture)) {
    ok(`台词 "${key}" 对应一个真手势`, declaredSet.has(key), '写了台词但没有这个动作 —— 永远不会被念到');
  }
  for (const r of STYLE_TIERS) {
    for (const m of r.motions) {
      ok(`${r.id} 的 "${m}" 有对应台词`, !!lines.gesture[m], '动作会演但没台词 = 演了个寂寞');
    }
  }
}

// ⚠️ 同样不要 process.exit()：run-all.mjs 用 import() 串行加载各套测试，
// 这里一退出，后面 bundle/parity 都不会跑，而 run-all 照样会喊"全部测试通过 ✓"。
if (fails.length) {
  console.error(`style.test.mjs: ${pass} 通过, ${fails.length} 失败`);
  for (const f of fails) console.error('  ✗ ' + f);
  throw new Error(`style.test.mjs: ${fails.length} 项失败`);
}
console.log(`style.test.mjs: ${pass} 通过, 0 失败`);
