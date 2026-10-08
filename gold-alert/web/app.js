/**
 * GOLD ALERT - Mobile web client
 * API Token is entered by user and stored in sessionStorage (never hardcoded).
 */

(function () {
  "use strict";

  const MAX_ALERTS = 10;
  const REFRESH_MS = 3000;
  const TOKEN_KEY = "gold_alert_api_token";

  /** @type {Array<{id?: number|null, price: string}>} */
  let localAlerts = [];
  let refreshTimer = null;
  let toastTimer = null;

  const $ = (id) => document.getElementById(id);

  // -------------------------------------------------------------------------
  // Auth
  // -------------------------------------------------------------------------

  function getToken() {
    return sessionStorage.getItem(TOKEN_KEY) || "";
  }

  function setToken(token) {
    sessionStorage.setItem(TOKEN_KEY, token);
  }

  function clearToken() {
    sessionStorage.removeItem(TOKEN_KEY);
  }

  function showAuth() {
    $("auth-screen").classList.remove("hidden");
    $("app-screen").classList.add("hidden");
    stopRefresh();
  }

  function showApp() {
    $("auth-screen").classList.add("hidden");
    $("app-screen").classList.remove("hidden");
    startRefresh();
    refreshAll();
  }

  async function unlock() {
    const token = ($("token-input").value || "").trim();
    const errEl = $("auth-error");
    errEl.classList.add("hidden");

    if (!token) {
      errEl.textContent = "请输入 API Token";
      errEl.classList.remove("hidden");
      return;
    }

    setToken(token);
    try {
      await api("/api/status");
      showApp();
      await loadAlerts();
    } catch (e) {
      clearToken();
      errEl.textContent = e.message === "Unauthorized" ? "Token 无效" : e.message;
      errEl.classList.remove("hidden");
    }
  }

  // -------------------------------------------------------------------------
  // API
  // -------------------------------------------------------------------------

  async function api(path, options = {}) {
    const token = getToken();
    const headers = Object.assign(
      { "Content-Type": "application/json" },
      options.headers || {},
      { Authorization: "Bearer " + token }
    );

    const res = await fetch(path, Object.assign({}, options, { headers }));
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }

    if (res.status === 401) {
      throw new Error("Unauthorized");
    }
    if (!res.ok) {
      const msg = (data && data.error) || "请求失败 (" + res.status + ")";
      const err = new Error(msg);
      err.code = data && data.code;
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  // -------------------------------------------------------------------------
  // UI helpers
  // -------------------------------------------------------------------------

  function toast(msg, type) {
    const el = $("toast");
    el.textContent = msg;
    el.className = "toast " + (type || "");
    el.classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add("hidden"), 2800);
  }

  function formatPrice(n) {
    if (n == null || !Number.isFinite(Number(n))) return "--";
    const v = Number(n);
    // Prefer 2 decimals for gold; keep more if needed
    const s = v.toFixed(Math.abs(v - Math.round(v * 100) / 100) < 1e-9 ? 2 : 3);
    return s;
  }

  function renderEaStatus(online) {
    const el = $("ea-status");
    const text = $("ea-status-text");
    if (online) {
      el.classList.add("online");
      el.classList.remove("offline");
      text.textContent = "🟢 EA 在线";
    } else {
      el.classList.add("offline");
      el.classList.remove("online");
      text.textContent = "🔴 EA 离线";
    }
  }

  function renderAlerts() {
    const list = $("alerts-list");
    $("alerts-count").textContent = localAlerts.length + " / " + MAX_ALERTS;
    $("btn-add").disabled = localAlerts.length >= MAX_ALERTS;

    if (localAlerts.length === 0) {
      list.innerHTML = '<li class="empty-hint">暂无提醒，请添加或自动生成</li>';
      return;
    }

    list.innerHTML = "";
    localAlerts.forEach((a, idx) => {
      const li = document.createElement("li");
      li.className = "alert-item";
      li.innerHTML =
        '<span class="alert-index">' +
        (idx + 1) +
        '.</span>' +
        '<input class="input alert-price-input" type="text" inputmode="decimal" ' +
        'value="' +
        escapeAttr(a.price) +
        '" data-idx="' +
        idx +
        '" />' +
        '<button type="button" class="btn-delete" data-idx="' +
        idx +
        '">删除</button>';
      list.appendChild(li);
    });

    list.querySelectorAll(".alert-price-input").forEach((input) => {
      input.addEventListener("change", onPriceEdit);
      input.addEventListener("blur", onPriceEdit);
    });
    list.querySelectorAll(".btn-delete").forEach((btn) => {
      btn.addEventListener("click", onDeleteClick);
    });
  }

  function escapeAttr(s) {
    return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  }

  function onPriceEdit(e) {
    const idx = Number(e.target.getAttribute("data-idx"));
    if (!Number.isInteger(idx) || !localAlerts[idx]) return;
    localAlerts[idx].price = e.target.value.trim();
  }

  function onDeleteClick(e) {
    const idx = Number(e.currentTarget.getAttribute("data-idx"));
    if (!Number.isInteger(idx)) return;
    localAlerts.splice(idx, 1);
    renderAlerts();
  }

  // -------------------------------------------------------------------------
  // Data refresh
  // -------------------------------------------------------------------------

  async function refreshStatus() {
    const data = await api("/api/status");
    $("symbol").textContent = data.symbol || "XAUUSD";
    $("current-price").textContent = formatPrice(data.price);
    $("bid").textContent = formatPrice(data.bid);
    $("ask").textContent = formatPrice(data.ask);
    renderEaStatus(!!data.ea_online);
    if (data.step != null && document.activeElement !== $("step-input")) {
      $("step-input").value = String(data.step);
    }
    $("last-refresh").textContent =
      "刷新 " + new Date().toLocaleTimeString("zh-CN", { hour12: false });
    return data;
  }

  async function loadAlerts() {
    const data = await api("/api/alerts");
    localAlerts = (data.alerts || []).map((a) => ({
      id: a.id,
      price: String(a.price),
    }));
    renderAlerts();
  }

  async function refreshAll() {
    try {
      await refreshStatus();
      // Only reload alerts from server if user is not mid-edit on an input
      if (!document.activeElement || !document.activeElement.classList.contains("alert-price-input")) {
        // Keep local edits until save — only load on first open / after save
      }
    } catch (e) {
      if (e.message === "Unauthorized") {
        clearToken();
        showAuth();
        return;
      }
      console.warn("refresh failed", e);
    }
  }

  function startRefresh() {
    stopRefresh();
    refreshTimer = setInterval(() => {
      refreshStatus().catch(() => {});
    }, REFRESH_MS);
  }

  function stopRefresh() {
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  function collectAlertsFromDom() {
    const inputs = document.querySelectorAll(".alert-price-input");
    if (inputs.length > 0) {
      localAlerts = Array.from(inputs).map((input, i) => ({
        id: localAlerts[i] ? localAlerts[i].id : null,
        price: input.value.trim(),
      }));
    }
    return localAlerts;
  }

  async function saveAlerts() {
    collectAlertsFromDom();
    const step = Number($("step-input").value);
    if (!Number.isFinite(step) || step <= 0) {
      toast("间隔必须是大于 0 的数字", "error");
      return;
    }

    const payload = [];
    for (const a of localAlerts) {
      const p = Number(a.price);
      if (!Number.isFinite(p) || p <= 0) {
        toast("存在无效价格：" + a.price, "error");
        return;
      }
      payload.push({ price: p, enabled: true });
    }

    if (payload.length > MAX_ALERTS) {
      toast("最多 " + MAX_ALERTS + " 个提醒", "error");
      return;
    }

    try {
      $("btn-save").disabled = true;
      const data = await api("/api/alerts", {
        method: "POST",
        body: JSON.stringify({ alerts: payload, step }),
      });
      localAlerts = (data.alerts || []).map((a) => ({
        id: a.id,
        price: String(a.price),
      }));
      renderAlerts();
      toast("设置已保存", "success");
      await refreshStatus();
    } catch (e) {
      toast(e.message, "error");
    } finally {
      $("btn-save").disabled = false;
    }
  }

  async function autoGenerate() {
    const step = Number($("step-input").value);
    if (!Number.isFinite(step) || step <= 0) {
      toast("间隔必须是大于 0 的数字", "error");
      return;
    }

    try {
      $("btn-auto").disabled = true;
      // Check EA online first for clearer UX
      const status = await api("/api/status");
      if (!status.ea_online) {
        toast("EA当前离线，无法获取最新黄金价格。", "error");
        return;
      }

      const data = await api("/api/alerts/auto", {
        method: "POST",
        body: JSON.stringify({ step }),
      });
      localAlerts = (data.alerts || []).map((a) => ({
        id: a.id,
        price: String(a.price),
      }));
      renderAlerts();
      toast(data.message || "已自动生成", "success");
      await refreshStatus();
    } catch (e) {
      if (e.code === "EA_OFFLINE" || (e.data && e.data.code === "EA_OFFLINE")) {
        toast("EA当前离线，无法获取最新黄金价格。", "error");
      } else {
        toast(e.message, "error");
      }
    } finally {
      $("btn-auto").disabled = false;
    }
  }

  function addAlert() {
    collectAlertsFromDom();
    if (localAlerts.length >= MAX_ALERTS) {
      toast("最多 " + MAX_ALERTS + " 个提醒", "error");
      return;
    }
    localAlerts.push({ id: null, price: "" });
    renderAlerts();
    const inputs = document.querySelectorAll(".alert-price-input");
    const last = inputs[inputs.length - 1];
    if (last) last.focus();
  }

  async function clearAll() {
    if (!confirm("确定清除全部提醒？")) return;
    localAlerts = [];
    renderAlerts();
    try {
      const step = Number($("step-input").value) || 5;
      await api("/api/alerts", {
        method: "POST",
        body: JSON.stringify({ alerts: [], step }),
      });
      toast("已全部清除", "success");
    } catch (e) {
      toast(e.message, "error");
    }
  }

  // -------------------------------------------------------------------------
  // Init
  // -------------------------------------------------------------------------

  function bindEvents() {
    $("btn-unlock").addEventListener("click", unlock);
    $("token-input").addEventListener("keydown", (e) => {
      if (e.key === "Enter") unlock();
    });
    $("btn-logout").addEventListener("click", () => {
      clearToken();
      showAuth();
    });
    $("btn-save").addEventListener("click", saveAlerts);
    $("btn-auto").addEventListener("click", autoGenerate);
    $("btn-add").addEventListener("click", addAlert);
    $("btn-clear").addEventListener("click", clearAll);
  }

  async function init() {
    bindEvents();
    const token = getToken();
    if (!token) {
      showAuth();
      return;
    }
    try {
      await api("/api/status");
      showApp();
      await loadAlerts();
    } catch {
      clearToken();
      showAuth();
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
