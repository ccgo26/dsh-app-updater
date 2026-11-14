# dsh-app-updater 契约（宿主 ↔ 客户端）

插件 id：`dsh-app-updater`　显示名：应用更新（App Updater）

## 文件布局

```
dsh-app-updater/
├─ package.json          # main: ./lib/index.js, exports ./client, dsh.bundle.patch, dsh.client
├─ cordis.patch.yml      # insert 行：id=dsh-app-updater, name=dsh-app-updater
├─ lib/
│  ├─ index.js           # 宿主半身：cordis 插件，注册 /dsh-app-updater/* 路由
│  ├─ platform.js        # 运行环境识别：Windows / macOS、版本、CPU 架构、引擎选择
│  ├─ engine.js          # 扫描 / 下载 / 安装编排（Windows=winget / macOS=Homebrew）
│  ├─ winget.js          # winget 定位、调用、表格解析
│  ├─ registry.js        # 注册表 Uninstall 键枚举（覆盖 winget 未收录的应用）
│  ├─ version.js         # 版本比较（Windows 风格 1.2.3.4 + 字母后缀）
│  ├─ elevate.js         # Windows UAC 提权执行（临时文件 IPC + 进程树取消）
│  ├─ proc.js            # 子进程底座（UTF-8 / 超时 / AbortSignal / shell:false）
│  ├─ macos.js           # macOS 数据层：.app 枚举 / cask 目录竞速 / 列表组装
│  ├─ appcast.js         # 非 Homebrew 应用官网更新源（Sparkle / Electron，只读）
│  ├─ state.js           # 持久化状态（~/.dsh/dsh-app-updater/state.json）
│  └─ client.js          # 浏览器半身：设置页 UI
└─ README.md
```

## 运行环境与引擎

- `platform.js` 输出 `env`：`{ platform, family: windows|macos|other, osName, osVersion, osBuild, arch: arm64|x64|x86, archLabel, wingetArch, cpuModel, cpuCount }`。
- 引擎：Windows → `winget`；macOS → `homebrew`；其它 → `none`（扫描/更新接口返回 400）。
- 架构匹配：`settings.matchSystemArch !== false` 时，Windows 侧把 `env.wingetArch` 传给
  `winget download/upgrade --architecture`；清单缺该架构时自动退回自动匹配并写日志。
  macOS 侧由 Homebrew 决定 cask 架构。
- 提权（`lib/elevate.js`）：`settings.autoElevate !== false` 且当前进程没有管理员令牌时，
  安装类命令（安装包本体、`winget upgrade` 兜底）交给 `Start-Process -Verb RunAs` 的提权副本
  执行，退出码与输出写进临时文件后读回；`cancelled` 表示 UAC 被取消（1223）。
  读类命令（`winget list` / `upgrade --include-unknown` / `--version`）不提权。
- 复核：安装后必须用「安装前版本 / 安装后版本 / 目标版本」判断是否真的生效，退出码 0 不算成功
  （机器级安装包在未提权时会静默退出 0 却什么都没装）。`update.results[].installOk` 记录
  安装器自身是否报成功，`verified` 记录复核时读到的版本。
- 自带更新服务：Edge 的 winget 目录条目是企业版 MSI，与本机消费版安装技术不匹配
  （`0x8A15008E`），改走 `MicrosoftEdgeUpdate.exe /ua`，再由复核轮询确认版本就位。

## 宿主 HTTP 路由

全部 `kind: "exact"`，前缀 `/dsh-app-updater/`。每个请求先过 **connection 准入**：
`ctx.connection.admit(req)`（DSH 的 Host/Origin 信任校验 + 浏览器会话 / API 认证，
宿主自己的 `/api` 路由用的同一套），被拒即返回 `401`（未认证）/ `403`（不可信来源）/
`409`（连接被占用），响应头带 `X-DSH-Admission: denied`；写操作再要求 `confirm: true`。

**默认拒绝**（1.3.1 起）：宿主没有 `connection` 服务时不再「仅凭回环地址放行」，而是 `403`。
只有用户显式开启兼容模式（插件配置 `allowLegacyLoopback: true` 或环境变量
`DSH_APP_UPDATER_ALLOW_LEGACY_LOOPBACK=1`）时，回环请求才放行，并带
`X-DSH-Admission: loopback-legacy-optin` 与 `X-DSH-Admission-Warning`（见 `lib/index.js` 的
`admissionGate` / `resolveLegacyLoopbackOptIn`）。

