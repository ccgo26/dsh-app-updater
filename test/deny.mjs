/**
 * 默认拒绝的端到端自测：宿主没有 connection 服务、且用户没有显式开启兼容模式时，
 * `/dsh-app-updater/*` 的每一条路由都必须 403（1.3.0 的「仅凭回环放行」已移除）。
 * 反方向再验证一次：显式开启兼容模式后，回环请求才会被放行并带上 opt-in 响应头。
 *
 * 运行：node test/deny.mjs
 */

import http from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
process.env.DSH_HOME = process.env.DSH_HOME || join(here, "..", ".test-home");
delete process.env.DSH_APP_UPDATER_ALLOW_LEGACY_LOOPBACK;

const indexModule = await import("../lib/index.js");
const plugin = indexModule.default;
const { __setRegistryFetchForTest } = indexModule;

let checks = 0;
let failures = 0;
function ok(cond, label, extra) {
  checks += 1;
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures += 1;
    console.log(`  ✗ ${label}${extra === undefined ? "" : ` — ${JSON.stringify(extra)}`}`);
  }
}

/** 起一个假宿主（没有 connection 服务），返回服务地址与路由表。 */
function mount(config) {
  const routes = [];
  const webServer = {
    register(spec) {
      routes.push(spec);
      return () => {};
    },
  };
  const ctx = {
    effect(fn) {
      const dispose = fn();
      return () => {
        if (typeof dispose === "function") dispose();
      };
    },
    inject(deps, fn) {
      // 只提供 webServer，不提供 connection —— 等价于旧宿主
      fn({ webServer });
    },
  };
  plugin.apply(ctx, config);

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const route = routes.find((r) => r.path === url.pathname);
    if (!route) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "no route" }));
      return;
    }
    Promise.resolve(route.handler(req, res)).catch((err) => {
      if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err) }));
    });
  });
  return { routes, server };
}

