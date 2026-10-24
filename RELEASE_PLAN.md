# 发行方案：dsh-deepseek-peak-whale v0.6.0

> **状态**：方案已就绪，待三档优化（tier1-3）全部完成后执行。
> **目标仓库**：https://github.com/TestFox000/dsh-deepseek-peak-whale

---

## 一、当前状态盘点

| 项 | 现状 |
|---|---|
| 当前版本 | 0.5.5（package.json / README badge） |
| README 行数 | 843 行 |
| 截图 | 4 张 PNG（pet-preview / pet-harness / pet-harness-typing / strip-preview） |
| HTML 预览源 | 3 个（pet-preview.html / pet-harness.html / strip-preview.html） |
| Git 仓库 | ❌ 本地工作区**不是 git 仓库**，需 `git init` |
| GitHub 仓库 | ✅ 已存在 https://github.com/TestFox000/dsh-deepseek-peak-whale |
| GitHub Release | ❌ 暂无（releases 页面为空） |
| CHANGELOG | ❌ 不存在 |
| package.json repository | `OWNER` 占位符，需改为 `TestFox000`（3 处） |
| README 中 OWNER | 第 98 行安装命令含 `OWNER`，需改为 `TestFox000` |
| 测试套件数 | README 写"9 suites"，优化后应为 11 suites |

---

## 二、发行步骤（6 步，严格顺序）

### Step 1：版本号与仓库信息（5 处改动）

| 文件 | 改动 | 位置 |
|---|---|---|
| `package.json` | `"version": "0.5.5"` → `"0.6.0"` | L3 |
| `package.json` | `repository.url`: `OWNER` → `TestFox000` | L41 |
| `package.json` | `bugs.url`: `OWNER` → `TestFox000` | L44 |
| `package.json` | `homepage`: `OWNER` → `TestFox000` | L46 |
| `README.md` | Version badge: `0.5.5` → `0.6.0` | L8 |

### Step 2：README.md 内容更新

| # | 改动 | 位置 |
|---|---|---|
| 1 | Version badge `0.5.5` → `0.6.0` | L8 |
| 2 | Tests badge `9 suites` → `11 suites` | L10 |
| 3 | 安装命令 `github.com/OWNER/...` → `github.com/TestFox000/...` | L98 |
| 4 | "跑九套测试" → "跑十一套测试" | L100 |
| 5 | 功能描述新增：右键撒爱心 / 表情选择 / 亲密度显示 / 拖拽视觉反馈 / 活力度滑块 / 配色切换 / 状态反馈 / 贴图 WebP 化 / 账单导出 | 描述区 + 功能列表 |
| 6 | 安装方式一命令更新（如 CLI 语法有变） | L89 |
| 7 | 新增"v0.6.0 更新内容"小节（CHANGELOG 摘要） | 安装之后、权威依据之前 |

### Step 3：截图更新

**方式选择**：从 DSH GUI 实际运行截图（推荐，最真实）或 HTML 预览渲染截图。

| 截图 | 当前用途 | 更新策略 |
|---|---|---|
| `strip-preview.png` | 侧栏价格条 + 详情浮层 | 确认无需大改（tier3 #11 账单导出若加了按钮则需更新） |
| `pet-preview.png` | 桌宠演示（念台词） | **必改**——tier1 #1 撒爱心 / #2 表情选择需体现 |
| `pet-harness.png` | 深色主题桌宠 | 确认即可 |
| `pet-harness-typing.png` | 打字状态桌宠 | **必改**——tier2 #8 listening/thinking 接线后需体现 |
| **新截图（可选）** | 设置页（新开关展示） | tier1 #3 亲密度 + #5 活力度滑块 + petVisible 开关 |
| **新截图（可选）** | 多配色展示 | tier2 #6 配色切换完成后 |

**HTML 预览源同步更新**：
- `pet-preview.html`：加撒爱心 + 新表情演示
- `pet-harness-typing.html`：加 listening 状态
- `strip-preview.html`：如加了账单导出按钮则更新

### Step 4：CHANGELOG.md 创建

新建 `CHANGELOG.md`，格式：

