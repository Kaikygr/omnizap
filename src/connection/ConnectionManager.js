const { default: makeWASocket, Browsers, useMultiFileAuthState, DisconnectReason, getContentType } = require('baileys');
const pino = require('pino');
const path = require('path');
const qrcode = require('qrcode-terminal');
const fsPromises = require('fs').promises; // Renomeado para fsPromises para clareza
const { existsSync, writeFileSync } = require('fs'); // Importa as funções síncronas necessárias
const { cleanEnv, num, str } = require('envalid');
const EventEmitter = require('events');

const logger = require('../utils/logs/logger');
require('dotenv').config();

const env = cleanEnv(process.env, {
  BACKOFF_INITIAL_DELAY_MS: num({ default: 5000 }),
  BACKOFF_MAX_DELAY_MS: num({ default: 60000 }),
  AUTH_STATE_PATH: str({ default: path.join(__dirname, 'temp', 'auth_state_minimal') }),
});

const STATUS = {
  CONNECTED: 'open',
  DISCONNECTED: 'close',
  CONNECTING: 'connecting',
};

let client = null;
let authState = null;
let reconnectionAttempts = 0;
const maxReconnectionAttempts = 10;
let isReconnecting = false;
let currentBackoffDelayMs = env.BACKOFF_INITIAL_DELAY_MS;
let backoffTimer = null;
const eventEmitter = new EventEmitter();

const instanceId = process.env.INSTANCE_ID || 'omnizap-instance';
const authStatePath = env.AUTH_STATE_PATH;
const initialBackoffDelayMs = env.BACKOFF_INITIAL_DELAY_MS;
const maxBackoffDelayMs = env.BACKOFF_MAX_DELAY_MS;
const authFlagPath = path.join(authStatePath, '.auth_success_flag');

function emitEvent(eventName, data, context = '') {
  try {
    eventEmitter.emit(eventName, data);
    logger.info(`Evento '${eventName}' emitido com sucesso.`, {
      label: 'EventEmitter',
      metricName: 'event.emit.success',
      context,
      eventName,
      dataKeys: typeof data === 'object' && data !== null ? Object.keys(data) : undefined,
      dataType: typeof data,
      instanceId,
    });
  } catch (error) {
    logger.error(` Erro ao emitir o evento '${eventName}': ${error.message}.`, {
      label: 'EventEmitter',
      metricName: 'event.emit.error',
      error: error.message,
      stack: error.stack,
      context,
      eventName,
      instanceId,
    });
  }
}

function getEventEmitter() {
  return eventEmitter;
}

function getClient() {
  return client;
}

async function loadAuthState() {
  const logMeta = { label: 'ConnectionManager.loadAuthState', instanceId };

  try {
    await fsPromises.access(authStatePath); // Usa fsPromises para operações assíncronas
  } catch {
    logger.info(`Diretório de autenticação não encontrado em "${authStatePath}". Criando...`, logMeta);
    try {
      await fsPromises.mkdir(authStatePath, { recursive: true }); // Usa fsPromises para operações assíncronas
      logger.info(`Diretório "${authStatePath}" criado com sucesso.`, logMeta);
    } catch (mkdirError) {
      logger.error(`Erro ao criar o diretório "${authStatePath}": ${mkdirError.message}`, {
        ...logMeta,
        error: mkdirError,
      });
      throw mkdirError;
    }
  }

  try {
    const { state, saveCreds } = await useMultiFileAuthState(authStatePath);
    logger.info('Estado de autenticação carregado com sucesso.', logMeta);
    return { state, saveCreds };
  } catch (authError) {
    logger.error(`Erro ao carregar o estado de autenticação: ${authError.message}`, {
      ...logMeta,
      error: authError,
    });
    throw authError;
  }
}

