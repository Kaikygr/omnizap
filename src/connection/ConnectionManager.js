const { default: makeWASocket, Browsers, useMultiFileAuthState, DisconnectReason, getContentType } = require('baileys');
const pino = require('pino');
const path = require('path');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const { cleanEnv, num, str } = require('envalid');
const Redis = require('ioredis');

const logger = require('../utils/logs/logger');

const env = cleanEnv(process.env, {
  BACKOFF_INITIAL_DELAY_MS: num({ default: 5000 }),
  BACKOFF_MAX_DELAY_MS: num({ default: 60000 }),
  AUTH_STATE_PATH: str({ default: path.join(__dirname, 'temp', 'auth_state_minimal') }),
  REDIS_HOST: str({ default: 'localhost' }),
  REDIS_PORT: num({ default: 6379 }),
  REDIS_PASSWORD: str({ default: '' }),
  REDIS_DB: num({ default: 0 }),
});

const REDIS_PREFIX_GROUP = 'group:';
const REDIS_PREFIX_CHAT = 'chat:';
const REDIS_PREFIX_CONTACT = 'contact:';
const REDIS_PREFIX_MESSAGE = 'message:';

const REDIS_TTL_METADATA_SHORT = 3600;
const REDIS_TTL_METADATA_LONG = 24 * 3600;
const REDIS_TTL_MESSAGE = 7 * 24 * 3600;
const REDIS_TTL_RECEIPT = 7 * 24 * 3600;

/**
 * Gerencia a conexão com o WhatsApp, incluindo lógica de reconexão com backoff exponencial.
 */
class ConnectionManager {
  /**
   * @param {number} initialBackoffDelayMs - Atraso inicial para reconexão em milissegundos.
   * @param {number} maxBackoffDelayMs - Atraso máximo para reconexão em milissegundos.
   * @param {string} authStatePath - Caminho para armazenar o estado de autenticação.
   * @param {import('../database/MySQLDBManager').MySQLDBManagerClass} mysqlDbManager - Instância do MySQLDBManager.
   */
  constructor(mysqlDbManager, initialBackoffDelayMs = env.BACKOFF_INITIAL_DELAY_MS, maxBackoffDelayMs = env.BACKOFF_MAX_DELAY_MS, authStatePath = env.AUTH_STATE_PATH) {
    this.initialBackoffDelayMs = initialBackoffDelayMs;
    this.maxBackoffDelayMs = maxBackoffDelayMs;
    this.mysqlDbManager = mysqlDbManager;
    this.authStatePath = authStatePath;
    this.currentBackoffDelayMs = initialBackoffDelayMs;
    this.client = null;
    this.reconnectionAttempts = 0;
    this.maxReconnectionAttempts = 10;
    this.isReconnecting = false;

    this.initializeRedisClient();
  }

  /**
   * Inicializa o cliente Redis.
   */
  initializeRedisClient() {
    this.redisClient = new Redis({
      host: env.REDIS_HOST,
      port: env.REDIS_PORT,
      password: env.REDIS_PASSWORD || undefined,
      db: env.REDIS_DB,
    });

    this.redisClient.on('connect', () => {
      logger.info('Conectado ao servidor Redis com sucesso.', { label: 'RedisClient' });
    });

    this.redisClient.on('error', (err) => {
      logger.error('Erro na conexão com o Redis:', { label: 'RedisClient', message: err.message, stack: err.stack });
    });
  }
  /**
   * Initializes the connection to WhatsApp.
   */
  async initialize() {
    logger.info('Iniciando conexão com o WhatsApp...', { label: 'ConnectionManager' });
    await this.loadAuthState();
    await this.connect();
  }

