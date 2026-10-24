/**
 * 提示词优化器 —— **Host 专用**（不进浏览器 bundle）。
 *
 * 流程：你把鲸鱼娘拖到文本框上 → 浏览器把框里的文字 POST 给 Host →
 * Host 调一次**本机 openai-gateway**（`127.0.0.1:8326/v1`）上的
 * `modlens-our-free-model/deepseek-v4.1-flash-free`（= 本机 DSH 会话当前走的那条路由）→
 * 返回改写后的提示词 → 浏览器写回文本框。
 *
 * ── 为什么不用 https://api.deepseek.com ─────────────────────────────────────
 * 那条路要另备 DeepSeek API key、按 token 计费，而且和会话里实际用的模型不是同一个
 * （优化器按 A 模型的口味改，会话由 B 模型执行，改出来的稿子对不上）。
 * 直接复用会话路由：一份 key、一种口味、零额外配置。
 *
 * ── 配置放哪 ────────────────────────────────────────────────────────────────
 * `$DSH_HOME/peak-whale/settings.json`（缺失时由 `ensureSettingsFile` 自动创建模板）：
 *
 * ```json
 * { "deepseekApiKey": "<本机网关的 key>",
 *   "model": "modlens-our-free-model/deepseek-v4.1-flash-free",
 *   "reasoningEffort": "deep", "baseUrl": "http://127.0.0.1:8326/v1" }
 * ```
 *
 * `deepseekApiKey` 就是 `$DSH_HOME/openai-gateway/api-key` 里那串（网关用它鉴权）；
 * 环境变量 `DEEPSEEK_API_KEY` 仍可兜底（文件优先）。
 * key **不会**进插件代码、不会进对话、不会进日志。
 *
 * ── 关于思考内容 ────────────────────────────────────────────────────────────
 * 该路由把思考放在 `message.reasoning_content`、正文放 `message.content`（已验证），
 * 所以正常情况只有正文被读走。但别的路由会把思考混进 `content`，所以还要两道闸：
 * ① 系统提示词要求正文套 `<<<PROMPT>>>` / `<<<END>>>` 标记，只取标记之间的部分；
 * ② `cleanOptimized` 兜底剥掉 ` thinking… response` 与常见的「思考过程：」段落。
 * 两者都在 `cleanOptimized` 里，网页端通道（webchat.js）共用同一份清洗。
 *
 * @module src/optimize.js
 */

import fs from 'node:fs';
import path from 'node:path';

/** 没写配置时的默认值；每一项都能在 settings.json 里覆盖。 */
export const DEFAULTS = {
  // 本机 openai-gateway 上那条「会话当前在走」的路由。改这里 = 改优化器口味。
  model: 'modlens-our-free-model/deepseek-v4.1-flash-free',
  // 该路由的思考档位只有 light/balanced/deep（见网关 /v1/models 的 efforts）。
  reasoningEffort: 'deep',
  baseUrl: 'http://127.0.0.1:8326/v1',
  timeoutMs: 120000,
  /** 输入太长只会烧钱且容易超时，先挡一道。 */
  maxInputChars: 12000,
  /** 同一段原文 5 分钟内不重复扣费（拖错了再拖一次不该再收一次钱）。 */
  cacheTtlMs: 300000,
  /**
   * 迭代打磨轮数（2026-10-23 用户要求）：第 1 轮优化原文，第 2 轮起把上一轮的
   * 优化稿捕获回来当新输入继续打磨，直到「模型说没得改」或轮数用尽。
   * 1 = 只优化一轮（旧行为）；上限 5 是防「越迭代越长」的失控。
   */
  iterateRounds: 2,
};

/**
 * 本机网关的 key（`$DSH_HOME/openai-gateway/api-key`，单行、43 字符）。
 *
 * settings.json 没填 `deepseekApiKey` 时拿它兜底：这条路由是本机的，key 也是本机生成
 * 的，让用户再手抄一遍纯属自找麻烦。读不到就返回 ''（照旧提示去配置）。
 */
export function readGatewayKey(settingsFile) {
  try {
    const p = path.join(path.dirname(settingsFile), '..', 'openai-gateway', 'api-key');
    const k = fs.readFileSync(p, 'utf8').trim();
    return k;
  } catch {
    return '';
  }
}

/** settings.json 的路径（`dir` 一般是 `$DSH_HOME/peak-whale`）。 */
export function settingsPath(dir) {
  return path.join(dir, 'settings.json');
}

/**
 * 正文包裹标记。模型只把**最终提示词**放中间，其余（思考、解释、前言、结语）一律放外面；
 * `cleanOptimized` 只取中间那一段，外面写什么都进不了文本框。
 *
 * 选这种尖括号长标记是因为它在提示词正文里几乎不会自然出现：真出现了也只是被当成
 * 内容的一部分（取到第一个 END 就停），不会把正文截断成半截。
 */
export const PROMPT_OPEN = '<<<PROMPT>>>';
export const PROMPT_CLOSE = '<<<END>>>';

/**
 * 系统提示词：只改写、不越界。
 *
 * 关键约束写死在里面——**不改变原意、不增删任务**，而且只输出正文：
 * 模型要是把说明也吐回来，写回文本框就成了事故。
 */
export const SYSTEM_PROMPT = [
  '你是提示词优化器。用户会给一段自己写给 AI 助手的提示词/指令，请改写它。',
  '要求：',
  '1. 不改变原意、不增删任务目标、不替用户做决定；',
  '2. 只补「怎么做好」，不编「做什么」：补齐上下文、约束、边界条件、输出格式',
  '   与验收标准；原文没有的数据、事实、引用、需求一律不添；',
  '3. 消除歧义：指代不明的写清楚，可选的路径替用户列出，而不是暗自替他选定；',
  '4. 篇幅与原文同量级：短提示词只补必要澄清，不许膨胀成公文；长提示词重组',
  '   层次、去掉复读的冗余，但一个细节、一条约束都不许丢；',
  '5. 信息多时按 背景 / 任务 / 要求 / 输出 分层；',
  '6. 保留用户原来的语言（中文就中文），保留其中的专有名词、链接、代码片段与',
  '   列表结构（代码放回代码块里，别混进正文）；',
  `7. 只输出改写后的提示词正文，并且**必须**用 ${PROMPT_OPEN} 和 ${PROMPT_CLOSE} 包起来，`,
  `   形如：${PROMPT_OPEN}\\n（改写后的提示词正文）\\n${PROMPT_CLOSE}`,
  '   两个标记各占一行；标记外面不要写任何别的东西。',
  `8. 你的思考过程、分析、解释、前言、结语一律放在 ${PROMPT_OPEN} 之外；`,
  '   标记之间只许有最终提示词正文本身——不要解释、不要客套、不要在标记内加',
  '   “优化后的提示词”这类标题。',
].join('\n');

