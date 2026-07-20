"use strict";

// MonitorTriagem: servidor HTTP e canal em tempo real para os monitores.
const path = require("path");
const http = require("http");
const express = require("express");
const { Server } = require("socket.io");

const DEFAULT_PORT = 3000;
const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  // Mantém a sessão Socket.IO saudável em monitores abertos por longos períodos.
  pingInterval: 25000,
  pingTimeout: 20000,
  serveClient: true
});

let latestState = null;
const operationalState = {
  startedAt: Date.now(),
  routes: new Map(),
  cities: new Map(),
  ufs: new Map(),
  ceps: new Map()
};

app.disable("x-powered-by");
app.use(express.json({ limit: "32kb" }));

// Responde JSON também quando o n8n enviar um corpo inválido.
app.use((error, _request, response, next) => {
  if (error instanceof SyntaxError && "body" in error) {
    return response.status(400).json({
      ok: false,
      error: "O corpo da requisição precisa ser um JSON válido."
    });
  }

  return next(error);
});

// Impede que a página principal fique presa em cache após uma atualização do monitor.
app.get("/", (_request, response) => {
  response.sendFile(path.join(__dirname, "public", "index.html"), {
    headers: { "Cache-Control": "no-store" }
  });
});

app.use(express.static(path.join(__dirname, "public"), {
  maxAge: 0,
  etag: false,
  setHeaders(response) {
    response.setHeader("Cache-Control", "no-store");
  }
}));

function broadcastConnectedClients() {
  io.emit("clientesConectados", io.engine.clientsCount);
}

function normalizeLabel(value, maxLength = 80) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function normalizeCount(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : null;
}

function repairTextEncoding(value) {
  const raw = String(value ?? "").trim();

  if (!raw || !/[ÃÂ�]/.test(raw)) {
    return raw;
  }

  try {
    const repaired = Buffer.from(raw, "latin1").toString("utf8");
    return repaired.includes("�") ? raw : repaired;
  } catch (_error) {
    return raw;
  }
}

function normalizeCounterEntries(source) {
  if (!source || typeof source !== "object") {
    return null;
  }

  const entries = [];
  const pushEntry = (label, value) => {
    const normalizedLabel = normalizeLabel(label, 80);
    const normalizedValue = normalizeCount(value);

    if (normalizedLabel && normalizedValue !== null) {
      entries.push([normalizedLabel, normalizedValue]);
    }
  };

  if (Array.isArray(source)) {
    for (const item of source) {
      if (Array.isArray(item) && item.length >= 2) {
        pushEntry(item[0], item[1]);
        continue;
      }

      if (item && typeof item === "object") {
        pushEntry(
          item.rota ?? item.route ?? item.cidade ?? item.city ?? item.uf ?? item.label ?? item.key ?? item.name,
          item.total ?? item.count ?? item.value ?? item.quantidade
        );
      }
    }
  } else {
    for (const [key, value] of Object.entries(source)) {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        pushEntry(
          value.rota ?? value.route ?? value.cidade ?? value.city ?? value.uf ?? value.label ?? key,
          value.total ?? value.count ?? value.value ?? value.quantidade
        );
        continue;
      }

      pushEntry(key, value);
    }
  }

  return entries.length ? entries : null;
}

function setEntriesFromSnapshot(target, entries) {
  if (!entries) {
    return false;
  }

  target.clear();

  for (const [label, count] of entries) {
    target.set(label, count);
  }

  return true;
}

function incrementCounter(target, label) {
  const normalizedLabel = normalizeLabel(label, 80);

  if (!normalizedLabel) {
    return;
  }

  target.set(normalizedLabel, (target.get(normalizedLabel) || 0) + 1);
}

function sortCounterEntries(target) {
  return Array.from(target.entries())
    .map(([label, count]) => ({ label, count }))
    .sort((left, right) => {
      if (right.count !== left.count) {
        return right.count - left.count;
      }

      return left.label.localeCompare(right.label, "pt-BR");
    });
}

function buildDashboardStats() {
  const routeEntries = sortCounterEntries(operationalState.routes);
  const cityEntries = sortCounterEntries(operationalState.cities);
  const ufEntries = sortCounterEntries(operationalState.ufs);
  const cepEntries = sortCounterEntries(operationalState.ceps);
  const totalHoje = latestState ? latestState.totalHoje : 0;
  const uptimeMinutes = Math.max((Date.now() - operationalState.startedAt) / 60000, 1 / 60);
  const productionPerMinute = totalHoje / uptimeMinutes;
  const productionPerHour = productionPerMinute * 60;
  const lastCarta = latestState
    ? `${latestState.rota} • ${latestState.cidade}/${latestState.uf}`
    : "--";

  return {
    totalHoje,
    totalCidades: cityEntries.length,
    totalCepsUnicos: cepEntries.length,
    rotasAtivas: routeEntries.length,
    rotaMaisMovimentada: routeEntries[0]?.label ?? "--",
    cidadeMaisProcessada: cityEntries[0]?.label ?? "--",
    ufMaisProcessada: ufEntries[0]?.label ?? "--",
    ultimaCartaLida: lastCarta,
    ultimaCidadeLida: latestState?.cidade ?? "--",
    ultimaRotaLida: latestState?.rota ?? "--",
    ultimoCepLido: latestState?.cep ?? "--",
    horaUltimaLeitura: latestState?.hora ?? "--:--:--",
    ultimaRotaEnviada: latestState?.rota ?? "--",
    producaoMediaMinuto: productionPerMinute,
    producaoHora: productionPerHour,
    routeEntries,
    cityEntries,
    ufEntries,
    generatedAt: new Date().toISOString()
  };
}

