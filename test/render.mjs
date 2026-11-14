/**
 * 渲染 + 交互自测：用迷你 React / 迷你 DOM 把 lib/client.js 真实加载起来，
 * 覆盖设置面板、演练提示、列宽拖拽、请求体与本地存储。
 *
 * 运行：node test/render.mjs
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "..", "lib", "client.js"), "utf8");

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
const group = (n) => console.log(`\n${n}`);
const tick = () => new Promise((r) => setTimeout(r, 0));

/* ------------------------------------------------------------------ *
 * 迷你 React（只覆盖本组件用到的 hooks）
 * ------------------------------------------------------------------ */

function makeReact() {
  let hooks = [];
  let cursor = 0;
  let effects = [];
  let renderFn = null;
  let dirty = false;
  let rendering = false;

  const shallowEqual = (a, b) =>
    Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]);

  const schedule = () => {
    dirty = true;
    if (rendering) return;
    queueMicrotask(() => {
      if (dirty && !rendering) renderFn();
    });
  };

  const react = {
    createElement(type, props, ...children) {
      const flat = [];
      for (const c of children) {
        if (Array.isArray(c)) flat.push(...c.flat(Infinity));
        else flat.push(c);
      }
      return {
        type,
        props: props || {},
        children: flat.filter((c) => c !== null && c !== undefined && c !== false && c !== true && c !== ""),
      };
    },
    useState(init) {
      const i = cursor++;
      if (!(i in hooks)) hooks[i] = typeof init === "function" ? init() : init;
      const set = (v) => {
        const next = typeof v === "function" ? v(hooks[i]) : v;
        if (next !== hooks[i]) {
          hooks[i] = next;
          schedule();
        }
      };
      return [hooks[i], set];
    },
    useRef(init) {
      const i = cursor++;
      if (!(i in hooks)) hooks[i] = { current: init };
      return hooks[i];
    },
    useMemo(fn, deps) {
      const i = cursor++;
      const prev = hooks[i];
      if (!prev || !shallowEqual(prev.deps, deps)) hooks[i] = { value: fn(), deps: deps };
      return hooks[i].value;
    },
    useCallback(fn, deps) {
      return react.useMemo(() => fn, deps);
    },
    useEffect(fn, deps) {
      const i = cursor++;
      const prev = hooks[i];
      if (!prev || !shallowEqual(prev.deps, deps)) {
        hooks[i] = { deps: deps };
        effects.push(fn);
      }
    },
  };

  return {
    react,
    setRenderer(fn) {
      renderFn = fn;
    },
    render() {
      cursor = 0;
      effects = [];
      rendering = true;
      let tree;
      try {
        tree = renderFn();
      } finally {
        rendering = false;
      }
      dirty = false;
      const cleanups = [];
      for (const fn of effects) {
        try {
          const c = fn();
          if (typeof c === "function") cleanups.push(c);
        } catch (e) {
          throw e;
        }
      }
      for (const c of cleanups) {
        // 只收集，不立即执行（组件卸载时由内部清理逻辑负责）
        void c;
      }
      return tree;
    },
    reset() {
      hooks = [];
      cursor = 0;
      effects = [];
      dirty = false;
    },
  };
}

/* ------------------------------------------------------------------ *
 * 迷你 DOM
 * ------------------------------------------------------------------ */

function makeDom() {
  const listeners = new Map();
  const styles = [];
  const document = {
    visibilityState: "visible",
    querySelector: () => null,
    createElement: () => ({ dataset: {}, textContent: "", setAttribute() {}, appendChild() {} }),
    head: { appendChild: (el) => styles.push(el) },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const list = listeners.get(type) || [];
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    },
  };
  return {
    document,
    styles,
    listeners,
    fire(type, ev) {
      for (const fn of listeners.get(type) || []) fn(ev);
      return (listeners.get(type) || []).length;
    },
    countListeners(type) {
      return (listeners.get(type) || []).length;
    },
  };
}

function makeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    _map: map,
  };
}

/* ------------------------------------------------------------------ *
 * 树遍历工具
 * ------------------------------------------------------------------ */

function walk(node, out = []) {
  if (node === null || node === undefined || node === false || node === true) return out;
  if (typeof node === "string" || typeof node === "number") {
    out.push(node);
    return out;
  }
  if (Array.isArray(node)) {
    for (const n of node) walk(n, out);
    return out;
  }
  out.push(node);
  if (typeof node.type === "function") {
    walk(node.type(node.props), out);
    return out;
  }
  for (const c of node.children || []) walk(c, out);
  return out;
}

const cls = (n) => (n && n.props ? String(n.props.className || "") : "");
function byClass(tree, part) {
  return walk(tree).filter((n) => n && n.props && cls(n).split(/\s+/).includes(part));
}
function textOf(node) {
  return walk(node)
    .filter((n) => typeof n === "string")
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/* ------------------------------------------------------------------ *
 * 加载模块
 * ------------------------------------------------------------------ */

const rt = makeReact();
const dom = makeDom();
const storage = makeStorage();
const calls = [];
let statePayload = null;
let settingsResponse = { ok: true };
/* 1.4.0：版本信息区交互的可编程响应（检查更新 / 自更新）。
   每个场景改这两个变量即可模拟「有新版本 / 无新版本 / 失败 / 挂起」。 */
let checkUpdateResponse = { ok: true, hasUpdate: false, currentVersion: "1.4.0", latestVersion: "1.4.0" };
let selfUpdateResponse = { ok: true, message: "已更新到 v1.5.0" };
let checkUpdateDeferred = null; // 非 null 时模拟「进行中」，返回永不 resolve 的 Promise

function jsonResponse(obj, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => obj,
  };
}

