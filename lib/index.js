/**
 * dsh-app-updater 宿主半身。
 *
 * 职责：暴露 HTTP 路由给设置页 UI，串行调度「扫描」与「更新」两条后台任务，
 * 把进度写进持久化状态。所有路由默认拒绝：先过宿主 connection 准入；写操作另需
 * confirm:true。仅在用户显式开启兼容模式时，才按「回环地址」放行（默认关闭）。
 *
 * 设计上不依赖宿主内部服务（不用 llm / tools / agent），只依赖 webServer，
 * 因此在没有 Web 的 composition 里它会安静地不挂载任何路由。
 */

import { homedir } from "node:os";
import { join, isAbsolute } from "node:path";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

import { Store, dshHome, settingAppliesTo } from "./state.js";
import { scanApps, runUpdates, resolveDownloadDir, findBrew, currentEnvironment } from "./engine.js";
import { findWinget } from "./winget.js";
import { describeEnvironment, engineFor, capabilitiesFor, ENGINE_WINGET, ENGINE_BREW } from "./platform.js";
import { runProcess } from "./proc.js";
import {
  pluginVersionInfo,
  currentVersion,
  parseRegistryLatest,
  evaluateUpdate,
  isSafeVersionArg,
  buildSelfUpdateCommand,
  findDshCli,
  REGISTRY_LATEST_URL,
  PACKAGE_NAME,
} from "./plugin-version.js";

const PREFIX = "/dsh-app-updater";
const MAX_BODY_BYTES = 256 * 1024;

/** 写操作路由：HTTP method 校验与 confirm / CSRF 闸门的依据。 */
const WRITE_ROUTES = new Set(["/scan", "/update", "/cancel", "/settings", "/open-downloads", "/self-update"]);

/** 版本号只有 package.json 一个来源，避免两处写死对不上。 */
const PLUGIN_VERSION = (() => {
  try {
    return createRequire(import.meta.url)("../package.json").version || "";
  } catch {
    return "";
  }
})();

/** 插件自更新：CLI 最长执行时间；超时会杀进程组并如实报错，不会卡死按钮。 */
const SELF_UPDATE_TIMEOUT_MS = 180000;
const REGISTRY_TIMEOUT_MS = 12000;

/**
 * 抓 npm registry 的 /latest 文本。抽成变量便于测试注入（不联网也能验证路由分支）；
 * 生产路径恒为 Node 内置 fetch + 超时。
 */
let fetchRegistryLatest = async () => {
  const r = await fetch(REGISTRY_LATEST_URL, {
    cache: "no-store",
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
  });
  if (!r.ok) throw new Error("registry 返回 HTTP " + r.status);
  return r.text();
};

/** 仅测试用：替换 registry 抓取实现，返回恢复函数。 */
export function __setRegistryFetchForTest(fn) {
  const prev = fetchRegistryLatest;
  fetchRegistryLatest = fn || (async () => {
    const r = await fetch(REGISTRY_LATEST_URL, {
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
    });
    if (!r.ok) throw new Error("registry 返回 HTTP " + r.status);
    return r.text();
  });
  return () => { fetchRegistryLatest = prev; };
}

const store = new Store();

/** 当前任务的控制面。同一时刻只允许一个扫描 + 一个更新。 */
const control = {
  scanAbort: null,
  updateAbort: null,
  // 「更新结束后 4 秒自动重扫」的 timer 句柄：卸载时必须清掉，否则幽灵重扫
  rescanTimer: null,
};

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function isLoopback(req) {
  const a = req && req.socket && req.socket.remoteAddress;
  return a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1";
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    // 收集 Buffer 再一次性解码：原来 `chunks += c` 会把每个 chunk 单独 toString("utf8")，
    // 中文恰好跨 chunk 边界时会被解成 U+FFFD，污染应用名 / 路径。
    const chunks = [];
    let bytes = 0;
    let tooLarge = false;
    req.on("data", (c) => {
      const buf = Buffer.isBuffer(c) ? c : Buffer.from(c);
      bytes += buf.length;
      if (tooLarge) return;
      if (bytes > MAX_BODY_BYTES) {
        tooLarge = true;
        // 继续排空请求体（不能直接 destroy，否则写不出 413 响应），但不再保存内容
        try { req.resume(); } catch { /* 已结束 */ }
        return;
      }
      chunks.push(buf);
    });
    req.on("end", () => {
      if (tooLarge) return resolve({ tooLarge: true });
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw.trim()) return resolve({});
      try {
        const parsed = JSON.parse(raw);
        // 只接受普通对象：数组 / 标量 / null 都按「非法请求体」处理，避免语义含糊
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          return resolve({ parseError: true });
        }
        resolve(parsed);
      } catch {
        resolve({ parseError: true });
      }
    });
    req.on("error", () => resolve({ parseError: true }));
  });
}

