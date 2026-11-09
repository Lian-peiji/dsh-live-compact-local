/**
 * 备份文件。按会话分目录，默认上限 256MB，快满时删最老的。
 * Shadow files live in per-session directories. Default cap is 256MB; delete the oldest when nearly full.
 *
 * 删除顺序：根目录旧文件，死会话，当前会话的旧文件。
 * 不删当前卡片指向的文件，也不删别的还活着的会话。ENOENT 当成已经删掉。
 * Delete legacy root files, then dead sessions, then old files of the current session.
 * Never delete the current card's file or another live session. ENOENT counts as already freed.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve, win32 } from "node:path";

const DRIVE_ROOT = /^[A-Za-z]:[\\/]/;
const PLUGIN_NAME = /^(?:(?:cut|official|shadow)-\d+-[0-9a-f]{8}|raw-[0-9a-f]{16}|\d+-[0-9a-f]{8}-[0-9a-f]{8}|\d+-[0-9a-f]{8,16})\.txt$/;
let cachedSid = "";
const lockedDirs = new Set();
let shadowFuse = false;
const shadowWarnings = new Set();

export function resetShadowAccessState() {
  cachedSid = "";
  lockedDirs.clear();
  shadowFuse = false;
  shadowWarnings.clear();
}

export function shadowAccessFused() {
  return shadowFuse;
}

function tripFuse() {
  shadowFuse = true;
}

function envValue(env, name) {
  if (!env) return "";
  const found = Object.keys(env).find((key) => key.toLowerCase() === name.toLowerCase());
  return found ? String(env[found] ?? "").trim() : "";
}

export function windowsSystemRoot(env = process.env) {
  const systemRoot = envValue(env, "SystemRoot");
  const windir = envValue(env, "windir");
  const root = (DRIVE_ROOT.test(systemRoot) ? systemRoot : "") || (DRIVE_ROOT.test(windir) ? windir : "");
  return root.replace(/[\\/]+$/, "");
}

export function win32Tool(name, env = process.env) {
  const root = windowsSystemRoot(env);
  if (!root) {
    const error = new Error("spine: Windows system root is not a drive path");
    error.code = "ESHADOWACCESS";
    throw error;
  }
  return win32.join(root, "System32", name);
}

function lockKey(path) {
  return resolve(path).replace(/[\\/]+$/, "").toLowerCase();
}

export function shadowDirLocked(path) {
  return lockedDirs.has(lockKey(path));
}

export function noteShadowWarning(logger, error) {
  const code = error?.code || "ESHADOWACCESS";
  if (shadowWarnings.has(code)) return;
  shadowWarnings.add(code);
  const status = error?.cause?.status ?? error?.status;
  const step = error?.step || error?.cause?.step || "";
  const where = step ? ` ${step}` : "";
  const exit = status == null ? "" : ` exit ${status}`;
  logger?.warn?.(`spine: shadow permission failed ${code}${where}${exit}`);
}
const SESSION_MARK = /^# spine-session (\S+)/;

export function isPluginShadowName(name) {
  return PLUGIN_NAME.test(name);
}

export function sanitizeSessionKey(key) {
  const safe = String(key || "default").replace(/[^A-Za-z0-9_-]/g, "");
  return safe || "default";
}

export function sessionDir(root, key) {
  return join(root, sanitizeSessionKey(key));
}

function ownerPid(dir) {
  try {
    const text = readFileSync(join(dir, "owner"), "utf8").trim();
    const pid = Number(text);
    return Number.isInteger(pid) && pid > 0 ? pid : 0;
  } catch {
    return 0;
  }
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function shadowFileBody(sessionKey, body) {
  const key = String(sessionKey || "default").replace(/\s+/g, "");
  return `# spine-session ${key}\n${body || ""}`;
}

export const STATS_NAME = "spine-stats.json";
export const CUTS_NAME = "spine-cuts.jsonl";

export function readCutStats(dir) {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, STATS_NAME), "utf8"));
    return {
      cuts: Number(parsed.cuts) || 0,
      savedTokens: Number(parsed.savedTokens) || 0,
      rewriteTokens: Number(parsed.rewriteTokens) || 0,
      drains: Number(parsed.drains) || 0,
    };
  } catch {
    return { cuts: 0, savedTokens: 0, rewriteTokens: 0, drains: 0 };
  }
}

export function drainRewrite(notes) {
  const cuts = (notes || []).filter((note) => note?.kind === "cut" && note.saved > 0);
  if (!cuts.length) return 0;
  const later = cuts.slice(1).reduce((sum, note) => sum + (note.saved || 0), 0);
  return Math.max(0, (cuts[0].afterPrefix || 0) - later);
}

export function flushDrainStats(dir, notes, meta = {}) {
  const cuts = (notes || []).filter((note) => note?.kind === "cut" && note.saved > 0);
  const charged = drainRewrite(notes);
  const saved = cuts.reduce((sum, note) => sum + note.saved, 0);
  if (cuts.length) recordDrainStats(dir, { cuts: cuts.length, saved, rewrite: charged });
  const lines = (notes || []).map((note, index) => JSON.stringify({
    v: 1,
    ts: new Date().toISOString(),
    sid: meta.sid || "",
    kind: note.kind || "cut",
    pass: index,
    drain: meta.drain === true,
    saved: note.saved || 0,
    rewriteCharged: note.kind === "cut" && index === (notes || []).findIndex((item) => item?.kind === "cut") ? charged : 0,
    tailBeyondKept: note.tailBeyondKept || 0,
    prefix: note.prefix || 0,
    afterPrefix: note.afterPrefix || 0,
    tokens: note.tokens || 0,
    total: note.total || 0,
    gate: note.gate || "cut",
  }));
  if (!lines.length) return charged;
  try {
    appendFileSync(join(dir, CUTS_NAME), `${lines.join("\n")}\n`);
  } catch {}
  return charged;
}

function recordDrainStats(dir, { cuts = 0, saved = 0, rewrite = 0 } = {}) {
  if (!(cuts > 0) || !(saved > 0)) return null;
  try {
    const file = join(dir, STATS_NAME);
    const lock = join(dir, "spine-stats.lock");
    const tmp = `${file}.${process.pid}-${randomBytes(8).toString("hex")}.tmp`;
    let fd;
    try {
      fd = openSync(lock, "wx");
    } catch {
      return null;
    }
    try {
      const prev = readCutStats(dir);
      const locked = {
        cuts: prev.cuts + cuts,
        savedTokens: prev.savedTokens + saved,
        rewriteTokens: prev.rewriteTokens + rewrite,
        drains: (Number(prev.drains) || 0) + 1,
        updatedAt: new Date().toISOString(),
      };
      writeFileSync(tmp, JSON.stringify(locked));
      renameSync(tmp, file);
      return locked;
    } finally {
      try { unlinkSync(tmp); } catch {}
      closeSync(fd);
      try { unlinkSync(lock); } catch {}
    }
  } catch {
    return null;
  }
}

export function recordCutStats(dir, { saved = 0, rewrite = 0 } = {}) {
  if (!(saved > 0)) return readCutStats(dir);
  try {
    const file = join(dir, STATS_NAME);
    const lock = join(dir, "spine-stats.lock");
    const tmp = `${file}.${process.pid}-${randomBytes(8).toString("hex")}.tmp`;
    let fd;
    try {
      fd = openSync(lock, "wx");
    } catch {
      return null;
    }
    try {
      const prev = readCutStats(dir);
      const locked = {
        cuts: prev.cuts + 1,
        savedTokens: prev.savedTokens + saved,
        rewriteTokens: prev.rewriteTokens + rewrite,
        updatedAt: new Date().toISOString(),
      };
      writeFileSync(tmp, JSON.stringify(locked));
      renameSync(tmp, file);
      return locked;
    } finally {
      try { unlinkSync(tmp); } catch {}
      closeSync(fd);
      try { unlinkSync(lock); } catch {}
    }
  } catch {
    return null;
  }
}

export function shadowAccessPlan(platform = process.platform, userSid = "", kind = "dir") {
  if (platform === "win32") {
    if (!/^S-\d+(?:-\d+)+$/.test(userSid)) {
      throw new Error("spine: current Windows user SID is required");
    }

    // 文件不能带继承标志，否则 icacls 会把整条 ACE 当无效丢掉，留下空 DACL。
    // Files reject (OI)(CI), so a file grant must not carry it.
    const scope = kind === "dir" ? "(OI)(CI)" : "";

    return {
      kind: "acl",
      usesChmodOnly: false,
      inheritance: "remove",
      grant: [
        `*${userSid}:${scope}F`,
        `*S-1-5-18:${scope}F`,
        `*S-1-5-32-544:${scope}F`,
      ],
    };
  }

  return {
    kind: "mode",
    usesChmodOnly: true,
    dirMode: 0o700,
    fileMode: 0o600,
  };
}

export function defaultShadowAccessRunner({
  path,
  kind,
  platform,
  execFile = execFileSync,
  env = process.env,
} = {}) {
  if (platform !== "win32") {
    const plan = shadowAccessPlan(platform);
    chmodSync(path, kind === "dir" ? plan.dirMode : plan.fileMode);
    return true;
  }

  if (shadowFuse) {
    const error = new Error("spine: shadow permission already failed");
    error.code = "ESHADOWACCESS";
    throw error;
  }

  let whoamiPath = "";
  let icaclsPath = "";
  try {
    whoamiPath = win32Tool("whoami.exe", env);
    icaclsPath = win32Tool("icacls.exe", env);
  } catch (error) {
    tripFuse();
    throw error;
  }

  let sid = cachedSid;
  if (!sid) {
    let identity = "";
    try {
      identity = execFile(whoamiPath, ["/user", "/fo", "csv", "/nh"], {
        encoding: "utf8",
        windowsHide: true,
      });
    } catch (error) {
      error.step = "whoami";
      tripFuse();
      throw error;
    }
    const match = String(identity ?? "").match(/,"(S-\d+(?:-\d+)+)"\s*$/i);
    if (!match) {
      const error = new Error("spine: cannot determine current Windows user SID");
      error.step = "whoami";
      tripFuse();
      throw error;
    }
    sid = match[1];
    cachedSid = sid;
  }

  const plan = shadowAccessPlan("win32", sid, kind);
  try {
    execFile(
      icaclsPath,
      [resolve(path), "/inheritance:r", "/grant:r", ...plan.grant],
      { stdio: "pipe", windowsHide: true },
    );
  } catch (error) {
    error.step = kind === "file" ? "file" : "dir";
    tripFuse();
    throw error;
  }

  if (kind === "dir") lockedDirs.add(lockKey(path));
  return true;
}

export function tightenShadow(path, kind = "dir", access = {}) {
  const platform = access.platform ?? process.platform;
  const windows = platform === "win32" && !access.runner;
  if (windows && kind === "file" && shadowDirLocked(dirname(path))) return;
  if (windows && shadowFuse) {
    const error = new Error("spine: shadow permission action failed; backup refused");
    error.code = "ESHADOWACCESS";
    throw error;
  }

  const runner = access.runner ?? ((action) => defaultShadowAccessRunner({
    ...action,
    execFile: access.execFile,
    env: access.env,
  }));

  try {
    if (runner({ path, kind, platform, env: access.env, execFile: access.execFile }) !== true) {
      throw new Error("permission runner did not confirm success");
    }
  } catch (cause) {
    if (windows) tripFuse();
    const error = new Error(
      "spine: shadow permission action failed; backup refused",
      { cause },
    );
    error.code = "ESHADOWACCESS";
    error.step = cause?.step;
    throw error;
  }
}

export function ensureShadowDir(dir, access = {}) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const platform = access.platform ?? process.platform;
  if (!access.runner && platform === "win32" && shadowDirLocked(dir)) return dir;
  tightenShadow(dir, "dir", access);
  return dir;
}

export function discardShadowFiles(files, cause, { account = true } = {}) {
  const errors = [];

  for (const file of files) {
    try {
      unlinkSync(file);
      // 只有「已入账的文件」才扣。writeShadowFile 内部回滚时还没记账，扣了就是反向错账。
      if (account) noteShadowUnlink(file);
    } catch (error) {
      if (error?.code !== "ENOENT") errors.push(error);
    }
  }

  if (errors.length > 0) {
    const error = new AggregateError(
      [cause, ...errors],
      "spine: shadow write failed and cleanup failed",
    );
    error.code = cause?.code || "ESHADOWCLEANUP";
    throw error;
  }
}

export function writeShadowFile(
  file,
  body,
  access = {},
  { exclusive = false } = {},
) {
  const dir = dirname(file);
  ensureShadowDir(dir, access);

  const target = exclusive
    ? file
    : join(
        dir,
        `.${basename(file)}-${randomBytes(8).toString("hex")}.tmp`,
      );

  let fd = null;
  let created = false;
  let protectedPath = target;
  // 覆盖已有同名文件时只补差值，不重复计数。
  let priorBytes = -1;
  if (!exclusive) {
    try {
      priorBytes = statSync(file).size;
    } catch {
      priorBytes = -1;
    }
  }

  try {
    fd = openSync(target, "wx", 0o600);
    created = true;

    if (!exclusive) {
      renameSync(target, file);
      protectedPath = file;
    }

    tightenShadow(protectedPath, "file", access);
    writeFileSync(fd, body);

    const opened = fd;
    fd = null;
    closeSync(opened);
    noteShadowWrite(file, priorBytes); // 记账集中在这里：唯一写口
    return file;
  } catch (error) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {}
    }

    if (created) discardShadowFiles([protectedPath], error, { account: false });
    throw error;
  }
}

export function writeShadowOwner(dir, access = {}) {
  return writeShadowFile(
    join(dir, "owner"),
    String(process.pid),
    access,
  );
}

export function shadowMaxBytes(env = process.env) {
  const bytes = Number(env.SPINE_SHADOW_MAX_BYTES);
  if (Number.isFinite(bytes) && bytes > 0) return Math.floor(bytes);
  const mb = Number(env.SPINE_SHADOW_MAX_MB);
  if (Number.isFinite(mb) && mb > 0) return Math.floor(mb * 1024 * 1024);
  return 256 * 1024 * 1024;
}

function readSessionKey(file) {
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(240);
    const count = readSync(fd, buf, 0, buf.length, 0);
    const line = buf.subarray(0, count).toString("utf8").split("\n")[0] || "";
    return SESSION_MARK.exec(line)?.[1] || "";
  } catch {
    return "";
  } finally {
    closeSync(fd);
  }
}

export function listPluginShadows(dir) {
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const files = [];
  for (const name of names) {
    if (!isPluginShadowName(name)) continue;
    const path = resolve(dir, name);
    try {
      const info = statSync(path);
      if (!info.isFile()) continue;
      files.push({
        name,
        path,
        size: info.size,
        mtimeMs: info.mtimeMs,
        // raw- 由 raw.js 直接写 body，从不带 "# spine-session" 头，
        // 归属由所在目录决定。跳过读头能省掉整棵树的逐文件打开（本机 459ms / 6728 文件）。
        sessionKey: name.startsWith("raw-") ? "" : readSessionKey(path),
      });
    } catch {}
  }
  return files;
}

function byAge(left, right) {
  return left.mtimeMs - right.mtimeMs || left.name.localeCompare(right.name);
}

export function listShadowEntries(dir, alive = processAlive) {
  const entries = [];
  let names = [];
  try {
    names = readdirSync(dir, { withFileTypes: true });
  } catch {
    return entries;
  }
  for (const entry of names) {
    const path = resolve(dir, entry.name);
    if (entry.isFile() && isPluginShadowName(entry.name)) {
      try {
        const info = statSync(path);
        entries.push({
          name: entry.name,
          path,
          size: info.size,
          mtimeMs: info.mtimeMs,
          sessionKey: "",
          legacy: true,
          live: false,
        });
      } catch {}
      continue;
    }
    if (!entry.isDirectory()) continue;
    const live = ownerPid(path) ? alive(ownerPid(path)) : false;
    for (const file of listPluginShadows(path)) {
      entries.push({ ...file, legacy: false, live, sessionKey: file.sessionKey || entry.name });
    }
  }
  return entries;
}

// 先删根目录旧文件，再删死会话，最后才删当前会话的旧文件。
// 当前卡片和这次引用的原文路径受保护。删不掉且仍然超限时返回 ok:false。
// Delete legacy root files, then dead sessions, then old files of this session.
// Protect the current card and cited raw paths. If unlink fails and the cap is still exceeded, ok is false.
// ── 本地化改造 v3（2026-11-10）────────────────────────────────────────────────
// 症状：每轮结束卡 5~10 秒，「深度求索中」散不掉、点什么都打断不了、切会话加载不出历史、只能重启。
// 关掉 live-compact 立刻不卡（主人实测，决定性证据）。
//
// 根因（本机 shadow=6728 个文件时逐段实测，不是估算）：
//     readdir 目录树       14 ms   便宜
//   + statSync 每个文件   433 ms   要 size 才能算用量
//   + readSessionKey      459 ms   逐个打开文件读头部 —— 而 98.9% 是 raw-，压根没有会话头
//   ──────────────────────────────
//     合计                 906 ms  全是同步 I/O，期间事件循环完全停摆
//   finishTurn 每轮最多 8 个 pass → 8 × 0.9s ≈ 7 秒，与「卡 10 秒」吻合。
// 而这一切，只为了回答一句：「12MB < 256MB，要不要删？」
//
// 本版做法：
//   1. 记账集中到唯一写口 writeShadowFile 与删除点，不再靠调用方自觉上报。
//   2. 热路径不查目录；但也不靠「每 N 秒强制校准」兜底 —— 那等于定时制造悬崖。
//      改为每次先做一次 14ms 的 readdir 点数：新增必然 +1、删除必然 -N，
//      任何漏记都会被点数抓住 → 对得上就放行，对不上立刻全量重算。
//   3. 只有真要删的时候才逐个 statSync 取精确值（那时本来就要知道删谁、多大）。
//   4. raw- 跳过读会话头（文件名已含全部信息，归属由所在目录决定），省掉那 459ms。
//   5. 上限口径与上游一致：只算正文文件，meta / owner / stats 不计入。
//
// 结果：护栏从「每 60 秒一次 900ms 悬崖」变成「每次 14ms，且没有悬崖」。
let shadowUsage = {
  key: "", // 已校准的目录键
  bytes: 0, // 正文文件字节合计（= 上游口径的 used）
  files: 0, // 正文文件个数
  exact: false, // 是否做过全量精确校准
  checkedAt: 0, // 上次点数校验的时间
};

// 三个阈值决定「什么时候值得花那 10ms 点数一次」：
const CHECK_NEAR_RATIO = 0.6; // 用量过 cap 的 60% → 靠近水线，每 pass 都点数
const CHECK_STALE_MS = 30_000; // 超过 30 秒没点数 → 兜底点数一次
// 远离水线时完全不查：账已经由唯一写口精确维护，漏记只可能来自外部写入，
// 而一旦它把用量推过 60%，下一次调用立刻就会被点数抓住并全量重算。
// 这样既没有旧版「每 60 秒 900ms 悬崖」，也没有每轮 8 × 10ms 的固定开销。

/** 目录键：账只对校准过的那一个根目录有效。 */
function shadowUsageKeyFor(dir) {
  return process.platform === "win32" ? resolve(dir).toLowerCase() : resolve(dir);
}