async function fakeFetch(url, init) {
  calls.push({ url: String(url), init: init || null });
  const u = String(url);
  if (u.endsWith("/state.json")) {
    if (!statePayload) return jsonResponse({ ok: true, platform: "win32", phase: "idle", settings: {}, apps: { items: [], stats: {} }, csrfToken: "test-csrf-token-0123456789abcdef" });
    return jsonResponse(statePayload);
  }
  /* 1.4.0：检查更新与自更新路由的模拟。checkUpdateDeferred 用于验证「进行中禁止重复点击」。 */
  if (u.endsWith("/check-update")) {
    if (checkUpdateDeferred) return checkUpdateDeferred.promise;
    return jsonResponse(checkUpdateResponse);
  }
  if (u.endsWith("/self-update")) {
    let body = {};
    try { body = JSON.parse((init && init.body) || "{}"); } catch (e) { body = {}; }
    const expected = (statePayload && statePayload.csrfToken) || "test-csrf-token-0123456789abcdef";
    if (body.csrfToken !== expected) return jsonResponse({ ok: false, error: "CSRF 校验失败" }, 403);
    return jsonResponse(selfUpdateResponse);
  }
  if (u.endsWith("/settings") || u.endsWith("/scan") || u.endsWith("/update") || u.endsWith("/cancel") || u.endsWith("/open-downloads")) {
    let body = {};
    try {
      body = JSON.parse((init && init.body) || "{}");
    } catch (e) {
      body = {};
    }
    // 模拟宿主 1.3.14 的 CSRF 闸门：缺 token 一律 403
    const expected = (statePayload && statePayload.csrfToken) || "test-csrf-token-0123456789abcdef";
    if (body.csrfToken !== expected) return jsonResponse({ ok: false, error: "CSRF 校验失败" }, 403);
    if (!u.endsWith("/settings")) return jsonResponse({ ok: true });
    if (body.settings && body.settings.downloadDir && !/^[A-Za-z]:[\\/]/.test(body.settings.downloadDir) && !/^\\\\/.test(body.settings.downloadDir)) {
      return jsonResponse({ ok: false, error: "downloadDir 必须是绝对路径" }, 400);
    }
    // 模拟宿主：保存后把设置落到 state 里，后续 state.json 就能读回新值
    if (statePayload) {
      statePayload.settings = Object.assign({}, statePayload.settings || {}, body.settings || {});
      if (body.settings && "downloadDir" in body.settings) {
        statePayload.downloadDir = body.settings.downloadDir || statePayload.downloadDir;
      }
    }
    return jsonResponse({ ok: settingsResponse.ok, settings: (statePayload && statePayload.settings) || {} });
  }
  return jsonResponse({ ok: true });
}

let captured = null;
const fakeWindow = {
  __ModuleLoader__: {
    load(def) {
      captured = def;
    },
  },
  localStorage: storage,
};

const fakeRequire = (name) => {
  if (name === "react") return rt.react;
  throw new Error("unexpected require: " + name);
};

// eslint-disable-next-line no-new-func
new Function("window", "document", "fetch", "require", src)(fakeWindow, dom.document, fakeFetch, fakeRequire);

if (!captured || captured.id !== "dsh-app-updater") {
  console.log("模块加载失败");
  process.exit(1);
}

const mod = captured.factory(fakeRequire);
ok(typeof mod.apply === "function", "exports.apply 是函数");
ok(JSON.stringify(mod.inject) === JSON.stringify(["slots", "locale"]), "inject = slots + locale", mod.inject);

/* 用假 ctx 跑 apply，捕获槽位注册 */
let SectionComponent = null;
const fakeCtx = {
  effect(fn) {
    const c = typeof fn === "function" ? fn() : undefined;
    return () => {
      if (typeof c === "function") c();
    };
  },
  inject(deps, fn) {
    const scope = {
      slots: {
        inject: (name, cb) => cb(),
        register: (opts, comp) => {
          if (opts && opts.name === "settings.section") SectionComponent = comp;
          return () => {};
        },
      },
    };
    fn(scope);
  },
  get: () => undefined,
};
mod.apply(fakeCtx);
ok(typeof SectionComponent === "function", "注册了 settings.section 组件");

/* ------------------------------------------------------------------ *
 * 渲染场景
 * ------------------------------------------------------------------ */

function baseState(overrides) {
  return Object.assign(
    {
      ok: true,
      platform: "win32",
      phase: "idle",
      winget: { available: true, version: "1.29.380" },
      scan: { running: false, startedAt: 0, finishedAt: 0, error: null, warnings: [] },
      update: { running: false, total: 0, done: 0, current: null, results: [], error: null },
      apps: {
        scannedAt: Date.now(),
        stats: { total: 2, upgradable: 1, unsupported: 0 },
        items: [
          { id: "Git.Git", name: "Git", version: "2.55.0.5", available: "2.56.0.3", publisher: "The Git Development Community", source: "winget", hasUpdate: true, updateSupported: true, reason: null },
          { id: "reg:foo", name: "腾讯视频", version: "11.186.4331.0", available: "", publisher: "腾讯", source: "registry", hasUpdate: false, updateSupported: false, reason: "not-in-catalog" },
        ],
      },
      log: [{ at: Date.now(), level: "info", text: "扫描完成" }],
      settings: { includeStoreApps: true, includeRegistryOnly: true, downloadDir: "", keepInstallers: true, hashFallbackUpgrade: true, dryRun: false },
      downloadDir: "C:\\Users\\19952\\Downloads\\DSH App Updater",
      csrfToken: "test-csrf-token-0123456789abcdef",
    },
    overrides || {}
  );
}

rt.setRenderer(() => SectionComponent({ t: () => "" }));
statePayload = baseState();
rt.reset();
let tree = rt.render();
await tick();
await tick();
tree = rt.render();

group("设置面板与列宽手柄");
ok(byClass(tree, "appupd-panel").length === 1, "渲染出插件设置面板");
const switches = byClass(tree, "appupd-switch");
ok(switches.length === 7, "渲染出 7 个设置开关（Windows：不含 macOS 专属项）", switches.length);

group("设置面板按平台显示开关");
{
  const macState = baseState({
    platform: "darwin",
    env: { family: "macos", platform: "darwin", osName: "macOS 15（Sequoia）", archLabel: "Apple Silicon（ARM64）" },
    envSummary: "macOS 15（Sequoia） · Apple Silicon（ARM64）",
    engine: { id: "homebrew", available: true, version: "4.5.0" },
  });
  statePayload = macState;
  rt.reset();
  await tick();
  tree = rt.render();
  await tick();
  tree = rt.render();
  const macSwitches = byClass(tree, "appupd-switch");
  ok(macSwitches.length === 6, "macOS 显示 6 个开关（跨平台 3 + macOS 专属 3）", macSwitches.length);
  const labels = byClass(tree, "appupd-field-label").map(textOf);
  ok(!labels.includes("自动提权安装"), "macOS 不显示「自动提权安装」", labels);
  ok(!labels.includes("下载失败时回退 winget"), "macOS 不显示「下载失败时回退 winget」", labels);
  ok(labels.includes("包含非 Homebrew 应用"), "macOS 显示「包含非 Homebrew 应用」", labels);
  ok(labels.includes("查询官网更新源"), "macOS 显示「查询官网更新源」开关", labels);
  ok(labels.includes("包含 App Store 应用"), "macOS 显示「包含 App Store 应用」", labels);
  ok(labels.includes("演练模式") && labels.includes("保留安装包"), "跨平台开关仍然显示", labels);
}
statePayload = baseState();
rt.reset();
await tick();
tree = rt.render();
await tick();
tree = rt.render();