function setupEventHandlers() {
  if (!client) {
    const errorMessage = 'Cliente WhatsApp não inicializado. Execute connect() antes de setupEventHandlers().';
    logger.error(errorMessage, {
      label: 'ConnectionManager.setupEventHandlers',
      instanceId,
    });
    throw new Error(errorMessage);
  }

  const eventHandlers = {
    'connection.update': handleConnectionUpdate,
    'creds.update': handleCredsUpdate,
    'messages.upsert': handleMessagesUpsert,
    'messages.update': handleMessagesUpdate,
    'messages.delete': handleMessagesDelete,
    'messages.reaction': handleMessagesReaction,
    'message-receipt.update': handleMessageReceiptUpdate,
    'messaging-history.set': handleMessagingHistorySet,
    'groups.update': handleGroupsUpdate,
    'groups.upsert': handleGroupsUpsert,
    'group-participants.update': handleGroupParticipantsUpdate,
    'chats.upsert': handleChatsUpsert,
    'chats.update': handleChatsUpdate,
    'chats.delete': handleChatsDelete,
    'contacts.upsert': handleContactsUpsert,
    'contacts.update': handleContactsUpdate,
    'blocklist.set': handleBlocklistSet,
    'blocklist.update': handleBlocklistUpdate,
    call: handleCall,
    'presence.update': handlePresenceUpdate,
  };

  for (const [event, handler] of Object.entries(eventHandlers)) {
    client.ev.on(event, handler);
  }

  logger.debug('Todos os manipuladores de eventos foram registrados.', {
    label: 'ConnectionManager.setupEventHandlers',
    instanceId,
  });
}

async function connect() {
  if (!authState) {
    const errorMessage = 'Estado de autenticação não carregado. Execute loadAuthState() antes de connect().';
    logger.error(errorMessage, {
      label: 'ConnectionManager.connect',
      instanceId,
    });
    throw new Error(errorMessage);
  }

  try {
    const socketConfig = {
      auth: authState.state,
      logger: pino({ level: 'silent' }),
      browser: Browsers.macOS('Desktop'),
      syncFullHistory: true,
      markOnlineOnConnect: false,
      printQRInTerminal: false,
    };

    client = makeWASocket(socketConfig);

    logger.info('Socket do WhatsApp criado com sucesso.', {
      label: 'ConnectionManager.connect',
      instanceId,
    });

    setupEventHandlers();
  } catch (error) {
    logger.error(`Erro ao criar socket do WhatsApp: ${error.message}`, {
      label: 'ConnectionManager.connect',
      instanceId,
      error,
    });
    throw error;
  }
}

async function initialize() {
  logger.info('Iniciando conexão com o WhatsApp...', { label: 'ConnectionManager.initialize', instanceId });
  try {
    // Carrega o estado de autenticação e o atribui à variável authState no escopo do módulo.
    authState = await loadAuthState();
    // A função connect() verificará se authState foi carregado corretamente.
    // Se loadAuthState() falhar e lançar um erro, ele será capturado pelo bloco catch abaixo.
    await connect();
    logger.info('Conexão com o WhatsApp estabelecida com sucesso.', { label: 'ConnectionManager.initialize', instanceId });
  } catch (error) {
    logger.error('Erro ao inicializar a conexão com o WhatsApp.', { label: 'ConnectionManager.initialize', instanceId, error: error });
    throw error;
  }
}

function authFlagExists() {
  try {
    return existsSync(authFlagPath); // Usa a função existsSync importada diretamente
  } catch (error) {
    logger.error(`Erro ao verificar a existência do flag de autenticação em ${authFlagPath}: ${error.message}`, {
      label: 'ConnectionManager.authFlagExists',
      instanceId,
      error,
    });
    return false;
  }
}

function createAuthFlag() {
  writeFileSync(authFlagPath, ''); // Usa a função writeFileSync importada diretamente
}

function shouldReconnect(statusCode) {
  return statusCode !== DisconnectReason.loggedOut && reconnectionAttempts < maxReconnectionAttempts;
}

function calculateNextBackoffDelay() {
  return Math.min(initialBackoffDelayMs * Math.pow(2, reconnectionAttempts - 1), maxBackoffDelayMs);
}

function resetReconnectionState() {
  if (backoffTimer) {
    clearTimeout(backoffTimer);
    backoffTimer = null;
  }
  reconnectionAttempts = 0;
  currentBackoffDelayMs = initialBackoffDelayMs;
  isReconnecting = false;
}

