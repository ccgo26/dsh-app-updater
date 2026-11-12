/**
 * Windows 提权执行。
 *
 * 为什么需要它：winget 目录里的「官网全量包」有一大半是**机器级**安装 —— MSI 要
 * 写 HKLM / Program Files，安装器要往 Program Files 落文件。进程没有管理员令牌
 * 时有两种失败方式：
 *  1) MSI 直接失败（msiexec 返回 1603，MSI 日志里是 Error 1925「权限不足」）；
 *  2) 安装器**静默退出 0 却什么都没装**（实测 Logitech G HUB）。
 * 第 2 种最坑：只看退出码就会误报「更新成功」，所以安装之后必须复核版本
 * （见 engine.js 的 verifyInstalled）。
 *
 * Windows 的进程令牌创建后无法原地提升，因此这里把**一条命令**写进临时
 * PowerShell 助手脚本，用 `Start-Process -Verb RunAs` 在提权副本里执行，再把
 * 退出码与输出回传到文件后读回。两个脚本都写成 UTF-8 **带 BOM**：Windows
 * PowerShell 5.1 读 .ps1 时若无 BOM 会按本地代码页解码，中文路径会乱。
 */

import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runProcess } from "./proc.js";

const PS_PROBE_TIMEOUT_MS = 20000;

/** Windows 取消提权的退出码（ERROR_CANCELLED）。 */
export const ELEVATION_CANCELLED = 1223;

/** PowerShell 单引号字面量：内部的 `'` 要写成 `''`。 */
export function psQuote(value) {
  return `'${String(value == null ? "" : value).replace(/'/g, "''")}'`;
}

/** Windows PowerShell 5.1 的绝对路径。 */
export function powershellPath(env = process.env) {
  const root = env.SystemRoot || env.windir || "C:\\Windows";
  return join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

/** 本机是否有可用的 PowerShell（没有它就无法提权）。 */
export function elevationAvailable(env = process.env) {
  try {
    return existsSync(powershellPath(env));
  } catch {
    return false;
  }
}

let cachedElevated = null;

/** 清掉「是否已提权」的缓存（单元测试与提权后复核用）。 */
export function resetElevationCache() {
  cachedElevated = null;
}

/**
 * 当前进程是否在管理员上下文里。
 * 非 Windows 平台按 uid==0 判断（macOS 的 brew 永远不需要提权）。
 */
export async function isElevated(opts = {}) {
  if (cachedElevated !== null && !opts.refresh) return cachedElevated;
  if (process.platform !== "win32") {
    /* 原来「没有 process.getuid 就返回 true」语义不严谨：拿不到 uid 时应视为
       「无法确认已提权」而不是「已提权」。macOS 分支在 engine 里直接按 true 处理，
       不依赖这里，所以此改动不影响主流程。 */
    cachedElevated = typeof process.getuid === "function" ? process.getuid() === 0 : false;
    return cachedElevated;
  }
  if (!elevationAvailable()) {
    cachedElevated = false;
    return cachedElevated;
  }
  const res = await runProcess(
    powershellPath(),
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      "[Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)",
    ],
    { timeoutMs: PS_PROBE_TIMEOUT_MS, signal: opts.signal }
  );
  cachedElevated = res.ok && /true/i.test(res.stdout);
  return cachedElevated;
}

function stripBom(text) {
  return String(text || "").replace(/^\ufeff/, "");
}

/**
 * 在提权副本里执行一条命令。
 *
 * 返回结构与 proc.js 的 runProcess 一致（外加 cancelled），因此调用方可以
 * 无差别地把它当成「另一个 runProcess」。
 *
 * @param {string} exe 绝对路径
 * @param {string[]} args 参数数组
 * @param {{ timeoutMs?: number, signal?: AbortSignal }} [opts]
 * @returns {Promise<{ok:boolean, code:number|null, stdout:string, stderr:string, timedOut:boolean, spawnError:string|null, cancelled:boolean}>}
 */