/**
 * 三种优化偏向（用户在鲸鱼娘气泡里四选一）。
 *
 * 每条都是在 `SYSTEM_PROMPT` 之后再追加的「这一版往哪个方向改」的指令，
 * 所以三条共有的底线（不编造、不改原意、只输出正文）由 `SYSTEM_PROMPT` 兜住，
 * 这里只写各自的方向。
 *
 * `auto` 那版允许在正文末尾另起一行以「建议：」开头给一句优化建议——
 * 这是用户明确要的「AI 自主决定加建议」，其余两版不许加。
 * 注意这句建议要写在标记**里面**（跟着正文一起进输入框），标记外的那条铁律只针对思考过程。
 */
export const VARIANT_PROMPTS = {
  detailed: '这一版请把提示词改得更详细、更充分：补齐能想到的相关上下文、约束、边界条件与验收标准，让接手的 AI 不用再猜；但不要改变原意、不要替用户做决定。',
  professional: '这一版请把提示词改得更专业、更精确：用该领域的标准术语和工程化表述，去掉口语和含糊措辞，结构按 背景/任务/要求/输出 分层；但不要改变原意。',
  auto: '这一版请你自主判断这段提示词该怎么优化最好（方向由你定，可以更详细也可以更精炼，以实际效果为准）。另外在标记**之内**、正文的最末尾另起一行，以「建议：」开头给出你的一条优化建议（只一条，简短）——这句建议要和正文一起被标记包住。',
};

/** 三版的展示标签（气泡里四选一用的）。 */
export const VARIANT_LABELS = {
  detailed: '更详细',
  professional: '更专业',
  auto: 'AI 自主 + 建议',
};

/**
 * 迭代打磨轮（第 2 轮起）追加在系统提示词后的指令。
 *
 * 为什么不能沿用原 SYSTEM_PROMPT 逐字重发：原提示词说「用户会给一段自己写给
 * AI 助手的提示词」，而迭代轮喂进去的是**上一轮优化后的稿子**——不说明白，
 * 模型会把它当新任务重新发挥（删约束、加任务），越磨越歪。
 *
 * 铁律与首轮一致（不改原意、不编事实、篇幅同量级），只是视角换成「在上一稿上继续」。
 */
export const ITERATION_SUFFIX = [
  '【迭代打磨】下面是上一轮优化后的提示词稿。',
  '请在此基础上继续打磨：消除仍然含糊的表述、补齐仍然缺失的约束与验收标准；',
  '不要改变原意、不要新增原文没有的事实、篇幅不要明显膨胀。',
  `仍只输出正文，用 ${PROMPT_OPEN} 和 ${PROMPT_CLOSE} 包起来，标记外不要写别的。`,
].join('\n');

/** 迭代轮用户消息的前缀（与首轮的「【原始提示词】」区分，模型才知道这不是原文）。 */
export const ITERATION_USER_PREFIX = '【上一轮优化稿】';

/** 缓存键里标记迭代模式的尾巴：iterateRounds 变了（2→3）缓存就该失效。 */
const ITER_CACHE_TAIL = '\n[iterate:';

/** 取某版的系统提示词（`SYSTEM_PROMPT` + 偏向追加）；不认识的 key 回落基础提示词。 */
export function systemPromptFor(variantKey) {
  const suffix = variantKey && Object.prototype.hasOwnProperty.call(VARIANT_PROMPTS, variantKey)
    ? VARIANT_PROMPTS[variantKey]
    : '';
  return suffix ? `${SYSTEM_PROMPT}\n\n${suffix}` : SYSTEM_PROMPT;
}

// ============================================================================
//  提示词风格
//
//  「风格」= 系统提示词**底稿**，可整组替换。三版的偏向指令叠加在它之上，
//  所以换风格不会动 detailed/professional/auto 各自的取向，只改它们共同的底子。
//
//  ⚠️ **风格清单尚未指定**（用户明确要求不要自行编造），所以：
//    - `PROMPT_STYLES` 目前只有内置那一条 `default`，它就是当前写死的那段底稿；
//    - `DEFAULT_PROMPT_STYLE` 指向 `default`，因此**当前输出与加这个特性之前逐字节相同**；
//    - 将来往表里加条目即可，无需改任何调用方（下面所有入口都走 `stylePrompt`）。
//
//  表项形状：`{ id, name, note, prompt }`，其中 `prompt` 整体顶替 `SYSTEM_PROMPT`。
// ============================================================================
export const DEFAULT_PROMPT_STYLE = 'default';

/** 内置风格表。**加新风格只往这里加一条**，别的地方都不用动。 */
export const PROMPT_STYLES = {
  default: {
    id: 'default',
    name: '默认',
    note: '不改底稿：只改写、不增删任务目标、篇幅与原文同量级。',
    // 逐字复制 SYSTEM_PROMPT —— 这样 default 走和不走风格层完全等价。
    // 故意不写成 `prompt: SYSTEM_PROMPT` 再 export 引用：那会让下面对 SYSTEM_PROMPT
    // 的任何改动**静默地**改变"默认风格"的定义，而默认风格的定义必须与旧行为一致。
    prompt: SYSTEM_PROMPT,
  },
};

/** 列出可选风格（给设置面板用；不回 prompt 正文，太长且没必要送进浏览器）。 */
export function listPromptStyles() {
  return Object.values(PROMPT_STYLES).map((s) => ({ id: s.id, name: s.name, note: s.note }));
}

/** 认一个风格 id；不认识（含空值/原型属性）一律回默认，绝不抛。 */
export function promptStyleId(id) {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(PROMPT_STYLES, id)
    ? id
    : DEFAULT_PROMPT_STYLE;
}

/**
 * 鲸鱼娘配色（第二档 #6）。
 *
 * 与浏览器半身的 WHALE_PALETTES（client.template.js）同构：鲸鱼是贴图渲染，
 * 配色实际改的是特效主色（竖耳弧 / 思考气泡 / 睡 z），皮肤对象的 palette 只是附带。
 * Host 这里只需要一份**白名单**，用来校验写进 settings.json 的值。
 */
