/**
 * 更新引擎：扫描 → 排队 → 逐个「下载官网全量安装包 → 校验 → 静默安装 → 复核版本」。
 *
 * 设计取舍：
 *  - 检测只用 winget 的公开子命令（list / upgrade），不需要启动任何被检测的软件；
 *  - 更新优先走 winget download：它把**官网原始安装包**完整下载到本地（不是增量补丁），
 *    我们再自己用清单里的静默参数执行，做到「全量包 + 可留档 + 可回退」；
 *  - download 失败时退回 winget upgrade（同样是官网全量包，只是安装过程交给 winget）；
 *  - 每步都写日志，失败原因原样透出，不吞错误。
 */

import { mkdir, readdir, stat, readFile, writeFile, rm, rename, copyFile } from "node:fs/promises";
import { createReadStream, existsSync, lstatSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, basename, isAbsolute } from "node:path";
import { homedir } from "node:os";

import { runProcess, outputText } from "./proc.js";
import { elevationAvailable, isElevated, runElevated } from "./elevate.js";
import {
  findWinget,
  runWinget,
  parseInstalledList,
  parseUpgradeList,
  parseWingetVersion,
  isWingetUnavailable,
} from "./winget.js";
import { readRegistryApps, normalizeName } from "./registry.js";
import { compareVersions, isNewer, looksLikeVersion } from "./version.js";
import { detectEnvironment, describeEnvironment, engineFor, ENGINE_BREW, ENGINE_WINGET } from "./platform.js";
import { scanAppBundles, fetchCaskCatalog, parseCaskCatalog, buildMacosItems, createCaskMatcher, applicationDirs, mainVersionOf } from "./macos.js";
// 修坑：版本归一统一由 macos.js 的 mainVersionOf 提供，engine.js 不再自带一份重复实现。
import { checkAppUpdateSources } from "./appcast.js";

const INSTALLER_EXT = /\.(exe|msi|msix|appx|msixbundle|pkg|dmg)$/i;
// 修坑：下载目录磁盘配额（4 GiB），新一轮更新开始时按 mtime 从旧清理。
const MAX_DOWNLOAD_BYTES = 4 * 1024 * 1024 * 1024;
const DOWNLOAD_ARTIFACT = /\.(exe|msi|msix|msixbundle|appx|pkg|dmg|ya?ml)$/i;
/* 磁盘配额只删「本插件自己产出的」文件：moveIntoDownloadDir 会给每个回迁文件写一个
   同名 .dsh-app-updater 侧车标记，pruneDownloadDir 只认带标记的文件。
   否则用户把 downloadDir 指到 ~/Downloads 时，按扩展名清理会删掉用户自己的安装包。 */
const OWNED_SIDECAR = ".dsh-app-updater";
// 修坑：下载阶段并发度（安装/兜底/复核仍严格串行）。
const DOWNLOAD_CONCURRENCY = 3;

/** 当前环境（进程级缓存：同一次运行里平台/架构不会变）。 */
let cachedEnv = null;
export function currentEnvironment() {
  if (!cachedEnv) cachedEnv = detectEnvironment();
  return cachedEnv;
}

/* ------------------------------------------------------------------ *
 * 清单解析（只取我们需要的字段，不引第三方 YAML 库）
 * ------------------------------------------------------------------ */

/**
 * 从 winget download 落盘的 merged manifest 里提取安装信息。
 * 只做「按缩进扫描」的定向提取：InstallerType / Silent 参数 / Scope / InstallerUrl。
 */
export function parseInstallerManifest(yamlText) {
  const text = String(yamlText || "").replace(/\r\n?/g, "\n");
  const info = {
    installerType: "",
    installerUrl: "",
    silent: "",
    silentWithProgress: "",
    scope: "",
    elevation: "",
    productCode: "",
  };
  const lines = text.split("\n");
  let inInstallers = false;
  let inSwitches = false;
  let switchIndent = -1;
  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, "");
    if (!line.trim()) continue;
    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();
    if (/^Installers:\s*$/.test(trimmed)) {
      inInstallers = true;
      inSwitches = false;
      continue;
    }
    if (inInstallers && indent === 0 && /^[A-Za-z]/.test(trimmed)) {
      // 回到顶层键：Installers 段结束
      inInstallers = false;
      inSwitches = false;
    }
    if (!inInstallers) continue;

    if (/^InstallerSwitches:\s*$/.test(trimmed)) {
      inSwitches = true;
      switchIndent = indent;
      continue;
    }
    if (inSwitches && indent <= switchIndent && !/^InstallerSwitches:/.test(trimmed)) {
      inSwitches = false;
    }

    if (inSwitches) {
      const m = trimmed.match(/^(SilentWithProgress|Silent|Log|InstallLocation):\s*(.+)$/);
      if (m) {
        const value = stripQuotes(m[2]);
        if (m[1] === "Silent") info.silent = value;
        else if (m[1] === "SilentWithProgress") info.silentWithProgress = value;
      }
      continue;
    }

    // YAML 列表项（`- Architecture: x64`）标志着新 Installer 块开始：先清掉上一块
    // 的架构，防止「块里没有 Architecture 键时拿别块的架构去配对哈希」。
    if (/^-\s+\w/.test(trimmed)) info._lastArch = "";
    const kv = trimmed.match(/^(?:-\s+)?(InstallerType|InstallerUrl|Scope|ElevationRequirement|ProductCode|Architecture|InstallerSha256):\s*(.+)$/);
    if (kv) {
      const value = stripQuotes(kv[2]);
      switch (kv[1]) {
        case "InstallerType":
          if (!info.installerType) info.installerType = value;
          break;
        case "InstallerUrl":
          if (!info.installerUrl) info.installerUrl = value;
          break;
        case "Architecture":
          // merged 清单里每个 Installer 块各带 Architecture + InstallerSha256。
          // 配对收集，最后由 pickInstallerSha256 用实际架构或落盘文件名选定；
          // 配对不出来时宁可不做校验，也绝不拿「别的架构的哈希」把正确文件判成篡改。
          info._lastArch = value;
          break;
        case "InstallerSha256": {
          const map = (info.sha256ByArch ||= {});
          map[String(info._lastArch || "any").toLowerCase()] = value.toLowerCase();
          break;
        }
        case "Scope":
          if (!info.scope) info.scope = value;
          break;
        case "ElevationRequirement":
          if (!info.elevation) info.elevation = value;
          break;
        case "ProductCode":
          if (!info.productCode) info.productCode = value;
          break;
        default:
          break;
      }
    }
  }
  return info;
}

function stripQuotes(value) {
  let v = String(value || "").trim();
  if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) {
    v = v.slice(1, -1);
  }
  return v;
}

