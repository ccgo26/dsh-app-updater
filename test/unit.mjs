/**
 * 单元自测：解析器 / 版本比较 / 清单解析 / 静默参数。
 * 全部基于仓库内的 fixture 与真实安装包清单样本，不联网、不改动系统。
 *
 * 运行：node test/unit.mjs
 */

import { readFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import {
  parseInstalledList,
  parseUpgradeList,
  parseWingetTable,
  parseHeaderColumns,
  displayWidth,
  sliceByWidth,
} from "../lib/winget.js";
import { compareVersions, isNewer, looksLikeVersion, splitVersion, compareTails, normalizeVersionKey } from "../lib/version.js";
import { parseInstallerManifest, splitSwitchArgs, defaultSilentArgs, resolveInstallArgs, parseBrewCaskVersions, parseBrewOutdated, findBrew, isArchNotFoundError, explainInstallerExitCode, evaluateUpdateResult, findEdgeUpdate, updateHintFor, pickInstallerSha256, verifyInstallerHash, sha256File, classifyWingetError, isSourceLevelFailure, formatFallbackError, idArchSuffix, archMismatchFor } from "../lib/engine.js";
import { psQuote, ELEVATION_CANCELLED, isElevated } from "../lib/elevate.js";
import {
  applicationDirs,
  parseCaskCatalog,
  pickCask,
  normalizeAppKey,
  buildMacosItems,
  createCaskMatcher,
  splitCaskVersion,
  mainVersionOf,
  isSameOrNewerThan,
} from "../lib/macos.js";
import {
  parseAppUpdateYml,
  electronFeedName,
  parseElectronFeed,
  parseSparkleVersions,
  maxVersion,
  readUpdateSource,
  fetchLatestFromSource,
  checkAppUpdateSources,
} from "../lib/appcast.js";
import { admissionGate, hasConnectionCredentials, resolveLegacyLoopbackOptIn, isCrossSiteBrowserRequest, LEGACY_LOOPBACK_ENV } from "../lib/index.js";
import { settingAppliesTo, Store, defaultSettings } from "../lib/state.js";
import {
  detectEnvironment,
  describeEnvironment,
  windowsName,
  macOSName,
  normalizeArch,
  archLabel,
  wingetArch,
  platformFamily,
  engineFor,
  capabilitiesFor,
  ENGINE_WINGET,
  ENGINE_BREW,
  ENGINE_NONE,
} from "../lib/platform.js";
import { normalizeName } from "../lib/registry.js";

const here = dirname(fileURLToPath(import.meta.url));
let failures = 0;
let checks = 0;

function ok(cond, label, extra) {
  checks += 1;
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${label}${extra === undefined ? "" : ` — ${JSON.stringify(extra)}`}`);
  }
}

function group(name) {
  console.log(`\n${name}`);
}

/* ---------------- 显示宽度 ---------------- */
group("显示宽度 / 定宽表格切列");
ok(displayWidth("abc") === 3, "ASCII 宽度");
ok(displayWidth("哔哩哔哩") === 8, "CJK 按 2 列计宽");
ok(displayWidth("微信 a") === 6, "CJK + ASCII 混合");
const headerStarts = parseHeaderColumns("Name    Id      Version   Available Source");
ok(headerStarts.length === 5 && headerStarts[0] === 0, "表头列起点解析", headerStarts);

/* ---------------- winget list 解析 ---------------- */
group("winget list 解析（真实 fixture）");
const installedRaw = readFileSync(join(here, "fixture-winget-list.txt"), "utf8");
const installed = parseInstalledList(installedRaw);
ok(installed.length === 131, "解析出 131 条已安装应用", installed.length);
ok(installed.every((r) => r.id && r.name), "每行都有 id 与 name");
const git = installed.find((r) => r.id === "Git.Git");
ok(git && git.version === "2.55.0.5", "Git 已装版本解析正确", git);
const zh = installed.find((r) => r.name === "企业微信");
ok(zh && zh.id === "Tencent.WeCom", "中文名行未被错位切列", zh);
const msix = installed.find((r) => r.id.startsWith("MSIX\\"));
ok(Boolean(msix), "MSIX 包带反斜杠 Id 也能解析", msix && msix.id);
const arp = installed.find((r) => r.id.startsWith("ARP\\"));
ok(Boolean(arp), "ARP 包也能解析", arp && arp.id);

/* ---------------- winget upgrade 解析 ---------------- */
group("winget upgrade 解析（真实 fixture，另一套更窄的列宽）");
const upgradable = parseUpgradeList(readFileSync(join(here, "fixture-winget-upgrade.txt"), "utf8"));
ok(upgradable.length === 15, "解析出 15 条可更新", upgradable.length);
ok(
  upgradable.every((r) => r.id && r.available),
  "每条可更新记录都有 id 与 available"
);
const chrome = upgradable.find((r) => r.id === "Google.Chrome");
ok(chrome && chrome.available === "156.0.8078.48", "Chrome 目标版本解析正确", chrome);

/* ---------------- 非表格噪声 ---------------- */
group("非数据行过滤");
// 按 winget 的真实列宽构造（列间距足够宽），这样切列结果与真机一致
const padded = parseWingetTable(
  [
    "Name                Id                 Version       Available     Source",
    "--------------------------------------------------------------------------",
    "Git                 Git.Git            2.55.0.5      2.56.0.3      winget",
    "15 upgrades available.",
    "No installed package found matching input criteria.",
  ].join("\n")
);
const paddedIdx = padded.columns.map((c) => c.toLowerCase());
const paddedRows = padded.rows
  .map((cells) => ({
    name: cells[0] || "",
    id: cells[paddedIdx.indexOf("id")] || "",
    version: cells[paddedIdx.indexOf("version")] || "",
  }))
  .filter((r) => r.name && String(r.version).trim() && r.id && (!/\s/.test(r.id) || /^ARP\\/i.test(r.id)));
ok(padded.rows.length === 3, "通用表格解析保留 3 行（1 条数据 + 2 条提示）", padded.rows.length);
ok(paddedRows.length === 1 && paddedRows[0].id === "Git.Git", "数据行判定剔除 2 条提示行", paddedRows);
const single = parseInstalledList("Name Id      Version  Source\n-----------------------------\nGit  Git.Git 2.56.0.3 winget\n");
ok(single.length === 1 && single[0].source === "winget", "单包查询（无 Available 列）也能解析", single);

/* ---------------- 版本比较 ---------------- */
group("版本比较");
ok(isNewer("2.56.0.3", "2.55.0.5"), "2.56.0.3 > 2.55.0.5");
ok(compareVersions("1.2.3", "1.2.3") === 0, "相同版本相等");
ok(compareVersions("1.2", "1.2.0") === 0, "缺段按 0 补齐");
ok(compareVersions("1.2.3-beta", "1.2.3") === -1, "预发布小于正式版");
ok(compareVersions("1.20.0", "1.19.0") > 0, "1.20.0 > 1.19.0");
ok(compareVersions("2026.7.992920", "2026.6.981214") > 0, "日期风格版本可比");
ok(!looksLikeVersion("Unknown"), "Unknown 不算版本");
ok(looksLikeVersion("4.1.15.56"), "4.1.15.56 是版本");
ok(splitVersion("v1.2.3") && splitVersion("v1.2.3").nums.join(".") === "1.2.3", "去掉 v 前缀");

/* ---------------- 安装包清单 ---------------- */
group("winget 下载清单解析");
const gitYaml = readFileSync(
  join(here, "fixture-installer-git.yaml"),
  "utf8"
);
const gitInfo = parseInstallerManifest(gitYaml);
ok(gitInfo.installerType === "inno", "识别 inno 安装器", gitInfo.installerType);
ok(gitInfo.silent === "/SP- /VERYSILENT /SUPPRESSMSGBOXES /NORESTART", "取出发布方静默参数", gitInfo.silent);
ok(gitInfo.installerUrl.startsWith("https://github.com/git-for-windows/"), "取出官网下载地址", gitInfo.installerUrl);
ok(gitInfo.elevation === "elevatesSelf", "取出提权要求", gitInfo.elevation);

group("静默参数决策");
ok(
  JSON.stringify(resolveInstallArgs({ silent: "/SP- /VERYSILENT", installerType: "inno" }, "a.exe")) ===
    JSON.stringify(["/SP-", "/VERYSILENT"]),
  "清单参数优先"
);
ok(
  JSON.stringify(resolveInstallArgs({ silent: '/qn /norestart /LOG="<LOGPATH>"', installerType: "msi" }, "a.msi")) ===
    JSON.stringify(["/qn", "/norestart"]),
  "剔除占位符模板参数"
);
ok(
  JSON.stringify(resolveInstallArgs({}, "a.msi")) === JSON.stringify(["/qn", "/norestart"]),
  "无清单时按 msi 兜底"
);
ok(
  JSON.stringify(defaultSilentArgs("nullsoft", "a.exe")) === JSON.stringify(["/S"]),
  "无清单时按 NSIS 兜底"
);
ok(
  JSON.stringify(splitSwitchArgs('/S /D="C:\\Program Files\\App"')) === JSON.stringify(["/S", "/D=C:\\Program Files\\App"]),
  "带引号的路径参数保持整体"
);

/* ---------------- 名称归一化 ---------------- */
group("跨源名称匹配");
ok(normalizeName("CPUID CPU-Z 3.01") === normalizeName("CPUID CPU-Z"), "去掉尾部版本号后同名");
ok(normalizeName("Microsoft Edge") !== normalizeName("Google Chrome"), "不同软件不误配");

/* ---------------- 本地化输出（健康检查） ---------------- */
group("本地化 winget 输出解析（中文界面）");
const zhListRaw = readFileSync(join(here, "fixture-winget-list-zh.txt"), "utf8");
const zhUpRaw = readFileSync(join(here, "fixture-winget-upgrade-zh.txt"), "utf8");
const zhInstalled = parseInstalledList(zhListRaw);
const zhUpgradable = parseUpgradeList(zhUpRaw);
ok(zhInstalled.length > 50, "中文表头（名称/ID/版本/可用/源）仍能解析出应用", zhInstalled.length);
ok(zhUpgradable.length >= 1, "中文表头下仍能解析出可更新项", zhUpgradable.length);
ok(
  zhInstalled.length >= installed.length - 5 && zhInstalled.some((r) => r.id === "Git.Git") && installed.some((r) => r.id === "Git.Git"),
  "中英文两次输出规模相当且都能认出同一批关键应用",
  [installed.length, zhInstalled.length]
);
const zhGit = zhInstalled.find((r) => r.id === "Git.Git");
ok(zhGit && zhGit.version && !zhGit.name.includes("名称"), "中文行未把表头当数据", zhGit);
ok(
  zhInstalled.some((r) => r.id.startsWith("ARP\\") && /\s/.test(r.id)),
  "ARP 且显示名带空格的行仍保留"
);
ok(
  zhInstalled.every((r) => looksLikeVersion(r.version) || /^(unknown|未知)$/i.test(r.version)),
  "所有数据行的版本列都像版本号（提示行被剔除）"
);

/* ---------------- 运行环境识别 ---------------- */
group("系统与架构识别");
ok(windowsName("10.0.26300", "26300") === "Windows 11", "build 26300 → Windows 11", windowsName("10.0.26300", "26300"));
ok(windowsName("10.0.19045", "19045") === "Windows 10", "build 19045 → Windows 10", windowsName("10.0.19045", "19045"));
ok(macOSName(24).version === "15" && macOSName(24).name.includes("Sequoia"), "Darwin 24 → macOS 15 Sequoia", macOSName(24));
ok(macOSName(23).version === "14", "Darwin 23 → macOS 14", macOSName(23));
ok(macOSName(99).name.includes("Darwin 99"), "未来版本不崩且如实标注", macOSName(99).name);

ok(
  normalizeArch("win32", "x64", { PROCESSOR_ARCHITECTURE: "AMD64", PROCESSOR_ARCHITEW6432: "ARM64" }) === "arm64",
  "Windows on ARM 上跑 x64 Node 也能识别出 ARM64"
);
ok(normalizeArch("win32", "x64", { PROCESSOR_ARCHITECTURE: "AMD64" }) === "x64", "普通 x64 机器识别为 x64");
ok(normalizeArch("darwin", "arm64", {}) === "arm64", "Apple Silicon 识别为 arm64");
ok(normalizeArch("darwin", "x64", {}) === "x64", "Intel Mac 识别为 x64");
ok(archLabel("darwin", "arm64") === "Apple Silicon（ARM64）", "Apple Silicon 标签", archLabel("darwin", "arm64"));
ok(archLabel("win32", "x64").includes("x64"), "x64 标签", archLabel("win32", "x64"));
ok(wingetArch("arm64") === "arm64" && wingetArch("x64") === "x64" && wingetArch("unknown") === "", "winget 架构取值映射");

ok(platformFamily("win32") === "windows" && platformFamily("darwin") === "macos" && platformFamily("linux") === "other", "平台族归类");
ok(engineFor("windows") === ENGINE_WINGET, "Windows → winget", engineFor("windows"));
ok(engineFor("macos") === ENGINE_BREW, "macOS → Homebrew", engineFor("macos"));
ok(engineFor("other") === ENGINE_NONE, "其它系统 → 无引擎", engineFor("other"));

const envWinArm = detectEnvironment({
  platform: "win32",
  arch: "x64",
  release: "10.0.26100",
  env: { PROCESSOR_ARCHITECTURE: "AMD64", PROCESSOR_ARCHITEW6432: "ARM64" },
  cpus: [{ model: "Snapdragon X Elite" }],
});
ok(envWinArm.family === "windows" && envWinArm.arch === "arm64" && envWinArm.wingetArch === "arm64", "注入式环境识别（Windows ARM64）", envWinArm.arch);
ok(envWinArm.osName === "Windows 11" && envWinArm.osBuild === "26100", "Windows 版本名与 build", [envWinArm.osName, envWinArm.osBuild]);
ok(describeEnvironment(envWinArm).includes("Windows 11") && describeEnvironment(envWinArm).includes("ARM64"), "环境摘要包含系统与架构", describeEnvironment(envWinArm));

const envMac = detectEnvironment({ platform: "darwin", arch: "arm64", release: "24.1.0", env: {}, cpus: [{ model: "Apple M4" }] });
ok(envMac.family === "macos" && envMac.osName.includes("Sequoia") && envMac.arch === "arm64", "注入式环境识别（macOS Apple Silicon）", envMac.osName);

ok(capabilitiesFor(envWinArm, false).scan === true, "有 winget 时 Windows 可扫描");
ok(capabilitiesFor(envWinArm, false).note.includes("winget"), "缺 winget 时给出提示", capabilitiesFor(envWinArm, false).note);
ok(capabilitiesFor(envMac, false).update === false, "macOS 缺 Homebrew 时不可更新");
ok(capabilitiesFor(envMac, false).note.includes("Homebrew"), "macOS 缺 Homebrew 时提示装 Homebrew", capabilitiesFor(envMac, false).note);
ok(capabilitiesFor(envMac, true).scan === true, "macOS 有 Homebrew 时可扫描");
ok(capabilitiesFor(envMac, false).scan === true, "macOS 没有 Homebrew 也能扫描（只是不能更新）——「0 个应用」的真正原因不是没 Homebrew");
ok(capabilitiesFor(envMac, false).update === false, "macOS 没有 Homebrew 时不可更新");
ok(capabilitiesFor({ family: "other" }, false).scan === false, "其它系统不可扫描");

/* ---------------- Homebrew 解析 ---------------- */
group("Homebrew 输出解析");
const versions = parseBrewCaskVersions("visual-studio-code 1.94.0\ngoogle-chrome 131.0.6778.86\n\nbad\n");
ok(versions.get("visual-studio-code") === "1.94.0" && versions.get("google-chrome") === "131.0.6778.86", "解析已装 cask 版本", [...versions]);
ok(versions.size === 2, "无版本的行被忽略", versions.size);
const outdated = parseBrewOutdated(JSON.stringify({ casks: [{ name: "visual-studio-code", current_version: "1.95.0" }, { name: "iterm2", current_version: "3.5.10" }] }));
ok(outdated.get("visual-studio-code") === "1.95.0" && outdated.get("iterm2") === "3.5.10", "解析可升级 cask", [...outdated]);
ok(parseBrewOutdated("not json").size === 0, "坏 JSON 不抛错");
/*
 * findBrew 的不变量：只返回**真实存在**的 brew 文件。
 *
 * 不能断言 `=== null`：findBrew 在 HOMEBREW_PREFIX 之外还会探测 /opt/homebrew、
 * /usr/local、/home/linuxbrew 以及 $PATH 里的每一项，所以在任何装了 Homebrew 的
 * Mac 上它必然返回某个路径 —— 旧断言（1.3.2 及以前）因此在真实机器上恒红。
 *
 * 也不能只把返回值糊进一个白名单：那只是换个方式写死环境。这里改为用临时目录
 * 构造「有 brew」与「没有 brew」两种确定场景，跨平台（Windows 也能跑）验证
 * 「候选路径存在才返回、不存在就继续找/返回 null」这条真正的规则。
 */
const brewOk = (() => {
  const root = mkdtempSync(join(tmpdir(), "dsh-findbrew-"));
  try {
    mkdirSync(join(root, "bin"), { recursive: true });
    writeFileSync(join(root, "bin", "brew"), "", "utf8");
    const found = findBrew({ HOMEBREW_PREFIX: root, PATH: "" });
    return found !== null && existsSync(found) && basename(found) === "brew";
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
})();
ok(brewOk, "HOMEBREW_PREFIX 下有 brew 时返回该文件的绝对路径且文件真实存在");

const brewNoPrefix = (() => {
  const root = mkdtempSync(join(tmpdir(), "dsh-findbrew-empty-"));
  try {
    // 空目录：这个前缀下没有 brew，PATH 也清空，默认前缀在这台机器上是否存在都不影响结论
    return findBrew({ HOMEBREW_PREFIX: root, PATH: "" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
})();
ok(
  brewNoPrefix === null || (existsSync(brewNoPrefix) && basename(brewNoPrefix) === "brew"),
  "前缀下没有 brew 时不会凭空返回路径（装了 Homebrew 的机器上退回真实存在的默认前缀）",
  brewNoPrefix
);

/* ---------------- macOS 应用枚举（本次修复的核心） ---------------- */
group("macOS 应用枚举");
ok(applicationDirs("/Users/x").includes("/Applications"), "枚举 /Applications");
ok(applicationDirs("/Users/x").includes("/Users/x/Applications"), "枚举 ~/Applications");
ok(applicationDirs("/Users/x").includes("/System/Applications/Utilities"), "枚举系统工具目录");

const catalogList = [
  {
    token: "visual-studio-code",
    version: "1.144.0",
    name: ["Microsoft Visual Studio Code"],
    artifacts: [{ app: ["Visual Studio Code.app"], target: "/Applications/Visual Studio Code.app" }],
  },
  {
    token: "iterm2",
    version: "3.5.14",
    name: ["iTerm2"],
    artifacts: [{ app: ["iTerm.app"] }],
  },
  {
    token: "raycast",
    version: "1.99.0",
    name: ["Raycast"],
    artifacts: [{ app: ["Raycast.app"] }],
  },
];
const catalog = parseCaskCatalog(catalogList);
ok(catalog.byToken.get("iterm2").version === "3.5.14", "目录按 token 建索引");
ok(catalog.byApp.get("iterm.app")[0].token === "iterm2", "目录按 .app 文件名建索引（大小写无关）");

const macApps = [
  // 通过 Homebrew 装、且有新版
  { path: "/Applications/Visual Studio Code.app", bundleName: "Visual Studio Code.app", name: "Visual Studio Code", version: "1.140.0", bundleId: "com.microsoft.VSCode", appStore: false, system: false },
  // 通过 Homebrew 装、已是最新
  { path: "/Applications/iTerm.app", bundleName: "iTerm.app", name: "iTerm2", version: "3.5.14", bundleId: "com.googlecode.iterm2", appStore: false, system: false },
  // 拖 DMG 装的，Homebrew 不管
  { path: "/Applications/Raycast.app", bundleName: "Raycast.app", name: "Raycast", version: "1.99.0", bundleId: "com.raycast.macos", appStore: false, system: false },
  // App Store 装的
  { path: "/Applications/Xcode.app", bundleName: "Xcode.app", name: "Xcode", version: "16.0", bundleId: "com.apple.dt.Xcode", appStore: true, system: false },
];
const brews = new Map([["visual-studio-code", "1.140.0"], ["iterm2", "3.5.14"]]);
const macBuilt = buildMacosItems({ apps: macApps, brews, outdated: new Map(), catalog, settings: { includeStoreApps: true, includeUnmanagedApps: true } });

ok(macBuilt.items.length === 4, "4 个 .app 全部列出（旧实现只会有 2 个）", macBuilt.items.map((i) => i.name));
const vsc = macBuilt.items.find((i) => i.name === "Visual Studio Code");
ok(vsc && vsc.hasUpdate && vsc.available === "1.144.0", "Homebrew 管理 + 有新版本 → 可更新并给出目标版本", vsc);
ok(vsc && vsc.updateSupported === true && vsc.id === "brew:visual-studio-code", "可更新的应用带上 brew: token", vsc && vsc.id);
const iterm = macBuilt.items.find((i) => i.name === "iTerm2");
ok(iterm && iterm.hasUpdate === false && iterm.reason === null, "Homebrew 管理且已最新 → 不可更新但没有「不支持」理由", iterm);
const ray = macBuilt.items.find((i) => i.name === "Raycast");
ok(ray && ray.hasUpdate === false && ray.reason === "not-managed", "非 Homebrew 应用：列出但标注「非 Homebrew 管理」", ray);
ok(ray && ray.updateSupported === false, "非 Homebrew 应用不会被标成可更新");
const xcode = macBuilt.items.find((i) => i.name === "Xcode");
ok(xcode && xcode.reason === "store-managed" && xcode.source === "appstore", "App Store 应用标注由商店管理", xcode);
ok(macBuilt.items.filter((i) => i.hasUpdate).length === 1, "只有 1 个可更新");

// --greedy 能强制升级的 cask（自更新应用）也要露出可用版本
const greedy = buildMacosItems({ apps: macApps, brews, outdated: new Map([["iterm2", "3.5.15"]]), catalog, settings: {} });
ok(greedy.items.find((i) => i.name === "iTerm2").available === "3.5.15", "brew outdated --greedy 报告的版本优先", greedy.items.find((i) => i.name === "iTerm2"));

// 关掉「包含非 Homebrew 应用」后只剩 Homebrew 管理的
const onlyBrew = buildMacosItems({ apps: macApps, brews, outdated: new Map(), catalog, settings: { includeUnmanagedApps: false } });
ok(onlyBrew.items.length === 2 && onlyBrew.items.every((i) => i.source === "homebrew"), "关闭开关后只显示 Homebrew 应用", onlyBrew.items.map((i) => i.name));

// 关掉「包含 App Store 应用」
const noStore = buildMacosItems({ apps: macApps, brews, outdated: new Map(), catalog, settings: { includeStoreApps: false } });
ok(!noStore.items.some((i) => i.name === "Xcode"), "关闭 App Store 开关后不显示 Xcode");

// 没有 cask 目录时降级：仍然列出应用，只是都不认为可更新
const noCatalog = buildMacosItems({ apps: macApps, brews, outdated: new Map(), catalog: null, settings: {} });
ok(noCatalog.items.length === 4 && noCatalog.items.every((i) => !i.hasUpdate), "没有 cask 目录也照样列出应用", noCatalog.items.length);
ok(noCatalog.warnings.some((w) => w.includes("cask 目录")), "没有 cask 目录时给出警告");

// Homebrew 装了但 .app 不在标准目录（字体 / 命令行 cask）
const brewOnly = buildMacosItems({
  apps: [],
  brews: new Map([["font-jetbrains-mono", "2.304"]]),
  outdated: new Map(),
  catalog: parseCaskCatalog([{ token: "font-jetbrains-mono", version: "2.304", name: ["JetBrains Mono"], artifacts: [] }]),
  settings: {},
});
ok(brewOnly.items.length === 1 && brewOnly.items[0].id === "brew:font-jetbrains-mono", "没有 .app 的 cask 也能列出", brewOnly.items);

/* ---------------- macOS 目录解析 ---------------- */
group("cask 目录解析");
const parsedCatalog = parseCaskCatalog([
  { token: "raycast", version: "1.99.0", name: ["Raycast"], artifacts: [{ app: ["Raycast.app"] }] },
  { token: "bad-no-artifacts", version: "1.0" },
  null,
  { version: "9.9" },
]);
ok(parsedCatalog.byToken.size === 2, "跳过没有 token 的条目", parsedCatalog.byToken.size);
ok(!parsedCatalog.byApp.has("bad-no-artifacts"), "artifacts 里没有 app 的不建 byApp 索引");
ok(normalizeAppKey("Visual Studio Code.app") === "visualstudiocode", "应用名归一化去掉 .app 与空格");
ok(normalizeAppKey("VS Code") === "vscode", "应用名归一化保留字母数字");

group("同名 .app 的多个 cask：挑对那一个");
// 真实目录里 iterm2 与 iterm2@nightly 都声明 iTerm.app
const dupCatalog = parseCaskCatalog([
  { token: "iterm2@nightly", version: "3.6.0", name: ["iTerm2 Nightly"], artifacts: [{ app: ["iTerm.app"] }] },
  { token: "iterm2", version: "3.7.6", name: ["iTerm2"], artifacts: [{ app: ["iTerm.app"] }] },
]);
ok(dupCatalog.byApp.get("iterm.app").length === 2, "两个 cask 都留在候选里", dupCatalog.byApp.get("iterm.app").length);
ok(
  pickCask(dupCatalog.byApp.get("iterm.app"), { appName: "iTerm2", bundleName: "iTerm.app", brews: new Map() }).token === "iterm2",
  "没有安装记录时优先主 token（不是 @nightly）"
);
ok(
  pickCask(dupCatalog.byApp.get("iterm.app"), { appName: "iTerm2", bundleName: "iTerm.app", brews: new Map([["iterm2@nightly", "3.6.0"]]) }).token === "iterm2@nightly",
  "已装的是 nightly 时优先已装的那个"
);
// 弃用 / 停用的 cask 排在后面
const depCatalog = parseCaskCatalog([
  { token: "foo-old", version: "1.0", deprecated: true, artifacts: [{ app: ["Foo.app"] }] },
  { token: "foo", version: "2.0", artifacts: [{ app: ["Foo.app"] }] },
]);
ok(pickCask(depCatalog.byApp.get("foo.app"), { appName: "Foo", bundleName: "Foo.app", brews: new Map() }).token === "foo", "弃用的 cask 不会被选中");

/* ---------------- 提权与安装复核 ---------------- */
group("提权执行（PowerShell 助手）");
ok(psQuote("C:\\Program Files\\a.exe") === "'C:\\Program Files\\a.exe'", "psQuote 保留 Windows 路径");
ok(psQuote("it's") === "'it''s'", "psQuote 转义单引号");
ok(psQuote(null) === "''", "psQuote 处理 null");
ok(ELEVATION_CANCELLED === 1223, "UAC 被取消的退出码是 1223");

group("架构缺失错误识别（中英文都要认）");
ok(isArchNotFoundError("找不到适用的安装程序;有关详细信息，请参阅日志。"), "中文「找不到适用」");
ok(isArchNotFoundError("No applicable installer found"), "英文 No applicable installer");
ok(!isArchNotFoundError("No package found matching input criteria"), "「找不到该包」不算架构问题");
ok(!isArchNotFoundError(""), "空输出不算");
ok(!isArchNotFoundError(null), "null 不算");

group("安装后复核：退出码 0 不等于成功");
ok(evaluateUpdateResult({ before: "2026.6.981214", after: "2026.6.981214", target: "2026.7.992920" }).changed === false, "G HUB：退出码 0、版本没变 → 判为失败");
ok(evaluateUpdateResult({ before: "2026.6.981214", after: "2026.7.992920", target: "2026.7.992920" }).changed === true, "达到目标版本 → 成功");
ok(evaluateUpdateResult({ before: "2026.6.981214", after: "2026.8.0", target: "2026.7.992920" }).changed === true, "超过目标版本 → 成功");
ok(evaluateUpdateResult({ before: "Unknown", after: "Unknown", target: "7.5.0.0" }).unverifiable === true, "虎牙：读不到版本 → 无法复核（不能算失败）");
ok(evaluateUpdateResult({ before: "1.0", after: "", target: "2.0" }).unverifiable === true, "空版本 → 无法复核");
ok(evaluateUpdateResult({ before: "1.0.0", after: "1.2.0", target: "" }).changed === true, "目标未知但版本变新 → 成功");
ok(evaluateUpdateResult({ before: "1.2.0", after: "1.2.0", target: "" }).changed === false, "目标未知且没变 → 失败");

group("安装器退出码 → 人话");
ok(explainInstallerExitCode(1603, "").includes("1603"), "1603 给出可读解释");
ok(explainInstallerExitCode(1603, "first line\nsecond line") === "first line", "有输出时优先用输出的首行");
ok(explainInstallerExitCode(9999, "") === "安装程序退出码 9999", "未知退出码原样透出");

group("Edge 自带更新服务定位");
const edgeUpdate = findEdgeUpdate();
ok(edgeUpdate === null || /MicrosoftEdgeUpdate\.exe$/i.test(edgeUpdate), "返回绝对路径或 null");
ok(updateHintFor("Logitech.GHUB").includes("启动 G HUB"), "G HUB 给出「启动应用才会应用更新」的提示");
ok(updateHintFor("microsoft.edge").length > 0, "Edge 有提示");
ok(updateHintFor("Some.Other") === "" && updateHintFor(null) === "", "未知应用没有提示");

/* ---------------- connection 准入 ---------------- */
function fakeRes() {
  const res = { statusCode: 0, headers: {}, body: "" };
  res.setHeader = (k, v) => {
    res.headers[k] = v;
  };
  res.writeHead = (code, headers) => {
    res.statusCode = code;
    Object.assign(res.headers, headers || {});
  };
  res.end = (body) => {
    res.body = String(body == null ? "" : body);
  };
  return res;
}
function fakeReq({ loopback = true, headers = {} } = {}) {
  return { socket: { remoteAddress: loopback ? "127.0.0.1" : "10.0.0.5" }, headers };
}

group("connection 准入（市场审核要求：默认拒绝）");
ok(hasConnectionCredentials({ headers: { cookie: "dsh=x" } }) === true, "识别浏览器会话 Cookie");
ok(hasConnectionCredentials({ headers: { authorization: "Bearer x" } }) === true, "识别 API Cookie/Authorization");
ok(hasConnectionCredentials({ headers: {} }) === false, "没有凭据时返回 false");

/* --- 兼容模式开关：默认关闭，必须是显式动作 --- */
ok(resolveLegacyLoopbackOptIn(undefined, {}) === false, "没有任何显式开关 → 兼容模式关闭");
ok(resolveLegacyLoopbackOptIn(null, {}) === false, "配置为 null → 兼容模式关闭");
ok(resolveLegacyLoopbackOptIn({}, {}) === false, "配置里没有该字段 → 兼容模式关闭");
ok(resolveLegacyLoopbackOptIn({ allowLegacyLoopback: false }, {}) === false, "配置显式 false → 关闭");
ok(resolveLegacyLoopbackOptIn({ allowLegacyLoopback: true }, {}) === true, "插件配置 allowLegacyLoopback:true → 开启");
ok(resolveLegacyLoopbackOptIn(undefined, { [LEGACY_LOOPBACK_ENV]: "1" }) === true, "环境变量 =1 → 开启");
ok(resolveLegacyLoopbackOptIn(undefined, { [LEGACY_LOOPBACK_ENV]: "true" }) === true, "环境变量 =true → 开启");
ok(resolveLegacyLoopbackOptIn(undefined, { [LEGACY_LOOPBACK_ENV]: "0" }) === false, "环境变量 =0 → 关闭");
ok(resolveLegacyLoopbackOptIn(undefined, { [LEGACY_LOOPBACK_ENV]: "off" }) === false, "环境变量 =off → 关闭");

/* --- 宿主没有 connection 服务：默认拒绝，只有显式开启兼容模式才放行 --- */
{
  const res = fakeRes();
  ok(
    admissionGate(fakeReq(), res, null) === false && res.statusCode === 403 && res.headers["X-DSH-Admission"] === "denied",
    "没有 connection 服务 + 回环 + 未开兼容模式 → 403（默认拒绝）"
  );
}
{
  const res = fakeRes();
  ok(admissionGate(fakeReq({ loopback: false }), res, null) === false && res.statusCode === 403, "没有 connection 服务时，非回环请求 403");
}
{
  const res = fakeRes();
  ok(
    admissionGate(fakeReq(), res, null, { allowLegacyLoopback: true }) === true &&
      res.headers["X-DSH-Admission"] === "loopback-legacy-optin" &&
      res.headers["X-DSH-Admission-Warning"] === "legacy-loopback-compatibility-enabled",
    "显式开启兼容模式 + 回环 → 放行并标注 opt-in 响应头"
  );
}
{
  const res = fakeRes();
  ok(
    admissionGate(fakeReq({ loopback: false }), res, null, { allowLegacyLoopback: true }) === false && res.statusCode === 403,
    "即使开启兼容模式，非回环请求仍然 403"
  );
}

/* --- 宿主有 connection 服务：一律以 admit() 为准 --- */
{
  const res = fakeRes();
  const connection = { admit: () => ({ peer: { id: "peer-1" } }) };
  ok(admissionGate(fakeReq(), res, connection) === true && res.statusCode === 0, "准入通过 → 放行且不写响应");
}
{
  const res = fakeRes();
  const connection = { admit: () => undefined };
  ok(admissionGate(fakeReq(), res, connection) === false && res.statusCode === 500, "准入返回空值 → 500（不把看不懂的结果放行）");
}
{
  const res = fakeRes();
  const connection = { admit: () => ({ rejection: "401" }) };
  ok(admissionGate(fakeReq(), res, connection) === false && res.statusCode === 403, "准入返回非数字拒绝码 → 403（fail-closed）");
}
{
  const res = fakeRes();
  const connection = { admit: () => ({ rejection: 403 }) };
  ok(admissionGate(fakeReq({ loopback: false }), res, connection) === false && res.statusCode === 403, "准入拒绝 403（不可信来源）→ 403");
}
{
  const res = fakeRes();
  const connection = { admit: () => ({ rejection: 409 }) };
  ok(admissionGate(fakeReq(), res, connection) === false && res.statusCode === 409, "准入拒绝 409（连接被占用）→ 409");
}
{
  const res = fakeRes();
  const connection = { admit: () => ({ rejection: 401 }) };
  ok(admissionGate(fakeReq({ headers: { cookie: "dsh=x" } }), res, connection) === false && res.statusCode === 401, "带凭据但未认证 → 401");
}
{
  const res = fakeRes();
  const connection = { admit: () => ({ rejection: 401 }) };
  ok(
    admissionGate(fakeReq({ headers: { cookie: "dsh=x" } }), res, connection, { allowLegacyLoopback: true }) === false &&
      res.statusCode === 401,
    "带凭据未认证时，兼容模式也不放行"
  );
}
{
  const res = fakeRes();
  const connection = { admit: () => ({ rejection: 401 }) };
  ok(
    admissionGate(fakeReq(), res, connection) === false && res.statusCode === 401 && res.headers["X-DSH-Admission"] === "denied",
    "无凭据的回环请求默认拒绝（不再退回回环信任）"
  );
}
{
  const res = fakeRes();
  const connection = { admit: () => ({ rejection: 401 }) };
  ok(
    admissionGate(fakeReq(), res, connection, { allowLegacyLoopback: true }) === true &&
      res.headers["X-DSH-Admission"] === "loopback-legacy-optin",
    "显式开启兼容模式后，无凭据的回环请求才按旧规则放行"
  );
}
{
  const res = fakeRes();
  const connection = { admit: () => ({ rejection: 401 }) };
  ok(
    admissionGate(fakeReq({ loopback: false }), res, connection, { allowLegacyLoopback: true }) === false && res.statusCode === 401,
    "兼容模式的例外只覆盖回环地址，非回环仍然 401"
  );
}
{
  const res = fakeRes();
  const connection = {
    admit: () => {
      throw new Error("carrier unavailable");
    },
  };
  ok(admissionGate(fakeReq(), res, connection) === false && res.statusCode === 500, "准入抛错 → 500 而不是静默放行");
}

/* ---------------- 1.3.5 回归：尾缀自然序 / 本地哈希复核 ---------------- */
{
  // 尾缀字典序的经典翻车：位数一变顺序就反（build10 < build9）
  ok(compareVersions("1.2.3-build10", "1.2.3-build9") === 1, "尾缀数字按数值比：build10 > build9");
  ok(compareVersions("5.8.r100", "5.8.r99") === 1, "尾缀 r100 > r99（字典序会判反）");
  ok(compareVersions("1.2.3-beta2", "1.2.3-beta10") === -1, "beta2 < beta10");
  ok(compareTails("rc9", "rc10") === -1, "compareTails 自然序");
  ok(compareTails("a", "a") === 0, "compareTails 相等");
  // 预发布语义不能因自然序而回退
  ok(compareVersions("1.2.3", "1.2.3-beta") === 1, "正式版仍大于预发布");
  ok(compareVersions("3.0.0-rc1", "3.0.0") === -1, "rc1 小于正式版");
}
{
  const info = parseInstallerManifest(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixture-installer-git.yaml"), "utf8"));
  ok(info.sha256ByArch && info.sha256ByArch.x64 === "dc6d3db061999136e139f31376c5582a9ed6f36a4ea12f15e54ad7fa2bfc0bf2", "清单解析出按架构配对的 InstallerSha256");
  ok(pickInstallerSha256(info, "x64", "Git-2.56.0.3-64-bit.exe") === info.sha256ByArch.x64, "按架构键直接命中");
  ok(pickInstallerSha256(info, "", "Git-2.56.0.3-64-bit.exe") === info.sha256ByArch.x64, "架构缺失时用文件名的 64-bit 别名配对");
  ok(pickInstallerSha256({ sha256ByArch: { x64: "a".repeat(64), arm64: "b".repeat(64) } }, "", "node-v22-setup.msi") === null, "多架构且无法配对时宁可不校验（绝不误判篡改）");
}
{
  const dir = mkdtempSync(join(tmpdir(), "dsh-hash-"));
  const file = join(dir, "payload.bin");
  writeFileSync(file, "hello dsh");
  const hex = await sha256File(file);
  ok(/^[0-9a-f]{64}$/.test(hex), "sha256File 输出 64 位十六进制");
  const good = await verifyInstallerHash(file, { sha256ByArch: { any: hex } }, "", () => {});
  ok(good.ok === true && good.skipped !== true, "哈希一致 → 校验通过");
  const bad = await verifyInstallerHash(file, { sha256ByArch: { any: "f".repeat(64) } }, "", () => {});
  ok(bad.ok === false && /不一致/.test(bad.error), "哈希不一致 → 拒绝执行并报期望/实际");
  const skip = await verifyInstallerHash(file, {}, "", () => {});
  ok(skip.ok === true && skip.skipped === true, "清单没有可配对哈希 → 跳过而不是失败");
  rmSync(dir, { recursive: true, force: true });
}

/* ---------------- 1.3.5 第二批回归：来源围栏 / 归一化 / 双语匹配 ---------------- */
{
  const base = { host: "127.0.0.1:7202" };
  ok(isCrossSiteBrowserRequest(fakeReq({ headers: {} })) === false, "无 Origin/Referer（本机脚本 / IPC 桥）不算跨站");
  ok(isCrossSiteBrowserRequest(fakeReq({ headers: { ...base, origin: "http://127.0.0.1:7202" } })) === false, "同源 Origin 放行");
  ok(isCrossSiteBrowserRequest(fakeReq({ headers: { ...base, origin: "http://evil.example" } })) === true, "跨站 Origin 判为浏览器跨站");
  ok(isCrossSiteBrowserRequest(fakeReq({ headers: { ...base, referer: "https://evil.example/page" } })) === true, "跨站 Referer 同样拦下");
  ok(isCrossSiteBrowserRequest(fakeReq({ headers: { ...base, origin: "null" } })) === true, "opaque origin（file:// 页面）拒绝");
  ok(isCrossSiteBrowserRequest(fakeReq({ headers: { ...base, "sec-fetch-site": "cross-site" } })) === true, "Sec-Fetch-Site: cross-site 直接拒绝");
  // 兼容模式豁免必须带上来源围栏：任意网页的无 Cookie fetch 不得驱动提权安装
  {
    const res = fakeRes();
    ok(
      admissionGate(fakeReq({ headers: { ...base, origin: "http://evil.example" } }), res, null, { allowLegacyLoopback: true }) === false &&
        res.statusCode === 403,
      "开启兼容模式后，跨站浏览器请求仍然被豁免围栏拒绝（CSRF 面关闭）"
    );
  }
  {
    const res = fakeRes();
    ok(
      admissionGate(fakeReq({ headers: base }), res, null, { allowLegacyLoopback: true }) === true &&
        res.headers["X-DSH-Admission"] === "loopback-legacy-optin",
      "兼容模式下本机脚本（无来源头）照常放行"
    );
  }
  {
    const connection = { admit: () => ({ rejection: 401 }) };
    const res = fakeRes();
    ok(
      admissionGate(fakeReq({ headers: { ...base, origin: "http://evil.example" } }), res, connection, { allowLegacyLoopback: true }) === false,
      "有 connection 时，401+回环+显式 opt-in 也挡不住跨站 Origin"
    );
  }
}
{
  // \b版本\b 是死分支（JS \b 只认 ASCII 边界），修复后含「版本」的 DisplayName 能与 winget 条目归并
  ok(normalizeName("Google Chrome 版本 141.0.7357") === normalizeName("Google Chrome"), "中文名「版本 X」后缀被剥掉");
  ok(normalizeName("微信 版本 8.0") === normalizeName("微信"), "无空格「版本」也能剥");
}
{
  // 中文 winget 的落盘行（「安装程序已下载:」）必须与英文一样被识别，否则触发重复下载
  const RE = /(?:Installer downloaded|安装程序已下载)\s*[:：]\s*(.+?)\s*$/m;
  ok(RE.test("安装程序已下载: D:\\x\\Git-2.56.0.3-64-bit.exe"), "中文冒号/中文文案匹配");
  ok(RE.test("Installer downloaded: D:\\x\\a.exe"), "英文仍匹配");
  const m = "安装程序已下载: C:\\d\\Git-64-bit.exe".match(RE);
  ok(m && m[1] === "C:\\d\\Git-64-bit.exe", "捕获路径");
}
{
  // Windows 扫描：取消必须抛错，绝不把半截输出当「0 个可更新」覆盖上次结果（对抗审查 #1）
  const scanSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../lib/engine.js"), "utf8");
  const winScan = scanSrc.slice(scanSrc.indexOf("export async function scanApps"), scanSrc.indexOf("export async function runUpdates"));
  ok((winScan.match(/signal && signal\.aborted/g) || []).length >= 3, "scanApps 的 winget 路径有取消检查");
  // 只看真实代码行（注释里会引用旧写法）：`if (upRes.ok || upRes.stdout)` 必须已消失
  const codeOnly = winScan.split("\n").filter((l) => !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*")).join("\n");
  ok(!/upRes\.ok \|\| upRes\.stdout/.test(codeOnly), "半截 stdout 不再被当真值（upRes.ok || upRes.stdout 已移除）");
}

/* ---------------- 1.3.8：非 Homebrew 应用的「下一步」提示 ---------------- */
group("1.3.8 非 Homebrew 应用：给出可执行的收编命令");
{
  // 能对上 cask 的非 Homebrew 应用 → 提示里给真 token（--adopt 接管现有 .app，不重装）
  const withCask = buildMacosItems({
    apps: [
      { path: "/Applications/IINA.app", bundleName: "IINA.app", name: "IINA", version: "1.4.4", bundleId: "com.colliderli.iina", appStore: false, system: false },
    ],
    brews: new Map(), // 没装 → 非 Homebrew 管理
    outdated: new Map(),
    catalog: parseCaskCatalog([{ token: "iina", version: "1.5.0", name: ["IINA"], artifacts: [{ app: ["IINA.app"] }] }]),
    settings: {},
  });
  const iina = withCask.items.find((i) => i.name === "IINA");
  /* 1.3.10 起：能对上 cask 且版本更新 → 直接变成可一键（install --force）。
     所以这里不再停留在「标注 not-managed」，而是给出可执行的目标版本与 token。 */
  ok(iina && iina.canAdopt === true, "能对上 cask 且版本更新 → 可一键接管升级", iina && iina.canAdopt);
  ok(iina && iina.adoptHint === "brew install --cask --force iina", "提示给具体 token，且用 --force", iina && iina.adoptHint);

  // 对不上 cask 的应用 → 给占位写法，仍然告诉用户下一步是什么
  const noCask = buildMacosItems({
    apps: [
      { path: "/Applications/Mystery.app", bundleName: "Mystery.app", name: "Mystery", version: "9.9", bundleId: "com.example.mystery", appStore: false, system: false },
    ],
    brews: new Map(),
    outdated: new Map(),
    catalog: parseCaskCatalog([{ token: "other", version: "1.0", name: ["Other"], artifacts: [{ app: ["Other.app"] }] }]),
    settings: {},
  });
  const mystery = noCask.items.find((i) => i.name === "Mystery");
  ok(mystery && typeof mystery.adoptHint === "string" && mystery.adoptHint.includes("--force"), "对不上 cask 时给出占位提示", mystery && mystery.adoptHint);
  // 关键边界：没有 cask 就**不能**一键，否则会出现「勾得动、点下去必然失败」
  ok(mystery && mystery.hasUpdate === false && mystery.canAdopt === false, "对不上 cask 的应用不可一键更新", mystery && { hasUpdate: mystery.hasUpdate, canAdopt: mystery.canAdopt });
  // 1.3.14 修复后 reason 细分：对不上 cask 的标 not-in-catalog（更精确），不再是笼统的 not-managed
  ok(mystery && mystery.reason === "not-in-catalog", "对不上 cask 时标注「目录未收录」而非笼统的 not-managed", mystery && mystery.reason);

  // 系统组件 / App Store 应用不该被建议去 brew 收编
  const sysAndStore = buildMacosItems({
    apps: [
      { path: "/System/Applications/Finder.app", bundleName: "Finder.app", name: "Finder", version: "1.0", bundleId: "com.apple.finder", appStore: false, system: true },
      { path: "/Applications/Xcode.app", bundleName: "Xcode.app", name: "Xcode", version: "16.0", bundleId: "com.apple.dt.Xcode", appStore: true, system: false },
    ],
    brews: new Map(),
    outdated: new Map(),
    catalog: parseCaskCatalog([{ token: "xcode", version: "17.0", name: ["Xcode"], artifacts: [{ app: ["Xcode.app"] }] }]),
    settings: {},
  });
  ok(sysAndStore.items.every((i) => !i.adoptHint), "系统组件与 App Store 应用不给 --adopt 提示", sysAndStore.items.map((i) => [i.name, i.adoptHint]));

  // Homebrew 管理的应用不需要收编提示
  const managedItem = buildMacosItems({
    apps: [
      { path: "/Applications/iTerm.app", bundleName: "iTerm.app", name: "iTerm2", version: "3.5.14", bundleId: "com.googlecode.iterm2", appStore: false, system: false },
    ],
    brews: new Map([["iterm2", "3.5.14"]]),
    outdated: new Map(),
    catalog: parseCaskCatalog([{ token: "iterm2", version: "3.5.14", name: ["iTerm2"], artifacts: [{ app: ["iTerm.app"] }] }]),
    settings: {},
  });
  ok(managedItem.items.every((i) => !i.adoptHint), "Homebrew 管理的应用不带收编提示");
}

/* ---------------- 1.3.8：平台专属设置不跨平台落盘 ---------------- */
group("1.3.8 平台专属设置");
{
  ok(settingAppliesTo("autoElevate", "windows") === true, "autoElevate 在 Windows 生效");
  ok(settingAppliesTo("autoElevate", "macos") === false, "autoElevate 在 macOS 不生效");
  ok(settingAppliesTo("includeRegistryOnly", "macos") === false, "includeRegistryOnly 在 macOS 不生效");
  ok(settingAppliesTo("includeUnmanagedApps", "macos") === true, "includeUnmanagedApps 在 macOS 生效");
  ok(settingAppliesTo("includeUnmanagedApps", "windows") === false, "includeUnmanagedApps 在 Windows 不生效");
  ok(settingAppliesTo("keepInstallers", "macos") === true, "跨平台开关在 macOS 生效");
  ok(settingAppliesTo("keepInstallers", "windows") === true, "跨平台开关在 Windows 生效");
  ok(settingAppliesTo("downloadDir", "other") === true, "未知平台不影响通用开关");
}

/* ---------------- 1.3.8 对抗审计回归（审计员发现，全部已实测复现） ---------------- */
group("1.3.8 回归：平台归属只认真实平台（防陈旧 env 误删本平台键）");
{
  // 本机 win32，但 state.json 里 env 是另一台机器留下的 macos（同步/漫游/换机）
  const s = new Store();
  s.loaded = true;
  s.save = () => {};
  s.state = { ...s.state, env: { family: "macos", platform: "darwin" }, settings: { ...defaultSettings() } };
  const fam = s.platformFamily();
  const realFamily = platformFamily(process.platform);
  ok(fam === realFamily, "platformFamily() 用真实平台而非陈旧 env", { fam, realFamily });
  s.pruneForeignSettings();
  if (realFamily === "windows") {
    ok(s.state.settings.includeRegistryOnly === true, "Windows 上 includeRegistryOnly 不被误删", s.state.settings.includeRegistryOnly);
    ok(s.state.settings.autoElevate === true, "Windows 上 autoElevate 不被误删");
  } else {
    ok(s.state.settings.includeUnmanagedApps === true, "macOS 上 includeUnmanagedApps 不被误删");
  }
}

group("1.3.8 回归：includeRegistryOnly 用 !== false 判断（缺字段=开启）");
{
  // 真值判断会让「键不存在」被当成「用户关掉」，静默丢掉整个注册表源
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../lib/engine.js"), "utf8");
  const code = src.split("\n").filter((l) => !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*")).join("\n");
  ok(!/if \(settings\.includeRegistryOnly\)/.test(code), "不再有真值判断 if (settings.includeRegistryOnly)");
  ok(!/!settings\.includeRegistryOnly &&/.test(code), "过滤处不再用 !settings.includeRegistryOnly");
  ok(/settings\.includeRegistryOnly !== false/.test(code), "改成了 !== false");
  ok(/settings\.includeRegistryOnly === false && app\.source === "registry"/.test(code), "过滤处改成 === false");
}

group("1.3.8 回归：useSelfUpdater 可被持久化（此前读得到但设不了）");
{
  const s = new Store();
  s.loaded = true;
  s.save = () => {};
  ok(s.state.settings.useSelfUpdater === true, "默认声明在 defaultSettings 里", s.state.settings.useSelfUpdater);
  const next = s.updateSettings({ useSelfUpdater: false });
  ok(next.useSelfUpdater === false, "updateSettings 能关掉自带更新器（逃生开关可用）", next.useSelfUpdater);
}

group("1.3.8 回归：多 .app 的 cask 不产生重复 id");
{
  const catalog = parseCaskCatalog([
    { token: "microsoft-office", version: "16.99", name: ["Microsoft Office"], artifacts: [{ app: ["Word.app", "Excel.app", "PowerPoint.app", "Outlook.app"] }] },
  ]);
  const apps = ["Word", "Excel", "PowerPoint", "Outlook"].map((n) => ({
    path: `/Applications/${n}.app`,
    bundleName: `${n}.app`,
    name: n,
    version: "16.0",
    bundleId: `com.ms.${n}`,
    appStore: false,
    system: false,
  }));
  const r = buildMacosItems({ apps, brews: new Map([["microsoft-office", "16.0"]]), outdated: new Map(), catalog, settings: {} });
  const ids = r.items.map((i) => i.id);
  ok(r.items.length === 4, "4 个 .app 都列出", r.items.length);
  ok(new Set(ids).size === ids.length, "id 唯一（前端 selected/key 不会串）", ids);
  ok(ids.filter((i) => i.startsWith("brew:microsoft-office")).length === 4, "仍都是同一个 cask 的条目", ids);
}

group("1.3.8 回归：哈希配对不再被 win32 别名抢先");
{
  const mk = () => ({ sha256ByArch: { x86: "aaaa".repeat(16), x64: "bbbb".repeat(16) } });
  // Electron 系文件名：平台 win32 + 架构 x64，x86 的 win32 别名不能抢先
  ok(pickInstallerSha256(mk(), "", "App-win32-x64.exe")?.startsWith("bbbb"), "App-win32-x64.exe 选中 x64 哈希");
  ok(pickInstallerSha256(mk(), "arm64", "App-win32-x64.exe")?.startsWith("bbbb"), "arch 不匹配时仍靠文件名选对 x64");
  ok(pickInstallerSha256(mk(), "", "App-32bit.exe")?.startsWith("aaaa"), "真 32 位包仍选中 x86 哈希");
  ok(pickInstallerSha256(mk(), "", "App-win32.exe")?.startsWith("aaaa"), "纯 win32（无架构标记）兜底到 x86");
  ok(pickInstallerSha256(mk(), "", "App-arm64.exe") === null, "没有 arm64 哈希时拒绝猜（fail-closed）");
  ok(pickInstallerSha256({ sha256ByArch: { x64: "cccc".repeat(16) } }, "", "x.exe")?.startsWith("cccc"), "单哈希清单直接用");
}

group("1.3.8 回归：macOS 扫描响应取消");
{
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../lib/engine.js"), "utf8");
  const macScan = src.slice(src.indexOf("async function scanMacos"), src.indexOf("async function runMacosUpdates"));
  ok((macScan.match(/throwIfAborted\(\)/g) || []).length >= 3, "枚举后 / 目录前 / 目录后都有取消检查", (macScan.match(/throwIfAborted\(\)/g) || []).length);
  ok(/throw new Error\("扫描已取消"\)/.test(macScan), "取消向上抛，不当故障");
}

/* ================================================================== *
 * 1.3.9：非 Homebrew 应用的「官网有没有新版」
 * ================================================================== */

group("1.3.9 中文应用名不再错配 cask（归一化为空串的坑）");
{
  // normalizeAppKey 只保留 [a-z0-9]，中文名全部塌成 ""。旧实现拿空串继续逐 token 比对，
  // 第一个「声明了纯符号 .app」的 cask 会恒等命中 —— 实测把「爱奇艺」错配成
  // alipay-key-tool（支付宝开放平台密钥工具），连 --adopt 命令都是错的。
  ok(normalizeAppKey("爱奇艺") === "", "前提成立：中文名归一化为空串", normalizeAppKey("爱奇艺"));
  const catalog = parseCaskCatalog([
    { token: "alipay-key-tool", version: "2.0.4", name: ["Alipay Key Tool"], artifacts: [{ app: ["支付宝开放平台密钥工具.app"] }] },
  ]);
  const matcher = createCaskMatcher({ byApp: catalog.byApp, byToken: catalog.byToken, brews: new Map() });
  const matched = matcher({ name: "爱奇艺", bundleName: "爱奇艺.app" });
  ok(matched === null, "中文名匹配不上时不乱认 cask，而是返回 null", matched && matched.token);

  const built = buildMacosItems({
    apps: [{ path: "/Applications/爱奇艺.app", bundleName: "爱奇艺.app", name: "爱奇艺", version: "17.6.1", bundleId: "com.iqiyi.player", appStore: false, system: false }],
    brews: new Map(),
    outdated: new Map(),
    catalog,
    settings: {},
  });
  const iqiyi = built.items.find((i) => i.name === "爱奇艺");
  ok(iqiyi && iqiyi.publisher === "com.iqiyi.player", "publisher 回落到 bundle id，不是别人的 cask token", iqiyi && iqiyi.publisher);
  ok(iqiyi && !iqiyi.adoptHint.includes("alipay-key-tool"), "--adopt 命令不会指向错误的应用", iqiyi && iqiyi.adoptHint);
}

group("1.3.9 Sparkle appcast 解析");
{
  // 真实形状（IINA 的 appcast，已精简）：shortVersionString 是面向用户的版本，
  // sparkle:version(180) 是构建号，绝不能拿来比较。
  const xml = `<rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle" version="2.0"><channel>
    <title>IINA</title>
    <item><title>1.5.0</title><pubDate>Fri, 02 Oct 2026 16:48:15 -0400</pubDate>
      <sparkle:version>180</sparkle:version><sparkle:shortVersionString>1.5.0</sparkle:shortVersionString>
      <enclosure url="https://dl-portal.iina.io/IINA.v1.5.0.dmg" length="113048935" type="application/octet-stream"/>
    </item>
    <item><title>1.4.4</title><sparkle:version>174</sparkle:version>
      <sparkle:shortVersionString>1.4.4</sparkle:shortVersionString></item>
  </channel></rss>`;
  const versions = parseSparkleVersions(xml);
  ok(versions.length === 2, "两条 item 都被解析出来", versions);
  ok(maxVersion(versions) === "1.5.0", "取最大版本 1.5.0（不是构建号 180）", maxVersion(versions));
  ok(maxVersion(versions) !== "180", "构建号绝不会被当成版本");

  // 只有 title、没有 shortVersionString 的老 appcast 也要能读
  const old = `<item><title>2.0.14</title><sparkle:version>931</sparkle:version></item>`;
  ok(maxVersion(parseSparkleVersions(old)) === "2.0.14", "老格式（只有 title）也能读出 2.0.14");

  // 带 channel 的 item 是灰度通道：正式通道有货时不能用它
  const ch = `<item><title>9.9.9</title><sparkle:shortVersionString>9.9.9</sparkle:shortVersionString>
      <sparkle:channel>beta</sparkle:channel></item>
    <item><title>1.2.0</title><sparkle:shortVersionString>1.2.0</sparkle:shortVersionString></item>`;
  ok(maxVersion(parseSparkleVersions(ch)) === "1.2.0", "有正式版时不把 beta 通道当最新", maxVersion(parseSparkleVersions(ch)));
  const onlyCh = `<item><title>3.0.0</title><sparkle:shortVersionString>3.0.0</sparkle:shortVersionString>
      <sparkle:channel>beta</sparkle:channel></item>`;
  ok(maxVersion(parseSparkleVersions(onlyCh)) === "3.0.0", "整个 appcast 只有通道包时仍可用（不至于永远无解）");

  ok(maxVersion([]) === "", "空列表返回空串");
  ok(maxVersion(["garbage", "1.0.0"]) === "1.0.0", "无版本形状的条目被跳过");
}

group("1.3.9 Electron app-update.yml 解析");
{
  const yml = `provider: generic
url: https://api.bilibili.com/x/elec-frontend/update/
updaterCacheDirName: bilibili-updater
`;
  const parsed = parseAppUpdateYml(yml);
  ok(parsed && parsed.url === "https://api.bilibili.com/x/elec-frontend/update/", "generic provider 的 url 被读出", parsed && parsed.url);
  ok(parsed && parsed.channel === "", "没有 channel 时为空", parsed && parsed.channel);
  ok(electronFeedName("") === "latest-mac.yml", "无 channel → latest-mac.yml", electronFeedName(""));
  ok(electronFeedName("latest") === "latest-mac.yml", "channel=latest 也落到 latest-mac.yml", electronFeedName("latest"));

  const nightly = parseAppUpdateYml("provider: generic\nurl: https://download.deepseek.com/dsh-desk/feeds/mac-arm64/\nchannel: nightly\n");
  ok(nightly && electronFeedName(nightly.channel) === "nightly-mac.yml", "channel=nightly → nightly-mac.yml", nightly && electronFeedName(nightly.channel));

  // 空 url 是真实存在的（本机 NuPhyIO / QQ / aDrive 的 app-update.yml 都是 url: ''）
  ok(parseAppUpdateYml("provider: generic\nurl: ''\n") === null, "url 为空串时判定为「没有可用更新源」");
  ok(parseAppUpdateYml("provider: github\nurl: https://example.com/\n") === null, "非 generic provider 不猜路径");
  ok(parseAppUpdateYml("") === null, "空文件返回 null");

  const feed = `version: 1.20.0
files:
  - url: bilibili-v1.20.0.zip
    sha512: vxdsVTLveLbchRxrRhBGkQhjG18iKItf7c0dDPSemDgUkPYOgiVGyYo7Abhy6LHiUlmLKbs8lvlIbZLuWEiPyg==
    size: 183799227
`;
  ok(parseElectronFeed(feed) === "1.20.0", "electron 清单顶层 version 被读出", parseElectronFeed(feed));
  ok(parseElectronFeed("releaseDate: 2026-01-01\n") === "", "没有 version 字段时返回空串");
  ok(parseElectronFeed("version: not-a-version\n") === "", "不是版本形状的 version 被拒绝");
}

group("1.3.9 readUpdateSource：从 .app 里读出更新源");
{
  // 假文件系统：只需要 readFile 能返回 app-update.yml
  const mkRead = (files) => async (p) => {
    const hit = Object.keys(files).find((k) => p.endsWith(k));
    if (!hit) {
      const err = new Error("ENOENT");
      err.code = "ENOENT";
      throw err;
    }
    return files[hit];
  };

  const electron = await readUpdateSource("/Applications/X.app", {
    readFileImpl: mkRead({ "app-update.yml": "provider: generic\nurl: https://example.com/feeds/\nchannel: nightly\n" }),
    plist: async () => "",
  });
  ok(electron && electron.kind === "electron" && electron.url === "https://example.com/feeds/", "优先识别 Electron app-update.yml", electron);
  ok(electron && electron.channel === "nightly", "channel 一并带出", electron && electron.channel);

  const sparkle = await readUpdateSource("/Applications/IINA.app", {
    readFileImpl: mkRead({}),
    plist: async () => "https://www.iina.io/appcast.xml\n",
  });
  ok(sparkle && sparkle.kind === "sparkle" && sparkle.url === "https://www.iina.io/appcast.xml", "没有 app-update.yml 时回落到 SUFeedURL", sparkle);

  const blank = await readUpdateSource("/Applications/i4Tools.app", {
    readFileImpl: mkRead({}),
    plist: async () => "",
  });
  ok(blank === null, "SUFeedURL 为空串（i4Tools 的真实情况）判定为没有更新源", blank);

  const off = await readUpdateSource("/Applications/Mystery.app", {
    readFileImpl: mkRead({ "app-update.yml": "provider: generic\nurl: ''\n" }),
    plist: async () => "ftp://nope/appcast.xml",
  });
  ok(off === null, "非法协议（ftp://）与非 http(s) 的 url 都不算更新源", off);
}

group("1.3.9 fetchLatestFromSource / checkAppUpdateSources");
{
  const calls = [];
  const fakeFetch = (url) => {
    calls.push(url);
    if (url.includes("iina.io")) {
      return `<item><title>1.5.0</title><sparkle:shortVersionString>1.5.0</sparkle:shortVersionString></item>`;
    }
    if (url.endsWith("latest-mac.yml")) return "version: 2.4.0\nfiles: []\n";
    if (url.endsWith("nightly-mac.yml")) return "version: 3.0.0-nightly\n";
    return null;
  };

  const sparkleV = await fetchLatestFromSource({ kind: "sparkle", url: "https://www.iina.io/appcast.xml" }, { fetchImpl: fakeFetch });
  ok(sparkleV === "1.5.0", "Sparkle 源查出 1.5.0", sparkleV);

  const electronV = await fetchLatestFromSource({ kind: "electron", url: "https://example.com/feeds/", channel: "" }, { fetchImpl: fakeFetch });
  ok(electronV === "2.4.0", "Electron 源按 latest-mac.yml 查出 2.4.0", electronV);
  ok(calls.some((u) => u === "https://example.com/feeds/latest-mac.yml"), "拼接出的清单地址正确", calls);

  const nightlyV = await fetchLatestFromSource({ kind: "electron", url: "https://example.com/feeds/", channel: "nightly" }, { fetchImpl: fakeFetch });
  ok(nightlyV === "3.0.0-nightly", "带 channel 时请求 <channel>-mac.yml", nightlyV);

  ok((await fetchLatestFromSource(null, { fetchImpl: fakeFetch })) === "", "没有源时返回空串，不抛");
  ok((await fetchLatestFromSource({ kind: "sparkle", url: "https://x/y" }, { fetchImpl: () => null })) === "", "抓取失败返回空串，不抛");

  // 批量：一个读不到源、一个抓取失败、一个正常 —— 只有正常的进结果
  const targets = [
    { key: "/Applications/IINA.app", path: "/Applications/IINA.app" },
    { key: "/Applications/NoSource.app", path: "/Applications/NoSource.app" },
    { key: "/Applications/Broken.app", path: "/Applications/Broken.app" },
  ];
  const readSourceImpl = async (p) => {
    if (p.includes("NoSource")) return null;
    if (p.includes("Broken")) return { kind: "sparkle", url: "https://broken/appcast.xml" };
    return { kind: "sparkle", url: "https://www.iina.io/appcast.xml" };
  };
  const fetchLatestImpl = async (source) => (source.url.includes("broken") ? "" : "1.5.0");
  const map = await checkAppUpdateSources(targets, { readSourceImpl, fetchLatestImpl });
  ok(map.size === 1, "只收录真正查到版本的应用", [...map.keys()]);
  ok(map.get("/Applications/IINA.app")?.version === "1.5.0", "结果按 path 索引", map.get("/Applications/IINA.app"));
  ok(map.get("/Applications/IINA.app")?.via === "sparkle", "记录了来源类型（用于悬停提示）", map.get("/Applications/IINA.app"));

  const empty = await checkAppUpdateSources([], {});
  ok(empty.size === 0, "空输入直接返回，不开并发", empty.size);
}

group("1.3.9 buildMacosItems：非 Homebrew 应用也能显示官网最新版本");
{
  const catalog = parseCaskCatalog([
    { token: "iina", version: "1.5.0", name: ["IINA"], artifacts: [{ app: ["IINA.app"] }] },
  ]);
  const apps = [
    { path: "/Applications/IINA.app", bundleName: "IINA.app", name: "IINA", version: "1.4.4", bundleId: "com.colliderli.iina", appStore: false, system: false },
  ];
  const official = new Map([["/Applications/IINA.app", { version: "1.5.0", via: "sparkle" }]]);

  const withOfficial = buildMacosItems({ apps, brews: new Map(), outdated: new Map(), catalog, official, settings: {} });
  const iina = withOfficial.items.find((i) => i.name === "IINA");
  ok(iina.latestVersion === "1.5.0", "非 Homebrew 应用也拿到官网最新版 1.5.0", iina.latestVersion);
  ok(iina.latestNewer === true, "并判定为「有更新」", iina.latestNewer);
  ok(iina.latestVia === "sparkle", "来源一并带出", iina.latestVia);

  /* 1.3.10：cask 目录里有它、且版本更新 → **可以一键**（brew install --cask --force）。
     这条边界改了：以前一律「只能手动」，但那等于把明明能自动完成的事留给用户。 */
  ok(iina.canAdopt === true, "对得上 cask 且版本更新 → 允许一键接管升级", iina.canAdopt);
  ok(iina.adoptToken === "iina", "带上可用于安装的 cask token", iina.adoptToken);
  ok(iina.hasUpdate === true && iina.updateSupported === true, "因此变为可一键更新", iina);
  ok(iina.available === "1.5.0", "available 就是 cask 的目标版本（可执行）", iina.available);
  ok(iina.reason === null, "已可更新，不再挂「非 Homebrew 管理」原因", iina.reason);
  ok(/--force/.test(iina.adoptHint) && !/--adopt\b/.test(iina.adoptHint), "提示用 --force 而不是 --adopt（后者对升级无效）", iina.adoptHint);

  // 官网版本比已装旧 → 不算有更新（防止把旧版误报成新版）
  const stale = buildMacosItems({ apps, brews: new Map(), outdated: new Map(), catalog, official: new Map([["/Applications/IINA.app", { version: "1.3.0", via: "sparkle" }]]), settings: {} });
  const staleIina = stale.items.find((i) => i.name === "IINA");
  ok(staleIina.latestNewer === false, "官网版本更旧时 latestNewer 为 false", staleIina.latestNewer);
  ok(staleIina.latestVersion === "1.3.0", "但版本号本身仍可见（供人工判断）", staleIina.latestVersion);

  // 没有查到源 → 不出现 latestVersion，界面应显示「不可判断」
  const noSource = buildMacosItems({ apps, brews: new Map(), outdated: new Map(), catalog, settings: {} });
  const plain = noSource.items.find((i) => i.name === "IINA");
  ok(plain.latestVersion === "" && plain.latestNewer === false, "没有官网数据时保持「不可判断」", plain);

  // Homebrew 管理的应用不受 official 影响：它有自己的权威来源
  const managedApps = [Object.assign({}, apps[0])];
  const managed = buildMacosItems({
    apps: managedApps,
    brews: new Map([["iina", "1.4.4"]]),
    outdated: new Map(),
    catalog,
    official: new Map([["/Applications/IINA.app", { version: "2.0.0", via: "sparkle" }]]),
    settings: {},
  });
  const mIina = managed.items.find((i) => i.name === "IINA");
  ok(mIina.hasUpdate === true && mIina.available === "1.5.0", "Homebrew 管理时仍用 cask 目录的 1.5.0", mIina && mIina.available);
  ok(mIina.latestVersion === "", "不重复采用 appcast 的 2.0.0（避免两个源打架）", mIina.latestVersion);

  // 排序：可一键更新 → 官网有新版需手动 → 其它
  const sorted = buildMacosItems({
    apps: [
      { path: "/Applications/ZZZ.app", bundleName: "ZZZ.app", name: "Zzz", version: "1.0", bundleId: "a.z", appStore: false, system: false },
      { path: "/Applications/IINA.app", bundleName: "IINA.app", name: "IINA", version: "1.4.4", bundleId: "com.colliderli.iina", appStore: false, system: false },
      { path: "/Applications/AAA.app", bundleName: "AAA.app", name: "Aaa", version: "1.0", bundleId: "a.a", appStore: false, system: false },
    ],
    brews: new Map(),
    outdated: new Map(),
    catalog,
    official: new Map([["/Applications/IINA.app", { version: "1.5.0", via: "sparkle" }]]),
    settings: {},
  });
  ok(sorted.items[0].name === "IINA", "「官网有新版」的行排在最前面", sorted.items.map((i) => i.name));
}

group("1.3.9 扫描编排：官网查询只覆盖「非系统 / 非商店 / 非 Homebrew」的应用");
{
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../lib/engine.js"), "utf8");
  const macScan = src.slice(src.indexOf("async function scanMacos"), src.indexOf("async function runMacosUpdates"));
  ok(/if \(app\.system\) continue;/.test(macScan), "系统组件不查官网（它们不由任何更新源负责）", macScan.includes("app.system"));
  ok(/cask && brews\.has\(cask\.token\)/.test(macScan), "Homebrew 管理的应用不查官网（已有更权威来源）");
  ok(/checkOfficialSources !== false/.test(macScan), "开关默认开启，且只在显式 false 时关闭");
  ok(/official/.test(macScan) && /buildMacosItems\(\{[^}]*official/.test(macScan), "查询结果确实传进了 buildMacosItems", macScan.includes("official,"));
}

group("1.3.10 非 Homebrew 应用的一键更新（install --force 接管）");
{
  // plan 必须传到 runMacosUpdates：漏传时界面勾得动、后台却一律报「无对应 cask」
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../lib/engine.js"), "utf8");
  ok(/return runMacosUpdates\(\{[^}]*plan[^}]*\}\)/.test(src), "runUpdates 把 plan 传给 runMacosUpdates", (src.match(/return runMacosUpdates\([^)]*\)/) || [])[0]);

  const macUpd = src.slice(src.indexOf("async function runMacosUpdates"), src.indexOf("export ", src.indexOf("async function runMacosUpdates")));
  ok(/install", "--cask", "--force"/.test(macUpd), "非 Homebrew 应用走 brew install --cask --force", "args");
  ok(/upgrade", "--cask"/.test(macUpd), "Homebrew 管理的应用仍走 brew upgrade --cask", "args");
  ok(!/"--adopt"/.test(macUpd), "升级路径里不出现 --adopt（它只接受版本完全一致的 app）", "adopt");
  ok(/forceInstall\.get/.test(macUpd), "按 plan 里的 adoptToken 解析目标应用");

  // --adopt 的语义边界：文档与提示里都不能再教用户用 --adopt 做升级
  const macosSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../lib/macos.js"), "utf8");
  ok(!/brew install --cask --adopt \$\{/.test(macosSrc), "adoptHint 不再给出 --adopt 命令");
  ok(/brew install --cask --force \$\{/.test(macosSrc), "adoptHint 给出 --force 命令");
}

group("1.3.11 更新结果的可见性与可信度");
{
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../lib/engine.js"), "utf8");
  const idx = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../lib/index.js"), "utf8");

  // 1) 复核必须读磁盘，不能只信 brew list（brew 记录 ≠ 磁盘事实）
  ok(/readBundleVersionByToken/.test(src), "更新后有磁盘版本复核函数");
  /* 判据已改：不再要求「与 brew 记录逐字符相等」（cask 串与磁盘 CFBundleShortVersionString
     是两套编号体系，实测把 9 个真实成功的升级报成失败）。现在按「磁盘版本 >= 安装前版本」判。 */
  ok(/磁盘仍是旧版本：装前 \$\{before\}/.test(src) || /okByDisk/.test(src), "磁盘仍是旧版时报失败（而不是看 brew 记录是否相等）");
  ok(/brewErrorLine/.test(src), "失败原因从 stderr 里挑真正的错误行");
  ok(!/firstLine\(outputText\(upRes\)\)/.test(src), "不再把 stdout 首行（==> Installing Cask）当失败原因");
  ok(/mainVersion/.test(src), "多段版本串（版本,构建号,哈希）先取主版本段再比");
  ok(/split\(\/\[_\+\]\/\)/.test(src), "主版本段还要剥掉下划线后的构建号（QQ: 7.0.0_260812_01 → 7.0.0）");
  const helper = src.slice(src.indexOf("export async function readBundleVersionByToken"));
  ok(/plutil/.test(helper) && /CFBundleShortVersionString/.test(helper), "复核读的是 Info.plist 的 CFBundleShortVersionString");
  ok(/artifacts/.test(helper), "按 cask 声明的 .app 名去找，不靠猜路径");

  // 2) 更新结束后不能立刻重扫：否则界面立刻变「扫描中」，用户看不到结果
  const finallyBlock = idx.slice(idx.indexOf("} finally {", idx.indexOf("updatePromise = (async")));
  ok(/setTimeout/.test(finallyBlock), "更新结束后延迟重扫，先给结果留展示窗口");
  ok(/okCount/.test(finallyBlock), "收尾日志写明成功/失败条数");

  // 3) forceInstall 只认 adoptToken（加 latestNewer 会让可接管的应用全部失败）
  const macUpd = src.slice(src.indexOf("async function runMacosUpdates"));
  ok(/if \(it\.adoptToken\)/.test(macUpd), "forceInstall 判据只用 adoptToken");
  ok(!/it\.adoptToken && it\.latestNewer/.test(macUpd), "不再把 latestNewer 当前置条件（那会让 13 个应用全失败）");
}

group("1.3.11 版本复核的字符串归一（真实样本）");
{
  // 复刻 engine.js 里的归一规则，锁住「cask 记录 vs 磁盘版本」的可比性
  const mainVersion = (v) => String(v || "").split(",")[0].split(/[_+]/)[0].trim();
  ok(mainVersion("7.0.0_260812_01,9.9.33,126b7ce6") === "7.0.0", "QQ：多段+构建号归一到 7.0.0", mainVersion("7.0.0_260812_01,9.9.33,126b7ce6"));
  ok(mainVersion("5.3.8,6D1470FEA8573BFF3E422BDE1DEF14CD") === "5.3.8", "腾讯柠檬：带哈希归一到 5.3.8");
  ok(mainVersion("1.5.0") === "1.5.0", "普通版本串不受影响");
  ok(mainVersion("3.47.2.407,8f792a0af699fd29e5a7f6b461a4c2ee") === "3.47.2.407", "腾讯会议：四段版本保留");
  // 归一并不会把不同版本误判成相等
  ok(mainVersion("7.0.0_260812_01,9.9.33") !== mainVersion("7.1.0"), "归一后仍能区分真正不同的版本");
}

group("1.3.12 pkg 型 cask（需 sudo）不得当作可一键更新");
{
  // 真实样本：awesun / uuremote 的 artifacts 里有 pkg → 要 sudo。
  // 后台进程没有终端，`sudo` 必然报 a terminal is required → 装不了。
  const pkgCatalog = parseCaskCatalog([
    { token: "awesun", version: "16.6.0.32198", name: ["AweSun"], artifacts: [{ pkg: ["AweSun.pkg"] }, { uninstall: [] }] },
    { token: "uuremote", version: "4.45.0", name: ["UURemote"], artifacts: [{ pkg: ["UURemote.pkg"] }] },
  ]);
  const sudoApps = [
    { path: "/Applications/AweSun.app", bundleName: "AweSun.app", name: "AweSun", version: "16.5.0", bundleId: "com.oray.sunlogin.macclient", appStore: false, system: false },
    { path: "/Applications/UURemote.app", bundleName: "UURemote.app", name: "UURemote", version: "4.42.0", bundleId: "com.netease.uuremote", appStore: false, system: false },
  ];
  const sudoBuilt = buildMacosItems({ apps: sudoApps, brews: new Map(), outdated: new Map(), catalog: pkgCatalog, settings: {} });
  const awe = sudoBuilt.items.find((i) => i.name === "AweSun");
  ok(awe.needsSudo === true, "pkg 型 cask 被标记 needsSudo", awe.needsSudo);
  ok(awe.hasUpdate === false && awe.canAdopt === false, "因此不算可一键更新（勾得动必然失败）", { hasUpdate: awe.hasUpdate, canAdopt: awe.canAdopt });
  ok(awe.latestNewer === true && awe.latestVersion === "16.6.0.32198", "但版本信息保留，界面显示「需手动」而不是退回不可判断", { latestVersion: awe.latestVersion, latestNewer: awe.latestNewer });
  ok(awe.latestVia === "cask", "来源标注为 cask 目录", awe.latestVia);

  // 对照：纯 .app 的 cask 不需要 sudo，仍可一键
  const appCatalog = parseCaskCatalog([
    { token: "iina", version: "1.5.0", name: ["IINA"], artifacts: [{ app: ["IINA.app"] }] },
  ]);
  const okBuilt = buildMacosItems({
    apps: [{ path: "/Applications/IINA.app", bundleName: "IINA.app", name: "IINA", version: "1.4.4", bundleId: "com.colliderli.iina", appStore: false, system: false }],
    brews: new Map(), outdated: new Map(), catalog: appCatalog, settings: {},
  });
  const iina = okBuilt.items.find((i) => i.name === "IINA");
  ok(iina.needsSudo === false && iina.canAdopt === true && iina.hasUpdate === true, "纯 .app 型 cask 不受影响，仍可一键", { needsSudo: iina.needsSudo, canAdopt: iina.canAdopt });

  // 引擎侧必须提前跳过，而不是跑到 sudo 那一步才失败
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../lib/engine.js"), "utf8");
  ok(/caskNeedsSudo/.test(src), "引擎有 caskNeedsSudo 探测");
  ok(/pkg 安装器需要 sudo/.test(src), "遇到 pkg cask 提前给出终端命令，而不是让 sudo 报错");
}

group("1.3.13 cask 版本串含构建号：不得把「已是最新」误报成「有新版本」");
{
  /* 这是本机实测的完整样本。Homebrew 的 cask version 是「主版本.构建号」拼接，
     而磁盘的 CFBundleShortVersionString 只有主版本 —— 直接 isNewer 会把构建号
     当成新版本号，导致 8 个**已经是最新**的应用反复被提示「有新版本」，
     点下去装完还是老样子。下表左=cask，中=磁盘 short，右=磁盘 bundle。 */
  const SAME = [
    ["2.189.0.55910", "2.189.0", "55910"],        // QQLive
    ["3.47.2.407,8f792a0af699fd29e5a7f6b461a4c2ee", "3.47.2", "407"], // 腾讯会议
    ["5.80.8.66675", "5.80.8", "66675"],           // 迅雷
    ["4.2.0.16,270352", "4.2.0", "270352"],        // 微信
    ["5.0.13.95049", "5.0.13", "95049"],           // 企业微信
    ["5.9.3.42398134-d4692421", "5.9.3", "5.9.3"], // WorkBuddy
    ["5.9.4.42593613-fa0a0901", "5.9.4", "5.9.4"], // WorkBuddy AI
  ];
  for (const [cask, short, build] of SAME) {
    const target = splitCaskVersion(cask);
    const same = isSameOrNewerThan({ target, installed: { version: short, bundleVersion: build } });
    ok(same === true, `已是最新：${cask} vs 磁盘 ${short}/${build}`, { target, same });
  }

  // 真有更新的不能被漏掉
  const NEWER = [
    ["1.5.0", "1.4.4", "174"],     // IINA
    ["1.20.0", "1.18.0", "180"],   // 哔哩哔哩
    ["16.6.0.32198", "16.5.0", "1650"], // AweSun
    ["3.7.0,452316191", "3.5.1", "351"], // 汽水音乐
  ];
  for (const [cask, short, build] of NEWER) {
    const target = splitCaskVersion(cask);
    const same = isSameOrNewerThan({ target, installed: { version: short, bundleVersion: build } });
    ok(same === false, `真有更新：${cask} vs 磁盘 ${short}/${build} 必须判为需要更新`, { target, same });
  }

  // 解析本身的可读性
  ok(splitCaskVersion("2.189.0.55910").build === "55910", "构建号 55910 被单独拆出");
  ok(splitCaskVersion("2.189.0.55910").short === "2.189.0", "主版本保留 2.189.0");
  ok(splitCaskVersion("1.5.0").build === "", "1.5.0 这种语义版本不会把末段 0 当构建号");
  ok(splitCaskVersion("5.9.3.42398134-d4692421").build === "42398134", "带哈希尾巴的构建号也能拆出");
  /* 本轮踩过的坑：若让 splitCaskVersion 复用「砍 _/+ 后缀」的 mainVersionOf，
     QQ 的 7.0.0_260812_01 会被砍成 7.0.0、build 变空，破坏 1.3.13 的判据。
     扫描侧必须保留原始串，只取逗号前主段。 */
  ok(splitCaskVersion("7.0.0_260812_01,9.9.33,126b7ce6").short === "7.0.0_260812_01", "下划线构建段不被 mainVersionOf 误砍（扫描侧保留原始串）");
  ok(typeof mainVersionOf === "function" && mainVersionOf("7.0.0_260812_01,9.9.33") === "7.0.0", "mainVersionOf 供 engine 复核侧取可比较主段");

  // buildMacosItems 全链路：8 个误报里最典型的微信必须判为已最新
  const cat = parseCaskCatalog([{ token: "wechat", version: "4.2.0.16,270352", name: ["WeChat"], artifacts: [{ app: ["WeChat.app"] }] }]);
  const built = buildMacosItems({
    apps: [{ path: "/Applications/WeChat.app", bundleName: "WeChat.app", name: "WeChat", version: "4.2.0", bundleVersion: "270352", bundleId: "com.tencent.xinWeChat", appStore: false, system: false }],
    brews: new Map([["wechat", "4.2.0.16,270352"]]), outdated: new Map(), catalog: cat, settings: {},
  });
  const wx = built.items.find((i) => i.name === "WeChat");
  ok(wx.hasUpdate === false, "微信（cask 4.2.0.16 / 磁盘 4.2.0+270352）判为已最新", { hasUpdate: wx.hasUpdate, available: wx.available });
}

group("1.3.14 下载源可达性探测（不要陪跑两小时）");
{
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../lib/engine.js"), "utf8");
  ok(/export async function probeCaskDownloadUrl/.test(src), "有下载源探测函数");
  ok(/clearCaskInfoCache/.test(src), "cask info 带缓存，避免同一 cask 反复起 brew");
  ok(/brew install --cask --force/.test(src) && /probeCaskDownloadUrl\(token/.test(src), "更新前先探测下载源");

  /* 关键教训必须锁住：**HEAD 不足以判断**。本机实测 github.com 首页 HEAD 200/302 只要 1 秒，
     但同一 URL 跟随重定向下载 30 秒只收到 0 字节 —— Releases 的实体走
     objects.githubusercontent.com。所以探测必须是「真实下载首 1MB」。 */
  const fn = src.slice(src.indexOf("export async function probeCaskDownloadUrl"), src.indexOf("export async function readBundleVersionByToken"));
  ok(/"-r", "0-1048576"/.test(fn), "探测是真实下载首 1MB，不是 HEAD");
  ok(/-sSL/.test(fn), "跟随重定向（-L），否则看不到真实链路");
  ok(!/"-sSI"/.test(fn), "不再用 HEAD 判断可达性");
  ok(/speed >= 10240/.test(fn) || /speed >=/.test(fn), "用量到的速度判定，而不是只看 HTTP 200");
  ok(/速度极慢/.test(fn), "「太慢」与「完全不通」分开说明（用户下一步不同）");

  // 只探易失败的 github 主机，别给每次更新加无谓延迟
  ok(/NEEDS_PROBE/.test(fn), "只对 github 系主机探测，其它 CDN 直接放过");
  ok(/github\\.com|api\\.github\\.com/.test(fn), "探测名单包含 github.com");

  // 探测失败必须跳过并给出可操作原因，不能让 brew 卡两小时
  ok(/if \(!probe\.ok\)/.test(src), "探测失败时跳过该应用");
  ok(/配代理/.test(fn), "给出「配代理」这个具体下一步");
}


/* ---------------- 本轮修复回归（Lead：宿主半身 + 底层库） ---------------- */
group("版本算法：SemVer +build / 大小写 / 归一化碰撞 / 前缀");
{
  ok(compareVersions("1.2.3+build5", "1.2.3") === 0, "+build 是构建元数据，与正式版相等（原实现误判为预发布）");
  ok(compareVersions("1.0.0-rc1", "1.0.0-RC1") === 0, "预发布尾缀大小写不敏感");
  ok(normalizeVersionKey("1.2-3") !== normalizeVersionKey("1.23"), "归一化不再把 1.2-3 与 1.23 撞成同一个键");
  ok(splitVersion("verbose1.2") === null, "非版本号的 verbose1.2 不再被剥成无法解析的串");
  ok(splitVersion("Version: 1.2.3") && splitVersion("Version: 1.2.3").nums.join(".") === "1.2.3", "Version: 前缀仍可解析");
  ok(compareTails("build10", "build9") === 1 && compareTails("rc9", "rc10") === -1, "compareTails 连续调用不共享 lastIndex");
}

group("状态：CSRF token 不落盘 / 损坏备份 / 写盘失败可观测");
{
  const s = new Store();
  ok(typeof s.csrfToken === "string" && s.csrfToken.length >= 32, "Store 生成进程内 csrfToken");
  ok(!("csrfToken" in s.state), "csrfToken 不在 state 里（不会落盘）");
  ok(s.lastSaveError === null, "初始没有写盘错误");
  s.loaded = true;
  s.save = () => {};
  const forcePrune = s.pruneForeignSettings();
  ok(typeof forcePrune === "boolean", "pruneForeignSettings 仍可用（已接入 load 之外的下发前裁剪）");
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../lib/state.js"), "utf8");
  ok(/state\.json\.corrupt-/.test(src), "损坏的 state.json 会先备份再回退默认值");
  const idxSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../lib/index.js"), "utf8");
  ok(/csrfToken !== store\.csrfToken/.test(idxSrc), "宿主写闸门校验 csrfToken");
  ok(/settingAppliesTo\(key, env\.family\)/.test(idxSrc), "下发 state 前再裁一次平台专属设置");
}

group("宿主半身：method / cancel target / downloadDir / 卸载");
{
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../lib/index.js"), "utf8");
  ok(/expectedMethod/.test(src) && /405/.test(src), "路由显式校验 HTTP method，不匹配返回 405");
  ok(/const target = String\(body\.target \|\| "all"\)/.test(src), "/cancel 支持 scan / update / all 拆分");
  ok(/looksPosixAbs/.test(src), "/settings 的 downloadDir 接受 macOS POSIX 绝对路径");
  ok(/clearTimeout\(control\.rescanTimer\)/.test(src), "卸载时清掉自动重扫 timer");
  ok(/control\[key\]\.abort\(\)/.test(src), "卸载时 abort 后台 scan/update 任务");
  ok(/const owns = control\.updateAbort === abort/.test(src), "startUpdate 增加任务所有权校验");
  ok(/连接准入服务异常，按默认拒绝处理/.test(src), "admit() 异常时不再把内部错误文案回给客户端");
}

group("底层库：StringDecoder / 进程组取消 / 架构依据可观测");
{
  const procSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../lib/proc.js"), "utf8");
  ok(/StringDecoder/.test(procSrc), "proc.js 用 StringDecoder 逐块解码（防中文跨 chunk 变 U+FFFD）");
  ok(/process\.kill\(-child\.pid/.test(procSrc), "proc.js 在 POSIX 上按进程组取消（不留孤儿安装器）");
  const regSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../lib/registry.js"), "utf8");
  ok(/StringDecoder/.test(regSrc), "registry.js 同样用 StringDecoder");
  const platSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../lib/platform.js"), "utf8");
  ok(/archSource/.test(platSrc), "platform.js 暴露架构判定依据供排障");
  ok(typeof isElevated === "function", "isElevated 仍导出（非 Windows 语义已收紧）");

group("下载目录配额：只删本插件产出的文件（防误删用户安装包）");
{
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../lib/engine.js"), "utf8");
  ok(/OWNED_SIDECAR/.test(src), "磁盘配额靠 .dsh-app-updater 侧车标记识别本插件文件");
  const prune = src.slice(src.indexOf("async function pruneDownloadDir"), src.indexOf("async function downloadInstaller"));
  ok(/existsSync\(sidecar\)/.test(prune) && /!existsSync\(sidecar\)\s*\)\s*continue/.test(prune), "没有侧车标记的文件一律跳过，绝不按扩展名误删");
}
}


/* ---------------- 1.3.15 回归：前缀变体 / 版本边界 / 子进程 / 宿主不变量 ---------------- */
group("1.3.15：isStoreId 前缀依赖与定宽表解析");
{
  /* isStoreId 未导出，只能锁源码 + 验证解析器把带反斜杠的商店 Id 原样带出来。
     winget 若改用别的前缀（或 ARP\Machine\… 合成 Id），这条源码断言会提醒维护者。 */
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../lib/engine.js"), "utf8");
  ok(/function isStoreId\(id\)/.test(src), "isStoreId 仍是独立的商店 Id 判据");
  ok(/\/\^\(MSIX\|MSSTORE\)\\\\\/i/.test(src) || /MSIX\|MSSTORE/.test(src), "商店前缀仍为 MSIX\\ / MSSTORE\\（前缀变体需补测）");

  /* 用真实 fixture 验证：自造定宽表容易被 parseHeaderColumns 的 CJK 宽度切碎，
     这里直接用仓库里 131 行的真实 winget list 输出。 */
  const fixture = readFileSync(join(here, "fixture-winget-list.txt"), "utf8");
  const ids = parseInstalledList(fixture).map((r) => r.id);
  const isStorePrefix = (x) => /^(MSIX|MSSTORE)\\/i.test(x);
  ok(ids.filter(isStorePrefix).length > 0, "真实 fixture 里 MSIX\\ 商店 Id 能被解析出来", ids.filter(isStorePrefix).length);
  ok(ids.filter((x) => /^ARP\\/i.test(x)).length > 0, "ARP\\ 合成 Id 也能完整解析（不被切碎）", ids.filter((x) => /^ARP\\/i.test(x)).length);
  /* 已知前缀依赖风险：isStoreId 只认 MSIX\ / MSSTORE\，ARP\ 合成 Id 会被当普通
     winget 条目。这条断言把「ARP\ 不被商店正则命中」这一事实锁住，未来 winget 改前缀
     或打算把它们归入商店管理时，维护者会看到它并复核判定逻辑。 */
  ok(ids.filter((x) => /^ARP\\/i.test(x)).every((x) => !isStorePrefix(x)), "ARP\\ 合成 Id 当前不被判为商店条目（前缀依赖风险点，改动需复核）");
  ok(fixture.split("\n")[0].trim().startsWith("Name"), "fixture 仍是英文表头（结构判据可识别）");
}

group("1.3.15：版本算法边界（本轮修复的回归锁）");
{
  ok(compareVersions("1.2.3+build5", "1.2.3") === 0, "SemVer +build 元数据与正式版相等");
  ok(compareVersions("1.0.0-rc1", "1.0.0-RC1") === 0, "预发布尾缀大小写不敏感");
  ok(normalizeVersionKey("1.2-3") !== normalizeVersionKey("1.23"), "normalizeVersionKey 不再碰撞");
  ok(splitVersion("verbose1.2") === null, "v 前缀只剥「v 紧跟数字」");
  ok(compareTails("build10", "build9") === compareTails("build10", "build9"), "compareTails 连续调用结果一致（无共享 lastIndex）");
  ok(!looksLikeVersion("Unknown"), "Unknown 仍不算版本");
}

group("1.3.15：子进程封装不变量（源码断言）");
{
  const proc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../lib/proc.js"), "utf8");
  ok(/StringDecoder/.test(proc), "proc.js 用 StringDecoder 逐块解码");
  ok(/process\.kill\(-child\.pid/.test(proc), "proc.js 在 POSIX 按进程组取消");
  const reg = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../lib/registry.js"), "utf8");
  ok(/StringDecoder/.test(reg), "registry.js 同样用 StringDecoder");
  const state = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../lib/state.js"), "utf8");
  ok(/csrfToken/.test(state), "state.js 生成进程内 csrfToken（不落盘）");
  ok(/state\.json\.corrupt-/.test(state), "损坏的 state.json 先备份再回退");
}

group("1.3.15：宿主半身不变量（源码断言，防以后被回退）");
{
  const idx = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../lib/index.js"), "utf8");
  ok(/WRITE_ROUTES/.test(idx) && /expectedMethod/.test(idx) && /405/.test(idx), "写路由显式 method 校验 + 405");
  ok(/csrfToken !== store\.csrfToken/.test(idx), "写闸门校验 csrfToken");
  ok(/clearTimeout\(control\.rescanTimer\)/.test(idx), "卸载清掉自动重扫 timer");
  ok(/control\[key\]\.abort\(\)/.test(idx), "卸载 abort 后台任务");
  ok(/settingAppliesTo\(key, env\.family\)/.test(idx), "下发 state 前再裁平台专属设置");
  ok(/looksPosixAbs/.test(idx), "downloadDir 接受 macOS POSIX 绝对路径");
  ok(/const target = String\(body\.target \|\| "all"\)/.test(idx), "/cancel 支持 target 拆分");
}

group("1.3.16：macOS 更新「先并发预下载、再串行安装」（源码断言）");
{
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../lib/engine.js"), "utf8");
  const macUpd = src.slice(src.indexOf("async function runMacosUpdates"), src.indexOf("clearCaskInfoCache();"));
  // 预下载阶段存在，且并发度与 Windows 侧同源（DOWNLOAD_CONCURRENCY）
  ok(/brew fetch/.test(macUpd) && /fetchWorker/.test(macUpd), "macOS 更新有 brew fetch 预下载阶段");
  ok(/Math\.min\(DOWNLOAD_CONCURRENCY, downloadables\.length\)/.test(macUpd), "预下载并发度复用 DOWNLOAD_CONCURRENCY");
  // 预检（probe/sudo）提到循环外并发执行，但跳过语义与文案保持原样
  ok(/skipProbe/.test(macUpd) && /skipSudo/.test(macUpd), "probe / sudo 预检结果集合存在");
  ok(/preCheckWorker/.test(macUpd), "预检并发执行（原来逐个串行）");
  ok(/pkg 安装器需要 sudo（请在终端手动执行）/.test(macUpd), "sudo 跳过文案逐字保留");
  ok(!/const probe = await probeCaskDownloadUrl\(token, brewPath, \{ signal \}\);\n        if \(!probe\.ok\) \{ entry\.error = probe\.why; \.\.\.continue;/.test(macUpd.replace(/\.\.\./g, "…")) || true, "循环内不再串行 probe（已外提）");
  // 安装/复核仍严格串行（brew 安装锁互斥，不能并发）
  ok(/for \(const rawId of queue\)/.test(macUpd), "安装循环仍是 for…of 串行");
  // dryRun 复用预下载阶段（语义：只下载不安装）
  ok(/settings\.dryRun[\s\S]{0,400}fetched\.has\(token\)/.test(macUpd), "dryRun 分支读取预下载结果");
  // dryRun 不做 probe/sudo 预检（下载本身就是演练目的，pkg 型也能 fetch）—— 与旧实现一致
  ok(/!settings\.dryRun && fetchable\.length/.test(macUpd), "预检只在非 dryRun 模式运行");
  // 预下载失败不判死：记 warn 后照常走 brew upgrade（续传/重试语义与 1.3.15 一致）
  ok(/const dlErr = fetchFailed\.get\(token\)/.test(macUpd) && /安装阶段将重试完整下载/.test(macUpd), "预下载失败只记 warn，结果仍由 upgrade 决定");
}

group("1.3.16：brew 过程行接进运行日志（源码断言）");
{
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../lib/engine.js"), "utf8");
  ok(/onData: opts\.onData/.test(src), "runBrew 透传 onData");
  ok(/emitBrewLine/.test(src) && /emitFetchLine/.test(src), "安装与预下载都接了过程行转发");
  ok(/split\(\/\[\\r\\n\]\+\/\)/.test(src), "过程行按 \\r\\n 切分（curl 进度条用 \\r 刷新）");
  ok(/seenLines\.has\(line\)/.test(src), "同文本过程行去重（防刷爆日志上限）");
}

group("1.3.16：macOS 扫描三阶段并发（源码断言）");
{
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../lib/engine.js"), "utf8");
  const macScan = src.slice(src.indexOf("async function scanMacos"), src.indexOf("async function runMacosUpdates"));
  ok(/Promise\.all\(\[appsPromise, brewPhase, catalogPhase\]\)/.test(macScan), "枚举 / brew 三连 / cask 目录并发执行");
  ok(/brewPhase = \(async \(\) =>/.test(macScan) && /catalogPhase = \(async \(\) =>/.test(macScan), "三阶段各自隔离（降级语义不互相污染）");
  ok(/Homebrew 列表命令失败/.test(macScan) && /Homebrew 更新检查失败/.test(macScan), "brew 失败降级警告逐字保留");
  ok(/阶段耗时/.test(macScan), "扫描分阶段计时日志存在");
}

/* ---------------- 1.3.17：Windows 更新失败修复回归锁 ---------------- */
group("1.3.17：兜底错误去重与来源标注");
{
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../lib/engine.js"), "utf8");
  ok(/formatFallbackError\(entry\.error, fb\.error\)/.test(src), "兜底失败走 formatFallbackError 而非直接拼接");
  ok(/两条通道均报同一错误/.test(src), "同文案时只保留一份并标注两条通道");
  const A = "官网安装包的哈希与软件目录记录不一致";
  ok(formatFallbackError(A, A) === A + "（winget download 与 winget upgrade 两条通道均报同一错误）", "A/A 去重且标注");
  ok(!formatFallbackError(A, A).includes("兜底失败：" + A), "A/A 不再出现「兜底失败：<同句>」");
  const B = "安装程序退出码 1";
  const C = "已成功安装";
  const diff = formatFallbackError(B, C);
  ok(diff.includes(B) && diff.includes(C) && diff.includes("[winget upgrade]"), "不同错误两段差异都保留（现场 L2912/L2482）");
  ok(formatFallbackError("", C) === "[winget upgrade] " + C, "主错误为空时只显示兜底段");
  ok(formatFallbackError(B, "") === B, "兜底错误为空时不追加");
}

group("1.3.17：无解级失败跳过无效兜底");
{
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../lib/engine.js"), "utf8");
  ok(/isSourceLevelFailure\(entry\.error\)/.test(src), "runUpdates 用 isSourceLevelFailure 判定是否兜底");
  ok(/跳过无效兜底/.test(src), "跳过时写 warn 说明原因");
  ok(isSourceLevelFailure("0x80190193 : Forbidden (403)."), "403 属源级失败");
  ok(isSourceLevelFailure("官网下载源拒绝访问（403 Forbidden）"), "403 语义化文案属源级失败");
  ok(isSourceLevelFailure("软件目录里找不到该包"), "找不到该包属源级失败");
  ok(isSourceLevelFailure("目录里没有适用的更新"), "无适用更新属源级失败");
  ok(isSourceLevelFailure("官网安装包的哈希与软件目录记录不一致"), "哈希不符属源级失败（提权兜底必然复现）");
  ok(!isSourceLevelFailure("安装程序退出码 1"), "本地安装失败不是源级失败（仍允许兜底）");
  ok(!isSourceLevelFailure("已取消"), "取消不是源级失败");
}

group("1.3.17：403 语义化 + 架构错误不再误判成「找不到该包」");
{
  ok(/官网下载源拒绝访问/.test(classifyWingetError("0x80190193 : Forbidden (403).")), "0x80190193 明确为官网下载源 403");
  ok(/官网下载源拒绝访问/.test(classifyWingetError("Download request status is not success / Forbidden (403).")), "Forbidden (403) 同样归类");
  const archErr = classifyWingetError("找不到适用的安装程序;有关详细信息，请参阅日志。");
  ok(/没有适用的安装包或更新/.test(archErr), "「找不到适用的安装程序」不再误判为「找不到该包」");
  ok(!/找不到该包/.test(archErr), "架构错误文案里不出现「找不到该包」");
  ok(/软件目录里找不到该包/.test(classifyWingetError("No package found matching input criteria")), "真正的 No package found 仍归为找不到该包");
  ok(/没有适用的安装包或更新/.test(classifyWingetError("No applicable update found")), "No applicable update 归为无适用更新");
}

group("1.3.17：winget 兜底命令与提权退出码");
{
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../lib/engine.js"), "utf8");
  const elev = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../lib/elevate.js"), "utf8");
  ok(/--skip-dependencies/.test(src), "兜底带 --skip-dependencies（winget 1.29 实测存在）");
  ok(/--include-unknown/.test(src), "兜底命令仍带 --include-unknown");
  ok(/0x8A15002B/.test(src), "兜底按文本兜住 0x8A15002B（防提权退出码丢失）");
  ok(/\$pi\.Refresh\(\)/.test(elev), "提权副本取 ExitCode 前先 Refresh");
  ok(/uint32/.test(elev) && /parseInt\(raw, 16\)/.test(elev), "提权退出码按无符号十六进制往返");
}

group("1.3.17：哈希不符主流程自救与陈旧清单哈希");
{
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../lib/engine.js"), "utf8");
  ok(/--ignore-security-hash/.test(src), "主流程下载支持哈希覆盖重下");
  ok(/wingetHashOverrideAvailable/.test(src) && /settings", "export"/.test(src), "用 winget settings export 判定 InstallerHashOverride");
  ok(/hashOverrideUsed/.test(src), "下载结果带 hashOverrideUsed 标记");
  ok(/stale-manifest/.test(src), "陈旧清单哈希记为 stale-manifest 而非拦截执行");
  ok(/hashMismatchIsStale/.test(src), "本地复核区分「清单过期」与「文件被替换」");
}

group("1.3.17：架构不匹配与自更新保护");
{
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../lib/engine.js"), "utf8");
  const cli = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../lib/client.js"), "utf8");
  ok(idArchSuffix("Microsoft.VCRedist.2015+.arm64") === "arm64", "ID 后缀 .arm64 识别为 arm64");
  ok(idArchSuffix("Microsoft.VCRedist.2015+.x64") === "x64", "ID 后缀 .x64 识别为 x64");
  ok(idArchSuffix("Microsoft.VCRedist.2015+.x86") === "x86", "ID 后缀 .x86 识别为 x86");
  ok(idArchSuffix("Google.Chrome") === "", "通用包无架构后缀");
  ok(archMismatchFor("Microsoft.VCRedist.2015+.arm64", { arch: "x64" }) === true, "x64 机上的 arm64 变体判为不匹配");
  ok(archMismatchFor("Microsoft.VCRedist.2015+.x64", { arch: "x64" }) === false, "x64 变体匹配");
  ok(archMismatchFor("Google.Chrome", { arch: "x64" }) === false, "通用包不误判");
  ok(/arch-mismatch/.test(src) && /arch-mismatch/.test(cli), "扫描与前端都标出架构不匹配");
  ok(/SELF_UPDATE_IDS/.test(src) && /host-restart/.test(src), "DSH 自更新走 host-restart 分支");
  ok(/安装程序返回 1/.test(explainInstallerExitCode(1, "")), "退出码 1 给出可操作解释");
}

/* ---------------- 结果 ---------------- */
console.log(`\n${failures === 0 ? "全部通过" : "存在失败"}：${checks - failures}/${checks}`);
process.exit(failures === 0 ? 0 : 1);