export const WHALE_PALETTES = ['mint', 'mono', 'navigator', 'claude', 'fox', 'purple', 'lemon'];
export const DEFAULT_PALETTE = 'mint';
/** 认一个配色 id；不认识（含空值/原型属性）一律回默认，绝不抛。 */
export function paletteId(id) {
  return WHALE_PALETTES.includes(id) ? id : DEFAULT_PALETTE;
}

/**
 * 风格底稿正文。
 *
 * 认不出的 id 静默回落 `default` —— 换一个手滑打错的风格名不该让优化直接报失败，
 * 而且回落后的行为和没开这个特性时一模一样。
 */
export function stylePrompt(id) {
  const style = PROMPT_STYLES[promptStyleId(id)];
  return typeof style?.prompt === 'string' && style.prompt !== '' ? style.prompt : SYSTEM_PROMPT;
}

/** 构造某个版本的完整系统提示词 = 该风格的底稿 + 该版的偏向。 */
export function systemPromptForStyle(variantKey, styleId) {
  const suffix = variantKey && Object.prototype.hasOwnProperty.call(VARIANT_PROMPTS, variantKey)
    ? VARIANT_PROMPTS[variantKey]
    : '';
  const base = stylePrompt(styleId);
  return suffix ? `${base}\n\n${suffix}` : base;
}

/** 模板内容：自动创建时写进 settings.json 的东西。 */
export function settingsTemplate() {
  return {
    _说明: '优化提示词默认走本机 openai-gateway（baseUrl=http://127.0.0.1:8326/v1），用的就是 DSH 会话当前那条路由。deepseekApiKey 留空时自动读 $DSH_HOME/openai-gateway/api-key，不用手抄。',
    _说明2: 'uiMode 控制详情浮层的排版（concise 简洁版，默认 / detailed 详细版）；optimizeEnabled 关掉后，把鲸鱼娘拖到文本框上不会再发起优化请求。',
    _说明3: 'webToken：chat.deepseek.com 的 userToken（浏览器 localStorage 里）。填了之后优化改走网页端对话（cookie 方案），不填就走 baseUrl 那条。注意网页端会改版，改版后可能要重新逆向。',
    _说明4: 'keepWebSessions：默认 false —— 网页端每次优化用完就把那条对话删掉，不在你的 chat.deepseek.com 侧栏留垃圾。想留着回看就设 true。',
    _说明5: 'promptStyle：提示词风格（= 系统提示词底稿的 id）。不写或写错都回落 default，default 就是内置那段底稿。风格清单在 src/optimize.js 的 PROMPT_STYLES 里，往表里加一条即可新增风格。',
    _说明6: 'model / reasoningEffort / baseUrl 三项要和本机网关对得上：model 填 GET /v1/models 列出的 id（默认 modlens-our-free-model/deepseek-v4.1-flash-free），reasoningEffort 填该模型声明的档位（默认 deep）。改完即生效——每次拖鲸鱼都重读本文件，不用重启 DSH。',
    _说明7: 'serialVariants：三版优化是否串行打上游（默认 false 并行，适合本机网关）。上游是匿名免费档（同一时刻只放 1 个请求，如 Pollinations）时设 true，否则四选一气泡里会有两版被限流刷掉。',
    _说明8: '通道优先级（v0.6.0 起）：拖鲸鱼时浏览器会带上当前对话框的模型选择，优化走同一条 llm 路由（与对话共用适配器和凭据，免配置，不同对话框各自走各自的模型）。浏览器没读到选择时才依次回落：webToken 网页端 → 全局默认模型 → 本文件的 baseUrl+key 网关配置。',
    _说明9: 'iterateRounds：迭代打磨轮数（默认 2）。第 1 轮优化原文，第 2 轮起把上一轮的优化稿捕获回来继续打磨，直到模型说没得改或轮数用尽。1 = 只优化一轮（旧行为）；上限 5。每轮都花 token，轮数越多越贵也越慢。',
    _说明10: 'petVisible：显示/关闭小鲸鱼人偶（桌宠）。关掉后她不再出现（侧栏价格条不受影响），设置即时生效，不用重启。',
    _说明11: 'palette：小鲸鱼配色（第二档）。可选 mint/mono/navigator/claude/fox/purple/lemon，默认 mint。实际改的是她竖耳听 / 思考 / 睡觉时特效的主色（贴图本身不变），设置即时生效。',
    deepseekApiKey: '',
    webToken: '',
    model: DEFAULTS.model,
    reasoningEffort: DEFAULTS.reasoningEffort,
    baseUrl: DEFAULTS.baseUrl,
    timeoutMs: DEFAULTS.timeoutMs,
    uiMode: 'concise',
    optimizeEnabled: true,
    keepWebSessions: false,
    serialVariants: false,
    iterateRounds: DEFAULTS.iterateRounds,
    petVisible: true,
    palette: DEFAULT_PALETTE,
  };
}

/**
 * 从 localStorage 粘进来的 userToken 常被 appKit 包成 `{"value":"..."}`。
 * 直接当 Bearer 用会得到一句费解的 `40003 Authorization Failed`，
 * 所以这里把包装剥掉；不是包装就原样返回（只 trim）。
 */
export function unwrapStoredToken(raw) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s.startsWith('{') || !s.endsWith('}')) return s;
  try {
    const parsed = JSON.parse(s);
    const v = parsed && typeof parsed === 'object' ? parsed.value : null;
    return typeof v === 'string' && v.trim() !== '' ? v.trim() : s;
  } catch {
    return s; // 不是合法 JSON：别乱改，原样交给上游报错
  }
}

/**
 * 识别「把取 token 的命令本身粘成了 token」这类误操作。
 * 真实 userToken 是 base64 风格的不透明串，绝不含括号/引号/花括号/分号/换行；
 * 而 `copy(JSON.parse(localStorage.getItem('userToken')).value)` 全中。
 * 不拦的话会被当 Bearer 发出去，换回一句费解的 `40003 Authorization Failed`。
 */
