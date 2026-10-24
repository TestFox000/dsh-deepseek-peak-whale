/**
 * 一次跑完全部测试：node test/run-all.mjs
 *
 * 末尾显式 `process.exit(0)`：用 Electron 的 as-node 模式跑时，脚本跑完进程不退出，
 * 会让调用方的 pwsh 一直挂着（表现为「测试全过但命令不返回」）。
 *
 * ⚠️ 这里逐套 import 而不是 import 一个汇总文件，是有原因的：
 *   任何一套测试自己调 process.exit() 都会让后面的套**静默失跑**，
 *   而本文件照样会在最后喊"全部测试通过 ✓"—— 假绿就是这么来的。
 *   所以两处都得守住：各套测试不许 exit（失败就 throw），本文件必须确认每套都真的跑到了。
 */
const SUITES = [
  './peak.test.mjs',
  './wallet.test.mjs',
  './optimize.test.mjs',
  './webchat.test.mjs',
  './sessionllm.test.mjs',
  './style_prompt.test.mjs',
  './gesture.test.mjs',
  './style.test.mjs',
  './bundle.test.mjs',
  './parity.test.mjs',
];

const ran = [];
for (const suite of SUITES) {
  await import(suite);
  ran.push(suite);
}

// 每套都必须真的跑到了：少一个就是被上一套的 process.exit 截断了
if (ran.length !== SUITES.length) {
  console.error(`\n✗ 只跑了 ${ran.length}/${SUITES.length} 套测试，后面的被静默截断了`);
  process.exit(1);
}

console.log(`\n全部测试通过 ✓（${ran.length} 套）`);
process.exit(0);
