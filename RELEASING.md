# 打包 / 发布

```bash
node tools/pack.mjs            # 自检 + 打成 tar.gz
node tools/pack.mjs --check    # 只做发布自检，不打包
```

`--check` 会验证这些**发布前必须为真**的条件：

1. `package.json` 的 `license` 是 `AGPL-3.0-or-later`；
2. 根目录 `LICENSE` 与 `vendor/LICENSE-Coopanion-AGPL-3.0.txt` 都在；
3. `client.js` 与 `npm run build` 的产物**逐字节一致**（防止手改构建产物）；
4. 全部测试通过；
5. 仓库里**没有** `settings.json` / `wallet.*.json` / `.env` 等用户数据；
6. 没有硬编码的 API key 形态字符串。

## 发到 GitHub

```bash
git init
git add -A
git commit -m "release: v0.5.0"
git tag -a v0.5.0 -m "v0.5.0"
git remote add origin https://github.com/<你的用户名>/dsh-deepseek-peak-whale.git
git push -u origin main --tags
```

推送前记得把 `package.json` 里的 `OWNER` 换成你的 GitHub 用户名
（`repository` / `bugs` / `homepage` 三处）。

## `vendor/` 里的本地改动（升级上游时必须手工重做）

`vendor/pet-core.js` 与 `vendor/figure.js` 是从
[Coopanion](https://github.com/) 的桌宠运行时（AGPL-3.0）取过来改的。
本项目对这两处有**本地改动**，升级上游版本时不会自动合进来，
必须手工重做，否则会静默丢功能（测试会红，但别指望 git 提示你）：

| 文件 | 本地加的东西 | 漏了会怎样 |
| --- | --- | --- |
| `vendor/pet-core.js` | `GESTURES` 手势表（13 个动作）、`gesture()` / `gestureName()` / `setMood()`、`mode` 之外的手势叠加块、mood 弹簧 | 右键「逗她玩」、场景反应、心情驱动尾巴全部失效 |
| `vendor/figure.js` | `sp.gest` / `sp.mood` 弹簧、手臂 `case '<手势>'` 分支、`gestMood` 参与的尾巴/鳍/呆毛 | 手势演了但**身体不动**（最难察觉的一类哑故障） |
| `tools/vendor_pet.mjs` | 把 `GESTURES` 加进两处返回对象 | 打包时 `GESTURES` 为 `undefined` |

改完这三处之后**必须**重跑：

```bash
node tools/vendor_pet.mjs     # 重新生成 pet-runtime.js（IIFE 包装 + 贴图内联）
node build.mjs                 # 重新生成 client.js
node test/run-all.mjs          # gesture + style 两套会直接验动作接线
```

`test/gesture.test.mjs` 会逐个手势断言"pet-core 有 `case`、`figure.js` 有手臂 `case`"，
就是为了让"只改了一半"这种哑故障在测试阶段就红，而不是等你盯着屏幕看才发现她不抬手。

## 体积说明

约 6.0 MB，其中约 5.0 MB 是 `vendor/` 贴图与 `client.js` 里内联的同一份 base64。

这是刻意的：浏览器半身不能 fetch（页面没有文件系统，也不启服务器），
所以贴图必须以 data URI 内联。Git 单文件超过 2 MB 需要
Git LFS 或容忍二进制大文件；`client.js`（1.9 MB）与 `client.template.js`
都会触发提示，正常提交即可。