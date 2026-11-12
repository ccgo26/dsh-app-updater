# 更新日志

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [1.3.16] — 2026-11-12

### 性能：macOS 更新引入「并发预下载 + 串行安装」，扫描三阶段并发

实测基线（本机 Apple Silicon，3 个可更新应用）：刷新检测热态 1.2s；「全部更新」
320.4s（google-chrome 169s / tencent-meeting 65s / wechat 86s），99% 耗在串行
`brew upgrade` 的下载阶段；界面全程停在「0/3 0%」没有任何过程可见性。本版针对
这两点动刀，**不改变任何判定结果与成功/失败语义**：

- **macOS 更新改为与 Windows 侧同构的两段式**：先对全部 token 并发
  `brew fetch --cask`（并发度 3，复用 `DOWNLOAD_CONCURRENCY`）把安装包拉进
  Homebrew 自己的下载缓存，再走原有的串行 `brew upgrade` / `install --force`
  循环——安装命中缓存，只剩安装与复核。总时长从 Σ(下载+安装) 变为
  ≈ 并发下载最大值 + Σ(安装)。预下载失败的 token 记入失败集合，串行循环按
  原有「如实报错」语义透出，不吞错误、不静默跳过。
- **预检（下载源探测 / pkg-sudo 判定）从循环内外提并发执行**：原来逐个串行，
  github 托管的 cask 每个白等最长 10s。跳过文案与判定语义逐字保留。
- **`dryRun` 复用预下载阶段**：语义不变（只下载不安装），pkg 型 cask 在演练
  模式下如实标注「包已就绪、需终端 sudo」。
- **brew 子过程输出接进运行日志**（`runBrew` 透传 `onData`，安装与预下载都接）：
  `==> Downloading / Installing / Moving…` 过程行带 token 前缀写入运行日志，
  按 `\r\n` 切分并去重（curl 的 `##` 进度条用 `\r` 刷新，直接透传会刷爆 400 条
  日志上限）。「0/3 0% 挂 169 秒」从此有中间可见性。
- **macOS 扫描三阶段并发**：枚举 `.app`（磁盘）/ brew 三连（子进程）/ cask 目录
  竞速（网络）互不依赖，`Promise.all` 并发。热态收益小（实测 1.2s），冷态从
  「相加」变「取最大」。各阶段 catch/降级/warnings 语义逐项保留。
- **分阶段计时日志**：扫描（并发墙钟 / 官网更新源）、更新（预检 / 预下载）
  各写一条 `阶段耗时：…s`，供效果对比与排障。

### 兼容性

- 更新结果 `entry` 的 ok/error/note 字段语义与 1.3.15 完全一致；`stats` 口径
  （total/upgradable/manual/unsupported）不受影响。
- 无新增设置项、无 API 变更；`state.json` 结构不变。
- Windows 路径零改动。

## [1.3.15] — 2026-11-04

### 安全：写操作默认拒绝再加固（`csrfToken` + `method`）

- 宿主半身对 5 个写路由**显式校验 `method === "POST"`**（不匹配返回 `405`），不再依赖
  宿主 `webServer.register` 的分发实现——原来「GET 带 body」也能触发扫描/更新/改设置。
- 新增进程内 `csrfToken`（由 `GET /state.json` 下发、**不落盘**）：所有写操作在
  `confirm:true` 之外必须原样带回，否则 `403`。兼容模式下无 Cookie 的跨站/脚本请求
  拿不到它，无法再驱动「下载官网包 + UAC 提权静默安装」。
- `admissionGate` 的 `500` 不再把宿主内部错误文案回给客户端；`readJsonBody` 改用
  Buffer 累积（防中文跨 chunk 变 `U+FFFD`）、按字节计大小、超大请求体排空、只接受对象。
- `/cancel` 支持 `target: "scan" | "update" | "all"`（默认 `all` 兼容旧行为），界面在
  扫描中也能取消，不再「一按把扫描和更新一起停」。

### 可靠性：下载并发化、结果可信度、生命周期

- `winget download` 改为 **3 路并发预下载**，每次下载用独立私有 `workDir`，彻底消除
  「共享下载目录前后 diff」的并发竞态；安装/兜底/复核仍严格串行（UAC 互斥）。
- `moveIntoDownloadDir` 回迁处理 `EXDEV` 跨卷，并写 `.dsh-app-updater` **侧车标记**；
  4 GiB 磁盘配额 `pruneDownloadDir` **只删带标记的本插件文件**，绝不误删用户放在同一
  下载目录里的 `.exe` / `.dmg` / `.yaml`。
- 安装后复核改为「首次立即 + 递增退避（`1.5^i`，cap 30s）+ 总时限」；网络抖动下载
  最多重试 2 次（1s / 3s，仅超时/网络类错误）；`dryRun` 不再被 `keepInstallers=false` 删包。
- `unverifiable`（读不到已装版本）新增明确字段与「已安装·未复核」状态；Windows 补
  `manual` 统计；结果面板渲染 `installOk / verified / hash / durationMs / selfUpdater /
  dryRun / unverifiable`。
- cordis 卸载时 `abort()` 后台 scan / update 并清掉「更新后 4 秒自动重扫」timer；
  `startUpdate` 补任务所有权校验（与 `startScan` 对齐）。
- `state.json` 损坏时先备份为 `state.json.corrupt-*` 再回退；`save()` 失败记
  `lastSaveError` 而非静默吞掉；`load()` / `openFolder` / `route dispose` 失败全部留痕。
- 下发 `state.json` 前再裁一次平台专属设置（堵住运行期外部写入）。`/settings` 的
  `downloadDir` 现在接受 macOS 以 `/` 开头的 POSIX 绝对路径。

### 正确性：版本算法与子进程

- `version.js`：`+build` 按 SemVer 视为元数据（与正式版相等）、尾缀大小写不敏感、
  `normalizeVersionKey` 加分隔符消除 `1.2-3` vs `1.23` 碰撞、模块级 `/g` 正则改用
  `matchAll`、`v` 前缀只剥「v 紧跟数字」。
- `proc.js` / `registry.js`：`StringDecoder` 逐块解码（中文跨 chunk 不再变 `U+FFFD`）；
  `proc.js` 在 POSIX 上 `detached` + 按进程组 kill（不留孤儿安装器）。
- 扫描侧与复核侧版本归一统一到 `macos.js` 的 `mainVersionOf`，但 `splitCaskVersion`
  保留原始串（不砍 `_` / `+`），避免破坏 1.3.13 的构建号识别。
- macOS `reason` 细分 `not-in-catalog` / `unknown-version`（可一键更新集合逐位不变）；
  cask 缓存带 `source` / `count` 与 `readCatalogCacheMeta`，stale 告警写明来源与缓存天数。

### 界面与文档

- 浏览器半身：`csrfToken` 统一注入、首帧不再闪 Windows 专属设置、结果字段补全、
  `source` 徽章白名单、日志稳定排序、取消扫描、`doOpenDownloads` 回读 state。
- `CONTRACT.md` / `README.md` / `README.en.md` / `RELEASING.md` 对齐代码：轮询
  `900/5000ms`（原写 `800/4s`）、6 列 + 徽章、`/cancel` 的 `target` 与 1.3.5 杀树实现、
  `csrfToken` / `saveError`、settings 全集、测试数改为「以 `npm test` 输出为准」、
  发版脚本加资产名断言。

### 修复引入的回归（本轮自查发现并修掉）

- `splitCaskVersion` 一度误用 `mainVersionOf` 砍掉下划线构建段 → 恢复 + 加回归断言。
- `pruneDownloadDir` 一度按扩展名清理（会误删用户文件）→ 改侧车标记 + 加断言锁住。

### 测试

`unit 363 / render 87 / deny 16`（本轮基线；发版前以 `npm test` 实际输出为准）。
16 个 `lib/*.js` + `test/*.mjs` 全部 `node --check` 通过，`test/harness.mjs` 真实 HTTP
端到端通过，6 项 HTTP 探针（CSRF / 405 / macOS 路径 / cancel target / 相对路径拒绝）全通过。

