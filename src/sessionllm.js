/**
 * 会话同路由优化通道 —— **Host 专用**（不进浏览器 bundle）。
 *
 * 目标：优化提示词用的模型 = 当前对话框用的模型。浏览器半身在拖拽瞬间读出
 * 当前会话的模型选择（provider/model/effort），随 POST body 一起送到 Host；
 * Host 借 `ctx.llm` 服务（与会话共用同一条适配器注册表、同一份凭据）
 * `prepareCall → stream` 走完全相同的路由。换机器、换供应商都零配置——
 * 对话框用什么，优化器就用什么；不同对话框各自的选择互不干扰。
 *
 * 官方参照：`dsh-session-title-llm`（会话标题生成）就是这条路的先例——同样是
 * 「插件在 Host 侧打一次辅助 LLM 调用」，同样走 `ctx.llm.prepareCall` +
 * `options = {...call.config, messages, system, purpose, signal}`。
 *
 * ── 通道选择（与旧通道的关系）─────────────────────────────────────────────
 * 路由优先级（见 index.js 两个路由处理器）：
 *   ① 请求带 route（浏览器读到了会话选择）→ 本通道
 *   ② 配了 webToken → 网页端通道（用户显式配置，维持旧行为；仅 optimize3）
 *   ③ llm 可用且全局默认模型可解析 → 本通道（默认路由）
 *   ④ 网关通道（baseUrl + key，兜底/测试；src/optimize.js）
 *
 * ── 为什么手搓消息对象而不 import 官方 helper ─────────────────────────────
 * `@deepseek-ai/dsh-llm` 的 createUserMessage/BlockAssembler 当然好用，但
 * peak-whale 的部署副本（local-packages / profile node_modules）不保证能解析
 * 内核包。适配器契约是**结构校验**（our-free-model 的 forward 监听器同样喂
 * 手搓的普通对象），所以这里用纯对象 + 一个逐 chunk 的拼装循环，零内核依赖。
 *
 * @module src/sessionllm.js
 */

import {
  addUsage,
  cleanOptimized,
  hashText,
  ITERATION_SUFFIX,
  ITERATION_USER_PREFIX,
  readSettings,
  systemPromptForStyle,
} from './optimize.js';

/** 缓存键里标记迭代模式的尾巴（与 optimize.js 的 ITER_CACHE_TAIL 同义，这里独立定义避免跨模块依赖私有常量）。 */
const ITER_CACHE_TAIL = '\n[iterate:';

/** route 各字段的长度上限：路由是本机 GUI 送来的，防脏数据无限膨胀。 */
const ROUTE_FIELD_MAX = {
  provider: 120,
  model: 200,
  reasoningEffort: 48,
  sessionId: 128,
};

/**
 * 从 HTTP body 里提取并校验会话路由提示。
 *
 * @param {unknown} payload - 已解析的请求体。
 * @returns {{provider: string, model: string, reasoningEffort?: string, sessionId?: string}|null}
 *   字段齐全且合法才返回路由；缺/坏一律 null（调用方据此回落旧通道）。
 */
export function routeHintOf(payload) {
  const route = payload && typeof payload === 'object' ? payload.route : null;
  return normalizeRoute(route);
}

/**
 * 把任意输入收敛成合法路由对象（导出给测试用）。
 *
 * @param {unknown} route
 * @returns {{provider: string, model: string, reasoningEffort?: string, sessionId?: string}|null}
 */
export function normalizeRoute(route) {
  if (!route || typeof route !== 'object' || Array.isArray(route)) return null;
  const str = (value, max) => {
    const s = typeof value === 'string' ? value.trim() : '';
    return s.length > 0 && s.length <= max ? s : null;
  };
  const provider = str(route.provider, ROUTE_FIELD_MAX.provider);
  const model = str(route.model, ROUTE_FIELD_MAX.model);
  if (provider === null || model === null) return null;
  const out = { provider, model };
  const effort = str(route.reasoningEffort, ROUTE_FIELD_MAX.reasoningEffort);
  if (effort !== null) out.reasoningEffort = effort;
  const sessionId = str(route.sessionId, ROUTE_FIELD_MAX.sessionId);
  if (sessionId !== null) out.sessionId = sessionId;
  return out;
}