### GET /dsh-app-updater/state.json

```jsonc
{
  "ok": true,
  "platform": "win32",
  "env": { "platform": "win32", "family": "windows", "osName": "Windows 11", "osVersion": "10.0.26300", "osBuild": "26300", "arch": "x64", "archLabel": "x64（AMD64）", "wingetArch": "x64", "cpuModel": "13th Gen Intel(R) Core(TM) i7-13700K", "cpuCount": 24 },
  "envSummary": "Windows 11（build 26300） · x64（AMD64）",
  "engine": { "id": "winget", "available": true, "version": "1.29.380" },
  "capabilities": { "scan": true, "update": true, "checkVersions": true, "storeAppsIncluded": true, "note": "" },
  "winget": { "available": true, "version": "v1.29.380", "path": "C:\\...\\winget.exe" },
  "phase": "idle",                 // idle | scanning | updating
  "scan": { "running": false, "startedAt": 0, "finishedAt": 0, "error": null },
  "update": { "running": false, "total": 0, "done": 0, "current": null, "error": null },
  "apps": { "scannedAt": 0, "stats": { "total": 0, "upgradable": 0, "unsupported": 0 }, "items": [], "engine": "winget" },
  "log": [ { "at": 0, "level": "info|warn|error|success", "text": "..." } ],
  "settings": { "includeStoreApps": true, "includeRegistryOnly": true, "includeUnmanagedApps": true, "checkOfficialSources": true, "downloadDir": "", "keepInstallers": true, "useWingetDownload": true, "hashFallbackUpgrade": true, "dryRun": false, "matchSystemArch": true, "autoElevate": true, "useSelfUpdater": true },
  // 写接口必须带回的 CSRF token（进程内生成、不落盘）；saveError 为最近一次写盘失败原因
  "csrfToken": "<hex>", "saveError": null,
  // 准入现状，供界面与复核确认当前走哪条路径（默认 "deny" 不会出现在能读到响应的地方）
  "admission": { "mode": "connection|connection+loopback-legacy|loopback-legacy-optin|deny", "service": true, "allowLegacyLoopback": false, "warning": null },
  // 1.4.0 起：底部版本信息区数据源（只读）。version 来自 package.json，
  // updatedAt 来自 CHANGELOG.md 顶部日期，浏览器不直接 require
  "pluginInfo": { "version": "1.4.1", "updatedAt": "2026-11-13", "packageName": "dsh-app-updater" },
  // 1.4.1：被记下「官网下载源 403」的应用个数（只下发计数，不暴露内部记录表）
  "sourceFailureCount": 0
}
```

`apps.items[]`（单条应用）：

```jsonc
{
  "id": "Google.Chrome",            // winget id；注册表项 "reg:<key>"；macOS 由 Homebrew 管理的是 "brew:<cask token>"，其余 "macapp:<bundle id>"
  "name": "Google Chrome",
  "version": "155.0.8059.85",       // 已安装版本，未知时 ""
  "available": "156.0.8078.48",     // 可升级到的版本，无更新时 ""
  "publisher": "Google LLC",
  "source": "winget",               // winget | msstore | registry | homebrew | appstore | app
  "installLocation": "C:\\Program Files\\Google\\Chrome\\Application",
  "hasUpdate": true,
  "updateSupported": true,          // 本插件能否驱动更新
  "reason": null,                   // null | "not-in-catalog" | "not-managed" | "unknown-version" | "pinned" | "store-managed" | "system-component" | "arch-mismatch" | "app-missing" | "source-unavailable"(1.4.1)
  // 1.4.1：reason="source-unavailable" 的行额外带（上次更新时官网下载源返回 403）：
  "latestNewer": true,             // 让它落进「需手动」分段并被「未收录」排除
  "latestVersion": "4.47.0.5146",
  "latestVia": "source-failure",
  "adoptHint": "发布方下载源返回 403……请等待发布方修复，或到官网手动下载新版安装",
  "sourceFailedAt": 1794563752223
  "kind": "exe",                    // exe | msi | msix | inno | cask | app | null（未知）
  // 1.3.18 起，仅 `reason: "app-missing"` 的行额外带：
  "missingPaths": ["/Applications/Thunder.app"],  // 磁盘上找不到、但 cask 声明过的 .app 路径
  "cleanedResidual": true          // 可选：本次扫描是否已自动清掉 Homebrew 残留记账
}
```