## [1.3.14] — 2026-11-03

### 新增：更新前探测下载源，不再陪跑两小时

用户实测反馈：「balenaEtcher 明明是 GitHub 上下的，为什么更新卡住不动？」。
根因是 Homebrew 的 cask 把下载地址写死：

```
url: https://github.com/balena-io/etcher/releases/download/v2.1.9/…arm64.dmg
homepage: https://balena.io/etcher        ← 只用于展示，brew 不用它
```

官网 `etcher.balena.io` 能打开，但它的下载按钮本质上是去问 GitHub API 再跳 Releases，
**绕不开 GitHub**。而 `github.com` 在本机网络下不可达/极慢时，
`brew install --cask --force` 会卡在「解析下载地址」最长 2 小时。

新增 `probeCaskDownloadUrl()`：动手前对 github 系主机发一次**真实的首 1MB 下载**，
量到速度就放行，量不到就立刻报原因并跳过。

> **重要教训（踩过两次）**：`HEAD` 判断不可用。本机实测 github.com 首页
> `HEAD` 返回 200/302 只要 1 秒，但同一个 URL 跟随重定向真正下载时
> 30 秒收到 **0 字节**——Releases 的实体走 `objects.githubusercontent.com`，
> 那条链路单看首页完全测不出来。所以必须 `-r 0-1048576` 真下 1MB。

失败时区分两种原因（用户下一步不同）：
- 「完全访问不到」→ 链路不通，配代理
- 「链路能通但速度极慢（10 秒只下到 270 KB，27 KB/s）」→ 太慢，配代理或官网手动下

实测：balenaEtcher 从「卡到 2 小时超时」变成 **10.3 秒**给出明确结论。

### 优化：cask info 不再重复调用

`caskNeedsSudo` / `readBundleVersionByToken` 各自起一次 `brew info --cask --json=v2`
（每次最长 60 秒），同一个 cask 在一次更新里会被问三次。现在共享 `loadCaskInfo()`
+ 进程内缓存，更新结束时 `clearCaskInfoCache()` 清掉，避免装前信息污染复核。

### 测试

`unit 334/334`（新增 12 条）、`render 85/85`、`deny 12/12`。
其中专门锁住「不能用 HEAD 判断」这条教训，防止以后改回去。

## [1.3.13] — 2026-11-03

### 修复：8 个「有新版本」是**误报**，它们其实早就是最新版

这是本版最重要的一条。Homebrew 的 cask `version` 是「主版本 + 构建号」的拼接写法，
而磁盘的 `CFBundleShortVersionString` 只有主版本：

| 应用 | cask version | 磁盘 short | 磁盘 bundle |
|---|---|---|---|
| QQLive | `2.189.0.55910` | `2.189.0` | 55910 |
| 腾讯会议 | `3.47.2.407,…` | `3.47.2` | 407 |
| 迅雷 | `5.80.8.66675` | `5.80.8` | 66675 |
| 微信 | `4.2.0.16,270352` | `4.2.0` | 270352 |
| 企业微信 | `5.0.13.95049` | `5.0.13` | 95049 |
| WorkBuddy | `5.9.3.42398134-d4692421` | `5.9.3` | 5.9.3 |

拿 `2.189.0.55910` 直接和 `2.189.0` 比，第 4 段会被当成「更高的版本」，
于是**已经是最新**的 8 个应用全被报成「有新版本」。用户点「全部更新」，
装完再看，版本号还是 `2.189.0` —— 因为本来就没得升。

新增 `splitCaskVersion()` / `isSameOrNewerThan()`：把 cask 串拆成
「主版本 + 构建号」，再拿磁盘的 `CFBundleShortVersionString` **和**
`CFBundleVersion` 一起比对。`readAppBundle` 现在会保留 `bundleVersion`。

四种真实写法都要认（各有回归断言）：
- `2.189.0.55910` —— 末段远大于主版本段
- `3.47.2.407` —— 407 只有 3 位，靠「大于主版本」识别
- `4.2.0.16,270352` —— 16 很小，靠逗号后那个 bundle 号才认得出
- `5.9.3.42398134-d4692421` —— 构建号后接哈希

### 修复：版本列显示不全

`available` 列默认 96px，装了 `3.47.2.407,8f792a0af699fd29e5a7f6b461a4c2ee`
这种 40 字符的串只能看到前半截，用户没法用这列判断有没有更新。
默认宽度改为 `name 240 / version 112 / available 168 / state 96`，
并保留拖动调整。

### 测试

`unit 322/322`（新增 16 条，含 7 个「已是最新」+ 4 个「真有更新」的真实样本）、
`render 85/85`、`deny 12/12`。
真实扫描：可一键更新从 8 个降为 1 个（balenaEtcher，因 GitHub 不可达会失败），
那 7 个误报全部正确归为「已是最新」。

## [1.3.12] — 2026-11-03

### 修复：9 个「版本不一致」是把**成功的升级**报成了失败

判据写错。cask 的 `version` 与磁盘的 `CFBundleShortVersionString` 是**两套编号体系**：

| 应用 | cask 记录 | 磁盘实际 |
|---|---|---|
| 微信 | `4.2.0.16,270352` | `4.2.0` |
| 腾讯会议 | `3.47.2.407,8f7920…` | `3.47.2` |
| QQLive | `2.189.0.55910` | `2.189.0` |

cask 串的末段往往就是磁盘的 `CFBundleVersion` 构建号，主版本本来就对不上。
旧逻辑要求「与 brew 记录逐字符相等」，于是 9 个真实升级全被标失败。
现改为按**磁盘版本 >= 安装前版本**判定（升级只可能往前走；磁盘仍是旧版才算没装上）。

### 修复：失败原因显示成 `==> Installing Cask awesun`

`firstLine(outputText(res))` 取的是 stdout 首行，那是**过程输出**，不是错误。
新增 `brewErrorLine()`：优先从 stderr 里挑 `Error:` / `Failed` / `curl:` 等关键行，
绝不把 `==>` 过程行当原因展示。挑不出时返回空串，由调用方拼「退出码 N」。

### 修复：AweSun / UURemote 永远装不上（pkg 安装器需要 sudo）

真实原因（实测复现）：

```
sudo: a terminal is required to read the password
sudo: a password is required
```

这两个 cask 用 `.pkg` 安装器，`brew` 会调 `/usr/bin/sudo installer -pkg`，而后台进程
**没有终端**，sudo 读不到密码，必然失败。以前它跑到一半才报错，错误还被过程行盖住。

现在：扫描阶段就识别 `needsSudo`（`artifacts` 里出现 `pkg`/`pkgutil`/`installer`），
这类应用**不算可一键更新**，界面显示「需手动」并给出可直接复制的终端命令；
引擎执行时也提前跳过并说明原因，不再让 sudo 抛一堆栈。

### 修复：`planById` 作用域错误

复核逻辑引用了 `planById`，但它是 `runUpdates` 里 Windows 分支的局部变量，
在 `runMacosUpdates` 作用域不可见 —— 一旦走到复核就会抛 `planById is not defined`，
把已经成功的更新写成失败。现在在 `runMacosUpdates` 内部自行构建。

### 测试

`unit 306/306`（新增 9 条）、`render 85/85`、`deny 12/12`。
真实扫描：8 个可一键更新、2 个需手动（AweSun / UURemote，均因 pkg + sudo）。

## [1.3.11] — 2026-11-03

### 修复：点「全部更新」后 13 个应用全部失败（判据写错）

`runMacosUpdates` 里构建 `forceInstall` 表时用了：

```js
if (it.adoptToken && it.latestNewer)   // ← 错
```