/** 流式 SHA-256（安装包常有几百 MB～GB，绝不整读进内存）。失败返回 null。 */
export function sha256File(path) {
  return new Promise((resolve) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", () => resolve(null));
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

/**
 * 从按架构收集的哈希里挑出「本次落盘这个文件」对应的声明哈希。
 *
 * @param {{sha256ByArch?: Record<string,string>}} info 清单解析结果
 * @param {string} arch 本机/请求的架构（x64 / arm64 …）
 * @param {string} fileName 实际下载到的文件名（merged 清单常把架构写进文件名）
 * @returns {string|null} 期望哈希；无法可靠配对时 null（调用方据此跳过校验）
 */
export function pickInstallerSha256(info, arch, fileName) {
  const map = info && info.sha256ByArch;
  if (!map) return null;
  const keys = Object.keys(map);
  if (!keys.length) return null;
  const wanted = String(arch || "").toLowerCase();
  if (wanted && map[wanted]) return map[wanted];
  // 文件名里带架构标记时用它配对。注意软件官网的命名习惯并不统一：
  // Git 用 `-64-bit`，Node 用 `-x64`，VS Code 用 `arm64` —— 所以每个 arch 键
  // 都带一组别名来匹配，而不是只做 `name.includes(key)`。
  //
  // 分「强/弱」两轮：`win32` 是**平台**名（Win32 API）而不是架构标记，Electron 系
  // 的文件名把两者拼在一起（`App-win32-x64.exe` = 平台 win32 + 架构 x64）。若按
  // 对象键顺序先试 x86，`win32` 会抢先命中 → 拿 x86 的哈希去校验 x64 的包 →
  // 误报「哈希与清单声明不一致」→ 拒绝安装并白跑一次 winget 兜底。
  // 所以强别名先全部试一遍，弱别名（只有 win32）只在没有更强线索时兜底。
  const STRONG_ALIASES = {
    x64: ["x64", "64-bit", "64bit", "win64", "amd64"],
    arm64: ["arm64", "aarch64", "winarm"],
    x86: ["x86", "32-bit", "32bit", "ia32"],
  };
  const WEAK_ALIASES = { x86: ["win32"] };
  const name = String(fileName || "").toLowerCase();
  const pick = (aliasTable) => {
    for (const k of keys) {
      if (k === "any") continue;
      const probes = aliasTable[k] || (aliasTable === WEAK_ALIASES ? [] : [k]);
      if (probes.some((p) => name.includes(p))) return map[k];
    }
    return null;
  };
  const strong = pick(STRONG_ALIASES);
  if (strong) return strong;
  const weak = pick(WEAK_ALIASES);
  if (weak) return weak;
  // 只有一份哈希（绝大多数单架构包）时可以直接用它
  if (keys.length === 1) return map[keys[0]];
  return null;
}

/** 校验已下载的安装包；返回 {ok, skipped, expected, actual, error}。 */
export async function verifyInstallerHash(installerPath, info, arch, log) {
  const expected = pickInstallerSha256(info, arch, basename(installerPath));
  if (!expected) {
    if (log) log("info", "清单里没有可配对的 InstallerSha256，跳过本地复核（winget 下载时已校验过一次）");
    return { ok: true, skipped: true };
  }
  if (!/^[0-9a-f]{64}$/.test(expected)) return { ok: true, skipped: true };
  const actual = await sha256File(installerPath);
  if (!actual) {
    return { ok: false, error: `安装包无法读取，无法校验哈希：${installerPath}` };
  }
  if (actual !== expected) {
    return {
      ok: false,
      expected,
      actual,
      error: `安装包哈希与清单声明不一致（可能被替换或下载损坏）\n  期望 ${expected}\n  实际 ${actual}`,
    };
  }
  if (log) log("info", `安装包哈希复核通过（SHA-256 ${actual.slice(0, 16)}…）`);
  return { ok: true, expected, actual };
}

/** 根据安装包类型给出静默安装参数（清单没写时的兜底）。 */
export function defaultSilentArgs(installerType, filePath) {
  const type = String(installerType || "").toLowerCase();
  const ext = String(filePath || "").toLowerCase();
  if (type === "msi" || ext.endsWith(".msi")) return ["/qn", "/norestart"];
  if (type === "inno" || type === "innosetup") return ["/SP-", "/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART"];
  if (type === "nullsoft" || type === "nsis") return ["/S"];
  if (type === "burn" || type === "wix") return ["/quiet", "/norestart"];
  if (type === "msix" || type === "appx") return [];
  // 未知 exe：优先 Inno 参数（国内/开源软件最常见），失败时由上层改用 winget upgrade
  return ["/S"];
}

/** 把清单里的 Silent 字符串切成参数数组（保留引号内的整体）。 */
export function splitSwitchArgs(silent) {
  const text = String(silent || "").trim();
  if (!text) return [];
  const out = [];
  let current = "";
  let quote = null;
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === " ") {
      if (current) {
        out.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current) out.push(current);
  return out;
}

/**
 * 决定用什么参数跑安装包。
 *
 * 顺序很重要：清单里声明的 Silent 参数优先（那是发布方自己给的、与安装包
 * 完全匹配的一组开关）；没有清单时才按安装包类型猜。
 *
 * 注意：清单里的 `/LOG="<LOGPATH>"` 是占位符模板，不能原样传，所以这里只
 * 取 Silent / SilentWithProgress 两项，占位符再单独剔除。
 */
export function resolveInstallArgs(info, installerPath) {
  const declared = (info && (info.silent || info.silentWithProgress)) || "";
  // 占位符模板（<LOGPATH> / <INSTALLPATH>）不能原样传给安装包：删掉占位符，
  // 再把因此变空值的开关（形如 /LOG=）整条剔除。
  const cleaned = String(declared).replace(/<[A-Za-z_]+>/g, "").replace(/\s+/g, " ").trim();
  const declaredArgs = splitSwitchArgs(cleaned).filter((a) => {
    if (!a) return false;
    if (/^\/?[A-Za-z]+=$/.test(a)) return false; // /LOG= 这类空值开关
    return true;
  });
  if (declaredArgs.length) return declaredArgs;
  return defaultSilentArgs(info && info.installerType, installerPath);
}

/* ------------------------------------------------------------------ *
 * 扫描
 * ------------------------------------------------------------------ */

export function resolveDownloadDir(settings) {
  const custom = String((settings && settings.downloadDir) || "").trim();
  if (custom && isAbsolute(custom)) return custom;
  return join(homedir(), "Downloads", "DSH App Updater");
}

function isStoreId(id) {
  return /^(MSIX|MSSTORE)\\/i.test(String(id || ""));
}

/**
 * 执行一次完整扫描。
 * @param {{ settings: object, log: (level: string, text: string) => void, signal?: AbortSignal }} ctx
 */
export async function scanApps({ settings, log, signal }) {
  const startedAt = Date.now();
  const warnings = [];
  const env = currentEnvironment();

  log("info", `运行环境：${describeEnvironment(env)}（引擎：${engineFor(env.family)}）`);

  if (env.family === "macos") {
    return scanMacos({ settings, log, signal, env, startedAt, warnings });
  }
  if (env.family !== "windows") {
    log("warn", `当前系统 ${env.platform} 没有可用的更新引擎，本插件支持 Windows 与 macOS`);
    return {
      env,
      engine: { id: engineFor(env.family), available: false, version: "", path: "" },
      scannedAt: Date.now(),
      startedAt,
      stats: { total: 0, upgradable: 0, unsupported: 0 },
      items: [],
      warnings: [`当前系统 ${env.platform} 暂不支持（本插件面向 Windows 与 macOS）`],
    };
  }

  const wingetPath = findWinget();

  /** @type {Map<string, any>} */
  const byId = new Map();
  /** @type {Map<string, string>} id → available */
  const availableById = new Map();

  let wingetInfo = { available: false, version: "", path: wingetPath || "" };
  if (wingetPath) {
    const ver = await runWinget(wingetPath, ["--version"], { timeoutMs: 20000 });
    const version = parseWingetVersion(ver.stdout);
    wingetInfo = { available: ver.ok && !!version, version, path: wingetPath };
    if (!wingetInfo.available) warnings.push("winget 无法执行，仅使用注册表检测（无法判断是否有新版本）");
  } else {
    warnings.push("未找到 winget.exe，仅使用注册表检测（无法判断是否有新版本）");
  }

  if (wingetInfo.available) {
    log("info", "正在读取 winget 已安装清单…");
    const listRes = await runWinget(
      wingetPath,
      ["list", "--accept-source-agreements", "--disable-interactivity"],
      { timeoutMs: 240000, signal }
    );
    // 取消必须向上抛，绝不能把「被 kill 剩下的半截 stdout」解析成清单去覆盖上一次完整结果
    if (signal && signal.aborted) throw new Error("扫描已取消");
    if (!listRes.ok && isWingetUnavailable(listRes)) {
      warnings.push(`winget list 失败：${firstLine(outputText(listRes)) || "未知错误"}`);
      wingetInfo.available = false;
    } else if (!listRes.ok) {
      // 超时被杀：stdout 是半截的。如实警告并降级到注册表源，而不是静默当成「就这么几个应用」。
      warnings.push(`winget list ${listRes.error === "timeout" ? "超时" : `异常退出（exit ${listRes.code}）`}：本次已安装清单可能不完整`);
    } else {
      const installed = parseInstalledList(listRes.stdout);
      log("info", `winget 报告 ${installed.length} 个已安装条目`);
      for (const item of installed) {
        if (!item.id) continue;
        byId.set(item.id, {
          id: item.id,
          name: item.name || item.id,
          version: item.version || "",
          available: "",
          publisher: "",
          source: /^(MSIX|MSSTORE)\\/i.test(item.id) ? "msstore" : "winget",
          installLocation: "",
          hasUpdate: false,
          updateSupported: false,
          reason: null,
          kind: null,
        });
      }

      log("info", "正在向软件目录查询可用更新…");
      const upRes = await runWinget(
        wingetPath,
        ["upgrade", "--include-unknown", "--accept-source-agreements", "--disable-interactivity"],
        { timeoutMs: 240000, signal }
      );
      if (signal && signal.aborted) throw new Error("扫描已取消");
      // 只有 ok 才解析。原来的 `upRes.ok || upRes.stdout` 把超时/被杀残留的半截 stdout
      // 字符串真值当成功 → 解析出残缺清单 → hasUpdate 全 false → 用户看到「无更新」。
      // macOS 路径在 1.3.4 修过同款 bug（见 scanMacos），这次补上 Windows 侧。
      if (upRes.ok) {
        const upgradable = parseUpgradeList(upRes.stdout);
        log("info", `软件目录报告 ${upgradable.length} 个可更新条目`);
        for (const item of upgradable) {
          if (!item.id) continue;
          if (item.available) availableById.set(item.id, item.available);
          const existing = byId.get(item.id);
          if (existing) {
            existing.available = item.available || "";
            if (!existing.version && item.version) existing.version = item.version;
          } else {
            byId.set(item.id, {
              id: item.id,
              name: item.name || item.id,
              version: item.version || "",
              available: item.available || "",
              publisher: "",
              source: "winget",
              installLocation: "",
              hasUpdate: false,
              updateSupported: false,
              reason: null,
              kind: null,
            });
          }
        }
      } else {
        warnings.push(`查询可用更新失败（${upRes.error === "timeout" ? "超时" : `exit ${upRes.code}`}），本次只能显示已安装清单，可能漏报可更新应用`);
      }
    }
  }

  // 注册表兜底：补齐 winget 目录未收录的应用，并给 winget 条目补上发布者/安装位置
  // 用 `!== false` 而不是真值判断：缺字段时按默认「开启」处理，与 969/1085 行一致。
  // 真值判断会让「键不存在」被当成「用户关掉了」，静默丢掉整个注册表源。
  if (settings.includeRegistryOnly !== false) {
    if (signal && signal.aborted) throw new Error("扫描已取消");
    log("info", "正在读取注册表已安装应用…");
    const reg = await readRegistryApps(process.env, signal);
    if (!reg.ok) {
      warnings.push(`注册表读取失败：${reg.error || "未知错误"}`);
    } else {
      log("info", `注册表报告 ${reg.apps.length} 个应用`);
      const nameIndex = new Map();
      for (const app of byId.values()) nameIndex.set(normalizeName(app.name), app);
      for (const r of reg.apps) {
        const key = normalizeName(r.name);
        const matched = key ? nameIndex.get(key) : null;
        if (matched) {
          if (!matched.publisher && r.publisher) matched.publisher = r.publisher;
          if (!matched.installLocation && r.location) matched.installLocation = r.location;
          if (!matched.version && r.version) matched.version = r.version;
          continue;
        }
        const id = `reg:${r.key || key || r.name}`;
        if (byId.has(id)) continue;
        byId.set(id, {
          id,
          name: r.name,
          version: r.version || "",
          available: "",
          publisher: r.publisher || "",
          source: "registry",
          installLocation: r.location || "",
          hasUpdate: false,
          updateSupported: false,
          reason: null,
          kind: null,
        });
      }
    }
  }

  // 汇总判定
  const items = [];
  // 修坑：Windows 侧也统计 manual（目录里有新版但本插件判为不可一键更新）。
  // item.available 在 !hasUpdate 时会被清空，只能用汇总时的局部 available 计数。
  let manualCount = 0;
  for (const app of byId.values()) {
    if (!settings.includeStoreApps && app.source === "msstore") continue;
    if (settings.includeRegistryOnly === false && app.source === "registry") continue;
    const available = app.available || availableById.get(app.id) || "";
    let hasUpdate = false;
    let reason = null;
    let updateSupported = false;

    if (isStoreId(app.id) || app.source === "msstore") {
      reason = "store-managed";
    } else if (!available) {
      reason = app.source === "registry" ? "not-in-catalog" : null;
    } else if (!looksLikeVersion(app.version)) {
      // winget 显示 Unknown：无法确认是否真的更新，按可更新处理但不静默判定
      hasUpdate = true;
      updateSupported = true;
    } else if (isNewer(available, app.version)) {
      hasUpdate = true;
      updateSupported = true;
    } else {
      hasUpdate = false;
    }

    if (hasUpdate && !updateSupported && !reason) reason = "unknown-version";
    // 有 available 但没被判为可更新、且不是「商店托管」→ 需手动处理（store-managed/not-in-catalog 不计）。
    if (!hasUpdate && available && reason !== "store-managed") manualCount += 1;
    items.push({
      ...app,
      available: hasUpdate ? available : "",
      hasUpdate,
      updateSupported,
      reason: hasUpdate && updateSupported ? null : reason,
    });
  }

  items.sort((a, b) => {
    if (a.hasUpdate !== b.hasUpdate) return a.hasUpdate ? -1 : 1;
    if (a.updateSupported !== b.updateSupported) return a.updateSupported ? -1 : 1;
    return String(a.name).localeCompare(String(b.name), "zh-Hans-CN");
  });

  const stats = {
    total: items.length,
    upgradable: items.filter((i) => i.hasUpdate && i.updateSupported).length,
    // 修坑：补 manual 口径，让「可更新 + 需手动 + 不支持」与 total 自洽（与 macOS 对齐）。
    manual: manualCount,
    unsupported: items.filter((i) => i.hasUpdate && !i.updateSupported).length,
  };

  log("success", `扫描完成：${stats.total} 个应用，${stats.upgradable} 个可更新`);

  return {
    env,
    engine: {
      id: ENGINE_WINGET,
      available: Boolean(wingetInfo.available),
      version: wingetInfo.version || "",
      path: wingetInfo.path || "",
    },
    winget: wingetInfo,
    scannedAt: Date.now(),
    startedAt,
    stats,
    items,
    warnings,
  };
}

/* ------------------------------------------------------------------ *
 * 提权、复核与「自带更新服务」
 * ------------------------------------------------------------------ */

/**
 * winget 报「清单里没有可用安装包」一类错误（本机架构没有对应安装包）。
 * 中文输出是「找不到适用的安装程序」，英文是 “No applicable installer found”。
 *
 * 这类失败必须退回「不限架构」再来一次：虎牙直播（Huya.Huya）的清单里只有
 * 一个不标架构的通用 exe，带上 `--architecture x64` 就永远找不到。
 */
export function isArchNotFoundError(text) {
  const raw = String(text || "");
  if (!raw) return false;
  return /architecture|架构|applicable installer|not applicable|找不到适用|没有适用/i.test(raw);
}

/** 安装器退出码 → 人话。输出为空时兜底；MSI 的真实原因在它自己的日志里。 */
export function explainInstallerExitCode(code, text) {
  const first = firstLine(text);
  if (first) return first;
  const map = {
    1603: "安装程序返回 1603（安装失败：常见原因是权限不足、文件被占用或已装其它版本；MSI 详情见日志）",
    1619: "安装程序返回 1619（安装包无法打开）",
    1620: "安装程序返回 1620（安装包损坏或不可读）",
    1625: "安装程序返回 1625（被系统策略禁止）",
    1638: "安装程序返回 1638（已安装其它版本）",
    1730: "安装程序返回 1730（卸载/安装需要管理员权限）",
  };
  return map[code] || `安装程序退出码 ${code}`;
}

/**
 * 判断一次更新是否真的生效。
 *
 * 只看安装器退出码是不够的：机器级安装包在没有管理员令牌时会**静默退出 0**
 * 却什么都没装（实测 Logitech G HUB 2026.6.981214 → 目标 2026.7.992920，
 * 退出码 0，Program Files 里的文件与 winget 报的版本都没有变化）。
 * 所以拿「安装前版本 / 安装后版本 / 目标版本」三个值判断，判不出来才算失败。
 *
 * @returns {{changed: boolean, reason: string}}
 */
export function evaluateUpdateResult({ before, after, target }) {
  const a = String(after == null ? "" : after).trim();
  const b = String(before == null ? "" : before).trim();
  const t = String(target == null ? "" : target).trim();
  // winget 读不到已装版本（虎牙直播的卸载信息里就没有版本号）→ 无法复核：
  // 既不能判生效也不能判失败，交给调用方按「已安装、未复核」处理。
  if (!looksLikeVersion(a)) {
    return {
      changed: false,
      unverifiable: true,
      reason: a ? `winget 读不到已装版本（显示为 ${a}）` : "安装后读不到版本",
    };
  }
  // 达到或超过目标版本 → 生效
  if (t && !isNewer(t, a)) {
    return { changed: true, reason: `版本已是 ${a}（目标 ${t}）` };
  }
  // 目标版本未知时，只能看它是否真的变新了
  if (b && looksLikeVersion(b) && isNewer(a, b)) {
    return { changed: true, reason: `版本从 ${b} 升到 ${a}` };
  }
  if (t) return { changed: false, reason: `版本没有变化（仍为 ${a}，目标 ${t}）` };
  return { changed: false, reason: `版本没有变化（仍为 ${a}）` };
}

/** 可取消的等待。 */
function delay(ms, signal) {
  return new Promise((resolve) => {
    if (signal && signal.aborted) {
      resolve();
      return;
    }
    const finish = () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    if (signal) signal.addEventListener("abort", finish, { once: true });
  });
}

/** 提权跑 winget：winget 自己的安装动作同样需要管理员令牌才能装机器级包。 */
async function runWingetElevated(wingetPath, args, opts = {}) {
  const res = await runElevated(wingetPath, args, { timeoutMs: opts.timeoutMs, signal: opts.signal });
  return {
    ok: res.ok,
    code: res.code,
    stdout: res.stdout || "",
    stderr: "",
    error: res.spawnError ? "spawn" : res.timedOut ? "timeout" : null,
  };
}

/**
 * 本轮的「目标版本」表：复核「到底升没升上去」的依据。
 * 用一次 `winget upgrade --include-unknown` 拿全量（含已装版本为 Unknown 的应用）。
 */
async function fetchUpgradeTargets(wingetPath, ctx, signal) {
  const map = new Map();
  if (!wingetPath) return map;
  try {
    const res = await ctx.runWinget(
      wingetPath,
      ["upgrade", "--include-unknown", "--accept-source-agreements", "--disable-interactivity"],
      { timeoutMs: 240000, signal }
    );
    if (res.ok) {
      for (const row of parseUpgradeList(res.stdout)) {
        const key = String(row.id || "").toLowerCase();
        if (key && row.available) map.set(key, row.available);
      }
    }
  } catch {
    // 拿不到目标版本时退化为「只看版本有没有变化」
  }
  return map;
}

/**
 * 自带更新服务的软件：winget 目录里给的是**企业版**安装包，与本机的消费版
 * 安装技术不匹配，winget 会直接拒绝（0x8A15008E「安装技术与当前安装的版本
 * 不同，请卸载包并安装较新版本」）。这类软件交给它自己的更新服务。
 */
const SELF_UPDATERS = new Map([
  ["microsoft.edge", "edgeupdate"],
  ["microsoft.edgewebview2runtime", "edgeupdate"],
  ["microsoft.edgewebview", "edgeupdate"],
]);

/**
 * 少数软件的更新不由安装包完成，而是由它自己的常驻更新器在**应用启动时**应用
 * （实测 Logitech G HUB：更新包早就下载好躺在 %ProgramData%\LGHUB\next.json 指向的
 * depots 里，安装器 `--silent` 和 winget upgrade 都退出 0 什么都不做，只有启动
 * G HUB 本体后 current.json 才跳到新版本）。
 *
 * 插件承诺「不需要打开被检测的软件」，所以这里只给提示，不替用户启动 app。
 */
const UPDATE_HINTS = new Map([
  [
    "logitech.ghub",
    "G HUB 的更新由它自己的更新器在「启动 G HUB」时应用：安装包与 winget 都可能退出 0 而不生效，手动打开一次 G HUB 即可完成升级（插件不会替你启动软件）",
  ],
  [
    "microsoft.edge",
    "Edge 由 EdgeUpdate 服务维护；该服务不可用时插件会退回安装官网全量包（企业版 MSI，提权执行）",
  ],
]);

/** 这条应用有没有「安装之外的更新方式」提示。 */
export function updateHintFor(id) {
  return UPDATE_HINTS.get(String(id || "").toLowerCase()) || "";
}

/** 定位 Microsoft Edge 自带的更新服务。 */
export function findEdgeUpdate(env = process.env) {
  const roots = [
    env["ProgramFiles(x86)"],
    env.ProgramFiles,
    "C:\\Program Files (x86)",
    "C:\\Program Files",
  ].filter(Boolean);
  for (const root of roots) {
    const file = join(root, "Microsoft", "EdgeUpdate", "MicrosoftEdgeUpdate.exe");
    try {
      if (existsSync(file)) return file;
    } catch {
      // 受保护目录读不到时继续找下一个
    }
  }
  return null;
}

/**
 * 触发自带更新服务（目前只有 Edge）。
 * 它的退出码不代表版本已经就位（只是把任务交给服务），所以交给 verifyInstalled 轮询确认。
 */
async function runSelfUpdater(kind, log, signal, ctx) {
  if (kind !== "edgeupdate") return { ok: false, error: "未知的自带更新方式" };
  const exe = findEdgeUpdate();
  if (!exe) return { ok: false, error: "未找到 MicrosoftEdgeUpdate.exe（Edge 自带更新服务）" };
  log("info", "改用 Edge 自带更新服务（winget 目录里是企业版 MSI，与本机消费版 Edge 的安装技术不匹配）");
  const res = await ctx.run(exe, ["/ua"], { timeoutMs: 30 * 60 * 1000, signal });
  if (res.spawnError) return { ok: false, error: res.spawnError };
  if (res.timedOut) return { ok: false, error: "Edge 自带更新服务超时" };
  return { ok: true, note: "已交给 Microsoft Edge 更新服务，等待版本就位" };
}

/**
 * 安装后复核：读已装版本，与目标/安装前版本比对，必要时轮询等待
 * （Edge 这类自带更新服务不是同步生效的）。
 */
async function verifyInstalled({ wingetPath, id, before, target, signal, log, attempts = 1, delayMs = 15000, maxTotalMs = 5 * 60 * 1000 }) {
  let version = "";
  let verdict = { changed: false, reason: "尚未复核" };
  const rounds = Math.max(1, attempts);
  // 修坑：固定间隔轮询改成「首轮立即 + 递增退避 + 总时限」。原来固定 15s 要么早放弃、
  // 要么白等到超时；现在 delayMs 可为数值或函数 (i)=>ms，数值按 base*1.5^i 递增（封顶 30s），
  // 累计等待超过 maxTotalMs 提前退出。返回对象形状不变。
  const base = typeof delayMs === "function" ? 0 : Number(delayMs) || 0;
  const STEP_CAP_MS = 30000;
  const delayFor = (i) => {
    if (typeof delayMs === "function") return Math.max(0, Number(delayMs(i)) || 0);
    return Math.min(base * Math.pow(1.5, i), STEP_CAP_MS);
  };
  let waited = 0;
  for (let i = 0; i < rounds; i += 1) {
    if (signal && signal.aborted) break;
    version = await readInstalledVersion(wingetPath, id, signal);
    verdict = evaluateUpdateResult({ before, after: version, target });
    if (verdict.changed || verdict.unverifiable) return { ...verdict, version };
    if (i + 1 < rounds) {
      const step = delayFor(i);
      // 总时限：累计已等待 + 本次间隔会超限就提前退出，不再空等
      if (waited + step > maxTotalMs) {
        if (log) log("info", `${id}：复核已等待 ${Math.round(waited / 1000)}s，达到总时限 ${Math.round(maxTotalMs / 1000)}s，停止轮询`);
        break;
      }
      if (log && i === 0) {
        log("info", `${id}：暂未读到新版本（${version || "未知"}），继续等待…`);
      }
      await delay(step, signal);
      waited += step;
    }
  }
  return { ...verdict, version };
}

function firstLine(text) {
  const line = String(text || "").trim().split("\n")[0] || "";
  return line.slice(0, 200);
}

/**
 * 从 brew 的失败输出里挑出**真正的错误行**。
 *
 * 为什么不能用 `firstLine(outputText(res))`：outputText 是 stdout + stderr 拼接，
 * 首行通常是 `==> Installing Cask awesun` 这种**过程行**，而真正的失败原因在 stderr
 * 更靠后的位置。实测：AweSun / UURemote 更新失败，界面只显示
 * 「==> Installing Cask awesun」——用户完全看不出为什么失败。
 *
 * 挑选顺序：Error: / Warning: 开头的行 → 含失败关键词的行 → stderr 最后一行
 * → 实在没有才退回首行。始终取第一条命中的（最贴近根因）。
 */
export function brewErrorLine(res) {
  const stderr = String((res && res.stderr) || "").trim();
  const stdout = String((res && res.stdout) || "").trim();
  const KEY = /(Error:|Failed|failed|cannot|Cannot|not found|No such|Permission denied|denied|aborted|curl:|downloading|checksum|SHA|already)/i;
  const scan = (text) => {
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      // 过程行（==> / Downloading / Fetching / Installing 之类）不算错误
      if (/^(==>|->|Warning: Cask)/.test(line)) continue;
      if (KEY.test(line)) return line.slice(0, 300);
    }
    return "";
  };
  const fromErr = scan(stderr);
  if (fromErr) return fromErr;
  const fromOut = scan(stdout);
  if (fromOut) return fromOut;
  // 都没有：用 stderr 最后一行（通常是 ruby 抛出的那句话）
  const lastErr = stderr.split("\n").map((l) => l.trim()).filter(Boolean).pop() || "";
  if (lastErr) return lastErr.slice(0, 300);
  /* stdout 里也挑不出错误行：取**最后一行非过程行**（brew 失败时常把说明写在尾部），
     全都只有过程行时返回空串 —— 让调用方拼上「退出码 N」，
     绝不能把 `==> Installing Cask xxx` 这种过程行当成失败原因展示给用户。 */
  const tail = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/^(==>|->|\u{1F37A}|\u2714)/u.test(l))
    .pop();
  return tail ? tail.slice(0, 300) : "";
}

