# 小鲸鱼插件优化方案

## 状态

- ✅ 第一档（桌宠互动增强）—— 已完成并验收通过
- ✅ 第二档（多配色与状态反馈）—— 已完成并验收通过
- ✅ 第三档（技术优化）—— 已完成并验收通过

---

## 第一档：桌宠互动增强（已完成 ✅）

5 项全部落地，client.template.js 3878 → 4199 行。

| # | 优化项 | 代码位置 | 状态 |
|---|---|---|---|
| 1 | 撒爱心 | L2830-2834 菜单项 + action → emitHeart() + holdRoam(3) + bumpAffinity(1) | ✅ |
| 2 | 换表情 | L2836-2840 菜单项 + action → 循环 PET.EXPRESSIONS | ✅ |
| 3 | 亲密度显示 | L2176 affinityProgress() + L3828 设置页 section | ✅ |
| 4 | 拖拽反馈 | L202-203 CSS + L1776 NEAR_COMPOSER_PX + L2938 updateNearComposer() | ✅ |
| 5 | 活力度滑块 | L1773 MOOD_KEY + L2076 存档读取 + 设置页 range | ✅ |

## 第二档：多配色与状态反馈（已完成 ✅）

3 项全部落地。

| # | 优化项 | 代码位置 | 状态 |
|---|---|---|---|
| 6 | 配色切换 | WHALE_PALETTES（7套）+ applyPalette + Host 白名单 | ✅ |
| 7 | 倒计时增强 | nextCountdownText() + 状态条与详情统一 | ✅ |
| 8 | 状态反馈 | onTyping→setListening(true) / onFocusOut→setListening(false) / commit→setThinking | ✅ |

## 第三档：技术优化（已完成 ✅）

3 项全部落地。

| # | 优化项 | 结果 |
|---|---|---|
| 9 | 贴图 WebP 化 | ✅ pet-runtime.js 1.7MB → 492KB，client.js 2053KB → 775KB（降 62%） |
| 10 | 节假日表续期 | ✅ peak.js HOLIDAYS 从 7 条扩到 14 条（+2027 年 7 条） |
| 11 | 账单导出 | ✅ wallet.js 新增 exportLedgerCSV/exportLedgerJSON + index.js 新增 /api/wallet/export 路由 + client 新增「导出账单 CSV」按钮 |

### 第三档验收结果
- 构建: node build.mjs exit 0，产物 775 KB
- 测试: node test/run-all.mjs exit 0（10 套全绿）
- 部署: profile + local-packages 两处副本

### 附带修复
- bundle.test.mjs 截断修复（tech-opt 未完成的闭合）
- peak.test.mjs 节假日断言更新（7→14）
- wallet.test.mjs 路由断言更新（5→6 条路由）
