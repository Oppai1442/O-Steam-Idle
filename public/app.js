"use strict";
(() => {
  // client/app.ts
  var $ = (s) => document.querySelector(s);
  var els = {
    connection: $("#connection"),
    runtimeMode: $("#runtimeMode"),
    accountTitle: $("#accountTitle"),
    authText: $("#authText"),
    stateText: $("#stateText"),
    sessionText: $("#sessionText"),
    reconnectCount: $("#reconnectCount"),
    qrBtn: $("#qrBtn"),
    savedBtn: $("#savedBtn"),
    logoutBtn: $("#logoutBtn"),
    qrWrap: $("#qrWrap"),
    qr: $("#qr"),
    qrHint: $("#qrHint"),
    search: $("#search"),
    filter: $("#filter"),
    sort: $("#sort"),
    refreshBtn: $("#refreshBtn"),
    refreshCardsBtn: $("#refreshCardsBtn"),
    libraryCount: $("#libraryCount"),
    visibleCount: $("#visibleCount"),
    selectedCount: $("#selectedCount"),
    idlingCount: $("#idlingCount"),
    cardGamesCount: $("#cardGamesCount"),
    cardDropsCount: $("#cardDropsCount"),
    selectVisibleBtn: $("#selectVisibleBtn"),
    selectDropsBtn: $("#selectDropsBtn"),
    clearBtn: $("#clearBtn"),
    manualBtn: $("#manualBtn"),
    copyBtn: $("#copyBtn"),
    stopBtn: $("#stopBtn"),
    startBtn: $("#startBtn"),
    exitBtn: $("#exitBtn"),
    notice: $("#notice"),
    games: $("#games"),
    emptyState: $("#emptyState")
  };
  var status = {};
  var library = [];
  var selected = /* @__PURE__ */ new Set();
  var initializedSelection = false;
  var lastLibraryCount = -1;
  var lastCardScanReady = false;
  var shuttingDown = false;
  async function api(url, options = {}) {
    const r = await fetch(url, {
      ...options,
      headers: { "Content-Type": "application/json", ...options.headers || {} }
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error || `${r.status} ${r.statusText}`);
    return body;
  }
  function fmtHours(mins) {
    const h = Number(mins || 0) / 60;
    if (h >= 1e3) return `${Math.round(h).toLocaleString()} h`;
    return `${h.toFixed(h < 10 ? 1 : 0)} h`;
  }
  function fmtDate(ts) {
    if (!ts) return "never";
    return new Date(ts * 1e3).toLocaleDateString();
  }
  function visibleApps() {
    const q = els.search.value.trim().toLowerCase();
    const filter = els.filter.value;
    let x = library.filter((g) => {
      const matches = !q || g.name.toLowerCase().includes(q) || String(g.appid).includes(q);
      if (!matches) return false;
      if (filter === "selected") return selected.has(g.appid);
      if (filter === "played") return g.playtime > 0;
      if (filter === "never") return g.playtime <= 0;
      if (filter === "manual") return g.discoveredViaManual === true;
      if (filter === "cards") return g.hasCards === true;
      if (filter === "drops") return Number(g.cardDrops || 0) > 0;
      if (filter === "nodrops") return g.hasCards === true && Number(g.cardDrops || 0) === 0;
      if (filter === "cardunknown") return g.hasCards == null;
      return true;
    });
    const sort = els.sort.value;
    x.sort((a, b) => {
      if (sort === "playtime") return b.playtime - a.playtime || a.name.localeCompare(b.name);
      if (sort === "recent") return b.lastPlayed - a.lastPlayed || a.name.localeCompare(b.name);
      if (sort === "appid") return a.appid - b.appid;
      if (sort === "drops") return Number(b.cardDrops ?? -1) - Number(a.cardDrops ?? -1) || a.name.localeCompare(b.name);
      return a.name.localeCompare(b.name);
    });
    return x;
  }
  function sourceTags(g) {
    const tags = [];
    if (g.discoveredViaManual) tags.push("manual");
    if (g.discoveredViaProfile) tags.push("profile");
    if (g.discoveredViaLocalSteam) tags.push("local");
    return tags;
  }
  function renderGames() {
    const apps = visibleApps();
    const idling = new Set(status.idling || []);
    els.visibleCount.textContent = apps.length;
    els.libraryCount.textContent = library.length;
    els.selectedCount.textContent = selected.size;
    els.idlingCount.textContent = idling.size;
    els.cardGamesCount.textContent = status.cardGames || 0;
    els.cardDropsCount.textContent = status.cardDropsRemaining || 0;
    els.emptyState.classList.toggle("hidden", apps.length > 0);
    const frag = document.createDocumentFragment();
    for (const g of apps) {
      const label = document.createElement("label");
      const isSelected = selected.has(g.appid);
      const isIdling = idling.has(g.appid);
      label.className = `game${isSelected ? " active" : ""}${isIdling ? " idling" : ""}`;
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = isSelected;
      cb.setAttribute("aria-label", `Select ${g.name}`);
      cb.addEventListener("change", () => {
        cb.checked ? selected.add(g.appid) : selected.delete(g.appid);
        persistSelection();
        renderGames();
      });
      let icon;
      if (g.icon) {
        icon = document.createElement("img");
        icon.className = "icon";
        icon.src = g.icon;
        icon.alt = "";
        icon.loading = "lazy";
        icon.decoding = "async";
      } else {
        icon = document.createElement("div");
        icon.className = "icon fallback";
        icon.textContent = "APP";
      }
      const info = document.createElement("div");
      info.className = "game-info";
      const name = document.createElement("div");
      name.className = "name";
      name.textContent = g.name;
      const meta = document.createElement("div");
      meta.className = "meta";
      const appid = document.createElement("span");
      appid.textContent = `#${g.appid}`;
      meta.append(appid);
      for (const tag of sourceTags(g)) {
        const chip = document.createElement("span");
        chip.className = "meta-chip";
        chip.textContent = tag;
        meta.append(chip);
      }
      if (g.lastPlayed) {
        const last = document.createElement("span");
        last.textContent = `last ${fmtDate(g.lastPlayed)}`;
        meta.append(last);
      }
      info.append(name, meta);
      const play = document.createElement("div");
      play.className = "cell-play";
      play.textContent = fmtHours(g.playtime);
      const cardCell = document.createElement("div");
      cardCell.className = "card-cell";
      const cards = document.createElement("div");
      cards.className = "cards";
      if (g.hasCards === true) {
        const drops = Number(g.cardDrops || 0);
        cards.textContent = drops > 0 ? `${drops} drop${drops === 1 ? "" : "s"} remaining` : "No drops remaining";
        cards.classList.add(drops > 0 ? "drops" : "done");
      } else {
        cards.textContent = status.cardScanReady ? "Unknown / no badge row" : "Not scanned";
      }
      cardCell.append(cards);
      const stateTag = document.createElement("div");
      stateTag.className = `state-tag${isIdling ? " idling" : isSelected ? " selected" : ""}`;
      stateTag.textContent = isIdling ? "LIVE" : isSelected ? "ARMED" : "STANDBY";
      label.append(cb, icon, info, play, cardCell, stateTag);
      frag.append(label);
    }
    els.games.replaceChildren(frag);
  }
  var selectionTimer;
  function persistSelection() {
    clearTimeout(selectionTimer);
    selectionTimer = setTimeout(() => {
      api("/api/selection", { method: "POST", body: JSON.stringify({ appids: [...selected] }) }).catch(showError);
    }, 180);
  }
  function setNotice(text) {
    const span = els.notice.querySelector("span:last-child");
    if (span) span.textContent = text;
    else els.notice.textContent = text;
  }
  function showError(err) {
    setNotice(err.message || String(err));
  }
  async function loadLibrary() {
    const data = await api("/api/library");
    library = data.apps || [];
    if (!initializedSelection && Array.isArray(status.selected)) {
      selected = new Set(status.selected);
      initializedSelection = true;
    }
    renderGames();
  }
  function renderStatus() {
    const cloud = status.runtimeMode === "cloud";
    const yielding = !!status.externalPlaying;
    const conflict = !!status.sessionConflict;
    const connected = !!status.connected;
    const reconnecting = !!status.reconnecting;
    const connecting = !!status.connecting;
    let connectionLabel = "Offline";
    if (yielding) connectionLabel = status.externalPlayingApp ? `Yielding \xB7 ${status.externalPlayingApp}` : "Yielding";
    else if (conflict) connectionLabel = "Session conflict";
    else if (connected) connectionLabel = "Connected";
    else if (reconnecting) connectionLabel = "Reconnecting";
    else if (connecting) connectionLabel = "Connecting";
    els.connection.querySelector("span").textContent = connectionLabel;
    els.connection.classList.toggle("online", connected && !yielding);
    els.connection.classList.toggle("warn", yielding || conflict || reconnecting || connecting);
    els.runtimeMode.textContent = cloud ? "CLOUDFLARE" : "LOCAL";
    els.accountTitle.textContent = connected ? status.accountName ? status.accountName : "Steam session online" : connecting || reconnecting ? "Linking Steam session\u2026" : "No active session";
    els.stateText.textContent = connected ? "ONLINE" : reconnecting ? "RECOVER" : connecting ? "LINKING" : "READY";
    els.sessionText.textContent = (status.idling || []).length ? `${status.idling.length} ACTIVE` : status.idleWanted ? "PENDING" : yielding ? "YIELD" : "IDLE";
    els.reconnectCount.textContent = status.reconnectCount || 0;
    setNotice(status.libraryError || status.cardScanError || status.message || "Ready");
    els.authText.textContent = cloud ? "Cloud mode uses the configured Steam refresh-token secret. QR login works for this container session, but update the secret for durable restarts." : "Authenticate once with Steam Mobile QR. The refresh token is protected with Windows DPAPI on this PC.";
    els.logoutBtn.textContent = cloud ? "Disconnect session" : "Logout & forget token";
    els.exitBtn.classList.toggle("hidden", cloud);
    els.savedBtn.classList.toggle("hidden", !status.hasSavedLogin || connected || connecting || reconnecting);
    els.logoutBtn.classList.toggle("hidden", !connected && !status.hasSavedLogin);
    els.qrBtn.disabled = connected || connecting || reconnecting;
    els.refreshBtn.disabled = !connected || !!status.cardScanRunning;
    els.refreshCardsBtn.disabled = !connected || !!status.cardScanRunning || !status.libraryReady;
    els.refreshCardsBtn.textContent = status.cardScanRunning ? "Scanning\u2026" : "Cards only";
    els.startBtn.disabled = !connected || yielding || selected.size === 0;
    els.stopBtn.disabled = !(status.idleWanted || (status.idling || []).length);
    if (status.qrDataUrl) {
      els.qr.src = status.qrDataUrl;
      els.qrWrap.classList.remove("hidden");
      els.qrHint.textContent = status.qrStatus === "scanned" ? "Scanned \xB7 approve in Steam Mobile" : "Scan with Steam Mobile";
    } else {
      els.qrWrap.classList.add("hidden");
    }
    renderGames();
  }
  async function poll() {
    if (shuttingDown) return;
    try {
      status = await api("/api/status");
      renderStatus();
      const cardsJustFinished = !!status.cardScanReady && !lastCardScanReady;
      if (status.libraryReady && (status.libraryCount !== lastLibraryCount || cardsJustFinished)) {
        lastLibraryCount = status.libraryCount;
        await loadLibrary();
      }
      lastCardScanReady = !!status.cardScanReady;
    } catch (err) {
      showError(err);
    }
  }
  els.qrBtn.addEventListener("click", async () => {
    try {
      await api("/api/login/qr", { method: "POST" });
      await poll();
    } catch (e) {
      showError(e);
    }
  });
  els.savedBtn.addEventListener("click", async () => {
    try {
      await api("/api/login/saved", { method: "POST" });
      await poll();
    } catch (e) {
      showError(e);
    }
  });
  els.logoutBtn.addEventListener("click", async () => {
    try {
      await api("/api/logout", { method: "POST" });
      selected.clear();
      initializedSelection = false;
      library = [];
      await poll();
    } catch (e) {
      showError(e);
    }
  });
  els.refreshBtn.addEventListener("click", async () => {
    try {
      await api("/api/library/refresh", { method: "POST" });
      lastLibraryCount = -1;
      await loadLibrary();
      await poll();
    } catch (e) {
      showError(e);
    }
  });
  els.refreshCardsBtn.addEventListener("click", async () => {
    try {
      await api("/api/cards/refresh", { method: "POST" });
      await loadLibrary();
      await poll();
    } catch (e) {
      showError(e);
    }
  });
  els.startBtn.addEventListener("click", async () => {
    try {
      await api("/api/idle/start", { method: "POST", body: JSON.stringify({ appids: [...selected] }) });
      await poll();
    } catch (e) {
      showError(e);
    }
  });
  els.stopBtn.addEventListener("click", async () => {
    try {
      await api("/api/idle/stop", { method: "POST" });
      await poll();
    } catch (e) {
      showError(e);
    }
  });
  els.exitBtn.addEventListener("click", async () => {
    if (!confirm("Stop idle, log out this idler session, and exit the local server?")) return;
    try {
      shuttingDown = true;
      els.exitBtn.disabled = true;
      els.startBtn.disabled = true;
      els.stopBtn.disabled = true;
      setNotice("Shutting down server\u2026");
      await api("/api/shutdown", { method: "POST" });
    } catch (_) {
    }
    els.connection.querySelector("span").textContent = "Stopped";
    els.connection.classList.remove("online", "warn");
    setNotice("Server stopped. You can close this tab.");
  });
  els.selectVisibleBtn.addEventListener("click", () => {
    visibleApps().forEach((g) => selected.add(g.appid));
    persistSelection();
    renderGames();
  });
  els.selectDropsBtn.addEventListener("click", () => {
    selected.clear();
    library.filter((g) => Number(g.cardDrops || 0) > 0).forEach((g) => selected.add(g.appid));
    persistSelection();
    renderGames();
  });
  els.clearBtn.addEventListener("click", () => {
    selected.clear();
    persistSelection();
    renderGames();
  });
  els.manualBtn.addEventListener("click", async () => {
    const raw = prompt("Add Steam AppID(s). Separate multiple IDs with commas or spaces.\nExample: 346110 2399830");
    if (!raw) return;
    const appids = [...new Set((raw.match(/\d+/g) || []).map(Number).filter((x) => Number.isInteger(x) && x > 0))];
    if (!appids.length) return showError(new Error("No valid AppIDs found"));
    try {
      const out = await api("/api/library/manual", { method: "POST", body: JSON.stringify({ appids }) });
      lastLibraryCount = -1;
      await loadLibrary();
      setNotice(`Added ${out.added || 0} manual AppID${out.added === 1 ? "" : "s"}.`);
    } catch (e) {
      showError(e);
    }
  });
  els.copyBtn.addEventListener("click", async () => {
    const text = [...selected].sort((a, b) => a - b).join(",");
    if (!text) return showError(new Error("Nothing selected"));
    try {
      await navigator.clipboard.writeText(text);
      setNotice(`Copied ${selected.size} AppID${selected.size === 1 ? "" : "s"} to clipboard.`);
    } catch (_) {
      prompt("Copy selected AppIDs:", text);
    }
  });
  for (const el of [els.search, els.filter, els.sort]) el.addEventListener(el === els.search ? "input" : "change", renderGames);
  poll();
  setInterval(poll, 1200);
})();