/* ------------------------------------------------------------------ *
 * 更新
 * ------------------------------------------------------------------ */

/** 目录快照，用于在 winget download 后找出新增文件。 */
async function snapshotDir(dir) {
  const map = new Map();
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isFile()) continue;
      try {
        const st = await stat(join(dir, e.name));
        map.set(e.name, st.mtimeMs);
      } catch {
        /* 文件在扫描间隙被删掉 */
      }
    }
  } catch {
    /* 目录不存在 */
  }
  return map;
}

/** 把私有目录里下载好的文件搬回共享下载目录；目标已存在则加后缀，绝不覆盖。 */
async function moveIntoDownloadDir(src, dir, log) {
  try {
    let target = join(dir, basename(src));
    if (existsSync(target)) {
      // 修坑：同名文件可能来自其它并发下载或用户手动放置，加时间戳后缀，绝不覆盖。
      const name = basename(src);
      const dot = name.lastIndexOf(".");
      const stem = dot > 0 ? name.slice(0, dot) : name;
      const ext = dot > 0 ? name.slice(dot) : "";
      target = join(dir, `${stem}-${Date.now()}-${process.pid}${ext}`);
    }
    try {
      await rename(src, target);
    } catch (e) {
      // 修坑：跨卷时 rename 抛 EXDEV，退回 copyFile + rm，保证回迁不失败。
      if (e && e.code === "EXDEV") {
        await copyFile(src, target);
        await rm(src, { force: true });
      } else {
        throw e;
      }
    }
    /* 落一个侧车标记，供磁盘配额清理识别「这是本插件产出的文件」。
       标记写失败不阻断下载（最坏情况只是这个文件不被自动清理）。 */
    try {
      await writeFile(`${target}${OWNED_SIDECAR}`, JSON.stringify({ createdAt: Date.now(), source: "dsh-app-updater" }), "utf8");
    } catch {
      /* 忽略 */
    }
    return target;
  } catch (e) {
    if (log) log("warn", `安装包回迁下载目录失败：${basename(src)}（${String((e && e.message) || e)}）`);
    return "";
  }
}

/** 只对「超时 / 网络抖动」类下载失败重试；明确的业务失败（无此包 / 无适用安装程序）不重试。 */
function isRetryableDownloadError(res, text) {
  const raw = String(text || "");
  if (isArchNotFoundError(raw)) return false;
  if (/not found|找不到|No package found|No available upgrade|No newer package|hash does not match|哈希不匹配|DownloadCommandProhibited|requires administrator|需要管理员|Access is denied|被拒绝访问/i.test(raw)) return false;
  if (res && (res.error === "timeout" || res.timedOut || res.error === "spawn")) return true;
  return /timeout|timed out|超时|connection|连接|network|网络|unable to|could not|failed to|download.*fail|下载失败|HTTP [45]\d\d|TLS|SSL|DNS|reset|refused|中断|0x8007|0x8a15/i.test(raw);
}

/**
 * 下载目录磁盘配额清理：只删本插件产出的安装包/清单，按 mtime 从旧到删，
 * 直到总大小 ≤ maxBytes。失败静默但写 warn 日志（不能因为清理失败阻断更新）。
 */
async function pruneDownloadDir(dir, maxBytes, log) {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const files = [];
    let total = 0;
    for (const e of entries) {
      if (!e.isFile() || !DOWNLOAD_ARTIFACT.test(e.name)) continue;
      // 只认「有本插件侧车标记」的文件：绝不误删用户放在同一目录里的 .exe/.dmg/.yaml
      const sidecar = join(dir, `${e.name}${OWNED_SIDECAR}`);
      if (!existsSync(sidecar)) continue;
      try {
        const st = await stat(join(dir, e.name));
        files.push({ name: e.name, size: st.size, mtime: st.mtimeMs, sidecar });
        total += st.size;
      } catch { /* 文件在扫描间隙被删掉 */ }
    }
    if (total <= maxBytes) return;
    files.sort((a, b) => a.mtime - b.mtime); // 旧 → 新
    for (const f of files) {
      if (total <= maxBytes) break;
      try {
        await rm(join(dir, f.name), { force: true });
        await rm(f.sidecar, { force: true });
        total -= f.size;
        if (log) log("info", `下载目录超过配额，已清理本插件旧安装包：${f.name}`);
      } catch (e) {
        if (log) log("warn", `清理旧安装包失败：${f.name}（${String((e && e.message) || e)}）`);
      }
    }
  } catch (e) {
    if (log) log("warn", `下载目录配额清理跳过：${String((e && e.message) || e)}`);
  }
}

/**
 * 下载官网全量安装包。
 * @returns {Promise<{ok:boolean, installer?:string, manifest?:string, info?:object, error?:string}>}
 */
