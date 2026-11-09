/**
 * 薄入口。这个文件必须能求值，引擎加载失败也不能把这里抛掉。
 * Thin entry. This file must evaluate even when the engine cannot load.
 * A throw here leaves stock disabled and /compact waiting.
 *
 * 配置预先检查失败时不构造引擎，也不再构造原版，避免报错被盖成「服务已被注册」。
 * On a preflight failure, construct neither engine. Stock would register and hide the real error.
 */
import { loadBase, loadCompaction } from "./adapter.js";

let Engine = null;
let Stock = null;
let CompactionEngine = null;
let ManualCompactionError = null;
let loadError = null;

if (process.env.SPINE_ENGINE_FAIL === "import") {
  loadError = new Error("spine: engine import refused");
} else {
  try {
    const engine = await import("./index.js");
    Engine = engine.default;
  } catch (error) {
    loadError = error instanceof Error ? error : new Error(String(error));
  }
}

try {
  const compaction = await loadCompaction();
  CompactionEngine = compaction.CompactionEngine;
  ManualCompactionError = compaction.ManualCompactionError;
} catch (error) {
  loadError ??= error instanceof Error ? error : new Error(String(error));
}

try {
  const stock = await loadBase();
  Stock = stock.BasicCompactionEngine;
} catch (error) {
  if (!loadError) loadError = error instanceof Error ? error : new Error(String(error));
}

function reasonText(error) {
  return error instanceof Error ? error.message : String(error);
}

export function preflightConfig(config = {}) {
  if (!config || typeof config !== "object") return;
  const threshold = config.thresholdRatio;
  if (typeof threshold !== "number") return;
  if (config.retainTokens !== undefined) return;
  const ratio = config.retainRatio ?? 0.16;
  if (ratio >= threshold) {
    throw new Error(`BasicCompactionConfig: retainRatio (${ratio}) must be less than the resolved thresholdRatio (${threshold})`);
  }
}

function releaseCompaction(ctx) {
  const store = ctx?.reflect?.store;
  if (!store) return false;
  const keys = [...Object.getOwnPropertySymbols(store), ...Object.keys(store)];
  for (const key of keys) {
    if (store[key]?.name !== "compaction") continue;
    delete store[key];
    if (ctx.fiber?.store) delete ctx.fiber.store.compaction;
    return true;
  }
  return false;
}

function visibleTakeover(ctx, reason) {
  const line = `spine: ${MARK}。${reason}`;
  console.error(line);
  ctx?.logger?.warn?.(line);
}

const MARK = "本会话未接管";

const UnavailableCompaction = CompactionEngine
  ? class extends CompactionEngine {
    constructor(ctx, reason) {
      super(ctx);
      this.reason = reason;
      ctx.logger?.warn?.(`spine: ${MARK}。压缩没有装上，这一刀没有执行。${reason}`);
    }

    compactIfNeeded() {
      return Promise.reject(new Error(`spine: ${MARK}。压缩没有装上，这一刀没有执行。${this.reason}`));
    }

    compactNow() {
      const message = `spine: ${MARK}。压缩没有装上，这一刀没有执行。${this.reason}`;
      if (ManualCompactionError) return Promise.reject(new ManualCompactionError("summary", message));
      return Promise.reject(new Error(message));
    }
  }
  : null;

export default class LiveCompactEntry {
  static inject = ["llm", "tokenMeter", "sessions"];
  static Config = Stock?.Config || Engine?.Config;

  constructor(ctx, config) {
    let cause = loadError;
    let skipStock = process.env.SPINE_ENGINE_FAIL === "construct";
    if (skipStock) cause = new Error("spine: constructor refused");
    if (!loadError && !skipStock) {
      try {
        preflightConfig(config);
      } catch (error) {
        cause = error instanceof Error ? error : new Error(String(error));
        skipStock = true;
      }
    }
    if (!loadError && !skipStock && Engine) {
      try {
        return new Engine(ctx, config);
      } catch (error) {
        cause = error instanceof Error ? error : new Error(String(error));
        releaseCompaction(ctx);
        skipStock = true;
      }
    }
    cause ??= new Error("spine: engine missing");
    if (!skipStock && process.env.SPINE_STOCK_FAIL !== "1" && Stock) {
      try {
        visibleTakeover(ctx, `这一轮用原版压缩。${reasonText(cause)}`);
        return new Stock(ctx, config);
      } catch (error) {
        cause = error instanceof Error ? error : new Error(String(error));
        releaseCompaction(ctx);
      }
    }
    visibleTakeover(ctx, reasonText(cause));
    if (!UnavailableCompaction) throw new Error(`spine: ${MARK}。压缩接口没有装上。${reasonText(cause)}`);
    return new UnavailableCompaction(ctx, reasonText(cause));
  }
}