`latestNewer` 表示「应用自带更新源（appcast）查到的版本更新」，而能靠 cask 接管的
应用根本不会去查 appcast（`managed=false` 但 cask 命中时走的是 cask 目录这条线），
所以该字段恒为 `false`。后果：界面显示「13 个可更新」，点下去 13 个全报
「cask 目录里没有它」——**勾得动、必然失败**，比不显示更糟。
判据改为只看 `adoptToken`（它由 `canAdopt` 决定：cask 存在且版本更新）。

### 修复：更新结束后界面立刻变「扫描中」，看不到结果

`startUpdate` 的 `finally` 里无条件立即 `startScan(true)`，界面在更新收尾的同一瞬间
切到「扫描中…」。用户只看到「点了全部更新，结果它在扫描」，完全不知道
13 个应用成没成。现在：收尾先写一条带成功/失败条数的日志，延迟 4 秒再重扫。

### 新增：更新结果面板

以前 `update.results` **根本没有被渲染**。现在更新结束后直接显示
「上次更新：成功 N / M（X 个失败）」，并逐条列出失败的应用名与原因。

### 新增：更新后的**磁盘**版本复核

以前只看 `brew list --cask --versions`，那是 Homebrew **记录的**版本，不是磁盘事实。
`brew install --cask --force` 的流程是「下载 → 移除旧 app → 搬入新 app」，中途被打断时
brew 可能已记成新版本，而 `/Applications` 里还是旧的。现在再用 cask 声明的 `.app` 名
读 `CFBundleShortVersionString` 做第二重证据，两者对不上就**报失败**。

版本串归一（真实样本，本机实测）：cask 的 version 常是「版本,构建号,哈希」多段写法，
磁盘上只有主版本。例如 QQ 记录 `7.0.0_260812_01,9.9.33,126b7ce6`、磁盘 `7.0.0`；
腾讯柠檬 `5.3.8,6D1470FEA8573BFF3E422BDE1DEF14CD`。比较前先取逗号前那段、
再砍掉下划线/加号之后的部分，否则会把成功误报成失败（实测踩到）。

### 测试

`unit 297/297`（新增 15 条）、`render 85/85`（新增 8 条）、`deny 12/12`。
真实端到端：QQ 升级成功并被 brew 接管（记录 `7.0.0_260812_01,...`、磁盘 `7.0.0`，
归一后判为一致）；balenaEtcher 因 GitHub Releases 在本机不可达而卡死超时，
被如实报为失败（未被误判成功）。

## [1.3.10] — 2026-11-03

### 变更：能对上 cask 的非 Homebrew 应用改为**可一键更新**

1.3.9 把「官网有新版」如实显示出来了，但把它做成了**只能看、点不动**的「需手动」。
用户的反问是对的：明明 `brew` 一条命令就能做完的事，为什么要让人自己开终端？

只要满足**两个条件**——cask 目录里有这个应用、且 cask 版本比已装的新——就执行：

```bash
brew install --cask --force <token>
```

引擎新增 `adoptToken` / `canAdopt` 字段：`hasUpdate` 与 `updateSupported` 同时为真，
勾选框可用，`available` 就是 cask 的目标版本。装完后应用自动转为 Homebrew 管理，
之后走常规 `brew upgrade --cask`。

### 修正：1.3.9 给出的 `--adopt` 命令是**错的**

`--adopt` 只接受「已有 app 与待安装版本**完全一致**」的情形 —— `cask/artifact/moved.rb`
会比对 `CFBundleShortVersionString`，不一致直接抛
`It seems the existing App is different from the one being installed.`。
它只能「认领一个已经是最新的 app」，**根本不能用于升级**。

实测确认（本机）：IINA 1.4.4 用 `--adopt` 失败，用 `--force` 成功升到 1.5.0 并被接管。
1.3.8 / 1.3.9 的文档与界面提示都教用户跑 `--adopt`，属于把无效命令写进产品，本版全部改为 `--force`。

### 修复：`plan` 没有传进 `runMacosUpdates`

端到端实测抓到的真 bug：界面把非 Homebrew 应用勾上了，后台却一律报
「无对应 cask」——因为 `runUpdates` 调用 `runMacosUpdates` 时漏传了 `plan`，
拿不到 `adoptToken`。这就是典型的「勾得动、点下去必然失败」，比不显示更糟。
已修复并加防回归断言（`runUpdates` 必须把 `plan` 传下去）。

### 实测

- `unit 282/282`、`render 77/77`、`deny 12/12`。
- 真实扫描：117 个应用，**14 个可一键更新**（此前为 0），`manual` 降为 0。
- 真实更新：哔哩哔哩 1.18.0 → 1.20.0，`brew install --cask --force bilibili` 耗时 44 秒，
  后台复核读到 `verified: "1.20.0"`，应用随即出现在 `brew list --cask`。
- 已知边界：对不上 cask 的 15 个应用（Quark、ToDesk、爱奇艺等）仍无法更新——
  Homebrew 里根本没有它们，插件不会去猜一个不存在的包名。

## [1.3.9] — 2026-11-03

### 新增：非 Homebrew 应用也能查到「官网有没有新版」

1.3.8 把「不可判断」如实显示出来是对的，但它也暴露了一个更根本的缺口：
**`available` 只在 `managed === true` 时才赋值**。本机 `brew list --cask` 是空的
（110 个应用全是拖 DMG / 手动安装），于是整屏都是「不可判断」、「可升级到」恒为 `—`，
而 cask 目录里其实已经知道 16 个应用有更新 —— 信息在那，却没送到用户眼前。

新增 `lib/appcast.js`，读应用**自带的**更新源，只读地判断官网最新版本：

- **Sparkle**：`Info.plist` 的 `SUFeedURL` → appcast.xml，取 `sparkle:shortVersionString`
  （`sparkle:version` 是构建号，180 这种数字拿来比较必然出错）；带 `<sparkle:channel>`
  的灰度 item 在存在正式 item 时不采用。
- **Electron**：`Contents/Resources/app-update.yml` 的 `url` + `channel` →
  `<channel>-mac.yml` / `latest-mac.yml` 的顶层 `version:`。只认 `generic` provider；
  `url: ''`（本机 NuPhyIO / QQ / aDrive 的真实情况）与 `provider: github` 一律不猜。
- 两者都失败 → 该应用保持「不可判断」。**绝不猜版本号**。

`buildMacosItems` 新增 `official` 入参，产出 `latestVersion` / `latestNewer` / `latestVia`
三个字段。它们与 `available` **刻意分开**：`available` 意味着「点一下就升到这个版本」，
`latestVersion` 只是「官网有个更新的版本，你得自己动手」。`hasUpdate` / `updateSupported`
仍然只由 Homebrew 决定 —— 查到有新版 ≠ 本插件能一键更新，这条边界不能糊。

界面：状态列新增橙色「**官网有新版**」，「可升级到」显示版本号 + `需手动` 标签，
状态栏补「另有 N 个官网有新版需手动升级」，筛选栏新增「**需手动**」分段，
悬停提示写明版本来源与 `brew install --cask --adopt <token>`。排序把「官网有新版」提到可一键更新之后。

新增设置 `checkOfficialSources`（macOS 专属，默认 `true`）。

### 修复：系统组件被谎报成「已是最新」

`UNDETERMINED_REASONS` 里没有 `system-component` / `store-managed`，这两类落到兜底分支
渲染成绿色「已是最新」。可本插件从来没有比较过它们的版本 —— macOS 由系统更新负责、
App Store 应用由 App Store 负责。本机 65 行全中，是被 1.3.8 修过的同一类谎报在另一个分支上漏网。
现在显示中性的「系统负责」，悬停说明由谁负责。**「没比较过」不许伪装成「已经最新」。**

### 修复：中文应用名错配 cask

