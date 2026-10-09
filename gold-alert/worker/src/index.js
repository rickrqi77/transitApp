/**
 * Gold Price Alert System - Cloudflare Worker API
 *
 * Secrets (wrangler secret put):
 *   API_TOKEN           - shared token for web + EA
 *   TELEGRAM_BOT_TOKEN  - Telegram Bot API token
 *   TELEGRAM_CHAT_ID    - Telegram chat/user id
 */

const EA_OFFLINE_SECONDS = 15;
const MAX_ALERTS = 10;

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);

      if (url.pathname.startsWith("/api/")) {
        return await handleApi(request, env, url);
      }

      // Static web assets
      if (env.ASSETS) {
        return env.ASSETS.fetch(request);
      }

      return json({ error: "Not found" }, 404);
    } catch (err) {
      console.error("Unhandled error:", err);
      return json({ error: "Internal server error", detail: String(err.message || err) }, 500);
    }
  },
};

// ---------------------------------------------------------------------------
// API router
// ---------------------------------------------------------------------------

async function handleApi(request, env, url) {
  const path = url.pathname;
  const method = request.method.toUpperCase();

  // CORS preflight
  if (method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  // Auth for all API routes
  const auth = checkAuth(request, env);
  if (!auth.ok) {
    return json({ error: auth.error }, 401);
  }

  if (method === "GET" && path === "/api/status") {
    return await getStatus(env);
  }
  if (method === "GET" && path === "/api/alerts") {
    return await getAlerts(env);
  }
  if (method === "POST" && path === "/api/alerts") {
    return await saveAlerts(request, env);
  }
  if (method === "DELETE" && path.startsWith("/api/alerts/")) {
    const id = path.slice("/api/alerts/".length);
    return await deleteAlert(id, env);
  }
  if (method === "POST" && path === "/api/alerts/auto") {
    return await autoGenerateAlerts(request, env);
  }
  if (method === "POST" && path === "/api/ea/heartbeat") {
    return await eaHeartbeat(request, env);
  }
  if (method === "GET" && path === "/api/config") {
    return await getConfig(env);
  }
  if (method === "POST" && path === "/api/alert-trigger") {
    return await alertTrigger(request, env);
  }
  if (method === "GET" && path === "/api/settings") {
    return await getSettings(env);
  }
  if (method === "POST" && path === "/api/settings") {
    return await saveSettings(request, env);
  }

  return json({ error: "Not found" }, 404);
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

function checkAuth(request, env) {
  const expected = env.API_TOKEN;
  if (!expected) {
    return { ok: false, error: "Server API_TOKEN not configured" };
  }

  const authHeader = request.headers.get("Authorization") || "";
  let token = "";

  if (authHeader.toLowerCase().startsWith("bearer ")) {
    token = authHeader.slice(7).trim();
  } else {
    token = request.headers.get("X-Api-Token") || "";
  }

  // Also allow ?token= for simple browser testing (not preferred)
  if (!token) {
    try {
      const url = new URL(request.url);
      token = url.searchParams.get("token") || "";
    } catch (_) {
      /* ignore */
    }
  }

  if (!token || token !== expected) {
    return { ok: false, error: "Unauthorized" };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function getStatus(env) {
  const status = await env.DB.prepare("SELECT * FROM system_status WHERE id = 1").first();
  const settings = await env.DB.prepare("SELECT step, telegram_enabled FROM settings WHERE id = 1").first();
  const countRow = await env.DB.prepare("SELECT COUNT(*) AS c FROM alerts").first();

  const lastSeen = status?.last_seen || null;
  const eaOnline = isEaOnline(lastSeen);

  return json({
    symbol: status?.symbol || "XAUUSD",
    price: status?.price ?? null,
    bid: status?.bid ?? null,
    ask: status?.ask ?? null,
    ea_online: eaOnline,
    last_seen: lastSeen,
    alerts_count: countRow?.c ?? 0,
    step: settings?.step ?? 5,
    telegram_enabled: !!(settings?.telegram_enabled),
    config_version: status?.config_version ?? 1,
  });
}

async function getAlerts(env) {
  const { results } = await env.DB.prepare(
    "SELECT id, price, enabled, triggered, last_trigger_direction, last_trigger_time, created_at, updated_at FROM alerts ORDER BY price ASC"
  ).all();

  return json({ alerts: results || [], max: MAX_ALERTS });
}

async function saveAlerts(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const alerts = Array.isArray(body.alerts) ? body.alerts : null;
  if (!alerts) {
    return json({ error: "alerts array required" }, 400);
  }
  if (alerts.length > MAX_ALERTS) {
    return json({ error: `Maximum ${MAX_ALERTS} alerts allowed` }, 400);
  }

  // Validate prices
  const prices = [];
  for (const a of alerts) {
    const p = Number(a.price);
    if (!Number.isFinite(p) || p <= 0) {
      return json({ error: `Invalid price: ${a.price}` }, 400);
    }
    const enabled = a.enabled === false || a.enabled === 0 ? 0 : 1;
    prices.push({
      price: roundPrice(p),
      enabled,
      // Re-arm only when the user explicitly turns 触发 on.
      triggered: enabled ? 0 : (a.triggered ? 1 : 0),
    });
  }

  // Check uniqueness
  const unique = new Set(prices.map((p) => p.price));
  if (unique.size !== prices.length) {
    return json({ error: "Duplicate alert prices are not allowed" }, 400);
  }

  // Optional step update
  if (body.step != null) {
    const step = Number(body.step);
    if (!Number.isFinite(step) || step <= 0) {
      return json({ error: "Invalid step" }, 400);
    }
    await env.DB.prepare(
      "UPDATE settings SET step = ?, updated_at = datetime('now') WHERE id = 1"
    )
      .bind(step)
      .run();
  }

  // Replace all alerts atomically
  await env.DB.batch([
    env.DB.prepare("DELETE FROM alerts"),
    ...prices.map((p) =>
      env.DB.prepare(
        "INSERT INTO alerts (price, enabled, triggered, created_at, updated_at) VALUES (?, ?, ?, datetime('now'), datetime('now'))"
      ).bind(p.price, p.enabled, p.triggered)
    ),
    env.DB.prepare(
      "UPDATE system_status SET config_version = config_version + 1, updated_at = datetime('now') WHERE id = 1"
    ),
  ]);

  const { results } = await env.DB.prepare(
    "SELECT id, price, enabled, triggered, created_at, updated_at FROM alerts ORDER BY price ASC"
  ).all();
  const status = await env.DB.prepare("SELECT config_version FROM system_status WHERE id = 1").first();

  return json({
    ok: true,
    message: "设置已保存",
    alerts: results || [],
    config_version: status?.config_version ?? 1,
  });
}

async function deleteAlert(idStr, env) {
  const id = Number(idStr);
  if (!Number.isInteger(id) || id <= 0) {
    return json({ error: "Invalid alert id" }, 400);
  }

  const existing = await env.DB.prepare("SELECT id FROM alerts WHERE id = ?").bind(id).first();
  if (!existing) {
    return json({ error: "Alert not found" }, 404);
  }

  await env.DB.batch([
    env.DB.prepare("DELETE FROM alerts WHERE id = ?").bind(id),
    env.DB.prepare(
      "UPDATE system_status SET config_version = config_version + 1, updated_at = datetime('now') WHERE id = 1"
    ),
  ]);

  return json({ ok: true, message: "已删除", id });
}

async function autoGenerateAlerts(request, env) {
  let body = {};
  try {
    const text = await request.text();
    if (text) body = JSON.parse(text);
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const status = await env.DB.prepare("SELECT * FROM system_status WHERE id = 1").first();
  const settings = await env.DB.prepare("SELECT step FROM settings WHERE id = 1").first();

  if (!isEaOnline(status?.last_seen) || status?.price == null) {
    return json(
      { error: "EA当前离线，无法获取最新黄金价格。", code: "EA_OFFLINE" },
      409
    );
  }

  let step = body.step != null ? Number(body.step) : Number(settings?.step ?? 5);
  if (!Number.isFinite(step) || step <= 0) {
    return json({ error: "Invalid step" }, 400);
  }

  const currentPrice = Number(status.price);
  // Use the integer part as the grid base, e.g. 4181.2 → 4181
  const base = Math.trunc(currentPrice);
  const prices = [];

  for (let i = 5; i >= 1; i--) {
    prices.push(roundPrice(base - step * i));
  }
  for (let i = 1; i <= 5; i++) {
    prices.push(roundPrice(base + step * i));
  }

  // Update step + replace alerts
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE settings SET step = ?, updated_at = datetime('now') WHERE id = 1"
    ).bind(step),
    env.DB.prepare("DELETE FROM alerts"),
    ...prices.map((p) =>
      env.DB.prepare(
        "INSERT INTO alerts (price, enabled, triggered, created_at, updated_at) VALUES (?, 1, 0, datetime('now'), datetime('now'))"
      ).bind(p)
    ),
    env.DB.prepare(
      "UPDATE system_status SET config_version = config_version + 1, updated_at = datetime('now') WHERE id = 1"
    ),
  ]);

  const { results } = await env.DB.prepare(
    "SELECT id, price, enabled, triggered, created_at, updated_at FROM alerts ORDER BY price ASC"
  ).all();
  const ver = await env.DB.prepare("SELECT config_version FROM system_status WHERE id = 1").first();

  return json({
    ok: true,
    message: "已生成，默认全部触发",
    base_price: base,
    spot_price: currentPrice,
    step,
    alerts: results || [],
    config_version: ver?.config_version ?? 1,
  });
}

async function eaHeartbeat(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const symbol = String(body.symbol || "XAUUSD").slice(0, 32);
  const bid = Number(body.bid);
  const ask = Number(body.ask);
  const price = Number(body.price ?? ((bid + ask) / 2));

  if (!Number.isFinite(bid) || !Number.isFinite(ask) || !Number.isFinite(price)) {
    return json({ error: "Invalid bid/ask/price" }, 400);
  }

  const now = new Date().toISOString();

  await env.DB.prepare(
    `UPDATE system_status SET
      symbol = ?,
      price = ?,
      bid = ?,
      ask = ?,
      ea_online = 1,
      last_seen = ?,
      updated_at = ?
     WHERE id = 1`
  )
    .bind(symbol, price, bid, ask, now, now)
    .run();

  const status = await env.DB.prepare("SELECT config_version FROM system_status WHERE id = 1").first();

  return json({
    ok: true,
    config_version: status?.config_version ?? 1,
    server_time: now,
  });
}

async function getConfig(env) {
  const status = await env.DB.prepare("SELECT symbol, config_version FROM system_status WHERE id = 1").first();
  const { results } = await env.DB.prepare(
    "SELECT id, price, enabled FROM alerts WHERE enabled = 1 AND triggered = 0 ORDER BY price ASC"
  ).all();

  return json({
    symbol: status?.symbol || "XAUUSD",
    alerts: (results || []).map((a) => ({
      id: a.id,
      price: a.price,
      enabled: !!a.enabled,
    })),
    version: status?.config_version ?? 1,
  });
}

async function alertTrigger(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const alertId = Number(body.alert_id);
  const currentPrice = Number(body.price);
  const triggerPrice = Number(body.trigger_price);
  const direction = String(body.direction || "").toUpperCase();

  if (!Number.isInteger(alertId) || alertId <= 0) {
    return json({ error: "Invalid alert_id" }, 400);
  }
  if (!Number.isFinite(currentPrice) || !Number.isFinite(triggerPrice)) {
    return json({ error: "Invalid price" }, 400);
  }
  if (direction !== "UP" && direction !== "DOWN") {
    return json({ error: "direction must be UP or DOWN" }, 400);
  }

  const alert = await env.DB.prepare("SELECT * FROM alerts WHERE id = ?").bind(alertId).first();
  if (!alert) {
    return json({ error: "Alert not found" }, 404);
  }
  if (!alert.enabled || alert.triggered) {
    return json({ error: "Alert disabled or already triggered", skipped: true }, 200);
  }

  const settings = await env.DB.prepare("SELECT telegram_enabled FROM settings WHERE id = 1").first();
  const nowIso = new Date().toISOString();

  // Mark trigger state before sending Telegram
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE alerts SET
        triggered = 1,
        enabled = 0,
        last_trigger_direction = ?,
        last_trigger_time = ?,
        updated_at = datetime('now')
       WHERE id = ?`
    ).bind(direction, nowIso, alertId),
    env.DB.prepare(
      "UPDATE system_status SET config_version = config_version + 1, updated_at = datetime('now') WHERE id = 1"
    ),
  ]);

  let telegramSent = false;
  let telegramError = null;

  if (settings?.telegram_enabled) {
    try {
      const result = await sendTelegramAlert(env, {
        triggerPrice: alert.price,
        currentPrice,
      });
      telegramSent = result.ok;
      if (!result.ok) telegramError = result.error;
    } catch (e) {
      telegramError = String(e.message || e);
      console.error("Telegram send failed:", e);
    }
  }

  return json({
    ok: true,
    alert_id: alertId,
    direction,
    telegram_sent: telegramSent,
    telegram_error: telegramError,
    time: nowIso,
  });
}

async function getSettings(env) {
  const settings = await env.DB.prepare(
    "SELECT step, telegram_enabled, updated_at FROM settings WHERE id = 1"
  ).first();
  return json({
    step: settings?.step ?? 5,
    telegram_enabled: !!(settings?.telegram_enabled),
    updated_at: settings?.updated_at ?? null,
  });
}

async function saveSettings(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const updates = [];
  const binds = [];

  if (body.step != null) {
    const step = Number(body.step);
    if (!Number.isFinite(step) || step <= 0) {
      return json({ error: "Invalid step" }, 400);
    }
    updates.push("step = ?");
    binds.push(step);
  }

  if (body.telegram_enabled != null) {
    updates.push("telegram_enabled = ?");
    binds.push(body.telegram_enabled ? 1 : 0);
  }

  if (updates.length === 0) {
    return json({ error: "No settings to update" }, 400);
  }

  updates.push("updated_at = datetime('now')");
  await env.DB.prepare(`UPDATE settings SET ${updates.join(", ")} WHERE id = 1`)
    .bind(...binds)
    .run();

  return await getSettings(env);
}

// ---------------------------------------------------------------------------
// Telegram
// ---------------------------------------------------------------------------

async function sendTelegramAlert(env, { triggerPrice, currentPrice }) {
  const botToken = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;

  if (!botToken || !chatId) {
    return { ok: false, error: "TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not configured" };
  }

  const text = `${formatNum(triggerPrice)} _ ${formatNum(currentPrice)}`;

  const apiUrl = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const resp = await fetch(apiUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    }),
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.ok) {
    return {
      ok: false,
      error: data.description || `Telegram HTTP ${resp.status}`,
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isEaOnline(lastSeen) {
  if (!lastSeen) return false;
  const ms = Date.parse(lastSeen);
  if (!Number.isFinite(ms)) return false;
  return Date.now() - ms <= EA_OFFLINE_SECONDS * 1000;
}

function roundPrice(p) {
  // Keep up to 5 decimal places (gold is typically 2–3)
  return Math.round(p * 100000) / 100000;
}

function formatNum(n) {
  if (!Number.isFinite(n)) return String(n);
  // Prefer readable gold prices (2–3 decimals), trim trailing zeros
  let s = n.toFixed(5);
  s = s.replace(/0+$/, "").replace(/\.$/, "");
  if (!s.includes(".")) s += ".00";
  else {
    const dec = s.split(".")[1] || "";
    if (dec.length === 1) s += "0";
  }
  return s;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders(),
    },
  });
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Api-Token",
  };
}
