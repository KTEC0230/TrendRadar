/**
 * 静流云端 API（Cloudflare Worker + KV）
 *
 * 手机 App 的固定地址后端——电脑关机不影响。数据全部存 KV：
 *   state.db        管道台账（GH Actions 每轮经由内部端点回传）
 *   feed.json       近 N 条已推契约 + 兴趣快照（sync-out 生成）
 *   interests:<t>   兴趣文件 overlay（App PUT 写入 → 下轮 Actions sync-in 生效）
 *   feedback        {契约id: useful|useless} 反馈 overlay（读时合并）
 *
 * 两套鉴权：
 *   /api/*      Bearer <JINGLIU_API_TOKEN>   —— App 调用，语义与本地 api_server.py 一致
 *   /internal/* Bearer <JINGLIU_SYNC_TOKEN>  —— 仅 GH Actions 云同步用
 *
 * 未实现的端点（设备注册/源管理/待推池）：轮询架构无需设备注册，源管理走仓库
 * config.yaml，/contracts/pending 与 App 无关。App 只用到 health/recent/feedback/interests。
 */

const KEY_STATE_DB = "state.db";
const KEY_FEED = "feed.json";
const KEY_FEEDBACK = "feedback";
const KEY_SOURCES_CONFIG = "sources_config.json";
const KEY_WEBPAGE_SOURCES = "webpage_sources.json";
const KEY_REPORT_INDEX = "report_index.json";
const KEY_INTERESTS = (t) => `interests:${t}`;

const INTEREST_TARGETS = ["ai_interests", "frequency_words"];
const INTEREST_PATHS = {
  ai_interests: "config/ai_interests.txt",
  frequency_words: "config/frequency_words.txt",
};
const KV_VALUE_LIMIT = 25 * 1024 * 1024; // KV 单值上限 25MiB

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

