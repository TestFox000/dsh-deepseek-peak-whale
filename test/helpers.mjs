/**
 * 测试公共工具：在 Node 里重建浏览器端的 module-loader 握手，
 * 这样不必开浏览器、也不必起 Harness 运行时就能驱动 client.js。
 *
 * window 桩给出漫游组件需要的最小面（尺寸、事件、计时器），计时器全部是空实现：
 * 副作用会同步跑一遍 setup，但不会真的排出定时任务把测试进程挂住。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const NAME = 'dsh-deepseek-peak-whale';

/**
 * document 桩：收下被插入的 `<style>`，并**记下组件注册/摘除的监听器**——
 * 「打字回避」这条链路就是靠它断言的（挂载后必须监听 keydown/input/focus*，
 * 卸载后必须摘干净）。
 */
export function makeDocumentStub() {
  const styles = [];
  const listeners = [];
  const removed = [];
  return {
    styles,
    listeners,
    removed,
    document: {
      listeners,
      removed,
      head: {
        appendChild(element) {
          styles.push(element);
        },
      },
      createElement() {
        return {
          attrs: {},
          textContent: '',
          setAttribute(key, value) {
            this.attrs[key] = value;
          },
          remove() {},
        };
      },
      addEventListener(type) {
        listeners.push(type);
      },
      removeEventListener(type) {
        removed.push(type);
      },
    },
  };
}

/** 最小 DOM 节点桩：够组件读写 style / 尺寸 / 文本，不做真实布局。 */
export function makeNodeStub(tag) {
  return {
    tagName: String(tag || 'div').toUpperCase(),
    style: {},
    hidden: false,
    textContent: '',
    children: [],
    getBoundingClientRect() {
      return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 };
    },
    setAttribute() {},
    removeAttribute() {},
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    removeChild(child) {
      const i = this.children.indexOf(child);
      if (i >= 0) this.children.splice(i, 1);
      return child;
    },
    addEventListener() {},
    removeEventListener() {},
    remove() {},
  };
}

/**
 * 最小 React 桩 —— 带 hook 槽位，因此**能真正重渲染**。
 *
 * 为什么值得做：组件把状态放在 `useState` 里，如果 setState 不触发重渲染，
 * 测试就只能断言「调用没抛错」。有了 hook 槽位就能断言「按下之后姿态变成 held」
 * 「拖动后坐标变了」这类**行为结果**，而不是仅确认没崩。
 *
 * `useEffect` 只在首次渲染执行（用槽位标记），与真实 React 的语义一致；
 * 清理函数不收集（测试里不需要）。
 */
export function makeReactStub() {
  const hooks = [];
  let cursor = 0;
  let onChange = () => {};
  // effect 必须等本次 render 返回之后再跑（真实 React 是提交后跑）。
  // 否则组件在 body 里读 ref.current 会拿到 null —— 元素树还没建出来。
  let pendingEffects = [];
  /** effect 返回的清理函数（`React.__unmount()` 会跑完它们）。 */
  const cleanups = [];

  const React = {
    Fragment: Symbol('Fragment'),
    setterCalls: [],
    createElement(type, props, ...children) {
      // 给带 ref 的元素塞一个最小 DOM 桩：这样组件 effect 里的
      // `stageRef.current` 之类不会为 null，初始化路径才能真正被走到。
      if (props && props.ref && typeof props.ref === 'object') {
        props.ref.current = makeNodeStub(type);
      }
      return {
        type,
        props: props ?? {},
        children: children
          .flat(Infinity)
          .filter((child) => child !== null && child !== undefined && child !== false),
      };
    },
    useState(initial) {
      const i = cursor++;
      if (!(i in hooks)) hooks[i] = typeof initial === 'function' ? initial() : initial;
      const setter = (value) => {
        React.setterCalls.push(value);
        hooks[i] = typeof value === 'function' ? value(hooks[i]) : value;
        onChange();
      };
      return [hooks[i], setter];
    },
    useEffect(effect) {
      const i = cursor++;
      if (i in hooks) return;
      hooks[i] = true;
      if (typeof effect === 'function') pendingEffects.push(effect);
    },
    useRef(initial) {
      const i = cursor++;
      if (!(i in hooks)) hooks[i] = { current: initial === undefined ? null : initial };
      return hooks[i];
    },
    useMemo(fn) {
      cursor += 1;
      return fn();
    },
  };

  /**
   * 挂载一个组件函数并返回一个盒子，`box.current` 永远是最新一次渲染的元素树。
   * 之后任何 setState 都会同步重渲染，测试可以直接检查渲染结果。
   *
   * effect 的返回值（清理函数）会被攒起来，`React.__unmount()` 一次跑完 ——
   * 「卸载时要把监听器摘干净」这类断言靠它。
   */
  React.__mount = (render) => {
    const box = { current: null, renders: 0 };
    const flush = () => {
      const queued = pendingEffects;
      pendingEffects = [];
      for (const effect of queued) {
        const off = effect();
        if (typeof off === 'function') cleanups.push(off);
      }
    };
    hooks.length = 0;
    pendingEffects = []; // 丢掉上一次（非 mount 方式）渲染留下的陈旧 effect
    cleanups.length = 0;
    cursor = 0;
    onChange = () => {
      cursor = 0;
      box.current = render();
      box.renders += 1;
      flush();
    };
    cursor = 0;
    box.current = render();
    box.renders = 1;
    flush();
    return box;
  };

  /** 卸载：按后进先出跑一遍 effect 清理函数。 */
  React.__unmount = () => {
    while (cleanups.length > 0) {
      const off = cleanups.pop();
      off();
    }
  };

  return React;
}