async function downloadInstaller(wingetPath, id, dir, log, signal, opts = {}) {
  await mkdir(dir, { recursive: true });
  // 修坑：每次下载用独立私有子目录，目录 diff 只在私有目录内进行 —— 并发下载时不会再
  // 把「别的任务刚落盘的安装包 / 用户自己放进共享下载目录的文件」错认成自己的安装包。
  const safeId = String(id).replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80) || "app";
  const workDir = join(dir, `.dsh-dl-${safeId}-${Date.now()}-${process.pid}`);
  const env = opts.env || currentEnvironment();
  const archFlag = opts.matchArch === false ? "" : env.wingetArch || "";

  // 单次下载：重建私有目录（清掉上次失败可能留下的半个文件）→ 跑 winget → 返回输出与快照。
  const runDownload = async (flag) => {
    await rm(workDir, { recursive: true, force: true });
    await mkdir(workDir, { recursive: true });
    const before = await snapshotDir(workDir);
    const args = [
      "download",
      "--id",
      id,
      "--download-directory",
      workDir,
      "--accept-package-agreements",
      "--accept-source-agreements",
      "--disable-interactivity",
    ];
    if (flag) args.push("--architecture", flag);
    const res = await runWinget(wingetPath, args, { timeoutMs: 30 * 60 * 1000, signal });
    return { before, res, text: outputText(res) };
  };

  try {
    if (archFlag) log("info", `按本机架构选择安装包：${env.archLabel}（--architecture ${archFlag}）`);
    else log("info", `未指定架构，交给 winget 自动匹配（${env.archLabel}）`);
    log("info", `下载官网全量安装包：${id}`);

    let currentFlag = archFlag;
    let { before, res, text } = await runDownload(currentFlag);

    // 指定架构失败（清单里没有这一架构的安装包）时，退回让 winget 自己挑，并如实记录。
    if (!res.ok && currentFlag && isArchNotFoundError(text)) {
      log("warn", `${id}：清单里没有 ${archFlag} 架构的安装包，改为自动匹配`);
      currentFlag = "";
      ({ before, res, text } = await runDownload(currentFlag));
    }

    // 修坑：网络抖动/超时最多重试 2 次（间隔 1s / 3s）；明确「无此 id / 无适用安装程序」不重试。
    // 只加在 winget download，brew 路径不重试。
    for (let attempt = 0; attempt < 2 && !res.ok && !(signal && signal.aborted) && isRetryableDownloadError(res, text); attempt += 1) {
      const waitMs = attempt === 0 ? 1000 : 3000;
      log("warn", `${id}：下载疑似网络错误（${firstLine(text) || res.error || "未知"}），${waitMs / 1000}s 后重试（第 ${attempt + 2} 次）`);
      await delay(waitMs, signal);
      if (signal && signal.aborted) break;
      ({ before, res, text } = await runDownload(currentFlag));
    }

    if (!res.ok) {
      const err = classifyWingetError(text) || `winget download 退出码 ${res.code}`;
      return { ok: false, error: err };
    }

    // 首选：从 winget 双语「安装程序已下载:」输出定位（中英都要认，原来只认英文会
    // 掉到不可靠的目录 diff，进而误报「没找到安装包」触发重复下载）。
    let installer = null;
    const m = text.match(/(?:Installer downloaded|安装程序已下载)\s*[:：]\s*(.+?)\s*$/m);
    if (m) {
      const candidate = m[1].trim().replace(/^["']|["']$/g, "");
      // 修坑：只按文件名折回私有目录，绝不信任输出里的绝对目录去搬共享目录里的其它文件。
      const candidatePath = join(workDir, basename(candidate));
      try {
        if ((await stat(candidatePath)).isFile()) installer = candidatePath;
      } catch { /* 输出路径不可信，退回目录 diff */ }
    }
    if (!installer) {
      const after = await snapshotDir(workDir);
      const fresh = [];
      for (const [name, mtime] of after) {
        if (!before.has(name) || before.get(name) !== mtime) fresh.push(name);
      }
      const pick = fresh.find((n) => INSTALLER_EXT.test(n)) || fresh.find((n) => /\.ya?ml$/i.test(n));
      if (pick) installer = join(workDir, pick);
    }
    if (!installer) return { ok: false, error: "下载完成但没找到安装包文件" };

    let manifest = null;
    const manifestGuess = installer.replace(INSTALLER_EXT, ".yaml");
    try {
      const st = await stat(manifestGuess);
      if (st.isFile()) manifest = manifestGuess;
    } catch {
      const after = await snapshotDir(workDir);
      const yaml = [...after.keys()].find((n) => /\.ya?ml$/i.test(n) && n.includes(basename(installer).split("_")[0]));
      if (yaml) manifest = join(workDir, yaml);
    }

    let info = {};
    if (manifest) {
      try {
        info = parseInstallerManifest(await readFile(manifest, "utf8"));
      } catch {
        info = {};
      }
    }

    // 把安装包 + 清单搬回共享下载目录（目标已存在则加后缀，绝不覆盖其它任务/用户的文件）。
    const movedInstaller = await moveIntoDownloadDir(installer, dir, log);
    if (!movedInstaller) return { ok: false, error: "下载完成但安装包回迁失败" };
    const movedManifest = manifest ? await moveIntoDownloadDir(manifest, dir, log) : null;
    return { ok: true, installer: movedInstaller, manifest: movedManifest, info };
  } finally {
    // 修坑：无论成功/失败都清掉私有工作目录，不在共享下载目录里留 .dsh-dl-* 残留。
    try {
      await rm(workDir, { recursive: true, force: true });
    } catch (e) {
      log("warn", `清理下载临时目录失败：${workDir}（${String((e && e.message) || e)}）`);
    }
  }
}

/** 执行安装包（静默）。 */
async function runInstaller(installer, info, log, signal, ctx = {}) {
  const ext = String(installer).toLowerCase();
  const isMsi = ext.endsWith(".msi");
  const run = ctx.run || runProcess;
  const args = resolveInstallArgs(info, installer);
  const exe = isMsi ? join(process.env.SystemRoot || "C:\\Windows", "System32", "msiexec.exe") : installer;
  // 安装失败时唯一能说明原因的现场就是 MSI 自己的日志（Error 1925 / 1603 …），
  // 所以顺手开一份；日志路径由调用方提供一个可写目录（临时目录里没有空格）。
  const msiLog = isMsi && ctx.scratchDir
    ? join(ctx.scratchDir, `${basename(installer).replace(/[^\w.-]+/g, "_")}.msi.log`)
    : "";
  const finalArgs = isMsi ? ["/i", installer, ...args, ...(msiLog ? ["/l*v", msiLog] : [])] : args;
  log("info", `静默安装：${basename(installer)} ${finalArgs.join(" ")}`.trim());
  if (ctx.elevated) log("info", "安装步骤在管理员上下文中执行（自动提权）");
  const res = await run(exe, finalArgs, { timeoutMs: 60 * 60 * 1000, signal });
  const text = outputText(res);
  if (res.spawnError) return { ok: false, error: res.spawnError, code: null };
  if (res.timedOut) return { ok: false, error: "安装超时（60 分钟）", code: null };
  if (res.code !== 0) {
    // 3010 = 需要重启，属成功
    if (res.code === 3010) return { ok: true, code: res.code, note: "安装完成，需重启生效" };
    const detail = msiLog && existsSync(msiLog) ? `；MSI 日志：${msiLog}` : "";
    return { ok: false, error: explainInstallerExitCode(res.code, text) + detail, code: res.code };
  }
  return { ok: true, code: 0 };
}

/**
 * 用 winget upgrade 兜底（同样是官网全量包，安装由 winget 执行）。
 *
 * 两道修正：
 *  1) 带上 `--include-unknown`：已装版本被 winget 读成 Unknown 的应用（虎牙直播）
 *     不带它就直接「目录里没有适用的更新」；
 *  2) 带架构过滤而失败时退回不限架构再试一次（清单里只有通用 exe 的应用）。
 */
async function wingetUpgradeFallback(wingetPath, id, log, signal, opts = {}) {
  const env = opts.env || currentEnvironment();
  const run = opts.run || runWinget;
  const archFlag = opts.matchArch === false ? "" : env.wingetArch || "";

  const attempt = async (flag) => {
    log("warn", `改用 winget upgrade 兜底：${id}（${flag ? "--architecture " + flag : "不限架构"}）`);
    const args = [
      "upgrade",
      "--id",
      id,
      "--exact",
      "--silent",
      "--include-unknown",
      "--accept-package-agreements",
      "--accept-source-agreements",
      "--disable-interactivity",
    ];
    if (flag) args.push("--architecture", flag);
    const res = await run(wingetPath, args, { timeoutMs: 60 * 60 * 1000, signal });
    return { res, text: outputText(res) };
  };

  let { res, text } = await attempt(archFlag);
  if (!res.ok && archFlag && isArchNotFoundError(text)) {
    // 清单里没有本机架构的安装包 → 交回 winget 自己挑
    ({ res, text } = await attempt(""));
  }
  if (res.ok) return { ok: true };
  const code = res.code;
  if (code === 3010) return { ok: true, note: "安装完成，需重启生效" };
  if ((code >>> 0) === 0x8a15002b) return { ok: false, error: "目录里没有适用的更新" };
  return { ok: false, error: classifyWingetError(text) || `winget upgrade 退出码 ${code}` };
}

/** 安装后复核版本。 */
async function readInstalledVersion(wingetPath, id, signal) {
  if (!wingetPath || id.startsWith("reg:")) return "";
  const res = await runWinget(
    wingetPath,
    ["list", "--id", id, "--exact", "--accept-source-agreements", "--disable-interactivity"],
    { timeoutMs: 60000, signal }
  );
  const rows = parseInstalledList(res.stdout);
  const row = rows.find((r) => r.id.toLowerCase() === id.toLowerCase()) || rows[0];
  return row ? row.version : "";
}

function classifyWingetError(text) {
  const raw = String(text || "");
  if (!raw.trim()) return "";
  if (/hash does not match|哈希不匹配|Installer hash/i.test(raw)) {
    return "官网安装包的哈希与软件目录记录不一致（发布方更新了安装包），可改用 winget upgrade 兜底，或以管理员身份执行 winget settings --enable InstallerHashOverride 后重试";
  }
  if (/DownloadCommandProhibited/i.test(raw)) return "该软件的清单禁止直接下载，只能通过 winget upgrade 安装";
  if (/requires administrator|需要管理员|elevat/i.test(raw)) return "需要管理员权限（会弹出 UAC 确认）";
  if (/No available upgrade found|No newer package/i.test(raw)) return "目录里没有适用的更新";
  if (/not found|找不到|No package found/i.test(raw)) return "软件目录里找不到该包";
  if (/被拒绝访问|Access is denied/i.test(raw)) return "访问被拒绝（可能需要以管理员身份运行）";
  const line = raw.split("\n").map((l) => l.trim()).filter((l) => l && !/^[-=]+$/.test(l)).pop() || "";
  return line.slice(0, 300);
}

/**
 * 串行执行一批更新。
 * @param {object} p
 * @param {string[]} p.ids
 * @param {object} p.settings
 * @param {(level: string, text: string) => void} p.log
 * @param {(patch: object) => void} p.onProgress 进度回调（写进 state.update）
 * @param {AbortSignal} p.signal
 */
export async function runUpdates({ ids, settings, log, onProgress, signal, plan = [] }) {
  const env = currentEnvironment();
  const matchArch = settings.matchSystemArch !== false;

  if (env.family === "macos") {
    // plan 必须往下传：非 Homebrew 应用要从中取 adoptToken 才能走 install --force。
    // 漏传的后果是「界面勾得动、后台一律报『无对应 cask』」—— 勾选与执行脱节。
    return runMacosUpdates({ ids, settings, log, onProgress, signal, env, plan });
  }

  const wingetPath = findWinget();
  const dir = resolveDownloadDir(settings);
  // 修坑：新一轮更新开始时按磁盘配额清理一次旧包（失败静默但写 warn）。
  await pruneDownloadDir(dir, MAX_DOWNLOAD_BYTES, log);
  const results = [];
  const queue = [...new Set(ids.filter(Boolean))];
  const planById = new Map(
    (Array.isArray(plan) ? plan : [])
      .map((item) => [String((item && item.id) || "").toLowerCase(), item])
      .filter(([key]) => key)
  );

  // 提权：机器级安装（MSI / 写 Program Files）需要管理员令牌，而进程令牌创建后无法
  // 原地提升，所以安装类命令交给提权副本执行（lib/elevate.js）。读版本、下载都不需要。
  const autoElevate = settings.autoElevate !== false;
  const elevatedNow = env.family === "windows" ? await isElevated({ signal }) : true;
  const useElevation = env.family === "windows" && autoElevate && !elevatedNow && elevationAvailable();
  const ctx = {
    run: (exe, args, o) => (useElevation ? runElevated(exe, args, o) : runProcess(exe, args, o)),
    runWinget: (exe, args, o) => (useElevation ? runWingetElevated(exe, args, o) : runWinget(exe, args, o)),
    elevated: useElevation,
    scratchDir: dir,
  };

  onProgress({ running: true, total: queue.length, done: 0, current: null, results: [], error: null, startedAt: Date.now() });
  log("info", `开始更新 ${queue.length} 个应用（${describeEnvironment(env)}，按架构匹配：${matchArch ? "是" : "否"}）`);
  if (env.family === "windows") {
    if (elevatedNow) log("info", "当前进程已具备管理员权限");
    else if (useElevation) log("info", "当前进程没有管理员权限：需要管理员的安装步骤会自动提权执行");
    else if (autoElevate) log("warn", "当前进程没有管理员权限，且找不到 powershell.exe：无法自动提权，机器级安装会失败");
    else log("warn", "当前进程没有管理员权限，且已关闭「自动提权安装」：机器级安装会失败（MSI 报 1925、安装器静默退出 0）");
  }

  // 「目标版本」表：安装后复核「到底升没升上去」的依据
  const targets = await fetchUpgradeTargets(wingetPath, ctx, signal);

  // 修坑：下载阶段并发化（原来完全串行，一个慢包拖住全部），并发度 3，用 appcast.js 同款
  // worker 模型；结果按 id 存 Map。安装/兜底/复核仍严格串行（UAC、安装互斥不能并发）。
  const dlResults = new Map();
  const consumedInstallers = new Set();
  if (wingetPath && queue.length && !signal.aborted) {
    let cursor = 0;
    let dlDone = 0;
    const worker = async () => {
      while (cursor < queue.length) {
        // 任一项被 abort 时其余 worker 尽快停下（已发出的子进程由 signal 负责 kill）。
        if (signal.aborted) return;
        const id = queue[cursor];
        cursor += 1;
        try {
          // 修坑：每次下载独立私有目录，彻底消除共享目录 diff 的并发竞态。
          const dl = await downloadInstaller(wingetPath, id, dir, log, signal, { env, matchArch });
          dlResults.set(id, dl);
        } catch (e) {
          dlResults.set(id, { ok: false, error: String((e && e.message) || e) });
        }
        dlDone += 1;
      }
    };
    log("info", `并发预下载 ${queue.length} 个安装包（并发度 ${Math.min(DOWNLOAD_CONCURRENCY, queue.length)}）`);
    await Promise.all(Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, queue.length) }, worker));
    log("info", `预下载阶段结束：成功 ${[...dlResults.values()].filter((d) => d && d.ok).length}/${dlDone}${settings.dryRun ? "（演练模式：到此为止，不进入安装阶段）" : ""}`);
  }

  let index = 0;
  for (const id of queue) {
    if (signal.aborted) {
      results.push({ id, ok: false, error: "已取消" });
      log("warn", `已取消：${id}`);
      break;
    }
    index += 1;
    onProgress({ running: true, total: queue.length, done: index - 1, current: id });
    log("info", `（${index}/${queue.length}）开始处理 ${id}`);

    const startedAt = Date.now();
    const target = targets.get(id.toLowerCase()) || "";
    const before = (planById.get(id.toLowerCase()) || {}).version || "";
    // 修坑：删掉从未写入的死字段 fromCache；把 client.js 渲染的字段初始化齐，各分支尽量写全。
    let entry = { id, ok: false, error: null, installer: null, manifest: null, note: null, verified: null, hash: null, installOk: false, selfUpdater: null, dryRun: false, unverifiable: false, durationMs: 0 };

    try {
      const selfUpdater = SELF_UPDATERS.get(id.toLowerCase());
      let settled = false;

      if (!wingetPath) {
        entry.error = "未找到 winget，无法下载官网安装包";
      } else if (selfUpdater && settings.useSelfUpdater !== false && !settings.dryRun) {
        // 先让软件自带的更新服务试一次；没生效就退回官网全量安装包。
        // Edge 的实测：EdgeUpdate 服务坏掉时 /ua 直接 0x80070002，而 winget 目录里的
        // 官方安装包（企业版 MSI）在提权下能正常把 Edge 装到目标版本 —— winget 自己
        // 拒绝执行只是因为「安装技术不同」这条策略。
        entry.selfUpdater = selfUpdater;
        const r = await runSelfUpdater(selfUpdater, log, signal, ctx);
        entry.note = r.note || null;
        if (r.ok) {
          const check = await verifyInstalled({
            wingetPath,
            id,
            before,
            target,
            signal,
            log,
            attempts: 14,
            delayMs: 10000,
            maxTotalMs: 240000,
          });
          entry.verified = check.version || null;
          if (check.changed || check.unverifiable) {
            settled = true;
            entry.ok = true;
            // 修坑：自带更新服务成功且复核通过时也要把 installOk 写全（client.js 会渲染）。
            entry.installOk = true;
            if (check.unverifiable) {
              // 修坑：明确「已安装·未复核」状态，不再只靠 warn 日志。
              entry.unverifiable = true;
              entry.note = `${entry.note ? entry.note + "；" : ""}已安装·未复核：${check.reason}`;
              log("warn", `${id} 已安装·未复核，${check.reason}`);
            } else {
              entry.note = `${entry.note ? entry.note + "；" : ""}复核通过：${check.reason}`;
              log("success", `${id} 更新完成，${check.reason}`);
            }
          } else {
            log("warn", `${id}：自带更新服务没有生效（${check.reason}），改用官网全量安装包`);
          }
        } else {
          log("warn", `${id}：${r.error}，改用官网全量安装包`);
        }
      }

      if (settled) {
        // 自带更新服务已经完成并复核过
      } else if (signal.aborted) {
        // 修坑：取消是主动行为，日志用 warn、文案用「已取消」，绝不把 undefined 拼进 error 日志。
        entry.error = entry.error || "已取消";
        log("warn", `${id} 已取消`);
      } else if (entry.error || !wingetPath) {
        log("error", `${id} 更新失败：${entry.error || "未知错误"}`);
      } else {
        // 修坑：下载已在并发预下载阶段完成，这里只取结果；失败仍按原串行语义走兜底/报错。
        const dl = dlResults.get(id) || { ok: false, error: signal.aborted ? "已取消" : "未开始下载" };
        if (dl.ok) {
          if (dl.installer) consumedInstallers.add(dl.installer);
          if (dl.manifest) consumedInstallers.add(dl.manifest);
        }
        if (!dl.ok) {
          entry.error = dl.error;
        } else if (settings.dryRun) {
          // 演练模式：照常从官网下载全量安装包并落盘，但不执行安装。
          entry.installer = dl.installer;
          entry.manifest = dl.manifest || null;
          entry.ok = true;
          // 修坑：演练没有真正安装，installOk 明确为 false（client.js 渲染字段写全）。
          entry.installOk = false;
          entry.dryRun = true;
          entry.note = "演练模式：已下载官网全量安装包，未执行安装";
          log("warn", `${id}：演练模式，已下载 ${basename(dl.installer)}，跳过安装`);
        } else {
          entry.installer = dl.installer;
          entry.manifest = dl.manifest || null;
          // 执行前本地复核 SHA-256：winget 下载时按清单校验过一次，但紧接着我们
          // 要（可能以**管理员**身份）执行这个文件，中途被替换/损坏就必须拦住。
          const hashCheck = await verifyInstallerHash(dl.installer, dl.info, env.wingetArch, log);
          entry.hash = hashCheck.skipped ? "skipped" : hashCheck.ok ? "verified" : "mismatch";
          if (!hashCheck.ok) {
            entry.error = hashCheck.error;
            log("error", `${id}：${hashCheck.error}`);
          } else {
            const inst = await runInstaller(dl.installer, dl.info, log, signal, ctx);
            if (inst.ok) {
              entry.ok = true;
              entry.installOk = true;
              entry.note = inst.note || null;
            } else {
              entry.error = inst.error;
            }
          }
        }

        // 修坑：设置名 hashFallbackUpgrade 名实不符 —— 它其实对「下载失败 / 安装失败 /
        // 哈希不符」任何失败都兜底，并非只针对哈希不符。为兼容保留设置名，这里注明真实语义。
        // 下载失败或安装失败 → winget upgrade 兜底（同样是官网全量包）
        if (!entry.ok && !entry.dryRun && settings.hashFallbackUpgrade !== false && !signal.aborted) {
          log("warn", `${id}：${entry.error || "未知错误"}，尝试 winget upgrade 兜底`);
          const fb = await wingetUpgradeFallback(wingetPath, id, log, signal, { env, matchArch, run: ctx.runWinget });
          if (fb.ok) {
            entry.ok = true;
            entry.installOk = true;
            entry.error = null;
            entry.note = fb.note || "已通过 winget 安装官网全量包";
          } else {
            entry.error = `${entry.error}；兜底失败：${fb.error}`;
          }
        }

        // 复核：退出码 0 ≠ 装上了。机器级安装包在没有管理员令牌时会静默退出 0 却什么都没装。
        if (entry.ok && !entry.dryRun && !signal.aborted) {
          const check = await verifyInstalled({
            wingetPath,
            id,
            before,
            target,
            signal,
            log,
            attempts: 8,
            delayMs: 8000,
            maxTotalMs: 180000,
          });
          entry.verified = check.version || null;
          if (check.changed) {
            entry.note = `${entry.note ? entry.note + "；" : ""}复核通过：${check.reason}`;
            log("success", `${id} 更新完成，${check.reason}`);
          } else if (check.unverifiable) {
            // 修坑：读不到已装版本时 ok 仍为 true（不改变「已安装」语义），但明确写出
            // unverifiable 字段 + 「已安装·未复核」文案，供 client.js 显示单独状态。
            entry.unverifiable = true;
            entry.note = `${entry.note ? entry.note + "；" : ""}已安装·未复核：${check.reason}`;
            log("warn", `${id} 已安装·未复核，${check.reason}`);
          } else {
            entry.ok = false;
            const hint = updateHintFor(id);
            entry.error = `安装报告成功，但没有生效：${check.reason}${hint ? `。${hint}` : ""}`;
            log("error", `${id} 更新失败：${entry.error}`);
          }
        } else if (entry.ok && entry.dryRun) {
          // 演练模式没有真正安装，不做版本复核
        } else if (entry.ok) {
          log("success", `${id} 更新完成`);
        } else {
          // 修坑：entry.error 可能未赋值，兜底避免日志里出现 undefined。
          log("error", `${id} 更新失败：${entry.error || "未知错误"}`);
        }
      }
    } catch (err) {
      entry.ok = false;
      entry.error = String((err && err.message) || err);
      log("error", `${id} 更新异常：${entry.error}`);
    }

    entry.durationMs = Date.now() - startedAt;
    // 修坑：演练模式要留包给用户（演练本意），补 !entry.dryRun；rm 失败写 warn 不再完全静默。
    if (!settings.keepInstallers && !entry.dryRun && entry.installer) {
      try {
        await rm(entry.installer, { force: true });
      } catch (e) {
        log("warn", `清理安装包失败：${basename(entry.installer)}（${String((e && e.message) || e)}）`);
      }
      // winget download 会同时落一份 .yaml 清单，别让它留在下载目录里
      if (entry.manifest) {
        try {
          await rm(entry.manifest, { force: true });
        } catch (e) {
          log("warn", `清理清单文件失败：${basename(entry.manifest)}（${String((e && e.message) || e)}）`);
        }
      }
    }
    results.push(entry);
    onProgress({ running: true, total: queue.length, done: index, current: null, results });
  }

  // 修坑：收尾统一清理 —— 未被任何 entry 消费的预下载包（如自带更新器成功时白下的包）、
  // .dsh-dl-* 临时目录残留、以及本次下载可能遗留的其它文件；rm 失败写 warn，不再完全静默。
  if (!settings.keepInstallers) {
    for (const dl of dlResults.values()) {
      if (!dl || !dl.ok) continue;
      for (const f of [dl.installer, dl.manifest]) {
        if (!f || consumedInstallers.has(f)) continue;
        try {
          await rm(f, { force: true });
        } catch (e) {
          log("warn", `清理未使用的下载文件失败：${basename(f)}（${String((e && e.message) || e)}）`);
        }
      }
    }
    try {
      const leftover = await readdir(dir, { withFileTypes: true });
      for (const e of leftover) {
        if (!e.isDirectory() || !e.name.startsWith(".dsh-dl-")) continue;
        try {
          await rm(join(dir, e.name), { recursive: true, force: true });
        } catch (err) {
          log("warn", `清理下载临时目录失败：${e.name}（${String((err && err.message) || err)}）`);
        }
      }
    } catch (e) {
      log("warn", `扫描下载目录临时残留失败：${String((e && e.message) || e)}`);
    }
  }

  const okCount = results.filter((r) => r.ok).length;
  onProgress({ running: false, total: queue.length, done: results.length, current: null, results, finishedAt: Date.now(), error: null });
  log(okCount === results.length ? "success" : "warn", `更新结束：成功 ${okCount} / ${results.length}`);
  return results;
}