`normalizeAppKey` 只保留 `[a-z0-9]`，「爱奇艺」「企业微信」归一化后都是空串。
旧实现拿空串继续逐 token 比对，`normalizeAppKey(entry.token) === ""` 对第一个
「声明了纯符号 `.app`」的 cask 恒等命中 —— 实测把**爱奇艺**错配成 `alipay-key-tool`
（支付宝开放平台密钥工具），连界面上给出的 `--adopt` 命令都是错的。
现在空 key 直接放弃逐 token 比对，返回 null；匹配逻辑抽成 `createCaskMatcher`，
扫描侧与组装侧共用同一套规则，避免「扫描时认为是非 Homebrew 去查了官网、
组装时又匹配成 Homebrew 管理」的自相矛盾。

### 新增：`skipBootstrap` 之外的第 118 个应用

扫描范围仍是标准目录，新增的 `.app` 会随枚举自动进入列表。

### 测试

`unit 270/270`（新增 54 条）、`render 72/72`（新增 15 条）、`deny 12/12`，全部通过。
端到端实测（110→117 个应用，真实网络）：IINA 1.4.4→1.5.0（Sparkle）、
哔哩哔哩 1.18.0→1.20.0（Electron）被正确识别；其余 43 个非 Homebrew 应用如实保持
「不可判断」。官网查询本身耗时约 1.3 秒（52 个目标，并发 7），可随时用开关关闭。

## [1.3.8] — 2026-11-03

收口《README-for-author》与《DIAGNOSIS.zh-CN》里**两条尚未落地的建议**。
四个补丁（brew 失败被伪装成 0 个应用、cask 目录竞速、扫描警告上界面、findBrew 断言）
在 1.3.3–1.3.5 已经并入，本版**不再重复修**，只处理剩下的两条。

### 新增

- **「非 Homebrew 管理」直接给可执行的下一步**（`lib/macos.js` + `lib/client.js`）。
  这是 Mac 上最常见的状态（绝大多数应用是拖 DMG 装的），以前只回一句「非 Homebrew 管理」，
  用户知道「不能更新」却不知道「那要怎么办」。现在引擎为这类应用附带 `adoptHint`：
  - 能对上 cask → `brew install --cask --adopt <真实 token>`（接管现有 `.app`，不重装、不丢配置）；
  - 对不上 cask → 给 `brew install --cask --adopt <token>` 占位写法，仍然指明方向；
  - 系统组件 / App Store 应用 / 已由 Homebrew 管理的应用**不**给这条提示（避免误导）。
  界面把提示拼在原因后面显示（`原因：命令`），没有提示时只显示原因，不留悬空冒号。

- **平台专属设置不再跨平台落盘**（`lib/state.js`）。界面本来就按平台裁剪开关，但
  `/settings` 接口和 `state.json` 不看平台 —— macOS 上照样能把 `autoElevate`、
  `hashFallbackUpgrade`、`includeRegistryOnly` 这些 Windows 概念写进去，然后永久存着一批
  用不到的键，还会被序列化回前端让「设置」看起来像跨平台通用项。
  新增 `settingAppliesTo(key, family)` 作为唯一判定源：
  - `updateSettings` 丢弃不属于本平台的键（静默，不算错误）；
  - `load()` 合并默认值后再裁一次（否则 `defaultSettings()` 的全集又会把它们带回来）；
  - 新增 `Store.pruneForeignSettings()`，可主动清掉上个平台遗留的键。

### 修复（独立对抗审计发现，全部先复现再修）

本版在发版前做了一轮独立只读审计，挖出 6 个真实缺陷 —— 其中 1 个是本版新增功能
自己引入的回归，另有 1 个从 1.3.x 起就存在。全部用可执行脚本复现过，修完各配回归测试。

- **平台归属被「陈旧的 env」带偏，Windows 上会静默丢掉注册表源**（`lib/state.js`）。
  这是**本版新增裁剪逻辑自己引入的回归**，也是整轮审计里后果最重的一条：
  `platformFamily()` 原先优先读 `state.json` 里存的上次扫描环境，而不是本机平台。
  只要那份 state 来自另一台机器（同步 `~/.dsh`、漫游配置、恢复备份、换机沿用），
  在 Windows 上读到陈旧的 `family: "macos"` 就会把 `includeRegistryOnly` 当成外来键删掉；
  而 engine 对它是**真值判断**，`undefined` = `false`、默认却是 `true` ——
  于是注册表兜底被静默跳过、registry 条目全被过滤，**界面少显示应用且没有任何警告**
  （正是 1.3.3 修过的那一类静默漏报）。修法两层：
  - `platformFamily()` 改为**只认真实 `process.platform`**，env 仅在真实平台无法判断时兜底；
  - engine 的两处判断改成 `!== false` / `=== false`，与 969/1085 行一致 ——
    「键不存在」永远等于「按默认开启」，不会被误读成「用户关掉了」。

- **「无法判断」被谎报成「已是最新」**（`lib/client.js` 状态列）。非 Homebrew 管理、
  目录未收录、版本读不出来的应用，`hasUpdate` 恒为 `false`，状态列就渲染「已是最新」——
  即使 cask 目录里明明有更新（实测 Raycast 已装 1.99.0、目录 2.10.1）。
  现在这类行显示琥珀色「**不可判断**」并给出悬停原因，不再把「没比较过」说成「已经最新」。

- **`useSelfUpdater` 读得到却设不了**（`lib/state.js`）。`engine.js:1013` 读
  `settings.useSelfUpdater !== false`，但它从来没在 `defaultSettings()` 里声明，
  而 `updateSettings` 只接受已声明的键 —— 结果这个「关闭自带更新器」的逃生开关
  对用户完全不可达，只能改代码。现已补进默认设置。

- **多 `.app` 的 cask 产生重复 item id**（`lib/macos.js`）。一个 cask 声明多个 `.app`
  是真实存在的（`microsoft-office` 声明 Word/Excel/PowerPoint/Outlook，`box-tools`、
  `boxy-suite` 同理），旧实现给每个 `.app` 都发 `brew:<token>`，于是 4 条 item 同 id →
  前端 `selected[id]` 勾一个全勾、`stats` 重复计数。现在首个沿用 `brew:<token>`，
  后续加 bundle 后缀去重。

- **哈希配对被 `win32` 别名抢先 → 假失败**（`lib/engine.js` `pickInstallerSha256`）。
  `win32` 是**平台**名不是架构标记，Electron 系文件名把两者拼在一起
  （`App-win32-x64.exe` = 平台 win32 + 架构 x64）。旧实现按对象键顺序先试 x86，
  `win32` 抢先命中 → 拿 x86 的哈希去校验 x64 的包 → 误报「哈希与清单声明不一致」→
  拒绝安装并白跑一次 winget 兜底。现在强别名（`x64`/`64-bit`/`arm64`…）先全试一遍，
  弱别名（只有 `win32`）仅在无更强线索时兜底；配对不出时照旧 fail-closed 跳过校验。

- **macOS 扫描不响应取消**（`lib/engine.js` `scanMacos`）。最慢的两步
  （枚举 `.app`、cask 目录竞速，单地址 60s）都不收 signal，也没有任何
  `signal.aborted` 抛出 —— 点取消要等它们跑完才响应，界面像卡死。
  Windows 侧 347/380/418 一直有这道检查，macOS 侧漏了。现已补上（枚举后、
  抓目录前、抓目录后各一次），与 Windows 一致：取消向上抛，不算故障、不写红横幅。

### 测试

`unit 217/217`（新增 33 条）、`render 57/57`（新增 6 条）、`deny 12/12`，全部通过。
审计同时确认**没有**问题的模块：`proc` / `elevate` / `registry` / `winget` / `version` /
`platform`，以及 engine 的更新主流程与安装后复核、index 的准入与 CSRF 围栏、
state 的原子写与并发 `save()`、macos 的竞速与过期缓存兜底。

## [1.3.7] — 2026-11-02

**改名回退**：GitHub 仓库 `19952730389/dsh-appupdater` → **改回 `19952730389/dsh-app-updater`**。
1.3.6 的仓库改名（为绕开 deepseek.club Plugin Hub 的撞名）经你确认不再需要，整体撤销：
仓库名、package.json 的 repository/homepage/bugs、README 链接全部回到原名。
deepseek.club 那家不上架了（RELEASING.md 保留提交入口与表单字段资料，供将来参考）。

