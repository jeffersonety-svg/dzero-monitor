"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { io: createClient } = require("socket.io-client");
const { httpServer, start, stop } = require("../server");

let baseUrl;

test.before(async () => {
  await start(0);
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
});

test.after(async () => {
  await stop();
});

test("POST /update transmite novaCarta para um cliente Socket.IO", async () => {
  const client = createClient(baseUrl, { transports: ["websocket"], forceNew: true });

  await new Promise((resolve, reject) => {
    client.once("connect", resolve);
    client.once("connect_error", reject);
  });

  const novaCarta = new Promise((resolve) => client.once("novaCarta", resolve));
  const response = await fetch(`${baseUrl}/update`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      rota: "07",
      cidade: "Curitiba",
      uf: "PR",
      cep: "81520-900",
      hora: "09:35:22",
      totalHoje: 1528
    })
  });

  const body = await response.json();
  const received = await novaCarta;
  client.close();

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.deepEqual(received, {
    rota: "07",
    cidade: "Curitiba",
    uf: "PR",
    cep: "81520-900",
    hora: "09:35:22",
    totalHoje: 1528
  });
});

test("POST /update rejeita dados obrigatórios ausentes", async () => {
  const response = await fetch(`${baseUrl}/update`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rota: "07" })
  });

  assert.equal(response.status, 400);
});

test("POST /update corrige texto com encoding quebrado", async () => {
  const response = await fetch(`${baseUrl}/update`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      rota: "R-102",
      cidade: "SÃ£o Paulo",
      uf: "SP",
      cep: "01310-911",
      hora: "12:00:00",
      totalHoje: 1242
    })
  });

  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.data.cidade, "São Paulo");
});