/** 请求是否携带了 DSH 连接凭据（浏览器会话 Cookie 或 API Cookie）。 */
export function hasConnectionCredentials(req) {
  const h = (req && req.headers) || {};
  return Boolean(h.cookie || h.authorization);
}

/**
 * 兼容模式豁免的来源围栏：请求**若带** Origin / Referer，则其主机必须与本次请求的
 * Host 一致（同源）；`Sec-Fetch-Site: cross-site` 一律拒绝。
 *
 * 为什么需要它：豁免是给「宿主自己的载体（Electron 经 IPC 桥）」与「本机脚本
 * （curl / PowerShell）」用的，这两类要么不带浏览器来源头，要么就是同源。而任意
 * 第三方网页的 `fetch("http://127.0.0.1:<port>/dsh-app-updater/update",
 * {method:"POST",mode:"no-cors",body:'{"confirm":true,"ids":[…]}'})` 天然不带
 * Cookie，能绕过「无凭据才豁免」这一条，驱动「下载任意包 + 自动 UAC 提权静默安装」。
 * 浏览器禁止脚本伪造 Origin / Sec-Fetch-Site（forbidden header），所以拿它做同源
 * 判定是可靠的：跨站请求必然带上一个与 Host 不符的 Origin → 拒绝。
 *
 * 只拒绝「出现且不同源」的来源头，绝不用「有来源头就拒」：同源界面的 fetch POST
 * 本来就会发 Origin（GET 还可能带 Referer），一刀切会把兼容模式想服务的那个界面打死。
 */
export function isCrossSiteBrowserRequest(req) {
  const h = (req && req.headers) || {};
  if (String(h["sec-fetch-site"] || "").toLowerCase() === "cross-site") return true;
  const host = String(h.host || "").toLowerCase();
  if (!host) return false;
  const sameHost = (value) => {
    const v = String(value || "").trim().toLowerCase();
    if (!v) return true; // 头不存在 → 不是浏览器跨站请求
    if (v === "null") return false; // opaque origin（file:// / data: 页面）
    try {
      const u = new URL(v.startsWith("http") ? v : `http://${v}`);
      return u.host.toLowerCase() === host;
    } catch {
      return false; // 解析不了的来源，按不可信处理
    }
  };
  if (h.origin && !sameHost(h.origin)) return true;
  if (h.referer && !sameHost(h.referer)) return true;
  return false;
}

/**
 * 兼容模式开关：只允许在用户**显式开启**时按「回环地址」放行。
 *
 * 1.3.0 在 `connection` 不可用（或没有凭据可核验）时会直接按回环放行，旧宿主上
 * 等于绕过了认证就能调用安装接口 —— 市场复核要求这条路径改为默认拒绝。
 * 因此 1.3.1 起默认关闭，只有下面两种显式动作之一才恢复（并会在响应头、状态接口
 * 与日志里标注，方便复核）：
 *   - 插件配置 `allowLegacyLoopback: true`（cordis patch 的 `config`）
 *   - 环境变量 `DSH_APP_UPDATER_ALLOW_LEGACY_LOOPBACK=1`
 */
export const LEGACY_LOOPBACK_ENV = "DSH_APP_UPDATER_ALLOW_LEGACY_LOOPBACK";

function truthyFlag(value) {
  if (value === true || value === 1) return true;
  if (typeof value !== "string") return false;
  return /^(1|true|yes|on)$/i.test(value.trim());
}

/** 解析兼容模式开关：插件配置优先，其次环境变量；默认（两者都没有）为 false。 */
export function resolveLegacyLoopbackOptIn(config, env = process.env) {
  if (config && truthyFlag(config.allowLegacyLoopback)) return true;
  return truthyFlag((env || {})[LEGACY_LOOPBACK_ENV]);
}

/** 兼容模式放行时打标记，便于复核与排障：正常准入不会出现这两个头。 */
function markLegacyAdmission(res) {
  if (typeof res.setHeader !== "function") return;
  res.setHeader("X-DSH-Admission", "loopback-legacy-optin");
  res.setHeader("X-DSH-Admission-Warning", "legacy-loopback-compatibility-enabled");
}