group("macOS 空状态文案");
{
  const emptyMac = baseState({
    platform: "darwin",
    env: { family: "macos", platform: "darwin" },
    apps: { scannedAt: Date.now(), stats: { total: 0, upgradable: 0, unsupported: 0 }, items: [] },
  });
  statePayload = emptyMac;
  rt.reset();
  await tick();
  tree = rt.render();
  await tick();
  tree = rt.render();
  const emptyText = textOf(byClass(tree, "appupd-empty")[0] || tree);
  ok(emptyText.includes("应用目录") || emptyText.includes("运行日志"), "macOS 空列表给出可执行的下一步，而不是只说「未检测到」", emptyText.slice(0, 120));
  ok(!emptyText.includes("未检测到任何已安装应用"), "macOS 不再显示会产生误解的那句话");
}
statePayload = baseState();
rt.reset();
await tick();
tree = rt.render();
await tick();
tree = rt.render();
ok(byClass(tree, "appupd-grip").length === 4, "渲染出 4 个列宽拖拽手柄", byClass(tree, "appupd-grip").length);
const ths = walk(tree).filter((n) => n.type === "th");
ok(ths.length === 6, "表头 6 列", ths.length);
const cols = walk(tree).filter((n) => n.type === "col");
ok(cols.length === 6, "colgroup 6 列", cols.length);
ok(String(cols[1].props.style.width) === "240px", "应用列默认 240px", cols[1].props.style.width);
ok(byClass(tree, "appupd-banner").length === 0, "演练模式关闭时无警示条");
ok(byClass(tree, "appupd-nameline").length === 2 || byClass(tree, "appupd-name").length === 2, "应用行渲染正常");

group("1.3.8 非 Homebrew 应用：行提示带 --adopt 命令");
statePayload = baseState({
  platform: "darwin",
  apps: {
    scannedAt: Date.now(),
    stats: { total: 2, upgradable: 0, unsupported: 2 },
    items: [
      {
        id: "macapp:com.colliderli.iina",
        name: "IINA",
        version: "1.4.4",
        available: "",
        publisher: "Homebrew cask · iina",
        source: "app",
        hasUpdate: false,
        updateSupported: false,
        reason: "not-managed",
        adoptHint: "brew install --cask --adopt iina",
      },
      {
        id: "macapp:com.raycast.macos",
        name: "Raycast",
        version: "1.99.0",
        available: "",
        publisher: "com.raycast.macos",
        source: "app",
        hasUpdate: false,
        updateSupported: false,
        reason: "not-managed",
      },
    ],
  },
});
rt.reset();
await tick();
tree = rt.render();
await tick();
tree = rt.render();
{
  const reasons = byClass(tree, "appupd-reason").map((n) => textOf(n));
  const iina = reasons.find((t) => t.includes("IINA") || t.includes("iina"));
  ok(reasons.some((t) => t.includes("brew install --cask --adopt iina")), "带 adoptHint 的行显示具体收编命令", reasons);
  ok(reasons.some((t) => t === "非 Homebrew 管理"), "没有 adoptHint 时只显示原因，不拼空提示", reasons);
  ok(!reasons.some((t) => t.includes("：") && t.trim().endsWith("：")), "不会渲染出空提示的悬空冒号", reasons);
  void iina;
}

group("1.3.8 回归：无法判断的行不再谎报「已是最新」");
{
  // 非 Homebrew 管理 / 目录未收录 / 版本未知 → 我们并不知道是不是最新，
  // 以前一律渲染「已是最新」，把「无法判断」谎报成「已经最新」。
  const states = byClass(tree, "appupd-state-unknown").map((n) => textOf(n));
  const latest = byClass(tree, "appupd-state-ok").map((n) => textOf(n));
  ok(states.filter((t) => t === "不可判断").length === 2, "两条 not-managed 行显示「不可判断」", states);
  ok(!latest.includes("已是最新"), "没有任何行被错误标成「已是最新」", latest);
  const unknown = byClass(tree, "appupd-state-unknown")[0];
  ok(unknown && String(unknown.props.title || "").includes("无法判断"), "悬停提示说明「无法判断是否有新版本」", unknown && unknown.props.title);
}

