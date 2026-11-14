/**
 * 「官网下载源级失败」记录（1.4.1）。
 *
 * 背景：某些应用的发布方 CDN / 清单源会返回 403（实测 NetEase.UURemote），
 * winget download 与 winget upgrade 共用同一个 URL，必然复现同一错误。
 * 扫描阶段无法预知 URL 是否 403，这类应用仍会被列进「可一键更新」，
 * 用户点下去必然失败（截图里的「成功 0 / 1（1 个失败）」）。
 *
 * 做法：**不硬编码包名**。更新任务把「源级失败」按 winget id 记进 state.json，
 * 下一次扫描读取这张表，给命中行降级为「需手动」并给出可操作提示；
 * 一旦后续更新成功，记录随即清除，行自动恢复为可一键更新。
 * 所有判断都是纯函数，便于单测，也不改动既有扫描/更新主流程的其它逻辑。
 */

/** 只认 HTTP 403 这一类「发布方 CDN 拒绝」；其它源级失败（找不到包/哈希不符）不落库，避免误降级。 */
const SOURCE_403_RE = /0x80190193|Forbidden \(403\)|HTTP 403|403 Forbidden|官网下载源拒绝访问/i;

/** 记录上限：防止异常环境下 state.json 被无限撑大。 */
export const MAX_SOURCE_FAILURES = 200;

/** 一条更新结果是否「发布方下载源 403」造成的失败。 */
export function isDownloadSource403(text) {
  return SOURCE_403_RE.test(String(text || ""));
}

/**
 * 从一次更新结果里挑出所有「源级 403」失败的 id。
 * 成功项不在此列（调用方据此清除旧记录）。
 * @param {Array<{id?:string, ok?:boolean, error?:string}>} results
 * @returns {string[]} 去重、保序、非空的 id
 */
export function sourceFailedIds(results) {
  const out = [];
  const seen = new Set();
  for (const r of Array.isArray(results) ? results : []) {
    if (!r || r.ok || !r.id) continue;
    if (!isDownloadSource403(r.error)) continue;
    const id = String(r.id).trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** 成功的 id（用于清除此前记下的源级失败）。 */
export function sourceRecoveredIds(results) {
  const out = [];
  const seen = new Set();
  for (const r of Array.isArray(results) ? results : []) {
    if (!r || !r.ok || !r.id) continue;
    const id = String(r.id).trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * 把一次更新结果合并进记录表，返回新表（不修改入参）。
 * - 失败且为 403 → 记 { at, reason }
 * - 成功 → 删掉该 id 的旧记录
 * - 超过上限 → 保留最近 MAX_SOURCE_FAILURES 条
 * @param {Record<string,{at:number,reason:string}>} current
 * @param {Array} results
 * @param {number} [now]
 */
export function mergeSourceFailures(current, results, now = Date.now()) {
  const next = {};
  for (const [k, v] of Object.entries(current && typeof current === "object" ? current : {})) {
    if (k && v && typeof v === "object") next[k] = { at: Number(v.at) || 0, reason: String(v.reason || "") };
  }
  for (const id of sourceFailedIds(results)) next[id] = { at: now, reason: "官网下载源拒绝访问（403 Forbidden）" };
  for (const id of sourceRecoveredIds(results)) delete next[id];
  const keys = Object.keys(next);
  if (keys.length > MAX_SOURCE_FAILURES) {
    keys.sort((a, b) => (next[a].at || 0) - (next[b].at || 0));
    for (const k of keys.slice(0, keys.length - MAX_SOURCE_FAILURES)) delete next[k];
  }
  return next;
}

/**
 * 把记录表应用到一条 Windows 扫描结果行上（纯函数，不修改入参）。
 *
 * 命中条件：该 id 有 403 记录，且这一行本来被判为「可一键更新」。
 * 效果：hasUpdate 保留（目录里确实有新版，不能谎报「已是最新」）、
 *       updateSupported=false、reason="source-unavailable"、
 *       adoptHint 给出可操作的下一步。
 * @returns {{item:object, changed:boolean}}
 */
export function applySourceFailure(item, failures) {
  const src = item && typeof item === "object" ? item : {};
  const id = String(src.id || "").trim();
  const rec = failures && typeof failures === "object" ? failures[id] : null;
  const eligible = Boolean(src.hasUpdate && src.updateSupported && rec);
  if (!eligible) return { item: src, changed: false };
  return {
    changed: true,
    item: {
      ...src,
      updateSupported: false,
      reason: "source-unavailable",
      /* 与 macOS「官网有新版」同构：让前端「需手动」分段收这一行，
         并把它从「未收录」分段排除（两者互斥）。 */
      latestNewer: true,
      latestVersion: String(src.available || src.version || "") || "新版本",
      latestVia: "source-failure",
      adoptHint: "发布方下载源返回 403，插件暂时无法自动下载；请等待发布方修复，或到官网手动下载新版安装",
      sourceFailedAt: Number(rec.at) || 0,
    },
  };
}
