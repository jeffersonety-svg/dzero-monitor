"use strict";

const STORAGE_KEY = "monitor-triagem:last-state";
const DISPLAY_DURATION_MS = 2000;
const numberFormatter = new Intl.NumberFormat("pt-BR");

const elements = Object.freeze({
  dashboard: document.getElementById("dashboard"),
  rota: document.getElementById("rota"),
  cidade: document.getElementById("cidade"),
  uf: document.getElementById("uf"),
  cep: document.getElementById("cep"),
  hora: document.getElementById("hora"),
  totalHoje: document.getElementById("totalHoje"),
  ultimaLeitura: document.getElementById("ultimaLeitura"),
  clockTime: document.getElementById("clockTime"),
  clockDate: document.getElementById("clockDate"),
  connection: document.getElementById("connection"),
  connectionText: document.getElementById("connectionText"),
  statusText: document.getElementById("statusText"),
  statusDetail: document.getElementById("statusDetail"),
  serverStatus: document.getElementById("serverStatus"),
  connectedClients: document.getElementById("connectedClients"),
  timeOnline: document.getElementById("timeOnline"),
  cardsPerMinute: document.getElementById("cardsPerMinute"),
  routesGrid: document.getElementById("routesGrid"),
  routeFilter: document.getElementById("routeFilter"),
  historyBody: document.getElementById("historyBody"),
  chartCanvas: document.getElementById("chartCanvas")
});

const beep = new Audio("/beep.mp3");
beep.preload = "auto";

let statusTimer = null;
let productionPerMinute = [];
let historyEntries = [];
let chartContext = null;
const connectedAt = new Date();

function text(value, fallback, maxLength) {
  const result = String(value ?? "").trim().slice(0, maxLength);
  return result || fallback;
}

function formatTime(value) {
  const raw = text(value, "", 80);
  const timeMatch = raw.match(/(\d{2}:\d{2}(?::\d{2})?)/);

  if (timeMatch) {
    return timeMatch[1].length === 5 ? `${timeMatch[1]}:00` : timeMatch[1];
  }

  const date = new Date(raw);
  return Number.isNaN(date.getTime())
    ? new Date().toLocaleTimeString("pt-BR", { hour12: false })
    : date.toLocaleTimeString("pt-BR", { hour12: false });
}

function updateClock() {
  const now = new Date();
  elements.clockTime.textContent = now.toLocaleTimeString("pt-BR", { hour12: false });
  elements.clockDate.textContent = now.toLocaleDateString("pt-BR", {
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
    year: "numeric"
  }).replace(".", "").toUpperCase();
}

function formatDuration(milliseconds) {
  const seconds = Math.floor(milliseconds / 1000);
  const hours = String(Math.floor(seconds / 3600)).padStart(2, "0");
  const minutes = String(Math.floor((seconds % 3600) / 60)).padStart(2, "0");
  const secs = String(seconds % 60).padStart(2, "0");
  return `${hours}:${minutes}:${secs}`;
}

function updateOnlineTime() {
  elements.timeOnline.textContent = formatDuration(Date.now() - connectedAt.getTime());
}

function getSortedRouteKeys(counts) {
  if (!counts || typeof counts !== "object") {
    return [];
  }

  return Object.keys(counts)
    .filter((route) => route != null && String(route).trim().length > 0)
    .sort((a, b) => String(a).localeCompare(String(b), "pt-BR", { numeric: true, sensitivity: "base" }));
}

function createRouteCard(routeName, count) {
  const card = document.createElement("div");
  card.className = "route-box";
  card.dataset.route = routeName;
  card.innerHTML = `
    <span>${routeName}</span>
    <strong>${numberFormatter.format(count)}</strong>
  `;
  return card;
}

function getRouteCard(routeName) {
  return elements.routesGrid.querySelector(`.route-box[data-route="${CSS.escape(routeName)}"]`);
}