async function reconnectWithBackoff(statusCode) {
  isReconnecting = true;
  reconnectionAttempts++;
  currentBackoffDelayMs = calculateNextBackoffDelay();

  if (backoffTimer) {
    clearTimeout(backoffTimer);
  }

  logger.info(`Tentando reconexão (Tentativa ${reconnectionAttempts}/${maxReconnectionAttempts}) em ${currentBackoffDelayMs}ms...`, {
    label: 'ConnectionManager',
    metricName: 'connection.reconnect.attempt',
    attempt: reconnectionAttempts,
    maxAttempts: maxReconnectionAttempts,
    delayMs: currentBackoffDelayMs,
    statusCode,
    instanceId,
  });

  backoffTimer = setTimeout(async () => {
    try {
      await connect();
      isReconnecting = false;
      backoffTimer = null;
    } catch (err) {
      logger.error(`Tentativa de reconexão falhou: ${err.message}`, {
        label: 'ConnectionManager.reconnectWithBackoff',
        metricName: 'connection.reconnect.failed_attempt',
        attempt: reconnectionAttempts,
        error: err.message,
        stack: err.stack,
        instanceId,
      });
      isReconnecting = false;
      backoffTimer = null;

      if (shouldReconnect(statusCode)) {
        reconnectWithBackoff(statusCode);
      } else {
        handleIrrecoverableDisconnect(statusCode);
      }
    }
  }, currentBackoffDelayMs);
}

function handleIrrecoverableDisconnect(statusCode) {
  logger.error(
    `Desconexão irrecuperável. Código de Status: ${statusCode}.
  ⚠️ A sessão foi encerrada permanentemente (ex.: logout manual ou excesso de falhas).
  ✅ Solução: exclua a pasta de autenticação "${authStatePath}" e reinicie para gerar um novo QR Code.`,
    {
      label: 'ConnectionManager.handleIrrecoverableDisconnect',
      metricName: 'connection.disconnected.irrecoverable',
      statusCode,
      instanceId,
    },
  );
  resetReconnectionState();
  emitEvent('connection:irrecoverable_disconnect', { statusCode, instanceId }, 'connection.update');
}

async function handleConnectionUpdate(update) {
  const { connection, lastDisconnect, qr: qrCodeValue } = update;

  if (qrCodeValue) {
    logger.info('QR Code recebido. Exibindo no terminal...', { label: 'ConnectionManager.handleQRCode', instanceId });
    qrcode.generate(qrCodeValue, { small: true });
    emitEvent('connection:qr_received', { qr: qrCodeValue, instanceId }, 'connection.update');
  }

  if (connection === STATUS.CONNECTED) {
    logger.info('Conexão com o WhatsApp estabelecida com sucesso!', {
      label: 'ConnectionManager',
      metricName: 'connection.established',
      instanceId,
    });
    resetReconnectionState();

    const credsFilePath = path.join(authStatePath, 'creds.json');
    if (existsSync(credsFilePath)) {
      // Usa a função existsSync importada diretamente
      if (!authFlagExists()) {
        try {
          createAuthFlag();
          logger.info(`Flag de autenticação criado em ${authFlagPath}`, {
            label: 'ConnectionManager.createAuthFlag',
            instanceId,
          });
        } catch (err) {
          logger.error(`Falha ao criar o flag de autenticação: ${err.message}`, {
            label: 'ConnectionManager.createAuthFlag',
            instanceId,
            error: err,
          });
        }
      }
    } else {
      logger.warn(`Conexão aberta, mas creds.json não encontrado em ${credsFilePath}. Flag não criado.`, {
        label: 'ConnectionManager.handleConnectionUpdate',
        instanceId,
      });
    }
    emitEvent('connection:opened', { instanceId }, 'connection.update');
  }

  if (connection === STATUS.DISCONNECTED) {
    const statusCode = lastDisconnect?.error?.output?.statusCode ?? 'unknown';
    const reason = DisconnectReason[statusCode] || lastDisconnect?.error?.message || 'Desconhecido';

    logger.warn(`Conexão com o WhatsApp fechada. Motivo: ${reason} (Código: ${statusCode})`, {
      label: 'ConnectionManager',
      metricName: 'connection.closed',
      statusCode,
      reason,
      instanceId,
      error: lastDisconnect?.error,
    });
    emitEvent('connection:closed', { reason, statusCode, instanceId, error: lastDisconnect?.error }, 'connection.update');

    const doReconnect = shouldReconnect(statusCode);
    if (doReconnect && !isReconnecting) {
      reconnectWithBackoff(statusCode);
    } else if (!doReconnect) {
      handleIrrecoverableDisconnect(statusCode);
    }
  }
}

