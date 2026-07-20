"use strict";

(() => {
  const STORAGE_KEY = "monitor-triagem:last-state";
  const STATUS_TIMEOUT_MS = 2000;
  const numberFormatter = new Intl.NumberFormat("pt-BR");

  const elements = Object.freeze({
    routePanel: document.querySelector(".main-panel"),
    rota: document.getElementById("rota"),
    cidade: document.getElementById("cidade"),
    cidadeCardBox: document.getElementById("cidadeCardBox"),
    cep: document.getElementById("cep"),
    uf: document.getElementById("uf"),
    horaUltimaLeitura: document.getElementById("horaUltimaLeitura"),
    statusLeitura: document.getElementById("statusLeitura"),
    mensagemLeitura: document.getElementById("mensagemLeitura"),
    systemId: document.getElementById("systemId"),
    stationDetail: document.getElementById("stationDetail"),
    topbarDate: document.getElementById("topbarDate"),
    topbarTime: document.getElementById("topbarTime"),
    connection: document.getElementById("connection"),
    connectionText: document.getElementById("connectionText"),
    serverStatusText: document.getElementById("serverStatusText"),
    serverStatusCard: document.getElementById("serverStatusCard"),
    clientesConectadosTopbar: document.getElementById("clientesConectadosTopbar"),
    totalCidadesCard: document.getElementById("totalCidadesCard"),
    totalHojeCard: document.getElementById("totalHojeCard"),
    statusText: document.getElementById("statusText"),
    statusDetail: document.getElementById("statusDetail")
  });

  const speech = window.speechSynthesis || null;
  const viewState = Object.create(null);
  const runtimeState = {
    snapshot: null,
    summary: null,
    citiesSeen: new Set(),
    lastAnnouncementKey: "",
    connectedSince: null,
    statusTimer: null,
    routeFlashTimer: null,
    cityFlashTimer: null,
    preferredVoice: null
  };

  function normalizeText(value, fallback, maxLength) {
    const result = String(value ?? "").trim().slice(0, maxLength);
    return result || fallback;
  }

  function repairTextEncoding(value) {
    const raw = String(value ?? "").trim();

    if (!raw) {
      return "";
    }

    if (!/[ÃÂ�]/.test(raw)) {
      return raw;
    }

    try {
      const repaired = decodeURIComponent(escape(raw));
      return repaired.includes("�") ? raw : repaired;
    } catch (_error) {
      return raw;
    }
  }

  function normalizeNumber(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function formatTime(value) {
    const raw = normalizeText(value, "", 80);
    const directMatch = raw.match(/(\d{2}:\d{2}(?::\d{2})?)/);

    if (directMatch) {
      return directMatch[1].length === 5 ? `${directMatch[1]}:00` : directMatch[1];
    }

    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) {
      return "--:--:--";
    }

    return date.toLocaleTimeString("pt-BR", { hour12: false });
  }

  function formatDate(value = new Date()) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) {
      return "-- --- ----";
    }

    const day = date.toLocaleDateString("pt-BR", { day: "2-digit" });
    const month = date.toLocaleDateString("pt-BR", { month: "short" }).replace(".", "").toUpperCase();
    const year = date.toLocaleDateString("pt-BR", { year: "numeric" });
    return `${day} ${month} ${year}`;
  }

  function formatLoad(value) {
    if (value === null || typeof value === "undefined" || value === "") {
      return "--";
    }

    if (typeof value === "string" && value.includes("%")) {
      return normalizeText(value, "--", 12);
    }

    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      return "--";
    }

    return `${Math.max(0, Math.min(100, Math.trunc(parsed)))}%`;
  }

  function buildStationDetail(systemId, scannerLoad) {
    return `ESTAÇÃO_${systemId}_ATIVA | CARGA: ${scannerLoad}`;
  }

  function setText(key, element, value, card) {
    if (!element) {
      return false;
    }

    const nextValue = String(value);

    if (viewState[key] === nextValue) {
      return false;
    }

    viewState[key] = nextValue;

    if (element.textContent !== nextValue) {
      element.textContent = nextValue;
      return true;
    }

    return false;
  }

  function persistSnapshot() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        snapshot: runtimeState.snapshot,
        summary: runtimeState.summary,
        citiesSeen: Array.from(runtimeState.citiesSeen)
      }));
    } catch (_error) {
      // Sem bloqueio: monitor segue funcionando mesmo sem localStorage.
    }
  }

  function restoreSnapshot() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        return;
      }

      const saved = JSON.parse(raw);
      if (saved?.snapshot && typeof saved.snapshot === "object") {
        runtimeState.snapshot = saved.snapshot;
      }

      if (saved?.summary && typeof saved.summary === "object") {
        runtimeState.summary = saved.summary;
      }

      if (Array.isArray(saved?.citiesSeen)) {
        runtimeState.citiesSeen = new Set(saved.citiesSeen.map((item) => normalizeText(item, "", 80)).filter(Boolean));
      }
    } catch (_error) {
      // Snapshot inválido é ignorado.
    }
  }

  function updateClock() {
    const now = new Date();
    setText("topbarDate", elements.topbarDate, formatDate(now), null, false);
    setText("topbarTime", elements.topbarTime, now.toLocaleTimeString("pt-BR", { hour12: false }), null, false);
  }

  function setConnectionStatus(status) {
    elements.connection.classList.remove("is-offline");

    if (status === "offline") {
      elements.connection.classList.add("is-offline");
      setText("statusDetail", elements.statusDetail, "RECONEXÃO AUTOMÁTICA", null, false);
      return;
    }

    if (status === "connecting") {
      setText("statusDetail", elements.statusDetail, "CONEXÃO EM PROGRESSO", null, false);
      return;
    }

    setText("statusDetail", elements.statusDetail, "CONEXÃO ESTÁVEL", null, false);
  }

  function setFooterStatus(message, detail) {
    setText("statusText", elements.statusText, message, null, false);
    setText("statusDetail", elements.statusDetail, detail, null, false);
  }

  function selectPreferredVoice() {
    if (!speech) {
      return null;
    }

    const voices = speech.getVoices();

    if (!voices.length) {
      return null;
    }

    const preferredVoices = voices
      .filter((voice) => /^pt(-|_)?BR$/i.test(voice.lang) || /^pt/i.test(voice.lang))
      .sort((left, right) => {
        const score = (voice) => {
          const name = `${voice.name || ""} ${voice.lang || ""}`.toLowerCase();
          let total = 0;

          if (voice.localService) total += 3;
          if (/natural|neural|premium|enhanced|wave/i.test(name)) total += 3;
          if (/google|microsoft|online|standard/i.test(name)) total += 2;
          if (/pt-br|portugu[eê]s do brasil|brazil/i.test(name)) total += 2;

          return total;
        };

        return score(right) - score(left);
      });

    return preferredVoices[0] || voices[0];
  }

  function numberToPortuguese(value) {
    const units = ["zero", "um", "dois", "tres", "quatro", "cinco", "seis", "sete", "oito", "nove"];
    const teens = ["dez", "onze", "doze", "treze", "quatorze", "quinze", "dezesseis", "dezessete", "dezoito", "dezenove"];
    const tens = ["", "", "vinte", "trinta", "quarenta", "cinquenta", "sessenta", "setenta", "oitenta", "noventa"];

    if (value < 10) {
      return units[value];
    }

    if (value < 20) {
      return teens[value - 10];
    }

    const ten = Math.floor(value / 10);
    const unit = value % 10;
    return unit === 0 ? tens[ten] : `${tens[ten]} e ${units[unit]}`;
  }

  function digitToPortuguese(digit) {
    return ["zero", "um", "dois", "três", "quatro", "cinco", "seis", "sete", "oito", "nove"][Number(digit)] || digit;
  }

  function spellDigits(value) {
    return String(value)
      .split("")
      .map((digit) => digitToPortuguese(digit))
      .join(", ");
  }

  function formatRouteForSpeech(routeValue) {
    const normalized = normalizeText(routeValue, "", 20).replace(/^rota\s*/i, "").trim();

    const letterNumberMatch = normalized.match(/^([A-Za-z])[\s-]*([0-9]+)$/);

    if (letterNumberMatch) {
      const routeNumber = Number(letterNumberMatch[2]);
      return `${letterNumberMatch[1].toUpperCase()} ${numberToPortuguese(routeNumber)}`;
    }

    if (!/^\d+$/.test(normalized)) {
      return normalized;
    }

    const routeNumber = Number(normalized);

    if (normalized.length === 2 && routeNumber < 10) {
      return `zero ${numberToPortuguese(routeNumber)}`;
    }

    return numberToPortuguese(routeNumber);
  }

  function buildAnnouncement(snapshot) {
    const routeText = formatRouteForSpeech(snapshot?.rota);
    const cityText = normalizeText(snapshot?.cidade, "", 80);

    if (!routeText || !cityText) {
      return "";
    }

    return `Rota ${routeText}. Cidade ${cityText}.`;
  }

  function speakReading(snapshot) {
    if (!speech || typeof window.SpeechSynthesisUtterance !== "function") {
      return;
    }

    const announcement = buildAnnouncement(snapshot);
    const announcementKey = `${snapshot?.rota}|${snapshot?.cidade}|${snapshot?.cep}|${snapshot?.hora}`;

    if (!announcement || runtimeState.lastAnnouncementKey === announcementKey) {
      return;
    }

    runtimeState.preferredVoice = runtimeState.preferredVoice || selectPreferredVoice();

    try {
      speech.cancel();

      const utterance = new window.SpeechSynthesisUtterance(announcement);
      utterance.lang = runtimeState.preferredVoice?.lang || "pt-BR";
      utterance.voice = runtimeState.preferredVoice || null;
      utterance.rate = 0.96;
      utterance.pitch = 1.0;
      utterance.volume = 1.0;
      utterance.onerror = () => {
        runtimeState.lastAnnouncementKey = "";
      };

      runtimeState.lastAnnouncementKey = announcementKey;

      // A fala acontece após o DOM ser pintado com a leitura nova.
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          speech.speak(utterance);
        });
      });
    } catch (_error) {
      runtimeState.lastAnnouncementKey = "";
    }
  }

  function flashRouteAndCity() {
    elements.rota.classList.remove("is-updated");
    elements.cidade.classList.remove("is-updated");
    elements.cidadeCardBox.classList.remove("is-updated");
  }

  function applySummary(summary) {
    runtimeState.summary = {
      totalHoje: Math.max(0, Math.trunc(normalizeNumber(summary?.totalHoje, runtimeState.snapshot?.totalHoje || 0))),
      totalCidades: Math.max(0, Math.trunc(normalizeNumber(summary?.totalCidades, runtimeState.citiesSeen.size))),
      ultimaCidadeLida: repairTextEncoding(normalizeText(summary?.ultimaCidadeLida, runtimeState.snapshot?.cidade || "--", 80)),
      ultimaRotaLida: normalizeText(summary?.ultimaRotaLida, runtimeState.snapshot?.rota || "--", 20),
      ultimoCepLido: normalizeText(summary?.ultimoCepLido, runtimeState.snapshot?.cep || "--", 20)
    };

    setText("totalHojeCard", elements.totalHojeCard, numberFormatter.format(runtimeState.summary.totalHoje), elements.totalHojeCard.closest(".side-card"));
    setText("totalCidadesCard", elements.totalCidadesCard, numberFormatter.format(runtimeState.summary.totalCidades), elements.totalCidadesCard.closest(".summary-card"));
  }

  function applySnapshot(data, options = {}) {
    const restored = Boolean(options.restored);
    const snapshot = {
      rota: repairTextEncoding(normalizeText(data?.rota, "--", 20)),
      cidade: repairTextEncoding(normalizeText(data?.cidade, "AGUARDANDO LEITURA", 80)),
      uf: normalizeText(data?.uf, "--", 10).toUpperCase(),
      cep: repairTextEncoding(normalizeText(data?.cep, "----- ---", 20)),
      hora: normalizeText(data?.hora, new Date().toISOString(), 80),
      totalHoje: Math.max(0, Math.trunc(normalizeNumber(data?.totalHoje, 0))),
      systemId: normalizeText(data?.systemId ?? data?.stationId ?? data?.estacaoAtiva, "A1", 20).toUpperCase(),
      scannerLoad: formatLoad(data?.scannerLoad ?? data?.load ?? data?.scannerLevel)
    };

    runtimeState.snapshot = snapshot;
    runtimeState.citiesSeen.add(snapshot.cidade);

    const readingTime = formatTime(snapshot.hora);
    const isPending = snapshot.rota.toUpperCase() === "PENDENTE";

    document.body.classList.toggle("pending", isPending);

    setText("rota", elements.rota, snapshot.rota, elements.routePanel);
    setText("cidade", elements.cidade, snapshot.cidade, elements.cidadeCardBox);
    setText("cep", elements.cep, snapshot.cep, elements.routePanel);
    setText("uf", elements.uf, snapshot.uf, elements.routePanel);
    setText("horaUltimaLeitura", elements.horaUltimaLeitura, readingTime, elements.routePanel, false);
    setText("systemId", elements.systemId, snapshot.systemId, elements.routePanel, false);
    setText("stationDetail", elements.stationDetail, buildStationDetail(snapshot.systemId, snapshot.scannerLoad), null, false);

    if (restored) {
      setText("statusLeitura", elements.statusLeitura, "AGUARDANDO LEITURA", null, false);
      setText("mensagemLeitura", elements.mensagemLeitura, "AGUARDANDO LEITURA", elements.routePanel, false);
      setFooterStatus("PROCESSAMENTO CONCLUÍDO", "ÚLTIMA LEITURA RECUPERADA");
    } else {
      const status = isPending ? "PENDENTE" : "LEITURA CONFIRMADA";
      const message = isPending ? "ROTA PENDENTE - VERIFICAR TRIAGEM" : `ROTA ${snapshot.rota} RECEBIDA`;

      setText("statusLeitura", elements.statusLeitura, status, null, false);
      setText("mensagemLeitura", elements.mensagemLeitura, message, elements.routePanel, false);

      flashRouteAndCity();
      setFooterStatus(isPending ? "PROCESSAMENTO PENDENTE" : "PROCESSAMENTO CONCLUÍDO", isPending ? "ATENÇÃO NECESSÁRIA" : "DADOS ATUALIZADOS");

      window.clearTimeout(runtimeState.statusTimer);
      runtimeState.statusTimer = window.setTimeout(() => {
        setText("statusLeitura", elements.statusLeitura, "AGUARDANDO LEITURA", null, false);
        setText("mensagemLeitura", elements.mensagemLeitura, "AGUARDANDO LEITURA", null, false);
        setFooterStatus("PROCESSAMENTO CONCLUÍDO", isPending ? "PENDÊNCIA EM EXIBIÇÃO" : "SISTEMA PRONTO");
      }, STATUS_TIMEOUT_MS);

      speakReading(snapshot);
    }

    applySummary(runtimeState.summary || {
      totalHoje: snapshot.totalHoje,
      totalCidades: runtimeState.citiesSeen.size,
      ultimaCidadeLida: snapshot.cidade,
      ultimaRotaLida: snapshot.rota,
      ultimoCepLido: snapshot.cep
    });

    persistSnapshot();
  }

  function updateConnectedClients(value) {
    const count = Math.max(0, Math.trunc(normalizeNumber(value, 0)));
    setText("clientesConectadosTopbar", elements.clientesConectadosTopbar, numberFormatter.format(count), elements.clientesConectadosTopbar.closest(".topbar-chip"), false);
  }

  async function refreshServerStatus() {
    try {
      const response = await fetch("/health", { cache: "no-store" });

      if (!response.ok) {
        throw new Error("health unavailable");
      }

      const payload = await response.json();
      elements.serverStatusCard?.classList.remove("is-offline");

      if (typeof payload?.connectedClients !== "undefined") {
        updateConnectedClients(payload.connectedClients);
      }
    } catch (_error) {
      elements.serverStatusCard?.classList.add("is-offline");
    }
  }

  function bindSocket() {
    const socket = io({
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 10000,
      randomizationFactor: 0.25,
      timeout: 10000
    });

    socket.on("connect", () => {
      runtimeState.connectedSince = Date.now();
      setConnectionStatus("online");
    });

    socket.on("disconnect", () => {
      runtimeState.connectedSince = null;
      setConnectionStatus("offline");
    });

    socket.on("connect_error", () => setConnectionStatus("offline"));
    socket.on("reconnect_attempt", () => setConnectionStatus("connecting"));
    socket.on("reconnect", () => setConnectionStatus("online"));
    socket.on("reconnect_error", () => setConnectionStatus("offline"));
    socket.on("reconnect_failed", () => setConnectionStatus("offline"));

    socket.on("estadoAtual", (payload) => applySnapshot(payload, { restored: true }));
    socket.on("novaCarta", (payload) => applySnapshot(payload));
    socket.on("dashboardStats", (payload) => applySummary(payload));
    socket.on("clientesConectados", updateConnectedClients);
  }

  restoreSnapshot();

  updateClock();
  setConnectionStatus("connecting");

  if (runtimeState.snapshot) {
    applySnapshot(runtimeState.snapshot, { restored: true });
  }

  if (runtimeState.summary) {
    applySummary(runtimeState.summary);
  }

  if (speech) {
    runtimeState.preferredVoice = selectPreferredVoice();
    speech.addEventListener("voiceschanged", () => {
      runtimeState.preferredVoice = selectPreferredVoice();
    });
  }

  window.setInterval(updateClock, 1000);
  window.setInterval(refreshServerStatus, 30000);
  refreshServerStatus();

  bindSocket();
})();