export function tokenLooksLikeSnippet(value) {
  const s = typeof value === 'string' ? value.trim() : '';
  if (!s) return false;
  if (/[\n\r]/.test(s)) return true;
  if (/[()[\]{}'"`;]/.test(s)) return true;
  return /\b(localStorage|sessionStorage|document\.cookie|JSON\.parse|getItem|copy)\b/.test(s);
}

/** 读 settings.json；不存在/损坏/字段缺失都回落到默认值。 */
export function readSettings(file, env = process.env) {
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    raw = null;
  }
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const str = (value, fallback) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback);
  const envKey = env && typeof env.DEEPSEEK_API_KEY === 'string' ? env.DEEPSEEK_API_KEY.trim() : '';
  const webToken = unwrapStoredToken(str(source.webToken, ''));
  return {
    // 配置里没写 key 就用本机网关的 key（同一条本机路由，没必要让用户再抄一遍）。
    apiKey: str(source.deepseekApiKey, envKey) || readGatewayKey(file),
    // 剥掉 appKit 的 {"value":"…"} 包装，避免粘进来直接 40003 却看不出原因。
    webToken,
    // 粘成了命令片段 = 配置错误，但**不能**当没填（会静默改用计费的 API 通道）。
    // 交给路由层报人话，让用户自己修。
    webTokenInvalid: tokenLooksLikeSnippet(webToken),
    model: str(source.model, DEFAULTS.model),
    reasoningEffort: str(source.reasoningEffort, DEFAULTS.reasoningEffort),
    baseUrl: str(source.baseUrl, DEFAULTS.baseUrl).replace(/\/+$/, ''),
    timeoutMs: Number.isFinite(Number(source.timeoutMs)) && Number(source.timeoutMs) > 0
      ? Number(source.timeoutMs)
      : DEFAULTS.timeoutMs,
    maxInputChars: Number.isFinite(Number(source.maxInputChars)) && Number(source.maxInputChars) > 0
      ? Number(source.maxInputChars)
      : DEFAULTS.maxInputChars,
    cacheTtlMs: Number.isFinite(Number(source.cacheTtlMs)) && Number(source.cacheTtlMs) > 0
      ? Number(source.cacheTtlMs)
      : DEFAULTS.cacheTtlMs,
    uiMode: source.uiMode === 'detailed' ? 'detailed' : 'concise',
    optimizeEnabled: source.optimizeEnabled === false ? false : true,
    // 提示词风格（系统提示词底稿）。不认识的 id 回落默认 —— 手滑打错不该让优化报错。
    promptStyle: promptStyleId(typeof source.promptStyle === 'string' ? source.promptStyle : ''),
    // 网页端会话是否保留。默认 false = 用完即删（不给用户侧栏留垃圾对话）。
    keepWebSessions: source.keepWebSessions === true,
    // 三版优化是否串行打上游。默认 false = 并行（本机网关吃得消）。
    // 匿名免费档（如 Pollinations）同一时刻只放行 1 个请求，不串行三版必丢两版。
    serialVariants: source.serialVariants === true,
    // 显示/关闭小鲸鱼人偶。默认 true = 显示；只有显式 false 才关。
    petVisible: source.petVisible === false ? false : true,
    // 小鲸鱼配色（第二档）。不认识就回默认，绝不因为一个坏值让特效主色消失。
    palette: paletteId(source.palette),
    // 迭代打磨轮数：1..5，非法值（0/负数/NaN/超限）回落默认，绝不让配置把循环变成死循环。
    iterateRounds: (() => {
      const n = Number(source.iterateRounds);
      return Number.isFinite(n) && n >= 1 && n <= 5 ? Math.round(n) : DEFAULTS.iterateRounds;
    })(),
    file,
  };
}

/**
 * 详情页模式与优化开关：设置页 / 详情浮层要的那一小块 UI 设置。
 *
 * **绝不带出 apiKey**——这个函数专门给「要回传给浏览器的载荷」用。
 */
export function readUiSettings(file, env = process.env) {
  const settings = readSettings(file, env);
  return {
    uiMode: settings.uiMode,
    optimizeEnabled: settings.optimizeEnabled,
    petVisible: settings.petVisible,
    palette: paletteId(settings.palette),
    promptStyle: settings.promptStyle,
    // 风格清单随设置一起回前端，面板才能渲染可选项，而不必把清单硬编码在客户端。
    promptStyles: listPromptStyles(),
    apiKeyConfigured: settings.apiKey !== '',
  };
}

/**
 * 写 UI 设置（白名单：`uiMode` 枚举、`optimizeEnabled` 布尔）。
 *
 * 其余字段（尤其是 `deepseekApiKey`）一律原样保留；未知字段直接忽略。
 * 写盘用「临时文件 + 原子改名」，正在读的进程永远读不到半个文件。
 *
 * @returns {{ok: boolean, settings?: object, message?: string}}
 */
export function writeUiSettings(file, patch) {
  const incoming = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};
  const next = {};
  let changed = false;
  if (incoming.uiMode !== undefined) {
    if (incoming.uiMode !== 'concise' && incoming.uiMode !== 'detailed') {
      return { ok: false, message: 'uiMode 只能是 concise 或 detailed' };
    }
    next.uiMode = incoming.uiMode;
    changed = true;
  }
  if (incoming.optimizeEnabled !== undefined) {
    if (typeof incoming.optimizeEnabled !== 'boolean') {
      return { ok: false, message: 'optimizeEnabled 必须是 true 或 false' };
    }
    next.optimizeEnabled = incoming.optimizeEnabled;
    changed = true;
  }
  if (incoming.petVisible !== undefined) {
    if (typeof incoming.petVisible !== 'boolean') {
      return { ok: false, message: 'petVisible 必须是 true 或 false' };
    }
    next.petVisible = incoming.petVisible;
    changed = true;
  }
  if (incoming.palette !== undefined) {
    // 写入端**不**静默回落：打错名字的请求必须被拒掉，否则用户以为换成功了，
    // 实际存的还是上一档 —— 这正是「设置项看着能改、其实没生效」最难查的那种故障。
    if (typeof incoming.palette !== 'string' || !WHALE_PALETTES.includes(incoming.palette)) {
      return { ok: false, message: `palette 只能是已知配色：${WHALE_PALETTES.join(' / ')}` };
    }
    next.palette = incoming.palette;
    changed = true;
  }
  if (incoming.promptStyle !== undefined) {
    // 写入端**不**静默回落：打错名字的请求必须被拒掉，否则用户以为换成功了，
    // 实际存的还是上一档 —— 这正是"设置项看着能改、其实没生效"最难查的那种故障。
    // 回落只发生在读取侧（老配置、损坏配置）。
    if (typeof incoming.promptStyle !== 'string'
        || !Object.prototype.hasOwnProperty.call(PROMPT_STYLES, incoming.promptStyle)) {
      const known = Object.keys(PROMPT_STYLES).join(' / ') || '（无）';
      return { ok: false, message: `promptStyle 只能是已知的风格：${known}` };
    }
    next.promptStyle = incoming.promptStyle;
    changed = true;
  }
  if (!changed) return { ok: false, message: '没有可写的设置项' };

  let current = {};
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) current = raw;
  } catch {
    // 不存在 / 损坏：按模板建，保证 deepseekApiKey 等字段都在
    current = settingsTemplate();
  }
  const merged = { ...current, ...next };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, `${JSON.stringify(merged, null, 2)}\n`);
    fs.renameSync(tmp, file);
  } catch (error) {
    return { ok: false, message: `设置写不进去：${error?.message ?? error}` };
  }
  return { ok: true, settings: readUiSettings(file) };
}

