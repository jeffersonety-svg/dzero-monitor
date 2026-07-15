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
  maxAge: "1h",
  etag: true
}));

/**
 * Converte e valida o formato aceito pelo endpoint /update.
 * @param {unknown} input Corpo JSON recebido pelo n8n.
 * @returns {{ok: true, data: object} | {ok: false, error: string}}
 */
function normalizeUpdate(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "Envie um objeto JSON com os dados da carta." };
  }

  const value = (field, maxLength) => String(input[field] ?? "").trim().slice(0, maxLength);
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

// Recebe a carta processada pelo fluxo do n8n e publica para todos os monitores.
app.post("/update", (request, response) => {
  const result = normalizeUpdate(request.body);

  if (!result.ok) {
    return response.status(400).json(result);
  }

  latestState = result.data;
  io.emit("novaCarta", latestState);

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

module.exports = { app, httpServer, io, normalizeUpdate, start, stop };