/* ------------------------------------------------------------------ *
 * macOS：Homebrew cask 引擎
 *
 * Homebrew 自己会按当前 Mac 的架构取对应的 cask（Apple Silicon 走 arm64，
 * Intel 走 x86_64），所以这里不需要再拼下载地址；我们只负责把「已装版本 →
 * 可升级版本」读出来，并在用户确认后执行 upgrade / fetch。
 * ------------------------------------------------------------------ */

export function findBrew(env = process.env) {
  const candidates = [];
  if (env.HOMEBREW_PREFIX) candidates.push(join(env.HOMEBREW_PREFIX, "bin", "brew"));
  candidates.push("/opt/homebrew/bin/brew", "/usr/local/bin/brew", "/home/linuxbrew/.linuxbrew/bin/brew");
  const pathValue = env.PATH || env.Path || "";
  for (const entry of String(pathValue).split(":")) {
    const dir = entry.trim();
    if (dir.startsWith("/")) candidates.push(join(dir, "brew"));
  }
  for (const file of candidates) {
    try {
      if (lstatSync(file).isFile()) return file;
    } catch {
      /* 不可访问的候选路径 */
    }
  }
  return null;
}

async function runBrew(brewPath, args, opts = {}) {
  return runProcess(brewPath, args, {
    timeoutMs: opts.timeoutMs || 20 * 60 * 1000,
    signal: opts.signal,
    // 1.3.16：透传 onData —— brew 的过程行（==> Downloading / Installing / Moving…）
    // 由调用方接进运行日志。原来 macOS 更新一个应用 169 秒，界面全程停在
    // 「0/3 0%」没有任何过程可见性；proc.js 的 onData 一直在，只是这里没接。
    onData: opts.onData,
  });
}

