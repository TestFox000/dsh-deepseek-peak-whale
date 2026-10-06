/**
 * dsh-deepseek-peak-whale —— 浏览器半身【模板】
 *
 * 这是**模板**，不是最终产物：`client.js` 由 `build.mjs` 注入下面两组标记之间的内容生成
 *   1. `src/peak.js`           —— 峰谷判定核心（与 Host 半身同源）
 *   2. `vendor/pet-runtime.js` —— Coopanion 鲸鱼桌宠运行时（AGPL-3.0：
 *                                 Live2D 式 WebGL2 分件模型 + 物理/动作/表情控制器），
 *                                 连同 50 张贴图的 data URI 与侧栏图标一起注入。
 * 要改请改这两个源文件，然后跑 `node build.mjs`。
 *
 * 本半身提供两个挂载点：
 *   · `sidebar.footer.action` —— 侧栏脚部的价格状态条（一眼看出是否半价）
 *   · `shell.overlay`         —— 全屏浮层里的鲸鱼娘桌宠：
 *                                自由漫游、拎起拖动、抛出、摸头、说话（价格台词）。
 *   本组件只负责**接线**（指针事件、命中区跟随、台词与气泡、右键菜单、亲密度）；
 *   动画、物理、表情、视线跟随全部由 vendored 的 pet-core 驱动。
 */

// ── 诊断信标 ────────────────────────────────────────────────────────────────
// 「开机不自启」这类只在真机开机瞬间出现的问题，光看代码猜不出来：把浏览器半身
// 走到的每一步回报给 Host 的 /api/diag，重启一次就能拿到确凿证据。
// 失败一律静默——诊断绝不能影响主流程，也绝不能拖慢它（不 await、不重试）。
var PW_DIAG_ROUTE = '/dsh-deepseek-peak-whale/api/diag';
function pwBeacon(phase, detail) {
  try {
    if (typeof fetch !== 'function') return;
    fetch(PW_DIAG_ROUTE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        phase: String(phase),
        detail: detail === undefined || detail === null ? '' : String(detail),
      }),
      keepalive: true,
    }).catch(function () { /* 诊断失败无所谓 */ });
  } catch (error) { /* 同上 */ }
}
/** 把任意抛出来的东西压成一行短文本（诊断用，绝不能再抛）。 */
function errText(error) {
  try {
    return (error && (error.message || error.name)) || String(error);
  } catch (inner) {
    return 'unknown';
  }
}

/**
 * 跑一个**可选步骤**：炸了只记一笔，绝不往上冒。
 *
 * 这是「开机不自启」的根治手法。真机实测（2026-10-06 16:52 开机信标）：
 * `apply-start` 之后什么都没有——既没有 `mounted` 也没有 `mount-failed`，
 * 说明 apply 在两者之间抛了异常，被外层 catch 静默吞掉，于是价格条 / 鲸鱼娘 /
 * 设置页 tab **一个都没挂上**。事后去插件页关掉再打开（重新 apply）就好了——
 * 因为那时 layout 已经就绪，不再抛。
 *
 * 教训：apply 里任何「锦上添花」的一步（装样式、抓 layout）都**不许**有能力
 * 拦住宿主功能。每一步各自 try，出事的步骤名会发回 /api/diag。
 */
function pwStep(name, fn) {
  try {
    return fn();
  } catch (error) {
    pwBeacon('step-threw', name + ': ' + errText(error));
    if (typeof console !== 'undefined') console.warn('[peak-whale] 步骤失败 ' + name + ':', error);
    return undefined;
  }
}

pwBeacon('script-executed', 'facade=' + (
  typeof window !== 'undefined' && window.__ModuleLoader__ ? 'yes' : 'no'
));

