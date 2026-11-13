/**
 * macOS 应用清单：把「本机装了哪些应用」真正列出来。
 *
 * 为什么需要这个模块：1.3.x 的 macOS 扫描只读了 `brew list --cask`，也就是
 * **只有通过 Homebrew 装过的应用才会出现在列表里**。一台正常使用的 Mac 上，
 * 绝大多数应用是拖 DMG 装的，于是 `brew list --cask` 返回空 → 界面显示
 * 「未检测到任何已安装应用」。这不是「没有应用」，而是**没有枚举应用**。
 *
 * 现在的做法：
 *  1. 枚举标准应用目录里的 `.app`（/Applications、/System/Applications 及其
 *     Utilities 子目录、~/Applications），从每个 bundle 的 Info.plist 读版本；
 *  2. 用 Homebrew 的 cask 目录（formulae.brew.sh，缓存一天）把 `.app` 反向匹配到
 *     cask token，从而知道**官网最新版本**；
 *  3. 只有「确实由 Homebrew 管理」的应用才标记为可一键更新 —— 其余应用如实列出，
 *     但标注为不可由本插件更新，绝不假装能更新。
 *
 * 这里只做「读」，不改动任何东西；所有命令都是绝对路径 + 参数数组，不经 shell。
 */

import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import { runProcess } from "./proc.js";
import { dataDir } from "./state.js";
import { isNewer, looksLikeVersion } from "./version.js";

/** macOS 放应用的标准目录（约定：这些目录第一层就是 `.app`）。 */
export function applicationDirs(home = homedir()) {
  // 这些是 macOS 的 POSIX 路径，用字符串拼接而不是 path.join：
  // join 在 Windows 上会产出反斜杠，跨平台跑单测时就对不上了。
  const h = String(home || "").replace(/\/+$/, "");
  return [
    "/Applications",
    "/Applications/Utilities",
    "/System/Applications",
    "/System/Applications/Utilities",
    `${h}/Applications`,
  ];
}

/**
 * 1.3.18：判断一个「Homebrew 记账里有、但标准目录里没找到 .app」的 cask 是不是
 * **孤儿安装**（brew 记录还在，磁盘上的应用已被删/移走）。
 *
 * 背景：`brew upgrade --cask <token>` 在卸载旧版阶段要备份 cask 声明的 .app
 * （Homebrew `cask/artifact/moved.rb` 的 `move_back`），文件不存在就抛
 * `CaskError: It seems the App source '...' is not there.`。本机实测 thunder 就是
 * 这种状态：`brew list --cask` 报 5.80.8.66675，但 `/Applications/Thunder.app`
 * 不在、Caskroom 版本目录是空的。旧版 `buildMacosItems` 的兜底分支把这类 cask
 * 也列成「可一键更新」，于是「勾得动、点下去必然失败」。
 *
 * 判定口径（**只认声明了 .app 的 cask**，字体 / 命令行 cask 不在此列）：
 *  - 有显式 `target` 绝对路径 → 以这些路径为准，全部不存在即孤儿；
 *  - 只有 `appNames` → 在 `applicationDirs()` 里按文件名找，全找不到即孤儿；
 *  - 两者都没有 → 不是孤儿（字体 / 命令行 / 纯 pkg cask，保持原行为）。
 *
 * 纯函数，不碰文件系统（`existsSync` 由调用方注入），方便跨平台单测。
 *
 * @param {object} entry parseCaskCatalog 里的条目（byToken.get(token)）
 * @param {(p:string)=>boolean} [exists] 文件存在判定，默认 existsSync
 * @returns {{orphan:boolean, missingPaths:string[]}}
 */
export function caskAppMissing(entry, exists = existsSync) {
  if (!entry || typeof entry !== "object") return { orphan: false, missingPaths: [] };
  const targets = Array.isArray(entry.appTargets) ? entry.appTargets.filter((p) => /\.app$/i.test(String(p))) : [];
  const names = Array.isArray(entry.appNames) ? entry.appNames.filter((n) => /\.app$/i.test(String(n))) : [];
  let candidates = [];
  if (targets.length) {
    candidates = targets.map(String);
  } else if (names.length) {
    // 用字符串拼接保持 POSIX 路径，跨平台单测不会因 path.join 出反斜杠而失真
    for (const dir of applicationDirs()) {
      for (const name of names) candidates.push(`${String(dir).replace(/\/+$/, "")}/${String(name)}`);
    }
  } else {
    return { orphan: false, missingPaths: [] }; // 没声明 .app：不是孤儿（字体/命令行 cask）
  }
  const missingPaths = candidates.filter((p) => !exists(p));
  // 所有候选路径都不存在才算孤儿；有一个在就说明 app 还在（可能装在别的目录）
  return { orphan: missingPaths.length === candidates.length, missingPaths };
}

/**
 * 可选的「扩展应用目录」候选集：默认扫描**不**包含它们（避免改变扫描结果与性能），
 * 仅供未来 `scanAppBundles({ dirs })` 显式传入以覆盖装在别处的应用。
 * 存在性由调用方判断（listAppBundles 会自动跳过读不到的目录）。
 */
export function extraApplicationDirs(home = homedir()) {
  // 与 applicationDirs 一致：用 / 拼接而不是 path.join，跨平台跑单测才对得上
  const h = String(home || "").replace(/\/+$/, "");
  return [
    "/Users/Shared/Applications",
    `${h}/.local/share/Applications`,
    `${h}/opt/Applications`,
  ];
}

/** cask 目录的缓存文件（放插件自己的数据目录，不碰宿主配置）。 */
export function catalogCachePath(dir) {
  return join(dir || dataDir(), "cask-catalog.json");
}

const CATALOG_URL = "https://formulae.brew.sh/api/cask.json";