/**
 * settings.json 不存在就写一份模板。
 * @returns {boolean} 是否真的创建了（调用方据此打一条日志）。
 */
export function ensureSettingsFile(file) {
  try {
    if (fs.existsSync(file)) return false;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(settingsTemplate(), null, 2)}\n`);
    return true;
  } catch {
    return false; // 写不进去（权限/磁盘满）不影响插件，运行时会走「未配置」的提示
  }
}

/** 给一段文本做小而稳的散列（cache key 用，不是安全用途）。 */
export function hashText(text) {
  let h = 5381;
  const s = String(text);
  for (let i = 0; i < s.length; i += 1) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return `${h.toString(36)}:${s.length}`;
}

/**
 * 缓存键：**原文 + 会影响结果的全部配置 + 系统提示词**一起散列。
 *
 * 只拿原文当键是个真 bug：改了 model / reasoningEffort / baseUrl（甚至我们升级
 * 了 SYSTEM_PROMPT）之后，5 分钟 TTL 内还会命中**旧配置产出的**旧结果——
 * 用户明明换了模型，拿到的却是上一个模型的稿子，而且完全看不出哪里错了。
 *
 * @param {ReturnType<typeof readSettings>} settings
 * @param {string} text - 已 trim 的原文。
 */
export function cacheKeyFor(settings, text, systemPrompt = SYSTEM_PROMPT) {
  return hashText([
    'v2',
    settings.model,
    settings.reasoningEffort,
    settings.baseUrl,
    systemPrompt,
    text,
  ].join('\u0000'));
}

/**
 * 组装一次上游请求体。
 *
 * `reasoningEffort` 非空才带上（有人的账户不认这个字段，删掉配置就退回默认思考）。
 *
 * @param {ReturnType<typeof readSettings>} settings
 * @param {string} text - 本轮的输入（首轮=原文，迭代轮=上一轮优化稿）。
 * @param {string} [systemPrompt] - 系统提示词（迭代轮会追加 ITERATION_SUFFIX）。
 * @param {string} [userPrefix] - 用户消息前缀；迭代轮传 ITERATION_USER_PREFIX，
 *   让模型知道喂进来的不是原文而是上一轮的稿子。
 */
export function buildRequestBody(settings, text, systemPrompt = SYSTEM_PROMPT, userPrefix = '【原始提示词】') {
  const body = {
    model: settings.model || DEFAULTS.model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `${userPrefix}\n${text}` },
    ],
    stream: false,
    temperature: 0.3,
  };
  const effort = typeof settings.reasoningEffort === 'string' ? settings.reasoningEffort.trim() : '';
  if (effort !== '') body.reasoning_effort = effort;
  return body;
}

/**
 * 把模型的输出收敛成「能直接粘进文本框的正文」。
 *
 * 三道闸，顺序有讲究：
 * ① **标记区**：模型按 `SYSTEM_PROMPT` 要求把正文包在 `<<<PROMPT>>>…<<<END>>>` 之间，
 *    此时**只取标记之间**，标记外不管是思考、解释还是客套都天然进不来。这是主路径。
 * ② **思考块**：模型没听（或走了不带标记的通道）时，剥掉 ` thinking…</think>` /
 *    `<thinking>…</thinking>` 这种成对思考块，以及「思考过程：」开头的整段。
 * ③ **老套路兜底**：整段被包进 ``` 代码块、前面一句「好的，以下是…」、结尾客套。
 *
 * 三条都不命中就原样返回（提示词正文自己带代码片段是常事，一刀切取「最长的那块」
 * 会把正文丢掉、只留下那段代码）。
 *
 * @param {unknown} raw - `choices[0].message.content`。
 * @returns {string|null}
 */
export function cleanOptimized(raw) {
  if (typeof raw !== 'string') return null;
  let text = raw.replace(/\r\n/g, '\n').trim();
  if (text === '') return null;

  // ① 标记区主路径。用 indexOf 而不是正则：模型偶尔把标记塞进 ``` 里或加粗，
  //    这里只认标记本身，外面的包装随后由 ③ 处理。
  const openAt = text.indexOf(PROMPT_OPEN);
  if (openAt !== -1) {
    const bodyStart = openAt + PROMPT_OPEN.length;
    const closeAt = text.indexOf(PROMPT_CLOSE, bodyStart);
    // 只有 END 才截断；模型忘了写 END 就取到结尾——总比把思考也放进来强。
    text = (closeAt === -1 ? text.slice(bodyStart) : text.slice(bodyStart, closeAt)).trim();
  }

  // ② 成对思考块（可跨行、可多个）。开标签丢了就只剥闭标签前的部分。
  text = text.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '').trim();
  const strayClose = /<\/think(?:ing)?>/i.exec(text);
  if (strayClose) text = text.slice(strayClose.index + strayClose[0].length).trim();
  text = text.replace(/^思考(过程|分析)?\s*[:：][\s\S]*?\n\s*\n/, '').trim();
  if (text === '') return null;

  // ③ 整段被包进代码块 → 剥开。**只在「包住整段」时才剥**。
  const wrapped = /^```[^\n]*\n([\s\S]*?)\n?```$/.exec(text);
  if (wrapped) text = wrapped[1].trim();
  if (text === '') return null;

  const lines = text.split('\n');
  // 开头的引导语：短、且是套话才删（用户自己的首行短句不动）
  const head = lines[0].trim();
  if (lines.length > 1 && head.length <= 60
    && /^(好的|好的[，,]|以下是|下面是|优化后|这是改写|当然可以|没问题|Sure|Here (is|are)|Below (is|are))/i.test(head)) {
    lines.shift();
  }
  // 结尾的客套
  while (lines.length > 0 && /^(希望(这|对)|如有需要|祝你|Let me know|Feel free)/.test(lines[lines.length - 1].trim())) {
    lines.pop();
  }
  const out = lines.join('\n').trim();
  return out === '' ? null : out;
}

