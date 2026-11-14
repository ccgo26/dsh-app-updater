/**
 * 持久化状态：设置、上次扫描结果、日志。
 * 位置：$DSH_HOME/dsh-app-updater/  （默认 ~/.dsh/dsh-app-updater）
 *
 * 只写插件自己的目录，绝不碰 profile 或宿主配置。
 */

import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { homedir, platform as nodePlatform } from "node:os";
import { join } from "node:path";

import { platformFamily } from "./platform.js";
import { mergeSourceFailures } from "./source-failures.js";

const MAX_LOG = 400;

/**
 * 只在某一个平台有意义的设置。
 *
 * 为什么需要这张表：界面本来就按平台裁剪了开关（client 的 TOGGLES.only），但
 * `/settings` 接口不看平台 —— macOS 上照样能把 autoElevate / hashFallbackUpgrade
 * 这些 Windows 概念写进 state.json，然后在 macOS 上永久存着一批用不到的键。
 * 更糟的是它们会被序列化回前端，让「设置」看起来像跨平台通用开关。
 *
 * 现在：不在本平台生效的键**一律不落盘**（静默丢弃，不算错误 —— 前端本来就不该发）。
 * includeStoreApps 两个平台都有（只是文案不同），所以不在此表里。
 */
const PLATFORM_ONLY_SETTINGS = {
  autoElevate: "windows",
  hashFallbackUpgrade: "windows",
  includeRegistryOnly: "windows",
  includeUnmanagedApps: "macos",
  checkOfficialSources: "macos",
};

/** 某个设置键在本平台是否生效（未知键一律视为通用）。 */
export function settingAppliesTo(key, family) {
  const only = PLATFORM_ONLY_SETTINGS[key];
  if (!only) return true;
  return only === family;
}

export function dshHome() {
  const explicit = process.env.DSH_HOME;
  if (explicit && explicit.trim()) return explicit.trim();
  return join(homedir(), ".dsh");
}

export function dataDir() {
  return join(dshHome(), "dsh-app-updater");
}

export function defaultSettings() {
  return {
    includeStoreApps: true,
    includeRegistryOnly: true,
    // macOS：把非 Homebrew 管理（拖 DMG / 手动装）的应用也列出来（只列出，不更新）
    includeUnmanagedApps: true,
    // macOS：查非 Homebrew 应用**自带的**更新源（Sparkle appcast / Electron
    // app-update.yml），只读地判断「官网有没有新版」。关闭后这些应用一律「不可判断」。
    checkOfficialSources: true,
    downloadDir: "",
    keepInstallers: true,
    useWingetDownload: true,
    hashFallbackUpgrade: true,
    dryRun: false,
    // 按本机架构（Windows ARM64 / x64、Apple Silicon / Intel）挑选安装包
    matchSystemArch: true,
    // 需要管理员的安装包（MSI / 写入 Program Files）改用管理员上下文执行
    autoElevate: true,
    // 先试软件自带的更新服务（Edge 等），没生效再退回官网全量安装包。
    // 必须在这里声明：engine.js 读的是 `settings.useSelfUpdater !== false`，
    // 而 updateSettings 只接受 defaultSettings() 里有的键 —— 漏了它，用户/文档
    // 都无法把这个逃生开关关掉，只能改代码。
    useSelfUpdater: true,
  };
}

export function defaultState() {
  return {
    version: 2,
    settings: defaultSettings(),
    scan: { startedAt: 0, finishedAt: 0, error: null, running: false, warnings: [] },
    update: { startedAt: 0, finishedAt: 0, running: false, total: 0, done: 0, current: null, results: [], error: null },
    apps: { scannedAt: 0, stats: { total: 0, upgradable: 0, unsupported: 0 }, items: [], engine: "" },
    /* 1.4.1：按 winget id 记下「官网下载源 403」的失败，供下次扫描把该行降级为「需手动」。
       不硬编码包名，更新成功后自动清除。 */
    sourceFailures: {},
    env: null,
    engine: null,
    log: [],
  };
}

async function readJson(file) {
  let raw;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    // 文件不存在 / 不可读：按「没有历史状态」处理，不算损坏
    return { value: null, corrupt: false };
  }
  try {
    return { value: JSON.parse(raw), corrupt: false };
  } catch {
    // 原来把「解析失败」和「文件不存在」都吞成 null：用户不知道配置坏了，
    // 而且损坏文件会被下一次 save() 无条件覆盖。这里显式区分。
    return { value: null, corrupt: true };
  }
}

/** 原子写：先写 .tmp 再 rename。 */
export async function writeJsonAtomic(file, value) {
  await mkdir(join(file, ".."), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tmp, file);
}

export class Store {
  constructor() {
    this.state = defaultState();
    this.loaded = false;
    this.saving = null;
    this.dirty = false;
    /* CSRF token：进程内生成、随 /state.json 下发，但**不写进 state.json**。
       写接口必须原样带回，兼容模式下无凭据的跨站/脚本请求拿不到它。 */
    this.csrfToken = randomBytes(24).toString("hex");
    /* 最近一次写盘失败原因：save() 不再完全静默，供 /state.json 与 /health.json 下发。 */
    this.lastSaveError = null;
  }

  get statePath() {
    return join(dataDir(), "state.json");
  }