/**
 * llm usage chunk → 界面用的 {prompt, completion, total}。
 *
 * 内核/各家适配器的 usage 字段名不完全一致（prompt_tokens / prompt / input /
 * inputTokens 都在野外出现过），这里多形态兼容；认不出数字就返回 null
 * （客户端对 null 的约定是「安静省略」，不显示假 0）。
 *
 * @param {unknown} usage - `{type:'usage', usage}` chunk 里的 usage 对象。
 * @returns {{prompt: number, completion: number, total: number}|null}
 */
export function usageOf(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const num = (value) => (Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null);
  const prompt = num(usage.prompt_tokens ?? usage.prompt ?? usage.input ?? usage.inputTokens);
  const completion = num(usage.completion_tokens ?? usage.completion ?? usage.output ?? usage.outputTokens);
  if (prompt === null && completion === null) return null;
  const total = num(usage.total_tokens ?? usage.total) ?? (prompt ?? 0) + (completion ?? 0);
  return { prompt: prompt ?? 0, completion: completion ?? 0, total };
}

/** 把 llm 失败翻成一句能直接显示给人看的中文。 */
function describeLlmFailure(route, code, detail) {
  const at = `${route.provider}/${route.model}`;
  if (code === 'NO_ADAPTER') {
    return `当前对话框用的路由 ${at} 在 Host 上没有已注册的适配器（对应的模型插件可能没启用），启用后再拖一次`;
  }
  if (code === 'UNSUPPORTED_REASONING_EFFORT') {
    return `${at} 不支持这个思考档位；在对话框里换个档位，或用默认档再试`;
  }
  if (code === 'RATE_LIMIT') {
    return `模型限流了（${at}），稍等几秒再拖一次`;
  }
  if (code === 'AUTH' || code === 'INVALID_CREDENTIAL') {
    return `${at} 的凭据无效或过期，先在 DSH 里把该模型的登录/密钥修好`;
  }
  return `会话路由调用失败（${at}${code ? `，${code}` : ''}）${detail ? `：${detail}` : ''}`;
}

/**
 * configure 回调：思考档位只在模型声明支持时透传，否则交给适配器默认值。
 *
 * 硬塞一个模型不认识的档位会吃 UNSUPPORTED_REASONING_EFFORT（prepareCall 在
 * 上游 I/O 之前就抛）；模型的 efforts 列表读不到时同样不强塞——宁可走默认档。
 *
 * @param {object} route - 已收敛的路由。
 * @param {object} controls - prepareCall 传入的（去掉 provider/model 的）控制项。
 * @param {object} modelInfo - 适配器返回的模型能力信息。
 * @returns {object} 调整后的控制项。
 */
function selectControls(route, controls, modelInfo) {
  const wanted = typeof route.reasoningEffort === 'string' && route.reasoningEffort !== ''
    ? route.reasoningEffort
    : undefined;
  if (wanted === undefined) return { ...controls };
  const reasoning = modelInfo && typeof modelInfo === 'object' ? modelInfo.reasoning : undefined;
  const efforts = reasoning && Array.isArray(reasoning.efforts)
    ? reasoning.efforts
      .map((e) => (e && typeof e === 'object' && typeof e.id === 'string' ? e.id : (typeof e === 'string' ? e : null)))
      .filter((id) => typeof id === 'string')
    : null;
  // 模型没声明任何档位信息 → 不强塞；声明了但不包含想要的 → 也不塞，走默认。
  const effort = efforts !== null && !efforts.includes(wanted) ? undefined : wanted;
  return { ...controls, ...(effort !== undefined ? { reasoningEffort: effort } : {}) };
}