/**
 * 纯点数：只 readdir，不 stat、不打开文件。14ms 级。
 * 与 listShadowEntries 判定「哪些文件计入用量」的口径完全一致，用来校验账目。
 */
function countShadowFiles(root) {
  let files = 0;
  let names;
  try {
    names = readdirSync(root, { withFileTypes: true });
  } catch {
    return { files: 0, ok: false };
  }
  for (const entry of names) {
    if (entry.isFile()) {
      if (isPluginShadowName(entry.name)) files += 1;
      continue;
    }
    if (!entry.isDirectory()) continue;
    let inner;
    try {
      inner = readdirSync(resolve(root, entry.name));
    } catch {
      continue;
    }
    for (const name of inner) if (isPluginShadowName(name)) files += 1;
  }
  return { files, ok: true };
}

/** 全量精确校准：进程首次、换目录、或点数对不上时跑一次（~450ms，属慢路径）。 */
function calibrateShadow(dir, alive = processAlive) {
  const files = listShadowEntries(dir, alive);
  let bytes = 0;
  for (const file of files) bytes += file.size || 0;
  shadowUsage = { key: shadowUsageKeyFor(dir), bytes, files: files.length, exact: true, checkedAt: Date.now() };
  return shadowUsage;
}

/** 点数校验：账上的文件数是否与磁盘一致。一致 = 没有漏记的写入，也没有外部删除。 */
function shadowUsageVerified(dir) {
  const counted = countShadowFiles(dir);
  if (!counted.ok) return true; // 目录都读不到就别反复挖，交给后面的慢路径
  return counted.files === shadowUsage.files;
}