/**
 * cask 目录的下载地址，参与并发竞速。
 *
 * 为什么不止一个：`formulae.brew.sh` 在国内网络下常常只有 20~30 KB/s（实测 19 MB 的
 * cask.json 跑 120 秒只下到 0.5 MB），而旧实现只给它一次 120 秒的机会 —— 于是每次扫描
 * 都白等两分钟、最后拿不到目录，所有应用都算不出「可更新」。镜像站同样内容几秒就能下完，
 * 所以官方地址仍然排第一，谁先下完用谁。
 *
 * 为什么**不**放阿里云：`mirrors.aliyun.com/homebrew/homebrew-bottles/api/cask.json` 是一份
 * 冻结在 2025-05-22 的旧快照（13.7 MB，其余三源 19.3 MB；用 `isNewer` 全量比对有 2908 个
 * cask 版本落后官方、1257 个缺失）。它结构同构、不会报错，只会让「已是最新」的结论悄悄变错 ——
 * 而阿里云是国内最快的源，竞速里几乎总是它先返回，等于稳定拿到最旧的数据。
 * 宁可少一个源，也不要一个又快又错的源。
 */
const CATALOG_URLS = [
  CATALOG_URL,
  "https://mirrors.tuna.tsinghua.edu.cn/homebrew-bottles/api/cask.json",
  "https://mirrors.ustc.edu.cn/homebrew-bottles/api/cask.json",
];

/** 单个地址的超时：一个慢线路不该把整次扫描卡住好几分钟。 */
const CATALOG_FETCH_TIMEOUT_S = 60;
const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;
/** 抓不到新目录时，已经过期的缓存最多还能用这么久（旧数据也比没有强）。 */
const CATALOG_STALE_MAX_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * 从 cask 目录 JSON 建索引：
 *  - byApp：`.app` 文件名（小写）→ 条目**数组**，用来「从已装应用反查 cask」；
 *  - byToken：cask token → 条目，用来「从已装 cask 正查最新版本」。
 *
 * 一个 .app 可能被多个 cask 声明（例如 `iterm2` 与 `iterm2@nightly` 都装
 * `iTerm.app`），只留最后一个会让匹配随目录顺序漂移 —— 所以这里保留全部候选，
 * 由 pickCask 按「已装 > 非 nightly/非弃用 > token 精确匹配」挑选。
 *
 * @param {any} list formulae.brew.sh/api/cask.json 的内容
 */
export function parseCaskCatalog(list) {
  const byApp = new Map();
  const byToken = new Map();
  const addCandidate = (appName, entry) => {
    const key = String(appName).toLowerCase();
    const bucket = byApp.get(key);
    if (bucket) bucket.push(entry);
    else byApp.set(key, [entry]);
  };
  for (const c of Array.isArray(list) ? list : []) {
    if (!c || typeof c !== "object" || !c.token) continue;
    const appNames = [];
    /* 1.3.18：同时记下 cask 声明的 .app 目标路径，供「孤儿 cask」判定用。
       Homebrew 的 cask artifact 有两种写法：
         { app: ["Thunder.app"] }                          → 默认落到 /Applications
         { app: ["Thunder.app"], target: "/Applications/Thunder.app" } → 显式绝对路径
       target 可能是字符串或数组；只收 .app 结尾的绝对路径，其余交给 appNames 兜底。 */
    const appTargets = [];
    for (const art of Array.isArray(c.artifacts) ? c.artifacts : []) {
      if (!art || typeof art !== "object") continue;
      for (const raw of Array.isArray(art.app) ? art.app : []) {
        // 形如 "$APPDIR/Foo.app" 或 "Foo.app"，只取最后一段
        const base = String(raw).split("/").pop();
        if (base && /\.app$/i.test(base)) appNames.push(base);
      }
      const rawTargets = Array.isArray(art.target) ? art.target : [art.target];
      for (const t of rawTargets) {
        const target = String(t == null ? "" : t).trim();
        if (target.startsWith("/") && /\.app$/i.test(target)) appTargets.push(target);
      }
    }
    /* cask 用 .pkg 安装器 → 装它要走 sudo，后台进程没终端装不了。
       在扫描阶段就把这个事实记下来，界面能提前提示，用户不必点了才失败。 */
    let needsSudo = false;
    for (const art of Array.isArray(c.artifacts) ? c.artifacts : []) {
      if (!art || typeof art !== "object") continue;
      if (art.pkg || art.pkgutil || art.installer) {
        needsSudo = true;
        break;
      }
    }
    const entry = {
      token: String(c.token),
      version: String(c.version == null ? "" : c.version).trim(),
      name: Array.isArray(c.name) && c.name.length ? String(c.name[0]) : String(c.token),
      appNames,
      appTargets,
      deprecated: Boolean(c.deprecated),
      disabled: Boolean(c.disabled),
      autoUpdates: Boolean(c.auto_updates),
      needsSudo,
    };
    byToken.set(entry.token, entry);
    for (const appName of appNames) addCandidate(appName, entry);
  }
  return { byApp, byToken };
}

/** token 里的变体后缀（iterm2@nightly → iterm2），用于排序时优先主 cask。 */
function baseToken(token) {
  return String(token || "").split("@")[0];
}

/**
 * 版本串归一：取逗号前的主段，再砍掉 `_` / `+` 之后的构建号/后缀。
 *
 * 与 engine.js 复核侧（更新成功后比对「brew 记录版本 vs 磁盘版本」）的本地
 * `mainVersion` 语义**完全一致**：`String(v||"").split(",")[0].split(/[_+]/)[0].trim()`。
 * 提升为公共导出，让扫描侧（splitCaskVersion）与复核侧共用同一口径，
 * 避免两处各自实现、日后漂移（§6 坑 41）。engine.js 会改为 import 复用本函数。
 */
export function mainVersionOf(raw) {
  return String(raw || "").split(",")[0].split(/[_+]/)[0].trim();
}