`reason` 里的 `not-managed` 是 macOS 专用：应用在标准目录里枚举到了，但不是由 Homebrew 管理
（拖 DMG / 手动安装），所以能列出、不能一键更新。`source` 的 `app` / `appstore` 同理只出现在
macOS。macOS 的扫描范围是 `/Applications`、`/Applications/Utilities`、`/System/Applications`
（及其 `Utilities`）与 `~/Applications`；装在别处的应用不在范围内。

`reason: "app-missing"`（1.3.18）：Homebrew 仍记着这个 cask，但 cask 声明的 `.app` 在磁盘上
已全部不存在（用户删掉 / 移走了应用）。`brew upgrade` 会在卸载旧版阶段报
`It seems the App source '...' is not there.` 并失败，因此这类行**不再**标为可更新
（`hasUpdate=false`、`updateSupported=false`、`available=""`），扫描时另尝试用
`brew uninstall --cask <token>` 自动清理残留记账（尽力而为，失败不影响扫描结果）。
字体 / 命令行等没有 `.app` artifact 的 cask 不受此判定影响。

### POST /dsh-app-updater/scan

body `{ "confirm": true, "force": true }` → `{ "ok": true, "started": true }`（异步；结果看 state.json / apps.json）

### GET /dsh-app-updater/apps.json

`{ "ok": true, "scannedAt": 0, "stats": {...}, "items": [App...], "warnings": ["..."] }`

### GET /dsh-app-updater/check-update（1.4.0，只读）

检查**插件自身**在 npm 上是否有新版本。宿主请求
`https://registry.npmjs.org/dsh-app-updater/latest`（Node 内置 `fetch` + 12s 超时），
取 `version` 后用 `lib/version.js` 的 `isNewer()` 与 `package.json` 的 `version` 比对。

```jsonc
// 成功
{ "ok": true, "currentVersion": "1.4.0", "latestVersion": "1.5.0", "hasUpdate": true }
// 成功且无新版本
{ "ok": true, "currentVersion": "1.4.0", "latestVersion": "1.4.0", "hasUpdate": false }
// 失败（网络异常 / 非 2xx / 解析不出版本 / 本地版本读不到）
{ "ok": false, "error": "检查更新失败：..." }
```

失败一律 `ok:false`，**不谎报「已是最新」**；界面据此给失败提示并允许重试。

### POST /dsh-app-updater/self-update（1.4.0，写路由）

body `{ "confirm": true, "csrfToken": "<来自 state.json>", "target": "1.5.0" }`。
过与其它写接口相同的 `confirm` / `csrfToken` / `method=POST` 闸门。宿主二次裁决：
`target` 必须过 semver 白名单（挡命令注入）且严格新于当前版本，否则不执行安装。

- 有新版本且执行成功 → `{ "ok": true, "message": "已更新到 v...", "targetVersion": "1.5.0", ... }`
- `target` 不新于当前版本 → `{ "ok": true, "alreadyCurrent": true, "message": "当前已是最新版本，无需更新" }`
- 非法 `target` → `400 { "ok": false, "error": "目标版本号不合法" }`
- 找不到 `dsh` / 执行失败 / 超时 → `{ "ok": false, "error": "更新失败：..." }`（不卡死按钮）

执行的是 `dsh plugin --profile web add dsh-app-updater@<target>`（参数数组、不经 shell，
`lib/proc.js` 带 180s 超时与进程组取消）。`--profile web` 与 README 的安装命令一致。

### POST /dsh-app-updater/update

body `{ "confirm": true, "csrfToken": "<来自 state.json>", "ids": ["Google.Chrome", "..."] }`
（`mode` 为历史残留字段，宿主不读取；所有写接口一律额外要求 `csrfToken`，见「写操作闸门」。）
→ `{ "ok": true, "started": true, "queued": 3 }`
（macOS 与 Windows 同构的两段式：先并发预下载（macOS 用 `brew fetch --cask` 落
Homebrew 下载缓存、并发度 3；Windows 用 `winget download` 私有目录），再串行
逐条：校验哈希（Windows）→ 静默安装（需要管理员时自动提权）→ 复核版本。
安装仍严格串行（安装锁互斥）。Edge 由 `MicrosoftEdgeUpdate.exe /ua` 处理。
`settings.dryRun` 时只下载、不安装、不复核。）

