/**
 * 定价逻辑测试：官方规则的不变量 + 若干可手工核对的已知时刻。
 *
 * 已知时刻都挑在 2026 年国庆假期附近，因为那一段同时覆盖了
 * 「法定节假日」「周末」「调休上班的周六」「假期后第一个工作日」四种情况。
 */
import assert from 'node:assert/strict';
import {
  HOLIDAYS,
  MODELS,
  boundaryLabel,
  describePeriod,
  holidayAt,
  isWeekend,
  multiplierAt,
  nextBoundary,
  periodAt,
  previousBoundary,
  summary,
} from '../src/peak.js';

const at = (iso) => new Date(iso);

// ── 1. 价格不变量：谷时价必须恰好是峰时价的一半 ────────────────────────────────
for (const model of MODELS) {
  for (const kind of ['cacheHit', 'cacheMiss', 'output']) {
    const bucket = model[kind];
    assert.equal(
      bucket.off * 2,
      bucket.peak,
      `${model.name}.${kind}: 谷时价 ${bucket.off} 应为峰时价 ${bucket.peak} 的一半`,
    );
  }
}

// ── 2. 峰时窗口边界（2026-10-08 周四，假期已结束）────────────────────────────
const peakCases = [
  ['2026-10-08T00:30:00Z', 'offpeak'],
  ['2026-10-08T01:00:00Z', 'peak'],
  ['2026-10-08T03:59:00Z', 'peak'],
  ['2026-10-08T04:00:00Z', 'offpeak'],
  ['2026-10-08T05:30:00Z', 'offpeak'],
  ['2026-10-08T06:00:00Z', 'peak'],
  ['2026-10-08T09:59:00Z', 'peak'],
  ['2026-10-08T10:00:00Z', 'offpeak'],
  ['2026-10-08T23:00:00Z', 'offpeak'],
];
for (const [iso, expected] of peakCases) {
  assert.equal(periodAt(at(iso)).period, expected, `${iso} 应为 ${expected}`);
}
assert.equal(periodAt(at('2026-10-08T02:00:00Z')).reason, 'peak-window');

// ── 3. 周末与法定节假日整天算谷时 ─────────────────────────────────────────────
// 国庆假期 10/1–10/7；10/3 是周六，10/5 是周一（工作日却是假期）
assert.equal(periodAt(at('2026-10-03T02:00:00Z')).period, 'offpeak', '国庆假期周六应为谷时');
assert.equal(periodAt(at('2026-10-03T02:00:00Z')).reason, 'holiday');
assert.equal(periodAt(at('2026-10-05T02:00:00Z')).period, 'offpeak', '假期中的周一应为谷时');
assert.equal(periodAt(at('2026-10-05T02:00:00Z')).reason, 'holiday');
assert.equal(holidayAt(at('2026-10-05T02:00:00Z')).name, '国庆节');

// 调休上班的周六（10/10）——官方明确「周末整天都算谷时」，所以仍是谷时
assert.equal(isWeekend(at('2026-10-10T02:00:00Z')), true);
assert.equal(
  periodAt(at('2026-10-10T02:00:00Z')).period,
  'offpeak',
  '调休上班的周六仍按周末处理 → 谷时',
);
assert.equal(periodAt(at('2026-10-10T02:00:00Z')).reason, 'weekend');

// 假期结束后的第一个工作日 10/08（周四）恢复峰时
assert.equal(periodAt(at('2026-10-08T02:00:00Z')).period, 'peak');

// ── 4. 其它节假日边界 ────────────────────────────────────────────────────────
assert.equal(holidayAt(at('2026-02-15T04:00:00Z')).name, '春节', '春节首日');
assert.equal(holidayAt(at('2026-02-14T04:00:00Z')), null, '2/14 不是假期（周六上班日）');
assert.equal(holidayAt(at('2026-02-23T04:00:00Z')).name, '春节', '春节末日 2/23');
assert.equal(holidayAt(at('2026-02-24T04:00:00Z')), null, '2/24 假期已结束');
assert.equal(holidayAt(at('2026-01-04T04:00:00Z')), null, '1/4 不是假期');
assert.equal(holidayAt(at('2026-05-09T04:00:00Z')), null, '5/9 只是调休上班，不是假期');
assert.equal(HOLIDAYS.length, 7, '2026 年应有 7 个法定节假日段');