/**
 * cask 版本串 → 磁盘版本：Homebrew 的 cask `version` 是「主版本 + 构建号」的拼接，
 * 而磁盘上分成了 CFBundleShortVersionString（主版本）与 CFBundleVersion（构建号）。
 *
 * 本机实测（这组数据是判定「有没有新版」的关键）：
 *
 * | cask version            | 磁盘 short | 磁盘 bundle |
 * |-------------------------|-----------|------------|
 * | 2.189.0.55910           | 2.189.0   | 55910      |
 * | 3.47.2.407,8f7920…      | 3.47.2    | 407        |
 * | 5.80.8.66675            | 5.80.8    | 66675      |
 * | 4.2.0.16,270352         | 4.2.0     | 270352     |
 * | 5.0.13.95049            | 5.0.13    | 95049      |
 *
 * 拿 `2.189.0.55910` 直接和 `2.189.0` 比，第 4 段会被当成「更高的版本」，
 * 于是**已经是最新**的 8 个应用全被误报成「有新版本」——这正是用户看到的
 * 「8 个可更新，但点下去装完还是老样子」。正确做法：把 cask 的末段当构建号，
 * 与磁盘的 CFBundleVersion 对上才算同一版；对不上才是真的新版本。
 *
 * @returns {{short:string, build:string}} 从 cask 串拆出的主版本与构建号
 */
export function splitCaskVersion(raw) {
  // 只取「逗号前主段」（与 engine 复核侧的 mainVersionOf 同源的那一部分），
  // **不**沿用 mainVersionOf 的「砍 _/+ 后缀」：cask 版本里的下划线构建段
  // （QQ 7.0.0_260812_01）还要参与下面的「末段构建号」识别，砍掉会让 build 变空、
  // short 被改写，从而破坏 1.3.13 修「8 个已是最新被误报有更新」的判据。
  // 扫描侧（拆 short+build）与复核侧（只取可比较主段）本就是不同用途，各自独立实现。
  const first = String(raw || "").split(",")[0].trim();
  if (!first) return { short: "", build: "" };

  /* 用正则从**末尾**识别构建号，而不是按分隔符切割 —— 真实的 cask 写法有四种：
       2.189.0.55910                 构建号在最后一个点段
       3.47.2.407                    同上（407 只有 3 位也算）
       5.9.3.42398134-d4692421       构建号后接 -哈希
       4.2.0.16,270352               构建号 16 很小，靠逗号后的 270352 才认得出
     共同点：构建号总是**紧跟在完整语义版本之后**。所以先剥掉可能的 -,hash 尾巴，
     再从末尾尝试「主版本保留 2~4 段 + 末尾段当构建号」的各种切法。 */

  // 去掉 -哈希 尾巴（WorkBuddy 系）；保留前面的数字构建号
  const noHash = first.replace(/-[a-z0-9]+$/i, "");
  const nums = noHash.split(/[.]/).filter((x) => /^\d+$/.test(x));
  if (!nums.length) return { short: first, build: "" };
  if (nums.length <= 2) return { short: noHash, build: "" };

  const last = Number(nums[nums.length - 1]);
  const restArr = nums.slice(0, -1);
  const restMax = Math.max(...restArr.map(Number));
  const hasTrailingHash = /,[0-9]+$/.test(String(raw || "").trim());

  // 末段是构建号的条件：数值明显大于前面（407/55910/95049），
  // 或 4 位以上（42398134），或逗号后跟了纯数字（微信 4.2.0.16,270352 的 16）
  const lastStr = nums[nums.length - 1];
  const isBuild =
    (last > restMax && (last >= 100 || lastStr.length >= 4)) ||
    lastStr.length >= 4 ||
    hasTrailingHash;

  if (!isBuild) return { short: noHash, build: "" };
  return { short: restArr.join("."), build: lastStr };
}

/**
 * 磁盘上的这个应用，是否已经等于（或新于）cask 记录的那一版？
 *
 * 综合 short 与 bundle 两个字段判断，避免把构建号当成新版本（见 splitCaskVersion）。
 *
 * @param {{short:string,build:string}} target cask 拆出来的目标版本
 * @param {{version:string,bundleVersion:string}} installed 磁盘上的实际版本
 * @returns {boolean} true = 已是这一版（无需更新）
 */
export function isSameOrNewerThan({ target, installed }) {
  const short = String((installed && installed.version) || "").trim();
  const build = String((installed && installed.bundleVersion) || "").trim();
  if (!target || !target.short) return false;
  if (!looksLikeVersion(short)) return false;

  // 1) 主版本短版本必须对得上（cask 的 short 就是主版本）
  if (isNewer(target.short, short)) return false; // 磁盘主版本更旧 → 需要更新
  if (isNewer(short, target.short)) return true; // 磁盘主版本更新 → 无需更新

  // 2) 主版本相同：再看构建号能否对上
  if (target.build && build) {
    const bNumeric = /^\d+$/.test(build);
    const tNumeric = /^\d+$/.test(target.build);
    if (bNumeric && tNumeric) {
      // 两边都是纯数字：按数值比较（55910 vs 55910、407 vs 407）
      return Number(build) >= Number(target.build);
    }
    /* 磁盘的 CFBundleVersion 不是数字时（WorkBuddy 写作 5.9.3，与 short 相同），
       不能用它去对 cask 的 42398134。这种情况说明这个 app 的 bundle 号并不承载
       构建信息 —— 主版本已经相同，就认为是最新（宁可少报一次更新，
       也不要反复提示「有新版本」却怎么也升不上去）。 */
    return true;
  }
  // 3) cask 没给构建号，或磁盘读不到构建号：主版本相同即可认为是最新
  return true;
}

/**
 * 从 cask 目录索引建一个「.app → cask」匹配器。
 *
 * 独立成函数是因为现在有**两个**调用方：`buildMacosItems`（组装列表）与
 * `scanMacos`（先判断某应用是否由 Homebrew 管理，从而决定要不要去查它的官网
 * Sparkle 更新源）。两边必须用同一套匹配规则，否则会出现「扫描时认为是非 Homebrew
 * 应用、于是去查了官网，组装时又匹配成 Homebrew 管理」的自相矛盾。
 */