function updateRouteCards(counts) {
  const sortedRoutes = getSortedRouteKeys(counts);
  const existingCards = Array.from(elements.routesGrid.querySelectorAll(".route-box"));
  const existingByRoute = new Map(existingCards.map((card) => [card.dataset.route, card]));

  sortedRoutes.forEach((routeName) => {
    const count = Number(counts[routeName]) || 0;
    const card = existingByRoute.get(routeName);

    if (card) {
      const valueElement = card.querySelector("strong");
      const currentValue = Number(valueElement.textContent.replace(/\D/g, "")) || 0;
      if (count !== currentValue) {
        valueElement.textContent = numberFormatter.format(count);
        card.classList.add("route-update");
        window.setTimeout(() => card.classList.remove("route-update"), 800);
      }
      existingByRoute.delete(routeName);
      return;
    }

    const newCard = createRouteCard(routeName, count);
    elements.routesGrid.appendChild(newCard);
  });

  existingByRoute.forEach((card) => {
    card.remove();
  });

  updateRouteFilter(sortedRoutes);
}

function addHistoryEntry(carta) {
  historyEntries.unshift({
    hora: carta.hora,
    cep: carta.cep,
    cidade: carta.cidade,
    uf: carta.uf,
    rota: carta.rota
  });

  if (historyEntries.length > 10) {
    historyEntries.length = 10;
  }

  renderHistory();
}

function getFilteredHistory() {
  const filterValue = elements.routeFilter?.value || "";
  if (!filterValue) {
    return historyEntries;
  }

  return historyEntries.filter((entry) => entry.rota === filterValue);
}

function renderHistory() {
  const rows = getFilteredHistory()
    .map(
      (entry) => `
        <tr>
          <td>${entry.hora}</td>
          <td>${entry.cep}</td>
          <td>${entry.cidade}</td>
          <td>${entry.uf}</td>
          <td>${entry.rota}</td>
        </tr>
      `
    )
    .join("");

  elements.historyBody.innerHTML = rows;
}

function populateRouteFilter(routes = []) {
  if (!elements.routeFilter) {
    return;
  }

  const options = ["", ...routes];
  elements.routeFilter.innerHTML = options
    .map((route) => `
      <option value="${route}">${route || "Todas"}</option>
    `)
    .join("");

  if (!elements.routeFilter.hasAttribute("data-listener")) {
    elements.routeFilter.addEventListener("change", renderHistory);
    elements.routeFilter.setAttribute("data-listener", "true");
  }
}

function updateProductionData(currentMinute, restored) {
  if (restored) {
    return Number(elements.cardsPerMinute.textContent) || 0;
  }

  const minuteLabel = currentMinute || formatTime();
  const point = productionPerMinute[productionPerMinute.length - 1];

  if (point && point.label === minuteLabel) {
    point.count += 1;
  } else {
    productionPerMinute.push({ label: minuteLabel, count: 1 });
  }

  if (productionPerMinute.length > 10) {
    productionPerMinute.shift();
  }

  const currentCount = productionPerMinute[productionPerMinute.length - 1]?.count || 0;
  elements.cardsPerMinute.textContent = String(currentCount);
  return currentCount;
}