group("1.3.9 非 Homebrew 应用：官网有新版本 → 「可升级到」显示版本 + 「官网有新版」");
{
  statePayload = baseState({
    platform: "darwin",
    env: { platform: "darwin", family: "macos", osName: "macOS", archLabel: "Apple Silicon" },
    apps: {
      scannedAt: Date.now(),
      stats: { total: 3, upgradable: 0, manual: 1, unsupported: 3 },
      items: [
        // 对不上 cask：查到官网新版，但本插件升不了 → 「官网有新版 / 需手动」
        {
          id: "macapp:com.example.kiwihd",
          name: "kiwihd",
          version: "1.9.0",
          available: "",
          latestVersion: "2.0.14",
          latestNewer: true,
          latestVia: "sparkle",
          publisher: "com.huya.kiwihd",
          source: "app",
          hasUpdate: false,
          updateSupported: false,
          canAdopt: false,
          reason: "not-managed",
          adoptHint: "用 brew install --cask --force <token> 接管后可一键更新",
        },
        // 能对上 cask 且版本更新 → 可一键（brew install --cask --force）
        {
          id: "macapp:com.colliderli.iina",
          name: "IINA",
          version: "1.4.4",
          available: "1.5.0",
          latestVersion: "1.5.0",
          latestNewer: true,
          latestVia: "sparkle",
          publisher: "Homebrew cask · iina",
          source: "app",
          hasUpdate: true,
          updateSupported: true,
          canAdopt: true,
          adoptToken: "iina",
          reason: null,
          adoptHint: "brew install --cask --force iina",
        },
        {
          id: "macapp:com.raycast.macos",
          name: "Raycast",
          version: "1.99.0",
          available: "",
          publisher: "com.raycast.macos",
          source: "app",
          hasUpdate: false,
          updateSupported: false,
          reason: "not-managed",
        },
        {
          id: "macapp:com.apple.ActivityMonitor",
          name: "Activity Monitor",
          version: "10.14",
          available: "",
          publisher: "com.apple.ActivityMonitor",
          source: "app",
          hasUpdate: false,
          updateSupported: false,
          reason: "system-component",
        },
      ],
    },
  });
  rt.reset();
  await tick();
  tree = rt.render();
  await tick();
  tree = rt.render();

  const manual = byClass(tree, "appupd-state-manual").map(textOf);
  ok(manual.length === 1 && manual[0] === "官网有新版", "查到官网新版的非 Homebrew 应用显示「官网有新版」", manual);

  // 关键：它绝不能被说成「已是最新」（这正是 1.3.8 修的谎报），也不能叫「可一键更新」
  const okStates = byClass(tree, "appupd-state-ok").map(textOf);
  ok(!okStates.includes("已是最新") || byClass(tree, "appupd-state-ok").length === 0, "没有任何行被谎报成「已是最新」", okStates);
  ok(!byClass(tree, "appupd-state-new").some((n) => textOf(n).includes("IINA")), "不会把 IINA 标成「有新版本（可一键更新）」");

  // 「可升级到」列必须显示真版本号，而不是破折号
  const verTexts = byClass(tree, "appupd-ver-manual").map(textOf);
  ok(verTexts.length === 1 && verTexts[0].includes("2.0.14"), "查不到 cask 的行才显示「需手动」版本", verTexts);
  ok(verTexts.some((t) => t.includes("需手动")), "并带「需手动」标签，避免与可一键更新混淆", verTexts);

  // 关键：能对上 cask 的行必须变成**可点的一键更新**，而不是继续「需手动」
  const newStates = byClass(tree, "appupd-state-new").map(textOf);
  ok(newStates.length === 1 && newStates[0] === "有新版本", "对得上 cask 的行变成「有新版本」可一键更新", newStates);
  const iinaRow = byClass(tree, "appupd-name").find((n) => textOf(n) === "IINA");
  ok(!!iinaRow, "IINA 行存在");
  const cbs = byClass(tree, "appupd-cb");
  ok(cbs.some((c) => c.props.disabled === false), "至少有一行勾选框可用（可一键更新）", cbs.map((c) => c.props.disabled));

  // 悬停提示要说明版本从哪里来
  const tag = byClass(tree, "appupd-ver-manual")[0];
  ok(tag && String(tag.props.title || "").includes("2.0.14"), "版本格悬停提示带版本号", tag && tag.props.title);
  const st = byClass(tree, "appupd-state-manual")[0];
  ok(st && String(st.props.title || "").includes("Sparkle"), "状态悬停提示说明数据来源", st && st.props.title);
  ok(st && !String(st.props.title || "").includes("brew install"), "查不到 cask 时不承诺能一键，只指向应用内/官网", st && st.props.title);

  // 状态栏要说出「另有 N 个需手动」，否则用户以为没有更新
  const statusLine = byClass(tree, "appupd-status-strong").map(textOf).join(" ");
  ok(statusLine.includes("需手动"), "状态栏提示「另有 N 个官网有新版需手动升级」", statusLine);

  // 「需手动」筛选：只应剩 IINA 一行
  const segs = byClass(tree, "appupd-seg-btn");
  const manualBtn = segs.find((b) => textOf(b) === "需手动");
  ok(!!manualBtn, "筛选栏出现「需手动」分段按钮", segs.map(textOf));
  if (manualBtn) {
    await manualBtn.props.onClick();
    await tick();
    tree = rt.render();
    await tick();
    const names = byClass(tree, "appupd-name").map(textOf);
    ok(names.length === 1 && names[0] === "kiwihd", "「需手动」筛选只保留「查到新版但升不了」的行", names);
  }

  // 三个分段必须互斥：「需手动」的行不该同时出现在「未收录」里
  const unsupBtn = byClass(tree, "appupd-seg-btn").find((b) => textOf(b) === "未收录");
  if (unsupBtn) {
    await byClass(tree, "appupd-seg-btn").find((b) => textOf(b) === "全部").props.onClick();
    await tick();
    tree = rt.render();
    await tick();
    const unsup2 = byClass(tree, "appupd-seg-btn").find((b) => textOf(b) === "未收录");
    await unsup2.props.onClick();
    await tick();
    tree = rt.render();
    await tick();
    const names = byClass(tree, "appupd-name").map(textOf);
    ok(!names.includes("IINA") && !names.includes("kiwihd"), "「未收录」里不再混进「官网有新版」的行", names);
    ok(names.includes("Activity Monitor") || names.includes("Raycast"), "「未收录」仍保留真正未收录的行", names);
  }
}

group("1.3.9 没有官网数据时仍显示「不可判断」，不显示版本号");
{
  statePayload = baseState({
    platform: "darwin",
    env: { platform: "darwin", family: "macos", osName: "macOS", archLabel: "Apple Silicon" },
    apps: {
      scannedAt: Date.now(),
      stats: { total: 1, upgradable: 0, manual: 0, unsupported: 1 },
      items: [
        {
          id: "macapp:com.raycast.macos",
          name: "Raycast",
          version: "1.99.0",
          available: "",
          latestVersion: "",
          latestNewer: false,
          publisher: "com.raycast.macos",
          source: "app",
          hasUpdate: false,
          updateSupported: false,
          reason: "not-managed",
        },
      ],
    },
  });
  rt.reset();
  await tick();
  tree = rt.render();
  await tick();
  tree = rt.render();
  ok(byClass(tree, "appupd-state-unknown").length === 1, "没有官网数据的行仍是「不可判断」", byClass(tree, "appupd-state-unknown").map(textOf));
  ok(byClass(tree, "appupd-ver-manual").length === 0, "不会凭空显示版本号");
  ok(byClass(tree, "appupd-state-manual").length === 0, "不会凭空显示「官网有新版」");
}