1.4.1 起，任务收尾会把「官网下载源 403」失败按 id 记进 `state.json` 的
`sourceFailures`（宿主内部，最多 200 条）；下一次扫描读取它，把命中行标为
`reason="source-unavailable"` / 「需手动」（见 `apps.items[]`），不再进「可一键更新」。
该 id 后续更新成功即清除记录、自动恢复。`winget download` 对 403 不再重试。

`update.results[]`（每条一次更新）：

```jsonc
{
  "id": "Microsoft.Edge",
  "ok": false,              // 最终结论：复核不通过就是 false，哪怕安装器报成功
  "installOk": true,        // 安装器自身是否报成功（退出码 0 / winget 成功）
  "error": "安装报告成功，但没有生效：版本没有变化（仍为 156.0.4314.50，目标 156.0.4314.58）",
  "installer": "C:\\...\\Microsoft Edge_156.0.4314.58_Machine_X64_msi_en-US.msi",
  "manifest": "C:\\...\\Microsoft Edge_156.0.4314.58_Machine_X64_msi_en-US.yaml",
  "verified": "156.0.4314.50",   // 复核时读到的已装版本
  "selfUpdater": "edgeupdate",  // 走自带更新服务时存在
  "note": "已交给 Microsoft Edge 更新服务，等待版本就位",
  "durationMs": 33288
}
```

### POST /dsh-app-updater/cancel

body `{ "confirm": true, "csrfToken": "<...>", "target": "scan|update|all" }`（`target` 默认 `"all"`，兼容旧行为）
→ `{ "ok": true, "cancelled": true, "target": "all" }`

> 旧文档写「提权副本是独立进程，取消只会停掉启动器，已经开始的安装会自己跑完」——
> 这是 1.3.5 之前的行为。当前 `lib/elevate.js` 用 `cancel.flag` + 助手脚本 `taskkill /T /F`
> **杀掉整棵提权进程树**；`lib/proc.js` 在 POSIX 上按进程组 kill。取消仍只能停掉「尚未完成」
> 的那一次，已经提交给安装器的动作无法回滚。

### POST /dsh-app-updater/settings

body `{ "confirm": true, "csrfToken": "<...>", "settings": { ... } }` → `{ "ok": true, "settings": {...} }`
（`downloadDir` 接受 Windows 盘符 / UNC **或 macOS 以 `/` 开头的 POSIX 绝对路径**。）

### POST /dsh-app-updater/open-downloads

→ `{ "ok": true, "path": "..." }`（在资源管理器中打开下载目录）

## 客户端要求

- `window.__ModuleLoader__.load({ id: "dsh-app-updater", factory: (require) => { ... } })`
- `exports.inject = ["slots", "locale"]`
- 注册 `settings.section`：`{ name: "settings.section", id: "dsh-app-updater", order: 42, label: () => "应用更新" }`
- 只用 `require("react")`；不引入其它运行时依赖
- 页面：顶部工具条（刷新检测 / 全部更新 / 取消 / 打开下载目录）+ 统计条 + 可筛选可多选的表格 + 更新结果面板 + 底部日志 + **最下方版本信息区（1.4.0）**
- 版本信息区：显示 `pluginInfo.version` 与 `pluginInfo.updatedAt`；单按钮状态机
  `检查更新 → 检查中… → 立即更新 / 已是最新 / 重试 → 更新中… → 检查更新`。
  `hasUpdate` 只在「检查成功且远端版本严格更旧」时为真，是「立即更新」出现的唯一条件；
  进行中禁用按钮并阻止重复请求；失败给提示并允许重试；更新完成 / 重新检查无新版后清回初值。
- 表格列：勾选 / 应用名 / 已装版本 / 可升级到 / 状态 / 操作（「来源」是状态单元格里的徽章，不是独立列）
- 所有请求带 `cache: "no-store"`；轮询 state.json（扫描/更新中 **900ms**，空闲 **5000ms**）
  （旧文档写 800ms/4s，与 `lib/client.js:20-21` 不符）
- **写操作闸门**：宿主对写路由显式校验 `method === "POST"`（否则 405），并在 `confirm:true`
  之外要求 `csrfToken`（由 `GET /state.json` 下发、不落盘，兼容模式下尤其重要）
- 结果面板渲染 `installOk` / `verified` / `hash` / `durationMs` / `selfUpdater` / `dryRun` /
  `unverifiable`；`unverifiable`（读不到已装版本）单列为「已安装·未复核」状态
