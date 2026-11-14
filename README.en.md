# dsh-app-updater — App Updater for DeepSeek Harness

**English** | [简体中文](README.md)
[![npm](https://img.shields.io/npm/v/dsh-app-updater?style=flat-square&label=npm&color=0891b2&logo=npm)](https://www.npmjs.com/package/dsh-app-updater)
![license](https://img.shields.io/badge/license-MIT-2f6f4f?style=flat-square)
![platform](https://img.shields.io/badge/platform-Windows-7da1de?style=flat-square)
![dsh-plugin](https://img.shields.io/badge/DSH-plugin-263146?style=flat-square)


Detect every installed application that has a newer version, then update them
with one click — downloading the **full installer from each vendor's own website** and
installing it silently. **The detected applications are never launched.**
Windows (winget) and macOS (Homebrew), architecture-aware: ARM64 and x64/Intel installers are
chosen to match the machine.

Where to find it: DeepSeek Harness → Settings → **应用更新 (App Updater)**

## Install

```bash
# npm package (recommended; also one-click installable from the plugin center)
dsh plugin --profile web add dsh-app-updater
```

Without npm, install from source or from the prebuilt tarball:

```bash
# source repository
dsh plugin --profile web add github:ccgo26/dsh-app-updater

# prebuilt tgz (see Releases)
dsh plugin --profile web add https://github.com/ccgo26/dsh-app-updater/releases/latest/download/dsh-app-updater.tgz
```

Restart DSH afterwards; the plugin lives at **Settings → 应用更新**. The Electron-managed
`desktop` profile does not accept `dsh plugin` writes, so link the package into that
profile's `node_modules` and add it to `dsh.profile.bundles` manually.

---

## What it actually does

| Step | How |
|---|---|
| 1. List installed apps | `winget list` (apps known to the winget catalog plus Store/MSIX packages) **and** the three Windows registry `Uninstall` keys (apps the catalog does not know). Read-only: no application is ever started. |
| 2. Decide whether an update exists | `winget upgrade --include-unknown` gives "installed version → available version" from the official winget catalog, merged into the inventory by package id. |
| 3. One-click update | `winget download` fetches the **vendor's full installer** from the URL recorded in the winget manifest (SHA-256 verified by winget), the plugin **re-checks the hash locally before executing the file** (since 1.3.5 — the installer is about to run, possibly elevated, so a swapped or corrupted download is refused and the fallback path is taken), the downloaded manifest supplies the publisher's own `InstallerSwitches.Silent`, the installer runs silently, and the resulting version is re-read with `winget list --id`. |
| 4. Fallback | If the vendor re-signed the installer (hash no longer matches the catalog) or the manifest forbids direct download, it falls back to `winget upgrade --id … --exact --silent` — still the full installer from the vendor, with winget doing the fetching and installing. |

Those download URLs really are the vendors' own: `github.com/git-for-windows/…`,
`dl.google.com/dl/chrome/install/…`, `download.cpuid.com/cpu-z/…`, `dl.hdslb.com/…`.
Both the installer and its `.yaml` manifest are kept in the download folder, so the
`InstallerUrl`, `InstallerSha256` and silent switches can be audited afterwards.

---

## Usage

1. Open **Settings → 应用更新**.
2. Click **刷新检测** (nothing runs in the background; scanning only happens when you ask).
3. The table sorts updateable apps first. Use the search box and the
   **全部 / 仅可更新 / 未收录** segments to narrow it down.
4. Tick the apps to update (or press **全部更新**), or update a single app from its row.
5. While updating you get a progress bar, the current app name and a per-item log;
   **取消** stops the items that have not started yet.
6. **打开下载目录** reveals the downloaded vendor installers in Explorer.

### Status values

| Status | Meaning |
|---|---|
| **有新版本** | The catalog reports a higher version; one-click update is available. |
| **已是最新** | No newer version in the catalog. |
| **未收录** | An update exists in the catalog but this plugin cannot drive it (see reasons below). |

| Reason | Meaning |
|---|---|
| 软件目录未收录 | The app is not in the winget catalog (registry-only software), so its official update cannot be discovered or downloaded. |
| 由应用商店管理 | MSIX / Store app — update it through Microsoft Store. |
| 版本未知 | The installed version cannot be read (winget reports `Unknown`); updating is still allowed. |
| 系统组件 | System component / runtime; not driven by this plugin by default. |

---

## Settings

State file: `%USERPROFILE%\.dsh\dsh-app-updater\state.json`

| Key | Default | Meaning |
|---|---|---|
| `includeStoreApps` | `true` | List store apps too (MSIX on Windows, App Store on macOS; display only). |
| `includeRegistryOnly` | `true` | Windows: fill in apps missing from the winget catalog using the registry (display only). |
| `includeUnmanagedApps` | `true` | macOS: also list apps that Homebrew does not manage (drag-to-Applications installs; display only). |
| `downloadDir` | empty | Custom download folder; empty = `%USERPROFILE%\Downloads\DSH App Updater`. Must be absolute. |
| `keepInstallers` | `true` | Keep the installer after a successful update. |
| `hashFallbackUpgrade` | `true` | Fall back to `winget upgrade` when the download fails. |
| `dryRun` | `false` | **Rehearsal mode**: download the vendor's full installer but never install it. |
| `matchSystemArch` | `true` | Match the installer to the detected system and CPU architecture (Windows passes `--architecture`; macOS is resolved by Homebrew). |
| `autoElevate` | `true` | **Automatic elevation**: install commands that need administrator rights run in an elevated copy (UAC prompts once per install, when UAC prompts at all). |

Everything above is editable from the plugin's own settings panel inside the settings page.
The panel also accepts API calls:

```bash
curl -X POST -H "Content-Type: application/json" \
  -d '{"confirm":true,"settings":{"dryRun":true}}' \
  http://127.0.0.1:<port>/dsh-app-updater/settings
```

---

## Safety boundaries

- **Every route is deny-by-default**: each request first goes through `ctx.connection.admit(request)`
  — DSH's Host/Origin fence plus browser-session / API authentication, the same gate the host uses for
  its own `/api` routes. Rejected requests get `401` / `403` / `409` with `X-DSH-Admission: denied`.
- **Legacy loopback mode is off by default** (since 1.3.1): when the host has no `connection`
  service, requests are no longer trusted just because they come from loopback — they get `403`.
  If you really need it on an old host, opt in explicitly, either via plugin config:

  ```yaml
  - id: dsh-app-updater
    config:
      allowLegacyLoopback: true
  ```

  or by exporting `DSH_APP_UPDATER_ALLOW_LEGACY_LOOPBACK=1` before starting DSH. Once enabled, allowed
  requests carry `X-DSH-Admission: loopback-legacy-optin` and `X-DSH-Admission-Warning`, the
  `admission` field in `state.json` / `health.json` reports `mode: "loopback-legacy-optin"`, the
  settings page shows a red banner, and a `warn` line is written to the log.
- **Cross-site fence on the legacy exemption (since 1.3.5)**: even when the opt-in is enabled, a
  loopback request is rejected (`403`) when it looks browser-originated and cross-site — an
  `Origin` / `Referer` whose host differs from the request `Host`, or `Sec-Fetch-Site: cross-site`.
  Browsers forbid scripts from forging these headers, so the check is reliable: an arbitrary web
  page can no longer drive "download + elevated silent install" with a cookie-less `fetch(…/update)`.
  Local scripts and the host's IPC bridge (which send none of these headers) are unaffected.
- **The installer hash is re-checked locally before running (since 1.3.5)**: after `winget download`,
  the plugin recomputes SHA-256 over the on-disk file against the manifest's `InstallerSha256`
  before executing it (streaming, so a 500 MB package is not read into memory). That file is about
  to run, possibly elevated, so a swapped or corrupted download is refused and the fallback taken.
  When the manifest has no hash pairable to this machine's architecture, the check is skipped and
  logged — never judged against another architecture's hash.
- **Every write still requires explicit confirmation**: `scan` / `update` / `cancel` /
  `settings` / `open-downloads` require `confirm:true`.
- **No guessed silent switches**: the publisher's declared `Silent` switches are preferred;
  generic defaults are used only when a manifest is unavailable.
- **Elevation only for installs, and on demand**: install commands that need administrator rights
  (MSI packages, installers writing into `Program Files`, the `winget upgrade` fallback) run in an
  elevated copy through `Start-Process -Verb RunAs`. With UAC set to "always notify" you get one
  prompt per install; with `ConsentPromptBehaviorAdmin = 0` it is completely silent. Reads
  (`winget list` / `upgrade --include-unknown` / `--version`) never elevate.
- **A zero exit code is not success**: after installing, the plugin compares the installed version
  against the target version and reports a failure when nothing actually changed — machine-scope
  installers silently exit 0 without installing anything when they lack administrator rights
  (Logitech G HUB used to be reported as "updated" that way).
- **System components** (`.NET`, VC++ runtimes, …) are listed but not updated by default.
- **Only its own directory is written**: state and logs live in `~/.dsh/dsh-app-updater/`.

## Requirements

- **Windows**: `winget.exe` (Microsoft App Installer). Without winget the plugin can still
  list registry apps, but cannot tell whether they are up to date.
- **macOS**: no extra dependency is needed to **list** apps (the plugin reads `.app` bundles from
  `/Applications` and friends); judging and applying updates needs `brew` ([Homebrew](https://brew.sh)).
  Without Homebrew the apps are still listed, with a note that installing Homebrew enables one-click
  cask upgrades.
- No third-party npm dependencies: the host half uses Node built-ins only, the browser half
  only the host-provided `react`.

## Supported systems and architectures

The plugin detects its own environment at startup and picks the installer that matches it:

| System | Architecture | Engine | Notes |
|---|---|---|---|
| Windows 10 / 11 | x64 / ARM64 / x86 | **winget** | the detected architecture is passed as `winget --architecture`; if the manifest has no installer for it, the plugin falls back to automatic matching and says so in the log |
| macOS 11+ | Apple Silicon / Intel | **Homebrew casks** | apps are enumerated from `/Applications` and friends, then matched against the cask catalog; Homebrew resolves the right cask for the machine. Without Homebrew the apps are still listed, they just cannot be upgraded in one click |
| anything else | — | none | the scan/update routes answer 400 with the reason |

The result is shown in the status line and in the settings panel's “运行环境 / Environment” row, e.g.
`Windows 11（build 26300） · x64（AMD64） · winget 1.29.380` or
`macOS 15（Sequoia） · Apple Silicon（ARM64） · Homebrew 4.5.0`.

The “按本机架构安装包 / match system architecture” switch (on by default) can be turned off to hand
the choice back to winget; Homebrew always resolves for the local architecture.

> The macOS app enumeration (`/Applications` + `Info.plist`) and cask matching are covered by unit
> tests and were validated against the real `formulae.brew.sh` catalog (7,800+ casks), but the
> macOS **install/update execution** has not been verified on a real Mac — this plugin is developed
> on Windows. Please open an issue if something misbehaves there.
>
> Only the standard application directories are enumerated. Apps installed elsewhere (a custom
> folder, the Desktop, an external volume) are outside the scan scope by design.

## HTTP API (host half)

| Method | Path | Purpose |
|---|---|---|
| GET | `/dsh-app-updater/state.json` | Status, inventory, log, settings |
| GET | `/dsh-app-updater/apps.json` | Inventory and statistics only |
| GET | `/dsh-app-updater/health.json` | Self-check: version, environment, engine, capabilities, route count, data directory |
| POST | `/dsh-app-updater/scan` | `{confirm:true, force:true}` start scanning |
| POST | `/dsh-app-updater/update` | `{confirm:true, ids:[...]}` start the update queue |
| POST | `/dsh-app-updater/cancel` | `{confirm:true}` cancel items not yet started |
| POST | `/dsh-app-updater/settings` | `{confirm:true, settings:{...}}` |
| POST | `/dsh-app-updater/open-downloads` | `{confirm:true}` open the download folder |

## Install (from a checkout)

```bash
# from a local checkout
dsh plugin --profile <profile> add file:/path/to/dsh-app-updater

# or as a local link
dsh plugin --profile <profile> add link:/path/to/dsh-app-updater
```

Then add `dsh-app-updater` to `dsh.profile.bundles` in the profile's `package.json`
(the bundled `cordis.patch.yml` mounts the host half) and reload DSH.

## Uninstall

1. Remove `dsh-app-updater` from `dsh.profile.bundles` and from `dependencies` in the profile's `package.json`.
2. Delete `<profile>/node_modules/dsh-app-updater`.
3. Restart DSH; the data directory `%USERPROFILE%\.dsh\dsh-app-updater` can be removed as well.

## 1.3.16 performance (vs. 1.3.15)

- macOS "Update All" is now two-phase, mirroring the Windows path: a concurrent
  `brew fetch --cask` pre-download stage (concurrency 3, into Homebrew's own download
  cache) followed by the existing strictly-serial `brew upgrade` / `install --force`
  loop, so installs hit the cache and only install+verify work remains. Verdicts and
  success/failure semantics are unchanged.
- Pre-checks (download-source probe, pkg-sudo detection) moved out of the serial loop
  and run concurrently; skip messages are preserved verbatim.
- brew progress lines (`==> Downloading / Installing / Moving…`) are forwarded into the
  run log (deduplicated) — a multi-minute update is no longer a "0/3 0%" black box.
- macOS scan runs its three independent stages concurrently (app enumeration, brew
  triple, cask catalog race); per-stage timing logs added.

## 1.3.15 hardening (vs. 1.3.14)

- Host half now explicitly validates `method === "POST"` on write routes (405 otherwise) and
  requires a process-local `csrfToken` (delivered by `GET /state.json`, never persisted) in
  addition to `confirm:true`.
- Downloads are pre-fetched concurrently into private working directories (no shared-directory
  diff race); a 4 GiB quota only removes files carrying the plugin's `.dsh-app-updater` sidecar.
- Post-install verification uses immediate-first + exponential backoff + a total time limit;
  `unverifiable` is now an explicit result state. Uninstall aborts background tasks.
- Version parsing follows SemVer `+build`, is case-insensitive on suffixes, and no longer
  collides in `normalizeVersionKey`. `StringDecoder` and POSIX process-group cancellation were
  added to the process layer.
- See `CHANGELOG.md` for the full list and `CONTRACT.md` for the current HTTP contract.

## Tests

```bash
npm test                       # = unit + render + deny; the live output is authoritative for check counts
node test/unit.mjs              # table parsing, version compare, manifest & switches, OS/arch detection, Homebrew parsing, macOS enumeration, admission gate
node test/render.mjs            # settings panel (per platform), banners, column drag, request bodies, result panel
node test/deny.mjs              # deny-by-default per route + CSRF / method gates
node test/harness.mjs --scan    # boots the host half against a fake cordis ctx + real HTTP (print-only, not a scored test)
```

> Historic check counts in older docs (e.g. `153 / 51 / 12`) are stale — **always trust `npm test` output**.

> The tests do not depend on whether Homebrew is installed locally: the `findBrew` assertion checks
> existence across the three default prefixes (Apple Silicon / Intel / Linuxbrew), so it stays green
> on a real Mac (1.3.2 and earlier hard-coded `=== null` and was always red there; fixed in 1.3.3).

## Layout

| File | Purpose |
|---|---|
| `lib/index.js` | Host half: HTTP routes, write gate, scan/update scheduling |
| `lib/engine.js` | Inventory merge, vendor installer download, silent install, winget fallback, version re-check |
| `lib/winget.js` | winget discovery/invocation, fixed-width table parsing (CJK-aware) |
| `lib/registry.js` | Registry `Uninstall` enumeration (PowerShell, UTF-8) |
| `lib/version.js` | Windows-style version comparison |
| `lib/plugin-version.js` | 1.4.0: plugin version/date lookup, npm registry comparison, self-update command builder |
| `lib/source-failures.js` | 1.4.1: 403 download-source failure ledger and "needs manual" downgrade (pure functions) |
| `lib/state.js` | Settings and state persistence (atomic writes) |
| `lib/proc.js` | Child process runner (timeouts, cancellation, UTF-8) |
| `lib/client.js` | Browser half: the settings page UI (incl. the bottom version-info section) |
| `CONTRACT.md` | Host ↔ client interface contract |

## License

MIT