/** `brew list --cask --versions` → Map(token → version)。 */
export function parseBrewCaskVersions(text) {
  const out = new Map();
  for (const line of String(text || "").split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 2) continue;
    out.set(parts[0], parts.slice(1).join(" "));
  }
  return out;
}

/** `brew outdated --json=v2 --cask --greedy` → Map(token → 可用版本)。 */
export function parseBrewOutdated(text) {
  const out = new Map();
  let json = null;
  try {
    json = JSON.parse(String(text || "").trim() || "{}");
  } catch {
    return out;
  }
  const casks = Array.isArray(json && json.casks) ? json.casks : [];
  for (const c of casks) {
    if (!c || !c.name) continue;
    const current = c.current_version || (Array.isArray(c.current_versions) ? c.current_versions[0] : "") || "";
    out.set(String(c.name), String(current));
  }
  return out;
}

async function scanMacos({ settings, log, signal, env, startedAt, warnings }) {
  const brewPath = findBrew();

  /* 取消检查：macOS 扫描里最慢的两步是「枚举 .app」与「cask 目录竞速」（单地址 60s），
     而这两步都不收 signal —— 旧实现点取消后要等它们跑完才响应，界面看起来像卡死。
     与 Windows 侧一致：取消一律向上抛，不当故障、不写红横幅。 */
  const throwIfAborted = () => {
    if (signal && signal.aborted) throw new Error("扫描已取消");
  };
  throwIfAborted();
  // 1.3.16：分阶段计时的起点（A/B/C 并发起跑）
  const phaseT0 = Date.now();

  /* ---------------------------------------------------------------- *
   * 1.3.16：三个互不依赖的阶段并发执行（原来严格串行相加）：
   *    A 枚举 .app（磁盘）  B brew 三连（version/list/outdated，子进程）
   *    C cask 目录竞速（网络，缓存命中时近零）
   *    冷启动时 B 可能因 brew 自动刷新自家 API 元数据耗时 20s+、C 竞速最长 60s，
   *    串行相加白等；并发后总时长 ≈ 三者最大值。热态（本机实测 1.2s）收益很小，
   *    但冷态从「相加」变「取最大」。各阶段原有的 catch/降级语义逐项保留。
   * ---------------------------------------------------------------- */

  /* A. 枚举「本机到底装了哪些应用」——不依赖 Homebrew。
     旧实现只读 `brew list --cask`，没走 Homebrew 装的应用一个都看不到，
     于是正常 Mac 上就是「未检测到任何已安装应用」。 */
  log("info", "正在枚举应用目录（/Applications 等）…");
  const appsPromise = scanAppBundles({ log });

  /* B. Homebrew：哪些 cask 已装、哪些有新版（没装 Homebrew 也继续）。 */
  const brewPhase = (async () => {
    let brewVersion = "";
    const brews = new Map();
    const outdated = new Map();
    if (!brewPath) {
      warnings.push("未找到 Homebrew：可以列出已安装应用，但无法判断/驱动更新（安装 Homebrew 后可一键升级 cask 应用）");
      log("warn", warnings[warnings.length - 1]);
      return { brewVersion, brews, outdated };
    }
    const verRes = await runBrew(brewPath, ["--version"], { timeoutMs: 60000 });
    brewVersion = firstLine(outputText(verRes)).replace(/^Homebrew\s+/i, "");
    log("info", `Homebrew ${brewVersion}（${brewPath}）· ${env.archLabel}`);

    /*
     * 注意：brew 退出码非 0 时 stdout 通常是空的（错误都在 stderr），旧实现直接把它
     * 当成「0 个已安装 cask」记日志，于是真正的故障（例如 brew 卡在 Portable Ruby
     * 升级、后台残留进程占用锁文件）被伪装成了「本机没有应用」。这里必须把失败讲出来。
     */
    const listRes = await runBrew(brewPath, ["list", "--cask", "--versions"], { signal, timeoutMs: 5 * 60 * 1000 });
    if (listRes.ok) {
      for (const [token, version] of parseBrewCaskVersions(listRes.stdout)) brews.set(token, version);
    } else if (signal && signal.aborted) {
      log("info", "已取消：跳过 Homebrew 已装列表");
    } else {
      warnings.push(
        `Homebrew 列表命令失败（${firstLine(outputText(listRes)) || `exit ${listRes.code}`}）：本次无法判断哪些应用由 Homebrew 管理、也无法判断是否有新版本。可先在终端执行 \`brew list --cask\` 检查 Homebrew 是否正常`
      );
      log("warn", warnings[warnings.length - 1]);
    }
    log("info", `Homebrew 报告 ${brews.size} 个已安装 cask`);

    const outRes = await runBrew(brewPath, ["outdated", "--json=v2", "--cask", "--greedy"], { signal, timeoutMs: 10 * 60 * 1000 });
    /*
     * 用户按「取消」时 runProcess 会 resolve 成 {ok:false, code:null} —— 那是主动取消，
     * 不是 Homebrew 坏了，必须区别对待，否则取消操作会被当成故障报出来。
     */
    if (!outRes.ok && signal && signal.aborted) {
      log("info", "已取消：跳过 Homebrew 更新检查");
    } else if (outRes.ok) {
      for (const [token, version] of parseBrewOutdated(outRes.stdout)) outdated.set(token, version);
    } else {
      /* 不用 `outRes.ok || outRes.stdout`：超时被杀时 stdout 可能只有半截内容，
         字符串真值会让「解析出 0 条」伪装成成功，于是漏报更新却不发警告。 */
      warnings.push(`Homebrew 更新检查失败（${firstLine(outputText(outRes)) || `exit ${outRes.code}`}）：本次可能漏报可更新应用`);
      log("warn", warnings[warnings.length - 1]);
    }
    log("info", `其中 ${outdated.size} 个有新版本`);
    return { brewVersion, brews, outdated };
  })();

  /* C. cask 目录：把 .app 反查到 cask token，才能知道官网最新版本。
     抓不到就降级（只显示 Homebrew 自己报告的信息），不中断扫描。 */
  const catalogPhase = (async () => {
    if (!brewPath) return null;
    const list = await fetchCaskCatalog({ log, warnings });
    return list ? parseCaskCatalog(list) : null;
  })();

  let apps, brewResult, catalog;
  try {
    [apps, brewResult, catalog] = await Promise.all([appsPromise, brewPhase, catalogPhase]);
  } finally {
    /* 取消检查放在 Promise.all 之后：三个阶段内部的取消语义各自保留
       （brew 子进程由 signal kill，枚举/竞速照旧跑完当次），与串行版行为一致。 */
  }
  throwIfAborted();
  const { brewVersion, brews, outdated } = brewResult;
  // 1.3.16：分阶段计时（并发后的墙上时钟，含等待），供效果对比与排障
  log("info", `阶段耗时：枚举+brew+目录（并发墙钟）${((Date.now() - phaseT0) / 1000).toFixed(1)}s · ${apps.length} 个 .app · ${brews.size} 个 cask`);

  /* ---------------------------------------------------------------- *
   * 3.5 非 Homebrew 应用：查应用自带的更新源（Sparkle appcast / Electron
   *     app-update.yml）。这一步是 1.3.9 新增的 —— 没有它，`brew list --cask`
   *     为空的机器上所有应用都停在「不可判断」，「可升级到」恒为 `—`。
   *
   *     只查「既不是系统组件、也不是 App Store、也不由 Homebrew 管理」的应用：
   *     前三类要么不由本插件负责，要么已经有更权威的版本来源。
   *     查询结果只用于展示，绝不把非 Homebrew 应用变成「可一键更新」。
   * ---------------------------------------------------------------- */
  let official = new Map();
  if (settings.checkOfficialSources !== false) {
    throwIfAborted();
    const appcastT0 = Date.now();
    const matcher = createCaskMatcher({ byApp: catalog ? catalog.byApp : new Map(), byToken: catalog ? catalog.byToken : new Map(), brews });
    const targets = [];
    for (const app of apps) {
      if (app.system) continue;
      if (app.appStore && settings.includeStoreApps === false) continue;
      const cask = matcher(app);
      if (cask && brews.has(cask.token)) continue; // 已由 Homebrew 管理
      targets.push({ key: app.path, path: app.path });
    }
    if (targets.length) {
      log("info", `正在查询 ${targets.length} 个非 Homebrew 应用的官网更新源…`);
      official = await checkAppUpdateSources(targets, { log, signal: signal || undefined });
      throwIfAborted();
      const newerCount = [...official.values()].length;
      if (newerCount) log("info", `${newerCount} 个应用带可读的官网更新源`);
      log("info", `阶段耗时：官网更新源 ${((Date.now() - appcastT0) / 1000).toFixed(1)}s`);
    }
  } else {
    log("info", "已关闭「查询官网更新源」：非 Homebrew 应用的状态将是「不可判断」");
  }

  /* ---------------------------------------------------------------- *
   * 4. 合并：已装应用 + Homebrew 管理状态 → 最终列表
   * ---------------------------------------------------------------- */
  const built = buildMacosItems({ apps, brews, outdated, catalog, official, settings });
  const items = built.items;
  for (const w of built.warnings) if (!warnings.includes(w)) warnings.push(w);

  const stats = {
    total: items.length,
    upgradable: items.filter((i) => i.hasUpdate).length,
    /* 「官网有新版但本插件升不了」单独计数：以前它被混进 unsupported，
       界面上只看到「0 个可更新」，实际上有十几个应用早就该升了。 */
    manual: items.filter((i) => !i.hasUpdate && i.latestNewer).length,
    unsupported: items.filter((i) => !i.updateSupported).length,
  };
  log(
    "success",
    `扫描完成：${stats.total} 个应用，${stats.upgradable} 个可一键更新` +
      (stats.manual ? `，${stats.manual} 个官网有新版需手动升级` : "")
  );

  /*
   * 这里只是**按设计**如实说明「App Store 应用不由本插件升级」，不是故障。
   * 它以前被 push 进 warnings，而新界面把 warnings 渲染成红色告警横幅 ——
   * 于是每次正常扫描都会永久挂一条红条，把真正的故障（brew 失败 / 目录抓不到）
   * 稀释成噪音。日常说明走 info 日志，warnings 只留「本次判断依据失效」。
   */
  if (settings.includeStoreApps) {
    log("info", "App Store 应用只列出、不由本插件更新（由 App Store 自己负责升级）");
  }

  return {
    env,
    engine: { id: ENGINE_BREW, available: Boolean(brewPath), version: brewVersion, path: brewPath || "" },
    scannedAt: Date.now(),
    startedAt,
    stats,
    items,
    warnings,
  };
}

/**
 * 按 cask token 读出磁盘上那个 `.app` 的真实版本。
 *
 * 为什么不直接用 `brew list --cask --versions`：那是 Homebrew **记录的**版本，
 * 不是磁盘上的事实。`brew install --cask --force` 的流程是
 * 「下载 → 移除旧 app → 搬入新 app」，如果中途被打断（超时、断网、用户取消），
 * brew 有可能已经把 cask 记成新版本，而 `/Applications` 里还是旧 app ——
 * 只看 brew list 就会把失败报成成功。这里用 cask 声明的 `.app` 名去磁盘上找，
 * 读 Info.plist 的 CFBundleShortVersionString 作为第二重证据。
 *
 * @returns {Promise<string>} 版本串；找不到返回 ""
 */
/**
 * 这个 cask 是否用 `.pkg` 安装器（即需要 sudo / 管理员密码）。
 *
 * 为什么重要：`brew install --cask <token>` 对 pkg 型 cask 会调用
 * `/usr/bin/sudo ... installer -pkg`，而后台进程**没有终端**，sudo 无法读密码，必然失败：
 *   sudo: a terminal is required to read the password
 * 实测本机 AweSun / UURemote 就是这种，报错还被过程行盖住，看起来像「装了一半」。
 * 与其让它跑到一半才失败，不如提前识别并明确告诉用户「这类得你自己在终端跑」。
 *
 * @returns {Promise<boolean|null>} true=需要 sudo，false=不需要，null=探测失败
 */
/** brew info --cask --json=v2 的进程内缓存：一次更新流程里同一个 cask 可能被问 3 次
    （是否需 sudo、下载源是否可达、装完后读磁盘版本），每次都重启 brew 是浪费。 */
const caskInfoCache = new Map();

/**
 * 读一个 cask 的元信息（带缓存）。
 * @returns {Promise<object|null>} cask 的 json 对象；失败为 null
 */