- npm 包名/插件 id/路由/数据目录自 1.3.5 起就未变过，本次回退**对用户零影响**。
- v1.3.6 的 tag 与 Release 留在仓库里作为过程记录（资产文件名一直是 `dsh-app-updater.tgz`，未受影响）。
- 代码与 1.3.5/1.3.6 一致（仅文档与 URL 差异）；市场条目继续指向 `releases/latest/download/dsh-app-updater.tgz`。

## [1.3.6] — 2026-11-02

**GitHub 仓库改名**：`19952730389/dsh-app-updater` → **`19952730389/dsh-appupdater`**
（旧 URL 由 GitHub 自动重定向；README / package.json 里的仓库链接与源码安装命令已指向新名，
tarball 资产名 `dsh-app-updater.tgz` 不变，各市场 `releases/latest` 链接不受影响）。

改名原因：deepseek.club Plugin Hub 的插件 slug `dsh-app-updater` 已被另一个同名插件占用
（`m1452700576/dsh-app-updater`，用途是检测并更新 DSH 自身），在那家上架必须避开撞名。

- **npm 包名、插件 id、HTTP 路由前缀（`/dsh-app-updater/*`）、数据目录维持不变**：
  npm 的防混淆规则不允许同一作者发布过于相似的名字（`dsh-appupdater` 被 registry 拒绝），
  与其把生态拆成两套名字（用户迁移成本 + 市场条目重写），不如维持现状：
  `dsh plugin add dsh-app-updater` 照旧。已配置的环境变量与插件配置也全部沿用。
- 代码与 1.3.5 逐字节一致，仅仓库 URL 与文档差异。

## [1.3.5] — 2026-11-02

两轮对抗式复查的合并收口（1.3.4 之后），修掉 9 个真实缺陷、补上 1 处文档与实现不一致的承诺。
这一版没有新功能 —— 全是「判断错误 / 静默失败 / 条件触发的安全面」类问题。

### 修复

- **尾缀字典序把 build 号判反**（`lib/version.js`）。数字段一致后，尾缀（`-build10`、
  `-r100`、`-beta2`、Java 的 `8u202` 这类）原来是**整串字典序**比较：`-build9` > `-build10`、
  `8u99` > `8u202` —— 位数一变顺序就翻转。对插件来说这是静默漏报：已装 `1.2.3-build9`、
  有 `1.2.3-build10`，`isNewer()` 返回 false → 用户看到「已是最新」；复核路径还会把成功
  安装误判「没有变化」。现在尾缀按**自然序**比较（数字块按数值、字母块按字典序，
  `-beta2 < -beta10`），保留原有语义：正式版 > 任何预发布尾缀。
- **Windows 扫描不检查取消/超时，半截输出伪装成「0 个可更新」**（`lib/engine.js scanApps`）。
  取消或 240s 超时杀掉 `winget list` 后，半截 stdout 被解析成残缺清单；
  `if (upRes.ok || upRes.stdout)` 又把超时残留字符串真值当成功 → `hasUpdate` 全 false →
  整表覆盖上一次完整结果。macOS 路径 1.3.4 修过同款，这次补上 Windows 侧：
  取消一律向上抛（不算故障、不写红横幅），非零退出/超时不再解析，降级注册表源并如实
  警告「本次清单可能不完整」。
- **注册表读取会被一条无关的 PowerShell 警告整体误伤**（`lib/registry.js`）。stderr 原来与
  stdout 共用同一缓冲数组：任何一条执行策略提示或 .NET 横幅插进 JSON 中部 → 整体解析失败
  → 注册表源全量丢弃，用户以为这台机器读不到已装应用。winget 侧同病（`lib/winget.js`）：
  stderr 混进定宽表还可能伪造数据行。现在两个进程都分桶收集，`stderr` 字段如实传给错误分类。
- **哈希校验：文档承诺 ≠ 实际行为 → 现在真的做了**（`lib/engine.js`）。README 写「下载时按清单
  核对 SHA-256」——winget 自己确实会核对（我们从不传 `--skip-hash-check`），但**执行前的那个文件**
  此前没有任何本地校验。而这个文件紧接着会以**管理员**身份静默执行。1.3.5 起：
  - `parseInstallerManifest` 按 Installer 块配对收集 `Architecture → InstallerSha256`
    （兼容 `- Architecture:` 列表首项写法）；
  - `verifyInstallerHash` 流式（`createReadStream`，不整读几百 MB 的包）复核实际哈希；
  - 配对策略：先按本机架构键，再用文件名别名（`64-bit`/`x64`/`arm64`/`aarch64`…），
    单哈希清单直接用；**多架构配对不出时宁可跳过并记 info**，绝不拿别架构哈希把正确文件判成篡改；
  - 不一致 → **拒绝执行**，报「期望/实际」两个哈希，照旧走 `winget upgrade` 兜底；
  - 更新结果新增 `hash: verified|skipped|mismatch`。
- **兼容模式（legacy loopback）可被任意网页 CSRF 驱动提权安装**（`lib/index.js`）。开启
  `allowLegacyLoopback` 后，第三方网页的 `fetch("http://127.0.0.1:…/update",{mode:"no-cors"})`
  天然不带 Cookie → 过「无凭据才豁免」那条规则 → 无认证触发「下载任意包 + UAC 提权静默安装」。
  现在豁免路径加来源围栏：`Origin`/`Referer` 存在且与 `Host` 不同源、或
  `Sec-Fetch-Site: cross-site`，一律 403（浏览器禁止脚本伪造这些头，判定可靠；本机脚本与
  IPC 桥不带这些头，不受影响）。
- **取消/超时杀不掉提权安装树**（`lib/elevate.js`）。旧实现 Node 侧只能杀**启动器**；
  提权副本与安装器在独立进程树里继续跑，而队列已排到下一个应用（并发双装 + 幽灵安装）。
  现在助手脚本（本身就是提权进程）自己盯 `cancel.flag`（500ms 轮询），看到就
  `taskkill /T /F` 杀整棵安装器树再报告退出码；读不到退出码时按失败处理，绝不伪造 0。
- **「取消后立刻重试」的竞态**（`lib/index.js`）。旧任务 finally 无条件清 `control` 槽位，
  会把新任务句柄清成 null → `/cancel` 声称成功但新任务不可取消，旧半截结果还会覆盖新结果。
  现在 finally 做所有权检查（`control.scanAbort === abort` 才清），被接管的任务结果作废。
- **macOS 更新复核失败仍报「更新完成」**（`lib/engine.js runMacosUpdates`）。
  `brew list` 读空时此前直接 `log success` 且 `entry.ok=true` 无标注；现在与 Windows 准则
  一致：读不到版本 → note 标「未复核：brew list 读不到更新后的版本」+ warn 日志；
  取消/超时优先判错，不给误导性原因。
- **注册表 PowerShell 枚举没有取消通道**（`lib/registry.js`）。扫描取消后仍跑满 60s；
  现在 `spawn({ signal })` 直通，取消立刻杀。
- **`normalizeName` 的 `\b版本\b` 是死分支**（`lib/registry.js`）。JS `\b` 只认 ASCII 边界，
  「版」「本」都是非词字符 → 永不命中 → 「XXX 版本 1.2.3」与 winget 的「XXX」认不成同一条，
  同一软件重复列出。改为字面匹配 `版本`。
- **中文 winget 的落盘行匹配不到**（`lib/engine.js downloadInstaller`）。只认英文
  `Installer downloaded:`，中文系统的「安装程序已下载:」落到不可靠的目录 diff，失手时报
  「没找到安装包」→ 触发兜底**把同一个包再下载一遍**。正则改为中英双语（与
  `classifyWingetError` 一致）。

### 文档

- README / README.en 的执行流程表补充「执行前本地复核哈希（1.3.5 起）」，使承诺与实现一致。