/** 作废账目，逼下一次调用重新校准。用于写失败回滚这类无法精确定账的场合。 */
export function invalidateShadowUsage() {
  shadowUsage = { key: "", bytes: 0, files: 0, exact: false };
}

/**
 * 写口集中记账。file 形如 <root>/<session>/<name>。
 * priorBytes >= 0 表示这次是覆盖已有文件（同名重写），只补差值、不新增计数。
 */
function noteShadowWrite(file, priorBytes) {
  if (!isPluginShadowName(basename(file))) return; // meta / owner / stats 不计入 cap
  if (shadowUsage.key !== shadowUsageKeyFor(dirname(dirname(file)))) return;
  let size = 0;
  try {
    size = statSync(file).size;
  } catch {
    return;
  }
  if (priorBytes >= 0) {
    shadowUsage.bytes = Math.max(0, shadowUsage.bytes - priorBytes + size);
  } else {
    shadowUsage.bytes += size;
    shadowUsage.files += 1;
  }
}

/** 删除时扣账。size 已知就免一次 stat。 */
function noteShadowUnlink(file, size = -1) {
  if (!isPluginShadowName(basename(file))) return;
  if (shadowUsage.key !== shadowUsageKeyFor(dirname(dirname(file)))) return;
  let bytes = size;
  if (bytes < 0) {
    try {
      bytes = statSync(file).size;
    } catch {
      bytes = 0;
    }
  }
  shadowUsage.bytes = Math.max(0, shadowUsage.bytes - bytes);
  shadowUsage.files = Math.max(0, shadowUsage.files - 1);
}