/** 统一写出拒绝响应，并标明是「被拒绝」而不是「未经过闸门」。 */
function denyAdmission(res, status, error) {
  if (typeof res.setHeader === "function") res.setHeader("X-DSH-Admission", "denied");
  json(res, status, { ok: false, error, admission: "denied" });
}

/**
 * connection 准入（宿主信任边界）。**默认拒绝**。
 *
 * DSH 的 `connection` 服务负责插件 HTTP 路由的信任校验：`admit(request)` 先做
 * Host/Origin 校验，再做浏览器会话 / API 认证，返回本次调用对应的 Peer，或用
 * `401`（未认证）/`403`（不可信来源）/`409`（连接已被占用）拒绝 —— 宿主自己的
 * `/api` 路由用的就是它。
 *
 * 规则（按顺序）：
 * 1. 宿主有 `connection`：一律以 `admit()` 为准，通过就放行；
 *    只有「401 + 回环 + 没有任何凭据 + 用户显式开启兼容模式」这一种情况例外，
 *    否则按 `admit()` 给出的状态码拒绝。
 * 2. 宿主没有 `connection`：**默认拒绝**（403）。只有用户显式开启兼容模式、
 *    且请求来自回环地址时才放行。
 *
 * @returns {boolean} 已放行 true；已写出拒绝响应 false
 */
export function admissionGate(req, res, connection, options = {}) {
  const loopback = isLoopback(req);
  const optIn = options.allowLegacyLoopback === true;
  if (connection && typeof connection.admit === "function") {
    let admission;
    try {
      admission = connection.admit(req);
    } catch (err) {
      // 不把宿主内部错误文案回给客户端（轻微信息泄露），统一给泛化文案
      denyAdmission(res, 500, "连接准入服务异常，按默认拒绝处理");
      return false;
    }
    if (!admission || typeof admission !== "object") {
      // 宿主实现异常时宁可拒绝，也不要把「看不懂的结果」当成放行
      denyAdmission(res, 500, "连接准入返回了无法识别的结果，按默认拒绝处理");
      return false;
    }
    if (!("rejection" in admission)) return true;
    if (typeof admission.rejection !== "number") {
      denyAdmission(res, 403, "连接准入返回了无法识别的拒绝码，按默认拒绝处理");
      return false;
    }
    if (admission.rejection === 401 && loopback && !hasConnectionCredentials(req) && !isCrossSiteBrowserRequest(req) && optIn) {
      // 例外路径：宿主自己的载体（Electron 经 IPC 桥接的 fetch）与本机脚本都不带
      // Cookie，没有可核验的凭据。只有用户显式开启兼容模式才退回回环信任；
      // 且跨站浏览器请求（Origin/Referer 与 Host 不符）一律拒绝 —— 否则任意网页
      // 的无 Cookie fetch 就能驱动「下载 + 提权静默安装」（CSRF）。
      markLegacyAdmission(res);
      return true;
    }
    const status = admission.rejection === 403 ? 403 : admission.rejection === 409 ? 409 : 401;
    denyAdmission(
      res,
      status,
      status === 401
        ? "请求未通过 DSH connection 认证：缺少有效的会话 Cookie / API 凭据"
        : status === 409
          ? "请求对应的连接已被占用"
          : "请求来源不受信任：Host/Origin 校验未通过"
    );
    return false;
  }
  if (optIn && loopback && !isCrossSiteBrowserRequest(req)) {
    markLegacyAdmission(res);
    return true;
  }
  denyAdmission(
    res,
    403,
    optIn
      ? isCrossSiteBrowserRequest(req)
        ? "拒绝：兼容模式不接受跨站浏览器请求（Origin/Referer 与 Host 不一致）"
        : "只接受本机（loopback）请求：当前宿主没有可用的 connection 准入服务"
      : "拒绝访问：当前宿主没有 connection 准入服务，兼容模式（仅回环放行）未开启，按默认拒绝处理"
  );
  return false;
}

/**
 * 写操作闸门：`confirm:true`。
 *
 * 来源校验已经由 `register()` 里的 connection 准入做过（见 admissionGate），
 * 这里只负责「这次写入是用户显式确认过的」。
 */