/** 按浏览器的握手方式加载 client.js，返回其导出。 */
export function loadClientBundle() {
  const source = readFileSync(join(ROOT, 'client.js'), 'utf8');
  let registration = null;
  const windowEvents = [];
  const windowStub = {
    __ModuleLoader__: {
      load(definition) {
        registration = definition;
      },
    },
    innerWidth: 1280,
    innerHeight: 820,
    addEventListener(type) {
      windowEvents.push(type);
    },
    removeEventListener() {},
    // 计时器空实现：同步跑完 setup，不排出真实任务
    setTimeout() {
      return 0;
    },
    clearTimeout() {},
    setInterval() {
      return 0;
    },
    clearInterval() {},
  };

  const doc = makeDocumentStub();
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', source)(windowStub, doc.document);

  const React = makeReactStub();
  const exports =
    registration === null
      ? null
      : registration.factory((specifier) => {
          if (specifier === 'react') return React;
          throw new Error(`意外的 require("${specifier}")：浏览器半身必须自包含`);
        });

  return { registration, exports, doc, React, source, windowStub, windowEvents };
}

/** 深度收集元素树里的文本。 */
export function collectText(node, out = []) {
  if (node === null || node === undefined || node === false || node === true) return out;
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out);
    return out;
  }
  if (typeof node === 'object' && Array.isArray(node.children)) {
    for (const child of node.children) collectText(child, out);
  }
  return out;
}

/** 深度查找指定 type 的元素。 */
export function findAll(node, type, out = []) {
  if (node === null || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, type, out);
    return out;
  }
  if (node.type === type) out.push(node);
  if (Array.isArray(node.children)) for (const child of node.children) findAll(child, type, out);
  return out;
}

/** 深度查找带指定 class 的元素（按空白切分的 token 匹配，不要求 className 完全相等）。 */
export function findByClass(node, className, out = []) {
  if (node === null || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const child of node) findByClass(child, className, out);
    return out;
  }
  const cls = node.props && node.props.className;
  if (typeof cls === 'string' && cls.split(/\s+/).indexOf(className) !== -1) out.push(node);
  if (Array.isArray(node.children)) for (const child of node.children) findByClass(child, className, out);
  return out;
}

/**
 * 把全局 Date 钉在某个时刻，便于确定性地测试「现在」。
 * 只影响无参 `new Date()`；带参构造（核心逻辑内部大量使用）原样透传。
 */
export function withFakeNow(iso, fn) {
  const RealDate = Date;
  const fixed = new RealDate(iso).getTime();
  class FakeDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(fixed);
      else super(...args);
    }
    static now() {
      return fixed;
    }
  }
  globalThis.Date = FakeDate;
  try {
    return fn();
  } finally {
    globalThis.Date = RealDate;
  }
}
