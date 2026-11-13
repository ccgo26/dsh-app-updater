# dsh-app-updater — 应用更新（DSH 插件）

检测本机**所有已安装应用**是否有新版本，并从各自**官网下载完整安装包**一键静默更新。
检测过程**不需要打开被检测的软件**。
自动识别 **Windows / macOS** 与 **ARM64 / x64（Intel）** 架构，按当前系统与芯片挑选对应的安装包。

入口：DeepSeek Harness → 设置 → **应用更新**

## 安装

```bash
# npm 包（推荐，插件中心同样可一键安装）
dsh plugin --profile web add dsh-app-updater
```

> 刚发布的新版本可能被 pnpm 的 `minimumReleaseAge` 策略暂缓一段时间；想立刻装到指定版本就显式写版本号：
> `dsh plugin --profile web add dsh-app-updater@1.2.0`（细节见 [RELEASING.md](RELEASING.md)）。

不想走 npm，也可以用源码或发行包：

```bash
# 源码仓库
dsh plugin --profile web add github:ccgo26/dsh-app-updater

# 预构建 tgz（见 Releases）
dsh plugin --profile web add https://github.com/ccgo26/dsh-app-updater/releases/latest/download/dsh-app-updater.tgz
```

装好后重启 DSH，在 **设置 → 应用更新** 使用。桌面端（Electron 托管的 `desktop` profile）不允许
`dsh plugin` 直接改写，需在 profile 的 `node_modules` 下建 junction 并手动补 `bundles`。