### 测试

- `node test/unit.mjs` **184/184**（+31：自然序 8、清单哈希配对 4、哈希端到端 3、
  来源围栏 9、归一化 2、双语匹配 3、取消检查 2）、`node test/render.mjs` **51/51**、
  `node test/deny.mjs` **12/12**。
- 哈希端到端用 `mkdtemp` 临时目录真算真比：一致 → 通过；不一致 → 拒绝且错误里带两个哈希；
  清单缺哈希 → `skipped` 而不是失败。

## [1.3.4] — 2026-11-01

1.3.3 发布后对着同样几台真实机器做了一轮对抗式复查，修掉 5 个「1.3.3 自己引入或没修干净」的问题。
其中两个会**直接让用户看到错误的结论**（阿里云旧快照导致静默漏报、红色告警横幅永久常驻），
所以单独发一个补丁版本，而不是悄悄混进下一个功能版本。

### 修复

- **阿里云镜像是一份 17 个月前的冻结快照，会把「有更新」静默说成「已是最新」**。
  1.3.3 把 `mirrors.aliyun.com/homebrew/homebrew-bottles/api/cask.json` 放进了并发竞速，
  但实测（`curl -sSI` + 全量比对）：

  | 源 | `Last-Modified` | 大小 | 与官方版本不一致 |
  |---|---|---|---|
  | `formulae.brew.sh`（官方） | 2026-11-01 | 19.3 MB | — |
  | 清华 TUNA | 2026-11-01 | 19.3 MB | — |
  | 中科大 USTC | 2026-11-01 | 19.3 MB | — |
  | 阿里云 | **2025-05-22** | **13.7 MB** | **2908 个 cask 版本落后，1257 个缺失** |

  例如 `1password` 阿里云是 `8.10.76`、官方是 `8.12.42`。它的 JSON 结构同构、不会报错，
  而 `buildMacosItems` 只在 `isNewer(latest, app.version)` 为真时才标记可更新 —— 于是旧数据
  不会误报，而是**静默漏报**，用户看到「0 个可更新」：正是 1.3.3 承诺要消灭的那类沉默失败。
  更糟的是阿里云是国内最快的源，竞速里几乎总是它先返回，**越快越容易中招**。
  现在（`lib/macos.js`）把它从 `CATALOG_URLS` 移除，只保留官方 + 清华 + 中科大三个同步源。

- **红色告警横幅会永久常驻**。1.3.3 新增的横幅渲染的是 `state.scan.warnings`，但
  `warnings` 里混着两条**按设计的日常说明**，而 `includeStoreApps` 默认 `true`：
  - `App Store 应用只列出、不由本插件更新`（`lib/engine.js`）
  - `「包含非 Homebrew 应用」已关闭`（`lib/macos.js`）

  结果每次**完全正常**的扫描也会挂一条 `role="alert"` 红条，把真正的故障（brew 失败 /
  目录抓不到）稀释成噪音。现在这两条改走 `info` 日志，`warnings` 只保留「本次判断依据失效」。

- **扫描整体失败时界面什么也不显示**。`state.scan.error` 在 1.3.2/1.3.3 的界面上**完全没有
  渲染**，扫描抛异常时用户只看到一行「0 个应用」。现在同一条横幅也覆盖它（「检测失败：<原因>」），
  并且 `warnings` 里混入非字符串/空值时不会渲染出错。

- **用户按「取消」会被报成故障**。`runProcess` 在 abort 后返回 `{ok:false, code:null}`，
  1.3.3 的判断会把它写成「Homebrew 更新检查失败（exit null）：本次可能漏报可更新应用」——
  用户主动取消，却收到一条错误。现在 `signal.aborted` 时只记一条 `info`。

- **`brew outdated` 的失败仍可能被吞掉**。1.3.3 用的 `if (outRes.ok || outRes.stdout)` 是
  字符串真值判断：超时被杀但已经吐出半截 JSON 时条件为真 → 解析出 0 条 → **不发警告**，
  与同文件 `listRes` 的 `if (listRes.ok)` 自相矛盾。现在只有 `ok` 才解析，其余一律告警。

### 测试

- **`findBrew` 的断言不再依赖本机环境**：1.3.3 只把返回值糊进一个「null 或两个默认前缀」的
  白名单，而 `findBrew` 的候选里还有 `/home/linuxbrew/.linuxbrew/bin/brew` 且会扫 `$PATH` ——
  在装了 Linuxbrew 的机器上照样红。现在用临时目录构造「有 brew / 没有 brew」两种确定场景，
  验证真正的不变量（**只返回真实存在的文件**），跨平台可跑。
- 新增界面回归测试：警告横幅的出现条件（无警告不出、扫描中不出、整体失败要出、非字符串不崩）。
- 全量：`node test/unit.mjs` **153/153**、`node test/render.mjs` **51/51**、
  `node test/deny.mjs` **12/12**。

## [1.3.3] — 2026-11-01

针对 macOS 真实故障现场（macOS 27.2 / Apple M5 / Homebrew 7.0.11 / Node 24.21.0）的修复。
1.3.2 之后扫描确实会枚举应用了，但当 **Homebrew 自身故障**或**cask 目录抓不下来**时，
界面给出的仍然是「0 个可更新」这种「看起来一切正常」的结论 —— 本次把这两条沉默失败的路径
改成明说，并把「白等两分钟」变成「一秒出结果」。

### 修复

- **Homebrew 命令失败被伪装成「0 个已安装应用」**（实测触发：brew 卡在 Portable Ruby 4.0.9
  的 ghcr.io 下载并持有 `vendor-install-ruby` 锁，此后每条 `brew` 命令都立刻以
  `lockf: 200: already locked` 失败）。旧代码不检查 `ok`，直接解析空 stdout，于是日志写
  「Homebrew 报告 0 个已安装 cask」，真正的错误躺在 stderr 里被丢弃 —— 用户看到的是
  「本机没装任何应用」。现在（`lib/engine.js`）：
  - `brew list --cask --versions` / `brew outdated` 失败时写入扫描警告 + 警告日志，并给出可执行
    的排查提示（「先在终端执行 `brew list --cask` 检查 Homebrew 是否正常」）；
  - 这两条命令的超时放宽到 5 / 10 分钟（慢网络下 brew 首次运行可能真的很慢），
    `brew --version` 放宽到 60 秒。
- **cask 目录在国内网络下必然抓不到**（`formulae.brew.sh/api/cask.json` 有 19 MB，实测
  25 KB/s，120 秒只下到 0.39 MB）。旧实现单源单次 120 秒，于是每次扫描白等两分钟后
  `catalog = null`，所有应用都算不出「可更新」。现在（`lib/macos.js`）：
  - 官方地址 + 清华 TUNA / 中科大 USTC / 阿里云三个镜像 **并发竞速**（`Promise.any`），
    谁先返回用谁，其余立刻 `abort()` 取消；官方仍参与竞速，网络正常时优先用官方数据；
  - 单地址限时 60 秒（原 120 秒）；
  - 全部失败时回退到 **30 天内的过期缓存**兜底（`readCatalogCache` 新增 `allowStale`），
    宁可略旧，也好过整屏「无法判断是否有新版本」；顺带拒绝空数组缓存。
  - 实测：冷启动（无缓存）62 秒 → 42 秒；有缓存时 0.7 秒。
- **扫描警告在界面上不可见**：`state.scan.warnings` 之前只写进 state 与运行日志。目录抓不到时
  用户只看到「0 个可更新」，完全不知道判断依据已经失效。现在（`lib/client.js`）检测完成后若有
  警告，在状态行下方显示红色横幅（复用 `.appupd-banner-warn`）取第一条，多条可展开「查看全部」。

### 测试

