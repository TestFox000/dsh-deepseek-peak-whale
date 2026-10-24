/**
 * DeepSeek 网页端 PoW（proof-of-work）求解器。
 *
 * chat.deepseek.com 的 /api/v0/chat/completion 要求先解一道 PoW：
 *   POST /api/v0/chat/create_pow_challenge {target_path:"/api/v0/chat/completion"}
 *   → {algorithm:"DeepSeekHashV1", challenge, salt, difficulty, signature, expire_at, expire_after}
 *   → 用 WASM（sha3_wasm_bg）求出 answer
 *   → answer 作为 header 跟 completion 请求一起发（header 名/值由网页端的 Bx() 构造）
 *
 * 这里直接复用 DeepSeek 自己的 WASM 求解器（下载 sha3_wasm_bg.wasm → instantiate →
 * 调 wasm_solve），不重新实现 hashcash 循环——循环在 WASM 里，照搬最稳。
 *
 * **脆弱点**：WASM 的 URL/hash（`7b9ca65ddd`）随 DeepSeek 每次网页发版而变。
 * 变了就解不动 PoW，要重新抓包拿新 URL。WebChatCaller 会先探一次最新 URL。
 */

import fs from 'node:fs';
import path from 'node:path';
import { webcrypto } from 'node:crypto';

const DEFAULT_WASM_URL = 'https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm';

/**
 * @param {{wasmUrl?: string, wasmPath?: string, fetchImpl?: Function, log?: Function}} opts
 *   `wasmPath`：本地缓存的 WASM 路径；有就直接读，省一次下载。
 */
export async function createPowSolver(opts = {}) {
  const log = opts.log ?? (() => {});
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const wasmUrl = opts.wasmUrl ?? DEFAULT_WASM_URL;

  let exports = null;
  let loadPromise = null; // 并发防抖：三路同时来只实例化一次

  async function loadWasm() {
    if (exports) return exports;
    if (loadPromise) return loadPromise;
    loadPromise = (async () => {
      let bytes = null;
      // ① 本地缓存优先（避免每次启动都下 26KB）
      if (opts.wasmPath) {
        try {
          bytes = fs.readFileSync(opts.wasmPath);
          log('peak-whale: PoW WASM 从本地缓存加载');
        } catch { /* 没缓存，往下走下载 */ }
      }
      if (!bytes) {
        if (!fetchImpl) throw new Error('PoW 求解器需要 fetch 来下载 WASM，但当前环境没有 fetch');
        log('peak-whale: 下载 PoW WASM…');
        const resp = await fetchImpl(wasmUrl);
        if (!resp || !resp.ok) throw new Error(`下载 WASM 失败：HTTP ${resp ? resp.status : '?'}`);
        const ab = await resp.arrayBuffer();
        bytes = Buffer.from(ab);
        if (opts.wasmPath) {
          try {
            fs.mkdirSync(path.dirname(opts.wasmPath), { recursive: true });
            fs.writeFileSync(opts.wasmPath, bytes);
            log('peak-whale: PoW WASM 已缓存到本地');
          } catch { /* 缓存写不进就算了 */ }
        }
      }
      const { instance } = await WebAssembly.instantiate(bytes, { wbg: {} });
      exports = instance.exports;
      return exports;
    })();
    try {
      return await loadPromise;
    } finally {
      loadPromise = null;
    }
  }

  /** 把 JS 字符串写进 WASM 线性内存，返回 {ptr, len}（wasm-bindgen passStringToWasm）。 */
  function passString(str) {
    const enc = new TextEncoder().encode(str);
    const ptr = exports.__wbindgen_export_0(enc.length, 1) >>> 0; // malloc(len, align=1)
    new Uint8Array(exports.memory.buffer, ptr, enc.length).set(enc);
    return { ptr, len: enc.length };
  }

  /**
   * 解一道 PoW challenge。
   * @param {{algorithm: string, challenge: string, salt: string,
   *           difficulty: number, signature: string, expire_at?: number,
   *           expireAt?: number}} challenge
   * @returns {{algorithm: string, challenge: string, salt: string,
   *            answer: number, signature: string}}
   */
  async function solve(challenge) {
    await loadWasm();
    const algorithm = challenge.algorithm;
    const ch = challenge.challenge;
    const salt = challenge.salt;
    const difficulty = challenge.difficulty;
    const signature = challenge.signature;
    // 网页端字段是 expire_at（snake_case），worker 里解构成 expireAt；两种都接。
    const expireAt = challenge.expireAt ?? challenge.expire_at;
    if (algorithm !== 'DeepSeekHashV1') {
      throw new Error('不支持的 PoW 算法：' + algorithm);
    }
    // prefix = salt + "_" + expireAt + "_"（与网页端 worker 一致）
    const prefix = `${salt}_${expireAt}_`;
    const sp = exports.__wbindgen_add_to_stack_pointer(-16);
    const c = passString(ch);
    const p = passString(prefix);
    // wasm_solve(stack, challenge_ptr, challenge_len, prefix_ptr, prefix_len, difficulty)
    exports.wasm_solve(sp, c.ptr, c.len, p.ptr, p.len, difficulty);
    const view = new DataView(exports.memory.buffer);
    const status = view.getInt32(sp + 0, true);
    const answer = view.getFloat64(sp + 8, true);
    exports.__wbindgen_add_to_stack_pointer(16);
    if (status === 0) {
      throw new Error(`PoW 无解（algorithm=${algorithm}, difficulty=${difficulty}）`);
    }
    return { algorithm, challenge: ch, salt, answer, signature };
  }

  return { solve, loadWasm };
}
