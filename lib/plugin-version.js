/**
 * 插件自身版本信息与更新检查（1.4.0）。
 *
 * 与 lib/appcast.js 区分：appcast 查的是「本机安装的应用有没有新版」；
 * 本模块查的是「dsh-app-updater 这个插件自己有没有新版」。
 *
 * 数据来源（用户确认）：
 *   - 当前版本：package.json 的 version 字段（单一来源，避免多处写死）
 *   - 更新时间：CHANGELOG.md 顶部形如 `## [1.4.0] — 2026-11-13` 的日期
 *   - 最新版本：npm registry 的 https://registry.npmjs.org/dsh-app-updater/latest
 *
 * 这里只放纯函数与只读探测，不碰界面、不落盘、不执行安装。
 */

import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join, delimiter } from "node:path";

import { isNewer, looksLikeVersion } from "./version.js";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

export const REGISTRY_LATEST_URL = "https://registry.npmjs.org/dsh-app-updater/latest";
export const PACKAGE_NAME = "dsh-app-updater";
export const SELF_UPDATE_PROFILE = "web";

/** 当前版本：只认 package.json，读不到返回空串（界面会显示「未知」）。 */
export function currentVersion() {
  try {
    return String(require("../package.json").version || "").trim();
  } catch {
    return "";
  }
}

/**
 * 从 CHANGELOG.md 顶部读出「最新版本的发布日期」。
 *
 * 形状：`## [1.4.0] — 2026-11-13`（em dash 或普通连字符均可）。
 * 只取第一个匹配；没有就返回空串，界面据实显示「未知」，绝不编造。
 * @param {string} [text] 省略时读仓库内 CHANGELOG.md
 * @returns {string} YYYY-MM-DD
 */
export function latestUpdateDate(text) {
  let src = text;
  if (src === undefined) {
    try {
      src = readFileSync(join(here, "..", "CHANGELOG.md"), "utf8");
    } catch {
      return "";
    }
  }
  const m = /^##\s*\[[^\]]+\]\s*[—–-]\s*(\d{4}-\d{2}-\d{2})/m.exec(String(src || ""));
  return m ? m[1] : "";
}

/** 供 /state.json 下发的版本信息块。 */
export function pluginVersionInfo() {
  return {
    version: currentVersion(),
    updatedAt: latestUpdateDate(),
    packageName: PACKAGE_NAME,
  };
}

/**
 * 解析 registry `/latest` 的响应，取出版本号。
 * 兼容传入对象或 JSON 字符串；形状不对一律返回空串。
 * @returns {string}
 */
export function parseRegistryLatest(payload) {
  let obj = payload;
  if (typeof payload === "string") {
    try {
      obj = JSON.parse(payload);
    } catch {
      return "";
    }
  }
  if (!obj || typeof obj !== "object") return "";
  const v = String(obj.version || "").trim();
  return looksLikeVersion(v) ? v : "";
}

/**
 * 版本比对结果（唯一裁决点）。
 *  - 远端版本查不到 / 形状不对 → 视为「检查失败」，由调用方给错误反馈，不当成「无新版本」
 *  - 本地版本读不到 → 无法比较，也按失败处理（避免谎报「已是最新」）
 *  - 只有 isNewer(latest, current) 为真才出现「立即更新」
 * @returns {{ok:boolean, currentVersion:string, latestVersion:string, hasUpdate:boolean, error:string}}
 */
export function evaluateUpdate(localVersion, latestVersion) {
  const cur = String(localVersion || "").trim();
  const latest = String(latestVersion || "").trim();
  if (!looksLikeVersion(cur)) {
    return { ok: false, currentVersion: cur, latestVersion: latest, hasUpdate: false, error: "无法读取当前插件版本" };
  }
  if (!looksLikeVersion(latest)) {
    return { ok: false, currentVersion: cur, latestVersion: latest, hasUpdate: false, error: "无法获取最新版本信息" };
  }
  return {
    ok: true,
    currentVersion: cur,
    latestVersion: latest,
    hasUpdate: isNewer(latest, cur),
    error: "",
  };
}

/** 只接受形如 1.4.0 / 1.4.0-beta.2 的版本串，挡掉命令注入的可能。 */
export function isSafeVersionArg(v) {
  return /^\d+(?:\.\d+)*(?:-[0-9A-Za-z.+-]+)?$/.test(String(v || "").trim());
}

/**
 * 构造自更新命令：dsh plugin --profile web add dsh-app-updater@<version>
 * 返回 { exe, args, command }；参数数组不经过 shell，version 先过白名单。
 * @returns {{exe:string, args:string[], command:string}|null}
 */
export function buildSelfUpdateCommand(version, exe) {
  const v = String(version || "").trim();
  const dshExe = String(exe || "").trim();
  if (!isSafeVersionArg(v) || !dshExe) return null;
  const args = ["plugin", "--profile", SELF_UPDATE_PROFILE, "add", `${PACKAGE_NAME}@${v}`];
  return { exe: dshExe, args, command: `${dshExe} ${args.join(" ")}` };
}

/**
 * 在 PATH 里找 dsh CLI；找不到返回空串（界面会给出可复制命令的兜底提示）。
 * 只读目录项，不派生子进程；扫描顺序按 PATH 原序，再补两个 Homebrew 常见位置。
 * @param {{env?:NodeJS.ProcessEnv, exists?:(p:string)=>boolean}} [opts]
 */
export function findDshCli(opts) {
  const env = (opts && opts.env) || process.env;
  const exists = (opts && opts.exists) || existsSync;
  const paths = String(env.PATH || "").split(delimiter).filter(Boolean);
  paths.push("/opt/homebrew/bin", "/usr/local/bin");
  for (const dir of paths) {
    const candidate = join(dir, process.platform === "win32" ? "dsh.cmd" : "dsh");
    try {
      if (exists(candidate)) return candidate;
    } catch { /* 单个目录不可读不影响其它目录 */ }
  }
  return "";
}