- **修掉一条环境相关的既有失败断言**：`findBrew` 在 `HOMEBREW_PREFIX` 之外还会探测
  `/opt/homebrew`、`/usr/local`、`/home/linuxbrew` 等默认位置，因此「装了 Homebrew 的机器」
  上旧断言 `=== null` 必然失败 —— 1.3.2 发布状态下在真实 Mac 上 `npm test` 是 **151/152**。
  现在改成跨平台的存在性断言（覆盖 Apple Silicon / Intel / Linuxbrew 三处默认前缀）。
- 全量：`node test/unit.mjs` **152/152**、`node test/render.mjs` **44/44**、
  `node test/deny.mjs` **12/12**。修完在真实机器上全量扫描：110 个应用、33 个对上 cask、
  0 条警告、耗时 0.7 秒。

### 说明

- 「0 个可更新」在部分机器上仍然**是正确的**：插件只对 Homebrew 管理的应用提供一键更新，
  拖 DMG / 手动装的应用只列出并标 `not-managed`。想让某个应用变成可一键更新，可以用
  `brew install --cask --adopt <token>` 收编（接管现有 `.app`，不重装）。

## [1.3.2] — 2026-11-01

### 修复

- **macOS 上「未检测到任何已安装应用」**（用户实测报告）：1.3.0/1.3.1 的 macOS 扫描只执行
  `brew list --cask --versions`，也就是**只有通过 Homebrew 装过的应用才会出现在列表里**。
  一台正常使用的 Mac 上绝大多数应用是拖 DMG 装的，于是该命令返回空 → 界面显示「未检测到
  任何已安装应用」，日志里是「Homebrew 报告 0 个已安装 cask 应用」。这不是「没有应用」，
  而是**根本没有枚举应用**。现在（`lib/macos.js`）：
  - 枚举标准应用目录里的 `.app`：`/Applications`、`/Applications/Utilities`、
    `/System/Applications`（及其 `Utilities`）、`~/Applications`，用 `plutil` 读每个
    bundle 的 `Info.plist` 取显示名与版本（读不到时退回 `defaults read`）；
  - 抓取 Homebrew 的 cask 目录（`formulae.brew.sh/api/cask.json`，本地缓存 24 小时）把
    `.app` 反查到 cask token，从而知道**官网最新版本**；
  - 只有**确实由 Homebrew 管理**的应用才标记为可一键更新；其余应用如实列出并标注原因
    （`not-managed` 非 Homebrew 管理 / `store-managed` 由 App Store 管理 /
    `system-component` 系统组件），绝不假装能更新。
- **同一个 `.app` 被多个 cask 声明时匹配错乱**：真实目录里 `iterm2` 与 `iterm2@nightly`
  都声明 `iTerm.app`，旧写法「后写覆盖」会让匹配结果随目录顺序漂移（实测会把同一个应用
  列出两次）。现在保留全部候选，由 `pickCask` 按「已装 > 非弃用/停用 > 主 token >
  token 与应用名相等」挑选。
- **没有 Homebrew 也能扫描**：`capabilitiesFor` 不再把「macOS 无 Homebrew」判成不可扫描 ——
  应用照样列出来，只是无法判断/驱动更新，提示改为「安装 Homebrew 后可一键升级 cask 应用」。
- **设置面板按平台显示**：macOS 上不再出现「自动提权安装」「下载失败时回退 winget」
  「包含应用商店应用」（Windows 概念），改为 macOS 专属的「包含 App Store 应用」与
  「包含非 Homebrew 应用」（新增设置项 `includeUnmanagedApps`，默认开启）。
- **空状态文案分平台**：macOS 下列表为空时提示去看运行日志里的「枚举应用目录」记录，
  而不是干巴巴一句「未检测到任何已安装应用」。

### 新增

- **`lib/macos.js`**：应用目录枚举、`Info.plist` 解析、cask 目录缓存与解析、cask 匹配、
  列表合并（纯函数 `buildMacosItems` 便于单测）。
- 日志更细：分别记录「枚举到多少个 .app」「Homebrew 报告多少个 cask」「读取 cask 目录结果」，
  macOS 上再出现异常时一眼能看出断在哪一步。

### 测试

- `test/unit.mjs` 152 项（新增 macOS 应用枚举 20 项、同名 cask 挑选 6 项、cask 目录解析 6 项）；
  用**真实** `formulae.brew.sh/api/cask.json`（7824 个 cask）验证过匹配与去重。
- `test/render.mjs` 44 项（新增 macOS 设置面板 6 项、macOS 空状态文案 2 项）。
- `test/deny.mjs` 12 项不变。

## [1.3.1] — 2026-11-01

### 安全

- **「仅凭回环地址放行」改为默认拒绝**（插件市场 dshopen.org 对 1.3.0 的复核意见）：
  1.3.0 接入 `connection` 准入后仍留了一条退回路径 —— 宿主没有 `connection` 服务，或请求
  不带任何连接凭据且来自回环地址时，直接按「本机信任」放行。在没有准入服务的旧宿主上，
  任何本机进程（以及能向回环发起请求的页面）都能借此调用 `/update`、`/settings` 等安装接口，
  等于绕过认证。1.3.1 起这条路径**默认关闭**：
  - 宿主有 `connection`：一律以 `admit()` 的结果为准，`401` / `403` / `409` 原样返回
    （响应头 `X-DSH-Admission: denied`）。只有「401 + 回环 + 无凭据 + 用户显式开启兼容模式」
    这一种例外，且必须在下面第 2 条的前提下才成立。
  - 宿主没有 `connection`：**默认 403**，不再自动相信回环地址。
- **兼容模式必须由用户显式开启**（保留给确实跑在旧宿主上的用户）：插件配置
  `allowLegacyLoopback: true`（`cordis.patch.yml` 覆盖同名条目）或环境变量
  `DSH_APP_UPDATER_ALLOW_LEGACY_LOOPBACK=1`，两者默认都没有。开启后：
  - 放行的请求带 `X-DSH-Admission: loopback-legacy-optin` 与 `X-DSH-Admission-Warning`；
  - `state.json` / `health.json` 新增 `admission` 字段（`mode` / `service` /
    `allowLegacyLoopback` / `warning`），复核时不必读代码就能确认当前路径；
  - 设置页顶部显示红色警示条，日志写一条 `warn`。
- **准入拒绝统一返回 JSON**：`401`/`403`/`409` 带 `{ ok:false, error, admission:"denied" }`，
  不再用纯文本，排障时能直接看出是被准入挡掉的。

### 测试

- `test/unit.mjs`：准入用例从 6 项扩到 25 项，覆盖兼容模式开关（配置 / 环境变量 / 缺省关闭）、
  无 `connection` 服务默认拒绝、显式开启后放行、非回环仍拒绝、`409`、带凭据未认证不放行等。
- 新增 `test/deny.mjs`：起真实 HTTP 服务，验证无 `connection` 且未开兼容模式时**每一条路由**
  都是 `403 + X-DSH-Admission: denied`；再验证显式开启后放行并标注 opt-in 响应头。
- `test/render.mjs`：新增兼容模式警示条 4 项（开启显示、样式、文案、默认不显示）。
- 自测命令更新为 `node test/unit.mjs && node test/render.mjs && node test/deny.mjs`。

## [1.3.0] — 2026-10-31

### 修复

- **机器级安装全部失败的问题**：进程没有管理员令牌时，MSI 直接失败（msiexec 1603，
  MSI 日志里是 `Error 1925: You do not have sufficient privileges…`），而部分安装器是
  **静默退出 0 却什么都没装**（实测 Logitech G HUB）。两个现象同源，都是权限。
- **安装后复核**：退出码 0 不再等于成功。安装完成后用「安装前版本 / 安装后版本 / 目标版本」
  判断是否真的生效，没生效就如实报失败 —— 原来只看退出码，会把 G HUB 那种
  「退出码 0、版本没变」的情况误报成「更新完成」。
