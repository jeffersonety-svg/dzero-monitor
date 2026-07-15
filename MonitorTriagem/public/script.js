"use strict";

// Chave única para manter a última carta visível mesmo após uma queda de rede ou reinício do navegador.
const STORAGE_KEY = "monitor-triagem:last-state";
const DISPLAY_DURATION_MS = 2000;
const numberFormatter = new Intl.NumberFormat("pt-BR");

const elements = Object.freeze({
  dashboard: document.getElementById("dashboard"),
  rota: document.getElementById("rota"),
  cidade: document.getElementById("cidade"),
  uf: document.getElementById("uf"),
  cep: document.getElementById("cep"),
  totalHoje: document.getElementById("totalHoje"),
  ultimaLeitura: document.getElementById("ultimaLeitura"),
  clockTime: document.getElementById("clockTime"),
  clockDate: document.getElementById("clockDate"),
  connection: document.getElementById("connection"),
  connectionText: document.getElementById("connectionText"),
  statusText: document.getElementById("statusText"),
  statusDetail: document.getElementById("statusDetail")
});

const beep = new Audio("/beep.mp3");
beep.preload = "auto";

let statusTimer = null;

/** Remove valores inesperados antes de os apresentar na interface. */
function text(value, fallback, maxLength) {
  const result = String(value ?? "").trim().slice(0, maxLength);
  return result || fallback;
}

/** Converte o horário do n8n (HH:mm:ss ou ISO) para o padrão do monitor. */
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

/** Atualiza o relógio local independente da chegada de cartas. */
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

/** Define o aviso de conexão sem disparar erros durante tentativas automáticas de reconexão. */
function setConnection(state) {
  elements.connection.classList.remove("is-online", "is-offline");

  if (state === "online") {
    elements.connection.classList.add("is-online");
    elements.connectionText.textContent = "ONLINE";
    elements.statusDetail.textContent = "CONEXÃO ATIVA";
    return;
  }

  if (state === "offline") {
    elements.connection.classList.add("is-offline");
    elements.connectionText.textContent = "DESCONECTADO";
    elements.statusDetail.textContent = "RECONEXÃO AUTOMÁTICA";
    return;
  }

  elements.connectionText.textContent = "CONECTANDO";
  elements.statusDetail.textContent = "CONECTANDO AO SERVIDOR";
}

function setStatus(message, detail) {
  elements.statusText.textContent = message;
  elements.statusDetail.textContent = detail;
}

/** Faz o bip quando o navegador permite áudio; falhas de autoplay são tratadas silenciosamente. */
function playBeep() {
  beep.pause();
  beep.currentTime = 0;
  const playPromise = beep.play();

  if (playPromise) {
    playPromise.catch(() => {
      // Alguns navegadores exigem uma interação do operador antes de liberar áudio.
    });
  }
}

function persistState(data) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch (_error) {
    // O monitor continua funcionando caso o armazenamento local esteja indisponível.
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
  // Força o navegador a reiniciar as animações a cada nova leitura.
  void elements.dashboard.offsetWidth;
  elements.dashboard.classList.add("update-animation");
}

/** Atualiza toda a tela a partir do mesmo objeto recebido pelo Socket.IO. */
function applyCarta(data, { restored = false } = {}) {
  const carta = {
    rota: text(data?.rota, "--", 20),
    cidade: text(data?.cidade, "AGUARDANDO LEITURA", 80),
    uf: text(data?.uf, "--", 10).toUpperCase(),
    cep: text(data?.cep, "----- ---", 20),
    hora: formatTime(data?.hora),
    totalHoje: Math.max(0, Math.trunc(Number(data?.totalHoje) || 0))
  };
  const pending = carta.rota.toUpperCase() === "PENDENTE";

  elements.rota.textContent = carta.rota;
  elements.cidade.textContent = carta.cidade;
  elements.uf.textContent = carta.uf;
  elements.cep.textContent = carta.cep;
  elements.ultimaLeitura.textContent = carta.hora;
  elements.totalHoje.textContent = numberFormatter.format(carta.totalHoje);
  document.body.classList.toggle("pending", pending);

  persistState(carta);

  if (restored) {
    setStatus("AGUARDANDO PRÓXIMA CARTA", "ÚLTIMA LEITURA RECUPERADA");
    return;
  }

  restartAnimation();
  playBeep();
  clearTimeout(statusTimer);
  setStatus(
    pending ? "ROTA PENDENTE — VERIFICAR TRIAGEM" : `ROTA ${carta.rota} RECEBIDA`,
    pending ? "ATENÇÃO NECESSÁRIA" : "DADOS ATUALIZADOS"
  );

  // Mantém a indicação da rota por dois segundos e então volta ao estado de espera.
  statusTimer = window.setTimeout(() => {
    setStatus("AGUARDANDO PRÓXIMA CARTA", pending ? "PENDÊNCIA EM EXIBIÇÃO" : "SISTEMA PRONTO");
  }, DISPLAY_DURATION_MS);
}

// Exibe imediatamente o último dado conhecido enquanto a conexão é restabelecida.
const savedState = restoreState();
if (savedState) {
  applyCarta(savedState, { restored: true });
}

updateClock();
window.setInterval(updateClock, 1000);

// Socket.IO já possui reconexão automática; estas opções aumentam a resiliência do monitor de longa duração.
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
