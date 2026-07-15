# MonitorTriagem

Monitor industrial em tempo real para uma Central de Triagem de Correspondências. O servidor recebe uma carta processada pelo n8n e envia a atualização instantaneamente a todos os monitores abertos, sem F5.

## Recursos

- Interface industrial responsiva, de tela cheia e sem barras de rolagem.
- Atualização em tempo real com Node.js, Express e Socket.IO.
- Indicador ONLINE/DESCONECTADO e reconexão automática após falhas de rede.
- Último estado mantido no servidor e no navegador: ao reconectar, o monitor recupera a última leitura automaticamente.
- Fundo verde escuro para rotas normais e vermelho para `PENDENTE`.
- Relógio, data, animação e bip em cada leitura.

## 1. Instalar o Node.js

Instale a versão LTS (18 ou mais recente) em [nodejs.org](https://nodejs.org/). No Windows, mantenha marcada a opção de adicionar o Node.js ao `PATH` durante a instalação.

Para conferir, abra um terminal e execute:

```bash
node --version
npm --version
```

## 2. Abrir no Visual Studio Code

1. Extraia o arquivo `MonitorTriagem.zip`.
2. Abra o Visual Studio Code.
3. Selecione **Arquivo > Abrir Pasta** e escolha a pasta `MonitorTriagem`.
4. Abra o terminal integrado do VS Code.

## 3. Instalar e executar

No terminal, dentro da pasta do projeto:

```bash
npm install
npm run dev
```

O terminal exibirá o endereço do servidor. Abra [http://localhost:3000](http://localhost:3000) no navegador do computador que será o monitor.

Para parar o servidor, pressione `Ctrl+C` no terminal. Para iniciar em modo padrão, também é possível usar:

```bash
npm start
```

## 4. Integração com n8n

No último nó do fluxo, crie um nó **HTTP Request** com esta configuração:

| Campo | Valor |
| --- | --- |
| Method | `POST` |
| URL | `http://localhost:3000/update` |
| Send Body | Ativado |
| Body Content Type | `JSON` |
| Specify Body | `Using JSON` |

Use o seguinte corpo JSON:

```json
{
  "rota": "{{$json.Rota}}",
  "cidade": "{{$json.Cidade}}",
  "uf": "{{$json.UF}}",
  "cep": "{{$json.cep}}",
  "hora": "{{$now}}",
  "totalHoje": "{{$json.totalHoje}}"
}
```

> **Importante:** `localhost` só funciona se o n8n e o MonitorTriagem estiverem no mesmo computador. Se o n8n estiver em outro equipamento, troque `localhost` pelo IP do computador onde o servidor está aberto, por exemplo `http://192.168.1.50:3000/update`. Libere a porta TCP 3000 no firewall do Windows ou Linux quando necessário.

### Exemplo de teste manual

Com o servidor em execução, envie este JSON por uma ferramenta HTTP ou pelo próprio n8n:

```json
{
  "rota": "07",
  "cidade": "Curitiba",
  "uf": "PR",
  "cep": "81520-900",
  "hora": "09:35:22",
  "totalHoje": 1528
}
```

O endpoint responde com `200` e publica o evento `novaCarta` imediatamente para todos os navegadores conectados.

## Verificações automatizadas

Após instalar as dependências, execute:

```bash
npm test
```

O teste inicia o servidor em uma porta temporária, envia um `POST /update`, verifica a resposta e confirma que um cliente Socket.IO recebeu o evento em tempo real.

## Estrutura

```text
MonitorTriagem/
├── package.json
├── server.js
├── README.md
├── test/
│   └── server.test.js
└── public/
    ├── index.html
    ├── style.css
    ├── script.js
    ├── beep.mp3
    ├── logo.png
    └── favicon.ico
```

## Operação contínua

Deixe o navegador aberto na tela do monitor. Caso a rede ou o servidor oscile, o Socket.IO tenta reconectar automaticamente sem recarregar a página. Enquanto isso, a última carta continua visível; ao reconectar, o servidor envia novamente o último estado conhecido.