/**
 * 从上游响应里取 token 用量（官方文档：非流式响应的 `usage` 字段是必有的）。
 *
 * 返回给客户端用于气泡里显示「这次花了多少」——优化走的是用户自己的 API 账户，
 * 花没花钱、花了多少应该看得见。取不到就 null（老端点 / 被网关剥过都可能）。
 *
 * @param {unknown} payload - 完整的上游 JSON。
 * @returns {{prompt: number, completion: number, total: number}|null}
 */
export function pickUsage(payload) {
  const usage = payload && typeof payload.usage === 'object' && payload.usage !== null
    ? payload.usage
    : null;
  if (!usage) return null;
  const num = (value) => (Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null);
  const prompt = num(usage.prompt_tokens);
  const completion = num(usage.completion_tokens);
  if (prompt === null && completion === null) return null;
  const total = num(usage.total_tokens) ?? (prompt ?? 0) + (completion ?? 0);
  return { prompt: prompt ?? 0, completion: completion ?? 0, total };
}

/**
 * 累加两轮的 token 用量（迭代打磨时每轮都花 token，界面要看到**总和**）。
 *
 * 某一轮没给 usage（老端点/被网关剥过）就当 0 参与累加——显示出来的数字
 * 仍然是「至少花了这些」，不会因为缺一轮就报一个偏小的数。
 */
export function addUsage(a, b) {
  const pa = a && typeof a === 'object' ? a : null;
  const pb = b && typeof b === 'object' ? b : null;
  if (!pa) return pb;
  if (!pb) return pa;
  const sum = (x, y) => (Number.isFinite(Number(x)) ? Number(x) : 0) + (Number.isFinite(Number(y)) ? Number(y) : 0);
  const prompt = sum(pa.prompt, pb.prompt);
  const completion = sum(pa.completion, pb.completion);
  return { prompt, completion, total: sum(pa.total, pb.total) };
}
/** 把上游 HTTP 错误翻成一句能直接显示给人看的中文。 */
export function describeHttpError(status, payload) {
  const detail = payload && payload.error && typeof payload.error.message === 'string'
    ? payload.error.message
    : '';
  const short = detail.length > 160 ? `${detail.slice(0, 160)}…` : detail;
  if (status === 401) return `API key 无效或已过期（HTTP 401）${short ? `：${short}` : ''}`;
  if (status === 402) return `上游账户余额不足（HTTP 402）${short ? `：${short}` : ''}`;
  if (status === 403) return `没有权限调用该模型（HTTP 403）${short ? `：${short}` : ''}`;
  if (status === 404) return `模型 id 找不到（HTTP 404），检查 settings.json 的 model${short ? `：${short}` : ''}`;
  if (status === 429) return `请求太频繁了，稍等几秒再拖一次（HTTP 429）`;
  if (status === 502 || status === 503) {
    // 本机网关最常见的 502 是「选的模型在上游没有可用凭据」（如 qoder 未登录）。
    // 这时换 model 就行，别让用户去查网络。
    return `上游模型当前不可用（HTTP ${status}）${short ? `：${short}` : ''}`
      + '；多半是 settings.json 的 model 那条路由没有可用凭据，换成本机网关 /v1/models 里列出的其它 id';
  }
  if (status === 400) {
    // 最常见的 400 就是「这个账户不认 reasoning_effort」——顺手告诉用户改哪里
    const hint = /reasoning|thinking/i.test(short)
      ? '；把 settings.json 的 reasoningEffort 留空即可关掉思考字段'
      : '';
    return `请求被拒（HTTP 400）${short ? `：${short}` : ''}${hint}`;
  }
  return `上游返回 HTTP ${status}${short ? `：${short}` : ''}`;
}

/**
 * 创建一个「优化一段文本」的函数：读配置 → 查缓存 → 打上游 → 收敛输出。
 *
 * @param {{file: string, env?: object, fetchImpl?: Function, now?: () => number,
 *          retryDelayMs?: number,
 *          log?: (message: string, level?: string) => void}} options
 *   `retryDelayMs`：HTTP 429 后等多久自动重试一次（默认 1200；0 = 立即重试，
 *   负数 = 禁用重试；测试常用 0/-1）。
 * @returns {(text: string) => Promise<{ok: boolean, optimized?: string, message?: string,
 *          error?: string, cached?: boolean, unchanged?: boolean,
 *          usage?: {prompt: number, completion: number, total: number}|null, ms?: number}>}
 */