export function createCaskMatcher({ byApp = new Map(), byToken = new Map(), brews = new Map() } = {}) {
  const brewByName = new Map();
  for (const token of brews.keys()) brewByName.set(normalizeAppKey(token), token);

  return (app) => {
    const direct = byApp.get(String(app.bundleName || "").toLowerCase());
    if (direct && direct.length) {
      return pickCask(direct, { appName: app.name, bundleName: app.bundleName, brews });
    }
    const key = normalizeAppKey(app.name || app.bundleName);
    /* 中文应用名（爱奇艺、企业微信、哔哩哔哩…）归一化后是**空串**：normalizeAppKey
       只保留 [a-z0-9]。旧实现拿空串继续往下比，`normalizeAppKey(entry.token) === ""`
       对第一个纯符号声明的 cask 恒成立，于是「爱奇艺」被错配成 `alipay-key-tool`
       （支付宝开放平台密钥工具），publisher 与 --adopt 命令一起变成错的。
       空串不是有效 key，直接放弃逐 token 比对。 */
    if (!key) return null;
    for (const entry of byToken.values()) {
      if (normalizeAppKey(entry.token) === key) return entry;
      for (const appName of entry.appNames) {
        if (normalizeAppKey(appName) === key) return entry;
      }
    }
    const token = brewByName.get(key);
    if (token) return { token, version: "", name: token, appNames: [] };
    return null;
  };
}

/**
 * 在多个候选 cask 里挑出最可能是「这个 .app 对应的那个 cask」。
 *
 * 优先级（越靠前越优先）：
 *  1. 已安装（token 出现在 brews 里）—— 已装的就是用户实际在用的那个；
 *  2. 非 deprecated / disabled；
 *  3. 主 token（不带 @nightly 这类变体后缀）；
 *  4. token 与应用名/应用文件名归一化后相等。
 */
export function pickCask(candidates, { appName, bundleName, brews = new Map() } = {}) {
  if (!Array.isArray(candidates) || !candidates.length) return null;
  const keys = new Set([normalizeAppKey(appName), normalizeAppKey(bundleName)].filter(Boolean));
  const score = (entry) => {
    let s = 0;
    if (brews.has(entry.token)) s += 100;
    if (!entry.deprecated && !entry.disabled) s += 10;
    if (entry.token === baseToken(entry.token)) s += 5;
    if (keys.has(normalizeAppKey(entry.token))) s += 3;
    for (const n of entry.appNames) if (keys.has(normalizeAppKey(n))) s += 1;
    return s;
  };
  let best = candidates[0];
  let bestScore = score(best);
  for (const candidate of candidates.slice(1)) {
    const s = score(candidate);
    if (s > bestScore) {
      best = candidate;
      bestScore = s;
    }
  }
  return best;
}

/** 名字归一化：去掉 .app、空格与标点，只留字母数字，用于 token ↔ 应用名兜底匹配。 */
export function normalizeAppKey(name) {
  return String(name || "")
    .replace(/\.app$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

/**
 * 在标准应用目录里找 `.app`（不进入 bundle 内部，避免把框架当应用）。
 * @returns {Promise<string[]>} 绝对路径，已去重
 */
export async function listAppBundles(dirs, depth = 1) {
  const found = [];
  const seen = new Set();
  const walk = async (dir, level) => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // 目录不存在 / 无权限：跳过，不影响其它目录
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (/\.app$/i.test(entry.name)) {
        if (!seen.has(full)) {
          seen.add(full);
          found.push(full);
        }
        continue;
      }
      if (level > 0 && (entry.isDirectory() || entry.isSymbolicLink())) {
        await walk(full, level - 1);
      }
    }
  };
  for (const dir of dirs) await walk(dir, depth);
  return found;
}

/** 用 plutil 读 Info.plist（macOS 自带，binary plist 也能转 JSON）。 */
async function readInfoPlist(appPath) {
  const plist = join(appPath, "Contents", "Info.plist");
  const res = await runProcess("/usr/bin/plutil", ["-convert", "json", "-o", "-", plist], { timeoutMs: 15000 });
  if (!res.ok) return null;
  try {
    return JSON.parse(res.stdout);
  } catch {
    return null;
  }
}

/**
 * 读一个 `.app` 的元信息。
 * @returns {Promise<{path:string,bundleName:string,name:string,version:string,bundleId:string,appStore:boolean,system:boolean}>}
 */
export async function readAppBundle(appPath) {
  // macOS 上路径一定用 /，但单测在 Windows 上跑，两种分隔符都要能取到最后一段
  const bundleName = String(appPath).split(/[\\/]/).filter(Boolean).pop() || String(appPath);
  const info = {
    path: appPath,
    bundleName,
    name: bundleName.replace(/\.app$/i, ""),
    version: "",
    bundleId: "",
    appStore: existsSync(join(appPath, "Contents", "_MASReceipt", "receipt")),
    system: appPath.startsWith("/System/"),
  };
  const plist = await readInfoPlist(appPath);
  if (plist) {
    const short = plist.CFBundleShortVersionString;
    const bundle = plist.CFBundleVersion;
    info.version = String(short || bundle || "").trim();
    /* 构建号也要留着：Homebrew 的 cask version 是「主版本.构建号」的拼接写法
       （微信 cask=4.2.0.16,270352，磁盘 short=4.2.0 / bundle=270352）。
       判断「有没有新版」时，必须能拿 bundle 去对上 cask 串里那段构建号，
       否则 4.2.0 永远比不上 4.2.0.16，会把「已经是最新」错报成「有新版本」。 */
    info.bundleVersion = String(bundle == null ? "" : bundle).trim();
    info.bundleId = String(plist.CFBundleIdentifier || "").trim();
    const display = plist.CFBundleDisplayName || plist.CFBundleName;
    if (display) info.name = String(display).trim();
  }
  if (!info.version) {
    // plutil 失败时的兜底：defaults 直接读单个键
    const res = await runProcess(
      "/usr/bin/defaults",
      ["read", join(appPath, "Contents", "Info"), "CFBundleShortVersionString"],
      { timeoutMs: 15000 }
    );
    if (res.ok) info.version = res.stdout.trim();
  }
  return info;
}