async function handleCredsUpdate() {
  if (!authState) {
    logger.error('Tentativa de salvar credenciais sem authState inicializado.', {
      label: 'ConnectionManager.handleCredsUpdate',
      instanceId,
    });
    return;
  }
  try {
    await authState.saveCreds();
    logger.info('Credenciais de autenticação salvas/atualizadas.', {
      label: 'ConnectionManager.handleCredsUpdate',
      metricName: 'auth.credentials.updated',
      instanceId,
    });
    emitEvent('auth:creds_updated', { instanceId }, 'creds.update');
  } catch (err) {
    logger.error(`❌ Falha ao salvar as credenciais de autenticação: ${err.message}`, {
      label: 'ConnectionManager.handleCredsUpdate',
      metricName: 'auth.credentials.save_failed',
      instanceId,
      error: err,
      stack: err.stack,
    });
  }
}

async function handleMessagesUpsert(data) {
  const { messages, type } = data;
  logger.info(`Recebido(s) ${messages.length} mensagem(ns) no evento 'messages.upsert'. Tipo: ${type}.`, {
    label: 'ConnectionManager.handleMessagesUpsert',
    metricName: 'messages.upsert.recebidas',
    count: messages.length,
    type,
    instanceId,
  });

  for (const msg of messages) {
    const messageContentType = msg.message ? getContentType(msg.message) : null;
    const { key: messageKey } = msg;

    if (messageContentType) {
      logger.debug(`Tipo de conteúdo da mensagem ${messageKey?.id}: ${messageContentType}.`, {
        label: 'ConnectionManager.handleMessagesUpsert',
        messageKey,
        contentType: messageContentType,
        instanceId,
      });
    } else {
      logger.warn(`Não foi possível determinar o tipo de conteúdo para a mensagem ${messageKey?.id}. Pode ser um evento de sistema.`, {
        label: 'ConnectionManager.handleMessagesUpsert',
        messageKey,
        instanceId,
        messageDetails: msg,
      });
    }

    if (messageKey?.remoteJid && messageKey?.id) {
      const enrichedMessage = {
        ...msg,
        messageContentType,
        instanceId,
      };
      emitEvent('message:upsert:received', enrichedMessage, 'messages.upsert');
    } else {
      logger.warn('Mensagem recebida sem chave completa. Ignorada para emissão.', {
        label: 'ConnectionManager.handleMessagesUpsert',
        messageKey,
        instanceId,
      });
    }
    logger.debug(`Conteúdo bruto da mensagem ${messageKey?.id}:`, {
      label: 'ConnectionManager.handleMessagesUpsert',
      messageKey,
      messageDetails: msg,
      instanceId,
    });
  }
}

function validateGroupMetadata(metadata) {
  return metadata && typeof metadata === 'object' && typeof metadata.id === 'string' && metadata.id.endsWith('@g.us');
}

async function updateGroupMetadata(jid, existingMetadata = null, context = '') {
  try {
    if (!jid || !jid.endsWith('@g.us')) {
      logger.warn(`JID inválido fornecido para atualização de metadados de grupo: ${jid}${context ? ` (${context})` : ''}.`, {
        label: 'ConnectionManager.updateGroupMetadata',
        jid,
        context,
        instanceId,
      });
      return null;
    }

    let finalMetadata = existingMetadata;
    if (!finalMetadata && client) {
      finalMetadata = await client.groupMetadata(jid);
    }

    if (!validateGroupMetadata(finalMetadata)) {
      logger.warn(`Metadados de grupo inválidos ou não obtidos para ${jid} no contexto '${context}'.`, {
        label: 'ConnectionManager.updateGroupMetadata',
        jid,
        metadataAttempted: finalMetadata,
        context,
        instanceId,
      });
      return null;
    }

    emitEvent('group:metadata:updated', { jid, metadata: finalMetadata, instanceId, context }, `group.metadata.${context}`);
    return finalMetadata;
  } catch (error) {
    logger.error(`Erro ao atualizar metadados do grupo ${jid}${context ? ` (${context})` : ''}: ${error.message}.`, {
      label: 'ConnectionManager.updateGroupMetadata',
      jid,
      error: error.message,
      stack: error.stack,
      context,
      instanceId,
    });
    return null;
  }
}