export async function runElevated(exe, args, opts = {}) {
  const timeoutMs = opts.timeoutMs || 60 * 60 * 1000;
  const fail = (spawnError) => ({
    ok: false,
    code: null,
    stdout: "",
    stderr: "",
    timedOut: false,
    spawnError,
    cancelled: false,
  });

  if (process.platform !== "win32") return fail("非 Windows 平台不支持提权执行");
  if (!elevationAvailable()) return fail("未找到 powershell.exe，无法提权执行");

  const ps = powershellPath();
  const dir = await mkdtemp(join(tmpdir(), "dsh-app-updater-elev-"));
  const outFile = join(dir, "out.txt");
  const errFile = join(dir, "err.txt");
  const codeFile = join(dir, "code.txt");
  const cancelFile = join(dir, "cancel.flag");
  const helperFile = join(dir, "helper.ps1");
  const launchFile = join(dir, "launch.ps1");

  /**
   * 助手脚本（提权副本里执行）。1.3.5 起改为「Start-Process + 轮询取消标记 + 杀进程树」：
   * 旧写法 `& $exe` 同步阻塞，Node 侧取消/超时只能杀掉**启动器**——提权副本与安装器
   * 在独立进程树里继续跑，队列却已进入下一个应用（并发双装 + 幽灵安装）。
   * 助手自己就是提权进程，只有它杀得动自己启动的安装器树，所以取消通道放这里：
   * Node 落一个 cancel.flag，助手 500ms 内看到就 taskkill /T /F 整棵树再收尾。
   * PS 5.1 的 Start-Process -ArgumentList 给带空格参数不加引号，先手工包引号。
   */
  const helper = [
    "$ErrorActionPreference = 'Continue'",
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    "$OutputEncoding = [System.Text.Encoding]::UTF8",
    `$exe = ${psQuote(exe)}`,
    `$argv = @(${(args || []).map(psQuote).join(", ")})`,
    "$argv = @($argv | ForEach-Object { if (\"$_\" -match '\\s') { '\"' + $_ + '\"' } else { $_ } })",
    `$cancelFile = ${psQuote(cancelFile)}`,
    "$pi = $null",
    "try {",
    `  $pi = Start-Process -FilePath $exe -ArgumentList $argv -PassThru -WindowStyle Hidden -RedirectStandardOutput ${psQuote(outFile)} -RedirectStandardError ${psQuote(errFile)}`,
    "} catch {",
    `  Set-Content -Path ${psQuote(codeFile)} -Value 1 -Encoding ASCII`,
    "  exit 1",
    "}",
    "while (-not $pi.WaitForExit(500)) {",
    "  if (Test-Path $cancelFile) {",
    "    & taskkill.exe /PID $pi.Id /T /F 2>&1 | Out-Null",
    "    $pi.WaitForExit(10000) | Out-Null",
    "    break",
    "  }",
    "}",
    /* 先等进程真正退出并刷新，否则 Start-Process -PassThru 的 ExitCode 可能是缓存的旧值。 */
    "$pi.WaitForExit() | Out-Null",
    "$pi.Refresh()",
    "$code = $pi.ExitCode",
    // 读不到退出码时按失败处理（1）：宁可多走一次 winget upgrade 兜底，
    // 也不能伪造「退出码 0」让上层把没装成的东西判成成功。
    "if ($null -eq $code) { $code = 1 }",
    /* 1.3.17 修坑：winget 的失败码是 0x8A15002B 这类大无符号 32 位值，
       PowerShell 的 $pi.ExitCode 是 Int32（负数），ASCII 写十进制会丢上位，
       engine.js 里 (code>>>0)===0x8a15002b 的特判因此永远不命中。
       统一转成无符号十六进制字符串写盘，读侧按 parseInt(hex,16) 还原。 */
    `$hex = ('{0:X8}' -f ([uint32]($code -band 0xFFFFFFFF)))`,
    `Set-Content -Path ${psQuote(codeFile)} -Value $hex -Encoding ASCII`,
    // 保持旧版 2>&1 的现场：stderr 并入 out
    `if (Test-Path ${psQuote(errFile)}) { $e = Get-Content -Raw ${psQuote(errFile)}; if ($e) { Add-Content -Path ${psQuote(outFile)} -Value $e } }`,
    "exit $code",
    "",
  ].join("\r\n");

  // 启动器只负责「把助手脚本以管理员身份跑起来并等它退出」。取消/杀进程的职责全在
  // 助手（它是提权进程，杀得动安装器树）；启动器被 Node 杀掉也带不死助手，助手会
  // 自己看到 cancel.flag 收尾并写退出码。不用 -Wait：那会让「杀启动器」把取消通道一起带走。
  const launch = [
    "$ErrorActionPreference = 'Stop'",
    "try {",
    `  $p = Start-Process -FilePath ${psQuote(ps)} -ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File', ${psQuote(helperFile)}) -Verb RunAs -WindowStyle Hidden -PassThru`,
    `} catch { exit ${ELEVATION_CANCELLED} }`,
    `if ($null -eq $p) { exit ${ELEVATION_CANCELLED} }`,
    "while (-not $p.WaitForExit(1000)) {}",
    "$c = $null",
    "try { $c = $p.ExitCode } catch {}",
    "if ($null -eq $c) { exit 1 }",
    "exit $c",
    "",
  ].join("\r\n");

  try {
    await writeFile(helperFile, `\ufeff${helper}`, "utf8");
    await writeFile(launchFile, `\ufeff${launch}`, "utf8");
  } catch (err) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    return fail(String((err && err.message) || err));
  }

  // 取消通道：signal 触发时落一个 cancel.flag，提权副本里的助手 500ms 内看到
  // 就把安装器进程树杀掉（taskkill /T /F）并报告退出码。没有这一步，取消/超时
  // 只会杀掉启动器，安装器在提权树里继续跑，而队列已经排到下一个应用。
  let onCancel = null;
  if (opts.signal) {
    onCancel = () => {
      writeFile(cancelFile, "1", "utf8").catch(() => {});
    };
    if (opts.signal.aborted) onCancel();
    else opts.signal.addEventListener("abort", onCancel, { once: true });
  }

  const res = await runProcess(
    ps,
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", launchFile],
    { timeoutMs, signal: opts.signal }
  );
  // 超时同样走取消通道（runProcess 的超时杀的是启动器；助手要等它自己轮询退出）
  if (res.timedOut && onCancel) onCancel();
  if (opts.signal && onCancel) opts.signal.removeEventListener("abort", onCancel);

  let stdout = "";
  try {
    stdout = stripBom(await readFile(outFile, "utf8"));
  } catch {
    // 安装器没有产出任何输出：正常（GUI 安装包），失败原因由退出码与 MSI 日志给
  }

  let code = res.code;
  let reported = false;
  try {
    const raw = stripBom(await readFile(codeFile, "utf8")).trim();
    /* 1.3.17：提权副本写 8 位无符号十六进制（保住 0x8A15002B 这类大码）；
       兼容旧副本遗留的十进制文本。 */
    if (/^[0-9A-Fa-f]{8}$/.test(raw)) {
      const unsigned = parseInt(raw, 16);
      code = unsigned > 0x7fffffff ? unsigned - 0x100000000 : unsigned;
      reported = true;
    } else if (/^-?\d+$/.test(raw)) {
      code = Number(raw);
      reported = true;
    }
  } catch {
    // 提权副本没能跑到写退出码那一步
  }

  // 超时时提权副本可能还在跑（安装器），保留临时目录不删，避免动到正在执行的脚本
  if (!res.timedOut) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }

  const cancelled = res.code === ELEVATION_CANCELLED || code === ELEVATION_CANCELLED;
  const spawnError = res.spawnError
    ? res.spawnError
    : cancelled
      ? "提权被拒绝（UAC 被取消）"
      : !reported && !res.timedOut && code !== 0
        ? "提权副本未能报告退出码（可能被 UAC 拒绝）"
        : null;

  return {
    ok: !res.timedOut && !spawnError && code === 0,
    code,
    stdout,
    stderr: "",
    timedOut: res.timedOut,
    spawnError,
    cancelled,
  };
}