/** 枚举并读取全部已安装应用（并发有限，避免一次开几百个进程）。 */
export async function scanAppBundles({ dirs, log, concurrency = 8 } = {}) {
  const paths = await listAppBundles(dirs || applicationDirs());
  const out = [];
  let index = 0;
  const worker = async () => {
    while (index < paths.length) {
      const current = paths[index];
      index += 1;
      try {
        out.push(await readAppBundle(current));
      } catch {
        /* 单个 bundle 读不出来不影响其它应用 */
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, paths.length || 1) }, worker));
  if (log) log("info", `在应用目录里找到 ${out.length} 个 .app`);
  return out;
}

/**
 * 读缓存的 cask 目录。
 * @param {string} file 缓存文件
 * @param {number} [now] 当前时间
 * @param {{ allowStale?: boolean }} [opts] allowStale：TTL 过了也接受（用于网络抓取失败时兜底）
 * @returns {Promise<Array|null>} 目录条目；不可用时为 null（返回形状保持不变）
 */
export async function readCatalogCache(file, now = Date.now(), opts = {}) {
  try {
    const raw = JSON.parse(await readFile(file, "utf8"));
    /* 兼容旧缓存：早期只写 {fetchedAt, list}，没有 source/count。
       这里只认 fetchedAt + list，缺的元数据交给 readCatalogCacheMeta 兜底，
       不让老缓存因为少了字段就整体失效。 */
    if (!raw || typeof raw.fetchedAt !== "number") return null;
    const age = now - raw.fetchedAt;
    if (age > (opts.allowStale ? CATALOG_STALE_MAX_MS : CATALOG_TTL_MS)) return null;
    return Array.isArray(raw.list) && raw.list.length ? raw.list : null;
  } catch {
    return null;
  }
}

/**
 * 只读缓存的「来源 / 新鲜度」元数据，不返回目录本身，也不改 readCatalogCache。
 * 供界面或告警判断「这条『已是最新』的结论依据的是哪个源、多旧的数据」。
 * 兼容旧格式：缺 source → "unknown"，缺 count → list.length。
 * @returns {Promise<{source:string, fetchedAt:number, count:number, ageMs:number, stale:boolean}|null>}
 */
export async function readCatalogCacheMeta(file, now = Date.now()) {
  try {
    const raw = JSON.parse(await readFile(file, "utf8"));
    if (!raw || typeof raw.fetchedAt !== "number" || !Array.isArray(raw.list)) return null;
    const ageMs = now - raw.fetchedAt;
    return {
      source: typeof raw.source === "string" && raw.source ? raw.source : "unknown",
      fetchedAt: raw.fetchedAt,
      count: Number.isFinite(raw.count) ? raw.count : raw.list.length,
      ageMs,
      // stale：超过 TTL 但在 30 天兜底窗口内仍会被 readCatalogCache(allowStale) 采用
      stale: ageMs > CATALOG_TTL_MS,
    };
  } catch {
    return null;
  }
}

/**
 * 抓取 cask 目录并写缓存。
 *
 * 顺序：新鲜缓存 → 官方地址 → 镜像 → 过期缓存兜底 → null（调用方降级，不中断扫描）。
 * 每个地址单独限时，绝不因为一条慢线路让整次扫描等上十几分钟。
 */