  async load() {
    if (this.loaded) return this.state;
    const { value: stored, corrupt } = await readJson(this.statePath);
    if (corrupt) {
      // 损坏的 state.json 先备份再回退默认值，绝不静默覆盖丢失原始数据
      try {
        await rename(this.statePath, `${this.statePath}.corrupt-${Date.now()}`);
      } catch {
        /* 备份失败也要继续，不能让插件起不来 */
      }
      this.state.log.push({
        at: Date.now(),
        level: "error",
        text: "state.json 不是合法 JSON，已回退默认设置；损坏文件已备份为 state.json.corrupt-*",
      });
    }
    if (stored && typeof stored === "object") {
      const base = defaultState();
      this.state = {
        ...base,
        ...stored,
        settings: { ...base.settings, ...(stored.settings || {}) },
        scan: { ...base.scan, ...(stored.scan || {}), running: false },
        update: { ...base.update, ...(stored.update || {}), running: false, current: null },
        apps: stored.apps && typeof stored.apps === "object" ? stored.apps : base.apps,
        sourceFailures: stored.sourceFailures && typeof stored.sourceFailures === "object" && !Array.isArray(stored.sourceFailures)
          ? stored.sourceFailures
          : base.sourceFailures,
        log: Array.isArray(stored.log) ? stored.log.slice(-MAX_LOG) : [],
      };
      /* 合并后再裁掉「不属于本平台」的键：defaultSettings() 是全集，直接合并会把
         Windows 概念带回 macOS 的 state 里。裁掉后 engine 侧仍按默认值兜底
         （例如 settings.autoElevate !== false 在 macOS 上本来就从不参与判断）。 */
      const family = this.platformFamily();
      for (const key of Object.keys(this.state.settings)) {
        if (!settingAppliesTo(key, family)) delete this.state.settings[key];
      }
    }
    this.loaded = true;
    return this.state;
  }

  async save() {
    this.dirty = true;
    if (this.saving) return this.saving;
    this.saving = (async () => {
      while (this.dirty) {
        this.dirty = false;
        try {
          await writeJsonAtomic(this.statePath, this.state);
          this.lastSaveError = null;
        } catch (err) {
          /* 不再完全静默：记录失败原因，让 UI / health 可观测。
             不重试死循环：置 dirty=false 并退出，内存态继续可用，
             下一次显式 save() 会再试一次。 */
          this.dirty = false;
          this.lastSaveError = String((err && err.message) || err);
          break;
        }
      }
    })().finally(() => {
      this.saving = null;
    });
    return this.saving;
  }

  log(level, text) {
    const entry = { at: Date.now(), level, text: String(text == null ? "" : text) };
    this.state.log.push(entry);
    if (this.state.log.length > MAX_LOG) this.state.log = this.state.log.slice(-MAX_LOG);
    this.save();
    return entry;
  }

  /**
   * 1.4.1：把一次更新结果里的「官网下载源 403」合并进记录表。
   * 成功项会清掉旧记录（发布方修好后自动恢复可一键更新）。
   * @param {Array<{id?:string, ok?:boolean, error?:string}>} results
   */
  mergeSourceFailureResults(results) {
    const before = this.state.sourceFailures || {};
    const next = mergeSourceFailures(before, results);
    this.state.sourceFailures = next;
    const added = Object.keys(next).filter((k) => !before[k]);
    const removed = Object.keys(before).filter((k) => !next[k]);
    if (added.length || removed.length) this.save();
    return { added, removed };
  }

  updateSettings(patch) {
    const next = { ...this.state.settings };
    const family = this.platformFamily();
    const defaults = defaultSettings();
    for (const [k, v] of Object.entries(patch || {})) {
      if (!(k in defaults)) continue;
      // 不属于本平台的开关不落盘：既避免存下一堆用不到的键，也避免前端以为它生效了
      if (!settingAppliesTo(k, family)) continue;
      if (typeof defaults[k] === "boolean") next[k] = Boolean(v);
      else next[k] = String(v == null ? "" : v);
    }
    this.state.settings = next;
    this.save();
    return next;
  }

  /**
   * 本机平台族（windows / macos / other）。
   *
   * **必须用真实平台，不能用 state.json 里存的上次扫描环境**：那个 env 可能来自
   * 另一台机器（同步 ~/.dsh、漫游配置、恢复备份、换机沿用旧 state）。一旦拿它当
   * 「本机平台」，在 Windows 上读到一个陈旧的 `family: "macos"` 就会把
   * includeRegistryOnly 之类**本平台该保留的键当成外来键删掉** —— 而
   * engine.js 对它是真值判断，undefined 等于 false，默认却是 true，
   * 于是注册表兜底被静默跳过、registry 条目全被过滤，界面少显示应用且没有任何警告。
   *
   * 结论：平台归属只认 process.platform，env 只在真实平台无法判断（other）时兜底。
   */
  platformFamily() {
    let real = "other";
    try {
      real = platformFamily(nodePlatform());
    } catch {
      real = "other";
    }
    if (real !== "other") return real;
    const env = this.state && this.state.env;
    if (env && env.family) return env.family;
    return "other";
  }

  /**
   * 清掉「上个平台遗留」的平台专属设置。
   *
   * 场景：同一份 $DSH_HOME 在 Windows 与 macOS 之间同步（或用户换了机器沿用旧配置），
   * 于是 macOS 的 state.json 里躺着 autoElevate / hashFallbackUpgrade 这类 Windows 键。
   * 它们在 macOS 上既不生效也不该被展示，留着只会误导。这里只删、不写默认值，
   * 让 defaultSettings() 继续提供兜底值。
   */
  pruneForeignSettings() {
    const family = this.platformFamily();
    let changed = false;
    const next = { ...this.state.settings };
    for (const key of Object.keys(next)) {
      if (settingAppliesTo(key, family)) continue;
      delete next[key];
      changed = true;
    }
    if (changed) {
      this.state.settings = next;
      this.save();
    }
    return changed;
  }
}