async function handleGroupsUpdate(updates) {
  logger.debug(`Evento 'groups.update' recebido. Número de atualizações: ${updates.length}.`, {
    label: 'ConnectionManager.handleGroupsUpdate',
    count: updates.length,
    instanceId,
  });
  for (const groupUpdate of updates) {
    const jid = groupUpdate.id;
    if (jid && jid.endsWith('@g.us')) {
      await updateGroupMetadata(jid, groupUpdate, 'groups.update');
    }
  }
}

async function handleGroupParticipantsUpdate(event) {
  const { id: jid, action, participants } = event;
  logger.debug(`Evento 'group-participants.update' recebido para o grupo ${jid}. Ação: ${action}. Participantes: ${participants.join(', ')}.`, {
    label: 'ConnectionManager.handleGroupParticipantsUpdate',
    jid,
    action,
    participants,
    instanceId,
  });
  await updateGroupMetadata(jid, null, 'group-participants.update');
}

async function handleGroupsUpsert(groupsMetadata) {
  logger.debug(`Evento 'groups.upsert' recebido. Número de grupos: ${groupsMetadata.length}.`, {
    label: 'ConnectionManager.handleGroupsUpsert',
    count: groupsMetadata.length,
    instanceId,
  });
  const validGroupsToUpsert = groupsMetadata.filter(validateGroupMetadata);

  if (validGroupsToUpsert.length > 0) {
    validGroupsToUpsert.forEach((metadata) => {
      emitEvent('group:metadata:updated', { jid: metadata.id, metadata, instanceId, context: 'groups.upsert' }, 'groups.upsert');
    });
    logger.info(` ${validGroupsToUpsert.length} metadados de grupo de 'groups.upsert' emitidos via evento.`, {
      label: 'ConnectionManager.handleGroupsUpsert',
      metricName: 'group.event.emitted_batch',
      count: validGroupsToUpsert.length,
      instanceId,
    });
  } else if (groupsMetadata.length > 0) {
    logger.info(`'groups.upsert' recebido com ${groupsMetadata.length} grupos, mas nenhum era válido para emissão.`, {
      label: 'ConnectionManager.handleGroupsUpsert',
      instanceId,
    });
  }
}

async function handleMessagingHistorySet(data) {
  const { chats, contacts, messages } = data;
  logger.info(` Evento 'messaging-history.set' recebido. Chats: ${chats.length}, Contatos: ${contacts.length}, Mensagens: ${messages.length}.`, {
    label: 'ConnectionManager.handleMessagingHistorySet',
    metricName: 'messaging_history.set.recebido',
    counts: { chats: chats.length, contacts: contacts.length, messages: messages.length },
    instanceId,
  });

  for (const chat of chats) {
    if (chat.id) {
      emitEvent('history:chat:set', { ...chat, instanceId }, 'messaging-history.set.chat');
    }
  }
  for (const contact of contacts) {
    if (contact.id) {
      logger.debug(`Contato do histórico recebido: ${contact.id}.`, { label: 'ConnectionManager.handleMessagingHistorySet', contactId: contact.id, instanceId });
      emitEvent('history:contact:set', { ...contact, instanceId }, 'messaging-history.set.contact');
    }
  }
  for (const msg of messages) {
    logger.debug(`Mensagem do histórico recebida: ${msg.key?.id} de ${msg.key?.remoteJid}.`, { label: 'ConnectionManager.handleMessagingHistorySet', messageKey: msg.key, instanceId });
    if (msg.key && msg.key.remoteJid && msg.key.id) {
      const messageContentType = msg.message ? getContentType(msg.message) : null;
      const messageToEmit = { ...msg, receipts: msg.receipts || {}, messageContentType, instanceId };
      emitEvent('history:message:set', messageToEmit, 'messaging-history.set.message');
    } else {
      logger.warn('Mensagem do histórico recebida sem chave completa.', { label: 'ConnectionManager.handleMessagingHistorySet', message: msg, instanceId });
    }
  }
}