/** @deprecated v3 起写口已集中记账，保留导出仅为兼容旧调用方。 */
export function noteShadowUsage() {}

/** @deprecated v3 起写口已集中记账，raw.js 不再需要主动上报。 */
export function bumpShadowEstimate() {}

export function rotateShadow({ dir, incomingBytes, protectPath, protectPaths = [], sessionKey, cap, unlink = unlinkSync, alive = processAlive }) {
  const low = Math.floor(cap * 0.8);
  const oversize = incomingBytes > cap;
  const dirKey = shadowUsageKeyFor(dir);

  // 快路径：账目可信时不查目录直接放行；只有「靠近水线」或「太久没校验」才花 10ms 点数。
  // 注意这里不设「定期强制全量校准」—— 那正是旧版每 60 秒 900ms 悬崖的来源。
  if (!oversize) {
    if (!shadowUsage.exact || shadowUsage.key !== dirKey) {
      calibrateShadow(dir, alive);
    } else {
      const nearLine = shadowUsage.bytes >= cap * CHECK_NEAR_RATIO;
      const stale = Date.now() - shadowUsage.checkedAt >= CHECK_STALE_MS;
      if (nearLine || stale) {
        shadowUsage.checkedAt = Date.now();
        // 点数对不上 = 有绕过写口的写入或外部删除，账不可信 → 全量重算。
        if (!shadowUsageVerified(dir)) calibrateShadow(dir, alive);
      }
    }
    if (shadowUsage.bytes + incomingBytes <= low) {
      // 只做预测，绝不改账 —— 记账唯一归属 writeShadowFile。
      // 两边都记账会永久错位（每次调用虚增 incomingBytes），实测就是这么翻车的。
      return { ok: true, deleted: 0, freed: 0, used: shadowUsage.bytes, cap, oversize: false, failed: false };
    }
  }

  // ── 慢路径：真正要删东西了，这时才值得逐个 stat 取精确值 ──
  const files = listShadowEntries(dir, alive);
  const protect = new Set([protectPath, ...protectPaths].filter(Boolean).map((path) => resolve(path)));
  const current = sanitizeSessionKey(sessionKey);
  let used = files.reduce((sum, file) => sum + file.size, 0);
  shadowUsage = { key: dirKey, bytes: used, files: files.length, exact: true, checkedAt: Date.now() };
  if (!oversize && used + incomingBytes <= cap) {
    // 修正：估算把这次写入也算进去了，这里回到精确值。写入尚未发生，故只算已有文件。
    // （原版这里返回 used 但紧接着 writeShadowFile 会 +incoming，语义由写口记账接管。）
    return { ok: true, deleted: 0, freed: 0, used, cap, oversize: false, failed: false };
  }
  const legacy = [];
  const dead = [];
  const mine = [];
  for (const file of files) {
    if (protect.has(file.path)) continue;
    if (file.live && file.sessionKey !== current) continue;
    if (file.legacy) legacy.push(file);
    else if (file.sessionKey === current) mine.push(file);
    else dead.push(file);
  }
  legacy.sort(byAge);
  dead.sort(byAge);
  mine.sort(byAge);
  let deleted = 0;
  let freed = 0;
  let failed = false;
  for (const file of [...legacy, ...dead, ...mine]) {
    if (!oversize && used + incomingBytes <= low) break;
    try {
      unlink(file.path);
      noteShadowUnlink(file.path, file.size); // 记账：删多少扣多少
    } catch (error) {
      if (error?.code === "ENOENT") {
        // 已经被别人删掉了，账也要扣，否则点数永远对不上。
        noteShadowUnlink(file.path, file.size);
        used -= file.size;
        freed += file.size;
        deleted += 1;
        continue;
      }
      failed = true;
      break;
    }
    used -= file.size;
    freed += file.size;
    deleted += 1;
    if (file.name.startsWith("raw-")) {
      try {
        unlink(`${file.path}.meta.json`);
      } catch {}
    }
  }
  const fits = used + incomingBytes <= cap;
  return {
    ok: !failed && (oversize || fits),
    deleted,
    freed,
    used,
    cap,
    oversize,
    failed,
  };
}