// ── 5. 倍率 ──────────────────────────────────────────────────────────────────
assert.equal(multiplierAt(at('2026-10-08T02:00:00Z')), 1, '峰时倍率 1');
assert.equal(multiplierAt(at('2026-10-03T02:00:00Z')), 0.5, '谷时倍率 0.5');

// ── 6. 时段边界求解 ──────────────────────────────────────────────────────────
// 当日：00:30 → 下一个边界是 01:00
{
  const now = at('2026-10-08T00:30:00Z');
  assert.equal(nextBoundary(now).toISOString(), '2026-10-08T01:00:00.000Z');
  const s = summary(now);
  assert.equal(s.minutesLeft, 30);
  assert.equal(s.nextIsPeak, true);
  assert.equal(s.isHalfPrice, true);
}
// 当日：04:00 → 下一个边界是 06:00
{
  const now = at('2026-10-08T04:00:00Z');
  assert.equal(nextBoundary(now).toISOString(), '2026-10-08T06:00:00.000Z');
  assert.equal(summary(now).minutesLeft, 120);
}
// 周四 10:00（峰时收尾）→ 下一个边界是周五 01:00，跨 15 小时
{
  const now = at('2026-10-08T10:00:00Z');
  assert.equal(nextBoundary(now).toISOString(), '2026-10-09T01:00:00.000Z');
  assert.equal(summary(now).minutesLeft, 900);
}
// 假期中的周一 → 一路谷时到 10/08 周四 01:00
{
  const now = at('2026-10-05T05:00:00Z');
  assert.equal(nextBoundary(now).toISOString(), '2026-10-08T01:00:00.000Z');
  assert.equal(summary(now).minutesLeft, 68 * 60);
}
// 假期中的周六 10/03 12:00 → 上一段谷时起点是节前 09/30 10:00（周三峰时收尾）
{
  const now = at('2026-10-03T12:00:00Z');
  assert.equal(nextBoundary(now).toISOString(), '2026-10-08T01:00:00.000Z');
  assert.equal(previousBoundary(now).toISOString(), '2026-09-30T10:00:00.000Z');
  const s = summary(now);
  const expectedSpan = 183 * 60; // 09/30 10:00 → 10/08 01:00 = 183 小时
  assert.ok(Math.abs(s.progress - 74 / 183) < 1e-9, `进度应约为 0.4044，实得 ${s.progress}`);
  assert.ok(Math.abs(s.minutesLeft - (expectedSpan - 74 * 60)) < 1e-9);
}

// ── 7. 文案 ──────────────────────────────────────────────────────────────────
assert.equal(describePeriod(periodAt(at('2026-10-03T02:00:00Z'))).title, '谷时 · 半价');
assert.equal(describePeriod(periodAt(at('2026-10-03T02:00:00Z'))).note, '国庆节假期全天半价');
assert.equal(describePeriod(periodAt(at('2026-10-08T02:00:00Z'))).title, '峰时 · 全价');
assert.equal(
  boundaryLabel(at('2026-10-03T12:00:00Z'), nextBoundary(at('2026-10-03T12:00:00Z'))),
  '周四 09:00',
  '跨天边界应补星期',
);
assert.equal(
  boundaryLabel(at('2026-10-08T00:30:00Z'), nextBoundary(at('2026-10-08T00:30:00Z'))),
  '09:00',
  '当天边界不补星期',
);

// ── 8. 边界处不抖动：切换那一分钟必须已经属于新时段 ───────────────────────────
for (let minute = 0; minute < 24 * 60; minute += 1) {
  const iso = `2026-10-08T${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}:00Z`;
  const now = at(iso);
  const next = nextBoundary(now);
  assert.ok(next, `${iso} 应能求出下一个边界`);
  assert.notEqual(
    periodAt(next).period,
    periodAt(now).period,
    `${iso}: 下一边界 ${next.toISOString()} 必须真的切换时段`,
  );
  assert.ok(next.getTime() > now.getTime(), `${iso}: 下一边界必须晚于当前时刻`);
}

console.log('peak.test.mjs: 定价逻辑不变量与已知时刻全部通过');