export function createOptimizeRunner(options = {}) {
  const file = options.file;
  const env = options.env ?? process.env;
  const now = options.now ?? (() => Date.now());
  const log = options.log ?? (() => {});
  // 有限数值一律尊重（含负数：负 = 禁用重试）；只有缺省/垃圾值才回落 1200。
  const retryDelayMs = Number.isFinite(Number(options.retryDelayMs)) && options.retryDelayMs !== undefined && options.retryDelayMs !== null
    ? Number(options.retryDelayMs)
    : 1200;
  const fetchImpl = options.fetchImpl !== undefined
    ? options.fetchImpl
    : (typeof fetch === 'function' ? (...args) => fetch(...args) : null);

  /** hash → { at, optimized, model } */
  const cache = new Map();
  /** hash → in-flight promise（同一段文字并发拖两次只打一次上游） */
  const inflight = new Map();

  function cacheGet(hash, settings) {
    const hit = cache.get(hash);
    if (!hit) return null;
    if (now() - hit.at > settings.cacheTtlMs) {
      cache.delete(hash);
      return null;
    }
    return hit;
  }

  async function callUpstream(settings, text, systemPrompt = SYSTEM_PROMPT, userPrefix = '【原始提示词】') {
    if (fetchImpl === null) {
      return { ok: false, error: 'no-fetch', message: '这个运行环境没有 fetch，没法调优化后端' };
    }
    const controller = new AbortController();
    // 双保险的超时：① `abort()` 让 fetch 真的断掉；② `guard` 保证**即使上游不理会
    // signal**（自定义实现、卡住的流）也一定在超时点返回。
    // 计时器故意不 unref —— 这是用户正等着的、有上限（默认 120s）的操作，
    // 进程该为它多活一会儿；unref 了反而可能在空转的事件循环里被回收，请求悬死。
    let timedOut = false;
    let rejectGuard = () => {};
    const guard = new Promise((resolve, reject) => {
      rejectGuard = reject;
    });
    guard.catch(() => {}); // 没被 race 到的那次拒绝，别变成 unhandled rejection
    const timer = setTimeout(() => {
      timedOut = true;
      const abort = new Error('timeout');
      abort.name = 'AbortError';
      try {
        controller.abort();
      } catch { /* 已经断了 */ }
      rejectGuard(abort);
    }, settings.timeoutMs);
    const timeoutResult = () => ({
      ok: false,
      error: 'timeout',
      message: `等了 ${Math.round(settings.timeoutMs / 1000)} 秒还没想完（max 思考就是慢），稍后再试`,
    });
    const started = now();
    try {
      const response = await Promise.race([
        fetchImpl(`${settings.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${settings.apiKey}`,
          },
          body: JSON.stringify(buildRequestBody(settings, text, systemPrompt, userPrefix)),
          signal: controller.signal,
        }),
        guard,
      ]);
      let payload = null;
      try {
        payload = await Promise.race([response.json(), guard]);
      } catch {
        payload = null;
      }
      if (timedOut) return timeoutResult();
      if (!response.ok) {
        const message = describeHttpError(response.status, payload);
        log(`peak-whale: 提示词优化失败（HTTP ${response.status}）`);
        return { ok: false, error: `http-${response.status}`, message };
      }
      const choice = payload && payload.choices && payload.choices[0]
        ? payload.choices[0]
        : null;
      // ── 截断守卫 ──────────────────────────────────────────────────────────
      // finish_reason === 'length' 表示撞到 max_tokens 上限、正文被硬切断
      // （官方文档确认；thinking + reasoning_effort=max 时默认 128K，一般撞不到，
      //  但自定义低 max_tokens / 上游收紧默认值时会）。半截提示词写回文本框
      // 就是一场静默事故——用户拿着残缺的稿子去问模型，错还查不到优化器头上。
      // 其余非 'stop' 终止信号同理：content_filter/aborted 都不代表完整结果。
      const finish = choice && typeof choice.finish_reason === 'string' ? choice.finish_reason : '';
      if (finish !== '' && finish !== 'stop' && finish !== 'tool_calls') {
        log(`peak-whale: 提示词优化结果被上游截断（finish_reason=${finish}）`);
        return {
          ok: false,
          error: `finish-${finish}`,
          message: finish === 'length'
            ? '优化结果被输出长度上限截断了，半截提示词不能写回——把原文精简一点再试'
            : `上游提前终止了生成（finish_reason=${finish}），这次结果不可用，再拖一次试试`,
        };
      }
      // 正文只取 `content`：本机网关把思考放在独立的 `reasoning_content` 里。
      const message = choice ? choice.message && choice.message.content : null;
      const optimized = cleanOptimized(message);
      if (optimized === null) {
        return { ok: false, error: 'empty-result', message: '模型没返回可用内容，再拖一次试试' };
      }
      return {
        ok: true,
        optimized,
        // 模型认为没什么可改的：客户端据此不写回、不问撤销，只说一句「已经很清晰」
        unchanged: optimized === text,
        model: settings.model,
        effort: settings.reasoningEffort,
        usage: pickUsage(payload),
        ms: now() - started,
      };
    } catch (error) {
      if (timedOut || (error && (error.name === 'AbortError' || error.code === 'ABORT_ERR'))) {
        return timeoutResult();
      }
      const detail = error && error.message ? error.message : String(error);
      log(`peak-whale: 提示词优化网络错误：${detail}`);
      return { ok: false, error: 'network', message: `连不上优化后端（${settings.baseUrl}）：${detail}` };
    } finally {
      clearTimeout(timer);
    }
  }

  return async function optimize(rawText, variantKey) {
    const settings = readSettings(file, env);
    if (settings.optimizeEnabled === false) {
      return {
        ok: false,
        error: 'disabled',
        message: '提示词优化已在设置里关掉了；想用的话去「设置 → 插件 → 小鲸鱼」把开关打开',
      };
    }
    const text = typeof rawText === 'string' ? rawText.trim() : '';
    if (text === '') {
      return { ok: false, error: 'empty', message: '文本框里还没有提示词，先写一点再拖我过来～' };
    }
    // 传输层用错编码时，Node 按 UTF-8 解会留下 U+FFFD。真让它打上游的话：
    // 模型看见一堆乱码照样回一句话——钱花了还拿到垃圾。先挡下来。
    if (text.indexOf('�') !== -1) {
      return {
        ok: false,
        error: 'encoding',
        message: '文本里有乱码字符（U+FFFD），说明传输编码不对——先确认文本框里显示正常，再拖一次',
      };
    }
    if (text.length > settings.maxInputChars) {
      return {
        ok: false,
        error: 'too-long',
        message: `提示词太长了（${text.length} 字，上限 ${settings.maxInputChars}），先精简一点再优化`,
      };
    }
    if (settings.apiKey === '') {
      return {
        ok: false,
        error: 'no-api-key',
        message: `还没配置 API key：把 key 填进 ${settings.file} 的 deepseekApiKey，或写进 $DSH_HOME/openai-gateway/api-key`,
      };
    }

    // 风格底稿取自 settings（每次都重新读，跟 model/uiMode 一样即时生效）。
    // 默认风格下 stylePrompt() 返回的正是 SYSTEM_PROMPT，所以这条路径不改变现有输出。
    const systemPrompt = systemPromptForStyle(variantKey, settings.promptStyle);
    // 缓存键带迭代轮数：iterateRounds 变了缓存就该失效。
    const hash = cacheKeyFor(settings, text, systemPrompt) + ITER_CACHE_TAIL + String(settings.iterateRounds) + ']';
    const cached = cacheGet(hash, settings);
    if (cached) {
      return {
        ok: true,
        optimized: cached.optimized,
        cached: true,
        unchanged: cached.unchanged === true,
        model: cached.model,
        // 缓存命中没花钱：不带 usage，客户端也就不会显示一个「上次的」token 数
      };
    }
    const running = inflight.get(hash);
    if (running) return running;

    const promise = (async () => {
      try {
        // ── 迭代打磨（2026-10-23 用户要求）──────────────────────────────────
        // 第 1 轮优化原文；第 2 轮起把上一轮的优化稿捕获回来当新输入继续打磨。
        // 每轮：换系统提示词（追加 ITERATION_SUFFIX）、换用户消息前缀
        // （ITERATION_USER_PREFIX，让模型知道这不是原文而是上一稿）、
        // usage/ms 逐轮累加。任一轮失败就带着那轮的错误返回（不掩盖）；
        // 某一轮 unchanged（模型说没得改）或轮数用尽就停。
        let current = text;
        let result = null;
        let totalUsage = null;
        let totalMs = 0;
        let rounds = 0;
        for (let round = 1; round <= settings.iterateRounds; round += 1) {
          rounds = round;
          const isFirst = round === 1;
          const roundPrompt = isFirst
            ? systemPrompt
            : systemPrompt + '\n\n' + ITERATION_SUFFIX;
          const roundPrefix = isFirst ? '【原始提示词】' : ITERATION_USER_PREFIX;
          const roundResult = await callUpstreamWithRetry(settings, current, roundPrompt, roundPrefix);
          if (roundResult.usage) totalUsage = addUsage(totalUsage, roundResult.usage);
          totalMs += roundResult.ms ?? 0;
          if (!roundResult.ok) {
            result = roundResult;
            break;
          }
          if (roundResult.unchanged || round >= settings.iterateRounds) {
            result = roundResult;
            break;
          }
          current = roundResult.optimized;
          result = roundResult;
        }
        if (result && result.ok) {
          result = {
            ...result,
            usage: totalUsage,
            ms: totalMs,
            // 客户端看到的 unchanged = 「最终稿与原文一字不差」；
            // 中间轮的 unchanged 只是「这一轮没改上一稿」，不代表整体没改动。
            unchanged: result.optimized === text,
            rounds,
          };
          log(
            'peak-whale: 优化完成 ' + text.length + '->' + result.optimized.length + ' 字'
            + '（迭代 ' + rounds + ' 轮）'
            + ',tokens ' + (result.usage ? result.usage.total : '?')
            + ',' + Math.round(result.ms) + 'ms'
            + (result.unchanged ? '（无改动）' : ''),
            'info',
          );
          cache.set(hash, {
            at: now(),
            optimized: result.optimized,
            model: result.model,
            unchanged: result.unchanged === true,
          });
          while (cache.size > 8) cache.delete(cache.keys().next().value);
        }
        return result;
      } finally {
        inflight.delete(hash);
      }
    })();

    inflight.set(hash, promise);
    return promise;
  };

  /**
   * 打一次上游，HTTP 429 时等 `retryDelayMs` 自动重试一次。
   *
   * 限流的请求**没被计费**，重试零成本风险；对用户来说「稍等 1.2 秒自动成功」
   * 远好于「看见报错自己再拖一次」。只重试一次：连续 429 是真限流，再打只是
   * 火上浇油；第二次的 timeoutMs 收窄为剩余时间，整体仍受原 timeoutMs 约束，
   * 不会把最长等待翻倍。`retryDelayMs` 传 0 = 立即重试，传负数 = 禁用重试。
   */
  async function callUpstreamWithRetry(settings, text, systemPrompt = SYSTEM_PROMPT, userPrefix = '【原始提示词】') {
    const first = await callUpstream(settings, text, systemPrompt, userPrefix);
    if (!first || first.error !== 'http-429' || retryDelayMs < 0) return first;
    if (retryDelayMs > 0) {
      log(`peak-whale: 上游限流，${retryDelayMs}ms 后自动重试一次`);
      await new Promise((resolve) => { setTimeout(resolve, retryDelayMs); });
    }
    const remaining = settings.timeoutMs - Math.max(0, retryDelayMs);
    const second = await callUpstream(remaining > 0 ? { ...settings, timeoutMs: remaining } : settings, text, systemPrompt, userPrefix);
    if (second && second.ok) log('peak-whale: 限流重试成功', 'info');
    return second;
  }
}