function handleMessagesUpdate(updates) {
  logger.info(` Evento 'messages.update' recebido. Número de atualizações: ${updates.length}.`, {
    label: 'ConnectionManager.handleMessagesUpdate',
    metricName: 'messages.update.recebido',
    count: updates.length,
    instanceId,
  });
  updates.forEach((update) => {
    logger.debug(`Detalhes da atualização da mensagem: Chave=${update.key?.id}, JID=${update.key?.remoteJid}.`, {
      label: 'ConnectionManager.handleMessagesUpdate',
      messageUpdate: update,
      updateContent: update.update,
      instanceId,
    });
    emitEvent('message:updated', { ...update, instanceId }, 'messages.update');
  });
}

function handleMessagesDelete(deletion) {
  logger.info(` Evento 'messages.delete' recebido.`, {
    label: 'ConnectionManager.handleMessagesDelete',
    metricName: 'messages.delete.recebido',
    deletionDetails: deletion,
    instanceId,
  });
  emitEvent('message:deleted', { ...deletion, instanceId }, 'messages.delete');
}

function handleMessagesReaction(reactions) {
  logger.info(` Evento 'messages.reaction' recebido. Número de reações: ${reactions.length}.`, {
    label: 'ConnectionManager.handleMessagesReaction',
    metricName: 'messages.reaction.recebido',
    count: reactions.length,
    instanceId,
  });
  reactions.forEach((reaction) => {
    logger.debug(`Detalhes da reação: ChaveMsg=${reaction.key?.id}, JID=${reaction.key?.remoteJid}, TextoReacao=${reaction.reaction.text}.`, {
      label: 'ConnectionManager.handleMessagesReaction',
      reaction,
      instanceId,
    });
    emitEvent('message:reaction', { ...reaction, instanceId }, 'messages.reaction');
  });
}

async function handleMessageReceiptUpdate(receipts) {
  logger.info(` Evento 'message-receipt.update' recebido. Número de recibos: ${receipts.length}.`, {
    label: 'ConnectionManager.handleMessageReceiptUpdate',
    metricName: 'message_receipt.update.recebido',
    count: receipts.length,
    instanceId,
  });
  for (const receiptUpdate of receipts) {
    const { key, receipt } = receiptUpdate;
    if (key && key.remoteJid && key.id && receipt && receipt.userJid) {
      const timestamp = receipt.receiptTimestamp || receipt.readTimestamp || receipt.playedTimestamp;
      const emittedReceipt = { key, userJid: receipt.userJid, type: receipt.type, timestamp, instanceId };
      emitEvent('message:receipt:updated', emittedReceipt, 'message-receipt.update');
    }
    logger.debug(`Detalhes do Recibo: ChaveMsg=${key?.id}, JID=${key?.remoteJid}, Status=${receipt?.type}, UserJid=${receipt?.userJid}.`, { label: 'ConnectionManager.handleMessageReceiptUpdate', receipt: receiptUpdate, instanceId });
  }
}

async function handleChatsUpsert(chats) {
  logger.info(` Evento 'chats.upsert' recebido. Número de chats: ${chats.length}.`, {
    label: 'ConnectionManager.handleChatsUpsert',
    metricName: 'chats.upsert.recebido',
    count: chats.length,
    instanceId,
  });
  const validChats = chats.filter((chat) => chat.id);
  if (validChats.length > 0) {
    validChats.forEach((chat) => {
      emitEvent('chat:upserted', { ...chat, instanceId }, 'chats.upsert');
    });
    logger.info(` ${validChats.length} chats de 'chats.upsert' emitidos via evento.`, {
      label: 'ConnectionManager.handleChatsUpsert',
      count: validChats.length,
      instanceId,
    });
  } else if (chats.length > 0) {
    logger.info(`'chats.upsert' recebido com ${chats.length} chats, mas nenhum era válido para emissão.`, {
      label: 'ConnectionManager.handleChatsUpsert',
      count: chats.length,
      instanceId,
    });
  }
}

async function handleChatsUpdate(updates) {
  logger.info(` Evento 'chats.update' recebido. Número de atualizações: ${updates.length}.`, {
    label: 'ConnectionManager.handleChatsUpdate',
    metricName: 'chats.update.recebido',
    count: updates.length,
    instanceId,
  });
  const validChatUpdates = updates.filter((chatUpdate) => chatUpdate.id);
  if (validChatUpdates.length > 0) {
    validChatUpdates.forEach((update) => {
      emitEvent('chat:updated', { ...update, instanceId }, 'chats.update');
    });
    logger.info(` ${validChatUpdates.length} atualizações de chat de 'chats.update' emitidas via evento.`, {
      label: 'ConnectionManager.handleChatsUpdate',
      count: validChatUpdates.length,
      instanceId,
    });
  } else if (updates.length > 0) {
    logger.info(`'chats.update' recebido com ${updates.length} atualizações, mas nenhuma era válida para emissão.`, {
      label: 'ConnectionManager.handleChatsUpdate',
      count: updates.length,
      instanceId,
    });
  }
}