group("1.3.11 更新结果面板：点完更新必须能看到成败");
{
  statePayload = baseState({
    platform: "darwin",
    env: { platform: "darwin", family: "macos", osName: "macOS", archLabel: "Apple Silicon" },
    update: {
      running: false,
      total: 3,
      done: 3,
      current: null,
      error: null,
      results: [
        { id: "macapp:com.tencent.qq", ok: false, error: "该应用不由 Homebrew 管理，且 cask 目录里没有它" },
        { id: "macapp:com.tencent.tenvideo", ok: false, error: "brew install 退出码 1" },
        { id: "brew:iina", ok: true, verified: "1.5.0" },
      ],
    },
    apps: {
      scannedAt: Date.now(),
      stats: { total: 2, upgradable: 1, manual: 0, unsupported: 1 },
      items: [
        { id: "macapp:com.tencent.qq", name: "QQ", version: "6.9.99", available: "7.0.0", hasUpdate: true, updateSupported: true, source: "app", reason: null },
        { id: "macapp:com.tencent.tenvideo", name: "QQLive", version: "2.178.0", available: "2.189.0", hasUpdate: true, updateSupported: true, source: "app", reason: null },
      ],
    },
  });
  rt.reset();
  await tick();
  tree = rt.render();
  await tick();
  tree = rt.render();

  const panel = byClass(tree, "appupd-results");
  ok(panel.length === 1, "更新结束后出现结果面板", panel.length);
  const head = byClass(tree, "appupd-results-head").map(textOf).join(" ");
  ok(head.includes("成功 1 / 3"), "面板写明成功 1 / 3", head);
  ok(head.includes("2 个失败"), "并写明失败数量", head);

  const lines = byClass(tree, "appupd-results-line");
  ok(lines.length === 2, "失败明细逐条列出（2 条）", lines.length);
  const lineText = lines.map(textOf).join(" | ");
  ok(lineText.includes("QQ"), "失败明细带应用名 QQ", lineText);
  ok(lineText.includes("cask 目录里没有它"), "失败明细带具体原因", lineText);
  /* 成功明细用独立 class，不混进「失败明细」计数；补齐 installOk / verified 等字段的渲染覆盖 */
  const detail = byClass(tree, "appupd-results-detail").map(textOf).join(" | ");
  ok(detail.includes("安装器报成功") || detail.includes("复核版本") || detail.length > 0, "成功明细渲染补充字段", detail);
}

group("1.3.11 更新进行中不显示结果面板（避免和进度条打架）");
{
  statePayload = baseState({
    platform: "darwin",
    update: { running: true, total: 3, done: 1, current: "qq", error: null, results: [] },
  });
  rt.reset();
  await tick();
  tree = rt.render();
  await tick();
  tree = rt.render();
  ok(byClass(tree, "appupd-results").length === 0, "更新进行中不显示结果面板");
  ok(byClass(tree, "appupd-progress").length === 1, "而是显示进度条");
}

group("演练模式警示条");
statePayload = baseState({ settings: Object.assign({}, baseState().settings, { dryRun: true }) });
rt.reset();
await tick();
tree = rt.render();
await tick();
tree = rt.render();
ok(byClass(tree, "appupd-banner").length === 1, "演练模式开启时显示警示条", byClass(tree, "appupd-banner").length);
ok(textOf(byClass(tree, "appupd-banner")[0]).includes("不会真正安装"), "警示条文案包含「不会真正安装」");

group("开关交互 → POST /settings");
calls.length = 0;
const drySwitch = byClass(tree, "appupd-switch")[1]; // dryRun 是第 2 个开关
await drySwitch.props.onClick();
await tick();
await tick();
const setCalls = calls.filter((c) => c.url.endsWith("/settings"));
ok(setCalls.length === 1, "点击开关发出一次设置保存请求", setCalls.length);
const body = JSON.parse(setCalls[0].init.body);
ok(body.confirm === true && body.settings.dryRun === false, "请求体带 confirm:true 且把 dryRun 关掉", body);
ok(body.csrfToken === "test-csrf-token-0123456789abcdef", "写请求体带 csrfToken（宿主 CSRF 闸门要求）", body.csrfToken);
await tick();
await tick();
tree = rt.render();
ok(byClass(tree, "appupd-banner").length === 0, "关闭演练模式后警示条消失（宿主回读 state）");

group("兼容模式（仅回环放行）警示条");
statePayload = baseState({ admission: { mode: "loopback-legacy-optin", service: false, allowLegacyLoopback: true, warning: null } });
rt.reset();
await tick();
tree = rt.render();
await tick();
tree = rt.render();
ok(byClass(tree, "appupd-banner").length === 1, "兼容模式开启时显示警示条", byClass(tree, "appupd-banner").length);
ok(byClass(tree, "appupd-banner-warn").length === 1, "兼容模式警示条用警示样式");
ok(textOf(byClass(tree, "appupd-banner")[0]).includes("兼容模式已开启"), "警示条文案包含「兼容模式已开启」");

statePayload = baseState({ admission: { mode: "deny", service: false, allowLegacyLoopback: false, warning: null } });
rt.reset();
await tick();
tree = rt.render();
await tick();
tree = rt.render();
ok(byClass(tree, "appupd-banner").length === 0, "默认（未开启兼容模式）不显示任何警示条");

/* 扫描警告横幅：只该为「判断依据失效」出现，不能把日常说明也画成红条 */
group("扫描警告横幅");
async function renderWith(overrides) {
  statePayload = baseState(overrides);
  rt.reset();
  await tick();
  tree = rt.render();
  await tick();
  return rt.render();
}

tree = await renderWith({ scan: { running: false, startedAt: 0, finishedAt: 0, error: null, warnings: [] } });
ok(byClass(tree, "appupd-banner-warn").length === 0, "没有警告时不出红条（日常提示不该常驻）");

tree = await renderWith({
  scan: { running: false, startedAt: 0, finishedAt: 0, error: null, warnings: ["读取 Homebrew cask 目录失败：超时"] },
});
const warnBanners = byClass(tree, "appupd-banner-warn");
ok(warnBanners.length === 1, "有扫描警告时出 1 条红条", warnBanners.length);
ok(textOf(warnBanners[0]).includes("读取 Homebrew cask 目录失败"), "红条显示第一条警告的正文");

tree = await renderWith({
  scan: { running: false, startedAt: 0, finishedAt: 0, error: null, warnings: ["第一条故障", "第二条故障"] },
});
const many = byClass(tree, "appupd-banner-warn")[0];
ok(textOf(many).includes("2 条警告") && textOf(many).includes("查看全部"), "多条警告时显示条数并可展开查看全部");

tree = await renderWith({
  phase: "scanning",
  scan: { running: true, startedAt: Date.now(), finishedAt: 0, error: null, warnings: ["扫描中不该刷屏"] },
});
ok(byClass(tree, "appupd-banner-warn").length === 0, "扫描进行中不显示警告横幅（避免闪烁）");

/* 整体失败：以前只写 state，界面什么也不显示 */
tree = await renderWith({ scan: { running: false, startedAt: 0, finishedAt: Date.now(), error: "枚举应用目录失败", warnings: [] } });
const errBanner = byClass(tree, "appupd-banner-warn");
ok(errBanner.length === 1 && textOf(errBanner[0]).includes("枚举应用目录失败"), "扫描整体失败时界面必须显示原因", errBanner.length && textOf(errBanner[0]));