  /**
   * Carrega o estado de autenticação do diretório especificado.
   */
  async loadAuthState() {
    if (!fs.existsSync(this.authStatePath)) {
      logger.info(`Diretório de estado de autenticação não encontrado em ${this.authStatePath}. Criando...`, { label: 'ConnectionManager' });
      try {
        fs.mkdirSync(this.authStatePath, { recursive: true });
        logger.info(`Diretório ${this.authStatePath} criado com sucesso.`, { label: 'ConnectionManager' });
      } catch (mkdirError) {
        logger.error(`Falha ao criar o diretório ${this.authStatePath}: ${mkdirError.message}`, { label: 'ConnectionManager' });
        throw mkdirError;
      }
    }
    this.auth = await useMultiFileAuthState(this.authStatePath);
  }

  /**
   * Conecta-se ao WhatsApp usando o estado de autenticação carregado.
   */
  async connect() {
    const socketConfig = {
      auth: this.auth.state,
      logger: pino({ level: 'silent' }),
      browser: Browsers.macOS('Desktop'),
      syncFullHistory: true,
      markOnlineOnConnect: false,
      printQRInTerminal: false,
      cachedGroupMetadata: async (jid) => {
        const cacheKey = `group:${jid}`;
        try {
          const data = await this.redisClient.get(`${REDIS_PREFIX_GROUP}${jid}`);
          if (data) {
            logger.debug(`Cache HIT para metadados do grupo ${jid}`, { label: 'RedisCache' });
            return JSON.parse(data);
          }
          logger.debug(`Cache MISS para metadados do grupo ${jid}`, { label: 'RedisCache' });
        } catch (error) {
          logger.error(`Erro ao ler metadados do grupo ${jid} do cache Redis: ${error.message}`, { label: 'RedisCache', error });
        }
        return undefined;
      },
    };
    this.client = makeWASocket(socketConfig);
    this.setupEventHandlers();
  }

  /**
   * Configura os manipuladores de eventos para o cliente WhatsApp.
   */
  setupEventHandlers() {
    this.client.ev.on('connection.update', this.handleConnectionUpdate.bind(this));
    this.client.ev.on('creds.update', this.handleCredsUpdate.bind(this));
    this.client.ev.on('messages.upsert', this.handleMessagesUpsert.bind(this));
    this.client.ev.on('groups.update', this.handleGroupsUpdate.bind(this));
    this.client.ev.on('group-participants.update', this.handleGroupParticipantsUpdate.bind(this));
    this.client.ev.on('groups.upsert', this.handleGroupsUpsert.bind(this));

    this.client.ev.on('messaging-history.set', this.handleMessagingHistorySet.bind(this));
    this.client.ev.on('messages.update', this.handleMessagesUpdate.bind(this));
    this.client.ev.on('messages.delete', this.handleMessagesDelete.bind(this));
    this.client.ev.on('messages.reaction', this.handleMessagesReaction.bind(this));
    this.client.ev.on('message-receipt.update', this.handleMessageReceiptUpdate.bind(this));

    this.client.ev.on('chats.upsert', this.handleChatsUpsert.bind(this));
    this.client.ev.on('chats.update', this.handleChatsUpdate.bind(this));
    this.client.ev.on('chats.delete', this.handleChatsDelete.bind(this));

    this.client.ev.on('contacts.upsert', this.handleContactsUpsert.bind(this));
    this.client.ev.on('contacts.update', this.handleContactsUpdate.bind(this));

    this.client.ev.on('blocklist.set', this.handleBlocklistSet.bind(this));
    this.client.ev.on('blocklist.update', this.handleBlocklistUpdate.bind(this));
    this.client.ev.on('call', this.handleCall.bind(this));
    this.client.ev.on('presence.update', this.handlePresenceUpdate.bind(this));
    logger.debug('Todos os manipuladores de eventos foram registrados.', { label: 'ConnectionManager' });
  }