function drawProductionChart() {
  if (!chartContext) {
    return;
  }

  const canvas = elements.chartCanvas;
  const rect = canvas.getBoundingClientRect();
  const width = rect.width;
  const height = rect.height;

  chartContext.clearRect(0, 0, width, height);
  chartContext.save();

  const data = productionPerMinute.slice(-10);
  if (data.length === 0) {
    chartContext.fillStyle = "rgba(255, 255, 255, 0.16)";
    chartContext.font = "600 14px Inter, Arial, sans-serif";
    chartContext.fillText("Aguardando primeiros dados...", 18, height / 2);
    chartContext.restore();
    return;
  }

  const maxCount = Math.max(...data.map((item) => item.count), 1);
  const padding = 24;
  const labelPadding = 28;
  const availableWidth = width - padding * 2;
  const availableHeight = height - padding * 2 - labelPadding;
  const barWidth = Math.max(18, Math.floor(availableWidth / data.length) - 14);

  chartContext.strokeStyle = "rgba(255,255,255,0.08)";
  chartContext.lineWidth = 1;
  for (let i = 0; i <= 4; i += 1) {
    const y = padding + (availableHeight / 4) * i;
    chartContext.beginPath();
    chartContext.moveTo(padding, y);
    chartContext.lineTo(width - padding, y);
    chartContext.stroke();
  }

  data.forEach((point, index) => {
    const x = padding + index * (barWidth + 14);
    const ratio = point.count / maxCount;
    const barHeight = Math.max(4, ratio * availableHeight);
    const y = padding + availableHeight - barHeight;

    const gradient = chartContext.createLinearGradient(0, y, 0, y + barHeight);
    gradient.addColorStop(0, "rgba(49, 237, 139, 0.95)");
    gradient.addColorStop(1, "rgba(49, 237, 139, 0.28)");

    chartContext.fillStyle = gradient;
    chartContext.fillRect(x, y, barWidth, barHeight);
    chartContext.shadowColor = "rgba(49, 237, 139, 0.2)";
    chartContext.shadowBlur = 16;
    chartContext.fillRect(x, y, barWidth, barHeight);
    chartContext.shadowBlur = 0;

    chartContext.fillStyle = "#ffffff";
    chartContext.font = "600 12px Inter, Arial, sans-serif";
    chartContext.textAlign = "center";
    chartContext.fillText(point.count, x + barWidth / 2, y - 10);

    chartContext.fillStyle = "rgba(171, 255, 211, 0.82)";
    chartContext.fillText(point.label, x + barWidth / 2, padding + availableHeight + 22);
  });

  chartContext.restore();
}

function resizeChart() {
  const canvas = elements.chartCanvas;
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.floor(rect.width * dpr);
  canvas.height = Math.floor(rect.height * dpr);
  chartContext = canvas.getContext("2d");
  chartContext.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawProductionChart();
}

function applyCarta(data, { restored = false } = {}) {
  const carta = {
    rota: text(data?.rota, "--", 20),
    cidade: text(data?.cidade, "AGUARDANDO LEITURA", 80),
    uf: text(data?.uf, "--", 10).toUpperCase(),
    cep: text(data?.cep, "----- ---", 20),
    hora: formatTime(data?.hora),
    totalHoje: Math.max(0, Math.trunc(Number(data?.totalHoje) || 0)),
    rotas: data?.rotas || {},
    connectedClients: Number(data?.connectedClients) || 0
  };
  const pending = carta.rota.toUpperCase() === "PENDENTE";

  elements.rota.textContent = carta.rota;
  elements.cidade.textContent = carta.cidade;
  elements.uf.textContent = carta.uf;
  elements.cep.textContent = carta.cep;
  elements.hora.textContent = carta.hora;
  elements.ultimaLeitura.textContent = carta.hora;
  elements.totalHoje.textContent = numberFormatter.format(carta.totalHoje);
  elements.connectedClients.textContent = String(carta.connectedClients);

  updateRouteCards(carta.rotas);
  addHistoryEntry(carta);
  carta.cardsPerMinute = updateProductionData(carta.hora, restored);
  drawProductionChart();
  hydrateMetrics(carta, restored);

  document.body.classList.toggle("pending", pending);
  persistState(carta);

  if (restored) {
    setStatus("AGUARDANDO PRÓXIMA CARTA", "ÚLTIMA LEITURA RECUPERADA");
    return;
  }

  restartAnimation();
  notifyArrival(`Nova rota ${carta.rota} carregada`);
  clearTimeout(statusTimer);
  setStatus(
    pending ? "ROTA PENDENTE — VERIFICAR TRIAGEM" : `ROTA ${carta.rota} RECEBIDA`,
    pending ? "ATENÇÃO NECESSÁRIA" : "DADOS ATUALIZADOS"
  );

  statusTimer = window.setTimeout(() => {
    setStatus("AGUARDANDO PRÓXIMA CARTA", pending ? "PENDÊNCIA EM EXIBIÇÃO" : "SISTEMA PRONTO");
  }, DISPLAY_DURATION_MS);
}

