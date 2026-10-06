# 贡献指南

感谢你愿意参与小鲸鱼娘。

## 环境要求

- **Node.js ≥ 18**（用到 ESM、顶层 `await`、`node:test` 风格的断言脚本）
- **无需任何依赖**：`package.json` 里没有 `dependencies` / `devDependencies`，
  克隆下来就能直接跑构建和测试。

```bash
node --version   # >= v18
npm run build    # 生成 client.js
npm test         # 跑全部测试
```

## 动手之前

```bash
npm test   # 先确认是绿的
```

有两个测试对提交很重要，它们卡的是这个项目最容易被改坏的两条不变量：

| 测试 | 卡住什么 |
|---|---|
| `test/parity.test.mjs` | 浏览器半身内联的峰谷逻辑与 `src/peak.js` **逐点一致**。改了 `src/peak.js` 却忘了跑 `npm run build`，这里会红。 |
| `test/bundle.test.mjs` | 挂载点 id、`dsh.client` 清单形状、桌宠部件/贴图数量。 |

## 改动流程

1. 改 `src/`（Host 半身逻辑）或 `client.template.js`（浏览器半身）；
2. **跑 `npm run build`**——`client.js` 是构建产物，不要手改；
3. `npm test` 必须全绿；
4. 提交时如果动了 `vendor/`，说明来源与上游版本。

## 目录速查

```
index.js            Host 半身：/price /balance 命令 + 钱包路由 + 挂载接线
client.template.js  浏览器半身的「源」（构建产物 client.js 的模板）
src/peak.js         ★ 峰谷定价逻辑的唯一事实来源，Host 与浏览器共用
src/wallet.js       记账、余额、当日费用
src/optimize.js     提示词优化
vendor/             上游桌宠运行时（AGPL，未修改）
tools/vendor_pet.mjs  重新拼装 vendor/pet-runtime.js（改了 vendor/ 才需要）
build.mjs           注入 src/peak.js + vendor/pet-runtime.js → client.js
test/run-all.mjs    测试入口
```

## 约定

- **API key 永远不进仓库**。它只在运行时从 `$DSH_HOME/peak-whale/settings.json`
  或 `DEEPSEEK_API_KEY` 读取，只在 Host 进程里用，不进 bundle、不进日志。
  测试里只能用假桩（如 `sk-test-not-a-real-key`）。
- **不要提交用户数据**：`settings.json`、`wallet.*.json` 已在 `.gitignore` 里。
- **不要在客户端半身发请求给非预期来源**。钱包与账本路由是同源限定的，
  这是刻意的安全边界，不要为了「方便」放开 CORS。
- 注释和文档用中文，和现有代码风格保持一致。

## 许可

贡献即表示你同意你的贡献按 **AGPL-3.0-or-later** 发布。
不要把 `vendor/` 下的上游内容拷进自有代码区——那部分是 Pal-AI-Lab 的作品，
保持原样引用。