  /**
   * Manipula atualizações de conexão do cliente WhatsApp.
   * @param {import('@adiwajshing/baileys').ConnectionState} update - O objeto de atualização da conexão.
   */
  async handleConnectionUpdate(update) {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      logger.info('QR code recebido. Por favor, escaneie com seu WhatsApp:');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'open') {
      logger.info('Conexão com o WhatsApp estabelecida com sucesso!', { label: 'ConnectionManager' });
      this.resetReconnectionState();
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      logger.warn(`Conexão fechada. Razão: ${DisconnectReason[statusCode] || 'Desconhecida'} (Código: ${statusCode})`, { label: 'ConnectionManager' });

      const shouldReconnect = this.shouldReconnect(statusCode);
      if (shouldReconnect && !this.isReconnecting) {
        this.reconnectWithBackoff(statusCode);
      } else if (!shouldReconnect) {
        this.handleIrrecoverableDisconnect(statusCode);
      }
    }
  }

  /**
   * Determina se a reconexão deve ser tentada com base no motivo da desconexão.
   * @param {number} statusCode - O código de status da desconexão.
   * @returns {boolean} Verdadeiro se a reconexão deve ser tentada, falso caso contrário.
   */
  shouldReconnect(statusCode) {
    return statusCode !== DisconnectReason.loggedOut && this.reconnectionAttempts < this.maxReconnectionAttempts;
  }

  /**
   * Reconecta ao WhatsApp com backoff exponencial.
   * @param {number} statusCode - O código de status da desconexão.
   */
  async reconnectWithBackoff(statusCode) {
    this.isReconnecting = true;
    this.reconnectionAttempts++;
    this.currentBackoffDelayMs = Math.min(this.initialBackoffDelayMs * Math.pow(2, this.reconnectionAttempts - 1), this.maxBackoffDelayMs);

    logger.info(`Tentando reconectar (Tentativa ${this.reconnectionAttempts}/${this.maxReconnectionAttempts}) em ${this.currentBackoffDelayMs}ms...`, { label: 'ConnectionManager' });
    logger.debug(`Código de desconexão: ${statusCode}`, { label: 'ConnectionManager' });

    setTimeout(async () => {
      try {
        await this.connect();
        this.isReconnecting = false;
      } catch (err) {
        logger.error(`Tentativa de reconexão falhou: ${err.message}`, { label: 'ConnectionManager' });
        this.isReconnecting = false;
        if (this.shouldReconnect(statusCode)) {
          this.reconnectWithBackoff(statusCode);
        } else {
          this.handleIrrecoverableDisconnect(statusCode);
        }
      }
    }, this.currentBackoffDelayMs);
  }

  /**
   * Manipula desconexão irrecuperável (ex: logout).
   * @param {number} statusCode - O código de status da desconexão.
   */
  handleIrrecoverableDisconnect(statusCode) {
    logger.error(`Deslogado ou alcançou o número máximo de tentativas de reconexão. Por favor, remova o diretório 'auth_info_baileys' e reinicie a aplicação para gerar um novo QR code. (Código: ${statusCode})`, { label: 'ConnectionManager' });
    this.resetReconnectionState();
  }

  /**
   * Reseta o estado de reconexão.
   */
  resetReconnectionState() {
    this.reconnectionAttempts = 0;
    this.currentBackoffDelayMs = this.initialBackoffDelayMs;
    this.isReconnecting = false;
  }

  /**
   * Manipula a atualização de credenciais.
   */
  async handleCredsUpdate() {
    await this.auth.saveCreds();
    logger.info('Credenciais de autenticação salvas/atualizadas.', { label: 'ConnectionManager' });
  }

  /**
   * Manipula mensagens novas/atualizadas.
   * @param {import('@adiwajshing/baileys').BaileysEventMap['messages.upsert']} data - Os dados do evento de atualização de mensagens.
   */
  async handleMessagesUpsert(data) {
    const { messages, type } = data;
    logger.debug(`Evento 'messages.upsert' recebido. Número de mensagens: ${messages.length}. Tipo: ${type}`, { label: 'ConnectionManager', count: messages.length, type });

    for (const msg of messages) {
      const messageContentType = msg.message ? getContentType(msg.message) : null;

      if (messageContentType) {
        logger.debug(`Tipo de conteúdo da mensagem ${msg.key?.id}: ${messageContentType}`, { label: 'ConnectionManager', messageKey: msg.key, contentType: messageContentType });
      } else {
        logger.debug(`Não foi possível determinar o tipo de conteúdo para a mensagem ${msg.key?.id}`, { label: 'ConnectionManager', messageKey: msg.key });
      }

      if (msg.key && msg.key.remoteJid && msg.key.id) {
        const cacheKey = `${REDIS_PREFIX_MESSAGE}${msg.key.remoteJid}:${msg.key.id}`;
        try {
          const messageToStore = { ...msg, receipts: {}, messageContentType }; // Store the determined content type
          await this.redisClient.set(cacheKey, JSON.stringify(messageToStore), 'EX', REDIS_TTL_MESSAGE);
          logger.info(`Mensagem ${msg.key.id} de ${msg.key.remoteJid} salva no Redis.`, { label: 'RedisCache', messageKey: msg.key });

          if (this.mysqlDbManager) {
            await this.mysqlDbManager.upsertMessage(messageToStore);
          }
        } catch (error) {
          logger.error(`Erro ao salvar mensagem ${msg.key.id} no Redis ou MySQL: ${error.message}`, { label: 'SyncError', messageKey: msg.key, error: error.message });
        }
      } else {
        logger.warn('Mensagem recebida sem chave completa, não foi possível salvar no cache.', { label: 'ConnectionManager', message: msg });
      }
      logger.debug(`Conteúdo da mensagem: ${JSON.stringify(msg)}`, { label: 'ConnectionManager', messageDetails: msg });
    }
  }

  /**
   * Manipula atualizações de grupos.
   * @param {import('@adiwajshing/baileys').BaileysEventMap['groups.update']} updates - Os dados do evento de atualização de grupos.
   */
  handleGroupsUpdate(updates) {
    logger.debug(`Evento 'groups.update' recebido. Número de atualizações: ${updates.length}`, { label: 'ConnectionManager', count: updates.length });
    updates.forEach(async (groupUpdate) => {
      const jid = groupUpdate.id;
      if (jid) {
        try {
          const metadata = await this.client.groupMetadata(jid);
          if (metadata) {
            const cacheKey = `${REDIS_PREFIX_GROUP}${jid}`;
            await this.redisClient.set(cacheKey, JSON.stringify(metadata), 'EX', REDIS_TTL_METADATA_SHORT);
            logger.info(`Metadados do grupo ${jid} atualizados no Redis.`, { label: 'RedisCache' });

            if (this.mysqlDbManager) {
              await this.mysqlDbManager.upsertGroup(metadata);
            }
          }
        } catch (error) {
          logger.error(`Erro ao atualizar metadados do grupo ${jid} no Redis ou MySQL (groups.update): ${error.message}`, { label: 'SyncError', jid, error: error.message });
        }
      }
    });
  }

  /**
   * Manipula atualizações de participantes de grupos.
   * @param {import('@adiwajshing/baileys').BaileysEventMap['group-participants.update']} event - Os dados do evento de atualização de participantes de grupos.
   */
  async handleGroupParticipantsUpdate(event) {
    const { id: jid, action, participants } = event;
    logger.debug(`Evento 'group-participants.update' recebido para o grupo ${jid}. Ação: ${action}. Participantes: ${participants.join(', ')}`, { label: 'ConnectionManager', jid, action });
    try {
      const metadata = await this.client.groupMetadata(jid);
      if (metadata) {
        const cacheKey = `${REDIS_PREFIX_GROUP}${jid}`;
        await this.redisClient.set(cacheKey, JSON.stringify(metadata), 'EX', REDIS_TTL_METADATA_SHORT);
        logger.info(`Metadados do grupo ${jid} atualizados no Redis (participantes).`, { label: 'RedisCache' });

        if (this.mysqlDbManager) {
          await this.mysqlDbManager.upsertGroup(metadata); // upsertGroup lida com participantes
        }
      }
    } catch (error) {
      logger.error(`Erro ao obter ou salvar metadados do grupo ${jid} no Redis ou MySQL (group-participants.update): ${error.message}`, { label: 'SyncError', jid, error: error.message });
    }
  }

  /**
   * Manipula a inserção/atualização de grupos (quando o usuário entra em um novo grupo ou sincronização inicial).
   * @param {Array<import('@adiwajshing/baileys').GroupMetadata>} groups - Array de metadados de grupo.
   */
  async handleGroupsUpsert(groups) {
    logger.debug(`Evento 'groups.upsert' recebido. Número de grupos: ${groups.length}`, { label: 'ConnectionManager', count: groups.length });
    for (const groupMetadata of groups) {
      const jid = groupMetadata.id;
      if (jid) {
        try {
          const cacheKey = `${REDIS_PREFIX_GROUP}${jid}`;
          await this.redisClient.set(cacheKey, JSON.stringify(groupMetadata), 'EX', REDIS_TTL_METADATA_SHORT);
          logger.info(`Metadados do grupo ${jid} (upsert) salvos no Redis.`, { label: 'RedisCache', jid });

          if (this.mysqlDbManager) {
            await this.mysqlDbManager.upsertGroup(groupMetadata);
          }
        } catch (error) {
          logger.error(`Erro ao salvar metadados do grupo ${jid} (upsert) no Redis ou MySQL: ${error.message}`, { label: 'SyncError', jid, error: error.message });
        }
      }
    }
  }

  /**
   * Manipula o evento de conjunto de histórico de mensagens.
   * @param {import('@adiwajshing/baileys').BaileysEventMap['messaging-history.set']} data
   */
  async handleMessagingHistorySet(data) {
    const { chats, contacts, messages } = data;
    logger.info(`Evento 'messaging-history.set' recebido. Chats: ${chats.length}, Contatos: ${contacts.length}, Mensagens: ${messages.length}`, { label: 'ConnectionManager', counts: { chats: chats.length, contacts: contacts.length, messages: messages.length } });

    for (const chat of chats) {
      if (chat.id) {
        try {
          const cacheKey = `${REDIS_PREFIX_CHAT}${chat.id}`;
          await this.redisClient.set(cacheKey, JSON.stringify(chat), 'EX', REDIS_TTL_METADATA_SHORT);
          logger.debug(`Chat ${chat.id} do histórico salvo no Redis.`, { label: 'RedisCache', jid: chat.id });

          if (this.mysqlDbManager) {
            await this.mysqlDbManager.upsertChat(chat);
          }
        } catch (error) {
          logger.error(`Erro ao salvar chat ${chat.id} do histórico no Redis ou MySQL: ${error.message}`, { label: 'SyncError', jid: chat.id, error: error.message });
        }
      }
    }

    for (const contact of contacts) {
      if (contact.id) {
        try {
          const cacheKey = `${REDIS_PREFIX_CONTACT}${contact.id}`;
          await this.redisClient.set(cacheKey, JSON.stringify(contact), 'EX', REDIS_TTL_METADATA_LONG);
          logger.debug(`Contato ${contact.id} do histórico salvo no Redis.`, { label: 'RedisCache', jid: contact.id });

          if (this.mysqlDbManager) {
            await this.mysqlDbManager.upsertContact(contact);
          }
        } catch (error) {
          logger.error(`Erro ao salvar contato ${contact.id} do histórico no Redis ou MySQL: ${error.message}`, { label: 'SyncError', jid: contact.id, error: error.message });
        }
      }
    }

    for (const msg of messages) {
      logger.debug(`Mensagem do histórico recebida: ${msg.key?.id} de ${msg.key?.remoteJid}`, { label: 'ConnectionManager', messageKey: msg.key });
      if (msg.key && msg.key.remoteJid && msg.key.id) {
        const messageContentType = msg.message ? getContentType(msg.message) : null;
        const cacheKey = `${REDIS_PREFIX_MESSAGE}${msg.key.remoteJid}:${msg.key.id}`;
        try {
          const messageToStore = { ...msg, receipts: msg.receipts || {}, messageContentType };
          await this.redisClient.set(cacheKey, JSON.stringify(messageToStore), 'EX', REDIS_TTL_MESSAGE);
          logger.info(`Mensagem do histórico ${msg.key.id} salva no Redis.`, { label: 'RedisCache', messageKey: msg.key });

          if (this.mysqlDbManager) {
            await this.mysqlDbManager.upsertMessage(messageToStore);
          }
        } catch (error) {
          logger.error(`Erro ao salvar mensagem do histórico ${msg.key.id} no Redis ou MySQL: ${error.message}`, { label: 'SyncError', messageKey: msg.key, error: error.message });
        }
      } else {
        logger.warn('Mensagem do histórico recebida sem chave completa, não foi possível salvar.', { label: 'ConnectionManager', message: msg });
      }
    }
  }
  /**
   * Manipula atualizações de mensagens.
   * @param {Array<import('@adiwajshing/baileys').WAMessageUpdate>} updates
   */
  handleMessagesUpdate(updates) {
    logger.debug(`Evento 'messages.update' recebido. Número de atualizações: ${updates.length}`, { label: 'ConnectionManager', count: updates.length });
    updates.forEach((update) => {
      logger.debug(`Atualização de mensagem: Chave=${update.key?.id}, JID=${update.key?.remoteJid}, Update=${JSON.stringify(update.update)}`, { label: 'ConnectionManager', messageUpdate: update });
    });
  }

  /**
   * Manipula exclusão de mensagens.
   * @param {import('@adiwajshing/baileys').BaileysEventMap['messages.delete']} deletion
   */
  handleMessagesDelete(deletion) {
    logger.debug(`Evento 'messages.delete' recebido: ${JSON.stringify(deletion)}`, { label: 'ConnectionManager', deletion });
  }

  /**
   * Manipula reações a mensagens.
   * @param {import('@adiwajshing/baileys').BaileysEventMap['messages.reaction']} reactions
   */
  handleMessagesReaction(reactions) {
    logger.debug(`Evento 'messages.reaction' recebido. Número de reações: ${reactions.length}`, { label: 'ConnectionManager', count: reactions.length });
    reactions.forEach((reaction) => {
      logger.debug(`Reação: ChaveMsg=${reaction.key?.id}, JID=${reaction.key?.remoteJid}, Reação=${reaction.reaction.text}`, { label: 'ConnectionManager', reaction });
    });
  }

  /**
   * Manipula atualizações de recibo de mensagem.
   * @param {Array<import('@adiwajshing/baileys').MessageReceiptUpdate>} receipts
   */
  async handleMessageReceiptUpdate(receipts) {
    logger.debug(`Evento 'message-receipt.update' recebido. Número de recibos: ${receipts.length}`, { label: 'ConnectionManager', count: receipts.length });
    for (const receiptUpdate of receipts) {
      const { key, receipt } = receiptUpdate;
      if (key && key.remoteJid && key.id && receipt && receipt.userJid) {
        const messageCacheKey = `${REDIS_PREFIX_MESSAGE}${key.remoteJid}:${key.id}`;
        try {
          const messageJSON = await this.redisClient.get(messageCacheKey);
          if (messageJSON) {
            const messageData = JSON.parse(messageJSON);
            messageData.receipts = messageData.receipts || {};
            messageData.receipts[receipt.userJid] = {
              type: receipt.type,
              timestamp: receipt.receiptTimestamp || receipt.readTimestamp || receipt.playedTimestamp,
            };
            const ttl = await this.redisClient.ttl(messageCacheKey);
            if (ttl > 0) {
              await this.redisClient.set(messageCacheKey, JSON.stringify(messageData), 'EX', ttl);
            } else {
              // Se o TTL expirou ou não existe, define um novo (ou o padrão de mensagem)
              await this.redisClient.set(messageCacheKey, JSON.stringify(messageData), 'EX', REDIS_TTL_MESSAGE);
            }
            logger.info(`Recibo para mensagem ${key.id} (usuário ${receipt.userJid}, tipo ${receipt.type}) atualizado no Redis.`, { label: 'RedisCache', messageKey: key, userJid: receipt.userJid, receiptType: receipt.type });

            if (this.mysqlDbManager) {
              const timestamp = receipt.receiptTimestamp || receipt.readTimestamp || receipt.playedTimestamp;
              await this.mysqlDbManager.upsertMessageReceipt(key, receipt.userJid, receipt.type, timestamp);
            }
          } else {
            logger.warn(`Mensagem ${key.id} não encontrada no cache para atualizar recibo.`, { label: 'RedisCache', messageKey: key });
          }
        } catch (error) {
          logger.error(`Erro ao processar recibo para mensagem ${key.id} no Redis ou MySQL: ${error.message}`, { label: 'SyncError', messageKey: key, error: error.message });
        }
      }
      logger.debug(`Detalhes do Recibo: ChaveMsg=${key?.id}, JID=${key?.remoteJid}, Status=${receipt?.type}, UserJid=${receipt?.userJid}`, { label: 'ConnectionManager', receipt: receiptUpdate });
    }
  }

  /**
   * Manipula inserção/atualização de chats.
   * @param {Array<import('@adiwajshing/baileys').Chat>} chats
   */
  async handleChatsUpsert(chats) {
    logger.debug(`Evento 'chats.upsert' recebido. Número de chats: ${chats.length}`, { label: 'ConnectionManager', count: chats.length });
    for (const chat of chats) {
      if (chat.id) {
        try {
          const cacheKey = `${REDIS_PREFIX_CHAT}${chat.id}`;
          await this.redisClient.set(cacheKey, JSON.stringify(chat), 'EX', REDIS_TTL_METADATA_SHORT);
          logger.info(`Chat ${chat.id} (upsert) salvo no Redis.`, { label: 'RedisCache', jid: chat.id });

          if (this.mysqlDbManager) {
            await this.mysqlDbManager.upsertChat(chat);
          }
        } catch (error) {
          logger.error(`Erro ao salvar chat ${chat.id} (upsert) no Redis ou MySQL: ${error.message}`, { label: 'SyncError', jid: chat.id, error: error.message });
        }
      }
    }
  }

  /**
   * Manipula atualizações de chats.
   * @param {Array<Partial<import('@adiwajshing/baileys').Chat>>} updates
   */
  async handleChatsUpdate(updates) {
    logger.debug(`Evento 'chats.update' recebido. Número de atualizações: ${updates.length}`, { label: 'ConnectionManager', count: updates.length });
    for (const chatUpdate of updates) {
      if (chatUpdate.id) {
        try {
          const cacheKey = `${REDIS_PREFIX_CHAT}${chatUpdate.id}`;
          await this.redisClient.set(cacheKey, JSON.stringify(chatUpdate), 'EX', REDIS_TTL_METADATA_SHORT);
          logger.info(`Chat ${chatUpdate.id} (update) atualizado no Redis.`, { label: 'RedisCache', jid: chatUpdate.id });

          if (this.mysqlDbManager) {
            await this.mysqlDbManager.upsertChat(chatUpdate);
          }
        } catch (error) {
          logger.error(`Erro ao atualizar chat ${chatUpdate.id} (update) no Redis ou MySQL: ${error.message}`, { label: 'SyncError', jid: chatUpdate.id, error: error.message });
        }
      }
    }
  }

  /**
   * Manipula exclusão de chats.
   * @param {Array<string>} jids - Array de JIDs dos chats excluídos.
   */
  async handleChatsDelete(jids) {
    logger.debug(`Evento 'chats.delete' recebido. Número de JIDs: ${jids.length}`, { label: 'ConnectionManager', count: jids.length });
    for (const jid of jids) {
      try {
        const cacheKey = `${REDIS_PREFIX_CHAT}${jid}`;
        await this.redisClient.del(cacheKey);
        logger.info(`Chat ${jid} removido do Redis.`, { label: 'RedisCache', jid });

        if (this.mysqlDbManager) {
          await this.mysqlDbManager.deleteChatData(jid);
        }
      } catch (error) {
        logger.error(`Erro ao remover chat ${jid} do Redis ou MySQL: ${error.message}`, { label: 'SyncError', jid, error: error.message });
      }
    }
  }

  /**
   * Manipula inserção/atualização de contatos.
   * @param {Array<import('@adiwajshing/baileys').Contact>} contacts
   */
  async handleContactsUpsert(contacts) {
    logger.debug(`Evento 'contacts.upsert' recebido. Número de contatos: ${contacts.length}`, { label: 'ConnectionManager', count: contacts.length });
    for (const contact of contacts) {
      if (contact.id) {
        try {
          const cacheKey = `${REDIS_PREFIX_CONTACT}${contact.id}`;
          await this.redisClient.set(cacheKey, JSON.stringify(contact), 'EX', REDIS_TTL_METADATA_LONG);
          logger.info(`Contato ${contact.id} (upsert) salvo no Redis.`, { label: 'RedisCache', jid: contact.id });

          if (this.mysqlDbManager) {
            await this.mysqlDbManager.upsertContact(contact);
          }
        } catch (error) {
          logger.error(`Erro ao salvar contato ${contact.id} (upsert) no Redis ou MySQL: ${error.message}`, { label: 'SyncError', jid: contact.id, error: error.message });
        }
      }
    }
  }

  /**
   * Manipula atualizações de contatos.
   * @param {Array<Partial<import('@adiwajshing/baileys').Contact>>} updates
   */
  async handleContactsUpdate(updates) {
    logger.debug(`Evento 'contacts.update' recebido. Número de atualizações: ${updates.length}`, { label: 'ConnectionManager', count: updates.length });
    for (const contactUpdate of updates) {
      if (contactUpdate.id) {
        try {
          const cacheKey = `${REDIS_PREFIX_CONTACT}${contactUpdate.id}`;
          await this.redisClient.set(cacheKey, JSON.stringify(contactUpdate), 'EX', REDIS_TTL_METADATA_LONG);
          logger.info(`Contato ${contactUpdate.id} (update) atualizado no Redis.`, { label: 'RedisCache', jid: contactUpdate.id });

          if (this.mysqlDbManager) {
            await this.mysqlDbManager.upsertContact(contactUpdate);
          }
        } catch (error) {
          logger.error(`Erro ao atualizar contato ${contactUpdate.id} (update) no Redis ou MySQL: ${error.message}`, { label: 'SyncError', jid: contactUpdate.id, error: error.message });
        }
      }
    }
  }

  handleBlocklistSet(data) {
    logger.info(`Evento 'blocklist.set' recebido: ${JSON.stringify(data)}`, { label: 'ConnectionManager', blocklist: data });
  }

  handleBlocklistUpdate(data) {
    logger.info(`Evento 'blocklist.update' recebido: ${JSON.stringify(data)}`, { label: 'ConnectionManager', blocklistUpdate: data });
  }

  handleCall(call) {
    logger.info(`Evento 'call' recebido: ${JSON.stringify(call)}`, { label: 'ConnectionManager', callData: call });
  }

  handlePresenceUpdate(data) {
    logger.debug(`Evento 'presence.update' recebido: JID=${data.id}, Presences=${JSON.stringify(data.presences)}`, { label: 'ConnectionManager', presence: data });
  }
}

module.exports = ConnectionManager;