- **架构过滤回退**：`winget download/upgrade --architecture x64` 在清单里没有该架构时现在能
  正确识别（中文报错是「找不到适用的安装程序」，旧正则只匹配了「没有适用」）并退回不限架构
  重试；`winget upgrade` 兜底同时补上 `--include-unknown`（虎牙直播的已装版本被读成 Unknown，
  不带它直接「目录里没有适用的更新」）。
- **Edge**：winget 目录里的 `Microsoft.Edge` 是企业版 MSI，与本机消费版 Edge 的安装技术不匹配，
  winget 直接拒绝（`0x8A15008E`「安装技术与当前安装的版本不同，请卸载包并安装较新版本」），
  现在先走 Edge 自带的更新服务 `MicrosoftEdgeUpdate.exe /ua`；若它没生效（实测该机的
  EdgeUpdate 引擎目录是 `1.3.311.5` 而服务主程序还是 `1.3.275.13`，服务起不来，`/ua` 直接
  `0x80070002`），自动退回安装 winget 目录里的官网全量包（企业版 MSI，提权执行）——
  实测这一步能把 Edge 正常装到目标版本，winget 拒绝执行只是因为它的策略。
- **读不到版本的应用**：虎牙直播的卸载信息里没有版本号，winget 永远显示 `Unknown`。
  复核阶段不再把它误判为失败，改为「已安装、未复核」写进结果与日志。
- **「安装包不生效」的软件给出可操作提示**：实测 Logitech G HUB 的更新包早已下载到
  `%ProgramData%\LGHUB\next.json` 指向的 depots（build 880806 / 2026.7.992920），但安装器
  `--silent` 与 `winget upgrade` 都会在 3 秒内退出 0 且什么都不装，只有**启动 G HUB 本体**
  之后 `current.json` 才跳到新版本。插件承诺不启动用户的软件，所以这类情况现在会在失败
  原因里直接给出「手动打开一次该应用即可完成升级」的提示（`updateHintFor`）。
- **MSI 日志**：MSI 安装现在带 `/l*v <下载目录>\<包名>.msi.log`，失败时把日志路径写进错误信息
  （「Error 1925」就是这么被找到的）。
- **残留清单**：关闭「保留安装包」时，现在连 winget 落盘的 `.yaml` 清单一并删除。

### 新增

- **自动提权安装**（`lib/elevate.js`）：需要管理员的安装类命令交给 `Start-Process -Verb RunAs`
  的提权副本执行，退出码与输出写进临时文件后读回。新增开关「自动提权安装」（默认开启）。
  UAC 为「始终通知」时每次安装会弹一次确认；把 `ConsentPromptBehaviorAdmin` 设为 0
  （管理员静默提权）时完全无感。
- 说明：提权副本是独立进程，取消更新只会停掉启动器，已经开始的那次安装会自己跑完。

### 安全

- **接入宿主 connection 准入**（插件市场 dshopen.org 对 1.2.0 的复核意见）：所有
  `/dsh-app-updater/*` 路由先过 `ctx.connection.admit(request)` —— DSH 用来做 Host/Origin
  信任校验与浏览器会话 / API 认证的那套边界，宿主自己的 `/api` 路由用的就是它。
  未通过准入的请求直接得到 `401`/`403`；带凭据的请求一律以准入结果为准。
  只有在宿主没有 `connection` 服务、或者请求不带任何连接凭据且来自回环地址时，才退回旧的
  「回环」规则，并在响应头标注 `X-DSH-Admission: loopback-legacy`（宿主自己的 Electron
  载体与本机脚本都不带 Cookie，需要一个不误伤它们的路径）。
- 因此 README 里「用 curl 直接改设置」的例子现在需要带上 DSH 的会话 Cookie，或在
  `connection` 不可用的宿主上从回环地址调用。

### 说明

- 读类命令（`winget list` / `upgrade --include-unknown` / `--version`）不提权。
- `update.results[]` 新增 `installOk`（安装器自身是否报成功）与 `manifest`（落盘的清单位置）。

## [1.2.0] — 2026-10-31

### 新增

- **运行环境识别**（`lib/platform.js`）：识别 Windows / macOS / 其它系统、具体版本与名称
  （`Windows 11（build 26300）`、`macOS 15（Sequoia）`）、CPU 架构（ARM64 / x64 / Intel / x86），
  并记录 CPU 型号与线程数。Windows on ARM 上跑 x64 的 Node 时，靠 `PROCESSOR_ARCHITEW6432`
  仍能还原出真实架构，而不是被骗成 x64。
- **按架构挑选安装包**：Windows 侧把识别到的架构传给 winget 的 `--architecture`，让「官网全量包」
  与当前系统/芯片匹配；清单里没有该架构的安装包时自动退回自动匹配，并在日志里说明。
  macOS 侧由 Homebrew 按本机架构取对应 cask。新增开关「按本机架构安装包」（默认开启）。
- **macOS 更新引擎（Homebrew cask）**：用 `brew list --cask --versions` 拿已装版本、
  `brew outdated --json=v2 --cask --greedy` 拿可升级版本，`brew upgrade --cask <token>` 更新；
  演练模式改用 `brew fetch --cask <token>`，只下载安装包不安装。没有 Homebrew 时明确报告
  「不可用」，而不是假装能更新。
- **界面**：状态行与设置面板新增「运行环境」（系统 · 架构 · 引擎）；引擎不可用时红字给出原因；
  应用来源新增 `homebrew` 徽章。
- `/health.json` 增加 `version` / `env` / `envSummary` / `engine` / `capabilities`；
  `state.json` 同步带出这些字段。

### 说明

- macOS 路径无法在开发机（Windows）上真机验证，因此识别与 Homebrew 输出解析均以注入式单测覆盖
  （`test/unit.mjs` 共 66 项），安装/更新命令按 Homebrew 官方 CLI 行为编写。
- 扫描/更新接口按平台放行：Windows 与 macOS 通过，其它系统返回 400 并说明原因。

## [1.0.0] — 2026-10-31

首个可用版本。

### 检测

- 用 `winget list` 列出已安装应用（含 winget 目录收录的软件与商店 / MSIX 包），并用注册表三处
  `Uninstall` 键补齐 winget 目录未收录的软件。全程只读注册表与文件，**不启动任何被检测的应用**。
- 用 `winget upgrade --include-unknown` 取「已装版本 → 可升级版本」，按包 Id 与清单合并。
- 版本比较支持 Windows 风格的 `1.2.3.4`、日期风格 `2026.7.992920`、带后缀 `0.9.2+2026103013`
  以及 `1.2.3-beta` 这类预发布标记。
- 定宽表格解析按**显示宽度**切列（CJK 占 2 列），并剔除 `15 upgrades available.` 之类的尾部提示行。

### 更新

- 一键更新链路：`winget download` 从**发布方官网**拉取**完整安装包**（下载时核对清单里的 SHA-256）→
  解析随包落盘的 winget 清单，取发布方自己声明的 `InstallerSwitches.Silent` →
  静默安装 → 用 `winget list --id` 复核安装后版本。
- 官网包哈希与目录记录不一致（发布方重签了安装包）或清单禁止直接下载时，自动退回
  `winget upgrade --id … --exact --silent`（同源全量包，下载与安装交给 winget）。
- 安装包与清单留档在下载目录，便于核对来源；可关闭「保留安装包」在安装后自动清理。
- 需要管理员权限的安装包会正常弹出 UAC，插件不做静默提权。

### 界面

- 设置 → 应用更新：工具条（刷新检测 / 全部更新 / 更新所选 / 取消 / 打开下载目录）、
  状态行、进度条、筛选行、应用表格、可折叠日志。
- 表格列宽默认给足以完整显示应用名，并且**每列可拖拽调宽、双击恢复默认**，偏好记在浏览器本地。
- 插件设置面板：安装包下载目录（含绝对路径校验）、保留安装包、演练模式、下载失败回退 winget、
  包含商店应用、包含目录未收录应用。演练模式开启时页面顶部有醒目提示。
- 全部写操作要求本机（loopback）来源并显式带 `confirm:true`。