async function writeGate(req, res) {
  const body = await readJsonBody(req);
  if (body.tooLarge) {
    json(res, 413, { ok: false, error: "请求体过大" });
    return null;
  }
  if (body.parseError) {
    json(res, 400, { ok: false, error: "请求体不是合法 JSON" });
    return null;
  }
  if (body.confirm !== true) {
    json(res, 400, { ok: false, error: "缺少 confirm:true（写操作必须显式确认）" });
    return null;
  }
  /* CSRF：token 由 GET /state.json 下发、不落盘，写操作必须原样带回。
     这补上「confirm:true 只是请求体字段、不是能力凭证」的缺口，尤其在兼容模式下
     （无 Cookie 的跨站/脚本请求无法凭空拿到这个 token）。
     校验放在 confirm 之后，保证「缺少 confirm」的错误语义不变（deny.mjs 依赖它）。 */
  if (!store.csrfToken || body.csrfToken !== store.csrfToken) {
    json(res, 403, { ok: false, error: "CSRF 校验失败：请先刷新页面获取 csrfToken 并随写请求带回" });
    return null;
  }
  return body;
}

function phaseOf(state) {
  if (state.update.running) return "updating";
  if (state.scan.running) return "scanning";
  return "idle";
}

/**
 * 平台闸门：Windows 与 macOS 通过；其它系统明确拒绝，而不是让引擎跑到一半才报错。
 * @returns {object|null} 通过时返回环境对象，否则已写出 400 响应并返回 null
 */
function platformGuard(res) {
  const env = currentEnvironment();
  if (env.family === "windows" || env.family === "macos") return env;
  json(res, 400, {
    ok: false,
    error: `当前系统 ${env.platform} 暂不支持（本插件面向 Windows 与 macOS）`,
  });
  return null;
}

function buildStatePayload() {
  const s = store.state;
  const env = s.env || currentEnvironment();
  const engine = s.engine && s.engine.id ? s.engine : defaultEngine(env);
  /* 下发前再裁一次平台专属设置：state.json 可能在插件运行期间被外部进程
     （同步 ~/.dsh / 漫游配置）写入了不属于本平台的键，而 load() 的裁剪只在首次加载发生。 */
  const settings = { ...s.settings };
  for (const key of Object.keys(settings)) {
    if (!settingAppliesTo(key, env.family)) delete settings[key];
  }
  return {
    ok: true,
    platform: env.platform,
    env,
    envSummary: describeEnvironment(env),
    engine,
    capabilities: capabilitiesFor(env, Boolean(engine.available)),
    winget: s.winget || detectWingetSync(),
    phase: phaseOf(s),
    scan: s.scan,
    update: s.update,
    apps: s.apps,
    log: s.log.slice(-200),
    settings,
    downloadDir: resolveDownloadDir(s.settings),
    // 写接口需要的 CSRF token（不落盘）；以及最近一次写盘失败原因，供排障
    csrfToken: store.csrfToken,
    saveError: store.lastSaveError || null,
    /* 1.4.0：底部版本信息区的数据源。version 来自 package.json，
       updatedAt 来自 CHANGELOG.md 顶部日期，均由宿主只读下发（浏览器无法 require）。 */
    pluginInfo: pluginVersionInfo(),
  };
}

/** 还没扫描过时，也把引擎探测出来，界面不必等到扫描完才显示环境。 */
let cachedDefaultEngine = null;
function defaultEngine(env) {
  const id = engineFor(env.family);
  if (cachedDefaultEngine && cachedDefaultEngine.id === id) return cachedDefaultEngine;
  if (id === ENGINE_WINGET) {
    const file = findWinget();
    cachedDefaultEngine = { id, available: Boolean(file), version: "", path: file || "" };
  } else if (id === ENGINE_BREW) {
    const file = findBrew();
    cachedDefaultEngine = { id, available: Boolean(file), version: "", path: file || "" };
  } else {
    cachedDefaultEngine = { id, available: false, version: "", path: "" };
  }
  return cachedDefaultEngine;
}

let cachedWinget = null;
function detectWingetSync() {
  if (cachedWinget) return cachedWinget;
  const file = findWinget();
  cachedWinget = { available: Boolean(file), version: "", path: file || "" };
  return cachedWinget;
}

/* ------------------------------------------------------------------ *
 * 任务
 * ------------------------------------------------------------------ */

let scanPromise = null;

