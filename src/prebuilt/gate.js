import { createRequire } from "node:module";
import { STOCK_ENGINE as STOCK } from "./adapter.js";

// 【本地化】包名改为 dsh-live-compact-local（原 "dsh-live-compact"）
const OURS = "dsh-live-compact-local";
const PRESET_IDS = new Set(["standard", "ptc", "minimal", "cordis", "preset-standard", "preset-ptc", "preset-minimal", "preset-cordis"]);
export const GATE_SERVICE = "liveCompactPresetGate";
export const PRESET_ENGINE_CONFIG = {
  auto: true,
  thresholdRatio: Number(process.env.SPINE_THRESHOLD_RATIO || 0.8),
  headroomTokens: Number(process.env.SPINE_HEADROOM_TOKENS || 65536),
  retainTokens: Number(process.env.SPINE_RETAIN_TOKENS || 8192),
  compactionRetries: 0,
};

const require = createRequire(import.meta.url);

export function packageLoadable(load = (name) => require(name)) {
  try {
    load(OURS);
    return true;
  } catch (error) {
    // The shell uses top-level await so a failed engine does not fail this package.
    // require() refuses that shape even when import() can load it.
    if (error?.code !== "ERR_REQUIRE_ASYNC_MODULE" && error?.code !== "ERR_REQUIRE_ESM") return false;
    try {
      require.resolve(OURS);
      return true;
    } catch {
      return false;
    }
  }
}

function isPreset(node) {
  if (!node || typeof node !== "object") return false;
  if (PRESET_IDS.has(node.id)) return true;
  return Boolean(node.config && typeof node.config === "object" && !Array.isArray(node.config) && PRESET_IDS.has(node.config.id));
}

function withEngineConfig(entry) {
  const previous = entry.config && typeof entry.config === "object" && !Array.isArray(entry.config) ? entry.config : {};
  return { ...PRESET_ENGINE_CONFIG, ...previous };
}

function rewriteEntry(entry, loadable) {
  if (!entry || typeof entry !== "object") return entry;
  const next = { ...entry };
  if (entry.name === STOCK) {
    if (!loadable) return entry;
    next.name = OURS;
    next.config = withEngineConfig(entry);
    return next;
  }
  if (Array.isArray(entry.config)) next.config = entry.config.map((item) => rewriteEntry(item, loadable));
  else if (entry.config && typeof entry.config === "object") next.config = rewriteNode(entry.config, loadable);
  return next;
}

function rewriteNode(node, loadable) {
  if (Array.isArray(node)) return node.map((item) => rewriteEntry(item, loadable));
  if (!node || typeof node !== "object") return node;
  const next = { ...node };
  if (Array.isArray(node.plugins)) next.plugins = node.plugins.map((item) => rewriteEntry(item, loadable));
  if (Array.isArray(node.config)) next.config = node.config.map((item) => rewriteEntry(item, loadable));
  else if (node.config && typeof node.config === "object") next.config = rewriteNode(node.config, loadable);
  return next;
}

export function rewritePresetConfig(config, loadable = packageLoadable()) {
  if (!isPreset(config)) return config;
  return rewriteNode(config, loadable);
}

function engineEntry(node) {
  if (!node || typeof node !== "object") return null;
  if (node.name === OURS) return node;
  const nested = [];
  if (Array.isArray(node.plugins)) nested.push(...node.plugins);
  if (Array.isArray(node.config)) nested.push(...node.config);
  else if (node.config && typeof node.config === "object") nested.push(node.config);
  for (const item of nested) {
    const found = engineEntry(item);
    if (found) return found;
  }
  return null;
}

export default class LiveCompactGate {
  constructor(ctx) {
    const seen = new Set();
    ctx.on("internal/config", function (_raw, next) {
      const resolved = next();
      try {
        const loadable = packageLoadable();
        const rewritten = rewritePresetConfig(resolved, loadable);
        const id = rewritten?.id || rewritten?.config?.id;
        if (isPreset(resolved) && id && !seen.has(String(id))) {
          seen.add(String(id));
          const engine = engineEntry(rewritten);
          if (engine) {
            const config = engine.config || {};
            ctx.logger?.info?.(`spine: 预设 ${id} 已换包 ${engine.name} thresholdRatio=${config.thresholdRatio} headroomTokens=${config.headroomTokens} retainTokens=${config.retainTokens} compactionRetries=${config.compactionRetries}`);
          } else if (!loadable) {
            ctx.logger?.warn?.(`spine: 本会话未接管预设 ${id}，仍用原版压缩。`);
          }
        }
        return rewritten;
      } catch {
        return resolved;
      }
    }, { global: true });
    ctx.provide(GATE_SERVICE, {});
  }
}
