/**
 * 同源性测试：证明「注入进浏览器 bundle 的那份核心逻辑」与
 * 「Host 半身 import 的 src/peak.js」判定完全一致。
 *
 * 这是 build.mjs 的价值所在——如果哪天真去手抄了第二份实现，这里会立刻红。
 */
import assert from 'node:assert/strict';
import * as core from '../src/peak.js';
import { loadClientBundle } from './helpers.mjs';

const { exports: client } = loadClientBundle();

assert.equal(typeof client.periodAt, 'function', 'client 应导出 periodAt 供比对');
assert.equal(typeof client.summary, 'function', 'client 应导出 summary 供比对');

const MINUTE = 60000;
let checkedPeriod = 0;
let checkedSummary = 0;
let checkedHoliday = 0;

// ── 1. 密集比对 periodAt：覆盖国庆假期前后 10 天，每 7 分钟一点 ────────────────
{
  const from = Date.parse('2026-09-29T00:00:00Z');
  const to = Date.parse('2026-10-09T00:00:00Z');
  for (let t = from; t <= to; t += 7 * MINUTE) {
    const date = new Date(t);
    const a = core.periodAt(date);
    const b = client.periodAt(date);
    assert.equal(b.period, a.period, `periodAt(${date.toISOString()}).period 不一致`);
    assert.equal(b.reason, a.reason, `periodAt(${date.toISOString()}).reason 不一致`);
    assert.equal(b.isPeak, a.isPeak, `periodAt(${date.toISOString()}).isPeak 不一致`);
    assert.equal(b.isWeekend, a.isWeekend, `periodAt(${date.toISOString()}).isWeekend 不一致`);
    assert.equal(b.isHoliday, a.isHoliday, `periodAt(${date.toISOString()}).isHoliday 不一致`);
    assert.equal(b.holiday?.name ?? null, a.holiday?.name ?? null);
    checkedPeriod += 1;
  }
}

// ── 2. summary 比对：整年每 6 小时一点（含边界求解、进度、剩余时间）────────────
{
  const from = Date.parse('2026-01-01T00:00:00Z');
  const to = Date.parse('2026-12-31T23:59:59Z');
  for (let t = from; t <= to; t += 6 * 3600 * 1000) {
    const date = new Date(t);
    const a = core.summary(date);
    const b = client.summary(date);
    assert.equal(b.period, a.period, `summary(${date.toISOString()}).period 不一致`);
    assert.equal(b.isHalfPrice, a.isHalfPrice);
    assert.equal(b.nextIsPeak, a.nextIsPeak, `summary(${date.toISOString()}).nextIsPeak 不一致`);
    assert.equal(
      b.next === null ? null : b.next.toISOString(),
      a.next === null ? null : a.next.toISOString(),
      `summary(${date.toISOString()}).next 不一致`,
    );
    assert.equal(
      b.prev === null ? null : b.prev.toISOString(),
      a.prev === null ? null : a.prev.toISOString(),
      `summary(${date.toISOString()}).prev 不一致`,
    );
    assert.ok(
      Math.abs((b.minutesLeft ?? 0) - (a.minutesLeft ?? 0)) < 1e-9,
      `summary(${date.toISOString()}).minutesLeft 不一致`,
    );
    assert.ok(
      Math.abs((b.progress ?? 0) - (a.progress ?? 0)) < 1e-12,
      `summary(${date.toISOString()}).progress 不一致`,
    );
    checkedSummary += 1;
  }
}

// ── 3. 节假日表比对：整年每天北京时间中午一点 ────────────────────────────────
{
  const from = Date.parse('2025-12-30T00:00:00Z');
  const to = Date.parse('2027-01-02T00:00:00Z');
  for (let t = from; t <= to; t += 24 * 3600 * 1000) {
    const date = new Date(t);
    assert.equal(
      client.holidayAt(date)?.name ?? null,
      core.holidayAt(date)?.name ?? null,
      `holidayAt(${date.toISOString()}) 不一致`,
    );
    checkedHoliday += 1;
  }
}

// ── 4. 常量比对 ──────────────────────────────────────────────────────────────
assert.deepEqual(
  JSON.parse(JSON.stringify(client.MODELS)),
  JSON.parse(JSON.stringify(core.MODELS)),
  '两端模型价格表必须一致',
);
assert.deepEqual(
  JSON.parse(JSON.stringify(client.HOLIDAYS)),
  JSON.parse(JSON.stringify(core.HOLIDAYS)),
  '两端节假日表必须一致',
);

console.log('parity.test.mjs: 浏览器内联核心 与 src/peak.js 完全一致');
console.log(`  periodAt 比对 ${checkedPeriod} 点 / summary 比对 ${checkedSummary} 点 / 节假日比对 ${checkedHoliday} 点`);