/**
 * 创建「优化一段文本（走会话同路由）」的函数：读配置 → 查缓存 → 借 llm 打上游
 * → 收敛输出。返回形状与网关通道的 runner 完全一致，optimize3 无需区分。
 *
 * @param {{file: string, env?: object, now?: () => number,
 *          llm?: () => object|null, fallbackRoute?: () => object|null,
 *          log?: (message: string, level?: string) => void}} options
 *   `llm`：取 ctx.llm 服务的函数（服务晚就绪，每次调用现取）；
 *   `fallbackRoute`：路由提示缺失时取全局默认模型的函数（agentDefaultModel）。
 * @returns {(text: string, variantKey?: string, routeHint?: object|null) =>
 *   Promise<{ok: boolean, optimized?: string, message?: string, error?: string,
 *   cached?: boolean, unchanged?: boolean, model?: string, effort?: string,
 *   usage?: {prompt: number, completion: number, total: number}|null, ms?: number}>}
 */
export function createSessionRouteRunner(options = {}) {
  const file = options.file;
  const env = options.env ?? process.env;
  const now = options.now ?? (() => Date.now());
  const log = options.log ?? (() => {});
  const llmOf = typeof options.llm === 'function' ? options.llm : () => (options.llm ?? null);
  const fallbackRouteOf = typeof options.fallbackRoute === 'function' ? options.fallbackRoute : () => null;

  /** hash → { at, optimized, model, unchanged } */
  const cache = new Map();
  /** hash → in-flight promise（同一份原文+路由并发只打一次上游） */
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

  /**
   * 借 llm 服务打一次「会话同路由」的优化调用。
   *
   * 超时单保险说明：AbortController 让守规矩的适配器真的断流；timedOut 标志
   * 在每个 chunk 到达时复查，保证即使 signal 被无视也能在超时点附近返回。
   * （官方 dsh-session-title-llm 同款策略：deadline signal + 循环内 throwIfAborted。）
   */
  async function callViaLlm(llm, settings, route, text, systemPrompt, userPrefix) {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        controller.abort();
      } catch { /* 已经断了 */ }
    }, settings.timeoutMs);
    const started = now();
    const timeoutResult = () => ({
      ok: false,
      error: 'timeout',
      message: `等了 ${Math.round(settings.timeoutMs / 1000)} 秒还没想完，稍后再试`,
    });
    try {
      const call = await llm.prepareCall(
        { provider: route.provider, model: route.model },
        controller.signal,
        (controls, modelInfo) => selectControls(route, controls, modelInfo),
      );
      const messages = [{
        role: 'user',
        content: [{ type: 'text', text: `${userPrefix || '【原始提示词】'}\n${text}` }],
        source: { kind: 'peak-whale-optimize' },
      }];
      // options 必须包含 call.config 的全部字段（callConfigEquals 会比对），
      // 所以直接展开它再补 messages/system 等载荷字段。
      const streamOptions = {
        ...call.config,
        messages,
        system: systemPrompt,
        purpose: 'peak-whale-optimize',
        ...(route.sessionId !== undefined ? { sessionId: route.sessionId } : {}),
        signal: controller.signal,
      };
      // 流式拼装：只收 text-delta（思考/工具调用对优化器无意义），
      // usage 与 finish 各记最后一个；索引按首次出现顺序拼接。
      const texts = new Map();
      const order = [];
      let usageRaw = null;
      let finish = null;
      for await (const chunk of call.stream(streamOptions)) {
        if (timedOut) return timeoutResult();
        if (!chunk || typeof chunk !== 'object') continue;
        if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
          if (!texts.has(chunk.index)) {
            texts.set(chunk.index, '');
            order.push(chunk.index);
          }
          texts.set(chunk.index, texts.get(chunk.index) + chunk.text);
        } else if (chunk.type === 'usage') {
          usageRaw = chunk.usage;
        } else if (chunk.type === 'finish') {
          finish = chunk.reason;
        }
      }
      if (timedOut) return timeoutResult();
      const kind = finish && typeof finish.kind === 'string' ? finish.kind : 'stop';
      // ── 截断守卫：与网关通道同一句话、同一个 error 码，客户端不用区分通道 ──
      if (kind === 'max-tokens') {
        log(`peak-whale: 会话路由优化被 max_tokens 截断（${route.provider}/${route.model}）`);
        return {
          ok: false,
          error: 'finish-length',
          message: '优化结果被输出长度上限截断了，半截提示词不能写回——把原文精简一点再试',
        };
      }
      if (kind === 'error' || kind === 'aborted') {
        const failure = finish && finish.failure;
        const code = failure && typeof failure.code === 'string' ? failure.code : '';
        const detail = failure && failure.message ? String(failure.message).slice(0, 160) : '';
        log(`peak-whale: 会话路由优化失败（${code || kind}）`);
        return {
          ok: false,
          error: `llm-${code || kind}`,
          message: describeLlmFailure(route, code || kind, detail),
        };
      }
      const content = order.map((index) => texts.get(index)).join('');
      const optimized = cleanOptimized(content);
      if (optimized === null) {
        return { ok: false, error: 'empty-result', message: '模型没返回可用内容，再拖一次试试' };
      }
      return {
        ok: true,
        optimized,
        unchanged: optimized === text,
        model: route.model,
        effort: typeof route.reasoningEffort === 'string' ? route.reasoningEffort : '',
        usage: usageOf(usageRaw),
        ms: now() - started,
      };
    } catch (error) {
      if (timedOut || (error && (error.name === 'AbortError' || error.code === 'ABORT_ERR'))) {
        return timeoutResult();
      }
      const code = error && typeof error.code === 'string' ? error.code : '';
      const detail = error && error.message ? String(error.message).slice(0, 200) : String(error);
      log(`peak-whale: 会话路由优化异常：${detail}`);
      return { ok: false, error: code ? `llm-${code}` : 'network', message: describeLlmFailure(route, code, detail) };
    } finally {
      clearTimeout(timer);
    }
  }

  return async function optimizeViaSession(rawText, variantKey, routeHint) {
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
    if (text.indexOf('\uFFFD') !== -1) {
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
    const llm = llmOf();
    // 只检查 prepareCall：流入口在 call.stream（prepareCall 的返回物）上，
    // 顶层 llm.stream 是内核服务的便利方法，本通道不经过它，不作为就绪条件。
    if (!llm || typeof llm.prepareCall !== 'function') {
      return { ok: false, error: 'no-llm', message: 'Host 的 llm 服务还没就绪（或本组合不提供），稍后再试' };
    }
    const route = normalizeRoute(routeHint) ?? normalizeRoute(fallbackRouteOf());
    if (route === null) {
      return {
        ok: false,
        error: 'no-route',
        message: '没读到当前对话框的模型选择；在对话框里选一次模型再拖，或回落网关通道（settings.json）',
      };
    }
    // 风格底稿取自 settings（每次都重新读，与网关通道同一份逻辑）。
    const systemPrompt = systemPromptForStyle(variantKey, settings.promptStyle);
    // 缓存键带路由：换了对话框（=换了模型）不该吃到上一个模型的旧稿。
    const hash = `sr:${hashText(['v1', route.provider, route.model, route.reasoningEffort ?? '', systemPrompt, text].join('\u0000'))}${ITER_CACHE_TAIL}${settings.iterateRounds}]`;
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
        // ── 迭代打磨（2026-10-23 用户要求，与网关通道同一套逻辑）──────────
        // 第 1 轮优化原文；第 2 轮起把上一轮的优化稿捕获回来当新输入继续打磨。
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
          const roundResult = await callViaLlm(llm, settings, route, current, roundPrompt, roundPrefix);
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
            unchanged: result.optimized === text,
            rounds,
          };
          log(
            'peak-whale: 会话路由优化完成 ' + text.length + '->' + result.optimized.length + ' 字'
            + '（' + route.provider + '/' + route.model + '，迭代 ' + rounds + ' 轮）'
            + ',tokens ' + (result.usage ? result.usage.total : '?')
            + ',' + Math.round(result.ms) + 'ms'
            + (result.unchanged ? '（无改动）' : ''),
            'info',
          );
          cache.set(hash, {
            at: now(),
            optimized: result.optimized,
            model: route.model,
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
}