async function startScan(force) {
  if (store.state.scan.running && scanPromise) return { started: false, running: true };
  if (!force && store.state.apps.scannedAt && Date.now() - store.state.apps.scannedAt < 30_000) {
    return { started: false, cached: true };
  }

  const abort = new AbortController();
  control.scanAbort = abort;
  store.state.scan = { ...store.state.scan, running: true, startedAt: Date.now(), finishedAt: 0, error: null, warnings: [] };
  store.save();

  scanPromise = (async () => {
    try {
      const result = await scanApps({
        settings: store.state.settings,
        log: (level, text) => store.log(level, text),
        signal: abort.signal,
      });
      // 已被新扫描接管（取消后重试）时本次结果作废，不覆盖新任务的状态
      if (control.scanAbort !== abort) return;
      store.state.env = result.env || store.state.env;
      store.state.engine = result.engine || store.state.engine;
      if (result.winget) store.state.winget = result.winget;
      store.state.apps = {
        scannedAt: result.scannedAt,
        stats: result.stats,
        items: result.items,
        engine: result.engine ? result.engine.id : "",
      };
      store.state.scan = {
        running: false,
        startedAt: result.startedAt,
        finishedAt: Date.now(),
        error: null,
        warnings: result.warnings,
      };
    } catch (err) {
      const message = String((err && err.message) || err);
      const cancelled = /已取消/.test(message);
      if (cancelled) store.log("info", "扫描已取消");
      else store.log("error", `扫描失败：${message}`);
      // 只有本次任务还没被新任务接管时才写错误/收尾状态，避免旧任务把
      // 新任务「running:true」的状态覆盖成 running:false；
      // 取消不算故障：error 保持 null（红色横幅只留给真失败，1.3.4 的准则）
      if (control.scanAbort === abort) {
        store.state.scan = { ...store.state.scan, running: false, finishedAt: Date.now(), error: cancelled ? null : message };
      }
    } finally {
      // 槽位所有权检查：旧任务不能清掉「取消后立刻重试」的新任务句柄
      if (control.scanAbort === abort) {
        control.scanAbort = null;
        scanPromise = null;
      }
      store.save();
    }
  })();

  return { started: true };
}

let updatePromise = null;

async function startUpdate(ids) {
  if (store.state.update.running) return { started: false, running: true };
  const list = (Array.isArray(ids) ? ids : []).filter((x) => typeof x === "string" && x.trim());
  if (!list.length) return { started: false, error: "没有要更新的应用" };

  const abort = new AbortController();
  control.updateAbort = abort;
  store.state.update = {
    running: true,
    startedAt: Date.now(),
    finishedAt: 0,
    total: list.length,
    done: 0,
    current: null,
    results: [],
    error: null,
  };
  store.save();

  updatePromise = (async () => {
    try {
      await runUpdates({
        ids: list,
        // 把界面刚扫描出来的「已装版本 / 目标版本」一并带过去：安装后的复核要用它
        // 判断这次更新到底有没有真的生效（只看退出码会把「静默退出 0 却什么都没装」误报成功）
        plan: (store.state.apps.items || []).filter((it) => list.includes(it.id)),
        settings: store.state.settings,
        log: (level, text) => store.log(level, text),
        signal: abort.signal,
        onProgress: (patch) => {
          store.state.update = { ...store.state.update, ...patch };
          store.save();
        },
      });
    } catch (err) {
      const message = String((err && err.message) || err);
      // 所有权校验：旧任务不能覆盖「取消后立刻重试」的新任务状态（与 startScan 对齐）
      if (control.updateAbort === abort) {
        store.state.update = { ...store.state.update, running: false, finishedAt: Date.now(), error: message };
      }
      store.log("error", `更新任务异常：${message}`);
    } finally {
      const owns = control.updateAbort === abort;
      if (owns) {
        control.updateAbort = null;
        updatePromise = null;
      }
      store.save();
      /* 更新结束后自动重扫，让版本号刷新成新值。
         注意：这里**必须**让前端先能看到本次更新的结果。以前无条件立即重扫，
         界面在更新收尾的同一瞬间切到「扫描中…」，用户只看到「点了全部更新，
         结果它在扫描」，完全看不到 13 个应用到底成功还是失败。
         所以先留一小段窗口给结果展示，再重扫；重扫本身仍会自动发生。 */
      const finished = store.state.update || {};
      const results = Array.isArray(finished.results) ? finished.results : [];
      const okCount = results.filter((r) => r && r.ok).length;
      store.log(
        okCount === results.length && results.length ? "success" : "warn",
        `更新结束：成功 ${okCount} / ${results.length}（结果保留在界面上，稍后自动重扫版本）`
      );
      // 只有仍持有控制权的任务才排重扫；句柄存进 control，卸载时可清掉
      if (owns) {
        control.rescanTimer = setTimeout(() => {
          control.rescanTimer = null;
          startScan(true).catch(() => {});
        }, 4000);
        control.rescanTimer.unref?.();
      }
    }
  })();

  return { started: true, queued: list.length };
}