async function loadCaskInfo(token, brewPath, opts = {}) {
  const brew = brewPath || findBrew();
  if (!brew || !token) return null;
  if (caskInfoCache.has(token)) return caskInfoCache.get(token);
  const info = await runProcess(brew, ["info", "--cask", "--json=v2", token], {
    timeoutMs: 60000,
    signal: opts.signal,
  });
  if (!info.ok) {
    caskInfoCache.set(token, null);
    return null;
  }
  try {
    const json = JSON.parse(info.stdout);
    const cask = Array.isArray(json && json.casks) ? json.casks[0] : null;
    caskInfoCache.set(token, cask || null);
    return cask || null;
  } catch {
    caskInfoCache.set(token, null);
    return null;
  }
}

/** 清缓存：更新结束后要重新读，不能沿用「装之前」的版本信息。 */
export function clearCaskInfoCache() {
  caskInfoCache.clear();
}

export async function caskNeedsSudo(token, brewPath, opts = {}) {
  const cask = await loadCaskInfo(token, brewPath, opts);
  if (!cask) return null;
  for (const art of cask.artifacts || []) {
    if (!art || typeof art !== "object") continue;
    // artifacts 里出现 pkg / pkgutil 就说明要走 installer，需要 root
    if (art.pkg || art.pkgutil || art.installer) return true;
  }
  return false;
}

/**
 * 探测「这个 cask 的安装包能不能下得到」。
 *
 * 为什么需要：Homebrew 的 cask 把下载地址写死在 `url:` 字段里，经常直接指向
 * github.com（本机实测 balenaetcher：
 *   url: https://github.com/balena-io/etcher/releases/download/v2.1.9/…dmg
 *   而官网 etcher.balena.io 只是壳，它的下载按钮也是去问 GitHub API）。
 * 当 github.com 在本地网络不可达时，`brew install --cask --force` 会卡在
 * 「解析下载地址」这一步，最长要等 2 小时才超时，用户全程看不到任何进展。
 *
 * 这里在**动手之前**先 HEAD 一下下载地址的主机：不通就立刻返回原因，
 * 让用户知道「是网络到不了 GitHub，不是插件坏了」，而不是陪跑两小时。
 *
 * @returns {Promise<{ok:boolean, host:string, why:string}>}
 */
