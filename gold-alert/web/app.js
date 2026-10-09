/**
 * GOLD ALERT - Mobile web client
 * API Token is entered by user and stored in sessionStorage (never hardcoded).
 */

(function () {
  "use strict";

  const MAX_ALERTS = 11;
  const REFRESH_MS = 3000;
  const TOKEN_KEY = "gold_alert_api_token";

  /** @type {Array<{id?: number|null, price: string, enabled: boolean, triggered: boolean}>} */
  let localAlerts = [];
  let refreshTimer = null;
  let toastTimer = null;
  let stepHydrated = false;
  let capturedStep = null;
  let alertsPaused = false;
  let alertsDirty = false;

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

  function renderPauseButton() {
    const btn = $("btn-pause");
    if (!btn) return;
    if (alertsPaused) {
      btn.textContent = "恢复提醒";
      btn.classList.add("resume");
    } else {
      btn.textContent = "暂停提醒";
      btn.classList.remove("resume");
    }
  }

  async function togglePause() {
    try {
      $("btn-pause").disabled = true;
      const data = await api("/api/pause", {
        method: "POST",
        body: JSON.stringify({ paused: !alertsPaused }),
      });
      alertsPaused = !!data.paused;
      renderPauseButton();
      toast(data.message || (alertsPaused ? "提醒已暂停" : "提醒已恢复"), "success");
    } catch (e) {
      toast(e.message, "error");
    } finally {
      $("btn-pause").disabled = false;
    }
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

  function armCount() {
    return localAlerts.filter((a) => a.enabled).length;
  }

  function renderAlerts() {
    const list = $("alerts-list");
    $("alerts-count").textContent = "触发 " + armCount() + " / " + localAlerts.length;

    if (localAlerts.length === 0) {
      list.innerHTML = '<li class="empty-hint">暂无提醒，点「设定」生成后选择要触发的价格</li>';
      return;
    }

    list.innerHTML = "";
    localAlerts.forEach((a, idx) => {
      const on = !!a.enabled;
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
        '<button type="button" class="btn-arm ' +
        (on ? "on" : "off") +
        '" data-idx="' +
        idx +
        '">' +
        (on ? "触发" : "关闭") +
        "</button>" +
        '<button type="button" class="btn-delete" data-idx="' +
        idx +
        '">删除</button>';
      list.appendChild(li);
    });

    list.querySelectorAll(".alert-price-input").forEach((input) => {
      input.addEventListener("change", onPriceEdit);
      input.addEventListener("blur", onPriceEdit);
    });
    list.querySelectorAll(".btn-arm").forEach((btn) => {
      btn.addEventListener("click", onArmClick);
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
    alertsDirty = true;
  }

  function onArmClick(e) {
    const idx = Number(e.currentTarget.getAttribute("data-idx"));
    if (!Number.isInteger(idx) || !localAlerts[idx]) return;
    localAlerts[idx].enabled = !localAlerts[idx].enabled;
    if (localAlerts[idx].enabled) localAlerts[idx].triggered = false;
    alertsDirty = true;
    renderAlerts();
  }

  function onDeleteClick(e) {
    const idx = Number(e.currentTarget.getAttribute("data-idx"));
    if (!Number.isInteger(idx)) return;
    localAlerts.splice(idx, 1);
    alertsDirty = true;
    renderAlerts();
  }

  function mapAlerts(list) {
    return (list || []).map((a) => ({
      id: a.id,
      price: String(a.price),
      enabled: a.enabled === true || a.enabled === 1,
      triggered: a.triggered === true || a.triggered === 1,
    }));
  }

  function alertsFingerprint(list) {
    return (list || [])
      .map(function (a) {
        return [a.id, a.price, a.enabled ? 1 : 0, a.triggered ? 1 : 0].join(":");
      })
      .join("|");
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
    alertsPaused = !!data.paused || data.alerts_enabled === false;
    renderPauseButton();
    // Do not overwrite the interval the user is editing. Status polling used to
    // reset the box back to the last saved server value (often 5).
    if (!stepHydrated && data.step != null) {
      setStepInput(data.step);
      stepHydrated = true;
    }
    $("last-refresh").textContent =
      "刷新 " + new Date().toLocaleTimeString("zh-CN", { hour12: false });
    return data;
  }

  async function loadAlerts(opts) {
    const data = await api("/api/alerts");
    const next = mapAlerts(data.alerts);
    if (opts && opts.skipIfUnchanged && alertsFingerprint(next) === alertsFingerprint(localAlerts)) {
      return;
    }
    localAlerts = next;
    alertsDirty = false;
    renderAlerts();
  }

  function canReloadAlertsFromServer() {
    if (alertsDirty) return false;
    const el = document.activeElement;
    if (el && el.classList && el.classList.contains("alert-price-input")) return false;
    return true;
  }

  async function refreshAll() {
    try {
      await refreshStatus();
      if (canReloadAlertsFromServer()) {
        await loadAlerts({ skipIfUnchanged: true });
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

  function onPageVisible() {
    if (!getToken()) return;
    if ($("app-screen").classList.contains("hidden")) return;
    alertsDirty = false;
    refreshAll().catch(function () {});
  }

  function startRefresh() {
    stopRefresh();
    refreshTimer = setInterval(() => {
      refreshAll().catch(() => {});
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
        enabled: localAlerts[i] ? !!localAlerts[i].enabled : false,
        triggered: localAlerts[i] ? !!localAlerts[i].triggered : false,
      }));
    }
    return localAlerts;
  }

  const STEP_OPTIONS = [1, 2, 3, 4, 5, 10];

  function nearestStep(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return 5;
    if (STEP_OPTIONS.indexOf(n) >= 0) return n;
    let best = 5;
    let bestDiff = Infinity;
    for (let i = 0; i < STEP_OPTIONS.length; i++) {
      const d = Math.abs(STEP_OPTIONS[i] - n);
      if (d < bestDiff) {
        bestDiff = d;
        best = STEP_OPTIONS[i];
      }
    }
    return best;
  }

  function setStepInput(value) {
    $("step-input").value = String(nearestStep(value));
  }

  function readStep() {
    const raw = capturedStep != null ? capturedStep : Number($("step-input").value);
    capturedStep = null;
    return Number(raw);
  }

  function rememberStep() {
    const n = Number($("step-input").value);
    if (Number.isFinite(n) && n > 0) capturedStep = n;
  }

  async function saveAlerts() {
    collectAlertsFromDom();
    const step = readStep();
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
      payload.push({
        price: p,
        enabled: !!a.enabled,
        triggered: a.enabled ? 0 : a.triggered ? 1 : 0,
      });
    }

    if (payload.length > MAX_ALERTS) {
      toast("最多 " + MAX_ALERTS + " 个提醒", "error");
      return;
    }

    const armed = payload.filter((a) => a.enabled).length;
    if (payload.length > 0 && armed === 0) {
      if (!confirm("没有点「触发」的价格，EA 不会提醒。仍要保存吗？")) return;
    }

    try {
      $("btn-save").disabled = true;
      const data = await api("/api/alerts", {
        method: "POST",
        body: JSON.stringify({ alerts: payload, step }),
      });
      localAlerts = mapAlerts(data.alerts);
      alertsDirty = false;
      renderAlerts();
      setStepInput(step);
      toast("设置已保存，已同步到 EA", "success");
      await refreshStatus();
    } catch (e) {
      toast(e.message, "error");
    } finally {
      $("btn-save").disabled = false;
    }
  }

  async function autoGenerate() {
    const step = readStep();
    if (!Number.isFinite(step) || step <= 0) {
      toast("间隔必须是大于 0 的数字", "error");
      return;
    }
    setStepInput(step);

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
      localAlerts = mapAlerts(data.alerts);
      alertsDirty = false;
      renderAlerts();
      setStepInput(data.step != null ? data.step : step);
      toast(data.message || "已生成，默认全部触发", "success");
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

  async function clearAll() {
    if (!confirm("确定清除全部提醒？")) return;
    localAlerts = [];
    renderAlerts();
    try {
      const step = readStep();
      const savedStep = Number.isFinite(step) && step > 0 ? step : 5;
      setStepInput(savedStep);
      await api("/api/alerts", {
        method: "POST",
        body: JSON.stringify({ alerts: [], step: savedStep }),
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
    $("btn-save").addEventListener("pointerdown", rememberStep);
    $("btn-save").addEventListener("click", saveAlerts);
    $("btn-auto").addEventListener("pointerdown", rememberStep);
    $("btn-auto").addEventListener("click", autoGenerate);
    $("btn-clear").addEventListener("click", clearAll);
    $("step-input").addEventListener("change", rememberStep);
    $("btn-pause").addEventListener("click", togglePause);
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible") onPageVisible();
    });
    window.addEventListener("pageshow", onPageVisible);
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