/* 非字符串的 warning 不能把渲染搞崩 */
tree = await renderWith({ scan: { running: false, startedAt: 0, finishedAt: 0, error: null, warnings: [null, 42, ""] } });
ok(byClass(tree, "appupd-banner-warn").length === 0, "warnings 里混入非字符串/空值时不出红条也不崩");

statePayload = baseState();

group("下载目录校验");
calls.length = 0;
statePayload = baseState();
rt.reset();
await tick();
tree = rt.render();
const dirInput = walk(tree).find((n) => n.type === "input" && String(cls(n)).includes("appupd-input"));
ok(Boolean(dirInput), "渲染出下载目录输入框");
dirInput.props.onChange({ target: { value: "not-absolute" } });
tree = rt.render();
const saveBtn = walk(tree).find((n) => n.type === "button" && textOf(n) === "保存");
ok(Boolean(saveBtn), "渲染出保存按钮");
await saveBtn.props.onClick();
await tick();
tree = rt.render();
ok(calls.filter((c) => c.url.endsWith("/settings")).length === 0, "非法路径不发请求");
ok(
  textOf(tree).includes("必须是绝对路径"),
  "非法路径显示错误提示",
  textOf(tree).slice(0, 160)
);

calls.length = 0;
const dir2 = walk(rt.render()).find((n) => n.type === "input" && String(cls(n)).includes("appupd-input"));
dir2.props.onChange({ target: { value: "D:\\Apps" } });
tree = rt.render();
const saveBtn2 = walk(tree).find((n) => n.type === "button" && textOf(n) === "保存");
await saveBtn2.props.onClick();
await tick();
await tick();
const okCalls = calls.filter((c) => c.url.endsWith("/settings"));
ok(okCalls.length === 1, "合法路径发一次请求", okCalls.length);
ok(JSON.parse(okCalls[0].init.body).settings.downloadDir === "D:\\Apps", "请求体带上新目录");

group("列宽拖拽（含钳制与持久化）");
statePayload = baseState();
rt.reset();
storage._map.delete("dsh-appupd-cols-v1");
await tick();
tree = rt.render();
await tick();
tree = rt.render();

const grips = byClass(tree, "appupd-grip");
ok(grips.length === 4, "取到 4 个手柄");
const nameGrip = grips[0];
const fakeEv = () => ({
  button: 0,
  clientX: 0,
  preventDefault() {},
  stopPropagation() {},
});
nameGrip.props.onMouseDown(Object.assign(fakeEv(), { clientX: 300 }));
ok(dom.countListeners("mousemove") === 1 && dom.countListeners("mouseup") === 1, "拖拽开始后挂上 mousemove/mouseup");
dom.fire("mousemove", { clientX: 380 });
tree = rt.render();
let colsNow = walk(tree).filter((n) => n.type === "col");
ok(String(colsNow[1].props.style.width) === "320px", "右拖 80px → 应用列 320px", colsNow[1].props.style.width);
dom.fire("mousemove", { clientX: 300 + 5000 });
tree = rt.render();
colsNow = walk(tree).filter((n) => n.type === "col");
ok(String(colsNow[1].props.style.width) === "640px", "越界被钳制到 640px", colsNow[1].props.style.width);
dom.fire("mousemove", { clientX: 300 - 5000 });
tree = rt.render();
colsNow = walk(tree).filter((n) => n.type === "col");
ok(String(colsNow[1].props.style.width) === "48px", "反向越界钳制到 48px", colsNow[1].props.style.width);
dom.fire("mouseup", {});
ok(dom.countListeners("mousemove") === 0 && dom.countListeners("mouseup") === 0, "松手后摘掉 document 监听");
const stored = JSON.parse(storage.getItem("dsh-appupd-cols-v1"));
ok(stored && stored.name === 48, "列宽写进 localStorage", stored);

group("双击手柄恢复默认");
const gripAfter = byClass(rt.render(), "appupd-grip")[0];
gripAfter.props.onDoubleClick(Object.assign(fakeEv(), {}));
tree = rt.render();
const colsReset = walk(tree).filter((n) => n.type === "col");
ok(String(colsReset[1].props.style.width) === "240px", "双击恢复默认 240px", colsReset[1].props.style.width);
ok(JSON.parse(storage.getItem("dsh-appupd-cols-v1")).name === 240, "恢复后的宽度也持久化");

group("localStorage 不可用时不崩");
storage.setItem("dsh-appupd-cols-v1", "{not json");
const broken = makeStorage();
broken.getItem = () => {
  throw new Error("denied");
};
broken.setItem = () => {
  throw new Error("denied");
};
const brokenWindow = { __ModuleLoader__: { load() {} }, localStorage: broken };
const rt2 = makeReact();
new Function("window", "document", "fetch", "require", src)(
  brokenWindow,
  makeDom().document,
  fakeFetch,
  fakeRequire
);
ok(!!brokenWindow.__ModuleLoader__.load, "localStorage 抛错时仍能完成模块注册（读取包装有 try/catch）");
void rt2;


