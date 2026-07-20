"use strict";

(() => {
  const STORAGE_KEY = "monitor-triagem:last-state";
  const DISPLAY_DURATION_MS = 2000;
  const numberFormatter = new Intl.NumberFormat("pt-BR");
  const rateFormatter = new Intl.NumberFormat("pt-BR", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1
  });

  const elements = Object.freeze({
    dashboard: document.getElementById("dashboard"),
    routePanel: document.querySelector(".route-panel"),
    processingPanel: document.querySelector(".processing-panel"),
    routeChart: document.getElementById("routeProcessingChart"),
    rota: document.getElementById("rota"),
    cep: document.getElementById("cep"),
    cidade: document.getElementById("cidade"),
    uf: document.getElementById("uf"),
    statusLeitura: document.getElementById("statusLeitura"),
    mensagemLeitura: document.getElementById("mensagemLeitura"),
    statusLeituraCard: document.getElementById("statusLeituraCard"),
    mensagemLeituraCard: document.getElementById("mensagemLeituraCard"),
    ultimaLeitura: document.getElementById("ultimaLeitura"),
    horaUltimaLeitura: document.getElementById("horaUltimaLeitura"),
    topbarDate: document.getElementById("topbarDate"),
    topbarTime: document.getElementById("topbarTime"),
    topbarTotalHoje: document.getElementById("topbarTotalHoje"),
    topbarRotasAtivas: document.getElementById("topbarRotasAtivas"),
    topbarProducaoMinuto: document.getElementById("topbarProducaoMinuto"),
    rotasAtivasPanel: document.getElementById("rotasAtivasPanel"),
    totalHojeCard: document.getElementById("totalHojeCard"),
    rotasAtivasCard: document.getElementById("rotasAtivasCard"),
    rotaMaisMovimentada: document.getElementById("rotaMaisMovimentada"),
    cidadeMaisProcessada: document.getElementById("cidadeMaisProcessada"),
    ufMaisProcessada: document.getElementById("ufMaisProcessada"),
    ultimaCartaLidaCard: document.getElementById("ultimaCartaLidaCard"),
    ultimaRotaEnviadaCard: document.getElementById("ultimaRotaEnviadaCard"),
    producaoMediaMinutoCard: document.getElementById("producaoMediaMinutoCard"),
    producaoHoraCard: document.getElementById("producaoHoraCard"),
    tempoOnlineCard: document.getElementById("tempoOnlineCard"),
    connection: document.getElementById("connection"),
    connectionText: document.getElementById("connectionText"),
    statusText: document.getElementById("statusText"),
    statusDetail: document.getElementById("statusDetail")
  });

  const beep = new Audio("/beep.mp3");
  beep.preload = "auto";

  const state = {
    snapshot: null,
    summary: null,
    routeChartSignature: ""
  };

  const viewState = Object.create(null);
  let socket = null;
  let statusTimer = null;
  let connectedSince = null;
  let accumulatedOnlineMs = 0;

  function normalizeText(value, fallback, maxLength) {
    const result = String(value ?? "").trim().slice(0, maxLength);
    return result || fallback;
  }

  function normalizeNumber(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function formatDateTime(value) {
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime())
      ? "--:--:--"
      : date.toLocaleTimeString("pt-BR", { hour12: false });
  }

  function formatDate(value = new Date()) {
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime())
      ? "--/--/----"
      : date.toLocaleDateString("pt-BR", {
          day: "2-digit",
          month: "2-digit",
          year: "numeric"
        });
  }

  function formatDuration(milliseconds) {
    const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    return [hours, minutes, seconds].map((part) => String(part).padStart(2, "0")).join(":");
  }

  function formatCompactNumber(value) {
    return numberFormatter.format(Math.max(0, Math.trunc(value)));
  }

  function formatRate(value) {
    return rateFormatter.format(Math.max(0, value));
  }

  function setText(key, element, value, card, options = {}) {
    if (!element) {
      return false;
    }

    const nextValue = String(value);
    const shouldFlash = options.flash !== false;

    if (viewState[key] === nextValue) {
      return false;
    }

    viewState[key] = nextValue;

    if (element.textContent !== nextValue) {
      element.textContent = nextValue;
      if (card && shouldFlash) {
        flashCard(card);
      }
      return true;
    }

    return false;
  }

  function flashCard(card) {
    if (!card) {
      return;
    }

    card.classList.remove("is-updated");
    void card.offsetWidth;
    card.classList.add("is-updated");
    window.setTimeout(() => card.classList.remove("is-updated"), 540);
  }

  function persistState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (_error) {
      // O monitor continua funcionando mesmo sem armazenamento local.
    }
  }

  function restoreState() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (!saved) {
        return null;
      }

      const parsed = JSON.parse(saved);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch (_error) {
      return null;
    }
  }

  function updateClock() {
    const now = new Date();
    setText("topbarDate", elements.topbarDate, formatDate(now));
    setText("topbarTime", elements.topbarTime, formatDateTime(now));
  }

  function getOnlineElapsedMs() {
    if (connectedSince !== null) {
      return accumulatedOnlineMs + (Date.now() - connectedSince);
    }

    return accumulatedOnlineMs;
  }

  function updateTempoOnline() {
    const elapsed = getOnlineElapsedMs();
    const display = elapsed > 0 ? formatDuration(elapsed) : "--:--:--";
    setText("tempoOnlineCard", elements.tempoOnlineCard, display, elements.tempoOnlineCard.closest(".stat-card"), { flash: false });
  }

  function updateConnection(stateValue, detail) {
    elements.connection.classList.remove("is-offline");

    if (stateValue === "offline") {
      elements.connection.classList.add("is-offline");
      setText("connectionText", elements.connectionText, "DESCONECTADO");
      setText("statusDetail", elements.statusDetail, detail || "RECONEXÃO AUTOMÁTICA");
      return;
    }

    if (stateValue === "connecting") {
      setText("connectionText", elements.connectionText, "CONECTANDO");
      setText("statusDetail", elements.statusDetail, detail || "CONEXÃO EM PROGRESSO");
      return;
    }

    setText("connectionText", elements.connectionText, "ONLINE");
    setText("statusDetail", elements.statusDetail, detail || "CONEXÃO ESTÁVEL");
  }

  function updateFooterStatus(message, detail) {
    setText("statusText", elements.statusText, message);
    setText("statusDetail", elements.statusDetail, detail);
  }

  function playBeep() {
    beep.pause();
    beep.currentTime = 0;

    const promise = beep.play();
    if (promise) {
      promise.catch(() => {
        // Alguns navegadores exigem interação do operador para permitir áudio.
      });
    }
  }

  function restartAnimation() {
    elements.dashboard.classList.remove("update-animation");
    void elements.dashboard.offsetWidth;
    elements.dashboard.classList.add("update-animation");
  }

  function normalizeSnapshot(data) {
    const snapshot = {
      rota: normalizeText(data?.rota, "--", 20),
      cidade: normalizeText(data?.cidade, "AGUARDANDO LEITURA", 80),
      uf: normalizeText(data?.uf, "--", 10).toUpperCase(),
      cep: normalizeText(data?.cep, "----- ---", 20),
      hora: normalizeText(data?.hora, new Date().toISOString(), 80),
      totalHoje: Math.max(0, Math.trunc(normalizeNumber(data?.totalHoje, 0)))
    };

    return snapshot;
  }

  function normalizeSummary(data) {
    const routeEntriesSource = data?.routeEntries ?? data?.routes ?? data?.rotas ?? [];
    const routeEntries = Array.isArray(routeEntriesSource)
      ? routeEntriesSource
          .map((entry) => ({
            label: normalizeText(entry?.label ?? entry?.rota ?? entry?.route ?? entry?.name ?? entry?.key, "", 80),
            count: Math.max(0, Math.trunc(normalizeNumber(entry?.count ?? entry?.total ?? entry?.value ?? entry?.quantidade, 0)))
          }))
          .filter((entry) => entry.label)
      : [];

    return {
      totalHoje: Math.max(0, Math.trunc(normalizeNumber(data?.totalHoje ?? state.snapshot?.totalHoje, 0))),
      rotasAtivas: Math.max(0, Math.trunc(normalizeNumber(data?.rotasAtivas, routeEntries.length))),
      rotaMaisMovimentada: normalizeText(
        data?.rotaMaisMovimentada ?? routeEntries[0]?.label,
        "--",
        80
      ),
      cidadeMaisProcessada: normalizeText(data?.cidadeMaisProcessada, "--", 80),
      ufMaisProcessada: normalizeText(data?.ufMaisProcessada, "--", 10).toUpperCase(),
      ultimaCartaLida: normalizeText(
        data?.ultimaCartaLida ?? buildLastCartaLabel(state.snapshot),
        "--",
        120
      ),
      ultimaRotaEnviada: normalizeText(data?.ultimaRotaEnviada ?? state.snapshot?.rota, "--", 80),
      producaoMediaMinuto: normalizeNumber(data?.producaoMediaMinuto, 0),
      producaoHora: normalizeNumber(data?.producaoHora, 0),
      routeEntries
    };
  }

  function buildLastCartaLabel(snapshot) {
    if (!snapshot) {
      return "--";
    }

    return `${snapshot.rota} • ${snapshot.cidade}/${snapshot.uf}`;
  }

  function renderRouteChart(entries) {
    const signature = entries.map((entry) => `${entry.label}:${entry.count}`).join("|");

    if (signature === state.routeChartSignature) {
      return;
    }

    state.routeChartSignature = signature;
    elements.routeChart.replaceChildren();

    if (!entries.length) {
      const emptyState = document.createElement("article");
      emptyState.className = "route-row route-row--empty";
      emptyState.innerHTML = `
        <div class="route-row-head">
          <span class="route-row-name">AGUARDANDO DADOS DE ROTAS</span>
          <span class="route-row-count">SEM MOVIMENTO</span>
        </div>
        <div class="route-row-bar"><span style="width: 0%"></span></div>
      `;
      elements.routeChart.appendChild(emptyState);
      return;
    }

    const maxCount = Math.max(...entries.map((entry) => entry.count), 1);
    const fragment = document.createDocumentFragment();

    for (const entry of entries) {
      const row = document.createElement("article");
      row.className = "route-row";

      const percentage = Math.max(0, Math.min(100, (entry.count / maxCount) * 100));
      row.innerHTML = `
        <div class="route-row-head">
          <span class="route-row-name">${entry.label}</span>
          <span class="route-row-count">${formatCompactNumber(entry.count)} cartas</span>
        </div>
        <div class="route-row-bar"><span style="width: ${percentage}%"></span></div>
      `;

      fragment.appendChild(row);
    }

    elements.routeChart.appendChild(fragment);
  }

  function refreshOperationalWidgets() {
    const snapshot = state.snapshot;
    const summary = state.summary;
    const totalHoje = snapshot?.totalHoje ?? summary?.totalHoje ?? 0;
    const routeEntries = summary?.routeEntries ?? [];
    const rotasAtivas = summary?.rotasAtivas ?? routeEntries.length;
    const routeMost = summary?.rotaMaisMovimentada ?? "--";
    const cityMost = summary?.cidadeMaisProcessada ?? "--";
    const ufMost = summary?.ufMaisProcessada ?? "--";
    const lastCarta = summary?.ultimaCartaLida ?? buildLastCartaLabel(snapshot);
    const lastRoute = summary?.ultimaRotaEnviada ?? snapshot?.rota ?? "--";
    const onlineElapsedMs = getOnlineElapsedMs();
    const productionPerMinute = onlineElapsedMs > 0
      ? totalHoje / Math.max(onlineElapsedMs / 60000, 1 / 60)
      : 0;
    const productionPerHour = productionPerMinute * 60;
    const timeOnline = onlineElapsedMs > 0 ? formatDuration(onlineElapsedMs) : "--:--:--";

    setText("topbarTotalHoje", elements.topbarTotalHoje, formatCompactNumber(totalHoje), elements.topbarTotalHoje.closest(".topbar-chip"));
    setText("topbarRotasAtivas", elements.topbarRotasAtivas, formatCompactNumber(rotasAtivas), elements.topbarRotasAtivas.closest(".topbar-chip"));
    setText("topbarProducaoMinuto", elements.topbarProducaoMinuto, formatRate(productionPerMinute), elements.topbarProducaoMinuto.closest(".topbar-chip"), { flash: false });

    setText("totalHojeCard", elements.totalHojeCard, formatCompactNumber(totalHoje), elements.totalHojeCard.closest(".stat-card"));
    setText("rotasAtivasCard", elements.rotasAtivasCard, formatCompactNumber(rotasAtivas), elements.rotasAtivasCard.closest(".stat-card"));
    setText("rotaMaisMovimentada", elements.rotaMaisMovimentada, routeMost, elements.rotaMaisMovimentada.closest(".stat-card"));
    setText("cidadeMaisProcessada", elements.cidadeMaisProcessada, cityMost, elements.cidadeMaisProcessada.closest(".stat-card"));
    setText("ufMaisProcessada", elements.ufMaisProcessada, ufMost, elements.ufMaisProcessada.closest(".stat-card"));
    setText("ultimaCartaLidaCard", elements.ultimaCartaLidaCard, lastCarta, elements.ultimaCartaLidaCard.closest(".stat-card"));
    setText("ultimaRotaEnviadaCard", elements.ultimaRotaEnviadaCard, lastRoute, elements.ultimaRotaEnviadaCard.closest(".stat-card"));
    setText("producaoMediaMinutoCard", elements.producaoMediaMinutoCard, formatRate(productionPerMinute), elements.producaoMediaMinutoCard.closest(".stat-card"), { flash: false });
    setText("producaoHoraCard", elements.producaoHoraCard, formatRate(productionPerHour), elements.producaoHoraCard.closest(".stat-card"), { flash: false });
    setText("tempoOnlineCard", elements.tempoOnlineCard, timeOnline, elements.tempoOnlineCard.closest(".stat-card"), { flash: false });
    setText("rotasAtivasPanel", elements.rotasAtivasPanel, formatCompactNumber(rotasAtivas), elements.rotasAtivasPanel.closest(".processing-pill"));

    renderRouteChart(routeEntries);
    updateTempoOnline();
  }

  function syncReadingIdleState() {
    setText("statusLeitura", elements.statusLeitura, "AGUARDANDO LEITURA", elements.statusLeitura.closest(".status-pill"));
    setText("mensagemLeitura", elements.mensagemLeitura, "AGUARDANDO LEITURA", elements.mensagemLeitura.closest(".route-hero"));
    setText("statusLeituraCard", elements.statusLeituraCard, "AGUARDANDO LEITURA", elements.statusLeituraCard.closest(".reading-card"));
    setText("mensagemLeituraCard", elements.mensagemLeituraCard, "AGUARDANDO LEITURA", elements.mensagemLeituraCard.closest(".reading-card"));
  }

  function applySnapshot(data, { restored = false } = {}) {
    const snapshot = normalizeSnapshot(data);
    state.snapshot = snapshot;
    const pending = snapshot.rota.toUpperCase() === "PENDENTE";
    const lastReading = buildLastCartaLabel(snapshot);

    document.body.classList.toggle("pending", pending);

    setText("rota", elements.rota, snapshot.rota, elements.routePanel);
    setText("cep", elements.cep, snapshot.cep, elements.routePanel);
    setText("cidade", elements.cidade, snapshot.cidade, elements.routePanel);
    setText("uf", elements.uf, snapshot.uf, elements.routePanel);
    setText("ultimaLeitura", elements.ultimaLeitura, lastReading, elements.routePanel);
    setText("horaUltimaLeitura", elements.horaUltimaLeitura, formatDateTime(snapshot.hora), elements.routePanel);
    setText("topbarTotalHoje", elements.topbarTotalHoje, formatCompactNumber(snapshot.totalHoje), elements.topbarTotalHoje.closest(".topbar-chip"));

    if (restored) {
      syncReadingIdleState();
      updateFooterStatus("AGUARDANDO PRÓXIMA CARTA", "ÚLTIMA LEITURA RECUPERADA");
      refreshOperationalWidgets();
      persistState();
      return;
    }

    const readingStatus = pending ? "PENDENTE" : "LEITURA CONFIRMADA";
    const readingMessage = pending
      ? "ROTA PENDENTE - VERIFICAR TRIAGEM"
      : `ROTA ${snapshot.rota} RECEBIDA`;

    setText("statusLeitura", elements.statusLeitura, readingStatus, elements.statusLeitura.closest(".status-pill"));
    setText("mensagemLeitura", elements.mensagemLeitura, readingMessage, elements.routePanel);
    setText("statusLeituraCard", elements.statusLeituraCard, readingStatus, elements.statusLeituraCard.closest(".reading-card"));
    setText("mensagemLeituraCard", elements.mensagemLeituraCard, readingMessage, elements.mensagemLeituraCard.closest(".reading-card"));

    restartAnimation();
    playBeep();
    updateFooterStatus(
      pending ? "ROTA PENDENTE - VERIFICAR TRIAGEM" : `ROTA ${snapshot.rota} RECEBIDA`,
      pending ? "ATENÇÃO NECESSÁRIA" : "DADOS ATUALIZADOS"
    );

    clearTimeout(statusTimer);
    statusTimer = window.setTimeout(() => {
      syncReadingIdleState();
      updateFooterStatus("AGUARDANDO PRÓXIMA CARTA", pending ? "PENDÊNCIA EM EXIBIÇÃO" : "SISTEMA PRONTO");
    }, DISPLAY_DURATION_MS);

    refreshOperationalWidgets();
    persistState();
  }

  function applyDashboardStats(data, { restored = false } = {}) {
    state.summary = normalizeSummary(data || {});
    refreshOperationalWidgets();

    if (!restored) {
      persistState();
    }
  }

  function onConnect() {
    connectedSince = Date.now();
    accumulatedOnlineMs = 0;
    updateConnection("online");
    updateTempoOnline();
  }

  function onDisconnect() {
    if (connectedSince !== null) {
      accumulatedOnlineMs += Date.now() - connectedSince;
      connectedSince = null;
    }

    updateConnection("offline");
    updateTempoOnline();
  }

  function onConnectError(error) {
    onDisconnect();
    updateConnection("offline", error?.message ? "RECONEXÃO AUTOMÁTICA" : "TENTANDO RECONEXÃO");
  }

  function bindSocket() {
    socket = io({
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 10000,
      randomizationFactor: 0.25,
      timeout: 10000
    });

    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    socket.on("connect_error", onConnectError);
    socket.on("reconnect_attempt", () => updateConnection("connecting", "TENTANDO RECONEXÃO"));
    socket.on("reconnect", onConnect);
    socket.on("reconnect_error", () => updateConnection("offline", "FALHA NA RECONEXÃO"));
    socket.on("reconnect_failed", () => updateConnection("offline", "RECONEXÃO INDISPONÍVEL"));
    socket.on("estadoAtual", (payload) => applySnapshot(payload, { restored: true }));
    socket.on("novaCarta", (payload) => applySnapshot(payload));
    socket.on("dashboardStats", (payload) => applyDashboardStats(payload));
    socket.on("connect_timeout", () => updateConnection("offline", "TEMPO ESGOTADO"));
  }

  updateClock();
  updateTempoOnline();
  syncReadingIdleState();
  updateConnection("connecting", "CONEXÃO EM PROGRESSO");

  const savedState = restoreState();
  if (savedState) {
    if (savedState.summary) {
      state.summary = normalizeSummary(savedState.summary);
    }

    if (savedState.snapshot) {
      applySnapshot(savedState.snapshot, { restored: true });
    }

    if (savedState.summary) {
      refreshOperationalWidgets();
    }
  }

  window.setInterval(updateClock, 1000);
  window.setInterval(updateTempoOnline, 1000);

  bindSocket();
})();
