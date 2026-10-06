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
git commit -m "release: v0.4.6"
git tag -a v0.4.6 -m "v0.4.6"
git remote add origin https://github.com/<你的用户名>/dsh-deepseek-peak-whale.git
git push -u origin main --tags
```

推送前记得把 `package.json` 里的 `OWNER` 换成你的 GitHub 用户名
（`repository` / `bugs` / `homepage` 三处）。

## 体积说明

约 6.0 MB，其中约 5.0 MB 是 `vendor/` 贴图与 `client.js` 里内联的同一份 base64。

这是刻意的：浏览器半身不能 fetch（页面没有文件系统，也不启服务器），
所以贴图必须以 data URI 内联。Git 单文件超过 2 MB 需要
Git LFS 或容忍二进制大文件；`client.js`（1.9 MB）与 `client.template.js`
都会触发提示，正常提交即可。