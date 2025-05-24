const {
  default: makeWASocket,
  Browsers,
  useMultiFileAuthState,
  DisconnectReason,
} = require("baileys");
const pino = require("pino");
const path = require("path");
const qrcode = require("qrcode-terminal");
const fs = require("fs");

const logger = require("../utils/logs/logger");

const AUTH_STATE_PATH = path.join(__dirname, "temp", "auth_state_minimal");
const loggerB = pino({ level: "silent" });

let clientInstance = null;

async function connectToWhatsApp() {
  logger.error("Tentando conectar ao WhatsApp...", {
    label: "connectToWhatsApp",
  });

  if (!fs.existsSync(AUTH_STATE_PATH)) {
    console.log(
      `Diretório de estado de autenticação não encontrado em ${AUTH_STATE_PATH}. Criando...`
    );
    try {
      fs.mkdirSync(AUTH_STATE_PATH, { recursive: true });
      console.log(`Diretório ${AUTH_STATE_PATH} criado com sucesso.`);
    } catch (mkdirError) {
      logger.error(
        `Falha ao criar o diretório ${AUTH_STATE_PATH}: ${mkdirError.message}`
      );
    }
  }

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_STATE_PATH);

  const socketConfig = {
    auth: state,
    loggerB: pino({ level: "silent" }),
    browser: Browsers.macOS("Desktop"),
    syncFullHistory: false,
    printQRInTerminal: false,
  };

  clientInstance = makeWASocket(socketConfig);

  clientInstance.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("QR Code recebido! Escaneie com seu WhatsApp:");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "open") {
      console.log("Conexão com o WhatsApp estabelecida com sucesso!");
    }

    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      logger.error(
        `Conexão fechada. Razão: ${
          DisconnectReason[statusCode] || "Desconhecida"
        } (Código: ${statusCode}). Tentando reconectar: ${shouldReconnect}`
      );

      if (shouldReconnect) {
        console.log("Tentando reconectar em 5 segundos...");
        setTimeout(connectToWhatsApp, 5000);
      } else {
        logger.error(
          "Deslogado. Não será possível reconectar. Por favor, remova a pasta 'temp/auth_state_minimal' e reinicie a aplicação para gerar um novo QR Code."
        );
      }
    }
  });

  clientInstance.ev.on("creds.update", async () => {
    await saveCreds();
    console.log("Credenciais de autenticação salvas/atualizadas.");
  });

  clientInstance.ev.on("messages.upsert", (data) => {
    console.log(
      `Evento 'messages.upsert' recebido. Número de mensagens: ${data.messages.length}. Tipo: ${data.type}`
    );
    if (data.messages[0] && data.messages[0].message) {
      console.log(`Conteúdo da primeira mensagem: ${JSON.stringify(data)}`);
    }
  });

  clientInstance.ev.on("groups.update", (updates) => {
    console.log(
      `Evento 'groups.update' recebido. Número de atualizações: ${updates.length}`
    );
  });

  clientInstance.ev.on("group-participants.update", (event) => {
    console.log(
      `Evento 'group-participants.update' recebido para o grupo ${
        event.id
      }. Ação: ${event.action}. Participantes: ${event.participants.join(", ")}`
    );
  });
  console.log("Todos os handlers de evento foram registrados.");
  return clientInstance;
}

connectToWhatsApp().catch((err) => {
  logger.fatal("Falha crítica ao tentar iniciar a conexão com o WhatsApp:", {
    message: err.message,
    stack: err.stack,
  });
  process.exit(1);
});