[![npm](https://img.shields.io/npm/v/dsh-app-updater?style=flat-square&label=npm&color=0891b2&logo=npm)](https://www.npmjs.com/package/dsh-app-updater)
![license](https://img.shields.io/badge/license-MIT-2f6f4f?style=flat-square)
![platform](https://img.shields.io/badge/platform-Windows-7da1de?style=flat-square)
![dsh-plugin](https://img.shields.io/badge/DSH-plugin-263146?style=flat-square)

**简体中文** · [English](README.en.md) · [更新日志](CHANGELOG.md) · MIT

---

## 它到底做了什么

| 步骤 | 实现 |
|---|---|
| ① 列出已装应用 | `winget list`（覆盖 winget 目录收录的软件 + 商店/MSIX 包）+ Windows 注册表三处 `Uninstall` 键（覆盖 winget 未收录的软件）。全程只读文件与注册表，不启动任何应用。 |
| ② 判断有没有新版本 | `winget upgrade --include-unknown`：由 winget 官方软件目录给出「已装版本 → 可升级版本」，并与 ①的清单按 Id 合并。 |
| ③ 一键更新 | `winget download` 把**发布方官网的完整安装包**下载到你指定的目录（下载时按清单核对 SHA-256），**执行前插件再本地复核一次哈希**（1.3.5 起：安装包紧跟着要以管理员身份执行，中途被替换或损坏必须拦住；不一致就不执行、改用兜底），解析随包落盘的 winget 清单得到发布方自己的静默参数，再执行静默安装；安装完成后用 `winget list --id` 复核版本号。 |
| ④ 失败兜底 | 若官网安装包被发布方重新签发导致哈希与目录记录不一致、或清单禁止直接下载，自动退回 `winget upgrade --id <id> --exact --silent`（同样是从官网拉取完整安装包，只是下载与安装过程交给 winget）。 |

**「从对应官网下载」是真的官网**：安装包地址来自 winget 清单里的 `InstallerUrl`，例如
- Git → `https://github.com/git-for-windows/git/releases/download/...`
- CPU-Z → `https://download.cpuid.com/cpu-z/...`
- 哔哩哔哩 → `https://dl.hdslb.com/...`
- Chrome → `https://dl.google.com/dl/chrome/install/...`

下载目录（默认 `%USERPROFILE%\Downloads\DSH App Updater`）里会同时留一份 `.yaml` 清单，
里面有发布方声明的 `InstallerUrl` / `InstallerSha256` / `InstallerSwitches.Silent`，可以自行核对来源。

---

## 使用

1. 打开 **设置 → 应用更新**。
2. 点 **刷新检测**（不会自动跑后台任务；只有你点了才扫）。
3. 列表默认按「有新版本优先」排序，可用搜索框和 **全部 / 仅可更新 / 未收录** 分段筛选。
4. 勾选要更新的应用（或点 **全部更新** 一次处理当前筛选下所有可更新项），点行尾 **更新** 也可单个更新。
5. 更新期间有进度条、当前应用名与逐条日志；**取消** 会停止尚未开始的项目。
6. **打开下载目录** 可以在资源管理器中查看已下载的官网安装包。
7. 同一页的 **插件设置** 面板里可以改下载目录、保留安装包、演练模式等开关（见「设置项」）。
8. 表格列宽默认给足以完整显示应用名；**拖动表头右侧的分隔条** 可以调整该列宽度（双击恢复默认），
   偏好记在浏览器本地，下次打开仍是你的宽度。

### 状态含义

| 状态 | 含义 |
|---|---|
| **有新版本** | 软件目录给出更高的版本号，可一键更新。 |
| **已是最新** | 目录里没有更高版本。 |
| **未收录** | 目录里找到了更新，但本插件无法驱动它更新（见下）。 |

| 原因 | 含义 |
|---|---|
| 软件目录未收录 | 该软件不在 winget 目录里（例如只在注册表登记的国产软件），无法判断/下载官网更新。 |
| 由应用商店管理 | MSIX / 商店应用，请用 Microsoft Store 更新。 |
| 版本未知 | 应用当前版本读不出来（winget 显示 `Unknown`），仍然允许尝试更新。 |
| 系统组件 | 系统组件/运行时，默认不建议由第三方驱动更新。 |

### 为什么可能是「0 个可更新」

插件**只对 Homebrew 管理的应用提供一键更新**：应用从 `/Applications` 等目录枚举出来，
再按 cask 目录反查「它是不是 brew 装的」——拖 DMG / 手动装的应用会如实列出并标
**非 Homebrew 管理**，不会被算成可更新。所以一台全是拖装应用的 Mac 上，「0 个可更新」是**正确结论**。

#### 1.3.10 起：能对上 cask 的非 Homebrew 应用**可以直接一键更新**

只要 cask 目录里有这个应用、且 cask 版本比已装的新，本插件会直接执行：

```bash
brew install --cask --force <token>
```

它会移除现有 `.app`、装上 cask 版本，之后该应用自动变成「Homebrew 管理」，
后续更新走常规 `brew upgrade --cask`。

> **为什么不是 `--adopt`**：Homebrew 的 `--adopt` 只在「已有 app 与要安装的版本
> **完全一致**」时才接受（`cask/artifact/moved.rb` 会比对 `CFBundleShortVersionString`），
> 版本不同会直接报 `It seems the existing App is different from the one being installed.`。
> 也就是说 `--adopt` 只能「认领一个已经是最新的 app」，**不能用来升级**。
> 实测：IINA 1.4.4 用 `--adopt` 失败，用 `--force` 成功升到 1.5.0 并被 brew 接管。

对不上 cask 的应用仍然无法更新，界面会显示「需手动」并提示去应用内或官网升级。


1.3.8 起，界面上这类应用的行提示**会直接把对应命令写出来**（能对上 cask 时给真实 token，
例如 `非 Homebrew 管理：brew install --cask --adopt iina`），不用再回来看文档。

#### 1.3.9 起：非 Homebrew 应用也能查到「官网最新版本」

「只能列出、不知道有没有新版」并不是必然的 —— macOS 应用**自己就带着更新源**。
1.3.9 会读这两类源，只读地判断官网有没有新版：

| 类型 | 位置 | 读什么 |
|---|---|---|
| Sparkle | `Info.plist` 的 `SUFeedURL` → appcast.xml | `<sparkle:shortVersionString>`（**不是** `sparkle:version` 构建号） |
| Electron | `Contents/Resources/app-update.yml` | `url` + `channel` → 抓 `<channel>-mac.yml` / `latest-mac.yml` 顶层的 `version:` |

查到后，界面上这类应用会：

- 「可升级到」列显示官网版本 + 橙色 `需手动` 标签（不再是一个破折号）；
- 状态列显示 **官网有新版**（独立文案与颜色，既不是「已是最新」也不是「不可判断」）；
- 状态栏补一句「另有 N 个官网有新版，需手动升级」，并可用「需手动」分段筛选；
- 悬停提示说明版本来自哪个源、以及 `brew install --cask --adopt <token>` 收编命令。

**边界**：这条路径**只用于展示**，绝不会把非 Homebrew 应用变成「可一键更新」——
`hasUpdate` / `updateSupported` 依然只由 Homebrew 决定。查到版本 ≠ 能替你升级，
仍需收编进 Homebrew 或用应用内更新。查询是**只读**的：不下载、不安装、不启动被检测的应用。

本机实测覆盖情况（110 个应用）：只有 IINA（Sparkle）与哔哩哔哩（Electron）带可读的更新源；
其余 43 个非 Homebrew 应用既没有 appcast、`SUFeedURL` 也为空（例如 i4Tools），
这类应用仍然如实显示「不可判断」—— 不猜、不编版本号。

设置项 `checkOfficialSources`（默认 `true`）可整开关掉；关掉后这些应用回到「不可判断」，
且扫描不再发起任何对这些域名的请求。

如果状态行下方出现**红色警告横幅**，说明这次扫描的**判断依据本身失效**了（Homebrew 命令失败，
或 cask 目录抓不下来），此时「0 个可更新」不代表应用都是最新 —— 横幅里有具体原因与下一步。

---

## 设置项

状态文件：`%USERPROFILE%\.dsh\dsh-app-updater\state.json`

| 键 | 默认 | 说明 |
|---|---|---|
| `includeStoreApps` | `true` | 是否把商店应用列进来（Windows 是 MSIX、macOS 是 App Store 应用；只展示，不会被更新）。 |
| `includeRegistryOnly` | `true` | Windows：是否用注册表补齐 winget 未收录的应用（只展示，不能更新）。 |
| `includeUnmanagedApps` | `true` | macOS：是否把非 Homebrew 管理（拖 DMG / 手动装）的应用也列出来（只展示，不能更新）。 |
| `checkOfficialSources` | `true` | macOS：是否读取非 Homebrew 应用**自带的**更新源（Sparkle appcast / Electron 更新清单）来判断官网有没有新版。只读；关闭后这些应用一律显示「不可判断」。 |
| `downloadDir` | 空 | 自定义安装包下载目录；空 = `%USERPROFILE%\Downloads\DSH App Updater`（macOS 为 `~/Downloads/DSH App Updater`）。 |
| `keepInstallers` | `true` | 更新后保留安装包；`false` 则在安装完成后删掉该应用刚下载的包。 |
| `hashFallbackUpgrade` | `true` | 下载失败时退回 `winget upgrade` 兜底。 |
| `dryRun` | `false` | **演练模式**：只下载官网全量安装包、不执行安装。用来先看会装什么。 |
| `matchSystemArch` | `true` | 按识别到的系统与芯片架构挑选安装包（Windows 传 `--architecture`；macOS 由 Homebrew 决定）。 |
| `autoElevate` | `true` | **自动提权安装**：需要管理员的安装包（MSI、写入 `Program Files`）改由管理员上下文执行；UAC 开启时每次安装会弹一次确认。 |

用 API 改设置（等价于设置面板，适合脚本化）：

```bash
curl -X POST -H "Content-Type: application/json" \
  -d '{"confirm":true,"settings":{"dryRun":true}}' \
  http://127.0.0.1:<port>/dsh-app-updater/settings
```

`downloadDir` 会被校验：必须留空（用默认目录）或是绝对路径（`D:\Apps`）／UNC 路径（`\\server\share`），
否则返回 `400` 并在面板里显示红字提示，不会把安装包写到意料之外的位置。

> 这些路由**默认拒绝**：请求必须通过宿主的 `connection` 准入（浏览器里就是带上 DSH 页面的会话
> Cookie），或在**没有 `connection` 服务的旧宿主**上由你显式开启兼容模式（见「安全边界」）。

## 版本信息与插件自更新（1.4.0）

设置页 `应用更新` 面板的**最下方**有一块版本信息区，显示本插件的 `version` 与
`CHANGELOG.md` 顶部的「最新更新时间」。旁边一个按钮完成整套交互：

- 点「检查更新」→ 宿主查询 npm 官方源
  `https://registry.npmjs.org/dsh-app-updater/latest` 并与当前版本比对；
- 有新版 → 按钮变「立即更新」，点它执行
  `dsh plugin --profile web add dsh-app-updater@<新版>` 完成自更新；
- 无新版 → 明确提示「当前已是最新版本」，按钮保持「检查更新」；
- 检查 / 更新进行中按钮禁用并显示进行中文案，不会重复发请求；
- 失败给出原因并显示「重试」；更新完成或重新检查判定无新版后，按钮回到「检查更新」。

版本数据源：当前版本取 `package.json` 的 `version`，更新时间取 `CHANGELOG.md` 顶部日期，
由 `GET /dsh-app-updater/state.json` 的 `pluginInfo` 只读下发。检查走
`GET /dsh-app-updater/check-update`，执行走 `POST /dsh-app-updater/self-update`（同样要求
`confirm:true` + `csrfToken`）。接口细节见 [CONTRACT.md](CONTRACT.md)。
> 仅凭「来自 127.0.0.1」不再放行 —— 1.3.1 已把这条路径改成默认拒绝。

---

## 安全边界

- **路由默认拒绝**：每个请求先过 `ctx.connection.admit(request)` —— DSH 用来做
  Host/Origin 信任校验与浏览器会话 / API 认证的那套边界（宿主自己的 `/api` 路由用的就是它），
  未通过的请求直接得到 `401` / `403` / `409`，响应头带 `X-DSH-Admission: denied`。
- **兼容模式默认关闭**（1.3.1 起）：宿主没有 `connection` 服务时**不再**「仅凭回环地址放行」，
  一律 `403`。旧宿主上确实需要时，必须由你**显式**开启，二选一：
  - 插件配置（`cordis.patch.yml` 里覆盖同名条目）：

    ```yaml
    - id: dsh-app-updater
      config:
        allowLegacyLoopback: true
    ```

  - 或启动 DSH 前设置环境变量 `DSH_APP_UPDATER_ALLOW_LEGACY_LOOPBACK=1`。

  开启后：放行的回环请求带 `X-DSH-Admission: loopback-legacy-optin` 与
  `X-DSH-Admission-Warning`，`state.json` / `health.json` 的 `admission` 字段会标明 `mode: "loopback-legacy-optin"`，设置页顶部也会出现红色提示条；日志里记一条 `warn`。
- **兼容模式的来源围栏（1.3.5 起）**：豁免路径拒绝「跨站浏览器请求」——`Origin` / `Referer`
  存在且与本次请求的 `Host` 不同源，或 `Sec-Fetch-Site: cross-site`，一律 `403`。
  浏览器禁止脚本伪造这几个头（forbidden header），所以判定可靠：任意第三方网页的
  无 Cookie `fetch(…/update)` 不再可能驱动「下载 + 提权安装」；本机脚本与宿主 IPC 桥
  （不带这些头）不受影响。
- **写操作还要显式确认**：`scan` / `update` / `cancel` / `settings` / `open-downloads` 必须带 `confirm:true`。
- **不猜测静默参数**：优先用发布方在清单里声明的 `Silent` 参数；清单缺失时才按安装包类型用保守的默认开关。
- **执行前本地复核 SHA-256（1.3.5 起）**：`winget download` 完成后，按随包清单的
  `InstallerSha256` 对流盘的安装包重新计算一次哈希再执行——这个文件紧接着可能以管理员
  身份运行，中途被替换或损坏必须拦住；不一致就不执行、改用兜底。清单里配对不出本次
  架构的哈希时跳过并记录，绝不拿别的架构的哈希误判。
- **需要管理员时自动提权**：机器级安装包（MSI、写入 `Program Files`）交给
  `Start-Process -Verb RunAs` 的提权副本执行（可在设置里关掉「自动提权安装」）；
  UAC 为「始终通知」时每次安装会弹一次确认。
- **安装后复核版本**：用「安装前 / 安装后 / 目标」三个版本判断这次更新是否真的生效 ——
  退出码 0 不再等于成功（机器级安装包在没提权时会静默退出 0 却什么都没装）。
- **不做系统组件更新**：`.NET` 运行时、VC++ 运行库等仍会列出来，但默认不作为一键更新的目标。
- **只写自己的目录**：状态与日志写在 `~/.dsh/dsh-app-updater/`，不碰 profile 与宿主配置。

---

## 依赖

- **Windows**：`winget.exe`（Microsoft「应用安装程序 / App Installer」）。没装 winget 时插件仍能列出注册表里的应用，但无法判断是否有新版本。
- **macOS**：无需额外依赖即可**列出**应用（直接读 `/Applications` 等目录里的 `.app`）；要判断并执行更新需要 `brew`（[Homebrew](https://brew.sh)）。没装 Homebrew 时会照常列出应用，并说明「安装 Homebrew 后可一键升级 cask 应用」。
  cask 目录（19 MB）走**官方 + 清华 TUNA / 中科大 USTC 并发竞速**（阿里云镜像是过期快照、
  会把「有更新」静默说成「已是最新」，1.3.4 起已剔除），单地址限时 60 秒，
  全部失败时回退 30 天内的过期缓存；抓不到目录会在界面上给出红色警告横幅，而不是假装「无更新」。
- 不需要任何第三方 npm 依赖；宿主半身只用 Node 内置模块，浏览器半身只用宿主提供的 `react`。

## 接口（宿主半身）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/dsh-app-updater/state.json` | 当前状态、应用清单、日志、设置 |
| GET | `/dsh-app-updater/apps.json` | 只取应用清单与统计 |
| GET | `/dsh-app-updater/health.json` | 自检：版本、运行环境、引擎与能力、路由数、数据目录 |
| POST | `/dsh-app-updater/scan` | `{confirm:true, force:true}` 开始扫描 |
| POST | `/dsh-app-updater/update` | `{confirm:true, ids:[...]}` 开始更新队列 |
| POST | `/dsh-app-updater/cancel` | `{confirm:true}` 取消未开始项 |
| POST | `/dsh-app-updater/settings` | `{confirm:true, settings:{...}}` |
| POST | `/dsh-app-updater/open-downloads` | `{confirm:true}` 打开下载目录 |

## 安装（开发）

```bash
# 本地目录安装
dsh plugin --profile <profile> add file:/path/to/dsh-app-updater

# 或者用链接（开发时改代码即时生效）
dsh plugin --profile <profile> add link:/path/to/dsh-app-updater
```

装好后把 `dsh-app-updater` 加进 profile `package.json` 的 `dsh.profile.bundles` 清单
（包内自带的 `cordis.patch.yml` 会挂载宿主半身），然后重启 DSH 即可在设置页看到入口。

> 桌面端（Electron 托管）的 `desktop` profile 不允许用 `dsh plugin` 直接改写，
> 需要在 profile 的 `node_modules` 下建立指向本包的 junction 并手动补 `bundles` 与依赖。

## 测试

```bash
npm test                        # = unit + render + deny，具体项数以命令输出为准
node test/unit.mjs              # 定宽表格解析、版本比较、清单与静默参数、系统/架构识别、Homebrew 解析、macOS 应用枚举与 cask 匹配、准入闸门
node test/render.mjs            # 设置面板（按平台）、演练提示、扫描警告横幅、列宽拖拽、请求体、结果面板
node test/deny.mjs              # 无 connection 服务时逐路由验证默认拒绝 + CSRF / method 闸门
node test/harness.mjs --scan    # 用假 cordis ctx + 真 HTTP 把宿主半身跑起来（非计分工具，需 Windows + winget 才能真扫描）
```

> 文档里的历史项数（如 `153 / 51 / 12`、`36 / 32`）都是旧值，**一律以 `npm test` 的实际输出为准**。
> `test/harness.mjs` 没有断言、不在 `npm test` 里、不计分，不要误当成第四套测试。

> 测试不依赖本机是否装了 Homebrew：`findBrew` 的断言按「存在性」覆盖 Apple Silicon /
> Intel / Linuxbrew 三处默认前缀（1.3.2 及以前这条断言写死 `=== null`，在真实 Mac 上恒红，
> 1.3.3 已修正）。

## 支持的系统与架构

插件启动时会识别本机环境，并据此挑选对应架构的安装包：

| 系统 | 架构 | 更新引擎 | 说明 |
|---|---|---|---|
| Windows 10 / 11 | x64 / ARM64 / x86 | **winget** | 把识别到的架构传给 `winget --architecture`；清单没有该架构的包时自动退回自动匹配并记录日志 |
| macOS 11+ | Apple Silicon / Intel | **Homebrew cask** | 应用从 `/Applications` 等目录枚举，再按 cask 目录匹配；Homebrew 自己按本机架构取 cask。没装 Homebrew 时仍能列出应用，只是不能一键更新 |
| 其它 | — | 无 | 扫描/更新接口返回 400 并说明原因 |

识别结果会显示在状态行与设置面板的「运行环境」里，例如
`Windows 11（build 26300） · x64（AMD64） · winget 1.29.380` 或
`macOS 15（Sequoia） · Apple Silicon（ARM64） · Homebrew 4.5.0`。

还可以在设置面板里关掉「按本机架构安装包」——关闭后把选择权交回 winget 自己（Homebrew 一直按本机架构）。

机器级安装（MSI、写入 `Program Files`）需要管理员权限，否则 MSI 会返回 1603（MSI 日志里是
`Error 1925: You do not have sufficient privileges…`），部分安装器则可能**静默退出 0 却什么都没装**。
因此安装类命令默认自动提权执行（设置里的「自动提权安装」，默认开启）：安装包本体与
`winget upgrade` 兜底都交给 `Start-Process -Verb RunAs` 的提权副本，装完再按
「安装前版本 / 安装后版本 / 目标版本」复核这次更新是否真的生效。
UAC 为「始终通知」时每次安装会弹一次确认；把 DSH 本身以管理员身份运行则不会再弹。
Edge 走它自带的更新服务：winget 目录里的 `Microsoft.Edge` 是企业版 MSI，与本机消费版的
安装技术不匹配（`0x8A15008E`），winget 会直接拒绝。

> macOS 的应用枚举（`/Applications` 等目录 + `Info.plist`）与 cask 匹配逻辑有单测覆盖，
> 并用真实的 `formulae.brew.sh` 目录（7800+ cask）验证过匹配与去重；
> 但本插件主要在 Windows 上开发，macOS 上的**安装/更新执行**没有真机验证过，遇到问题请开 Issue。
>
> macOS 上只枚举标准应用目录。应用如果装在别处（例如 `~/Desktop` 或自定义目录），
> 本插件看不到它 —— 这不是漏扫，是扫描范围之外。

## 1.3.16 性能（相对 1.3.15 发布版）

- **macOS「全部更新」两段式**：先并发 `brew fetch --cask` 预下载（并发度 3，
  落 Homebrew 自己的下载缓存），再串行 `brew upgrade` / `install --force` 安装与
  复核。实测基线 3 应用 320s → 下载与安装解耦后总时长 ≈ 并发下载最大值 +
  串行安装之和。判定结果与成功/失败语义不变。
- **macOS 更新前预检并发化**：下载源探测（github 系 1MB 实测）与 pkg-sudo 判定
  从逐个串行改为循环外并发（并发度 3）。
- **brew 过程行进运行日志**：`==> Downloading / Installing` 等过程行带 token
  前缀写入日志并去重——更新一个应用几分钟不再是「0/3 0%」黑盒。
- **macOS 扫描三阶段并发**：枚举 `.app` / brew 三连 / cask 目录竞速并发执行，
  冷态（brew 自动刷新 API 元数据 20s+、目录竞速 60s）从相加变取最大。
- 扫描与更新各阶段补 `阶段耗时：…s` 计时日志。

## 1.3.15 加固（相对 1.3.14 发布版）

- **写操作双闸门**：宿主对写路由显式校验 `method === "POST"`，并在 `confirm:true` 之外
  要求 `csrfToken`（由 `GET /state.json` 下发、不落盘）；兼容模式下无凭据的跨站 / 脚本请求
  拿不到它，无法再驱动「下载 + 提权静默安装」。
- **`/cancel` 可指定目标**：`target: "scan" | "update" | "all"`（默认 `all`），不再一按全停；
  界面在扫描中也能取消。
- **macOS 自定义下载目录**：`/settings` 的 `downloadDir` 现在接受以 `/` 开头的 POSIX 绝对路径。
- **卸载清理**：cordis 卸载时 abort 后台 scan / update 任务并清掉自动重扫 timer，不再留幽灵任务。
- **版本算法**：`+build` 按 SemVer 视为元数据、尾缀大小写不敏感、`normalizeVersionKey` 不再碰撞。
- **子进程**：`StringDecoder` 逐块解码（中文跨 chunk 不再变 U+FFFD）、POSIX 按进程组取消。
- **下载**：并发预下载（独立子目录消除目录 diff 竞态）、网络抖动重试、磁盘配额与清理、
  `dryRun` 不再被删包；复核改为首立即 + 递增退避 + 总时限。
- **界面**：结果面板补全 `installOk / verified / hash / durationMs / unverifiable` 等字段、
  启用 `locale`（`zh-CN` / `en`）、键盘可调列宽等 a11y 改进。

> 具体改动与验证结果见仓库工作区的 `dsh-app-updater-修复说明-*.md`（不随本包发布）。

## 卸载

1. 从 profile 的 `package.json` 里删掉 `dsh.profile.bundles` 中的 `dsh-app-updater` 与 `dependencies` 中的对应条目。
2. 删除 `%USERPROFILE%\.dsh\profiles\<profile>\node_modules\dsh-app-updater`。
3. 重启 DSH；数据目录 `%USERPROFILE%\.dsh\dsh-app-updater` 可自行删除。

## 文件

| 文件 | 作用 |
|---|---|
| `lib/index.js` | 宿主半身：HTTP 路由、准入 / `confirm` / `csrfToken` / method 闸门、扫描/更新任务调度 |
| `lib/engine.js` | 扫描合并、官网包下载（并发预下载）、静默安装、winget 兜底、版本复核、下载源可达性探测 |
| `lib/winget.js` | winget 定位与调用、定宽表格解析（CJK 宽度感知） |
| `lib/registry.js` | 注册表 `Uninstall` 键枚举（PowerShell，UTF-8） |
| `lib/version.js` | Windows 风格版本比较（含 SemVer `+build` / 尾缀自然序） |
| `lib/plugin-version.js` | 1.4.0：插件自身版本/时间读取、npm registry 比对、自更新命令构造（纯函数） |
| `lib/state.js` | 状态与设置持久化（原子写）、CSRF token、跨平台设置裁剪 |
| `lib/proc.js` | 子进程执行（超时 / AbortSignal / 进程组取消 / StringDecoder） |
| `lib/macos.js` | macOS 数据层：`.app` 枚举、cask 目录竞速与缓存、列表组装 |
| `lib/appcast.js` | 非 Homebrew 应用官网更新源（Sparkle / Electron，只读） |
| `lib/elevate.js` | Windows UAC 提权（临时文件 IPC + 进程树取消） |
| `lib/platform.js` | 系统 / 架构 / 引擎识别 |
| `lib/client.js` | 浏览器半身：设置页 UI（设置面板、可拖拽列宽、进度、结果面板、日志与最下方版本信息区；`zh-CN` / `en` 字典） |
| `CONTRACT.md` | 宿主 ↔ 客户端接口契约 |
| `test/unit.mjs` | 解析器 / 版本 / 清单 / 准入闸门单测（项数以 `npm test` 输出为准） |
| `test/render.mjs` | 前端渲染与交互自测（项数以 `npm test` 输出为准） |
| `test/harness.mjs` | 宿主路由端到端 harness（假 ctx + 真 HTTP） |
| `icon.svg` | 插件图标 |
| `LICENSE` `CHANGELOG.md` `README.en.md` | MIT 许可证、更新日志、英文说明 |