/** 三版的 key 顺序（界面气泡里按这个顺序排）。 */
export const VARIANT_KEYS = ['detailed', 'professional', 'auto'];

/** 串行模式下两版之间的间隔：给上游的速率窗口喘口气（匿名档 1 并发 + 秒级间隔）。 */
const SERIAL_GAP_MS = 1500;

/**
 * 跑三版优化（详细 / 专业 / AI 自主），默认**并行**打上游；`options.serial` 为 true 时
 * 串行依次打（版间 `SERIAL_GAP_MS`），供匿名免费档使用——那种档位同一时刻只放行
 * 1 个请求，三路齐发必有两版被 429 刷掉，四选一气泡就退化成单选。
 *
 * @param {(text: string, variantKey: string) => Promise<{ok:boolean, optimized?: string,
 *          message?: string, unchanged?: boolean, usage?: object|null, cached?: boolean,
 *          ms?: number}>} optimize
 *   `createOptimizeRunner` 返回的那个函数（它现在收第二参 `variantKey`）。
 * @param {string} text - 已 trim 的原文。
 * @param {{serial?: boolean}} [options] - serial=true 时串行打上游（匿名免费档用）。
 * @returns {Promise<{ok: boolean, variants?: Array<{key: string, label: string,
 *           optimized: string, unchanged: boolean, usage: object|null, cached: boolean,
 *           ms: number|null}>, message?: string}>}
 *   三版全挂才 `ok:false`；只要有一版成功就 `ok:true`，界面把成功的几版 + 「不优化」一起摆出来。
 */
export async function optimize3(optimize, text, options = {}) {
  const serial = !!(options && options.serial);
  let results;
  if (serial) {
    results = [];
    for (let i = 0; i < VARIANT_KEYS.length; i += 1) {
      // 上一版完整落地后隔 SERIAL_GAP_MS 再发下一版，匿名档才不会 429。
      if (i > 0) await new Promise((resolve) => { setTimeout(resolve, SERIAL_GAP_MS); });
      results.push(await optimize(text, VARIANT_KEYS[i]));
    }
  } else {
    results = await Promise.all(VARIANT_KEYS.map((key) => optimize(text, key)));
  }
  const variants = [];
  let firstError = null;
  for (let i = 0; i < VARIANT_KEYS.length; i += 1) {
    const key = VARIANT_KEYS[i];
    const r = results[i];
    if (r && r.ok && typeof r.optimized === 'string' && r.optimized !== '') {
      variants.push({
        key,
        label: VARIANT_LABELS[key],
        optimized: r.optimized,
        unchanged: r.unchanged === true,
        usage: r.usage ?? null,
        cached: r.cached === true,
        // 这一版实打实花了多久。缓存命中**没有** ms（没打上游，报「上次的」耗时同样是误导）
        ms: typeof r.ms === 'number' ? r.ms : null,
        // 迭代轮数：让界面能显示「迭代 2 轮」——用户看得见这一版到底磨了几回
        rounds: typeof r.rounds === 'number' ? r.rounds : 1,
      });
    } else if (!firstError) {
      firstError = (r && r.message) || '优化失败';
    }
  }
  if (variants.length === 0) {
    return { ok: false, message: firstError || '三版优化全失败了' };
  }
  return { ok: true, variants };
}

