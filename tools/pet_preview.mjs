/**
 * 生成 assets/pet-preview.html —— 验证 vendored 运行时的端到端可用性。
 *
 * 验证链：PET_MODEL/PET_TEX data URI 加载 → WebGL2 渲染 → 物理落地 → 说话口型
 *          → 转圈 → 拎起拖拽 → 抛出落地 → 坐下 → 站立 + 气泡价格台词。
 *
 * 无头截图模式下 rAF 和定时器都不可靠（前面吃过亏），所以全部**加载期同步推进**，
 * 最后留一帧静态画面给截图。
 *
 * 用法：node tools/pet_preview.mjs   （然后无头 Edge 截图该文件）
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const html = `<!doctype html>
<meta charset="utf-8">
<title>pet-runtime preview</title>
<style>
body{margin:0;background:#1b1e26;font:12px/1.5 monospace;color:#cfd6e4}
#stage{position:relative;height:460px;overflow:hidden}
#stage svg{position:absolute;inset:0;width:100%;height:100%}
#diag{position:absolute;left:10px;top:10px;z-index:9;background:#0f1116ee;padding:8px 10px;border:1px solid #333a4d;white-space:pre-wrap;max-width:640px}
#bubble{position:absolute;z-index:8;background:#fff;border:1px solid #ccd;border-radius:11px;padding:4px 10px;color:#223;transform:translate(-50%,-100%);white-space:pre-wrap;font:12px system-ui}
</style>
<div id="stage">
<svg><ellipse id="shadow" fill="#000" opacity=".2"/><g id="pet"></g><g id="fx"></g></svg>
<div id="diag">boot…</div><div id="bubble" hidden></div>
</div>
<script src="../vendor/pet-runtime.js"></script>
<script>
(function () {
  var lines = [], errs = [];
  var diag = document.getElementById('diag');
  function push(s) { lines.push(s); diag.textContent = lines.join('\\n'); }
  window.onerror = function (m, u, l) { errs.push('onerror:' + m + '@' + l); };
  try {
    if (typeof PET === 'undefined') throw new Error('PET 未定义');
    var stage = document.getElementById('stage');
    var svg = stage.querySelector('svg');
    var bubble = document.getElementById('bubble');
    var sfx = PET.createSfx({ storageKey: 'preview.sound.v1' });
    var done = PET.createWhaleFigure('pet:///', { model: PET_MODEL, asset: function (p) { return PET_TEX[p]; } });
    done.then(function (figure) {
      try {
        var bounds = function () {
          var r = stage.getBoundingClientRect();
          return { W: r.width, H: r.height, floorY: r.height - 22, S: .42 * Math.min(1.4, r.height / 420) };
        };
        var ctl = PET.createPet(
          { petG: document.getElementById('pet'), shadowEl: document.getElementById('shadow'), fxG: document.getElementById('fx') },
          { sfx: sfx, figure: figure, roam: 'free', enter: 'drop', bounds: bounds, startX: 700 });
        function rect() {
          var b = svg.querySelector('#pet').getBoundingClientRect(), s = stage.getBoundingClientRect();
          return 'petRect(x=' + Math.round(b.x - s.x) + ', y=' + Math.round(b.y - s.y) + ', w=' + Math.round(b.width) + ', h=' + Math.round(b.height) + ')';
        }
        function step(n, fn) { for (var i = 0; i < n; i++) { ctl.step(1 / 60); if (fn) fn(i); ctl.render(); } }
        push('figure ok; PET_TEX keys=' + Object.keys(PET_TEX).length + '; parts=' + PET_MODEL.parts.length);

        step(200);
        push('落地: mode=' + ctl.pet.mode + ' ' + rect() + ' errs=' + errs.length);

        // 价格台词逐字揭示（说话时嘴动）
        var line = '现在是谷时，半价～', shown = 0;
        step(120, function (i) {
          if (i % 5 === 0 && shown < line.length) {
            shown++; ctl.talk();
            bubble.hidden = false; bubble.textContent = line.slice(0, shown);
            var a = ctl.anchor(); bubble.style.left = a.x + 'px'; bubble.style.top = a.y + 'px';
          }
        });
        push('说话: "' + line + '" ' + rect());

        ctl.act('spin'); step(70);
        push('spin: mode=' + ctl.pet.mode + ' ' + rect());

        // 拎起来 → 拖 → 抛
        var hit = ctl.pointerDown(ctl.toStage(128, 128));
        step(30);
        push('pointerDown hit=' + hit + ' mode=' + ctl.pet.mode);
        for (var k = 0; k < 25; k++) { ctl.pointerMove(ctl.toStage(128 + k * 4, 60)); step(4); }
        push('拖动中: mode=' + ctl.pet.mode + ' ' + rect());
        ctl.pointerUp(); step(260);
        push('抛出落地: mode=' + ctl.pet.mode + ' ' + rect() + ' errs=' + errs.length);

        ctl.act('sit'); step(80);
        push('坐下: mode=' + ctl.pet.mode + ' ' + rect());

        ctl.act('stand'); step(90);
        push('起立: mode=' + ctl.pet.mode + ' ' + rect());

        // 最终帧：站立 + 气泡
        bubble.hidden = false; bubble.textContent = line;
        var a2 = ctl.anchor(); bubble.style.left = a2.x + 'px'; bubble.style.top = a2.y + 'px';
        step(40);
        push('完成: mode=' + ctl.pet.mode + ' errs=' + errs.length + (errs.length ? '\\n' + errs.slice(0, 3).join('\\n') : ''));
      } catch (e) { push('FATAL: ' + (e.stack || e.message)); }
    }, function (e) { push('REJECT: ' + (e && (e.stack || e.message) || e)); });
  } catch (e) { push('FATAL: ' + (e.stack || e.message)); }
})();
</script>
</body>
`;

const out = join(root, 'assets', 'pet-preview.html');
writeFileSync(out, html, 'utf8');
console.log('pet_preview.mjs: 已写出 ' + out);