export async function probeCaskDownloadUrl(token, brewPath, opts = {}) {
  const cask = await loadCaskInfo(token, brewPath, opts);
  if (!cask) return { ok: true, host: "", why: "" }; // 读不到 cask 就不拦，交给 brew 自己报错
  // cask 的 url 可能是数组（多架构），取第一个 http(s) 的
  const rawUrls = Array.isArray(cask.url) ? cask.url : [cask.url];
  const url = rawUrls.filter((u) => typeof u === "string" && /^https?:\/\//i.test(u))[0] || "";
  if (!url) return { ok: true, host: "", why: "" };

  let host = "";
  try {
    host = new URL(url).host;
  } catch {
    return { ok: true, host: "", why: "" };
  }

  /* 只探「已知容易不可达」的主机，其它一律放过：
     github.com 在国内经常超时；objects.githubusercontent.com 通常可用
     （真正的大文件走它）。逐次探测成本低（并发 + 短超时），
     但没必要对所有 CDN 都打一遍 HEAD —— 那会给每次更新加无谓延迟。 */
  const NEEDS_PROBE = /^(github\.com|api\.github\.com|codeload\.github\.com)$/i;
  if (!NEEDS_PROBE.test(host)) return { ok: true, host, why: "" };

  /* 关键教训：**HEAD 不足以判断**。本机实测 github.com 首页 HEAD 返回 200/302 只用 1 秒，
     但同一个 URL 跟随重定向真正下载时，30 秒收到 0 字节 —— Releases 的大文件走的是
     `objects.githubusercontent.com`，那条链路可能完全不通。
     所以这里必须「真实跟随重定向下载一小段」：`-r 0-1048576` 取首 1MB，
     能量出速度就说明链路可用；0 字节/超时才算不可达。 */
  const timeoutS = opts.timeoutS || 10;
  const res = await runProcess(
    "/usr/bin/curl",
    [
      "-sSL",
      "--max-time", String(timeoutS),
      "-r", "0-1048576",           // 只要首 1MB，不下载整个安装包
      "-o", "/dev/null",
      "-w", "%{http_code} %{size_download} %{speed_download}",
      url,
    ],
    { timeoutMs: (timeoutS + 10) * 1000, signal: opts.signal }
  );
  const parts = String(res.stdout || "").trim().split(/\s+/);
  const code = parts[0] || "";
  const bytes = Number(parts[1] || 0);
  const speed = Number(parts[2] || 0);
  // 拿到至少 64KB 且速度 > 10KB/s，才算这条链路真的能用
  if (res.ok && /^[23]/.test(code) && bytes >= 65536 && speed >= 10240) {
    return { ok: true, host, why: "" };
  }

  /* 区分两种失败，因为用户的下一步不同：
     - 服务器已经响应（2xx/206）但只拿到很少字节 → 纯粹太慢，配代理/换网络能解决；
     - 完全没有响应（000/超时）→ 链路不通。 */
  const responded = /^[23]/.test(code);
  const why = responded
    ? `安装包托管在 ${host}，链路能通但**速度极慢**（${timeoutS} 秒只下到 ${Math.round(bytes / 1024)} KB，` +
      `${Math.round(speed / 1024)} KB/s）。按当前速度下载完需要很久，` +
      `建议给 ${host} 配代理，或改从官网手动下载。`
    : `安装包托管在 ${host}，当前网络**完全访问不到**（${res.timedOut ? "超时" : code || "连接失败"}）。` +
      `这不是插件故障；给 ${host} 配代理后再试，或改从官网手动下载。`;
  return { ok: false, host, why };
}

export async function readBundleVersionByToken(token, brewPath, opts = {}) {
  const brew = brewPath || findBrew();
  if (!brew || !token) return "";
  // 先问 cask 自己声明了哪个 .app（--json=v2 的 artifacts 里），再按名字在标准目录里找。
  const cask = await loadCaskInfo(token, brewPath, opts);
  if (!cask) return "";
  const appNames = [];
  for (const art of (cask && cask.artifacts) || []) {
    if (!art || typeof art !== "object") continue;
    for (const raw of Array.isArray(art.app) ? art.app : []) {
      const base = String(raw).split("/").pop();
      if (base && /\.app$/i.test(base)) appNames.push(base);
    }
  }
  for (const name of appNames) {
    for (const dir of applicationDirs()) {
      const appPath = join(dir, name);
      if (!existsSync(appPath)) continue;
      const res = await runProcess(
        "/usr/bin/plutil",
        ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", join(appPath, "Contents", "Info.plist")],
        { timeoutMs: 15000, signal: opts.signal }
      );
      const v = res.ok ? res.stdout.trim() : "";
      if (looksLikeVersion(v)) return v;
    }
  }
  return "";
}

async function runMacosUpdates({ ids, settings, log, onProgress, signal, env, plan = [] }) {
  const brewPath = findBrew();
  const results = [];
  const queue = [...new Set((ids || []).filter(Boolean))];

  /* 「非 Homebrew 管理但 cask 目录里有它」的应用：id → cask token。
     这类应用的 id 形如 macapp:<bundleId>，不能直接交给 brew；但用
     `brew install --cask --force <token>` 可以接管现有 .app 并升到 cask 版本。
     数据来源是引擎扫描时写进 item 的 adoptToken（macos.js 产出），
     这里从 plan 里取 —— plan 是界面那份已扫好的列表，正好带着它。 */
  const forceInstall = new Map();
  for (const it of Array.isArray(plan) ? plan : []) {
    if (!it || !it.id) continue;
    if (String(it.id).startsWith("brew:")) continue;
    /* 判据只能是 adoptToken —— 它由 macos.js 的 canAdopt 决定（cask 存在且版本更新）。
       绝不能再加上 latestNewer：那个字段表示「应用自带更新源查到的版本」，
       而 cask 能接管的应用根本不会去查 appcast（managed=false 但 cask 命中时
       走的是 cask 目录这条线），于是 latestNewer 恒为 false。
       实测后果：界面显示「13 个可更新」，点「全部更新」却 13 个全报
       「cask 目录里没有它」—— 勾得动、必然失败，比不显示更糟。 */
    if (it.adoptToken) forceInstall.set(String(it.id), String(it.adoptToken));
  }

  /* 安装前的版本表：复核时要靠它判断「磁盘到底升上去了没有」。
     必须在这里**自己**建一份 —— planById 是 runUpdates 里 Windows 分支的局部变量，
     在 runMacosUpdates 作用域里不可见（直接引用会在复核那一刻抛
     "planById is not defined"，把已成功的更新写成失败）。 */
  const planById = new Map(
    (Array.isArray(plan) ? plan : [])
      .map((item) => [String((item && item.id) || "").toLowerCase(), item])
      .filter(([key]) => key)
  );

  onProgress({ running: true, total: queue.length, done: 0, current: null, results: [], error: null, startedAt: Date.now() });
  log("info", `开始更新 ${queue.length} 个应用（${describeEnvironment(env)}，引擎：Homebrew）`);

  if (!brewPath) {
    for (const id of queue) {
      results.push({ id, ok: false, error: "未找到 Homebrew，无法更新；请先安装 Homebrew" });
      log("error", `${id} 更新失败：未找到 Homebrew`);
    }
    onProgress({ running: false, total: queue.length, done: results.length, current: null, results, finishedAt: Date.now(), error: null });
    return results;
  }

  /* ---------------------------------------------------------------- *
   * 1.3.16：macOS 也走「先并发预下载、再串行安装」——与 Windows 侧
   * 1.3.15 的 DOWNLOAD_CONCURRENCY 同构。原来 3 个应用串行 brew upgrade，
   * 每个 = 下载 + 安装，总时长 = Σ(下载+安装)；实测 320s 里 99% 是下载
   * （google-chrome 169s / tencent-meeting 65s / wechat 86s）。
   * 预下载用 `brew fetch --cask`（落 brew 自己的下载缓存，按内容哈希命名），
   * 之后串行的 brew upgrade/install 命中缓存、只剩安装与复核。
   * 预检（probe/sudo）同时并发化：原来逐个串行，github 托管的每个白等 10s。
   * ---------------------------------------------------------------- */

  /* 循环内逐项判断出的 token 先在这里统一解析（rawId → token），
     预检/预下载都按 token 进行；无 token 的项保留原「跳过并如实报错」语义。 */
  const tokenOf = new Map(); // rawId → token（"" 表示无对应 cask）
  for (const rawId of queue) {
    const isBrew = String(rawId).startsWith("brew:");
    const adopt = isBrew ? "" : forceInstall.get(String(rawId)) || "";
    tokenOf.set(rawId, isBrew ? String(rawId).replace(/^brew:/, "") : adopt);
  }
  const fetchable = [...new Set([...tokenOf.values()].filter(Boolean))];

  /* 预检并发（probe + sudo）：失败项记进 skipProbe / skipSudo，
     循环体遇到时按原有语义提前跳过并给出相同文案。caskInfoCache 在并发
     loadCaskInfo 下天然合并（同一个 token 只发一次 brew info）。
     演练模式与旧实现一致：不做 probe/sudo 预检 —— 下载本身就是演练的目的，
     pkg 型 cask 也能 fetch（只有安装才需要 sudo）。 */
  const skipProbe = new Map(); // token → why（不可达/极慢）
  const skipSudo = new Set(); // token（pkg 型，需要终端 sudo）
  if (!settings.dryRun && fetchable.length && !signal.aborted) {
    const preT0 = Date.now();
    let cursor = 0;
    const preCheckWorker = async () => {
      while (cursor < fetchable.length) {
        if (signal.aborted) return;
        const token = fetchable[cursor];
        cursor += 1;
        try {
          const probe = await probeCaskDownloadUrl(token, brewPath, { signal });
          if (!probe.ok) {
            skipProbe.set(token, probe.why);
            return;
          }
          const needsSudo = await caskNeedsSudo(token, brewPath, { signal });
          if (needsSudo) skipSudo.add(token);
        } catch {
          /* 预检自身异常不预判失败：交给串行安装循环按原语义处理 */
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, fetchable.length) }, preCheckWorker));
    log(
      "info",
      `预检完成（并发）：${fetchable.length} 个 token，${skipSudo.size} 个需 sudo 跳过、${skipProbe.size} 个下载源不可用（${((Date.now() - preT0) / 1000).toFixed(1)}s）`
    );
  }

  /* 并发预下载（brew fetch）：只对「预检通过且非 sudo」的 token 做。
     dryRun 模式同样复用这一阶段 —— 它的语义本来就是「只下载不安装」。 */
  const fetched = new Set(); // 预下载成功的 token
  const fetchFailed = new Map(); // token → 失败原因（循环里如实透出）
  const downloadables = fetchable.filter((t) => !skipProbe.has(t) && !skipSudo.has(t));
  if (downloadables.length && !signal.aborted) {
    const dlT0 = Date.now();
    let cursor = 0;
    let dlDone = 0;
    const fetchWorker = async () => {
      while (cursor < downloadables.length) {
        if (signal.aborted) return;
        const token = downloadables[cursor];
        cursor += 1;
        try {
          log("info", `预下载安装包：${token}`);
          /* 过程行同样接进日志（去重）：预下载阶段是更新里最长的一段，
             可见性与安装阶段同等重要。 */
          const seenLines = new Set();
          const emitFetchLine = (text) => {
            for (const rawLine of String(text).split(/[\r\n]+/)) {
              const line = rawLine.trim();
              if (!line) continue;
              if (!/^(==>|->|🍺|✔|Warning:|Error:|Error$|Fetching|Downloading|Installing|Moving|Removing|Backing up|Cask|Succeeded|Failed)/.test(line)) continue;
              if (seenLines.has(line)) continue;
              seenLines.add(line);
              try { log("info", `${token}：${line}`); } catch { /* 回调异常不影响主流程 */ }
            }
          };
          const res = await runBrew(brewPath, ["fetch", "--cask", token], { signal, timeoutMs: 60 * 60 * 1000, onData: emitFetchLine });
          if (signal.aborted || res.timedOut) {
            if (!signal.aborted) fetchFailed.set(token, "brew fetch 超时");
          } else if (res.ok) {
            fetched.add(token);
          } else {
            fetchFailed.set(token, brewErrorLine(res) || `brew fetch 退出码 ${res.code}`);
          }
        } catch (e) {
          fetchFailed.set(token, String((e && e.message) || e));
        }
        dlDone += 1;
      }
    };
    log("info", `并发预下载 ${downloadables.length} 个安装包（并发度 ${Math.min(DOWNLOAD_CONCURRENCY, downloadables.length)}）`);
    await Promise.all(Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, downloadables.length) }, fetchWorker));
    log(
      "info",
      `预下载阶段结束：成功 ${fetched.size}/${dlDone}${settings.dryRun ? "（演练模式：到此为止，不进入安装阶段）" : ""}（${((Date.now() - dlT0) / 1000).toFixed(1)}s）`
    );
  }

  let index = 0;
  for (const rawId of queue) {
    if (signal.aborted) {
      results.push({ id: rawId, ok: false, error: "已取消" });
      log("warn", `已取消：${rawId}`);
      break;
    }
    /* 「不由 Homebrew 管理」不等于「无法更新」：只要 cask 目录里有同名 cask，
       就能用 `brew install --cask --force <token>` 覆盖安装 —— 它会移除现有 .app
       并装上 cask 版本（实测 IINA 1.4.4 → 1.5.0 成功，之后自动变成 Homebrew 管理）。
       注意**不能**用 --adopt：Homebrew 的 adopt 只在「已有 app 与要装版本完全一致」
       时才通过，版本不同会直接报 "is different from the one being installed"，
       所以升级场景必须用 --force。 */
    const isBrew = String(rawId).startsWith("brew:");
    const adoptToken = isBrew ? "" : forceInstall.get(String(rawId)) || "";
    if (!isBrew && !adoptToken) {
      // 连 cask 都没有：这时才真的没法动它，如实报错而不是静默跳过
      index += 1;
      results.push({
        id: rawId,
        ok: false,
        error: "该应用不由 Homebrew 管理（拖 DMG / 手动安装），且 cask 目录里没有它；本插件无法更新，请在应用内或官网升级",
      });
      log("warn", `${rawId} 跳过：非 Homebrew 管理且无对应 cask`);
      onProgress({ running: true, total: queue.length, done: index, current: null, results });
      continue;
    }
    index += 1;
    const token = isBrew ? String(rawId).replace(/^brew:/, "") : adoptToken;
    // 走 --force 接管的应用：它原本不由 brew 管理，upgrade 会报「未安装」，必须 install。
    const needsForceInstall = !isBrew;
    onProgress({ running: true, total: queue.length, done: index - 1, current: token });
    log("info", `（${index}/${queue.length}）开始处理 ${token}`);

    const startedAt = Date.now();
    const entry = { id: rawId, ok: false, error: null, installer: null, note: null, verified: null, durationMs: 0 };
    try {
      if (settings.dryRun) {
        // 演练模式：预下载阶段已把包拉进 brew 缓存（或失败），这里只如实汇总。
        // 与旧实现一致：不做 probe/sudo 预检（下载本身就是演练目的，pkg 型也能 fetch）。
        if (fetched.has(token)) {
          entry.ok = true;
          entry.dryRun = true;
          entry.note = "演练模式：已下载该应用对应的安装包，未安装";
        } else {
          entry.error = fetchFailed.get(token) || "预下载未完成（可能已取消）";
        }
      } else {
        /* 预检结果（1.3.16 起在循环外并发完成）：
           - 下载源不可达/极慢 → 提前跳过并给出原因（与原串行 probe 语义一致）
           - pkg 型 cask → 需要终端 sudo，提前跳过并给出终端命令 */
        const why = skipProbe.get(token);
        if (why) {
          entry.error = why;
          log("warn", `${token} 跳过：${why}`);
          entry.durationMs = Date.now() - startedAt;
          results.push(entry);
          onProgress({ running: true, total: queue.length, done: index, current: null, results });
          continue;
        }
        if (skipSudo.has(token)) {
          entry.error =
            `该应用使用 .pkg 安装器，需要管理员密码；后台进程没有终端，无法自动完成。` +
            `请在终端执行：brew install --cask --force ${token}`;
          log("warn", `${token} 跳过：pkg 安装器需要 sudo（请在终端手动执行）`);
          entry.durationMs = Date.now() - startedAt;
          results.push(entry);
          onProgress({ running: true, total: queue.length, done: index, current: null, results });
          continue;
        }
        /* 预下载失败 → 记 warn 后照常走 brew upgrade：brew 会续传 .incomplete
           或重新下载（与 1.3.15「upgrade 自己下载」完全同语义，只是多了一次
           已失败的 fetch 尝试），最终结果由 upgrade 决定，不在这里判死。 */
        const dlErr = fetchFailed.get(token);
        if (dlErr) {
          log("warn", `${token} 预下载失败（${dlErr}），安装阶段将重试完整下载`);
        }
        const brewArgs = needsForceInstall
          ? ["install", "--cask", "--force", token]
          : ["upgrade", "--cask", token];
        // 修坑：--force 是破坏性接管（会移除现有 .app 再搬入新 app），执行前留一条 info 让用户/日志有痕。
        if (needsForceInstall) {
          log("info", `${token}：即将执行 brew install --cask --force —— 这是破坏性接管，会移除现有 .app 再安装 cask 版本`);
        }
        log("info", `brew ${brewArgs.join(" ")}`);
        // 2h 超时保留：下载慢的 cask 本来就可能需要这么久
        // 1.3.16：把 brew 的过程行接进运行日志 —— 实测 google-chrome 一步 169 秒，
        // 界面全程「0/3 0%」没有中间可见性。这里只放行有信息量的过程行
        // （==> Downloading / Installing / Moving …），并做去重：curl 的 ## 进度条
        // 用 \r 刷新、每秒十几条同前缀行，直接透传会刷爆 400 条日志上限。
        const seenLines = new Set();
        const emitBrewLine = (text) => {
          for (const rawLine of String(text).split(/[\r\n]+/)) {
            const line = rawLine.trim();
            if (!line) continue;
            // 只放行 brew 的过程/状态行；Ruby 报错栈与乱码片段留在 stdout 里给 brewErrorLine 用
            if (!/^(==>|->|🍺|✔|Warning:|Error:|Error$|Fetching|Downloading|Installing|Moving|Removing|Backing up|Cask|Succeeded|Failed)/.test(line)) continue;
            if (seenLines.has(line)) continue;
            seenLines.add(line);
            try { log("info", `${token}：${line}`); } catch { /* 回调异常不影响主流程 */ }
          }
        };
        const upRes = await runBrew(brewPath, brewArgs, { signal, timeoutMs: 2 * 60 * 60 * 1000, onData: emitBrewLine });
        // 取消/超时优先判错：被 kill 的 brew 退出码不是 0，落进 else 会给出误导性原因；
        // 更要防的是「半跑被杀却退出码 0」被当成功
        if (signal.aborted) entry.error = "已取消";
        else if (upRes.timedOut) entry.error = "brew upgrade 超时（可能被杀）";
        else if (upRes.ok) entry.ok = true;
        /* 失败原因必须从 stderr 里挑真正的错误行，不能拿 stdout 首行（那是过程输出） */
        else entry.error = brewErrorLine(upRes) || `brew ${needsForceInstall ? "install" : "upgrade"} 退出码 ${upRes.code}`;
      }

      // 修坑：演练模式没有真正安装，与 Windows 侧一致跳过版本复核（原来 dryRun 也置 ok=true 会误进复核，
      // 甚至落进下面的「更新失败」分支）；单独给一条 warn，不改动 ok 语义。
      if (entry.ok && entry.dryRun) {
        log("warn", `${token}：演练模式，已下载安装包，跳过安装与版本复核`);
      } else if (entry.ok) {
        const listRes = await runBrew(brewPath, ["list", "--cask", "--versions", token], { signal, timeoutMs: 60000 });
        const now = parseBrewCaskVersions(listRes.stdout).get(token) || "";
        /* 关键复核：`brew list` 读的是 **Homebrew 记录的版本**，不是磁盘上 .app 的
           实际版本。`--force` 安装若在「移除旧 app 之后、搬入新 app 之前」被打断，
           brew 仍可能把 cask 记为已装新版本 —— 此时只看 brew list 会把失败报成成功
           （1.3.0 立下的「退出码 0 不算成功，必须复核」准则，在 macOS 侧这里还差一层）。
           所以再读一次磁盘上的 CFBundleShortVersionString，两者都对上才算数。 */
        const onDisk = await readBundleVersionByToken(token, brewPath, { signal });
        /* cask 的 version 字段常是「版本,构建号,哈希」这种多段写法
           （本机 QQ 就是 7.0.0_260812_01,9.9.33,126b7ce6），而磁盘上的
           CFBundleShortVersionString 只有 7.0.0。直接按字符串比会恒不相等，
           把成功报成失败 —— 先取逗号前的主版本段再比。 */
        /* 主版本段还可能带构建号：本机 QQ 的 cask 版本是
           `7.0.0_260812_01,9.9.33,126b7ce6`，磁盘上只有 `7.0.0`。
           先取逗号前那段，再砍掉下划线/加号之后的部分，才能和磁盘版本对上。 */
        /* 修坑：归一规则统一由 macos.js 的 mainVersionOf 提供（1.3.12 修「9 个成功升级被报
           失败」的关键判据不能各写一份）。其实现等价于 split(",")[0].split(/[_+]/)[0].trim()：
           取逗号前主版本段，再砍掉下划线/加号之后的构建号。只换实现来源，不改判据。 */
        const brewMain = mainVersionOf(now);
        const diskMain = mainVersionOf(onDisk);
        /* 「更新成功」的语义是：磁盘上跑的是新版本。cask 的 version 字段与磁盘的
           CFBundleShortVersionString 是**两套编号体系**——cask 的 4.2.0.16 里第 4 段
           往往就是磁盘 CFBundleVersion 的构建号（微信实测：cask 4.2.0.16,270352 对应
           磁盘 short=4.2.0 / bundle=270352），腾讯会议 3.47.2.407 → 磁盘 3.47.2 同理。
           所以不能按「逐段相等」判 —— 那会把 9 个真实升级报成失败（本次实测踩中）。
           正确判据是**磁盘版本 >= 已装版本**（升级只可能往前走；磁盘还是旧版 = 没装上）。 */
        const before = String((planById.get(String(rawId)) || {}).version || "");
        const okByDisk =
          !onDisk || // 读不到磁盘版本时退回 brew 记录（记 warn，不判死）
          looksLikeVersion(before) === false ||
          isNewer(diskMain, mainVersionOf(before)) || // 磁盘已升到更新版本
          compareVersions(diskMain, mainVersionOf(before)) === 0; // 或与安装前相同（本来就已最新）
        if (okByDisk && now && onDisk) {
          entry.verified = onDisk;
          log("success", `${token} 更新完成，磁盘版本 ${onDisk}（brew 记录 ${now}）`);
        } else if (!okByDisk) {
          // 磁盘还是旧版：--force 真的没装上（常见于下载/网络失败），不能报成功
          entry.ok = false;
          entry.error = `更新后磁盘仍是旧版本：装前 ${before}，装后 ${onDisk}（Homebrew 记录 ${now}）`;
          log("error", `${token} 复核失败：${entry.error}`);
        } else if (now) {
          entry.verified = now;
          entry.note = "未复核磁盘版本：读不到 .app 的 Info.plist";
          log("warn", `${token} 已升级到 ${now}，但读不到磁盘上的 .app 版本，未能二次复核`);
        } else {
          entry.note = "未复核：brew list 读不到更新后的版本";
          log("warn", `${token} 已执行升级，但无法复核版本（brew list 失败或读空）`);
        }
      } else {
        log("error", `${token} 更新失败：${entry.error}`);
      }
    } catch (err) {
      entry.ok = false;
      entry.error = String((err && err.message) || err);
      log("error", `${token} 更新异常：${entry.error}`);
    }

    entry.durationMs = Date.now() - startedAt;
    results.push(entry);
    onProgress({ running: true, total: queue.length, done: index, current: null, results });
  }

  clearCaskInfoCache(); // 装完后的版本信息不能沿用装前缓存
  const okCount = results.filter((r) => r.ok).length;
  onProgress({ running: false, total: queue.length, done: results.length, current: null, results, finishedAt: Date.now(), error: null });
  log(okCount === results.length ? "success" : "warn", `更新结束：成功 ${okCount} / ${results.length}`);
  return results;
}