/** 恒定时间比较（对齐本地 api_server 的 hmac.compare_digest 纪律） */
function safeEqual(a, b) {
  const ab = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

function checkAuth(request, token) {
  const header = request.headers.get("Authorization") || "";
  return header.startsWith("Bearer ") && safeEqual(header.slice(7).trim(), token);
}

function unauthorized() {
  return json({ error: "unauthorized" }, 401);
}

async function readJson(request, maxBytes) {
  const text = await request.text();
  if (new TextEncoder().encode(text).length > maxBytes) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** 反馈 overlay：{契约id字符串: "useful"|"useless"} */
async function loadFeedback(env) {
  const raw = await env.KV.get(KEY_FEEDBACK);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function handleAppApi(request, url, env) {
  const token = env.JINGLIU_API_TOKEN;
  const path = url.pathname;
  const method = request.method;

  // 探活免鉴权（对齐本地 API）
  if (method === "GET" && path === "/api/health") {
    return json({ status: "ok", backend: "worker-kv" });
  }

  // HTML 报告：Custom Tabs 无法带请求头，用 query token 校验（值=App token）
  if (method === "GET" && path === "/api/report") {
    const qtoken = url.searchParams.get("token") || "";
    if (!safeEqual(qtoken, token)) return unauthorized();
    const report = await env.KV.get("report.html");
    if (!report) return json({ error: "云端暂无报告" }, 404);
    return new Response(report, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  // 历史报告列表（Bearer）
  if (method === "GET" && path === "/api/reports") {
    if (!checkAuth(request, token)) return unauthorized();
    const raw = await env.KV.get(KEY_REPORT_INDEX);
    let reports = [];
    if (raw) {
      try {
        reports = JSON.parse(raw).reports || [];
      } catch {}
    }
    return json({ reports });
  }

  // 单份历史报告（query token；WebView/内置浏览器直接加载）
  const reportFileMatch = path.match(/^\/api\/report\/file\/([\w.-]+\.html)$/);
  if (method === "GET" && reportFileMatch) {
    const qtoken = url.searchParams.get("token") || "";
    if (!safeEqual(qtoken, token)) return unauthorized();
    const html = await env.KV.get(`report/${reportFileMatch[1]}`);
    if (!html) return json({ error: "报告不存在" }, 404);
    return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  }

  // ---- 信息源管理（App 源管理屏；overlay 单一真源，下一轮管道生效） ----
  if (method === "GET" && path === "/api/sources-config") {
    const feedRaw = await env.KV.get(KEY_FEED);
    const feed = feedRaw ? JSON.parse(feedRaw) : {};
    const overlayRaw = await env.KV.get(KEY_SOURCES_CONFIG);
    let overlay = { disabled_platform_ids: [], disabled_feed_ids: [], extra_feeds: [] };
    if (overlayRaw) {
      try {
        const parsed = JSON.parse(overlayRaw);
        if (parsed && typeof parsed === "object") overlay = { ...overlay, ...parsed };
      } catch {}
    }
    return json({
      catalog: feed.sources_catalog || { platforms: [], feeds: [] },
      overlay,
    });
  }
  if (method === "PUT" && path === "/api/sources-config") {
    const body = await readJson(request, 256 * 1024);
    if (!body || typeof body !== "object") return json({ error: "请求体必须是 JSON 对象" }, 400);
    const clean = {
      disabled_platform_ids: Array.isArray(body.disabled_platform_ids) ? body.disabled_platform_ids.map(String) : [],
      disabled_feed_ids: Array.isArray(body.disabled_feed_ids) ? body.disabled_feed_ids.map(String) : [],
      extra_feeds: Array.isArray(body.extra_feeds)
        ? body.extra_feeds
            .filter((f) => f && typeof f === "object" && typeof f.url === "string" && f.url.trim())
            .map((f) => ({
              id: String(f.id || "").trim() || `custom-${Date.now()}`,
              name: String(f.name || "").trim() || "自定义源",
              url: String(f.url).trim(),
            }))
        : [],
    };
    await env.KV.put(KEY_SOURCES_CONFIG, JSON.stringify(clean));
    return json({ updated: true, overlay: clean });
  }

  if (!checkAuth(request, token)) return unauthorized();

  // ---- 今日热榜 ----
  if (method === "GET" && path === "/api/hotlist") {
    const feedRaw = await env.KV.get(KEY_FEED);
    const feed = feedRaw ? JSON.parse(feedRaw) : {};
    return json(feed.hotlist || { date: "", platforms: [] });
  }

  // ---- 网页监控源管理（overlay 单一真源；catalog = state.db 实况） ----
  if (method === "GET" && path === "/api/webpage-sources") {
    const feedRaw = await env.KV.get(KEY_FEED);
    const feed = feedRaw ? JSON.parse(feedRaw) : {};
    const overlayRaw = await env.KV.get(KEY_WEBPAGE_SOURCES);
    let overlay = { webpage_sources: [] };
    if (overlayRaw) {
      try {
        const parsed = JSON.parse(overlayRaw);
        if (Array.isArray(parsed)) overlay = { webpage_sources: parsed };
      } catch {}
    }
    return json({ catalog: feed.webpage_sources || [], overlay });
  }
  if (method === "PUT" && path === "/api/webpage-sources") {
    const body = await readJson(request, 256 * 1024);
    const list = Array.isArray(body?.webpage_sources) ? body.webpage_sources : null;
    if (!list) return json({ error: "webpage_sources 必须为数组" }, 400);
    const clean = list
      .filter((e) => e && typeof e === "object" && typeof e.url === "string" && /^https?:\/\//.test(e.url.trim()))
      .map((e, i) => ({
        uid: String(e.uid || `wp-${i}-${Date.now()}`),
        name: String(e.name || "").trim().slice(0, 100) || "网页监控",
        url: String(e.url).trim(),
        enabled: e.enabled !== false,
        check_interval: Math.max(30, parseInt(e.check_interval, 10) || 30),
      }));
    await env.KV.put(KEY_WEBPAGE_SOURCES, JSON.stringify(clean));
    return json({ updated: true, count: clean.length });
  }

  // ---- 推送流 ----
  if (method === "GET" && path === "/api/contracts/recent") {
    const limitRaw = parseInt(url.searchParams.get("limit") || "50", 10);
    const limit = Math.max(1, Math.min(Number.isNaN(limitRaw) ? 50 : limitRaw, 200));
    const feedRaw = await env.KV.get(KEY_FEED);
    const feed = feedRaw ? JSON.parse(feedRaw) : { contracts: [], interests: {} };
    const feedback = await loadFeedback(env);
    const contracts = (feed.contracts || []).slice(0, limit).map((c) => ({
      ...c,
      user_feedback: feedback[String(c.id)] ?? c.user_feedback ?? "",
    }));
    return json({ contracts });
  }

  // ---- 契约反馈 ----
  const feedbackMatch = path.match(/^\/api\/contracts\/(\d+)\/feedback$/);
  if (method === "POST" && feedbackMatch) {
    const body = await readJson(request, 64 * 1024);
    if (!body || !(typeof body.feedback === "string")) {
      return json({ error: "feedback 必须为字符串" }, 400);
    }
    if (!["useful", "useless", ""].includes(body.feedback)) {
      return json({ error: "feedback 必须为 useful / useless / 空串(清除)" }, 400);
    }
    const feedback = await loadFeedback(env);
    const id = feedbackMatch[1];
    if (body.feedback === "") {
      delete feedback[id];
    } else {
      feedback[id] = body.feedback;
    }
    await env.KV.put(KEY_FEEDBACK, JSON.stringify(feedback));
    return json({ updated: true, contract_id: parseInt(id, 10), feedback: body.feedback });
  }

  // ---- 兴趣文件 ----
  if (method === "GET" && path === "/api/interests") {
    const feedRaw = await env.KV.get(KEY_FEED);
    const feed = feedRaw ? JSON.parse(feedRaw) : { interests: {} };
    const result = {};
    for (const target of INTEREST_TARGETS) {
      const overlay = await env.KV.get(KEY_INTERESTS(target));
      const content = overlay !== null ? overlay : feed.interests?.[target] || "";
      result[target] = {
        path: INTEREST_PATHS[target],
        exists: content.length > 0,
        content,
      };
    }
    return json(result);
  }

  if (method === "PUT" && path === "/api/interests") {
    const body = await readJson(request, 320 * 1024);
    if (!body || !INTEREST_TARGETS.includes(body.target)) {
      return json({ error: "target 必须为 ai_interests/frequency_words" }, 400);
    }
    if (typeof body.content !== "string") {
      return json({ error: "content 必须为字符串" }, 400);
    }
    await env.KV.put(KEY_INTERESTS(body.target), body.content);
    return json({ updated: true, target: body.target, path: INTEREST_PATHS[body.target] });
  }

  return json({ error: `未知端点: ${method} ${path}` }, 404);
}

async function handleInternalApi(request, url, env) {
  const token = env.JINGLIU_SYNC_TOKEN;
  const path = url.pathname;
  const method = request.method;

  // ---- state.db 回传 / 拉取 ----
  if (method === "GET" && path === "/internal/state.db") {
    const value = await env.KV.get(KEY_STATE_DB, { type: "arrayBuffer" });
    if (!value) return json({ error: "远端暂无 state.db" }, 404);
    return new Response(value, {
      headers: { "Content-Type": "application/octet-stream" },
    });
  }
  if (method === "PUT" && path === "/internal/state.db") {
    const body = await request.arrayBuffer();
    if (body.byteLength > KV_VALUE_LIMIT) {
      return json({ error: `state.db 超过 KV 单值上限（${body.byteLength} 字节）` }, 413);
    }
    await env.KV.put(KEY_STATE_DB, body);
    return json({ ok: true, size: body.byteLength });
  }

  // ---- feed.json 上传（顺带把反馈 overlay 修剪到现存契约） ----
  if (method === "PUT" && path === "/internal/feed.json") {
    const text = await request.text();
    if (new TextEncoder().encode(text).length > KV_VALUE_LIMIT) {
      return json({ error: "feed.json 超过 KV 单值上限" }, 413);
    }
    let feed;
    try {
      feed = JSON.parse(text);
    } catch {
      return json({ error: "feed.json 不是合法 JSON" }, 400);
    }
    if (!Array.isArray(feed.contracts)) {
      return json({ error: "feed.contracts 必须为数组" }, 400);
    }
    await env.KV.put(KEY_FEED, text);
    // 反馈字典只保留仍在推送流里的契约 id，防无限增长
    const liveIds = new Set(feed.contracts.map((c) => String(c.id)));
    const feedback = await loadFeedback(env);
    const pruned = {};
    for (const [id, value] of Object.entries(feedback)) {
      if (liveIds.has(id)) pruned[id] = value;
    }
    await env.KV.put(KEY_FEEDBACK, JSON.stringify(pruned));
    return json({ ok: true, contracts: feed.contracts.length });
  }

  // ---- HTML 报告上传（App 内置浏览器查看） ----
  if (method === "PUT" && path === "/internal/report.html") {
    const body = await request.text();
    if (new TextEncoder().encode(body).length > KV_VALUE_LIMIT) {
      return json({ error: "report.html 超过 KV 单值上限" }, 413);
    }
    await env.KV.put("report.html", body);
    return json({ ok: true, size: new TextEncoder().encode(body).length });
  }

  // ---- 信息源 overlay（sync-in 拉取用；无 overlay → 404，管道恢复默认） ----
  if (method === "GET" && path === "/internal/sources-config") {
    const overlay = await env.KV.get(KEY_SOURCES_CONFIG);
    if (!overlay) return json({ error: "无信息源 overlay" }, 404);
    return new Response(overlay, { headers: JSON_HEADERS });
  }

  // ---- 网页监控 overlay（sync-in 拉取用；无 → 404，管道跳过应用） ----
  if (method === "GET" && path === "/internal/webpage-sources") {
    const overlay = await env.KV.get(KEY_WEBPAGE_SOURCES);
    if (!overlay) return json({ error: "无网页监控 overlay" }, 404);
    return new Response(overlay, { headers: JSON_HEADERS });
  }

  // ---- 历史报告上传（sync-out：单份文件 + 索引） ----
  const reportPutMatch = path.match(/^\/internal\/report\/([\w.-]+\.html)$/);
  if (method === "PUT" && reportPutMatch) {
    const body = await request.text();
    if (new TextEncoder().encode(body).length > KV_VALUE_LIMIT) {
      return json({ error: "报告超过 KV 单值上限" }, 413);
    }
    await env.KV.put(`report/${reportPutMatch[1]}`, body);
    return json({ ok: true });
  }
  if (method === "PUT" && path === "/internal/report-index") {
    const body = await readJson(request, 1024 * 1024);
    if (!body || !Array.isArray(body.reports)) return json({ error: "reports 必须为数组" }, 400);
    await env.KV.put(KEY_REPORT_INDEX, JSON.stringify({ reports: body.reports.slice(0, 20) }));
    return json({ ok: true, count: Math.min(body.reports.length, 20) });
  }

  // ---- 兴趣 overlay（sync-in 拉取用；无 overlay 时返回 null 让管道用仓库配置） ----
  if (method === "GET" && path === "/internal/interests") {
    const result = {};
    for (const target of INTEREST_TARGETS) {
      result[target] = await env.KV.get(KEY_INTERESTS(target)); // string | null
    }
    return json(result);
  }

  return json({ error: `未知端点: ${method} ${path}` }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith("/api/")) {
        return await handleAppApi(request, url, env);
      }
      if (url.pathname.startsWith("/internal/")) {
        if (!checkAuth(request, env.JINGLIU_SYNC_TOKEN)) return unauthorized();
        return await handleInternalApi(request, url, env);
      }
      return json({ error: "not found" }, 404);
    } catch (e) {
      return json({ error: `internal: ${(e && e.message) || e}` }, 500);
    }
  },
};
