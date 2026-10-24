# Changelog

All notable changes to this project will be documented in this file.

## [0.6.0] - 2026-10-24

### 新增
- 右键菜单新增「撒爱心」「换个表情」（10 种表情循环）
- 设置页显示小鲸鱼的心情（亲密度等级 Lv.1~10 + 进度条）
- 拖拽到输入框附近时鲸鱼发光提示
- 设置页新增「活力度」滑块（0~100，可手动锁定）
- 设置页新增多配色切换（7 套：mint / mono / navigator / claude / fox / purple / lemon）
- 状态反馈：打字时竖耳听（setListening），优化时思考气泡（setThinking）
- 钱包卡片新增「导出账单 CSV」按钮
- 价格条与详情浮层统一显示「距下次谷时/峰时 + 完整时分」

### 改进
- 贴图 WebP 化：client.js 从 1.8MB 降到 775KB（降 62%）
- 节假日表续期：覆盖至 2027 年

### 修复
- escapeTargetX 精灵偏移未计入（卡右边走不动）
- bundle.test.mjs 既有 bug（petX 精灵偏移断言）

### 兼容性
- 不影响既有设置，新增项全部有默认值

## [0.5.5] - 2026-10-10

### 新增
- 网页端对话路径（webToken）：走 /api/v0/chat_completion，用完即删会话
- 三版并行优化（optimize3）：同时出更详细/更专业/AI自主三版
- 会话路由（sessionllm）：route → webToken → 默认模型 → 网关回落

### 改进
- 缓存键含配置：不同 reasoning_effort 不共享缓存
- 429 重试一次
- usage 透传

## [0.5.0] - 2026-09-20

### 新增
- 账本字段从 usd 改为 cny（人民币）
- 官方余额接口对接
- /price /balance 命令

### 改进
- 记账口径与 tokenUsage 投影一致

## [0.4.7] - 2026-08-15

### 新增
- 拖拽提示词到输入框优化
- 右键菜单

## [0.4.0] - 2026-07-01

### 新增
- 鲸鱼娘桌宠（Coopanion AGPL-3.0）
- 峰谷计价状态条
- 账户余额与今日费用
