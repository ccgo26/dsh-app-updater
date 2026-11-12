/**
 * 1.3.16 Windows 更新失败现场回放（红测）。
 *
 * 只在本机能复现：读 ~/.dsh/dsh-app-updater/state.json 的 update.results / log，
 * 断言四类症状真实存在；若提供 1.3.15 / 1.3.16 的 engine.js 路径，还断言
 * 「Windows 更新路径在这两版之间零改动」。
 *
 * 可移植：缺文件时相关断言自动 SKIP，退出码仍为 0，不会让 CI / 别人的机器挂掉。
 * 用法：
 *   node test/repro-1316.mjs
 *   DSH_UPDATER_STATE=<state.json> DSH_ENGINE_1315=<engine.js> DSH_ENGINE_1316=<engine.js> node test/repro-1316.mjs
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const statePath = process.env.DSH_UPDATER_STATE || join(homedir(), ".dsh", "dsh-app-updater", "state.json");
const v15Path = process.env.DSH_ENGINE_1315 || join(here, "..", ".fixtures", "engine-1.3.15.js");
const v16Path = process.env.DSH_ENGINE_1316 || join(here, "..", ".fixtures", "engine-1.3.16.js");

let pass = 0, fail = 0, skip = 0;
function ok(cond, label) { if (cond) { pass++; console.log("  PASS " + label); } else { fail++; console.log("  FAIL " + label); } }
function skipped(label) { skip++; console.log("  SKIP " + label); }

if (!existsSync(statePath)) {
  console.log("=== 现场回放：无本机 state.json，跳过 ===");
  console.log("  提示：设置 DSH_UPDATER_STATE 指向插件状态文件即可重放现场。");
  console.log(`\n=== 结果：${pass} passed, ${fail} failed, ${skip} skipped ===`);
  process.exit(0);
}

const state = JSON.parse(readFileSync(statePath, "utf8"));
const results = (state.update && state.update.results) || [];
const logText = (state.log || []).map((l) => l.text).join("\n");

console.log("=== 现场回放：上次更新结果 ===");
for (const r of results) console.log(`  ${r.ok ? "OK  " : "FAIL"} ${r.id}: ${r.error}`);
if (results.length) {
  ok(results.length === 4, "上次更新共 4 项");
  ok(results.every((r) => r.ok === false), "4 项全部失败（成功 0/4）");
  const byId = new Map(results.map((r) => [r.id, r]));
  ok(/退出码 1/.test(byId.get("DeepSeek.DeepSeekHarnessDesktop")?.error || ""), "DeepSeek Harness：安装器退出码 1");
  ok(/哈希与软件目录记录不一致/.test(byId.get("Google.Chrome")?.error || ""), "Chrome：哈希不一致");
  ok(/软件目录里找不到该包/.test(byId.get("Microsoft.VCRedist.2015+.arm64")?.error || ""), "VCRedist.arm64：目录里找不到该包");
  ok(/Forbidden \(403\)/.test(byId.get("NetEase.UURemote")?.error || ""), "UURemote：Forbidden (403)");
  console.log("=== 兜底重复报错 ===");
  ok(results.some((r) => { const e = String(r.error || ""); const i = e.indexOf("；兜底失败："); return i > 0 && e.slice(0, i) === e.slice(i + 6); }), "至少一项：兜底错误与主错误完全相同");
} else { skipped("state.json 里没有 update.results"); }

console.log("=== 版本历史：Windows 路径零改动 ===");
if (existsSync(v15Path) && existsSync(v16Path)) {
  const a = readFileSync(v15Path, "utf8"), b = readFileSync(v16Path, "utf8");
  const win = (s) => s.split("\n").slice(0, 1501).join("\n");
  ok(win(a) === win(b), "1.3.15 与 1.3.16 的 engine.js Windows 段（1-1501 行）逐字节相同");
  ok(a !== b, "engine.js 整体确实有改动（macOS 段）");
} else { skipped("未提供 1.3.15 / 1.3.16 engine.js，跳过逐字节比对"); }

console.log("=== 早于 1.3.16 的同款失败 ===");
if (logText) {
  ok(/退出码 1；兜底失败/.test(logText), "历史批次已出现同款「退出码 1」失败");
  ok(/哈希与软件目录记录不一致/.test(logText), "历史批次已出现同款哈希不一致");
  ok(/Forbidden \(403\)/.test(logText), "历史批次已出现同款 403");
} else { skipped("state.json 里没有日志"); }

console.log(`\n=== 结果：${pass} passed, ${fail} failed, ${skip} skipped ===`);
process.exit(fail ? 1 : 0);