```markdown
# Changelog

## [0.6.0] - 2026-10-24

### 新增
- 右键菜单「撒爱心」「换个表情」（10 种表情循环）
- 设置页显示亲密度等级与进度条
- 拖拽到输入框附近时鲸鱼发光提示
- 设置页「活力度」滑块（setMood 0~1）
- 多配色切换（如 tier2 #6 完成）
- listening/thinking 状态视觉反馈（如 tier2 #8 完成）
- 账单导出按钮（如 tier3 #11 完成）

### 改进
- 贴图 WebP 化，client.js 体积下降（如 tier3 #9 完成）
- 节假日表续期至 2027 年（tier3 #10）

### 修复
- escapeTargetX 精灵偏移未计入（卡右边走不动）
- petVisible 开关（显示/关闭人偶）

### 兼容性
- 不影响既有设置，新增项全部有默认值
```

### Step 5：Git 初始化与推送

```bash
# 在插件目录
cd dsh-deepseek-peak-whale
git init
git add -A
git commit -m "release: v0.6.0

- 右键撒爱心、表情选择、亲密度显示、拖拽反馈、活力度滑块
- 多配色切换、状态反馈（按 tier 完成情况填写）
- 贴图 WebP 化、节假日续期、账单导出（按 tier 完成情况填写）
- 修复 escapeTargetX 精灵偏移导致卡右边
- 新增 petVisible 开关"

git tag -a v0.6.0 -m "v0.6.0"
git remote add origin https://github.com/TestFox000/dsh-deepseek-peak-whale.git
git push -u origin main --tags
```

⚠️ **注意**：
- 本地工作区目前**不是 git 仓库**，首次 `git init` 会把整个插件目录作为初始提交
- 如之前有 git 历史（在别的机器上），需先确认历史来源，避免重复初始提交
- 推送可能遇到大文件限制（client.js 1.9MB + vendor/ 贴图），正常提交即可（Gitee/GitHub 的 100MB 限制不触发）

### Step 6：GitHub Release 创建

通过 GitHub Web 或 API 创建：

| 字段 | 值 |
|---|---|
| Tag | `v0.6.0` |
| Target | `main` |
| Title | `v0.6.0` |
| Body | CHANGELOG.md 的 [0.6.0] 段落内容 |
| Assets | 无（或附加打包好的 tar.gz） |

---

## 三、截图清单（详细）

### 必改截图（3 张）

| 截图 | 改动原因 | 预计工时 |
|---|---|---|
| `pet-preview.png` | tier1 #1/#2 新功能需展示 | 30 min |
| `pet-harness-typing.png` | tier2 #8 listening 状态 | 20 min |
| `strip-preview.png` | tier3 #11 账单导出按钮（如加） | 15 min |

### 可选新截图（2-3 张）

| 截图 | 用途 | 预计工时 |
|---|---|---|
| `settings-page.png` | 展示设置页新开关（亲密度/活力度/petVisible） | 15 min |
| `skin-schemes.png` | 展示多配色（如 tier2 #6 完成） | 20 min |
| `optimize-drag.png` | 展示拖拽优化 + 视觉反馈 | 15 min |

### 截图生成方式

**方式 A（推荐）**：DSH GUI 实际截图
1. 重启 DSH（加载新代码）
2. 在 GUI 里操作插件，用截图工具截取
3. 保存到 `assets/` 目录

**方式 B**：HTML 预览渲染
1. 更新 HTML 预览文件
2. 用浏览器打开，截图
3. 保存为 PNG

---

## 四、执行时间线

| 阶段 | 前置条件 | 预计工时 |
|---|---|---|
| **方案**（本文件） | — | 已完成 |
| **Step 1-2**：版本号 + README | tier1-3 全部完成 | 30 min |
| **Step 3**：截图更新 | Step 1-2 + DSH 重启 | 60-120 min（取决于新截图数量） |
| **Step 4**：CHANGELOG | Step 1-2 | 15 min |
| **Step 5**：Git init + push | Step 1-4 | 15 min |
| **Step 6**：GitHub Release | Step 5 | 5 min |

**总计**：约 2-3 小时（不含优化本身）

---

## 五、风险与注意

| 风险 | 应对 |
|---|---|
| 本地无 git 历史 | 首次 `git init` 生成全新历史；如需要保留历史，从 GitHub 现有仓库 clone 下来再改 |
| client.js 1.9MB 推送可能慢 | 正常现象，GitHub 100MB 限制不触发 |
| 截图需要 DSH 重启 + GUI 操作 | 优化部署后重启一次即可截图 |
| OWNER 占位符遗漏 | Step 1 逐处检查，grep `OWNER` 确认零残留 |
| 测试套件数变化 | README 中"9 suites"需与实际一致 |
| GitHub Release body 格式 | 用 CHANGELOG.md 段落，保持 Markdown 格式 |