async function serve(server) {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${server.address().port}`;
}

const ROUTES = [
  "/dsh-app-updater/state.json",
  "/dsh-app-updater/apps.json",
  "/dsh-app-updater/scan",
  "/dsh-app-updater/update",
  "/dsh-app-updater/cancel",
  "/dsh-app-updater/settings",
  "/dsh-app-updater/open-downloads",
  "/dsh-app-updater/check-update",
  "/dsh-app-updater/self-update",
  "/dsh-app-updater/health.json",
];

/* ------------------------------------------------------------------ *
 * 1. 默认拒绝：没有 connection + 没有兼容模式
 * ------------------------------------------------------------------ */
console.log("\n默认拒绝（没有 connection 服务、未开启兼容模式）");
const denied = mount(undefined);
const deniedBase = await serve(denied.server);
for (const p of ROUTES) {
  const isWrite = ["/scan", "/update", "/cancel", "/settings", "/open-downloads", "/self-update"].includes(
    p.replace("/dsh-app-updater", "")
  );
  const res = await fetch(deniedBase + p, isWrite
    ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirm: true }) }
    : undefined);
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  ok(
    res.status === 403 && res.headers.get("x-dsh-admission") === "denied" && body && body.ok === false,
    `${p} → 403 + X-DSH-Admission: denied`,
    { status: res.status, admission: res.headers.get("x-dsh-admission"), body }
  );
}
denied.server.close();

/* ------------------------------------------------------------------ *
 * 2. 显式开启兼容模式：同一套路由才放行（且只在回环地址上）
 * ------------------------------------------------------------------ */
console.log("\n显式开启兼容模式（配置 allowLegacyLoopback: true）");
const legacy = mount({ allowLegacyLoopback: true });
const legacyBase = await serve(legacy.server);

const stateRes = await fetch(legacyBase + "/dsh-app-updater/state.json");
const state = await stateRes.json();
ok(
  stateRes.status === 200 && stateRes.headers.get("x-dsh-admission") === "loopback-legacy-optin",
  "state.json → 200 + X-DSH-Admission: loopback-legacy-optin"
);
ok(
  state && state.admission && state.admission.mode === "loopback-legacy-optin" && state.admission.allowLegacyLoopback === true,
  "状态接口暴露 admission 现状（供复核）",
  state && state.admission
);

const health = await (await fetch(legacyBase + "/dsh-app-updater/health.json")).json();
ok(
  health && health.admission && health.admission.mode === "loopback-legacy-optin",
  "health.json 同样标注兼容模式",
  health && health.admission
);

const badWrite = await (await fetch(legacyBase + "/dsh-app-updater/scan", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({}),
})).json();
ok(badWrite && badWrite.ok === false && String(badWrite.error).includes("confirm"), "兼容模式下写接口仍要求 confirm:true");

/* 新增：CSRF 与 method 校验（1.3.14 之后的加固） */
const csrfState = await (await fetch(legacyBase + "/dsh-app-updater/state.json")).json();
ok(typeof csrfState.csrfToken === "string" && csrfState.csrfToken.length >= 16, "state.json 下发 csrfToken");
const noCsrf = await (await fetch(legacyBase + "/dsh-app-updater/scan", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ confirm: true }),
})).json();
ok(noCsrf && noCsrf.ok === false && /CSRF/.test(String(noCsrf.error)), "写接口缺少 csrfToken → 403");
const withCsrf = await (await fetch(legacyBase + "/dsh-app-updater/scan", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ confirm: true, csrfToken: csrfState.csrfToken, force: true }),
})).json();
ok(withCsrf && withCsrf.ok === true, "带正确 csrfToken 的写请求被接受", withCsrf);
const wrongMethod = await (await fetch(legacyBase + "/dsh-app-updater/scan", { method: "GET" })).json();
ok(wrongMethod && wrongMethod.ok === false && /方法不允许/.test(String(wrongMethod.error)), "写接口用 GET → 405");

legacy.server.close();

/* ------------------------------------------------------------------ *
 * 3. 1.4.0 新路由端到端：check-update 比对 / self-update 二次裁决
 * ------------------------------------------------------------------ */
console.log("\n1.4.0 版本信息区新路由（真实 HTTP + 假宿主）");
const ver = mount({ allowLegacyLoopback: true });
const verBase = await serve(ver.server);
const curVer = (await import("../package.json", { with: { type: "json" } })).default.version;

/* state.json 下发版本信息 */
const verState = await (await fetch(verBase + "/dsh-app-updater/state.json")).json();
ok(
  verState.pluginInfo && verState.pluginInfo.version === curVer && /^\d{4}-\d{2}-\d{2}$/.test(verState.pluginInfo.updatedAt),
  "state.json 下发 pluginInfo（version + updatedAt）",
  verState.pluginInfo
);

/* 三档检查源：更新 / 无更新 / 失败 */
const restoreFetch = [];
restoreFetch.push(__setRegistryFetchForTest(async () => JSON.stringify({ version: "9.9.9" })));
const hasNew = await (await fetch(verBase + "/dsh-app-updater/check-update")).json();
ok(hasNew.ok === true && hasNew.hasUpdate === true && hasNew.latestVersion === "9.9.9", "registry 报更高版本 → hasUpdate=true", hasNew);

restoreFetch.push(__setRegistryFetchForTest(async () => JSON.stringify({ version: curVer })));
const noNew = await (await fetch(verBase + "/dsh-app-updater/check-update")).json();
ok(noNew.ok === true && noNew.hasUpdate === false, "registry 版本相同 → hasUpdate=false", noNew);

restoreFetch.push(__setRegistryFetchForTest(async () => { throw new Error("网络不可达"); }));
const failed = await (await fetch(verBase + "/dsh-app-updater/check-update")).json();
ok(failed.ok === false && /失败/.test(failed.error), "registry 异常 → ok:false + 失败文案（不谎报最新）", failed);

restoreFetch.push(__setRegistryFetchForTest(async () => "not json"));
const badPayload = await (await fetch(verBase + "/dsh-app-updater/check-update")).json();
ok(badPayload.ok === false, "registry 返回非法内容 → ok:false", badPayload);

/* self-update：缺 confirm / 非法 target / 非更新版本 / 缺 dsh 都不会真的安装 */
const csrf2 = (await (await fetch(verBase + "/dsh-app-updater/state.json")).json()).csrfToken;
const post = (body) => fetch(verBase + "/dsh-app-updater/self-update", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
}).then((r) => r.json());

const noConfirm = await post({ target: "9.9.9", csrfToken: csrf2 });
ok(noConfirm.ok === false && /confirm/.test(noConfirm.error), "self-update 缺 confirm:true → 400");
const noCsrf2 = await post({ confirm: true, target: "9.9.9" });
ok(noCsrf2.ok === false && /CSRF/.test(noCsrf2.error), "self-update 缺 csrfToken → 403");
const badTarget = await post({ confirm: true, csrfToken: csrf2, target: "9.9.9; rm -rf /" });
ok(badTarget.ok === false && /不合法/.test(badTarget.error), "self-update 非法版本号 → 400（挡注入）");
const alreadyCurrent = await post({ confirm: true, csrfToken: csrf2, target: curVer });
ok(alreadyCurrent.ok === true && alreadyCurrent.alreadyCurrent === true, "self-update 目标不新于当前 → 不执行安装", alreadyCurrent);

while (restoreFetch.length) restoreFetch.pop()();
ver.server.close();

/* ------------------------------------------------------------------ */
console.log(`\n${failures === 0 ? "全部通过" : "存在失败"}：${checks - failures}/${checks}`);
process.exit(failures === 0 ? 0 : 1);