/**
 * 1.4.3 现场回放 + 回归（红→绿）：兜底明明报「已成功安装」，主结果却记成失败。
 *
 * 现场（本机 state.json，微信 Tencent.WeChat.Universal）：官网 NSIS 包静默安装
 * 返回 1 → winget upgrade 兜底输出「已成功安装」→ 旧逻辑只认退出码，把成功文案
 * 当错误拼进结果，界面显示「上次更新：成功 0 / 1（1 个失败）」。
 * 本测试把历史失败记录喂给修复后的判定函数，断言现在判成成功。缺 state.json
 * 时用内置最小现场副本，任何机器上都能稳定跑。
 *
 * 用法：node test/repro-1318.mjs
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { isWingetSuccessOutput, wingetFallbackOutcome, classifyWingetError } from "../lib/engine.js";

let pass = 0, fail = 0;
function ok(cond, label) { if (cond) { pass++; console.log("  PASS " + label); } else { fail++; console.log("  FAIL " + label); } }

const statePath = join(homedir(), ".dsh", "dsh-app-updater", "state.json");
let hist = null;
if (existsSync(statePath)) {
  try {
    const results = (JSON.parse(readFileSync(statePath, "utf8")).update || {}).results || [];
    hist = results.find((r) => /兜底失败：\[winget upgrade\] 已成功安装/.test(r.error || "")) || null;
  } catch { /* 损坏则用内置副本 */ }
}
const fixture = {
  id: "Tencent.WeChat.Universal",
  ok: false,
  error: "安装程序返回 1（静默安装被中止…）；兜底失败：[winget upgrade] 已成功安装",
};
const entry = hist || fixture;

console.log("=== 现场：历史失败记录 ===");
console.log(`  ${entry.ok ? "OK  " : "FAIL"} ${entry.id}: ${entry.error}`);
console.log("  （数据源：" + (hist ? statePath : "内置副本") + "）");

const m = String(entry.error || "").match(/兜底失败：\[winget upgrade\]\s*(.+)$/);
const fallbackText = m ? m[1].trim() : "已成功安装";
console.log(`  兜底实际输出：「${fallbackText}」`);

ok(/已成功安装|Successfully installed/i.test(fallbackText), "现场兜底输出确实是成功文案");
ok(entry.ok === false, "历史结果把它记成了失败（成功 0/1）");
ok(isWingetSuccessOutput(fallbackText), "新逻辑识别出这是成功输出");
ok(!/已成功安装/.test(classifyWingetError(fallbackText)), "classifyWingetError 不再把成功行当错误原因");

const verdict = wingetFallbackOutcome({ ok: false, code: 1, text: fallbackText });
ok(verdict.ok === true, "★ 现场重放：退出码 1 + 已成功安装 → 判成功（不再是成功 0/1）");
ok(!verdict.error, "成功结果不再携带错误文案");
const genuineFail = wingetFallbackOutcome({ ok: false, code: 2, text: "安装程序失败，退出代码为: 2" });
ok(genuineFail.ok === false, "真实失败仍判失败");

console.log(`\n=== 结果：${pass} passed, ${fail} failed ===`);
console.log("（修复前：isWingetSuccessOutput / wingetFallbackOutcome 未导出 → 导入即红）");
process.exit(fail ? 1 : 0);