function broadcastDashboardStats() {
  io.emit("dashboardStats", buildDashboardStats());
}

/**
 * Converte e valida o formato aceito pelo endpoint /update.
 * @param {unknown} input Corpo JSON recebido pelo n8n.
 * @returns {{ok: true, data: object} | {ok: false, error: string}}
 */
function normalizeUpdate(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "Envie um objeto JSON com os dados da carta." };
  }

  const value = (field, maxLength) => repairTextEncoding(String(input[field] ?? "").trim()).slice(0, maxLength);
  const rota = value("rota", 20);
  const cidade = value("cidade", 80);
  const uf = value("uf", 10).toUpperCase();
  const cep = value("cep", 20);
  const hora = value("hora", 80) || new Date().toISOString();
  const totalHoje = Number(input.totalHoje);

  if (!rota || !cidade || !uf || !cep) {
    return { ok: false, error: "Os campos rota, cidade, uf e cep são obrigatórios." };
  }

  if (!Number.isFinite(totalHoje) || totalHoje < 0) {
    return { ok: false, error: "O campo totalHoje deve ser um número maior ou igual a zero." };
  }

  return {
    ok: true,
    data: {
      rota,
      cidade,
      uf,
      cep,
      hora,
      totalHoje: Math.trunc(totalHoje)
    }
  };
}

function updateOperationalState(normalized, rawInput) {
  const routeSnapshot = normalizeCounterEntries(rawInput.contadorPorRota);
  const citySnapshot = normalizeCounterEntries(rawInput.contadorPorCidade);
  const ufSnapshot = normalizeCounterEntries(rawInput.contadorPorUF);

  if (!setEntriesFromSnapshot(operationalState.routes, routeSnapshot)) {
    incrementCounter(operationalState.routes, normalized.rota);
  }

  if (!setEntriesFromSnapshot(operationalState.cities, citySnapshot)) {
    incrementCounter(operationalState.cities, normalized.cidade);
  }

  if (!setEntriesFromSnapshot(operationalState.ufs, ufSnapshot)) {
    incrementCounter(operationalState.ufs, normalized.uf);
  }

  incrementCounter(operationalState.ceps, normalized.cep);
}

// Recebe a carta processada pelo fluxo do n8n e publica para todos os monitores.
app.post("/update", (request, response) => {
  const result = normalizeUpdate(request.body);

  if (!result.ok) {
    console.warn(`[HTTP] /update rejeitado: ${result.error}`);
    return response.status(400).json(result);
  }

  latestState = result.data;
  updateOperationalState(latestState, request.body);
  io.emit("novaCarta", latestState);
  broadcastDashboardStats();
  console.info(`[HTTP] /update aceito - rota ${latestState.rota}, cidade ${latestState.cidade}, total ${latestState.totalHoje}`);

  return response.status(200).json({
    ok: true,
    message: "Monitor atualizado.",
    data: latestState
  });
});

// Endpoint simples para monitoramento externo ou diagnóstico da instalação.
app.get("/health", (_request, response) => {
  response.json({ ok: true, connectedClients: io.engine.clientsCount });
});

io.on("connection", (socket) => {
  // Um navegador que acabou de reconectar recebe o último estado sem esperar nova carta.
  if (latestState) {
    socket.emit("estadoAtual", latestState);
  }

  socket.emit("clientesConectados", io.engine.clientsCount);
  socket.emit("dashboardStats", buildDashboardStats());
  broadcastConnectedClients();

  socket.on("disconnect", () => {
    broadcastConnectedClients();
  });
});

/**
 * Inicializa o servidor; exportado para permitir o teste automatizado do projeto.
 * @param {number} port Porta desejada. Use 0 para uma porta aleatória em testes.
 * @returns {Promise<http.Server>}
 */
function start(port = Number(process.env.PORT) || DEFAULT_PORT) {
  return new Promise((resolve, reject) => {
    if (httpServer.listening) {
      return resolve(httpServer);
    }

    httpServer.once("error", reject);
    httpServer.listen(port, () => {
      httpServer.off("error", reject);
      console.log(`MonitorTriagem em execução em http://localhost:${httpServer.address().port}`);
      resolve(httpServer);
    });
  });
}

/** Fecha conexões Socket.IO e HTTP, usado apenas nos testes automatizados. */
function stop() {
  return new Promise((resolve) => {
    io.close(() => {
      if (!httpServer.listening) {
        return resolve();
      }
      return httpServer.close(resolve);
    });
  });
}

if (require.main === module) {
  start().catch((error) => {
    console.error("Não foi possível iniciar o MonitorTriagem:", error.message);
    process.exitCode = 1;
  });
}

app.use((error, _request, response, next) => {
  if (response.headersSent) {
    return next(error);
  }

  console.error("Erro inesperado no MonitorTriagem:", error);
  return response.status(500).json({
    ok: false,
    error: "Erro interno ao processar a requisição."
  });
});

module.exports = { app, httpServer, io, normalizeUpdate, start, stop };