/** 在资源管理器中打开下载目录（不需要 shell 解释器，避免注入）。 */
function openFolder(path) {
  try {
    const explorer = join(process.env.SystemRoot || process.env.windir || "C:\\Windows", "explorer.exe");
    const child = spawn(explorer, [path], { detached: true, stdio: "ignore", windowsHide: false });
    child.on("error", (err) => {
      // 不再静默吞掉：打开下载目录失败要留痕，方便排障
      try { store.log("warn", `打开下载目录失败：${String((err && err.message) || err)}`); } catch { /* ignore */ }
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * 插件
 * ------------------------------------------------------------------ */

export default {
  name: "dsh-app-updater",
  apply(ctx, config) {
    // 兼容模式：默认关闭。只有用户显式写进插件配置或环境变量才开启（见 LEGACY_LOOPBACK_ENV）。
    const allowLegacyLoopback = resolveLegacyLoopbackOptIn(config);

    ctx.effect(() => {
      store
        .load()
        .then(() => {
          if (allowLegacyLoopback) {
            store.log(
              "warn",
              "兼容模式（allowLegacyLoopback）已开启：没有连接凭据的回环请求会按本机信任放行；" +
                "建议只在旧宿主（没有 connection 服务）上临时使用"
            );
          }
        })
        .catch((err) => {
          // 不再静默：状态加载失败必须留痕（store.load 内部 readJson 已兜住读错，这里兜其它异常）
          try {
            store.state.log.push({
              at: Date.now(),
              level: "error",
              text: `state.json 加载失败：${String((err && err.message) || err)}`,
            });
          } catch { /* ignore */ }
        });
    }, "dsh-app-updater: load state");

    ctx.inject(["webServer"], (webCtx) => {
      const webServer = webCtx.webServer;

      // connection 准入：宿主提供的信任边界（Host/Origin 校验 + 浏览器/API 认证）。
      // 它在宿主没有 Web 载体时不存在，此时 admissionGate 默认拒绝，除非兼容模式显式开启。
      let connection = null;
      ctx.inject(["connection"], (connCtx) => {
        connection = connCtx.connection;
        return () => {
          connection = null;
        };
      });
      const routes = [];

      /** 准入现状：写进状态接口，界面/复核者不必读代码就知道当前走的是哪条路径。 */
      const admissionInfo = () => ({
        mode: connection
          ? allowLegacyLoopback
            ? "connection+loopback-legacy"
            : "connection"
          : allowLegacyLoopback
            ? "loopback-legacy-optin"
            : "deny",
        service: Boolean(connection),
        allowLegacyLoopback,
        warning: allowLegacyLoopback
          ? "兼容模式已开启：没有连接凭据的本机回环请求会被放行，仅应在旧宿主上临时使用"
          : null,
      });

      /**
       * 注册一条路由：请求先过 connection 准入（见 admissionGate），再进业务处理。
       * 写接口另有 `confirm:true` 闸门（writeGate）。
       */
      const register = (path, handler) => {
        const expectedMethod = WRITE_ROUTES.has(path) ? "POST" : "GET";
        routes.push(
          webServer.register({
            kind: "exact",
            path: `${PREFIX}${path}`,
            handler: (req, res) => {
              if (!admissionGate(req, res, connection, { allowLegacyLoopback })) return;
              // 显式校验 HTTP method：契约里的 GET/POST 不能只依赖宿主分发实现，
              // 否则「GET 带 body」也能触发扫描 / 更新 / 改设置。
              if (String(req.method || "GET").toUpperCase() !== expectedMethod) {
                return json(res, 405, { ok: false, error: `方法不允许，请使用 ${expectedMethod}` });
              }
              return handler(req, res);
            },
          })
        );
      };

      register("/state.json", async (req, res) => {
        try {
          await store.load();
          json(res, 200, { ...buildStatePayload(), admission: admissionInfo() });
        } catch (err) {
          json(res, 500, { ok: false, error: String((err && err.message) || err) });
        }
      });

      register("/apps.json", async (req, res) => {
        await store.load();
        json(res, 200, {
          ok: true,
          scannedAt: store.state.apps.scannedAt,
          stats: store.state.apps.stats,
          items: store.state.apps.items,
          warnings: store.state.scan.warnings || [],
        });
      });

      /* ---------------------------------------------------------------- *
       * 1.4.0 插件自身的「检查更新」（只读）
       *
       * 数据源：npm registry 的 /latest。用 Node 内置 fetch + AbortSignal.timeout，
       * 网络异常 / 非 2xx / 解析不出版本一律返回 ok:false + error，界面据此给失败提示
       * 并允许重试；绝不在失败时谎报「已是最新」。
       * ---------------------------------------------------------------- */
      register("/check-update", async (req, res) => {
        let latestRaw;
        try {
          latestRaw = await fetchRegistryLatest();
        } catch (err) {
          return json(res, 200, {
            ok: false,
            error: "检查更新失败：" + String((err && err.message) || err || "网络不可达"),
          });
        }
        const latestVersion = parseRegistryLatest(latestRaw);
        const verdict = evaluateUpdate(currentVersion(), latestVersion);
        if (!verdict.ok) {
          return json(res, 200, { ok: false, error: "检查更新失败：" + verdict.error });
        }
        json(res, 200, {
          ok: true,
          currentVersion: verdict.currentVersion,
          latestVersion: verdict.latestVersion,
          hasUpdate: verdict.hasUpdate,
        });
      });

      /* ---------------------------------------------------------------- *
       * 1.4.0 插件自身的「立即更新」（写操作，confirm + CSRF 闸门同其它写接口）
       *
       * 只在「检测到新版本」这一状态被调用，但仍由宿主二次裁决：target 必须是
       * 合法 semver 串且严格新于当前版本，防止绕过界面直接打这个路由装旧版 / 注入参数。
       * 执行 `dsh plugin --profile web add dsh-app-updater@<version>`（参数数组、不经 shell）。
       * ---------------------------------------------------------------- */
      register("/self-update", async (req, res) => {
        const body = await writeGate(req, res);
        if (!body) return;
        const target = String(body.target || "").trim();
        if (!isSafeVersionArg(target)) {
          return json(res, 400, { ok: false, error: "目标版本号不合法" });
        }
        /* 二次裁决：只有严格新于当前版本才允许执行，避免「立即更新」状态残留时
           被重复点击、或旧状态被重放导致降级 / 无意义重装。 */
        const verdict = evaluateUpdate(currentVersion(), target);
        if (!verdict.ok || !verdict.hasUpdate) {
          return json(res, 200, {
            ok: true,
            alreadyCurrent: true,
            currentVersion: verdict.currentVersion,
            message: "当前已是最新版本，无需更新",
          });
        }
        const dshExe = findDshCli();
        const cmd = buildSelfUpdateCommand(target, dshExe);
        if (!cmd) {
          return json(res, 200, {
            ok: false,
            error: "未找到 dsh 命令，请手动执行：dsh plugin --profile web add " + PACKAGE_NAME + "@" + target,
          });
        }
        try {
          const result = await runProcess(cmd.exe, cmd.args, { timeoutMs: SELF_UPDATE_TIMEOUT_MS });
          const out = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
          if (!result.ok) {
            const why = result.timedOut
              ? "执行超时"
              : result.spawnError || (out ? out.split("\n").slice(-3).join(" ") : ("退出码 " + result.code));
            return json(res, 200, { ok: false, error: "更新失败：" + String(why).slice(0, 500) });
          }
          return json(res, 200, {
            ok: true,
            currentVersion: verdict.currentVersion,
            targetVersion: target,
            message: "已更新到 v" + target + "，若界面未自动刷新请重载页面",
            output: out.slice(-1000),
          });
        } catch (err) {
          return json(res, 200, { ok: false, error: "更新失败：" + String((err && err.message) || err) });
        }
      });

      register("/scan", async (req, res) => {
        const body = await writeGate(req, res);
        if (!body) return;
        await store.load();
        if (!platformGuard(res)) return;
        const r = await startScan(body.force !== false);
        json(res, 200, { ok: true, ...r });
      });

      register("/update", async (req, res) => {
        const body = await writeGate(req, res);
        if (!body) return;
        await store.load();
        if (!platformGuard(res)) return;
        const r = await startUpdate(body.ids);
        if (r.error) return json(res, 400, { ok: false, ...r });
        json(res, 200, { ok: true, ...r });
      });

      register("/cancel", async (req, res) => {
        const body = await writeGate(req, res);
        if (!body) return;
        await store.load();
        /* 取消可指定目标：scan / update / all（默认 all，兼容旧行为）。
           原来一按「取消」就把扫描和更新一起停，用户只想停扫描时连更新也被打断。 */
        const target = String(body.target || "all").toLowerCase();
        const wantUpdate = target === "all" || target === "update";
        const wantScan = target === "all" || target === "scan";
        let cancelled = false;
        if (wantUpdate && control.updateAbort) {
          control.updateAbort.abort();
          cancelled = true;
          store.log("warn", "收到取消请求（target=" + target + "），正在停止更新队列");
        }
        if (wantScan && control.scanAbort) {
          control.scanAbort.abort();
          cancelled = true;
          store.log("warn", "收到取消请求（target=" + target + "），正在停止扫描");
        }
        json(res, 200, { ok: true, cancelled, target });
      });

      register("/settings", async (req, res) => {
        const body = await writeGate(req, res);
        if (!body) return;
        await store.load();
        const patch = { ...(body.settings || {}) };
        if (Object.prototype.hasOwnProperty.call(patch, "downloadDir")) {
          const value = String(patch.downloadDir == null ? "" : patch.downloadDir).trim();
          // 空 = 用默认目录；否则必须是绝对路径，避免把安装包写到意料之外的位置。
          // 旧实现只认 Windows 盘符 / UNC，macOS 的 /Users/me/Downloads 会被误判 400
          // —— 插件声称支持 macOS，自定义下载目录却几乎设不了（跨平台泄漏）。
          const looksWindowsAbs = /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\]/.test(value);
          const looksPosixAbs = /^\//.test(value);
          if (value && !(looksWindowsAbs || looksPosixAbs || isAbsolute(value))) {
            return json(res, 400, {
              ok: false,
              error: "downloadDir 必须是绝对路径（Windows 盘符 / UNC，或 macOS 以 / 开头）",
            });
          }
          patch.downloadDir = value;
        }
        const next = store.updateSettings(patch);
        store.log("info", "设置已保存");
        json(res, 200, { ok: true, settings: next, downloadDir: resolveDownloadDir(next) });
      });

      register("/open-downloads", async (req, res) => {
        const body = await writeGate(req, res);
        if (!body) return;
        await store.load();
        const dir = resolveDownloadDir(store.state.settings);
        const opened = process.platform === "win32" ? openFolder(dir) : false;
        json(res, 200, { ok: opened, path: dir, exists: existsSync(dir) });
      });

      register("/health.json", async (req, res) => {
        await store.load();
        const env = store.state.env || currentEnvironment();
        const engine = store.state.engine && store.state.engine.id ? store.state.engine : defaultEngine(env);
        json(res, 200, {
          ok: true,
          plugin: "dsh-app-updater",
          version: PLUGIN_VERSION,
          pluginInfo: pluginVersionInfo(),
          platform: env.platform,
          env,
          envSummary: describeEnvironment(env),
          engine,
          capabilities: capabilitiesFor(env, Boolean(engine.available)),
          admission: admissionInfo(),
          saveError: store.lastSaveError || null,
          routes: routes.length,
          // 用 state.js 的 dshHome()：原写法不对 DSH_HOME 做 trim，与真实写入目录可能不一致
          dataDir: join(dshHome(), "dsh-app-updater"),
        });
      });

      ctx.effect(
        () => () => {
          /* 卸载必须终止后台任务：否则扫描 / 更新 Promise 与「4 秒自动重扫」会在插件
             卸载后继续写 store.save()，cordis 热重载时留下幽灵任务。 */
          for (const key of ["updateAbort", "scanAbort"]) {
            try {
              if (control[key]) control[key].abort();
            } catch {
              /* 已结束 */
            }
          }
          if (control.rescanTimer) {
            clearTimeout(control.rescanTimer);
            control.rescanTimer = null;
          }
          for (const dispose of routes) {
            try {
              dispose();
            } catch (err) {
              try {
                store.log("warn", `路由释放失败：${String((err && err.message) || err)}`);
              } catch { /* ignore */ }
            }
          }
        },
        "dsh-app-updater: routes"
      );
    });
  },
};