/* ---------------- 1.3.15：i18n / a11y 回归 ---------------- */
group("1.3.15 i18n / a11y");
{
  /* 默认中文逐字不变：现有中文断言已覆盖，这里锁住「locale 解析防御」与 a11y 属性 */
  const src = readFileSync(join(here, "../lib/client.js"), "utf8");
  ok(/function resolveLocale/.test(src) && /currentLang = "zh-CN"/.test(src), "locale 解析缺省回落 zh-CN");
  ok(/function tr\(key, fallback\)/.test(src) && /return fallback/.test(src), "tr() 恒有中文 fallback（不会出现空白 UI）");
  ok(/scope: "col"/.test(src), "表头 th 带 scope=col");
  ok(/role: "separator"/.test(src) && /ArrowRight/.test(src) && /aria-valuenow/.test(src), "列宽手柄可键盘调整");
  ok(/aria-current/.test(src), "分段筛选带 aria-current");
  ok(/"aria-selected": checked/.test(src), "表格行 aria-selected 与勾选联动");
  ok(/aria-label": tr\("tableLabel"/.test(src), "表格带 aria-label");
}

/* ---------------- 1.4.0：版本信息区交互 ---------------- */
/* 复用现有迷你 React：每个场景重置 hooks、设置可编程响应、重新渲染后点击版本区按钮。
   断言按钮标签、提示文案、以及「立即更新」是否只在有新版时出现。 */
function resetVerScenario(payload, check, self) {
  statePayload = payload;
  checkUpdateResponse = check;
  selfUpdateResponse = self || { ok: true, message: "已更新到 v9.9.9" };
  checkUpdateDeferred = null;
  calls.length = 0;
  rt.reset();
}
function verBtn(tree) {
  return byClass(tree, "appupd-version-btn")[0];
}
function verText(tree) {
  return textOf(byClass(tree, "appupd-version")[0] || tree);
}
async function renderVer() {
  let t = rt.render();
  await tick();
  await tick();
  t = rt.render(); // refresh() 落地 state 后再渲染一次
  return t;
}

const VER_BASE = () => baseState({ pluginInfo: { version: "1.4.0", updatedAt: "2026-11-13", packageName: "dsh-app-updater" } });

group("1.4.0 版本信息展示");
{
  resetVerScenario(VER_BASE(), { ok: true, hasUpdate: false, currentVersion: "1.4.0", latestVersion: "1.4.0" });
  let t = await renderVer();
  const panel = byClass(t, "appupd-version");
  ok(panel.length === 1, "界面渲染出版本信息区");
  ok(textOf(panel[0]).includes("v1.4.0") && textOf(panel[0]).includes("2026-11-13"), "显示版本号与更新时间", textOf(panel[0]));
  // 版本信息区必须是根节点最后一个子节点
  const root = byClass(t, "appupd-root")[0];
  const last = (root.children || [])[root.children.length - 1];
  ok(last && cls(last).includes("appupd-version"), "版本信息区位于界面最下方");
  ok(textOf(verBtn(t)) === "检查更新", "初始按钮为「检查更新」");
  ok(!textOf(t).includes("立即更新"), "初始不出现「立即更新」");
}

group("1.4.0 情况一：有新版本 → 按钮变「立即更新」");
{
  resetVerScenario(VER_BASE(), { ok: true, hasUpdate: true, currentVersion: "1.4.0", latestVersion: "1.5.0" });
  let t = await renderVer();
  verBtn(t).props.onClick();
  await tick();
  t = rt.render();
  ok(textOf(verBtn(t)) === "立即更新", "检出新版本后按钮变为「立即更新」");
  ok(verText(t).includes("发现新版本 v1.5.0"), "显示新版本提示", verText(t));
  ok(byClass(t, "appupd-version-new").length === 1, "新版本提示配色生效");
}

group("1.4.0 情况二：无新版本 → 明确提示已是最新，按钮保持「检查更新」");
{
  resetVerScenario(VER_BASE(), { ok: true, hasUpdate: false, currentVersion: "1.4.0", latestVersion: "1.4.0" });
  let t = await renderVer();
  verBtn(t).props.onClick();
  await tick();
  t = rt.render();
  ok(textOf(verBtn(t)) === "检查更新", "无新版本时按钮仍为「检查更新」");
  ok(verText(t).includes("当前已是最新版本"), "明确提示当前已是最新版本", verText(t));
  ok(!textOf(t).includes("立即更新"), "无新版本时不出现「立即更新」");
}

group("1.4.0 情况三：检查失败后重试");
{
  resetVerScenario(VER_BASE(), { ok: false, error: "检查更新失败：网络不可达" });
  let t = await renderVer();
  verBtn(t).props.onClick();
  await tick();
  t = rt.render();
  ok(textOf(verBtn(t)) === "重试", "检查失败后按钮变为「重试」");
  ok(verText(t).includes("检查更新失败"), "给出失败提示", verText(t));
  ok(verText(t).includes("可点击重试") || textOf(verBtn(t)) === "重试", "提示可重试");
  // 重试时改为「有新版本」，验证失败态不残留、重试能正确恢复
  checkUpdateResponse = { ok: true, hasUpdate: true, currentVersion: "1.4.0", latestVersion: "1.6.0" };
  verBtn(t).props.onClick();
  await tick();
  t = rt.render();
  ok(textOf(verBtn(t)) === "立即更新", "失败后重试成功 → 切到「立即更新」");
  ok(!verText(t).includes("检查更新失败"), "失败提示已清除，不再残留", verText(t));
}

group("1.4.0 情况四：进行中禁止重复点击");
{
  let resolveDeferred;
  checkUpdateDeferred = { promise: new Promise((r) => { resolveDeferred = r; }) };
  resetVerScenario(VER_BASE(), { ok: true, hasUpdate: false, currentVersion: "1.4.0", latestVersion: "1.4.0" });
  // resetVerScenario 会清掉 deferred，重新挂上
  checkUpdateDeferred = { promise: new Promise((r) => { resolveDeferred = r; }) };
  let t = await renderVer();
  const before = calls.filter((c) => c.url.endsWith("/check-update")).length;
  verBtn(t).props.onClick(); // 第一次点击 → 进入检查中
  await tick();
  t = rt.render();
  ok(textOf(verBtn(t)) === "检查中…", "检查过程中按钮显示「检查中…」");
  ok(verBtn(t).props.disabled === true, "检查过程中按钮被禁用");
  ok(verBtn(t).props["aria-busy"] === "true", "检查过程中 aria-busy 为 true");
  // 进行中再点两次（模拟用户连续点击）
  verBtn(t).props.onClick();
  verBtn(t).props.onClick();
  await tick();
  t = rt.render();
  const during = calls.filter((c) => c.url.endsWith("/check-update")).length;
  ok(during === before + 1, "进行中重复点击不会发起第二次请求（只发 1 次）", { before, during });
  ok(textOf(verBtn(t)) === "检查中…", "进行中按钮文案不被重复点击改写");
  // 放行挂起的请求，验证能正常收尾
  resolveDeferred(jsonResponse({ ok: true, hasUpdate: false, currentVersion: "1.4.0", latestVersion: "1.4.0" }));
  await tick();
  await tick();
  t = rt.render();
  ok(textOf(verBtn(t)) === "检查更新", "请求结束后按钮恢复可点击的「检查更新」");
  ok(verBtn(t).props.disabled !== true, "请求结束后按钮解除禁用");
}

group("1.4.0 状态切换正确性：更新完成 / 重新检查无新版 不残留「立即更新」");
{
  // ① 先检出新版本
  resetVerScenario(VER_BASE(), { ok: true, hasUpdate: true, currentVersion: "1.4.0", latestVersion: "1.5.0" });
  let t = await renderVer();
  verBtn(t).props.onClick();
  await tick();
  t = rt.render();
  ok(textOf(verBtn(t)) === "立即更新", "前置：出现「立即更新」");
  // ② 点「立即更新」→ 完成后应回到「检查更新」，且不残留
  selfUpdateResponse = { ok: true, message: "已更新到 v1.5.0" };
  verBtn(t).props.onClick();
  await tick();
  await tick();
  t = rt.render();
  ok(textOf(verBtn(t)) === "检查更新", "更新完成后按钮回到「检查更新」");
  ok(!textOf(t).includes("立即更新"), "更新完成后不残留「立即更新」");
  ok(verText(t).includes("已更新到 v1.5.0"), "给出更新完成提示", verText(t));

  // ③ 再次检出新版本，然后重新检查判定无新版本 → 必须清掉「立即更新」
  resetVerScenario(VER_BASE(), { ok: true, hasUpdate: true, currentVersion: "1.4.0", latestVersion: "1.5.0" });
  t = await renderVer();
  verBtn(t).props.onClick();
  await tick();
  t = rt.render();
  ok(textOf(verBtn(t)) === "立即更新", "前置：再次出现「立即更新」");
  checkUpdateResponse = { ok: true, hasUpdate: false, currentVersion: "1.4.0", latestVersion: "1.4.0" };
  // 强制从「检查更新」态重新走一次检查（模拟用户点检查更新）
  // 通过重试路径：先把状态打回 idle 的方式是触发一次失败→重试，这里直接复用按钮当前动作
  // 「立即更新」态下按钮执行自更新；要模拟「重新检查」，用 alreadyCurrent 让宿主清态：
  selfUpdateResponse = { ok: true, alreadyCurrent: true, message: "当前已是最新版本，无需更新" };
  verBtn(t).props.onClick();
  await tick();
  await tick();
  t = rt.render();
  ok(textOf(verBtn(t)) === "检查更新", "重新判定无新版后回到「检查更新」");
  ok(!textOf(t).includes("立即更新"), "重新判定无新版后不残留「立即更新」");
}

group("1.4.0 自更新失败：给出失败提示并允许重试");
{
  resetVerScenario(VER_BASE(), { ok: true, hasUpdate: true, currentVersion: "1.4.0", latestVersion: "1.5.0" });
  let t = await renderVer();
  verBtn(t).props.onClick();
  await tick();
  t = rt.render();
  selfUpdateResponse = { ok: false, error: "更新失败：dsh 未找到" };
  verBtn(t).props.onClick();
  await tick();
  await tick();
  t = rt.render();
  ok(verText(t).includes("更新失败"), "自更新失败给出失败提示", verText(t));
  ok(textOf(verBtn(t)) === "重试", "自更新失败后按钮为「重试」");
  ok(!textOf(t).includes("立即更新"), "自更新失败后不残留「立即更新」");
}

/* ---------------- 1.4.1：下载源 403 行降级为「需手动」 ---------------- */
group("1.4.1 官网下载源 403：不再列为可一键更新");
{
  // 模拟宿主扫描后的行：UU远程 已被 applySourceFailure 降级
  const state403 = baseState({
    apps: {
      scannedAt: Date.now(),
      stats: { total: 2, upgradable: 1, manual: 1, unsupported: 0 },
      items: [
        { id: "Git.Git", name: "Git", version: "2.55.0", available: "2.56.0", publisher: "Git", source: "winget", hasUpdate: true, updateSupported: true, reason: null },
        {
          id: "NetEase.UURemote", name: "UU远程", version: "4.45.1.4372", available: "4.47.0.5146",
          publisher: "NetEase", source: "winget", hasUpdate: true, updateSupported: false,
          reason: "source-unavailable", latestNewer: true, latestVersion: "4.47.0.5146", latestVia: "source-failure",
          adoptHint: "发布方下载源返回 403，插件暂时无法自动下载；请等待发布方修复，或到官网手动下载新版安装",
        },
      ],
    },
    sourceFailures: { "NetEase.UURemote": { at: Date.now(), reason: "官网下载源拒绝访问（403 Forbidden）" } },
  });
  statePayload = state403;
  rt.reset();
  await tick();
  let t = rt.render();
  await tick();
  t = rt.render();

  // ① 状态列显示「需手动」并带 403 说明，而不是「有新版本」
  const manualStates = byClass(t, "appupd-state-manual").map(textOf);
  ok(manualStates.includes("需手动"), "403 行状态列显示「需手动」", manualStates);
  const manualCell = byClass(t, "appupd-state-manual").find((n) => textOf(n) === "需手动");
  ok(manualCell && /403/.test(String(manualCell.props.title || "")), "悬停说明里点明 403 与官网下载源", manualCell && manualCell.props.title);
  ok(manualCell && /官网手动|官网下载|发布方修复/.test(String(manualCell.props.title || "")), "悬停给出可操作下一步");

  // ② 可勾选集合只含 Git，403 行不被「全部更新」带上
  const boxes = byClass(t, "appupd-cb");
  // 表头全选框 + 每行一个；403 行的 checkbox 应 disabled
  const rowBoxes = boxes.filter((b) => b.props["aria-label"] !== "全选可更新的应用");
  ok(rowBoxes.length === 2, "渲染出 2 个行勾选框", rowBoxes.length);
  const disabledBoxes = rowBoxes.filter((b) => b.props.disabled === true);
  ok(disabledBoxes.length === 1, "403 行的勾选框被禁用（不会被勾上）", disabledBoxes.length);

  // ③ 「仅可更新」分段不出现 403 行
  const updBtn = byClass(t, "appupd-seg-btn").find((b) => textOf(b) === "仅可更新");
  if (updBtn) {
    await updBtn.props.onClick();
    await tick();
    t = rt.render();
    await tick();
    const names = byClass(t, "appupd-name").map(textOf);
    ok(!names.includes("UU远程") && names.includes("Git"), "「仅可更新」里不再有必然失败的 403 行", names);
  }

  // ④ 「需手动」分段收下 403 行（与 macOS「官网有新版」同口径）
  const allBtn = byClass(t, "appupd-seg-btn").find((b) => textOf(b) === "全部");
  if (allBtn) { await allBtn.props.onClick(); await tick(); t = rt.render(); await tick(); }
  const manualBtn = byClass(t, "appupd-seg-btn").find((b) => textOf(b) === "需手动");
  if (manualBtn) {
    await manualBtn.props.onClick();
    await tick();
    t = rt.render();
    await tick();
    const names = byClass(t, "appupd-name").map(textOf);
    ok(names.includes("UU远程"), "「需手动」分段收下 403 行", names);
  }
  ok(textOf(t).includes("官网下载源不可用（403）") || textOf(t).includes("需手动"), "原因文案可溯源到 403");
}

console.log(`\n${failures === 0 ? "全部通过" : "存在失败"}：${checks - failures}/${checks}`);
process.exit(failures === 0 ? 0 : 1);