async function handleChatsDelete(jids) {
  logger.info(` Evento 'chats.delete' recebido. Número de JIDs: ${jids.length}.`, {
    label: 'ConnectionManager.handleChatsDelete',
    metricName: 'chats.delete.recebido',
    count: jids.length,
    instanceId,
  });
  for (const jid of jids) {
    logger.debug(`Chat ${jid} marcado para exclusão. Emitindo evento.`, { label: 'ConnectionManager.handleChatsDelete', jid, instanceId });
    emitEvent('chat:deleted', { jid, instanceId }, 'chats.delete');
  }
}

async function handleContactsUpsert(contacts) {
  logger.info(` Evento 'contacts.upsert' recebido. Número de contatos: ${contacts.length}.`, {
    label: 'ConnectionManager.handleContactsUpsert',
    metricName: 'contacts.upsert.recebido',
    count: contacts.length,
    instanceId,
  });
  for (const contact of contacts) {
    if (contact.id) {
      logger.debug(`Upsert de contato recebido: ${contact.id}.`, { label: 'ConnectionManager.handleContactsUpsert', contactId: contact.id, instanceId });
      emitEvent('contact:upserted', { ...contact, instanceId }, 'contacts.upsert');
    }
  }
}

async function handleContactsUpdate(updates) {
  logger.info(` Evento 'contacts.update' recebido. Número de atualizações: ${updates.length}.`, {
    label: 'ConnectionManager.handleContactsUpdate',
    metricName: 'contacts.update.recebido',
    count: updates.length,
    instanceId,
  });
  for (const contactUpdate of updates) {
    if (contactUpdate.id) {
      logger.debug(`Atualização de contato recebida: ${contactUpdate.id}.`, { label: 'ConnectionManager.handleContactsUpdate', contactId: contactUpdate.id, update: contactUpdate, instanceId });
      emitEvent('contact:updated', { ...contactUpdate, instanceId }, 'contacts.update');
    }
  }
}

function handleBlocklistSet(data) {
  logger.info(` Evento 'blocklist.set' recebido. Contagem: ${data.blocklist?.length || 0}.`, {
    label: 'ConnectionManager.handleBlocklistSet',
    metricName: 'blocklist.set.recebido',
    count: data.blocklist?.length || 0,
    instanceId,
  });
  emitEvent('blocklist:set', { ...data, instanceId }, 'blocklist.set');
}

function handleBlocklistUpdate(data) {
  logger.info(` Evento 'blocklist.update' recebido. Ação: ${data.action}, Contagem de JIDs: ${data.jids?.length || 0}.`, {
    label: 'ConnectionManager.handleBlocklistUpdate',
    metricName: 'blocklist.update.recebido',
    action: data.action,
    jids: data.jids,
    count: data.jids?.length || 0,
    instanceId,
  });
  emitEvent('blocklist:update', { ...data, instanceId }, 'blocklist.update');
}

function handleCall(callEvents) {
  const callEvent = callEvents && callEvents.length > 0 ? callEvents[0] : null;
  logger.info(` Evento 'call' recebido. Status: ${callEvent?.status}, De: ${callEvent?.from}.`, {
    label: 'ConnectionManager.handleCall',
    metricName: 'call.event.recebido',
    callData: callEvent,
    instanceId,
  });
  if (callEvent) {
    emitEvent('call:received', { ...callEvent, instanceId }, 'call');
  }
}

function handlePresenceUpdate(data) {
  logger.debug(`Evento 'presence.update' recebido: JID=${data.id}.`, {
    label: 'ConnectionManager.handlePresenceUpdate',
    presenceData: data,
    instanceId,
  });
  emitEvent('presence:update', { ...data, instanceId }, 'presence.update');
}

module.exports = {
  initialize,
  getEventEmitter,
  getClient,
};