window.__ModuleLoader__.load({
  id: 'dsh-deepseek-peak-whale',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
    pwBeacon('factory-materialized', 'require=' + typeof require);
    var react = require('react');
    var h = react.createElement;

    /** 价格状态条：侧栏脚部、账号位旁边的动作区。 */
    var STRIP_SLOT = 'sidebar.footer.action';
    var STRIP_ORDER = -10;
    /** 鲸鱼娘桌宠：全屏浮层（在所有列之上、滚动容器之外，且本身点击穿透）。 */
    var ROAM_SLOT = 'shell.overlay';
    var ROAM_ORDER = 5;

    // ============================================================================
    //  峰谷核心逻辑 —— 由 build.mjs 从 src/peak.js 注入（不要在此手改）
    // ============================================================================
    /* __PEAK_CORE_BEGIN__ */
    /* __PEAK_CORE_END__ */
    // ============================================================================

    // ============================================================================
    //  鲸鱼桌宠运行时 —— 由 build.mjs 注入（不要在此手改）
    //  得到 PET_MODEL（几何）/ PET_TEX（贴图 data URI）/ PET（运行时 API）
    //  以及 WHALE_ICON_URI（侧栏小图标）。
    //  来源 github.com/Pal-AI-Lab/Coopanion，AGPL-3.0-or-later，仅本机个人使用。
    // ============================================================================
    /* __PET_RUNTIME_BEGIN__ */
    /* __PET_RUNTIME_END__ */
    // ============================================================================

    var CSS = `
.pw-strip{display:flex;align-items:center;gap:6px;width:100%;box-sizing:border-box;
  padding:4px 6px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;
  background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);
  font:inherit;font-size:12px;line-height:18px;text-align:left;cursor:pointer;
  transition:border-color .15s ease,background .15s ease}
.pw-strip:hover{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l2)}
.pw-strip[data-tone="off"]{border-color:var(--dsw-alias-state-success-primary)}
.pw-strip[data-tone="peak"]{border-color:var(--dsw-alias-state-warn-primary)}
.pw-strip[data-wide="0"]{justify-content:center;padding:4px}
.pw-strip-icon{flex:0 0 auto;width:19px;height:20px;display:block;object-fit:contain;
  user-select:none;-webkit-user-drag:none;pointer-events:none}
.pw-title{font-weight:600;white-space:nowrap}
.pw-title[data-tone="off"]{color:var(--dsw-alias-state-success-primary)}
.pw-title[data-tone="peak"]{color:var(--dsw-alias-state-warn-primary)}
.pw-spacer{flex:1 1 auto;min-width:4px}
.pw-count{white-space:nowrap;font-variant-numeric:tabular-nums}
/* 状态条改成两行：上行还是「时段 + 倒计时」，下行是「余额 + 今日费用」。
   侧栏只有约 260px 宽，两行比挤在一行里更读得清。 */
.pw-body{flex:1 1 auto;min-width:0;display:flex;flex-direction:column}
.pw-row{display:flex;align-items:center;gap:6px;min-width:0}
/* 第二行**只在真拿到数据时渲染**：一条极细分隔线把它和倒计时分开，
   标签走次级色、数字走主色加粗并用等宽数字，读起来是一行数据而不是一句提示。 */
.pw-wallet{display:flex;align-items:center;gap:5px;min-width:0;
  margin-top:5px;padding-top:4px;
  border-top:1px solid var(--dsw-alias-border-l1);
  white-space:nowrap;overflow:hidden}
.pw-witem{display:inline-flex;align-items:baseline;gap:4px;min-width:0;
  font-size:11px;line-height:15px;color:var(--dsw-alias-label-secondary);
  font-variant-numeric:tabular-nums;overflow:hidden}
.pw-witem b{font-weight:600;color:var(--dsw-alias-label-primary)}
.pw-wlabel{white-space:nowrap}
.pw-wvalue{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pw-wsep{font-size:11px;line-height:15px;color:var(--dsw-alias-label-secondary);opacity:.75}
.pw-backdrop{position:fixed;inset:0;z-index:1190}
/* 竖长卡片：宽度对齐侧栏（340px），高度给到 560px —— 详细版内容超出就在卡片内滚动。
   价格表四列在窄卡片里用 11px + 收紧内边距，第一列允许折行（见下面 .pw-table）。
   亚克力（毛玻璃）：半透明底 + backdrop-filter；不支持的环境用 @supports 退回不透明底色。 */
.pw-pop{position:fixed;left:12px;bottom:56px;width:340px;max-width:calc(100vw - 24px);
  max-height:560px;display:flex;flex-direction:column;overflow:hidden;
  box-sizing:border-box;padding:12px 14px;border-radius:12px;
  border:1px solid var(--dsw-alias-border-l2);
  background:color-mix(in srgb, var(--dsw-alias-bg-overlay) 76%, transparent);
  -webkit-backdrop-filter:blur(18px) saturate(1.5);
  backdrop-filter:blur(18px) saturate(1.5);
  color:var(--dsw-alias-label-primary);box-shadow:0 10px 32px rgba(0,0,0,.28);
  font-size:12px;line-height:20px;z-index:1200}
@supports not ((backdrop-filter:blur(2px)) or (-webkit-backdrop-filter:blur(2px))){
  .pw-pop{background:var(--dsw-alias-bg-overlay)}
}
.pw-pop .pw-dim{opacity:.5}
.pw-pop b{font-weight:600}
/* 窄卡片（340px）里的四列表：11px 字号 + 3px 内边距 + 固定布局；
   第一列（模型名）允许折行，其余数字列仍然不换行，四列刚好排得下。 */
.pw-table{width:100%;border-collapse:collapse;margin:6px 0 2px;font-size:11px;table-layout:fixed}
.pw-table th,.pw-table td{padding:2px 3px;text-align:right;white-space:nowrap}
.pw-table th:first-child,.pw-table td:first-child{text-align:left;white-space:normal}
.pw-table thead th{color:var(--dsw-alias-label-primary);font-weight:600;
  border-bottom:1px solid var(--dsw-alias-border-l1)}
.pw-now{color:var(--dsw-alias-label-primary);font-weight:600}
.pw-dim{opacity:.42}
.pw-slash{opacity:.4}
.pw-link{color:var(--dsw-alias-brand-primary);text-decoration:none}
.pw-link:hover{text-decoration:underline}
.pw-foot{margin-top:6px;opacity:.75;font-size:11px;line-height:17px}
/* ── 账户卡片（详情浮层里的余额与今日费用）───────────────────── */
/* 底色也留一点透明度，毛玻璃才透得出来（不支持的浏览器只是看着更实，不影响可读性）。 */
.pw-wallet-card{margin-top:8px;padding:8px 10px;border-radius:9px;
  border:1px solid var(--dsw-alias-border-l1);
  background:color-mix(in srgb, var(--dsw-alias-bg-layer-1) 74%, transparent)}
.pw-wallet-row{display:flex;align-items:baseline;justify-content:space-between;gap:10px;
  line-height:19px}
.pw-wallet-row .pw-label{color:var(--dsw-alias-label-secondary);white-space:nowrap}
.pw-wallet-row .pw-value{font-weight:600;font-variant-numeric:tabular-nums;text-align:right}
/* 当日费用是这张卡片的主角：单独一段、细分隔线、标签转主色、数字放大一档 */
.pw-wallet-row--today{margin-top:7px;padding-top:7px;
  border-top:1px solid var(--dsw-alias-border-l1)}
.pw-wallet-row--today .pw-label{color:var(--dsw-alias-label-primary);font-weight:600}
.pw-wallet-row--today .pw-value{font-size:13px;line-height:18px}
.pw-wallet-sub{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:17px;
  font-variant-numeric:tabular-nums}
.pw-wallet-links{margin-top:4px;display:flex;gap:10px;font-size:11px;line-height:17px}
.pw-wallet-note{margin-top:4px;opacity:.7;font-size:11px;line-height:17px}

/* ── 鲸鱼娘桌宠（全屏浮层）────────────────────────────────────
   整层点击穿透，只有 .pw-hitbox（跟随她身体的命中区）开回 pointer-events，
   所以她永远只挡住自己身体那一小块。SVG 由 pet-core 直接驱动：
   #pet 里 figure 会挂一个 <foreignObject> 画布（WebGL2），transform 由物理层设置；
   #shadow 是接地影子；#fx 是爱心 / z / 粒子等特效组。 */
.pw-roam{position:fixed;inset:0;z-index:1185;pointer-events:none}
.pw-stage{position:absolute;inset:0;width:100%;height:100%;overflow:visible}
.pw-hitbox{position:absolute;left:0;top:0;width:0;height:0;
  pointer-events:auto;cursor:grab;background:transparent;border:0;padding:0}

/* ── 右键菜单 ─────────────────────────────────────────────── */
/* 必须显式写 pointer-events:auto：父级 .pw-roam 是 none（防止挡住界面），
   不写的话菜单能显示但一个都点不动。 */
.pw-menu-backdrop{position:fixed;inset:0;z-index:1199;pointer-events:auto}
.pw-menu{position:fixed;z-index:1200;min-width:158px;padding:4px;
  border:1px solid var(--dsw-alias-border-l2);border-radius:10px;
  background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);
  box-shadow:0 8px 26px rgba(0,0,0,.26);font-size:12px;line-height:1;
  animation:pw-menu-in .12s ease-out}
.pw-menu button{display:block;width:100%;box-sizing:border-box;padding:7px 10px;
  border:0;border-radius:7px;background:transparent;color:inherit;font:inherit;
  text-align:left;cursor:pointer;white-space:nowrap}
.pw-menu button:hover{background:var(--dsw-alias-bg-layer-2)}
.pw-menu hr{margin:4px 8px;border:0;border-top:1px solid var(--dsw-alias-border-l1)}
.pw-menu-note{padding:6px 10px 4px;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:15px}
@keyframes pw-menu-in{from{opacity:0;transform:scale(.94)}to{opacity:1;transform:scale(1)}}

/* ── 优化气泡 / 撤销对话框：挂在小鲸鱼头顶（位置由 anchor 每帧写入） ─────────
   三种态：busy 优化中（无按钮）/ done 询问撤销（√/×，不设时限）/ error 原因（知道了）。
   和右键菜单同一个坑：父层 .pw-roam 是 pointer-events:none，
   不显式写 auto 就是「看得见点不动」。 */
.pw-opt{position:absolute;left:0;top:0;transform:translate(-50%,-100%);margin-top:-6px;
  z-index:6;display:flex;flex-direction:column;gap:6px;box-sizing:border-box;
  max-width:min(280px,calc(100vw - 24px));padding:9px 12px;border-radius:12px;
  pointer-events:auto;border:1px solid var(--dsw-alias-border-l2);
  background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);
  box-shadow:0 6px 20px rgba(0,0,0,.22);font-size:12px;line-height:17px;
  animation:pw-pop .2s ease-out}
.pw-opt:after{content:'';position:absolute;left:50%;top:100%;margin-left:-4px;
  border:4px solid transparent;border-top-color:var(--dsw-alias-bg-overlay)}
.pw-opt[data-kind="busy"]{color:var(--dsw-alias-label-secondary)}
.pw-opt[data-kind="error"]{border-color:var(--dsw-alias-state-error-primary)}
.pw-opt[data-kind="error"] .pw-opt-text{white-space:normal}
.pw-opt-ask{display:flex;flex-direction:column;gap:2px;color:var(--dsw-alias-label-primary)}
.pw-opt-actions{display:flex;gap:8px}
.pw-opt button{flex:none;border:0;border-radius:999px;padding:4px 12px;cursor:pointer;
  font:inherit;font-weight:600}
.pw-opt button.pw-opt-yes{background:var(--dsw-alias-brand-primary);color:#fff}
.pw-opt button.pw-opt-no{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.pw-opt button.pw-opt-close{background:transparent;color:var(--dsw-alias-label-secondary);
  font-weight:500;padding:4px 6px;align-self:flex-end}
.pw-opt button:hover{filter:brightness(1.08)}

/* ── 详情浮层：分节标题与底部动作 ──────────────────────────────────────── */
/* 模式切换只在「设置 → 插件 → 小鲸鱼」里改，浮层顶部不再摆开关（v0.4.0 起）。 */
.pw-sec{margin:12px 0 6px;padding-bottom:4px;border-bottom:1px solid var(--dsw-alias-border-l1);
  font-size:11px;font-weight:600;letter-spacing:.06em;color:var(--dsw-alias-label-secondary)}
.pw-sec:first-child{margin-top:0}
/* 详细版底部的「设置」按钮：跳到内置「插件」设置面板（我们的 tab 就在那）。
   吸底：详细版内容比卡片高、要在卡片内滚动，按钮必须**始终露在下沿**而不是被顶出视野。 */
/* 内容区自己滚（面板本体 overflow:hidden）：「设置」按钮因此**独立占位**，
   滚过的文字不会从它下面透出来（曾经用 sticky 叠着，半透明底把字糊成一团）。 */
.pw-pop-body{flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain}
.pw-actions{position:static;flex:none;z-index:1;display:flex;justify-content:flex-end;
  margin:10px -14px -12px;padding:8px 14px 10px;
  background:color-mix(in srgb, var(--dsw-alias-bg-overlay) 96%, transparent);
  border-top:1px solid var(--dsw-alias-border-l1);border-radius:0 0 11px 11px}
.pw-set-btn{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:4px 14px;
  cursor:pointer;font:inherit;font-size:12px;font-weight:500;line-height:18px;
  background:color-mix(in srgb, var(--dsw-alias-bg-layer-1) 72%, transparent);
  color:var(--dsw-alias-label-primary)}
.pw-set-btn:hover{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}

/* ── 设置页（设置 → 插件 → 小鲸鱼） ─────────────────────────────────────── */
.pw-settings{max-width:640px;display:flex;flex-direction:column;gap:16px;padding:4px 0 16px}
.pw-settings h3{margin:0;font-size:18px;font-weight:600}
.pw-settings h4{margin:0 0 8px;font-size:13px;font-weight:600}
.pw-settings .pw-dim{color:var(--dsw-alias-label-secondary);margin:4px 0 0}
.pw-set-sec{padding:12px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;
  background:var(--dsw-alias-bg-layer-1)}
.pw-set-modes{display:flex;flex-direction:column;gap:8px}
.pw-set-mode{display:flex;align-items:baseline;gap:8px;cursor:pointer;padding:8px 10px;
  border:1px solid var(--dsw-alias-border-l2);border-radius:8px}
.pw-set-mode.is-on{border-color:var(--dsw-alias-brand-primary)}
.pw-set-mode-name{font-weight:600;min-width:56px}
.pw-set-mode-note{color:var(--dsw-alias-label-secondary);font-size:12px}
.pw-set-switch{display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px}
.pw-set-help{margin:0;padding-left:18px;display:flex;flex-direction:column;gap:6px;
  color:var(--dsw-alias-label-secondary);font-size:12px;line-height:17px}
.pw-set-state{color:var(--dsw-alias-label-secondary);font-size:12px;margin:0}
.pw-set-error{color:var(--dsw-alias-state-error-primary)}

/* 说话气泡：位置由 ctl.anchor()（头顶）每帧写入 left/top，所以这里只管外观。
   她走动时气泡跟着走，不需要额外的位移动画。 */
.pw-bubble{position:absolute;left:0;top:0;transform:translate(-50%,-100%);
  margin-top:-6px;padding:5px 10px;border-radius:11px;white-space:pre-wrap;
  max-width:240px;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);
  border:1px solid var(--dsw-alias-border-l1);
  font-size:11px;line-height:16px;font-weight:500;pointer-events:none;
  box-shadow:0 4px 16px rgba(0,0,0,.18);animation:pw-pop .24s ease-out;z-index:3}
.pw-bubble:after{content:'';position:absolute;left:50%;top:100%;margin-left:-4px;
  border:4px solid transparent;border-top-color:var(--dsw-alias-bg-overlay)}

/* 气泡入场：基础 transform 是 translate(-50%,-100%)，关键帧必须带上它 */
@keyframes pw-pop{from{opacity:0;transform:translate(-50%,-100%) translateY(5px) scale(.92)}
  to{opacity:1;transform:translate(-50%,-100%) translateY(0) scale(1)}}
@media (prefers-reduced-motion:reduce){
  .pw-menu,.pw-bubble{animation:none}
}
`;

    // ============================================================================
    //  工具
    // ============================================================================
    function pickOne(list) {
      return list[Math.floor(Math.random() * list.length)];
    }

    /** 取 localStorage；隐私模式 / 沙箱里访问会抛，一律降级为 null。 */
    function safeStorage() {
      try {
        return typeof localStorage !== 'undefined' ? localStorage : null;
      } catch (error) {
        return null;
      }
    }

    /**
     * 鲸鱼娘会说的话（纯函数，便于测试）。
     * @returns {{ price: string[], idle: string[], greet: string[] }}
     */
    function roamLines(date) {
      var t = date === undefined ? new Date() : date;
      var price;
      try {
        var s = summary(t);
        if (!s.isPeak) {
          if (s.isHoliday && s.holiday) {
            price = ['今天' + s.holiday.name + '假期，半价哦～', '假期全天半价，随便用！', '放假的 token 是打折的～'];
          } else if (s.isWeekend) {
            price = ['周末半价，别客气～', '周末的 token 打折啦', '现在便宜一半，冲！'];
          } else {
            price = ['现在是谷时，便宜一半～', '半价时段，放心跑吧', '趁便宜多干点活！', '谷时半价，谁用谁知道'];
          }
        } else {
          price = ['全价时段…省着点花', '现在是峰时，token 贵一倍', '要不…等半价再跑？', '哼，峰时也不许浪费'];
        }
      } catch (error) {
        price = ['鲸鱼娘在看着你的 token 呢'];
      }
      return {
        price: price,
        idle: ['摸鱼中…', '呼…好困', '主人好久没理我了', '在原地转个圈～', 'zzz…', '发呆中…'],
        greet: ['我出来啦～', '巡场中…', '我来看看谁在烧 token', '巡逻！'],
      };
    }

    // ============================================================================
    //  打字回避：你在输入框里打字时，她要离开文本框区域
    //
    //  判定全在下面这几个纯函数里（视口坐标，不碰全局），所以能直接单测；
    //  真正的「喊她走」由 WhaleRoamer 每帧调一次 avoidWhileTyping 完成。
    // ============================================================================
    /** 文本框左右各留出的缝隙：她贴着这一侧站，就不压住输入框与旁边的按钮。 */
    var AVOID_MARGIN_X = 40;
    /** 纵向余量：输入框所在的卡片比框本身高（上沿标题、下沿工具行）。 */
    var AVOID_MARGIN_TOP = 24;
    var AVOID_MARGIN_BOTTOM = 72;
    /**
     * 停下时与回避区再留出的间隙。
     *
     * 她的包围盒**随走姿晃动**（跨步/前倾时能宽出十几像素），只按规划那一刻的半宽
     * 算「刚好贴边」，走到位时往往会往回压进区里几个像素——真实浏览器里就是这样翻车的
     * （pet-harness 的行为断言抓到过：x 807 → 473，差 6px 没出去）。
     * 留 24px 余量把这层晃动吃掉，界面上也更像「让开了」而不是「贴着站」。
     */
    var AVOID_CLEARANCE = 24;
    /** 打字停止后，回避状态再保持这么久（写完一句停顿一下，她不会立刻走回来）。 */
    var TYPING_GRACE_MS = 3000;
    /** 她离窗口边缘的最小留白（与 pet-core 的 `104*S + 8` 同一口径）。 */
    var AVOID_EDGE = 8;
    /** 目标位置相差不到这个数就不重新下令 —— 否则每帧 walkTo 会把步态重置成原地踏步。 */
    var AVOID_TARGET_TOLERANCE = 16;
    /** 这个距离以上就跑过去，不然走过去太慢，你一句话都打完了她还没让开。 */
    var AVOID_RUN_DISTANCE = 160;

    /**
     * 「现在算不算正在打字」：最后一次按键的宽限期内，**或者焦点还留在文本框里**。
     *
     * 只看按键会漏掉「打完一句停在那儿」的情况——光标还在框里，
     * 你随时会接着写，所以她得一直在外面等着。
     *
     * @param {object|null} activeElement - `document.activeElement`。
     * @param {number} until - 宽限截止时刻（毫秒）。
     * @param {number} now - 当前时刻（毫秒）。
     * @returns {boolean}
     */
    function typingActive(activeElement, until, now) {
      return now < until || isEditable(activeElement);
    }

    /**
     * 这个元素是不是「能打字的地方」（input / textarea / contenteditable）。
     * 只读属性、不碰全局，所以测试里塞个普通对象就能覆盖。
     *
     * @param {object|null} el - 候选元素。
     * @returns {boolean}
     */
    function isEditable(el) {
      if (!el || typeof el !== 'object') return false;
      const tag = String(el.tagName || '').toUpperCase();
      if (tag === 'TEXTAREA') return el.disabled !== true;
      if (tag === 'INPUT') {
        if (el.disabled === true) return false;
        const type = String(el.type || 'text').toLowerCase();
        return ['hidden', 'checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'image', 'range', 'color']
          .indexOf(type) === -1;
      }
      return el.isContentEditable === true;
    }

    /**
     * 从事件目标往上找一个能打字的元素（焦点有时落在编辑器的子节点上，
     * 比如 contenteditable 里的 `<p>`，那一层自己 `isContentEditable === false`）。
     *
     * @param {object|null} node - 起点（事件目标或 `document.activeElement`）。
     * @returns {object|null} 找到的文本框元素；最多往上走 5 层。
     */
    function editableAncestor(node) {
      var el = node;
      for (var i = 0; el && i < 5; i += 1) {
        if (isEditable(el)) return el;
        el = el.parentElement || el.parentNode || null;
      }
      return null;
    }

    /**
     * 文本框（连同它所在卡片的余量）在视口里的矩形。
     *
     * 横向放 `AVOID_MARGIN_X`，纵向上浅下深——下面那截是工具行，
     * 而她贴地走，判定要贴近「真实会被她挡住的可点区域」。
     *
     * @param {object} el - 文本框元素。
     * @returns {{left:number, right:number, top:number, bottom:number}|null}
     */
    function editableZone(el) {
      if (!isEditable(el) || typeof el.getBoundingClientRect !== 'function') return null;
      let rect;
      try {
        rect = el.getBoundingClientRect();
      } catch (error) {
        return null;
      }
      if (!rect || (rect.right - rect.left) <= 0) return null;
      return {
        left: rect.left - AVOID_MARGIN_X,
        right: rect.right + AVOID_MARGIN_X,
        top: rect.top - AVOID_MARGIN_TOP,
        bottom: rect.bottom + AVOID_MARGIN_BOTTOM,
      };
    }

    /** 两个矩形有没有重叠（`pad` 是四边各放宽多少）。 */
    function rectsOverlap(a, b, pad) {
      const p = typeof pad === 'number' ? pad : 0;
      return a.left < b.right + p
        && a.right > b.left - p
        && a.top < b.bottom + p
        && a.bottom > b.top - p;
    }

    /**
     * 挡路时该走到哪个 x：文本框**外侧最近**的一边，并保证真的落在框外。
     *
     * 两侧都塞不下（窗口太窄 / 她太宽）时返回 null —— 与其在框里来回蹭，
     * 不如下次再试。
     *
     * @param {{left:number,right:number}} petRect - 她的身体矩形（视口坐标）。
     * @param {{left:number,right:number}} zone - `editableZone` 给的回避区。
     * @param {number} width - 舞台宽度（= 视口宽度）。
     * @returns {number|null} 目标 x；不挡路或无处可去时为 null。
     */
    function escapeTargetX(petRect, zone, width) {
      const half = Math.max(1, (petRect.right - petRect.left) / 2);
      const center = (petRect.left + petRect.right) / 2;
      const lo = half + AVOID_EDGE;
      const hi = width - half - AVOID_EDGE;
      if (!(hi > lo)) return null;
      const clampX = (x) => (x < lo ? lo : x > hi ? hi : x);
      // 必须留出 AVOID_CLEARANCE：走姿会让包围盒晃动，「刚好贴边」= 到位时又压回去
      const clear = (x) => x + half + AVOID_CLEARANCE <= zone.left
        || x - half - AVOID_CLEARANCE >= zone.right;
      const options = [zone.left - half - AVOID_CLEARANCE, zone.right + half + AVOID_CLEARANCE]
        .map(clampX)
        .filter(clear)
        .sort((a, b) => Math.abs(a - center) - Math.abs(b - center));
      return options.length > 0 ? options[0] : null;
    }

    /**
     * 每帧的走位决策：**不挡路就什么都不做**（返回 null）。
     *
     * @param {{left:number,right:number,top:number,bottom:number}|null} petRect - 她的矩形。
     * @param {object|null} zone - 当前回避区。
     * @param {number} width - 舞台宽度。
     * @returns {number|null} 需要前往的 x。
     */
    function escapePlan(petRect, zone, width) {
      if (!petRect || !zone) return null;
      if (!rectsOverlap(petRect, zone, 0)) return null;
      return escapeTargetX(petRect, zone, width);
    }

    // ============================================================================
    //  提示词优化：把她拖到文本框上 → 换一版更好的提示词，不满意还能撤销
    // ============================================================================
    /** Host 侧的优化路由（POST `{text}`）。key 只待在 Host，永远不进这个 bundle。 */
    var OPTIMIZE_ROUTE = '/dsh-deepseek-peak-whale/api/optimize';
    /** 「拖到文本框上」的判定余量 —— 比回避区（40px）小，投递要更笃定一点。 */
    var DROP_PAD = 16;
    /** 写回后的归一化宽限：编辑器可能自己 trim/规范化，这 800ms 内不算「用户改过」。 */
    var UNDO_GRACE_MS = 800;

    /** 读文本框正文：textarea/input 读 value，contenteditable 读 innerText。 */
    function readComposer(el) {
      if (!el || typeof el !== 'object') return '';
      try {
        const tag = String(el.tagName || '').toUpperCase();
        if (tag === 'TEXTAREA' || tag === 'INPUT') {
          return typeof el.value === 'string' ? el.value : '';
        }
        if (typeof el.innerText === 'string') return el.innerText;
        return typeof el.textContent === 'string' ? el.textContent : '';
      } catch (error) {
        return '';
      }
    }

    /**
     * 写回文本框正文并派发 `input`。
     *
     * 两个坑都在这里：
     * ① React 的受控输入要走**原型上的原生 setter**（`el.value = x` 会被它下一次渲染盖回去）；
     * ② 必须派发 `input` —— 不派发的话框里看着改了、应用以为你没动，一回车就丢。
     *
     * @returns {boolean} 有没有写成功。
     */
    function writeComposer(el, text) {
      if (!el || typeof el !== 'object') return false;
      const tag = String(el.tagName || '').toUpperCase();
      const value = String(text === null || text === undefined ? '' : text);
      try {
        if (tag === 'TEXTAREA' || tag === 'INPUT') {
          let proto = null;
          try {
            if (typeof window !== 'undefined') {
              if (tag === 'TEXTAREA' && window.HTMLTextAreaElement) proto = window.HTMLTextAreaElement.prototype;
              if (tag === 'INPUT' && window.HTMLInputElement) proto = window.HTMLInputElement.prototype;
            }
          } catch (error) {
            proto = null;
          }
          const descriptor = proto ? Object.getOwnPropertyDescriptor(proto, 'value') : null;
          if (descriptor && typeof descriptor.set === 'function') descriptor.set.call(el, value);
          else el.value = value;
        } else {
          el.innerText = value;
        }
      } catch (error) {
        try {
          el.value = value;
        } catch (error2) {
          try {
            el.innerText = value;
          } catch (error3) {
            return false;
          }
        }
      }
      try {
        if (typeof el.dispatchEvent === 'function' && typeof Event === 'function') {
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }
      } catch (error) { /* 派发不了就当纯 DOM 写入 */ }
      return true;
    }

    /** 投递区：文本框本体 ±`DROP_PAD`（视口坐标）。取不到就 null。 */
    function dropZone(el) {
      if (!isEditable(el) || typeof el.getBoundingClientRect !== 'function') return null;
      let rect;
      try {
        rect = el.getBoundingClientRect();
      } catch (error) {
        return null;
      }
      if (!rect || (rect.right - rect.left) <= 0) return null;
      return {
        left: rect.left - DROP_PAD,
        right: rect.right + DROP_PAD,
        top: rect.top - DROP_PAD,
        bottom: rect.bottom + DROP_PAD,
      };
    }

    /** 点是否落在矩形里（视口坐标）。 */
    function pointInRect(point, rect) {
      return !!(point && rect
        && point.x >= rect.left && point.x <= rect.right
        && point.y >= rect.top && point.y <= rect.bottom);
    }

    /**
     * 撤销胶囊什么时候该自己收起：写回已过归一化宽限，而框里的内容**不再是
     * 当初优化出来的那版**（你自己改过、或应用换过）——绝不能拿旧稿盖掉你的新输入。
     */
    function shouldDismissUndo(undo, currentText, nowMs) {
      if (!undo) return false;
      if (!(nowMs - undo.since >= UNDO_GRACE_MS)) return false;
      return currentText !== undo.optimized;
    }

    /**
     * 打一次 Host 的优化路由。**永不 reject**：失败一律变成 `{ok:false, message}`，
     * 由界面显示给人看（拖一次不该在控制台留一个未处理的 rejection）。
     *
     * @param {string} text - 文本框里的原文。
     * @returns {Promise<{ok: boolean, optimized?: string, message?: string, cached?: boolean}>}
     */
    function optimizePrompt(text) {
      try {
        if (typeof fetch !== 'function') {
          return Promise.resolve({ ok: false, message: '这个环境没有 fetch，接不到 Host' });
        }
        if (typeof window === 'undefined' || !window.location || !window.location.origin) {
          return Promise.resolve({ ok: false, message: '非浏览器环境，接不到 Host' });
        }
        return fetch(window.location.origin + OPTIMIZE_ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: text }),
        }).then(
          function (response) {
            if (!response) throw new Error('没有响应');
            return response.json().then(
              function (payload) {
                if (!payload || payload.ok !== true) {
                  return { ok: false, message: (payload && payload.message) || `HTTP ${response.status}` };
                }
                return {
                  ok: true,
                  optimized: payload.optimized,
                  cached: payload.cached === true,
                  model: payload.model,
                };
              },
              function () {
                return { ok: false, message: `Host 返回的不是 JSON（HTTP ${response.status}）` };
              },
            );
          },
          function (error) {
            return { ok: false, message: `连不上 Host：${error && error.message ? error.message : String(error)}` };
          },
        );
      } catch (error) {
        return Promise.resolve({ ok: false, message: String(error && error.message ? error.message : error) });
      }
    }

    // ============================================================================
    //  账户钱包：余额 + 当日费用（数据由 Host 半身的 HTTP 路由提供）
    // ============================================================================
    /**
     * Host 半身用 `webServer` 注册的路由。**相对路径 = 同源请求**，
     * Host 侧刻意不发 CORS 头：余额是账户数据，不能让任意网页读到。
     *
     * 为什么不走 `host.call`：那是**动态插件**（cordis_define）才有的内建，
     * 安装型包没有它；官方插件同样以 webServer 路由对外提供 Host 数据。
     */
    var WALLET_ROUTE = '/dsh-deepseek-peak-whale/api/wallet';
    /** Host 对余额有 45 秒缓存；客户端 60 秒拉一次既够跟手也不打扰。 */
    var WALLET_POLL_MS = 60000;
    /** UI 设置（详情页模式 / 优化开关）：GET 读取、POST 写入；key 永远不经过这里。 */
    var SETTINGS_ROUTE = '/dsh-deepseek-peak-whale/api/settings';
    /** 设置页与详情浮层共享一份 UI 设置（wallet 载荷没带时回落默认值：默认简洁版）。 */
    var uiSettingsState = { uiMode: 'concise', optimizeEnabled: true, apiKeyConfigured: false };
    var uiSettingsListeners = [];
    /**
     * `layout` 客户端服务：**按需解析，绝不在 apply 时抓一次缓存**。
     *
     * 老代码在 apply 里 `ctx.get('layout')` 拿不到就退到 `ctx.layout` 属性访问，
     * 并在那时缓存结果。开机瞬间 layout 可能还没注册，而服务缺失时的属性访问
     * **会抛异常**——异常顺着 apply 冒到外层 catch，把整个挂载一起带走（真机表现：
     * 重启后小鲸鱼完全不出现，去插件页关掉再打开才出来，因为那时 layout 已就绪）。
     * 现在两条取值路径各自 try 住、点击时才解析、空结果不缓存。
     */
    var layoutOverride = null; // 测试 / 二次开发注入（见 exports.setLayoutService）
    var pluginCtx = null; // apply 时记下，供按需解析 layout

    function resolveLayout() {
      if (layoutOverride) return layoutOverride;
      var ctx = pluginCtx;
      if (!ctx) return null;
      var layout;
      try {
        layout = typeof ctx.get === 'function' ? ctx.get('layout') : undefined;
      } catch (error) {
        pwBeacon('layout-get-threw', errText(error));
        layout = undefined;
      }
      if (!layout) {
        try {
          layout = ctx.layout;
        } catch (error) {
          pwBeacon('layout-prop-threw', errText(error));
          layout = undefined;
        }
      }
      return layout && typeof layout.selectPanel === 'function' ? layout : null;
    }

    /**
     * 打开内置「插件」设置面板 —— 我们的「小鲸鱼」tab 就挂在那一页
     * （`settings.plugins.tab` 槽位）。面板键 `plugins` 取自内置侧栏的同名入口。
     * 拿不到 layout 服务或面板没注册就安静地什么都不做，绝不抛错。
     */
    function openPluginsSettings() {
      try {
        var layout = resolveLayout();
        if (layout) {
          layout.selectPanel('plugins');
          return true;
        }
      } catch (error) {
        if (typeof console !== 'undefined') {
          console.warn('[peak-whale] 打开设置面板失败:', error);
        }
      }
      return false;
    }

    /** 更新 UI 设置并通知订阅者；永不 reject（失败静默，下一轮 wallet 轮询会纠正）。 */
    function publishUiSettings(next) {
      if (next && typeof next === 'object') uiSettingsState = next;
      for (var i = 0; i < uiSettingsListeners.length; i += 1) {
        try {
          uiSettingsListeners[i](uiSettingsState);
        } catch (error) { /* 忽略 */ }
      }
    }

    /** 从 wallet 载荷里同步 UI 设置（Host 每轮轮询都带）。 */
    function syncUiSettingsFromWallet(wallet) {
      if (wallet && wallet.settings && typeof wallet.settings === 'object') {
        publishUiSettings(wallet.settings);
      }
    }

    /**
     * POST 写一项 UI 设置（白名单字段）。**永不 reject**：成功就发布新值，
     * 失败只打一行 warn——界面乐观更新，Host 是最终裁决。
     */
    function saveUiSettings(patch) {
      if (typeof fetch !== 'function') return Promise.resolve(false);
      if (typeof window === 'undefined' || !window.location || !window.location.origin) return Promise.resolve(false);
      return fetch(window.location.origin + SETTINGS_ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(patch),
      })
        .then(function (response) {
          if (!response || !response.ok) throw new Error('HTTP ' + (response ? response.status : 0));
          return response.json();
        })
        .then(
          function (payload) {
            if (payload && payload.ok === true && payload.settings) {
              publishUiSettings(payload.settings);
              return true;
            }
            return false;
          },
          function () {
            return false;
          },
        );
    }

    /** 最近一次载荷（null = 还没拉过）。模块级共享，状态条与浮层读同一份。 */
    var walletState = null;
    var walletListeners = [];
    var walletTimer = null;
    var walletInFlight = false;

    /**
     * 拉取地址。非浏览器环境（测试里的 window 桩没有 location）
     * 返回 null —— 这也是「不给测试进程排定时任务」的闸门。
     */
    function walletUrl() {
      try {
        if (typeof fetch !== 'function') return null;
        if (typeof window === 'undefined' || !window.location || !window.location.origin) return null;
        var locale = 'zh-CN';
        try {
          if (typeof navigator !== 'undefined' && navigator && navigator.language) locale = navigator.language;
        } catch (error) { /* 取不到就用默认值 */ }
        return window.location.origin + WALLET_ROUTE + '?locale=' + encodeURIComponent(locale);
      } catch (error) {
        return null;
      }
    }

    /** 换数据并通知所有订阅者（单个订阅者抛错不影响别人）。 */
    function publishWallet(next) {
      walletState = next;
      for (var i = 0; i < walletListeners.length; i += 1) {
        try {
          walletListeners[i](next);
        } catch (error) { /* 忽略 */ }
      }
    }

    /**
     * 拉一次。失败时**保留上一份数据**——余额没刷新不等于余额没了；
     * 一份都还没有时才记下失败原因，让浮层给一句**可操作**的提示
     * （尤其 404：说明 Host 半身还是旧代码，重启一次就好）。
     */
    function refreshWallet() {
      if (walletInFlight) return;
      var url = walletUrl();
      if (url === null) return;
      walletInFlight = true;
      fetch(url, { headers: { accept: 'application/json' } })
        .then(function (response) {
          if (!response) throw new Error('no response');
          if (!response.ok) {
            var failure = new Error('HTTP ' + response.status);
            failure.status = response.status;
            throw failure;
          }
          return response.json();
        })
        .then(
          function (payload) {
            walletInFlight = false;
            if (payload && payload.ok === true) {
              publishWallet(payload);
              syncUiSettingsFromWallet(payload);
            }
          },
          function (error) {
            walletInFlight = false;
            if (walletState === null) {
              publishWallet({
                ok: false,
                unavailable: true,
                status: typeof error === 'object' && error !== null && typeof error.status === 'number'
                  ? error.status
                  : 0,
              });
            }
            // 有旧数据就静默：下一轮轮询会重试。
          },
        );
    }

    /** 订阅：第一个订阅者开轮询，最后一个退订时关掉。返回退订函数。 */
    function subscribeWallet(listener) {
      walletListeners.push(listener);
      // 拉不到地址（非浏览器 / 测试桩）就压根不开定时器：没有可轮询的目标。
      if (walletTimer === null && walletUrl() !== null) {
        refreshWallet();
        walletTimer = setInterval(refreshWallet, WALLET_POLL_MS);
      }
      return function () {
        var index = walletListeners.indexOf(listener);
        if (index >= 0) walletListeners.splice(index, 1);
        if (walletListeners.length === 0 && walletTimer !== null) {
          clearInterval(walletTimer);
          walletTimer = null;
        }
      };
    }

    /** 订阅钱包数据的 hook（配合上面的订阅表，组件一挂载就能拿到最新值）。 */
    function useWallet() {
      var pair = react.useState(walletState);
      var setValue = pair[1];
      react.useEffect(function () {
        return subscribeWallet(setValue);
      }, []);
      return pair[0];
    }

    /** 订阅 UI 设置的 hook（详情页模式 / 优化开关；wallet 轮询与设置页写回都会推新值）。 */
    function useUiSettings() {
      var pair = react.useState(uiSettingsState);
      var setValue = pair[1];
      react.useEffect(function () {
        uiSettingsListeners.push(setValue);
        return function () {
          var index = uiSettingsListeners.indexOf(setValue);
          if (index >= 0) uiSettingsListeners.splice(index, 1);
        };
      }, []);
      return pair[0];
    }

    /**
     * 状态条第二行的分段数据（纯函数，便于测试）。
     *
     * 关键取舍：**拿不到数据就返回空数组**，于是这一行整行不渲染——
     * 宁可侧栏底部暂时保持原样，也不要挂一句「账户数据不可用」把界面搞成半成品。
     * 说明与重试提示交给详情浮层去说（那里有地方写清楚为什么、怎么办）。
     *
     * @param {object|null} wallet - 最近一次载荷。
     * @returns {Array<{label: string, value: string}>}
     */
    function walletItems(wallet) {
      if (!wallet || wallet.unavailable === true || wallet.ok === false) return [];
      var acc = wallet.account || {};
      var bal = wallet.balance || {};
      var items = [];

      if (acc.status === 'signed-out') {
        items.push({ label: '账户', value: '未登录' });
      } else if (bal.status === 'ready') {
        var wallets = Array.isArray(bal.wallets) ? bal.wallets : [];
        if (wallets.length > 0) {
          items.push({ label: '余额', value: formatMoney(wallets[0].balance, wallets[0].currency) });
        }
      } else if (bal.status === 'failed') {
        items.push({ label: '余额', value: '查询失败' });
      }
      // 账户服务缺席 / 还没查到：不摆一个「—」占位，直接不显示这一段。

      if (wallet.today) items.push({ label: '今日', value: formatUsdAmount(wallet.today.usd) });
      return items;
    }

    /**
     * 第二行的一行文本（悬停提示用）。
     * @returns {string|null} null = 这一行不显示。
     */
    function walletSummary(wallet) {
      var items = walletItems(wallet);
      if (items.length === 0) return null;
      var parts = [];
      for (var i = 0; i < items.length; i += 1) parts.push(items[i].label + ' ' + items[i].value);
      return parts.join(' · ');
    }

    /**
     * 详情浮层里的账户卡片（返回元素数组，键由调用方拼接）。
     * @param {object|null} wallet - 最近一次载荷。
     * @returns {Array<object>} 元素列表。
     */
    function walletDetails(wallet) {
      if (!wallet) {
        return [h('div', { key: 'w-load', className: 'pw-foot' }, '账户余额与今日费用读取中…')];
      }
      if (wallet.unavailable === true || wallet.ok === false) {
        // 404 = 路由压根不在，几乎一定是 Host 半身还没换成新代码（要重启）；
        // 其余（断网、服务缺席、500）都是「等一下会自己好」。
        var statusCode = typeof wallet.status === 'number' ? wallet.status : 0;
        var message = statusCode === 404
          ? '账户余额与今日费用要重启一次 DSH 才会出现——Host 侧的新半身还没加载；之后每分钟自动刷新。'
          : '账户余额与今日费用暂时取不到，每分钟会自动重试。';
        return [h('div', { key: 'w-na', className: 'pw-foot' }, message)];
      }

      var acc = wallet.account || {};
      var bal = wallet.balance || {};
      var today = wallet.today || null;
      var rows = [];

      var balanceText;
      if (acc.status === 'signed-out') balanceText = '未登录';
      else if (bal.status === 'ready') balanceText = '已登录';
      else if (bal.status === 'failed') balanceText = '查询失败';
      // 账户服务还没到（开机竞态）与「真的未知」要分开说：前者会自己好，
      // 后者才是异常。摆一个「—」等于什么都不告诉用户（实测反馈）。
      else if (acc.status === 'unavailable') balanceText = '服务未就绪';
      else balanceText = '—';
      rows.push(
        h(
          'div',
          { key: 'b', className: 'pw-wallet-row' },
          h('span', { className: 'pw-label' }, '账户'),
          h('span', { className: 'pw-value' }, balanceText),
        ),
      );

      if (bal.status === 'ready') {
        var wallets = Array.isArray(bal.wallets) ? bal.wallets : [];
        for (var i = 0; i < wallets.length; i += 1) {
          rows.push(
            h(
              'div',
              { key: 'w' + i, className: 'pw-wallet-row' },
              h('span', { className: 'pw-label' }, '余额（' + (wallets[i].currency || 'USD') + '）'),
              h('span', { className: 'pw-value' }, formatMoney(wallets[i].balance, wallets[i].currency)),
            ),
          );
        }
        var bonus = Array.isArray(bal.bonus) ? bal.bonus : [];
        for (var j = 0; j < bonus.length; j += 1) {
          rows.push(
            h(
              'div',
              { key: 'g' + j, className: 'pw-wallet-row' },
              h('span', { className: 'pw-label' }, '赠送（' + (bonus[j].currency || 'USD') + '）'),
              h('span', { className: 'pw-value' }, formatMoney(bonus[j].balance, bonus[j].currency)),
            ),
          );
        }
      }

      if (today) {
        var tokens = today.tokens || {};
        rows.push(
          h(
            'div',
            { key: 't', className: 'pw-wallet-row pw-wallet-row--today' },
            h('span', { className: 'pw-label' }, '今日费用 · ' + today.date),
            h('span', { className: 'pw-value' }, formatUsdAmount(today.usd)),
          ),
        );
        rows.push(
          h(
            'div',
            { key: 'tm', className: 'pw-wallet-sub' },
            (today.isPeak ? '按峰时全价档' : '按谷时半价档')
              + ' · ' + today.requests + ' 次请求'
              + ' · 输入 ' + formatTokens(tokens.uncachedInputTokens)
              + ' · 缓存命中 ' + formatTokens(tokens.cacheReadTokens)
              + ' · 输出 ' + formatTokens(tokens.outputTokens),
          ),
        );
      }

      if (acc.status === 'unavailable') {
        rows.push(
          h('div', { key: 'na', className: 'pw-wallet-sub' }, '账户服务还没就绪，每分钟自动重试。'),
        );
      }

      var links = [];
      if (acc.topUpUrl) {
        links.push(
          h('a', { key: 'top', className: 'pw-link', href: acc.topUpUrl, target: '_blank', rel: 'noreferrer' }, '充值'),
        );
      }
      if (acc.usageUrl) {
        links.push(
          h('a', { key: 'usage', className: 'pw-link', href: acc.usageUrl, target: '_blank', rel: 'noreferrer' }, '官方用量'),
        );
      }
      if (links.length > 0) rows.push(h('div', { key: 'lk', className: 'pw-wallet-links' }, links));

      return [h('div', { key: 'card', className: 'pw-wallet-card' }, rows)];
    }

    // ============================================================================
    //  价格状态条（侧栏脚部）
    // ============================================================================
    /** 每秒重渲染一次，让倒计时走动。 */
    function useTicker() {
      var state = react.useState(0);
      var setTick = state[1];
      react.useEffect(function () {
        var timer = setInterval(function () {
          setTick(function (n) {
            return (n + 1) % 1000000;
          });
        }, 1000);
        return function () {
          clearInterval(timer);
        };
      }, []);
      return state[0];
    }

    /** 一个价目格：`谷 / 峰`，当前生效的一档高亮。 */
    function priceCell(key, bucket, isPeak) {
      return h(
        'td',
        { key: key },
        h('span', { className: isPeak ? 'pw-dim' : 'pw-now' }, formatUsd(bucket.off)),
        h('span', { className: 'pw-slash' }, ' / '),
        h('span', { className: isPeak ? 'pw-now' : 'pw-dim' }, formatUsd(bucket.peak)),
      );
    }

    /** 弹出详情的内容（外壳卡片由 .pw-pop 提供）。`mode`：'concise' 简洁版 / 其余详细版。 */
    function details(now, s, desc, wallet, mode, onOpenSettings) {
      var concise = mode === 'concise';
      var p = beijingParts(now);

      /** 「当前时段」块：两种模式共用；简洁版的内容就是它 + 账户两块的全部。 */
      var periodBlock = [
        h('div', { key: 't' }, '北京时间 ', h('b', null, formatBeijingFull(now)), ' （', WEEKDAY_CN[p.weekday], '）'),
        h('div', { key: 'c' }, '当前：', h('b', null, desc.title), ' —— ', desc.note),
        h(
          'div',
          { key: 'n' },
          '下次切换：',
          h('b', null, boundaryLabel(now, s.next)),
          ' → ',
          s.nextIsPeak ? '峰时（全价）' : '谷时（半价）',
          '，还需 ',
          h('b', null, formatDuration(s.minutesLeft)),
        ),
      ];

      // 「设置」按钮：两种模式都挂在卡片底部（吸底）。
      // 只在详细版给入口会形成死循环 —— 切模式本身要去设置页，简洁版用户就永远进不去。
      var settingsActions = h(
        'div',
        { key: 'act', className: 'pw-actions' },
        h(
          'button',
          {
            key: 'set',
            type: 'button',
            className: 'pw-set-btn',
            onClick: function () {
              openPluginsSettings();
              if (typeof onOpenSettings === 'function') onOpenSettings();
            },
          },
          '设置',
        ),
      );

      if (concise) {
        // 简洁版：只显示余额、今日费用、当前价格档与持续时间（不再挂指路文案）。
        return [
          h('div', { key: 'body', className: 'pw-pop-body' }, [...periodBlock, ...walletDetails(wallet)]),
          settingsActions,
        ];
      }

      var rows = MODELS.map(function (model) {
        return h(
          'tr',
          { key: model.id },
          h('td', { title: model.version }, model.name),
          priceCell('hit', model.cacheHit, s.isPeak),
          priceCell('miss', model.cacheMiss, s.isPeak),
          priceCell('out', model.output, s.isPeak),
        );
      });

      return [
        h(
          'div',
          { key: 'body', className: 'pw-pop-body' },
          [
        h('div', { key: 's1', className: 'pw-sec' }, '当前时段'),
        ...periodBlock,
        h('div', { key: 's2', className: 'pw-sec' }, '账户'),
        ...walletDetails(wallet),
        h('div', { key: 's3', className: 'pw-sec' }, '官方价格表'),
        h(
          'table',
          { key: 'tb', className: 'pw-table' },
          h(
            'thead',
            null,
            h('tr', null, h('th', null, '模型'), h('th', null, '输入·命中'), h('th', null, '输入·未命中'), h('th', null, '输出')),
          ),
          h('tbody', null, rows),
        ),
        h(
          'div',
          { key: 'u' },
          '单位：美元 / 100 万 tokens，格式为 ',
          h('span', { className: 'pw-now' }, '当前档'),
          ' / ',
          h('span', { className: 'pw-dim' }, '另一档'),
          '。谷时价格恰为峰时的一半。',
        ),
        h(
          'div',
          { key: 'r', className: 'pw-foot' },
          '峰时：UTC 01:00–04:00、06:00–10:00（北京时间 09:00–12:00、14:00–18:00），',
          '周一至周五且非法定节假日；其余时段（含整个周末与节假日）均为谷时半价。',
        ),
        h('div', { key: 'hh', className: 'pw-foot' }, '节假日表：国务院办公厅《2026 年部分节假日安排》（内置 2026 年，跨年需更新插件）。'),
        h(
          'div',
          { key: 'src', className: 'pw-foot' },
          '数据来源 ',
          h('a', { className: 'pw-link', href: PRICING_URL, target: '_blank', rel: 'noreferrer' }, 'api-docs.deepseek.com/quick_start/pricing'),
          '（抓取于 ',
          PRICING_AS_OF,
          '）',
        ),
          ],
        ),
        // 详细版底部同样挂「设置」：切简洁/详细、开关提示词优化、看帮助都在那一页。
        settingsActions,
      ];
    }

    /** 侧栏脚部的价格状态条。 */
    function PeakWhaleStrip(props) {
      useTicker();
      var wallet = useWallet();
      var ui = useUiSettings();
      var openState = react.useState(false);
      var open = openState[0];
      var setOpen = openState[1];

      var mode = ui && ui.uiMode === 'detailed' ? 'detailed' : 'concise';

      var now = new Date();
      var s;
      try {
        s = summary(now);
      } catch (error) {
        return null;
      }

      var desc = describePeriod(s);
      var off = s.isHalfPrice;
      var wide = !!(props && props.wide);
      var countdown = (off ? '距峰时 ' : '距半价 ') + formatDurationShort(s.minutesLeft);
      /** 第二行的「余额 · 今日费用」分段：窄轨态与**没数据**时整行都不渲染。 */
      var segments = wide ? walletItems(wallet) : [];
      var walletText = wide ? walletSummary(wallet) : null;

      var title =
        'DeepSeek 峰谷计价（北京时间 ' + formatBeijingFull(now) + '）\n' +
        '当前：' + desc.title + ' —— ' + desc.note + '\n' +
        '下次切换：' + boundaryLabel(now, s.next) + '，还需 ' + formatDuration(s.minutesLeft) +
        (walletText === null ? '' : '\n' + walletText) +
        '\n点击展开今日价格表';

      var body = [h('img', {
        key: 'icon',
        className: 'pw-strip-icon',
        src: WHALE_ICON_URI,
        alt: '',
        'aria-hidden': 'true',
        draggable: false,
      })];
      if (wide) {
        // 数字拆成 `<b>`，标签留次级色：一行数据，而不是一句提示语。
        var walletChildren = [];
        for (var wi = 0; wi < segments.length; wi += 1) {
          if (wi > 0) walletChildren.push(h('span', { key: 'sep' + wi, className: 'pw-wsep' }, '·'));
          walletChildren.push(
            h(
              'span',
              { key: 'item' + wi, className: 'pw-witem' },
              h('span', { className: 'pw-wlabel' }, segments[wi].label),
              h('b', { className: 'pw-wvalue' }, segments[wi].value),
            ),
          );
        }
        body.push(
          h(
            'span',
            { key: 'body', className: 'pw-body' },
            h(
              'span',
              { className: 'pw-row' },
              h('span', { className: 'pw-title', 'data-tone': off ? 'off' : 'peak' }, desc.title),
              h('span', { className: 'pw-spacer' }),
              h('span', { className: 'pw-count' }, countdown),
            ),
            segments.length === 0 ? null : h('span', { className: 'pw-wallet' }, walletChildren),
          ),
        );
      }

      var button = h(
        'button',
        {
          type: 'button',
          className: 'pw-strip',
          'data-tone': off ? 'off' : 'peak',
          'data-wide': wide ? '1' : '0',
          title: title,
          'aria-label': title,
          'aria-expanded': open,
          onClick: function () {
            // 打开详情时顺手刷新一次：详情页要的是「现在」的余额
            if (!open) refreshWallet();
            setOpen(!open);
          },
        },
        ...body,
      );

      if (!open) return button;

      // 模式切换只在设置页里做（v0.4.0 起浮层顶部不再摆开关）。
      return h(
        react.Fragment,
        null,
        button,
        h(
          'div',
          {
            className: 'pw-backdrop',
            onClick: function () {
              setOpen(false);
            },
          },
          h(
            'div',
            {
              className: 'pw-pop',
              role: 'dialog',
              'aria-label': 'DeepSeek 峰谷计价详情',
              onClick: function (event) {
                event.stopPropagation();
              },
            },
            details(now, s, desc, wallet, mode, function () {
              setOpen(false);
            }),
          ),
        ),
      );
    }

    // ============================================================================
    //  鲸鱼娘桌宠（全屏浮层）
    // ============================================================================
    /** 她的"家"：出生位置，也是菜单「回家」的目标。 */
    var HOME_X = 110;
    /** 首次开口前先安静一会儿。 */
    var GREET_DELAY_MS = 9000;
    /** 自动念台词的间隔区间（大多数是价格台词）。 */
    var SPEECH_MIN_MS = 75000;
    var SPEECH_MAX_MS = 150000;
    /** 台词逐字揭示的节奏，以及说完后的停留。 */
    var SPEECH_CHAR_MS = 70;
    var SPEECH_HOLD_MS = 1700;
    /** 亲密度存储键；每 5 次互动升一级，10 级封顶。 */
    var AFFINITY_KEY = 'dsh-peak-whale.affinity.v1';
    var PETS_PER_LEVEL = 5;
    var MAX_LEVEL = 10;
    /** 音效开关的存储键（createSfx 读它，值为 'off' 即静音）。 */
    var SOUND_KEY = 'dsh-peak-whale.sound.v1';
    /** 窗口很高时别让她长得太大。 */
    var PET_SCALE_MAX = 0.6;
    /** 菜单「换个姿势」的候选：去掉 walk / run —— 那是自由漫游自己会做的事。 */
    var POSE_MOTIONS = (
      PET && PET.MOTIONS ? PET.MOTIONS : ['jump', 'hop', 'look', 'turn', 'nod', 'shake', 'spin', 'sit', 'sleep', 'dizzy', 'stand']
    ).filter(function (m) {
      return m !== 'walk' && m !== 'run';
    });

    /** 互动次数 → 亲密度等级（纯函数，便于测试）。 */
    function affinityLevel(pets) {
      var n = typeof pets === 'number' && pets > 0 ? Math.floor(pets) : 0;
      return Math.min(MAX_LEVEL, 1 + Math.floor(n / PETS_PER_LEVEL));
    }

    /** 从 storage 读亲密度（storage 以参数传入，便于测试；读取失败一律当 0）。 */
    function loadAffinity(storage) {
      try {
        if (!storage || typeof storage.getItem !== 'function') return 0;
        var raw = storage.getItem(AFFINITY_KEY);
        if (!raw) return 0;
        var parsed = JSON.parse(raw);
        var pets = parsed && typeof parsed.pets === 'number' ? parsed.pets : 0;
        return pets > 0 ? Math.floor(pets) : 0;
      } catch (error) {
        return 0;
      }
    }

    /** 写亲密度；隐私模式 / 配额满都会抛，一律吞掉（存不上不影响使用）。 */
    function saveAffinity(storage, pets) {
      try {
        if (!storage || typeof storage.setItem !== 'function') return false;
        storage.setItem(AFFINITY_KEY, JSON.stringify({ pets: pets, at: Date.now() }));
        return true;
      } catch (error) {
        return false;
      }
    }

    function WhaleRoamer() {
      // 可变 store + 手动重渲染：rAF 闭包永远读到最新值，不会踩 stale state。
      var store = react.useState(function () {
        var saved = loadAffinity(safeStorage());
        return {
          ready: false,
          pets: saved,
          level: affinityLevel(saved),
          menu: null,
          /** 提示词优化：进行中（拖投递后等上游返回） */
          busy: false,
          /**
           * 优化流程的气泡（**挂在小鲸鱼身上**，跟着她走）：
           *   busy  「正在优化提示词中…」（无按钮）
           *   done  询问是否撤销的对话框：√ 撤销 / × 保留（不设消失时间，一直等你选）
           *   error 失败原因 + 「知道了」，8 秒后自动收起
           */
          opt: null,
          /** 可撤销的原稿：{ el, original, optimized, since } */
          undo: null,
        };
      })[0];
      var counter = react.useState(0);
      var draw = counter[1];
      var api = react.useState(function () {
        return {
          store: store,
          commit: null,
          ctl: null,
          pointOf: null,
          startSpeech: null,
          /** 最近一次打字的文本框：拖她过来时往哪儿投递就看它 */
          composer: null,
          /** 按下时的指针状态 `{x, y, moved}` —— 用来区分「拖动」和「点一下」 */
          press: null,
          /** 投递之后让她离开文本框区域的截止时刻（打字回避那套逻辑复用） */
          avoidUntil: 0,
        };
      })[0];
      var stageRef = react.useRef(null);
      var petRef = react.useRef(null);
      var shadowRef = react.useRef(null);
      var fxRef = react.useRef(null);
      var hitRef = react.useRef(null);
      var bubbleRef = react.useRef(null);
      /** 优化气泡的 DOM：位置每帧钉在小鲸鱼头顶（拖着她跑时气泡跟着走）。 */
      var optRef = react.useRef(null);

      function commit(patch) {
        for (var key in patch) {
          if (Object.prototype.hasOwnProperty.call(patch, key)) store[key] = patch[key];
        }
        draw(function (n) {
          return (n + 1) % 1000000;
        });
      }
      api.commit = commit;
      // 测试 / 二次开发钩子：真正的 api 对象（commit、ctl、store、undoOptimize…）。
      // UI 状态全靠 commit 驱动，所以从这里能断言整条「投递 → 优化 → 撤销」链路。
      exports.__whaleApi = api;

      /** 她身上发生的每一次互动（拎起/放下/抛出/戳/摸）都会调这里。 */
      function bumpAffinity(n) {
        var pets = store.pets + (n || 1);
        var level = affinityLevel(pets);
        var leveledUp = level > store.level;
        saveAffinity(safeStorage(), pets);
        commit({ pets: pets, level: level });
        if (leveledUp && api.startSpeech) api.startSpeech('亲密度升到 Lv.' + level + ' 了！');
      }

      function localPoint(event) {
        return api.pointOf ? api.pointOf(event) : { x: event.clientX, y: event.clientY };
      }

      /**
       * 这次投递该往哪个文本框去：聚焦的 → 最近打字的那个 → 页面上最大的可见文本框。
       *
       * 第三条兜底是给「插件加载之前你就已经写好提示词了」这种情况：那会儿
       * `api.composer` 还是空的，靠焦点也找不回来，就按大小猜底部那个大框。
       */
      function findComposer() {
        try {
          const focused = editableAncestor(typeof document !== 'undefined' ? document.activeElement : null);
          if (focused) return focused;
        } catch (error) { /* 继续往下找 */ }
        if (api.composer && api.composer.isConnected !== false) return api.composer;
        try {
          if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return null;
          const nodes = document.querySelectorAll('textarea, input, [contenteditable]');
          let best = null;
          let bestArea = 0;
          for (let i = 0; i < nodes.length; i += 1) {
            const el = nodes[i];
            if (!isEditable(el)) continue;
            const r = el.getBoundingClientRect();
            const area = Math.max(0, r.right - r.left) * Math.max(0, r.bottom - r.top);
            if (area > bestArea) {
              best = el;
              bestArea = area;
            }
          }
          return best;
        } catch (error) {
          return null;
        }
      }

      /**
       * 投递：读原文 → 打 Host 的优化路由 → 成功就写回、留一份原稿可撤销。
       * 整个流程的气泡都**挂在小鲸鱼身上**（拖着她跑气泡跟着走）：
       *   busy  → 「正在优化提示词中…」（无按钮，完成即收）
       *   成功  → 「需要撤销吗？」√ / × 对话框（不设消失时间）
       *   失败  → 失败原因 + 「知道了」，8 秒后自动收起
       */
      api.deliverToComposer = function (box) {
        if (!box || store.busy) return;
        const text = readComposer(box);
        if (text.trim() === '') {
          if (api.startSpeech) api.startSpeech('框里还没有提示词呀～先写一点？');
          return;
        }
        commit({
          busy: true,
          undo: null,
          opt: { kind: 'busy', text: '正在优化提示词中…' },
        });
        // busy 气泡本身就是提示，不再抢话——两个气泡叠一起会打架。
        optimizePrompt(text).then(function (result) {
          if (result && result.ok && typeof result.optimized === 'string' && result.optimized !== '') {
            writeComposer(box, result.optimized);
            commit({
              busy: false,
              undo: { el: box, original: text, optimized: result.optimized, since: Date.now() },
              opt: {
                kind: 'done',
                text: result.cached ? '提示词优化好了（复用上次结果）' : '提示词优化好了',
                ask: '需要撤销这次优化吗？',
                // 不设消失时间：这个询问是**优化完成之后**才弹出来的，你不选它就一直在，
                // 绝不会在你还没看清时就自己收起来（√ 换回原文 / × 保留）。
                until: 0,
              },
            });
          } else {
            const message = (result && result.message) || '优化失败了';
            commit({
              busy: false,
              undo: null,
              opt: { kind: 'error', text: message, until: Date.now() + 8000 },
            });
          }
        });
      };

      /** 撤销：把原稿写回去，气泡一起收掉。 */
      api.undoOptimize = function () {
        const undo = store.undo;
        if (!undo) return;
        writeComposer(undo.el, undo.original);
        commit({ undo: null, opt: null, busy: false });
        if (api.startSpeech) api.startSpeech('撤销了，还是你原来那版～');
      };

      /** 关掉优化气泡（√ 撤销 / × 保留 / 「知道了」都会走到这）。 */
      api.dismissOpt = function () {
        if (store.opt) commit({ opt: null });
      };

      // ── 指针接线：全部转发给 pet-core，它自己判断命中与动作 ──────────────
      api.onPointerDown = function (event) {
        var ctl = api.ctl;
        if (!ctl || !event) return;
        if (event.button !== undefined && event.button !== 0) return;
        var hit = false;
        try {
          hit = ctl.pointerDown(localPoint(event));
        } catch (error) {
          hit = false;
        }
        if (hit) {
          // 记下按下点：松手时靠它区分「拖过来的」还是「点一下」
          api.press = { x: event.clientX, y: event.clientY, moved: false };
          try {
            if (event.currentTarget && event.currentTarget.setPointerCapture && event.pointerId !== undefined) {
              event.currentTarget.setPointerCapture(event.pointerId);
            }
          } catch (error) { /* 捕获失败不影响拖动 */ }
        }
        if (event.preventDefault) event.preventDefault();
      };

      api.onPointerUp = function (event) {
        var ctl = api.ctl;
        if (!ctl) return;
        var press = api.press;
        api.press = null;
        // ── 投递判定：确实拖动过 + 松手点落在文本框上 → 就地放下 + 优化 ──────
        // 「就地放下」用的是 pet-core 自带的 `dropAt()`（官方注释：no throw），
        // 所以她不会被甩飞出去——原样保留 vendor，不改上游一行。
        if (press && press.moved && event && typeof event.clientX === 'number') {
          const box = findComposer();
          const zone = box ? dropZone(box) : null;
          if (zone && pointInRect({ x: event.clientX, y: event.clientY }, zone)
            && typeof ctl.dropAt === 'function' && ctl.pressing) {
            try {
              ctl.dropAt(localPoint(event));
              api.avoidUntil = Date.now() + 6000; // 站住别挡着你，先让开
              api.deliverToComposer(box);
            } catch (error) {
              try {
                ctl.pointerUp();
              } catch (error2) { /* 忽略 */ }
            }
            return;
          }
        }
        try {
          ctl.pointerUp();
        } catch (error) { /* 忽略 */ }
      };

      api.onPointerLeave = function () {
        var ctl = api.ctl;
        if (!ctl || ctl.pressing) return; // 拖动中不要标记"离开"
        try {
          ctl.pointerLeave();
        } catch (error) { /* 忽略 */ }
      };

      api.closeMenu = function () {
        if (store.menu) commit({ menu: null });
      };

      api.onContextMenuClose = function (event) {
        if (event && event.preventDefault) event.preventDefault();
        api.closeMenu();
      };

      api.onContextMenu = function (event) {
        if (!event) return;
        if (event.preventDefault) event.preventDefault();
        if (event.stopPropagation) event.stopPropagation();
        var menuW = 190;
        var menuH = 280; // 7 项 + 亲密度头 + 分隔线
        commit({
          menu: {
            x: Math.round(Math.max(8, Math.min(event.clientX, window.innerWidth - menuW))),
            y: Math.round(Math.max(8, Math.min(event.clientY, window.innerHeight - menuH))),
          },
        });
      };

      api.menuAction = function (kind) {
        commit({ menu: null });
        var ctl = api.ctl;
        var lines = roamLines(new Date());
        if (kind === 'action') {
          if (!ctl) return;
          ctl.holdRoam(5);
          ctl.act(pickOne(POSE_MOTIONS));
        } else if (kind === 'pet') {
          if (!ctl) return;
          ctl.holdRoam(4);
          ctl.setExpr('love', 2.5);
          bumpAffinity(1);
        } else if (kind === 'say') {
          if (api.startSpeech) api.startSpeech(pickOne(lines.price));
        } else if (kind === 'quiet') {
          if (!ctl) return;
          ctl.setRoam('off');
          ctl.act('sit');
          if (api.startSpeech) api.startSpeech('好…我安静一会儿');
        } else if (kind === 'roam') {
          if (!ctl) return;
          ctl.setRoam('free');
          if (api.startSpeech) api.startSpeech(pickOne(lines.greet));
        } else if (kind === 'home') {
          if (!ctl) return;
          ctl.holdRoam(3);
          ctl.walkTo(HOME_X, false);
        } else if (kind === 'undo') {
          // 胶囊已经被你改字/超时收掉了也还能撤 —— 原稿一直留着
          api.undoOptimize();
        }
      };

      react.useEffect(function () {
        var alive = true;
        var ctl = null;
        var figure = null;
        var raf = 0;
        var last = 0;
        var warned = false;
        var speech = null;
        var nextSpeechAt = 0;
        var unlockSfx = null;
        var onResize = null;
        var stageEl = stageRef.current;
        var petEl = petRef.current;
        var shadowEl = shadowRef.current;
        var fxEl = fxRef.current;
        var hitEl = hitRef.current;
        var bubbleEl = bubbleRef.current;
        if (!stageEl || !petEl || !hitEl || !bubbleEl) return undefined;

        api.pointOf = function (event) {
          var rect = stageEl.getBoundingClientRect();
          return { x: event.clientX - rect.left, y: event.clientY - rect.top };
        };

        api.startSpeech = function (text) {
          if (!text) return;
          speech = { text: text, i: 0, nextAt: 0 };
        };

        // ── 打字回避：判定在模块级的 escapePlan 里（可单测），这里只负责驱动 ──
        /** 「正在打字」的截止时刻；最近打字的文本框存在 `api.composer`（组件体的投递逻辑也读它）。 */
        var typingUntil = 0;
        /** 每帧从 layout() 存下来的身体矩形，回避判定直接读它，不多做一次布局读取。 */
        var lastPetRect = null;
        /** 上一次下达的走位目标：目标没变就绝不重复 walkTo（否则步态会被重置成原地踏步）。 */
        var escape = { target: null };

        /** 当前回避区：优先正在聚焦的文本框，其次最近打字的那个。 */
        function activeZone() {
          var focused = typeof document !== 'undefined' ? document.activeElement : null;
          return editableZone(editableAncestor(focused) || api.composer);
        }

        /** 打字（含把焦点点进文本框）就续上回避窗口；只读事件，不 preventDefault。 */
        function onTyping(event) {
          var box = editableAncestor(event && event.target !== undefined ? event.target : null);
          if (box) api.composer = box;
          var focused = typeof document !== 'undefined' ? document.activeElement : null;
          if (box || editableAncestor(focused)) {
            typingUntil = Date.now() + TYPING_GRACE_MS;
          }
        }

        /** 焦点离开文本框只再宽限一小会儿，别让她对着空框傻等三秒。 */
        function onFocusOut(event) {
          if (editableAncestor(event && event.target)) {
            typingUntil = Math.min(typingUntil, Date.now() + 600);
          }
        }

        var canListen = typeof document !== 'undefined' && typeof document.addEventListener === 'function';
        if (canListen) {
          document.addEventListener('keydown', onTyping, true);
          document.addEventListener('input', onTyping, true);
          document.addEventListener('focusin', onTyping, true);
          document.addEventListener('focusout', onFocusOut, true);
        }

        /** 逐字揭示台词；每揭示一个字就调一次 ctl.talk()，她的嘴会跟着动。 */
        function speak(now) {
          if (!speech) {
            if (nextSpeechAt && now >= nextSpeechAt) {
              // 优化气泡 / 撤销对话框在位时不自动抢台词（两个气泡会叠一起）
              if (!store.opt) {
                var lines = roamLines(new Date());
                api.startSpeech(Math.random() < 0.75 ? pickOne(lines.price) : pickOne(lines.idle));
              }
              nextSpeechAt = now + SPEECH_MIN_MS + Math.random() * (SPEECH_MAX_MS - SPEECH_MIN_MS);
            }
            return;
          }
          if (now < speech.nextAt) return;
          if (speech.i < speech.text.length) {
            speech.i += 1;
            if (ctl) ctl.talk();
            bubbleEl.hidden = false;
            bubbleEl.textContent = speech.text.slice(0, speech.i);
            speech.nextAt = now + SPEECH_CHAR_MS;
          } else if (now > speech.nextAt + SPEECH_HOLD_MS) {
            bubbleEl.hidden = true;
            bubbleEl.textContent = '';
            speech = null;
          }
        }

        /** 命中区贴住她的身体；气泡钉在头顶。每帧直接改 DOM，不走 React 状态。 */
        function layout() {
          if (!ctl) return;
          var r = petEl.getBoundingClientRect();
          lastPetRect = r; // 打字回避的判定直接用这一份（同一帧的同一矩形）
          var s = stageEl.getBoundingClientRect();
          hitEl.style.left = (r.left - s.left) + 'px';
          hitEl.style.top = (r.top - s.top) + 'px';
          hitEl.style.width = Math.max(0, r.width) + 'px';
          hitEl.style.height = Math.max(0, r.height) + 'px';
          if (!bubbleEl.hidden) {
            var a = ctl.anchor();
            bubbleEl.style.left = a.x + 'px';
            // 优化气泡在位时，台词气泡往上挪一挪，两个别叠一起
            bubbleEl.style.top = (store.opt ? a.y - 56 : a.y) + 'px';
          }
          // 优化气泡钉在小鲸鱼头顶：拖着她跑的时候，气泡跟着她走
          if (optRef.current && store.opt) {
            var a2 = ctl.anchor();
            optRef.current.style.left = a2.x + 'px';
            optRef.current.style.top = a2.y + 'px';
          }
          // 你自己改过提示词 → 撤销就该自己收起来：绝不能拿旧稿盖掉你的新输入
          if (store.undo && shouldDismissUndo(store.undo, readComposer(store.undo.el), Date.now())) {
            commit({ undo: null, opt: null });
          }
          // 到期自动收起：只剩失败说明（8 秒）。撤销询问**不设消失时间**，一直等你选。
          if (store.opt && store.opt.until && Date.now() > store.opt.until) {
            commit({ opt: null });
          }
        }

        /**
         * 你打字时（以及刚把她投递进文本框之后），她离开文本框区域 ——
         * 无论她此刻在屏幕哪个位置。
         *
         * 每帧三步：
         *   1. 期间持续 `holdRoam`：自由漫游（`decide()`）不会把她重新派回这里，
         *      她会让开后待在原地；
         *   2. 取回避区（聚焦的文本框，连它所在卡片的余量一起算）；
         *   3. **不挡路就什么都不做**；挡路才 `walkTo`，而且只在目标真的变了才下令
         *      —— 每帧重复 walkTo 会把步态重置成原地踏步，她反而走不动。
         *
         * 第二个触发条件 `api.avoidUntil` 来自投递：她被放进文本框时刚点了「让开」，
         * 那会儿你多半还没把焦点点回去，只看打字状态会让她就站在框上。
         */
        function avoidWhileTyping() {
          if (!ctl) return;
          var focused = typeof document !== 'undefined' ? document.activeElement : null;
          var now = Date.now();
          var active = typingActive(editableAncestor(focused), typingUntil, now)
            || now < (api.avoidUntil || 0);
          if (!active) {
            escape.target = null;
            return;
          }
          ctl.holdRoam(0.5);
          var target = escapePlan(lastPetRect, activeZone(), window.innerWidth);
          if (target === null) {
            escape.target = null;
            return;
          }
          if (escape.target !== null && Math.abs(target - escape.target) <= AVOID_TARGET_TOLERANCE) return;
          var center = lastPetRect ? (lastPetRect.left + lastPetRect.right) / 2 : target;
          // 远了就跑过去：走的 78px/s 太慢，你一句话打完她还没让开。
          if (ctl.walkTo(target, Math.abs(target - center) > AVOID_RUN_DISTANCE)) {
            escape.target = target;
          }
        }

        function loop(now) {
          raf = 0;
          if (!alive || !ctl) return;
          if (!last) last = now;
          var dt = Math.min(0.05, Math.max(0.001, (now - last) / 1000));
          last = now;
          try {
            ctl.step(dt);
            ctl.render();
            layout();
            avoidWhileTyping();
            speak(now);
          } catch (error) {
            if (!warned) {
              warned = true;
              console.warn('[peak-whale] 桌宠渲染循环出错（只报一次）:', error);
            }
          }
          raf = window.requestAnimationFrame(loop);
        }

        /**
         * 鼠标在页面上任何地方移动都要喂给 pet-core：
         * 她的视线会跟着光标转，而且拖动时（指针已被命中区捕获）也能持续拿到位置。
         * 只挂在命中区上会让"跟着鼠标看"只在碰到她时才生效。
         */
        function onPointerMove(event) {
          if (!ctl) return;
          // 拖动阈值与 pet-core 一致（>6px 才算 drag）：松手时靠它判断是不是「拖过来的」
          if (api.press && typeof event.clientX === 'number') {
            if (Math.abs(event.clientX - api.press.x) > 6 || Math.abs(event.clientY - api.press.y) > 6) {
              api.press.moved = true;
            }
          }
          var cursor = '';
          try {
            cursor = ctl.pointerMove(api.pointOf(event)) || '';
          } catch (error) { /* 忽略 */ }
          if (hitEl) hitEl.style.cursor = cursor;
        }

        (async function init() {
          try {
            figure = await PET.createWhaleFigure('pet:///', {
              model: PET_MODEL,
              asset: function (p) {
                return PET_TEX[p];
              },
            });
            if (!alive) {
              if (figure && figure.dispose) figure.dispose();
              return;
            }
            var sfx = PET.createSfx({ storageKey: SOUND_KEY });
            unlockSfx = function () {
              if (sfx && typeof sfx.unlock === 'function') sfx.unlock();
            };
            ctl = PET.createPet(
              { petG: petEl, shadowEl: shadowEl, fxG: fxEl },
              {
                sfx: sfx,
                figure: figure,
                roam: 'free',
                enter: 'drop',
                startX: HOME_X,
                bounds: function () {
                  var w = window.innerWidth;
                  var h = window.innerHeight;
                  return {
                    W: w,
                    H: h,
                    floorY: h - 26,
                    S: Math.min(PET_SCALE_MAX, 0.42 * Math.min(1.4, h / 420)),
                  };
                },
                onEvent: function (kind) {
                  // 一切发生在身体上的事（拎起 / 放下 / 抛出 / 戳 / 摸 / 摔晕）都算互动
                  if (kind === 'touch') bumpAffinity(1);
                },
              },
            );
            api.ctl = ctl;
            // 浏览器要求先有用户手势才允许出声；捕获阶段挂，任何点击都能解锁
            window.addEventListener('pointerdown', unlockSfx, true);
            window.addEventListener('keydown', unlockSfx, true);
            window.addEventListener('pointermove', onPointerMove, { passive: true });
            onResize = function () {
              try {
                if (ctl) ctl.resize();
              } catch (error) { /* 忽略 */ }
            };
            window.addEventListener('resize', onResize);
            nextSpeechAt = performance.now() + GREET_DELAY_MS;
            last = 0;
            if (typeof window.requestAnimationFrame === 'function') {
              raf = window.requestAnimationFrame(loop);
            }
            commit({ ready: true });
          } catch (error) {
            if (alive) {
              commit({ ready: false });
              console.warn('[peak-whale] 鲸鱼娘初始化失败（此环境可能没有 WebGL2 / Image）:', error);
            }
          }
        })();

        return function () {
          alive = false;
          api.ctl = null;
          api.startSpeech = null;
          if (raf && typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(raf);
          if (onResize) window.removeEventListener('resize', onResize);
          window.removeEventListener('pointermove', onPointerMove);
          if (canListen) {
            document.removeEventListener('keydown', onTyping, true);
            document.removeEventListener('input', onTyping, true);
            document.removeEventListener('focusin', onTyping, true);
            document.removeEventListener('focusout', onFocusOut, true);
          }
          if (unlockSfx) {
            window.removeEventListener('pointerdown', unlockSfx, true);
            window.removeEventListener('keydown', unlockSfx, true);
          }
          // setFigure(null) 会释放自定义 figure 持有的 WebGL 上下文。
          // Chromium 每页的上下文数量有上限（约 16 个），HMR 反复重载时泄漏会
          // 让画布整片变空白——所以卸载时必须显式释放。
          try {
            if (ctl) ctl.setFigure(null);
            else if (figure && figure.dispose) figure.dispose();
          } catch (error) { /* 忽略 */ }
        };
      }, []);

      // 右键菜单：点空白处关闭
      var menu = null;
      if (store.menu) {
        var item = function (kind, text) {
          return h(
            'button',
            {
              key: kind,
              type: 'button',
              onClick: function () {
                api.menuAction(kind);
              },
            },
            text,
          );
        };
        menu = h(
          'div',
          {
            className: 'pw-menu-backdrop',
            onClick: api.closeMenu,
            onContextMenu: api.onContextMenuClose,
          },
          h(
            'div',
            {
              className: 'pw-menu',
              role: 'menu',
              style: { left: store.menu.x + 'px', top: store.menu.y + 'px' },
              onClick: function (event) {
                if (event && event.stopPropagation) event.stopPropagation();
              },
            },
            h(
              'div',
              { className: 'pw-menu-note' },
              '亲密度 Lv.' + store.level + ' · 互动 ' + store.pets + ' 次',
            ),
            h('hr'),
            item('action', '换个姿势'),
            item('pet', '摸摸头'),
            item('say', '念句价格'),
            item('home', '回家'),
            h('hr'),
            item('quiet', '安静一会儿'),
            item('roam', '自由活动'),
            store.undo ? h('hr', { key: 'hr2' }) : null,
            store.undo ? item('undo', '撤销提示词优化') : null,
          ),
        );
      }

      // ── 优化胶囊：贴在文本框上方，是这块浮层里唯一会自己挪窝的 UI ──────────
      // ── 优化气泡 / 撤销对话框：挂在小鲸鱼头顶，位置每帧由 rAF 钉着 ──────────
      // busy：一句「正在优化提示词中…」；done：√/× 撤销询问（不设消失时间）；error：原因 + 知道了。
      // 拖着她跑的时候，这个气泡跟她的头顶一起走（layout() 里每帧对齐 anchor）。
      var optEl = null;
      if (store.opt) {
        var optKind = store.opt.kind;
        optEl = h(
          'div',
          {
            className: 'pw-opt',
            'data-kind': optKind,
            ref: optRef,
            role: optKind === 'done' ? 'dialog' : 'status',
            'aria-label': optKind === 'done' ? '是否撤销提示词优化' : store.opt.text,
            onClick: function (event) {
              // 气泡自己不吞点击语义，但别让它一路冒泡到浮层
              if (event && event.stopPropagation) event.stopPropagation();
            },
          },
          h('span', { className: 'pw-opt-text' }, store.opt.text),
          optKind === 'done'
            ? h('span', { className: 'pw-opt-ask' }, store.opt.ask)
            : null,
          optKind === 'done'
            ? h(
                'span',
                { className: 'pw-opt-actions' },
                h('button', { key: 'yes', type: 'button', className: 'pw-opt-yes', title: '撤销，换回原文', onClick: api.undoOptimize }, '√'),
                h('button', { key: 'no', type: 'button', className: 'pw-opt-no', title: '保留优化结果', onClick: api.dismissOpt }, '×'),
              )
            : null,
          optKind === 'error'
            ? h('button', { key: 'close', type: 'button', className: 'pw-opt-close', onClick: api.dismissOpt }, '知道了')
            : null,
        );
      }

      return h(
        'div',
        { className: 'pw-roam', 'data-ready': store.ready ? '1' : '0' },
        h(
          'svg',
          { className: 'pw-stage', ref: stageRef, 'aria-hidden': 'true' },
          h('ellipse', { className: 'pw-shadow', ref: shadowRef }),
          // pet-core 会往这两个组里写 DOM（foreignObject 画布 / 特效），
          // 我们不渲染子节点，所以 React 不会去动它们。
          h('g', { className: 'pw-pet', ref: petRef }),
          h('g', { className: 'pw-fx', ref: fxRef }),
        ),
        h('div', {
          className: 'pw-hitbox',
          ref: hitRef,
          onPointerDown: api.onPointerDown,
          onPointerUp: api.onPointerUp,
          onPointerCancel: api.onPointerUp,
          onPointerLeave: api.onPointerLeave,
          onContextMenu: api.onContextMenu,
        }),
        h('div', { className: 'pw-bubble', ref: bubbleRef, hidden: true }),
        optEl,
        menu,
      );
    }

    // ============================================================================
    //  设置页（设置 → 插件 → 小鲸鱼）
    // ============================================================================
    /** 详情页模式的说明文案。 */
    var UI_MODES = [
      { id: 'detailed', name: '详细版', note: '完整价格表、时段规则与节假日说明。' },
      { id: 'concise', name: '简洁版', note: '只显示余额、今日费用与当前峰谷及持续时间。' },
    ];

    /**
     * 设置页 tab 组件。注册进 `settings.plugins.tab` 槽位，
     * 由内置的「插件」设置页渲染成「小鲸鱼」标签页。
     *
     * 契约要点（与 dsh-client-ui-settings-plugin-inventory 一致）：
     *   slots.inject("settings.plugins.tab", () => slots.register({ name, id, order, label }, 组件))
     * 数据走自己的 HTTP 设置路由；API key 只留在 Host，这里只看得到「是否已配置」。
     */
    function PeakWhaleSettingsTab() {
      var ui = useUiSettings();
      var savingState = react.useState(false);
      var setSaving = savingState[1];
      var errorState = react.useState('');
      var setError = errorState[1];
      var error = errorState[0];
      var mode = ui && ui.uiMode === 'detailed' ? 'detailed' : 'concise';

      /** 乐观更新 + 写回 Host；失败亮出来（下一轮 wallet 轮询会用 Host 的值纠正显示）。 */
      var applyPatch = function (patch) {
        setSaving(true);
        setError('');
        publishUiSettings(patch); // 界面立即生效
        saveUiSettings(patch).then(function (ok) {
          setSaving(false);
          if (!ok) setError('设置保存失败——Host 半身可能还是旧版，重启 DSH 或稍后重试。');
        });
      };

      var modeBtn = function (item) {
        var active = mode === item.id;
        return h(
          'label',
          { key: item.id, className: 'pw-set-mode' + (active ? ' is-on' : '') },
          h('input', {
            type: 'radio',
            name: 'pw-ui-mode',
            checked: active,
            onChange: function () {
              if (!active) applyPatch({ uiMode: item.id });
            },
          }),
          h('span', { className: 'pw-set-mode-name' }, item.name),
          h('span', { className: 'pw-set-mode-note' }, item.note),
        );
      };

      return h(
        'div',
        { className: 'pw-settings' },
        h(
          'div',
          { className: 'pw-settings-head' },
          h('h3', null, '小鲸鱼（DeepSeek 峰谷计价）'),
          h('p', { className: 'pw-dim' }, '侧栏价格状态条 + 桌宠小鲸鱼娘。所有设置即时生效并保存在本机。'),
        ),

        h(
          'section',
          { className: 'pw-set-sec' },
          h('h4', null, '详情页模式'),
          h('div', { className: 'pw-set-modes' }, UI_MODES.map(modeBtn)),
        ),

        h(
          'section',
          { className: 'pw-set-sec' },
          h('h4', null, '提示词优化'),
          h(
            'label',
            { className: 'pw-set-switch' },
            h('input', {
              type: 'checkbox',
              checked: !!(ui && ui.optimizeEnabled),
              onChange: function (event) {
                applyPatch({ optimizeEnabled: event.target.checked === true });
              },
            }),
            '把鲸鱼娘拖到输入框上时，自动用你的 DeepSeek API key 优化提示词',
          ),
          ui && ui.apiKeyConfigured
            ? h('p', { className: 'pw-dim' }, 'API key：已配置 ✓（key 只存在本机，不会显示在页面里）')
            : h('p', { className: 'pw-dim' }, 'API key：还没配置——把 key 填进 ~/.dsh/peak-whale/settings.json 的 deepseekApiKey 后即可使用。'),
        ),

        h(
          'section',
          { className: 'pw-set-sec' },
          h('h4', null, '帮助 / 使用说明'),
          h(
            'ul',
            { className: 'pw-set-help' },
            h('li', null, '侧栏底部：当前峰 / 谷时段与距切换倒计时；侧栏够宽时还显示「余额 · 今日费用」，点击展开详情。'),
            h('li', null, '详情浮层：顶部开关切换「简洁版 / 详细版」——简洁版只留余额、今日费用、当前档与持续时间。'),
            h('li', null, '小鲸鱼娘：点击、抚摸、拖动互动；右键菜单可换姿势、念价格、安静一会儿、自由活动、回家。'),
            h('li', null, '把鲸鱼娘拖到输入框上 = 优化提示词。优化完成后她会问是否撤销（√ 换回原文 / × 保留），不设时限、一直等你选；期间仍可拖动她，气泡会跟着走。'),
            h('li', null, '「今日费用」是按官方牌价折算会话用量得出的估算，不含赠送抵扣，不是账单。'),
            h('li', null, '余额与登录态来自 DeepSeek 账户服务；查不到时详情页会写明原因。'),
          ),
        ),

        savingState[0] ? h('p', { className: 'pw-set-state' }, '保存中…') : null,
        error ? h('p', { className: 'pw-set-state pw-set-error' }, error) : null,
      );
    }

    // ============================================================================
    //  注册
    // ============================================================================
    /** 幂等：装样式的一步炸了会走直装兜底，重复调用不能插出第二份样式表。 */
    var stylesInstalled = false;
    function installStyles() {
      if (stylesInstalled) return function () {};
      stylesInstalled = true;
      var style = document.createElement('style');
      style.setAttribute('data-plugin', 'dsh-deepseek-peak-whale');
      style.textContent = CSS;
      document.head.appendChild(style);
      return function () {
        stylesInstalled = false;
        style.remove();
      };
    }

    var inject = ['slots'];

    /**
     * 把三个挂载点都注册上。`slots` 还没就绪就返回 false，交给 inject / 退避重试。
     * 拆出来是为了让「立即试 / inject 回调 / 迟到重试」三条路共用同一份注册代码。
     */
    function mountSlots(ctx) {
      var slots = ctx && typeof ctx.get === 'function' ? ctx.get('slots') : undefined;
      if (!slots && ctx) slots = ctx.slots;
      if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') {
        return false;
      }

      var label = function () {
        try {
          return periodAt(new Date()).isPeak ? '峰时（全价）' : '谷时（半价）';
        } catch (error) {
          return 'DeepSeek 峰谷计价';
        }
      };

      slots.inject(STRIP_SLOT, function () {
        return slots.register(
          { name: STRIP_SLOT, id: 'peak-whale', order: STRIP_ORDER, label: label },
          PeakWhaleStrip,
        );
      });

      slots.inject(ROAM_SLOT, function () {
        return slots.register(
          { name: ROAM_SLOT, id: 'peak-whale-critter', order: ROAM_ORDER, label: label },
          WhaleRoamer,
        );
      });

      // 设置页 tab：内置「插件」设置页会把我们渲染成「小鲸鱼」标签页。
      // 契约与 dsh-client-ui-settings-plugin-inventory 一致；label 用函数即可，
      // 不需要注册 locale（settings 外壳用 resolveSlotLabel 处理）。
      slots.inject('settings.plugins.tab', function () {
        return slots.register(
          { name: 'settings.plugins.tab', id: 'peak-whale', order: 60, label: function () { return '小鲸鱼'; } },
          PeakWhaleSettingsTab,
        );
      });

      pwBeacon('mounted', 'strip+roam+settings-tab 已注册');
      return true;
    }

    /**
     * 开机自启的关键一步。
     *
     * 老写法是「拿不到 slots 就 console.warn 然后 return」——看着安全，其实是**静默放弃**：
     * 客户端 `slots` 服务有时比本插件晚就绪，于是重启后小鲸鱼根本不出现，
     * 得去插件页把插件关掉再打开（重新挂载）才出来。真机上就是这么表现的。
     *
     * 现在三层保证：① 立即试一次；② `ctx.inject(['slots'], …)` 服务就绪才回调；
     * ③ 退避重试兜底（inject 不回调也能补上）。三条路共用 mounted 闸门，不会重复注册。
     */
    function apply(ctx) {
      try {
        /** 把当下的上下文能力写成一行短诊断（开机竞态排查全靠它）。 */
        var describe = function (target) {
          var t = target || {};
          var report = function (name) {
            try {
              return typeof t[name];
            } catch (error) {
              return 'throw';
            }
          };
          var slots = null;
          try {
            slots = typeof t.get === 'function' ? t.get('slots') : undefined;
            if (!slots) slots = t.slots;
          } catch (error) {
            slots = 'throw';
          }
          return 'get=' + report('get') + ' inject=' + report('inject') + ' effect=' + report('effect')
            + ' slots=' + (slots === 'throw' ? 'throw' : (slots ? (typeof slots.inject === 'function' && typeof slots.register === 'function' ? 'usable' : 'partial') : 'none'));
        };
        pwBeacon('apply-start', describe(ctx));

        // 记下 ctx：layout 改成「点击时按需解析」。
        // 老代码在 apply 里抓一次并缓存 —— 开机瞬间 layout 若还没注册，
        // `ctx.layout` 属性访问会抛，异常冒到外层 catch，三个挂载点**全都挂不上**。
        pluginCtx = ctx;

        // 以下两步都是「锦上添花」：各自 try，谁炸了都不许拦住挂载（见 pwStep 注释）。
        pwStep('styles', function () {
          if (ctx && typeof ctx.effect === 'function') {
            try {
              ctx.effect(installStyles, 'peak-whale: styles');
              return 'effect';
            } catch (error) {
              // effect 通道炸了就直装：样式装不上会让整个界面裸奔（无样式 = 不可用）
              pwBeacon('effect-threw', errText(error));
            }
          }
          installStyles();
          return 'direct';
        });
        pwBeacon('styles-done', 'installed=' + (stylesInstalled ? 'yes' : 'no'));

        // 探一次 layout 就绪度：这条打点是「开机时 layout 在不在」的直接证据。
        pwStep('layout-probe', function () {
          var probed = resolveLayout();
          pwBeacon('layout-probe', probed ? 'available' : 'missing');
          return probed;
        });

        var mounted = false;
        var tryMount = function (target) {
          if (mounted) return true;
          try {
            mounted = mountSlots(target || ctx) === true;
          } catch (error) {
            mounted = false;
            pwBeacon('mount-threw', (error && (error.message || error.name)) || String(error));
            if (typeof console !== 'undefined') console.warn('[peak-whale] 挂载失败:', error);
          }
          if (!mounted) pwBeacon('mount-failed', describe(target || ctx));
          return mounted;
        };

        if (tryMount(ctx)) return;

        if (ctx && typeof ctx.inject === 'function') {
          try {
            ctx.inject(['slots'], function (host) {
              pwBeacon('inject-callback', describe(host && host.slots ? host : ctx));
              tryMount(host && host.slots ? host : ctx);
            });
          } catch (error) {
            pwBeacon('inject-threw', (error && error.message) || String(error));
            if (typeof console !== 'undefined') console.warn('[peak-whale] inject([slots]) 不可用:', error);
          }
        }

        var delays = [120, 400, 1200, 3000, 8000, 20000];
        var step = 0;
        var retry = function () {
          if (tryMount(ctx) || step >= delays.length) return;
          var delay = delays[step];
          step += 1;
          pwBeacon('retry-scheduled', 'delay=' + delay + ' step=' + step);
          var setFn = ctx && typeof ctx.setTimeout === 'function'
            ? ctx.setTimeout
            : (typeof setTimeout === 'function' ? setTimeout : null);
          if (typeof setFn === 'function') {
            try {
              setFn(retry, delay);
            } catch { /* 没有定时器就到此为止 */ }
          } else {
            pwBeacon('no-timer', 'ctx.setTimeout 与全局 setTimeout 都不可用');
          }
        };
        retry();
      } catch (error) {
        // 这行打点是关键：apply 抛异常时，老版本只 console.warn，
        // Host 侧只看到「有 apply-start、没有 mounted」，查不出是哪一步炸的。
        pwBeacon('apply-threw', errText(error));
        if (typeof console !== 'undefined') {
          console.warn('[peak-whale] 客户端插件注册失败:', error);
        }
      }
    }

    exports.apply = apply;
    exports.inject = inject;
    // 供测试与二次开发使用（bundles 只读 apply/inject）
    exports.PeakWhaleStrip = PeakWhaleStrip;
    exports.WhaleRoamer = WhaleRoamer;
    exports.PeakWhaleSettingsTab = PeakWhaleSettingsTab;
    exports.details = details;
    exports.roamLines = roamLines;
    // 设置页（模式 / 开关）
    exports.SETTINGS_ROUTE = SETTINGS_ROUTE;
    exports.getUiSettings = function () {
      return uiSettingsState;
    };
    exports.publishUiSettings = publishUiSettings;
    exports.saveUiSettings = saveUiSettings;
    exports.UI_MODES = UI_MODES;
    // 账户钱包（余额 + 当日费用）
    exports.walletItems = walletItems;
    exports.walletSummary = walletSummary;
    exports.walletDetails = walletDetails;
    exports.setWalletState = publishWallet;
    exports.getWalletState = function () {
      return walletState;
    };
    exports.refreshWallet = refreshWallet;
    exports.subscribeWallet = subscribeWallet;
    exports.walletUrl = walletUrl;
    exports.WALLET_ROUTE = WALLET_ROUTE;
    exports.WALLET_POLL_MS = WALLET_POLL_MS;
    exports.periodAt = periodAt;
    exports.summary = summary;
    exports.describePeriod = describePeriod;
    exports.holidayAt = holidayAt;
    exports.affinityLevel = affinityLevel;
    // 「设置」按钮：面板跳转（测试可注入假 layout 服务）
    exports.openPluginsSettings = openPluginsSettings;
    exports.setLayoutService = function (next) {
      layoutOverride = next && typeof next.selectPanel === 'function' ? next : null;
    };
    // 打字回避（纯判定，供测试与二次开发）
    exports.isEditable = isEditable;
    exports.editableAncestor = editableAncestor;
    exports.editableZone = editableZone;
    exports.rectsOverlap = rectsOverlap;
    exports.escapeTargetX = escapeTargetX;
    exports.escapePlan = escapePlan;
    exports.typingActive = typingActive;
    // 提示词优化（拖投递 / 写回 / 撤销的纯逻辑）
    exports.readComposer = readComposer;
    exports.writeComposer = writeComposer;
    exports.dropZone = dropZone;
    exports.pointInRect = pointInRect;
    exports.shouldDismissUndo = shouldDismissUndo;
    exports.optimizePrompt = optimizePrompt;
    exports.OPTIMIZE_ROUTE = OPTIMIZE_ROUTE;
    exports.DROP_PAD = DROP_PAD;
    exports.UNDO_GRACE_MS = UNDO_GRACE_MS;
    exports.AVOID_MARGIN_X = AVOID_MARGIN_X;
    exports.AVOID_CLEARANCE = AVOID_CLEARANCE;
    exports.TYPING_GRACE_MS = TYPING_GRACE_MS;
    exports.loadAffinity = loadAffinity;
    exports.saveAffinity = saveAffinity;
    exports.safeStorage = safeStorage;
    exports.AFFINITY_KEY = AFFINITY_KEY;
    exports.SOUND_KEY = SOUND_KEY;
    exports.POSE_MOTIONS = POSE_MOTIONS;
    exports.HOME_X = HOME_X;
    exports.PET = PET;
    exports.PET_MODEL = PET_MODEL;
    exports.PET_TEX = PET_TEX;
    exports.WHALE_ICON_URI = WHALE_ICON_URI;
    exports.CSS = CSS;
    exports.MODELS = MODELS;
    exports.HOLIDAYS = HOLIDAYS;
    return module.exports;
  },
});
