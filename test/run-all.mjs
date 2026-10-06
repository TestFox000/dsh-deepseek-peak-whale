/**
 * 一次跑完全部测试：node test/run-all.mjs
 *
 * 末尾显式 `process.exit(0)`：用 Electron 的 as-node 模式跑时，脚本跑完进程不退出，
 * 会让调用方的 pwsh 一直挂着（表现为「测试全过但命令不返回」）。
 */
await import('./peak.test.mjs');
await import('./wallet.test.mjs');
await import('./optimize.test.mjs');
await import('./bundle.test.mjs');
await import('./parity.test.mjs');

console.log('\n全部测试通过 ✓');
process.exit(0);