function setConnection(state) {
  elements.connection.classList.remove("is-online", "is-offline");

  if (state === "online") {
    elements.connection.classList.add("is-online");
    elements.connectionText.textContent = "ONLINE";
    elements.statusDetail.textContent = "CONEXÃO ATIVA";
    elements.serverStatus.textContent = "ONLINE";
    return;
  }

  if (state === "offline") {
    elements.connection.classList.add("is-offline");
    elements.connectionText.textContent = "DESCONECTADO";
    elements.statusDetail.textContent = "RECONEXÃO AUTOMÁTICA";
    elements.serverStatus.textContent = "OFFLINE";
    return;
  }

  elements.connectionText.textContent = "CONECTANDO";
  elements.statusDetail.textContent = "CONECTANDO AO SERVIDOR";
  elements.serverStatus.textContent = "CONECTANDO";
}

function setStatus(message, detail) {
  elements.statusText.textContent = message;
  elements.statusDetail.textContent = detail;
}

function playBeep() {
  beep.pause();
  beep.currentTime = 0;
  const playPromise = beep.play();

  if (playPromise) {
    playPromise.catch(() => {
      // Autoplay pode ser bloqueado até haver interação do usuário.
    });
  }
}

function notifyArrival(message) {
  if (window.speechSynthesis && typeof window.speechSynthesis.speak === "function") {
    const utterance = new SpeechSynthesisUtterance(message);
    utterance.lang = "pt-BR";
    utterance.rate = 1;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
    return;
  }

  playBeep();
}

function persistState(data) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch (_error) {
    // Continua funcionando mesmo se o armazenamento estiver indisponível.
  }
}

function restoreState() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved ? JSON.parse(saved) : null;
  } catch (_error) {
    return null;
  }
}

function restartAnimation() {
  elements.dashboard.classList.remove("update-animation");
  void elements.dashboard.offsetWidth;
  elements.dashboard.classList.add("update-animation");
}

function animateMetricCard(element) {
  if (!element) {
    return;
  }

  element.classList.add("active-change");
  window.setTimeout(() => element.classList.remove("active-change"), 900);
}

function hydrateMetrics(carta, restored) {
  if (!elements.totalHoje || !elements.ultimaLeitura || !elements.connectedClients || !elements.timeOnline || !elements.cardsPerMinute) {
    return;
  }

  const metricMap = [
    { id: "cardTotalHoje", value: numberFormatter.format(carta.totalHoje) },
    { id: "cardLastRead", value: carta.hora },
    { id: "cardClients", value: String(carta.connectedClients) },
    { id: "cardOnlineTime", value: elements.timeOnline.textContent },
    { id: "cardCardsPerMinute", value: String(carta.cardsPerMinute || elements.cardsPerMinute.textContent) }
  ];

  metricMap.forEach(({ id, value }) => {
    const card = document.getElementById(id);
    const valueSpan = card?.querySelector(".card-value");
    if (!card || !valueSpan) {
      return;
    }

    if (!restored && valueSpan.textContent !== value) {
      valueSpan.textContent = value;
      animateMetricCard(card);
    }
  });
}

resizeChart();
window.addEventListener("resize", resizeChart);

const savedState = restoreState();
if (savedState) {
  applyCarta(savedState, { restored: true });
}

updateClock();
updateOnlineTime();
window.setInterval(() => {
  updateClock();
  updateOnlineTime();
}, 1000);

const socket = io({
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 10000,
  randomizationFactor: 0.25,
  timeout: 10000
});

socket.on("connect", () => setConnection("online"));
socket.on("disconnect", () => setConnection("offline"));
socket.on("connect_error", () => setConnection("offline"));
socket.on("novaCarta", (data) => applyCarta(data));
socket.on("estadoAtual", (data) => applyCarta(data, { restored: true }));