export async function fetchCaskCatalog({ file, log, warnings, fetchImpl } = {}) {
  const cacheFile = file || catalogCachePath();
  const cached = await readCatalogCache(cacheFile);
  if (cached) return cached;

  /**
   * 并发竞速取目录：官方地址与镜像同时开跑，谁先下完用谁，其余立刻取消。
   *
   * 为什么不用「依次重试」：官方线路实测 25 KB/s，串行等待等于每次扫描先干等
   * 60 秒才知道该换镜像；并发竞速时镜像通常一两秒就返回，用户几乎不感知。
   * 官方地址仍然参与竞速（网络正常时用官方数据，最权威）。
   */
  const run = fetchImpl || (async () => {
    const controllers = [];
    const failures = [];

    const attempt = (url) => new Promise((resolve, reject) => {
      const host = url.replace(/^https?:\/\//, "").split("/")[0];
      const controller = new AbortController();
      controllers.push(controller);
      runProcess(
        "/usr/bin/curl",
        ["-fsSL", "--max-time", String(CATALOG_FETCH_TIMEOUT_S), url],
        { timeoutMs: (CATALOG_FETCH_TIMEOUT_S + 15) * 1000, signal: controller.signal }
      ).then((res) => {
        if (!res.ok) {
          const why = String(res.stderr || "").trim().split("\n")[0] || `curl 退出码 ${res.code}`;
          throw new Error(`${host}: ${why}`);
        }
        const list = JSON.parse(res.stdout);
        if (!Array.isArray(list) || !list.length) throw new Error(`${host}: 内容不是 cask 目录数组`);
        // 胜者带出命中的 host，缓存据此记录「数据来自哪个源」
        resolve({ list, source: host });
      }).catch((err) => reject(new Error(String((err && err.message) || err))));
    });

    try {
      // 全部并发起跑；Promise.any 拿到第一个成功的结果（含来源）。
      const win = await Promise.any(
        CATALOG_URLS.map((url) => attempt(url).catch((err) => {
          failures.push(String((err && err.message) || err));
          throw err;
        }))
      );
      return win;
    } catch {
      throw new Error(failures.join("；") || "所有 cask 目录地址都失败");
    } finally {
      // 无论成败，取消还在跑的下载，避免白白占用带宽。
      for (const controller of controllers) {
        try { controller.abort(); } catch { /* 已结束 */ }
      }
    }
  });

  try {
    const result = await run();
    // 兼容 fetchImpl 注入：旧实现直接返回 list 数组；新竞速返回 {list, source}。
    const isWrapped = result && !Array.isArray(result) && Array.isArray(result.list);
    const list = isWrapped ? result.list : result;
    const source = isWrapped && result.source ? String(result.source) : "unknown";
    if (!Array.isArray(list) || !list.length) throw new Error("cask 目录格式不符合预期");
    try {
      await mkdir(dataDir(), { recursive: true });
      // 缓存带上来源与条数，便于日后判断「这份『已是最新』依据哪个源、是否过旧」
      await writeFile(cacheFile, JSON.stringify({ fetchedAt: Date.now(), source, count: list.length, list }), "utf8");
    } catch {
      /* 缓存写不进去不影响本次扫描 */
    }
    if (log) log("info", `已读取 Homebrew cask 目录（${list.length} 个 cask，来自 ${source}）`);
    return list;
  } catch (err) {
    const message = String((err && err.message) || err);
    // 所有地址都失败时，用过期缓存兜底：版本判断宁可略旧，也好过整屏「无法判断」。
    const stale = await readCatalogCache(cacheFile, Date.now(), { allowStale: true });
    if (stale) {
      // 明确写出「数据来自哪个源、已缓存几天」，避免用户把越来越旧的目录当成最新结论
      const meta = await readCatalogCacheMeta(cacheFile, Date.now());
      const from = (meta && meta.source) || "unknown";
      const days = meta ? Math.max(0, Math.floor(meta.ageMs / (24 * 60 * 60 * 1000))) : 0;
      const text = `读取 Homebrew cask 目录失败，改用本地过期缓存：数据来自 ${from}，已缓存 ${days} 天，版本判断可能滞后（抓取失败：${message}）`;
      if (warnings) warnings.push(text);
      if (log) log("warn", text);
      return stale;
    }
    // 连过期缓存都没有：把「上次来源」也带上，方便定位是哪条线路长期不可用
    const meta = await readCatalogCacheMeta(cacheFile, Date.now());
    const lastFrom = meta && meta.source ? `，上次来源 ${meta.source}` : "";
    if (warnings) warnings.push(`读取 Homebrew cask 目录失败（不影响列出应用，但无法判断是否有新版本${lastFrom}）：${message}`);
    if (log) log("warn", `读取 Homebrew cask 目录失败${lastFrom}：${message}`);
    return null;
  }
}

/**
 * 组装 macOS 应用列表（纯函数，便于单测）。
 *
 * @param {object} input
 * @param {Array} input.apps        已安装的 .app（scanAppBundles 的结果）
 * @param {Map<string,string>} input.brews   已装 cask：token → 已装版本
 * @param {Map<string,string>} input.outdated 可升级 cask：token → 可用版本
 * @param {{byApp:Map,byToken:Map}|null} input.catalog cask 目录索引
 * @param {Map<string,{version:string,via:string}>} [input.official]
 *        「应用自带更新源」查到的官网最新版本：key 是 `.app` 的绝对路径
 *        （见 appcast.js 的 checkAppUpdateSources）。只影响展示，不产生可执行更新。
 * @param {object} input.settings
 * @returns {{items:Array, warnings:string[]}}
 */
export function buildMacosItems({
  apps = [],
  brews = new Map(),
  outdated = new Map(),
  catalog = null,
  official = new Map(),
  settings = {},
}) {
  const warnings = [];
  const items = [];
  const byApp = catalog ? catalog.byApp : new Map();
  const byToken = catalog ? catalog.byToken : new Map();
  /** 已被某个 .app 认领的 cask token，避免重复列出 */
  const claimed = new Set();
  /** 已用过的 item id：一个 cask 可能声明多个 .app，必须保证 id 唯一 */
  const usedIds = new Set();

  // 没有 cask 目录时也能把「已装 cask」和 .app 对上：用 token 名归一化匹配，
  // 否则同一个应用会既作为 .app 出现、又作为 brew 条目再出现一次。
  const matchCask = createCaskMatcher({ byApp, byToken, brews });

  for (const app of apps) {
    // 注意：只有**显式**设为 false 才过滤。settings 缺字段时按默认「包含」处理，
    // 否则单测/老状态文件里缺字段会把应用整批吞掉。
    if (settings.includeStoreApps === false && app.appStore) continue;
    const cask = matchCask(app);
    const managed = Boolean(cask && brews.has(cask.token));
    // 非 Homebrew 管理的应用：默认列出（includeUnmanagedApps），关掉后只看 Homebrew 应用
    if (!managed && settings.includeUnmanagedApps === false) continue;
    if (cask && managed) claimed.add(cask.token);

    const latest = cask && looksLikeVersion(cask.version) ? cask.version : "";
    const forced = managed && outdated.get(cask.token) ? String(outdated.get(cask.token)) : "";

    /* 版本比较的三个来源，优先级从高到低：
       1. `brew outdated --greedy` 报告的版本（Homebrew 自己算的，最权威）；
       2. cask 目录里的版本（Homebrew 管理时可直接用它驱动 `brew upgrade`）；
       3. 应用自带更新源查到的版本（appcast.js，**仅用于展示**，见下方 latestFromApp）。
       前两个只对 managed 生效 —— 非 managed 的应用交给 brew 执行升级没有意义；
       第三个对谁都生效，这正是 1.3.9 要解决的「非 Homebrew 应用查不到更新」。 */
    /* 判断「cask 是否有更低的版本」不能拿 cask 串直接和磁盘比 ——
       cask 的 version 是「主版本.构建号」拼接（QQLive 2.189.0.55910、微信 4.2.0.16,270352），
       磁盘的 CFBundleShortVersionString 只有主版本（2.189.0、4.2.0）。
       直接 isNewer 会把构建号当成新版本号，于是**已经是最新**的应用被反复报「有新版本」
       （本机实测 8 个全中）。改用 isSameOrNewerThan：主版本相同且构建号对上 = 已最新。 */
    const caskTarget = splitCaskVersion(latest);
    const alreadyCurrent = Boolean(
      latest && caskTarget.short && isSameOrNewerThan({ target: caskTarget, installed: app })
    );

    let available = "";
    if (managed) {
      if (forced) available = forced;
      else if (latest && looksLikeVersion(app.version) && !alreadyCurrent) available = latest;
    }

    /* 官网更新源（appcast.js）：只对**非 Homebrew 管理**的应用生效。
       managed 的行已经有 cask 目录这个更权威的来源，不必再去请求一次应用自己的
       appcast（多一次网络请求、还可能两个源对不上）。
       这里的结论**只写进 latestVersion 供展示**，绝不参与 hasUpdate ——
       查到有新版 ≠ 本插件能一键更新。 */
    const fromOfficial = !managed && app.path ? official.get(app.path) : null;
    let latestVersion = fromOfficial && looksLikeVersion(fromOfficial.version) ? fromOfficial.version : "";
    let latestNewer = Boolean(
      latestVersion && looksLikeVersion(app.version) && isNewer(latestVersion, app.version)
    );
    let latestVia = latestVersion ? String(fromOfficial.via || "") : "";

    /* unmanaged 与原判据 `reason === "not-managed"` 完全等价：非 Homebrew 管理、
       且不是系统组件 / App Store 应用。把它单独提出来给 canAdopt / adoptHint 用，
       这样下面把 reason 细分成 not-in-catalog / unknown-version 时，
       「可一键更新集合」逐位不变（1.3.11 的「勾得动、必然失败」绝不重演）。 */
    const unmanaged = Boolean(!managed && !app.system && !app.appStore);
    /* 版本是否可判断：cask 版本、磁盘版本都得是合法版本串，且已做过归一比较。
       读不出 / 不可判断时用 unknown-version 单独标注，便于 client.js 渲染更细的原因。 */
    const versionKnown = Boolean(
      looksLikeVersion(cask && cask.version) && looksLikeVersion(app.version)
    );
    let reason = null;
    if (app.system && !managed) reason = "system-component";
    else if (app.appStore && !managed) reason = "store-managed";
    else if (!managed) reason = !cask ? "not-in-catalog" : !versionKnown ? "unknown-version" : "not-managed";

    /* 「非 Homebrew 管理」是 Mac 上最常见的状态（绝大多数应用是拖 DMG 装的）。
       能对上 cask 时，**不必**再让用户自己去终端跑命令：`brew install --cask --force <token>`
       会移除现有 .app 并装上 cask 版本，等价于「接管并升级」，本插件可以直接执行
       （engine.js 的 runMacosUpdates 会按 adoptToken 走 install --force 分支）。
       注意用 --force 而不是 --adopt：adopt 只接受「已有 app 与目标版本完全一致」，
       版本不同会报 "is different from the one being installed"，对升级场景无效
       （实测：IINA 1.4.4 用 --adopt 失败、用 --force 成功升到 1.5.0 并被 brew 接管）。 */
    const adoptToken = cask && cask.token ? String(cask.token) : "";
    /* pkg 型 cask 需要 sudo：后台进程没有终端，装不了。提前算出供 adoptHint
       与 canAuto 共用（它必须在 adoptHint 之前定义，否则 TDZ）。 */
    const needsSudo = Boolean(cask && cask.needsSudo);
    /* 只有「对得上 cask 且 cask 版本确实更新」才可一键接管升级；
       对不上 cask 的应用仍然只能手动，提示里给占位写法。 */
    const caskNewer = Boolean(adoptToken && latest && looksLikeVersion(app.version) && !alreadyCurrent);
    /* canAdopt 只看 cask 目录：它才是「brew install --force 会装成什么版本」的依据。
       不能因为 appcast 也报了新版就否定它 —— 实测 IINA 两个源都报 1.5.0，
       若拿 latestNewer 做前置条件，这条本可一键的更新会被降级成「需手动」。
       判据用 unmanaged（等价于旧的 `reason === "not-managed"`），不随 reason 细分而变。 */
    const canAdopt = Boolean(unmanaged && adoptToken && caskNewer);
    /* pkg 型 cask 需要 sudo：后台进程没有终端读不到密码，装不了。
       给它的收编提示明确写上「需在终端手动执行（需要管理员密码）」，只改文案、
       不改 needsSudo 判定（那是硬限制，别试图绕过）。 */
    const adoptHint =
      unmanaged
        ? needsSudo
          ? `brew install --cask --force ${adoptToken || "<token>"}（需在终端手动执行，需要管理员密码）`
          : adoptToken
            ? `brew install --cask --force ${adoptToken}`
            : "用 brew install --cask --force <token> 接管后可一键更新"
        : "";

    /* hasUpdate：能一键执行的更新。以前只有 Homebrew 管理的才算；现在
       「非 Homebrew 管理但 cask 目录里有更新版」也能一键（走 --force 接管），
       所以它同样计入 -- 但仍需 updateSupported 与之同步，绝不能出现
       「勾得动、点下去必然失败」的组合。 */
    /* needsSudo 已在 adoptToken 之后算出：它**不算**可一键更新 ——
       否则就是「勾得动、点下去必然失败」。界面会以「需手动」显示，并给出终端命令。 */
    /* pkg 型 cask 被 sudo 挡住时，把它从「可一键」降级成「需手动」，
       但版本信息要保留 —— 否则界面就退回「不可判断」，用户又不知道有新版本了。
       这里用 cask 目录的版本兜底到 latestVersion（来源记为 cask）。 */
    if (needsSudo && caskNewer && !latestNewer) {
      latestVersion = latest;
      latestNewer = true;
      latestVia = "cask";
    }
    const canAuto = canAdopt && !needsSudo;
    const hasUpdate = Boolean((managed && available && !needsSudo) || canAuto);
    const effectiveAvailable = canAuto && !available ? latest : available;
    /* id 必须唯一：前端用 id 当 selected/React key，重复会让「勾一个全勾」、
       stats 重复计数。一个 cask 声明多个 .app 是真实存在的（microsoft-office 声明
       Word/Excel/PowerPoint/Outlook，box-tools、boxy-suite 同理），所以第一个 .app
       沿用 `brew:<token>`，后续的加 bundle 后缀区分。 */
    let id = managed ? `brew:${cask.token}` : `macapp:${app.bundleId || app.bundleName}`;
    if (managed && usedIds.has(id)) {
      const suffix = app.bundleId || app.bundleName || String(items.length);
      id = `brew:${cask.token}#${suffix}`;
      let n = 2;
      while (usedIds.has(id)) id = `brew:${cask.token}#${suffix}~${n++}`;
    }
    usedIds.add(id);
    items.push({
      id,
      name: app.name || app.bundleName,
      version: app.version || "",
      /* available = 「点一下就能升到的版本」。三条来源都会汇到这里：
         既有 Homebrew 管理（brew outdated / cask 目录），也有本插件用
         `brew install --cask --force` 接管升级的情形（canAdopt）。 */
      available: effectiveAvailable,
      /* latestVersion / latestNewer 只表示「官网有更新的版本」这一事实，
         不承诺本插件能升。它们给界面提供「需手动」这类提示，也用于排序。
         与 available 分开是刻意的：把两者混成一个字段，会让
         updateSupported 和 upgradeable 的判断跟着一起错（1.3.9 的教训）。 */
      latestVersion,
      latestNewer,
      latestVia,
      /* 非 Homebrew 应用对应的 cask token：更新时据此走 install --force 分支。
         为空表示「连 cask 都没有」，那种情况下界面不会给出可点按钮。 */
      adoptToken: canAuto ? adoptToken : "",
      canAdopt: canAuto,
      /* 该应用要装的话得走 sudo（pkg 安装器）——界面据此提示「需手动」而非给可点按钮 */
      needsSudo,
      publisher: cask ? `Homebrew cask · ${cask.token}` : app.bundleId || "",
      source: managed ? "homebrew" : app.appStore ? "appstore" : "app",
      installLocation: app.path,
      hasUpdate,
      updateSupported: hasUpdate,
      reason: hasUpdate ? null : reason,
      adoptHint,
      kind: managed ? "cask" : "app",
    });
  }

  // 通过 Homebrew 装的、但标准目录里没找到 .app 的（字体、命令行 cask 等）也要列出来。
  // 它们本来就由 Homebrew 管理，不受「包含非 Homebrew 应用」开关影响。
  //
  // 1.3.18：这里还要区分「本来就没有 .app 的 cask」与「声明了 .app 但磁盘上已丢失」的
  // **孤儿 cask**。后者 `brew upgrade` 在卸载旧版阶段必然报
  // `It seems the App source '...' is not there.`（moved.rb 的 move_back），旧实现把它
  // 当成普通可更新项列出，造成「勾得动、点下去必然失败」。这类行改为：
  //   hasUpdate=false / updateSupported=false / reason="app-missing"，
  // 并把磁盘缺失路径写进 missingPaths 供界面与自动清理使用。字体 / 命令行 cask
  // （没有 .app artifact）逐字保持原行为，不受影响。
  for (const [token, version] of brews) {
    if (claimed.has(token)) continue;
    const entry = byToken.get(token);
    const forced = outdated.get(token) ? String(outdated.get(token)) : "";
    const latest = entry && looksLikeVersion(entry.version) ? entry.version : "";
    let available = "";
    if (forced) available = forced;
    else if (latest && looksLikeVersion(version) && isNewer(latest, version)) available = latest;

    /* cask 目录不可用时（catalog=null）没有 appTargets/appNames，判定会退化成
       "not orphan"——此时不能凭空摘除可更新项，保持旧行为，让后续清理/错误文案兜底。 */
    const missing = entry ? caskAppMissing(entry) : { orphan: false, missingPaths: [] };
    const orphan = Boolean(entry && missing.orphan);
    const hasUpdate = Boolean(available) && !orphan;
    items.push({
      id: `brew:${token}`,
      name: entry ? entry.name : token,
      version: version || "",
      available: orphan ? "" : available,
      publisher: `Homebrew cask · ${token}`,
      source: "homebrew",
      installLocation: "",
      hasUpdate,
      updateSupported: hasUpdate,
      reason: orphan ? "app-missing" : null,
      /* 磁盘缺失路径：供 engine.js 的自动清理与 client.js 的提示文案使用。
         非孤儿行不带这个字段，state.json 结构对它们不变。 */
      ...(orphan ? { missingPaths: missing.missingPaths } : {}),
      kind: "cask",
    });
  }

  if (!catalog) {
    warnings.push("没有可用的 Homebrew cask 目录：只显示 Homebrew 报告的更新，非 Homebrew 应用无法判断是否有新版本");
  }
  /* 「包含非 Homebrew 应用」被关掉只是用户自己选的过滤条件，不是故障 ——
     不放进 warnings，否则界面会一直挂一条红色告警横幅。 */

  items.sort((a, b) => {
    // 排序：可一键更新 → 官网有新版但需手动 → 其它。让「真的有更新」的阶段排在最前，
    // 而不是混在 110 行里靠搜索找。
    const rank = (i) => (i.hasUpdate ? 0 : i.latestNewer ? 1 : 2);
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra - rb;
    return String(a.name).localeCompare(String(b.name));
  });
  return { items, warnings };
}
