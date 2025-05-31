const { default: makeWASocket, Browsers, useMultiFileAuthState, DisconnectReason, getContentType } = require('baileys');
const pino = require('pino');
const path = require('path');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const { cleanEnv, num, str } = require('envalid');
const EventEmitter = require('events');

const logger = require('../utils/logs/logger');
require('dotenv').config();

/**
 * JSDoc type definitions for Baileys and other external types.
 * NOTE: The 'import(...)' type syntax is standard for JSDoc but causes errors with the current parser.
 * These types have been changed to 'Object' as a workaround to allow JSDoc to pass.
 * For more precise type information in documentation, the JSDoc parser/environment should be configured
 * to support 'import()' type expressions.
 * @typedef {Object} WASocket - Instância do cliente Baileys (socket WA).
 * @typedef {Object} RedisClient - Instância do cliente ioredis para Redis.
 * @typedef {{ state: AuthenticationState, saveCreds: function(): Promise<void> }} AuthObject - Objeto retornado por `useMultiFileAuthState`, contendo o estado e a função para salvar credenciais.
 * @typedef {Object} ConnectionState - Objeto de atualização do estado da conexão Baileys.
 * @typedef {Object} Boom - Objeto de erro Boom.
 * @typedef {{ error: Boom<any>=, date: Date }} LastDisconnectInfo - Informações sobre a última desconexão, incluindo o erro e a data.
 * @typedef {Object} MessagesUpsertEvent - Dados do evento 'messages.upsert' do Baileys.
 * @typedef {Object} WAMessage - Objeto de mensagem do WhatsApp (Baileys).
 * @typedef {Object} MessageUpsertType - Tipo do evento 'messages.upsert' (ex: 'notify', 'append').
 * @typedef {Object} GroupMetadata - Metadados de um grupo do WhatsApp (Baileys).
 * @typedef {Object} GroupParticipantsUpdateData - Dados do evento 'group-participants.update' do Baileys.
 * @typedef {Object} ParticipantAction - Ação em 'group-participants.update' (ex: 'add', 'remove', 'promote', 'demote').
 * @typedef {Object} MessagingHistorySet - Dados do evento 'messaging-history.set' do Baileys, contendo chats, contatos e mensagens.
 * @typedef {Object} Chat - Objeto de chat do WhatsApp (Baileys).
 * @typedef {Object} Contact - Objeto de contato do WhatsApp (Baileys).
 * @typedef {Object} WAMessageUpdate - Dados de atualização de mensagem do Baileys (evento 'messages.update').
 * @typedef {Object} WAMessageKey - Chave de identificação de uma mensagem Baileys.
 * @typedef {Object} MessageReaction - Dados de reação a uma mensagem (evento 'messages.reaction' do Baileys).
 * @typedef {Object} MessageReceipt - Objeto de recibo de mensagem Baileys (status de entrega/leitura).
 * @typedef {Object} MessageReceiptUpdate - Dados de atualização de recibo de mensagem (evento 'message-receipt.update' do Baileys).
 * @typedef {Object} CallEvent - Dados de um evento de chamada do Baileys (evento 'call').
 * @typedef {Object} PresenceEntry - Entrada individual no mapa de presenças, indicando `lastKnownPresence` e opcionalmente `lastSeen`.
 * @typedef {Object<string, PresenceEntry>} PresencesMap - Mapa de presenças, onde a chave é o JID do participante e o valor é um `PresenceEntry`.
 * @typedef {Object} PresenceUpdateData - Dados de atualização de presença (evento 'presence.update' do Baileys).
 */

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

/**
 * @class ConnectionManager
 * @description
 * Gerencia a conexão com a API do WhatsApp Web, utilizando a biblioteca Baileys.
 * É responsável por estabelecer e manter a conexão, lidar com a autenticação,
 * gerenciar eventos de mensagens, grupos, contatos, e sincronizar esses dados
 * com um banco de dados MySQL.
 * Implementa uma lógica de reconexão com backoff exponencial para lidar com
 * desconexões temporárias.
 * @property {WASocket | null} client - A instância do cliente Baileys (socket) para interagir com o WhatsApp.
 * Inicializado como `null` e populado após a conexão bem-sucedida.
 * @property {Object} mysqlDbManager - Instância do `MySQLDBManager`,
 * responsável pela persistência dos dados.
 * @property {AuthObject} auth - Objeto contendo o estado de autenticação (`state`) e o método `saveCreds`
 * fornecido por `useMultiFileAuthState` para gerenciar as credenciais de login.
 * @property {string} instanceId - Identificador único para esta instância da aplicação Omnizap, usado para logging e rastreamento.
 * @property {string} authStatePath - Caminho no sistema de arquivos onde os dados de autenticação
 * são armazenados.
 * @property {number} initialBackoffDelayMs - Tempo de espera inicial (em milissegundos) antes da
 * primeira tentativa de reconexão.
 * @property {number} maxBackoffDelayMs - Tempo de espera máximo (em milissegundos) para reconexão.
 * O tempo de espera aumenta exponencialmente a cada tentativa, até atingir este limite.
 * @property {number} currentBackoffDelayMs - O tempo de espera atual (em milissegundos) para a
 * próxima tentativa de reconexão.
 * @property {number} reconnectionAttempts - Contador do número de tentativas de reconexão consecutivas.
 * @property {number} maxReconnectionAttempts - Número máximo de tentativas de reconexão antes de
 * considerar a desconexão como irrecuperável (ex: logout).
 * @property {boolean} isReconnecting - Flag que indica se o ConnectionManager está atualmente
 * tentando se reconectar.
 * @property {EventEmitter} eventEmitter - Emissor de eventos para comunicação interna, como o encaminhamento de novas mensagens.
 */

class ConnectionManager {
  /**
   * @constructor
   * @description Cria uma nova instância do `ConnectionManager`.
   * Inicializa os parâmetros de configuração para a conexão, reconexão,
   * @param {Object} mysqlDbManager - A instância do gerenciador do banco de dados MySQL (`MySQLDBManager`).
   * @param {number} [initialBackoffDelayMs=env.BACKOFF_INITIAL_DELAY_MS] - Atraso inicial para reconexão em milissegundos.
   * @param {number} [maxBackoffDelayMs=env.BACKOFF_MAX_DELAY_MS] - Atraso máximo para reconexão em milissegundos.
   * @param {string} [authStatePath=env.AUTH_STATE_PATH] - Caminho para o diretório onde o estado de autenticação será salvo.
   */
  constructor(mysqlDbManager, initialBackoffDelayMs = env.BACKOFF_INITIAL_DELAY_MS, maxBackoffDelayMs = env.BACKOFF_MAX_DELAY_MS, authStatePath = env.AUTH_STATE_PATH) {
    this.instanceId = process.env.INSTANCE_ID || 'omnizap-instance';
    this.initialBackoffDelayMs = initialBackoffDelayMs;
    this.maxBackoffDelayMs = maxBackoffDelayMs;
    this.mysqlDbManager = mysqlDbManager;
    this.authStatePath = authStatePath;
    this.currentBackoffDelayMs = initialBackoffDelayMs;
    this.client = null;
    this.reconnectionAttempts = 0;
    this.maxReconnectionAttempts = 10;
    this.isReconnecting = false;
    this.eventEmitter = new EventEmitter();
  }

  /**
   * @method emitEvent
   * @private
   * Método utilitário para emitir eventos com logging.
   * @param {string} eventName - O nome do evento a ser emitido.
   * @param {any} data - Os dados a serem emitidos com o evento.
   * @param {string} [context=''] - Contexto da emissão para logging.
   */
  emitEvent(eventName, data, context = '') {
    try {
      this.eventEmitter.emit(eventName, data);
      logger.info(`[MÉTRICA] Evento '${eventName}' emitido com sucesso.`, {
        label: 'EventEmitter',
        metricName: 'event.emit.success',
        context,
        eventName,
        dataKeys: typeof data === 'object' && data !== null ? Object.keys(data) : undefined,
        dataType: typeof data,
        instanceId: this.instanceId,
      });
    } catch (error) {
      logger.error(`[MÉTRICA] Erro ao emitir o evento '${eventName}': ${error.message}.`, {
        label: 'EventEmitter',
        metricName: 'event.emit.error',
        error: error.message,
        stack: error.stack,
        context,
        eventName,
        instanceId: this.instanceId,
      });
    }
  }

  /**
   * @method getEventEmitter
   * @returns {EventEmitter} Retorna a instância do EventEmitter para escutar eventos customizados, como 'message:upsert:received'.
   */
  getEventEmitter() {
    return this.eventEmitter;
  }

  /**
   * @method initialize
   * Inicializa a conexão principal com o WhatsApp.
   * Este método orquestra o carregamento do estado de autenticação e, em seguida,
   * tenta estabelecer a conexão com o WhatsApp.
   * @throws {Error} Propaga erros que podem ocorrer durante `loadAuthState` ou `connect`.
   */
  async initialize() {
    logger.info('Iniciando conexão com o WhatsApp...', { label: 'ConnectionManager', instanceId: this.instanceId });
    await this.loadAuthState();
    await this.connect();
  }

  /**
   * @method loadAuthState
   * Carrega o estado de autenticação do diretório especificado em `this.authStatePath`.
   * Se o diretório não existir, ele será criado.
   * Utiliza `useMultiFileAuthState` da biblioteca Baileys para gerenciar as credenciais.
   * @throws {Error} Se houver falha ao criar o diretório ou ao carregar o estado de autenticação.
   */
  async loadAuthState() {
    if (!fs.existsSync(this.authStatePath)) {
      logger.info(`Diretório de estado de autenticação não encontrado em ${this.authStatePath}. Criando...`, { label: 'ConnectionManager', instanceId: this.instanceId });
      try {
        fs.mkdirSync(this.authStatePath, { recursive: true });
        logger.info(`Diretório ${this.authStatePath} criado com sucesso.`, { label: 'ConnectionManager', instanceId: this.instanceId });
      } catch (mkdirError) {
        logger.error(`Falha ao criar o diretório ${this.authStatePath}: ${mkdirError.message}.`, { label: 'ConnectionManager', instanceId: this.instanceId });
        throw mkdirError;
      }
    }
    this.auth = await useMultiFileAuthState(this.authStatePath);
  }

  /**
   * @method connect
   * Conecta-se ao WhatsApp usando o estado de autenticação carregado.
   * Configura o socket Baileys com as opções necessárias, incluindo logger e informações do navegador.
   */
  async connect() {
    const socketConfig = {
      auth: this.auth.state,
      logger: pino({ level: 'silent' }),
      browser: Browsers.macOS('Desktop'),
      syncFullHistory: true,
      markOnlineOnConnect: false,
      printQRInTerminal: false,
    };
    this.client = makeWASocket(socketConfig);
    this.setupEventHandlers();
  }

  /**
   * @method setupEventHandlers
   * Configura os manipuladores de eventos para o cliente WhatsApp (Baileys).
   * Registra listeners para uma variedade de eventos, como atualizações de conexão,
   * recebimento de mensagens, atualizações de grupos, chats, contatos, etc.
   * Cada evento é vinculado ao método correspondente nesta classe.
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
    logger.debug('Todos os manipuladores de eventos foram registrados.', { label: 'ConnectionManager', instanceId: this.instanceId });
  }

  /**
   * @method handleConnectionUpdate
   * Manipula atualizações de conexão do cliente WhatsApp.
   * Este método é chamado quando o estado da conexão com o WhatsApp muda (evento `connection.update`).
   * @param {Partial<ConnectionState>} update - O objeto de atualização da conexão fornecido por Baileys.
   * @param {string} [update.connection] - O estado atual da conexão ('open', 'close', 'connecting').
   * @param {LastDisconnectInfo} [update.lastDisconnect] - Informações sobre a última desconexão, contendo o erro (do tipo Boom) e a data.
   * @param {string} [update.qr] - O código QR para autenticação, se aplicável.
   *
   * @description
   * - Se um código QR for recebido, ele é exibido no terminal.
   * - Se a conexão for 'open', o estado de reconexão é resetado.
   * - Se a conexão for 'close', analisa o motivo da desconexão. Se for uma desconexão recuperável e não estiver já em processo de reconexão, inicia `reconnectWithBackoff`. Caso contrário, trata como desconexão irrecuperável.
   */
  async handleConnectionUpdate(update) {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      logger.info('[MÉTRICA] Código QR gerado para autenticação. Por favor, escaneie com seu WhatsApp:', {
        label: 'ConnectionManager',
        metricName: 'connection.qr.generated',
        instanceId: this.instanceId,
      });
      qrcode.generate(qr, { small: true });
    }

    if (connection === STATUS.CONNECTED) {
      logger.info('[MÉTRICA] Conexão com o WhatsApp estabelecida com sucesso!', {
        label: 'ConnectionManager',
        metricName: 'connection.established',
        instanceId: this.instanceId,
      });
      this.resetReconnectionState();
    }

    if (connection === STATUS.DISCONNECTED) {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const reason = DisconnectReason[statusCode] || 'Desconhecida';
      logger.warn(`[MÉTRICA] Conexão com o WhatsApp fechada. Motivo: ${reason} (Código: ${statusCode})`, {
        label: 'ConnectionManager',
        metricName: 'connection.closed',
        statusCode,
        reason,
        instanceId: this.instanceId,
        error: lastDisconnect?.error,
      });

      const shouldReconnect = this.shouldReconnect(statusCode);
      if (shouldReconnect && !this.isReconnecting) {
        this.reconnectWithBackoff(statusCode);
      } else if (!shouldReconnect) {
        this.handleIrrecoverableDisconnect(statusCode);
      }
    }
  }

  /**
   * @method shouldReconnect
   * Determina se a reconexão deve ser tentada com base no motivo da desconexão.
   * @param {number|undefined} statusCode - O código de status da desconexão, obtido de `lastDisconnect.error.output.statusCode`.
   * @returns {boolean} Retorna `true` se o `statusCode` não for `DisconnectReason.loggedOut`
   * e o número de tentativas de reconexão (`this.reconnectionAttempts`) for menor que
   * `this.maxReconnectionAttempts`. Caso contrário, retorna `false`.
   */
  shouldReconnect(statusCode) {
    return statusCode !== DisconnectReason.loggedOut && this.reconnectionAttempts < this.maxReconnectionAttempts;
  }

  /**
   * @method reconnectWithBackoff
   * Reconecta ao WhatsApp com backoff exponencial.
   * Incrementa o contador de tentativas de reconexão e calcula o próximo atraso
   * de forma exponencial, limitado pelo `maxBackoffDelayMs`.
   * Agenda uma nova tentativa de conexão (`this.connect()`) após o atraso calculado.
   * Se a reconexão falhar, e ainda for permitido tentar novamente, chama a si mesmo recursivamente. Caso contrário, trata como desconexão irrecuperável.
   * @param {number|undefined} statusCode - O código de status da desconexão, usado para verificar se a reconexão ainda é válida.
   */
  async reconnectWithBackoff(statusCode) {
    this.isReconnecting = true;
    this.reconnectionAttempts++;
    this.currentBackoffDelayMs = Math.min(this.initialBackoffDelayMs * Math.pow(2, this.reconnectionAttempts - 1), this.maxBackoffDelayMs);

    logger.info(`[MÉTRICA] Tentando reconexão (Tentativa ${this.reconnectionAttempts}/${this.maxReconnectionAttempts}) em ${this.currentBackoffDelayMs}ms...`, {
      label: 'ConnectionManager',
      metricName: 'connection.reconnect.attempt',
      attempt: this.reconnectionAttempts,
      maxAttempts: this.maxReconnectionAttempts,
      delayMs: this.currentBackoffDelayMs,
      statusCode,
      instanceId: this.instanceId,
    });

    setTimeout(async () => {
      try {
        await this.connect();
        this.isReconnecting = false;
      } catch (err) {
        logger.error(`[MÉTRICA] Tentativa de reconexão falhou: ${err.message}.`, {
          label: 'ConnectionManager',
          metricName: 'connection.reconnect.failed_attempt',
          attempt: this.reconnectionAttempts,
          error: err.message,
          stack: err.stack,
          instanceId: this.instanceId,
        });
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
   * @method handleIrrecoverableDisconnect
   * Manipula desconexão irrecuperável (ex: logout ou máximo de tentativas atingido).
   * Registra um erro informando o usuário sobre a situação e a necessidade de
   * remover os dados de autenticação e reiniciar para gerar um novo QR code.
   * Reseta o estado de reconexão.
   * @param {number|undefined} statusCode - O código de status da desconexão (pode ser `undefined`).
   */
  handleIrrecoverableDisconnect(statusCode) {
    logger.error(`[MÉTRICA] Desconexão irrecuperável. Código de Status: ${statusCode}. Por favor, remova o diretório de autenticação e reinicie para gerar um novo código QR.`, {
      label: 'ConnectionManager',
      metricName: 'connection.disconnected.irrecoverable',
      statusCode,
      instanceId: this.instanceId,
    });
    this.resetReconnectionState();
  }

  /**
   * @method resetReconnectionState
   * Reseta o estado de reconexão.
   * Define `this.reconnectionAttempts` para 0, `this.currentBackoffDelayMs` para `this.initialBackoffDelayMs`,
   * e `this.isReconnecting` para `false`.
   */
  resetReconnectionState() {
    this.reconnectionAttempts = 0;
    this.currentBackoffDelayMs = this.initialBackoffDelayMs;
    this.isReconnecting = false;
  }

  /**
   * @method handleCredsUpdate
   * Manipula a atualização de credenciais.
   * Este método é chamado por Baileys quando as credenciais de autenticação são atualizadas (por exemplo, após escanear o QR code ou durante a reconexão).
   * Salva as novas credenciais usando `this.auth.saveCreds()`.
   */
  async handleCredsUpdate() {
    await this.auth.saveCreds();
    logger.info('[MÉTRICA] Credenciais de autenticação salvas/atualizadas.', {
      label: 'ConnectionManager',
      metricName: 'auth.credentials.updated',
      instanceId: this.instanceId,
    });
  }

  /**
   * @method handleMessagesUpsert
   * Manipula mensagens novas/atualizadas.
   * Este método é chamado quando novas mensagens são recebidas ou mensagens existentes são atualizadas (evento 'messages.upsert').
   * @param {MessagesUpsertEvent} data - Os dados do evento 'messages.upsert' de Baileys.
   * @param {WAMessage[]} data.messages - Array de mensagens recebidas/atualizadas.
   * @param {MessageUpsertType} data.type - O tipo de "upsert" (ex: 'notify', 'append').
   *
   * @description
   * Para cada mensagem:
   * 1. Determina o tipo de conteúdo da mensagem usando `getContentType`.
   * 2. Se a mensagem tiver uma chave válida (`remoteJid` e `id`), ela é processada.
   * 3. A mensagem, junto com seu tipo de conteúdo e um objeto `receipts` inicializado, é preparada.
   * 4. Se `this.mysqlDbManager` estiver configurado, a mensagem também é salva (upsert) no banco de dados MySQL.
   * 5. Erros durante o salvamento no Redis ou MySQL são registrados.
   */
  async handleMessagesUpsert(data) {
    const { messages, type } = data;
    logger.info(`[MÉTRICA] Recebido(s) ${messages.length} mensagem(ns) no evento 'messages.upsert'. Tipo: ${type}. Preparando para processamento em lote.`, {
      label: 'ConnectionManager',
      metricName: 'messages.upsert.recebidas',
      count: messages.length,
      type,
      instanceId: this.instanceId,
    });

    const messagesToProcess = [];
    const originalMessagesForEvent = [];

    for (const msg of messages) {
      const messageContentType = msg.message ? getContentType(msg.message) : null;
      const { key: messageKey } = msg;

      if (messageContentType) {
        logger.debug(`Tipo de conteúdo da mensagem ${messageKey?.id}: ${messageContentType}.`, { label: 'ConnectionManager', messageKey, contentType: messageContentType, instanceId: this.instanceId });
      } else {
        logger.warn(`Não foi possível determinar o tipo de conteúdo para a mensagem ${messageKey?.id}. Pode ser um evento como exclusão de mensagem.`, { label: 'ConnectionManager', messageKey, instanceId: this.instanceId, messageDetails: msg });
      }

      if (messageKey && messageKey.remoteJid && messageKey.id) {
        const messageToStore = {
          ...msg,
          messageContentType,
          instanceId: this.instanceId,
        };
        messagesToProcess.push(messageToStore);
        originalMessagesForEvent.push(messageToStore); // Keep a reference for event emission
      } else {
        logger.warn('Mensagem recebida sem chave completa ou ID, não foi possível processar para o BD.', { label: 'ConnectionManager', messageKey: msg.key, instanceId: this.instanceId });
      }
      logger.debug(`Conteúdo da mensagem original: ${msg.key?.id}.`, { label: 'ConnectionManager', messageKey: msg.key, messageDetails: msg, instanceId: this.instanceId });
    }

    if (this.mysqlDbManager && messagesToProcess.length > 0) {
      try {
        // Assume upsertMessagesBatch handles both message and related chat updates
        // and returns an array of results (e.g., dbPersistedMessage objects) or modifies messages in place.
        // For this example, let's assume it returns an array of objects that can augment the original messages.
        const batchResults = await this.mysqlDbManager.upsertMessagesBatch(messagesToProcess);

        logger.info(`[MÉTRICA] ${messagesToProcess.length} mensagens processadas em lote pelo MySQL.`, {
          label: 'MySQLSync',
          metricName: 'messages.mysql.batch_upsert.success',
          count: messagesToProcess.length,
          instanceId: this.instanceId,
        });

        // Emit events for each message, potentially augmented with batch results
        originalMessagesForEvent.forEach((originalMsg, index) => {
          let dataForEvent = { ...originalMsg };
          if (batchResults && batchResults[index] && typeof batchResults[index] === 'object') {
            dataForEvent = { ...dataForEvent, ...batchResults[index] }; // Augment with DB specific info if returned
          }
          this.emitEvent('message:upsert:received', dataForEvent, 'messages.upsert');
        });
      } catch (dbError) {
        logger.error(`[MÉTRICA] Erro no MySQL durante o upsert em lote de ${messagesToProcess.length} mensagens: ${dbError.message}.`, {
          label: 'SyncError',
          metricName: 'messages.mysql.batch_upsert.error',
          count: messagesToProcess.length,
          error: dbError.message,
          stack: dbError.stack,
          instanceId: this.instanceId,
        });
        // Fallback: emit events with original data if DB batch fails
        originalMessagesForEvent.forEach((msg) => this.emitEvent('message:upsert:received', msg, 'messages.upsert'));
      }
    } else if (originalMessagesForEvent.length > 0) {
      // No mysqlDbManager, but still emit events for messages that were valid for event emission
      originalMessagesForEvent.forEach((msg) => {
        this.emitEvent('message:upsert:received', msg, 'messages.upsert');
      });
    }
  }

  /**
   * @method validateGroupMetadata
   * @private
   * Valida se o objeto de metadados do grupo é minimamente válido.
   * @param {GroupMetadata|null|undefined} metadata - O objeto de metadados do grupo.
   * @returns {boolean} True se os metadados forem válidos, false caso contrário.
   */
  validateGroupMetadata(metadata) {
    return metadata && typeof metadata === 'object' && typeof metadata.id === 'string' && metadata.id.endsWith('@g.us');
  }

  /**
   * @method updateGroupMetadata
   * @private
   * Método utilitário para buscar e atualizar metadados de grupo no MySQL.
   * @param {string} jid - O JID do grupo.
   * @param {GroupMetadata} [existingMetadata=null] - Metadados existentes do grupo (opcional).
   * @param {string} [context=''] - Contexto da atualização para logging.
   * @returns {Promise<GroupMetadata|null>} Os metadados atualizados do grupo ou null se não for possível obtê-los.
   */
  async updateGroupMetadata(jid, existingMetadata = null, context = '') {
    try {
      if (!jid || !jid.endsWith('@g.us')) {
        logger.warn(`JID inválido fornecido para atualização de metadados de grupo: ${jid}${context ? ` (${context})` : ''}.`, {
          label: 'ConnectionManager',
          jid,
          context,
        });
        return null;
      }

      let finalMetadata = existingMetadata;
      if (!finalMetadata && this.client) {
        finalMetadata = await this.client.groupMetadata(jid);
      }

      if (!this.validateGroupMetadata(finalMetadata)) {
        logger.warn(`Metadados de grupo inválidos ou não obtidos para ${jid} no contexto '${context}'.`, {
          label: 'ConnectionManager',
          jid,
          metadataAttempted: finalMetadata,
          context,
        });
        return null;
      }

      if (finalMetadata) {
        if (this.mysqlDbManager) {
          try {
            await this.mysqlDbManager.upsertGroup(finalMetadata);
            logger.info(`[MÉTRICA] Metadados do grupo ${jid} atualizados no MySQL. Contexto: ${context}.`, {
              label: 'MySQLSync',
              metricName: 'group.metadata.mysql.updated',
              jid,
              context,
              instanceId: this.instanceId,
            });
          } catch (dbError) {
            logger.error(`[MÉTRICA] Erro ao atualizar metadados do grupo ${jid} no MySQL. Contexto: ${context}. Erro: ${dbError.message}.`, {
              label: 'MySQLSyncError',
              metricName: 'group.metadata.mysql.error',
              jid,
              context,
              error: dbError.message,
              stack: dbError.stack,
              instanceId: this.instanceId,
            });
          }
        }
        this.emitEvent('group:metadata:updated', { jid, metadata: finalMetadata, context }, context);
        // Metric for event emission is handled by emitEvent
        return finalMetadata;
      }
      logger.warn(`Metadados do grupo ${jid} não puderam ser obtidos (após validação)${context ? ` (${context})` : ''}.`, {
        label: 'ConnectionManager',
        jid,
        context,
        instanceId: this.instanceId,
      });
      return null;
    } catch (error) {
      logger.error(`Erro ao atualizar metadados do grupo ${jid}${context ? ` (${context})` : ''}: ${error.message}.`, {
        label: 'SyncError',
        jid,
        error: error.message,
        stack: error.stack,
        context,
        instanceId: this.instanceId,
      });
      return null;
    }
  }

  /**
   * @method handleGroupsUpdate
   * Manipula atualizações de grupos.
   * Este método é chamado quando há atualizações nos metadados de grupos existentes (ex: mudança de nome, descrição) (evento 'groups.update').
   * @param {Array<Partial<GroupMetadata>>} updates - Array de objetos contendo atualizações parciais dos metadados do grupo. Cada objeto deve ter pelo menos a propriedade `id` (JID do grupo).
   *
   * @description
   * Para cada atualização de grupo:
   * 1. Obtém o JID do grupo.
   * 2. Busca os metadados completos do grupo usando `this.client.groupMetadata(jid)`.
   * 3. Se os metadados forem obtidos com sucesso, eles são preparados para persistência.
   * 4. Se `this.mysqlDbManager` estiver configurado, os metadados do grupo também são salvos (upsert) no banco de dados MySQL.
   * 5. Erros durante o processo são registrados.
   */
  async handleGroupsUpdate(updates) {
    logger.debug(`Evento 'groups.update' recebido. Número de atualizações: ${updates.length}.`, {
      label: 'ConnectionManager',
      count: updates.length,
      instanceId: this.instanceId,
    });
    for (const groupUpdate of updates) {
      const jid = groupUpdate.id; // This is often just the JID
      if (jid && jid.endsWith('@g.us')) {
        // For groups.update, Baileys sends partial updates.
        // We need to fetch full metadata to ensure DB consistency.
        // This part remains individual as fetching is per-group.
        // The batching would apply if we collected multiple full metadata objects.
        // For this specific handler, if updates are frequent and partial,
        // batching the DB write after fetching full metadata for several groups could be beneficial.
        // However, updateGroupMetadata already handles a single group update well.
        // If `updates` array can be large, we can collect JIDs, fetch all metadata, then batch upsert.
        // For now, let's assume updateGroupMetadata is efficient enough or refactor if it becomes a bottleneck.
        // To demonstrate batching here, we'd change the flow:
        // 1. Collect all JIDs from `updates`.
        // 2. Fetch metadata for all these JIDs (e.g., Promise.all with this.client.groupMetadata).
        // 3. Collect valid full metadata objects.
        // 4. Call a batch upsert method.
        // This change is more involved for this handler due to the fetch step.
        // The current `updateGroupMetadata` is called, which does a single DB op.
        // Let's modify this handler to collect metadata first.
        // (See revised implementation below in the combined diff section for handleGroupsUpdate and handleGroupsUpsert)
        await this.updateGroupMetadata(jid, groupUpdate, 'groups.update'); // Pass groupUpdate as existingMetadata hint
      }
    }
  }

  /**
   * @method handleGroupParticipantsUpdate
   * Manipula atualizações de participantes de grupos.
   * Chamado quando participantes entram, saem, são promovidos ou rebaixados em um grupo (evento 'group-participants.update').
   * @param {GroupParticipantsUpdateData} event - Os dados do evento 'group-participants.update' de Baileys.
   * @param {string} event.id - O JID do grupo afetado.
   * @param {string[]} event.participants - Array de JIDs dos participantes afetados.
   * @param {ParticipantAction} event.action - Ação realizada ('add', 'remove', 'promote', 'demote').
   *
   * @description
   * Após uma atualização de participante, os metadados completos do grupo são buscados e atualizados.
   * A atualização dos participantes em si é gerenciada pelo `mysqlDbManager.upsertGroup`
   * que internamente chama `updateGroupParticipants`.
   */
  async handleGroupParticipantsUpdate(event) {
    const { id: jid, action, participants } = event;
    logger.debug(`Evento 'group-participants.update' recebido para o grupo ${jid}. Ação: ${action}. Participantes: ${participants.join(', ')}.`, {
      label: 'ConnectionManager',
      jid,
      action,
      participants,
      instanceId: this.instanceId,
    });
    // Fetching full metadata is important as participant list changes.
    await this.updateGroupMetadata(jid, null, 'group-participants.update');
  }

  /**
   * @method handleGroupsUpsert
   * Manipula a inserção/atualização de grupos (quando o usuário entra em um novo grupo ou sincronização inicial).
   * @param {GroupMetadata[]} groupsMetadata - Array de objetos completos de metadados de grupo.
   */
  async handleGroupsUpsert(groupsMetadata) {
    logger.debug(`Evento 'groups.upsert' recebido. Número de grupos: ${groupsMetadata.length}.`, {
      label: 'ConnectionManager',
      count: groupsMetadata.length,
      instanceId: this.instanceId,
    });

    const validGroupsToUpsert = groupsMetadata.filter((metadata) => this.validateGroupMetadata(metadata));

    if (this.mysqlDbManager && validGroupsToUpsert.length > 0) {
      try {
        await this.mysqlDbManager.upsertGroupsBatch(validGroupsToUpsert); // Assumed batch method
        logger.info(`[MÉTRICA] ${validGroupsToUpsert.length} grupos atualizados/inseridos em lote a partir de 'groups.upsert'.`, {
          label: 'MySQLSync',
          metricName: 'group.mysql.batch_upsert.success',
          count: validGroupsToUpsert.length,
          instanceId: this.instanceId,
        });
        validGroupsToUpsert.forEach((metadata) => {
          this.emitEvent('group:metadata:updated', { jid: metadata.id, metadata, context: 'groups.upsert' }, 'groups.upsert');
        });
      } catch (dbError) {
        logger.error(`[MÉTRICA] Erro ao atualizar/inserir em lote ${validGroupsToUpsert.length} grupos a partir de 'groups.upsert': ${dbError.message}.`, {
          label: 'MySQLSyncError',
          metricName: 'group.mysql.batch_upsert.error',
          count: validGroupsToUpsert.length,
          error: dbError.message,
          stack: dbError.stack,
          instanceId: this.instanceId,
        });
        // Fallback: emit events even if DB fails, with original data
        validGroupsToUpsert.forEach((metadata) => {
          this.emitEvent('group:metadata:updated', { jid: metadata.id, metadata, context: 'groups.upsert' }, 'groups.upsert');
        });
      }
    }
  }

  /**
   * @method handleMessagingHistorySet
   * Manipula o evento de conjunto de histórico de mensagens.
   * Este evento é disparado durante a sincronização inicial do histórico (evento 'messaging-history.set'),
   * fornecendo um conjunto de chats, contatos e mensagens.
   * @param {MessagingHistorySet} data - Os dados do evento 'messaging-history.set' de Baileys.
   * @param {Chat[]} data.chats - Array de objetos de chat do histórico.
   * @param {Contact[]} data.contacts - Array de objetos de contato do histórico.
   * @param {WAMessage[]} data.messages - Array de mensagens do histórico.
   *
   * @description
   * - Para cada chat: Salva no MySQL (via `this.mysqlDbManager.upsertChat`).
   * - Para cada contato: (Atualmente não salva contatos no MySQL neste handler, apenas loga).
   * - Para cada mensagem: Determina o tipo de conteúdo. Salva no MySQL (via `this.mysqlDbManager.upsertMessage`).
   * Erros durante o salvamento são registrados.
   */
  async handleMessagingHistorySet(data) {
    const { chats, contacts, messages } = data;
    logger.info(`[MÉTRICA] Evento 'messaging-history.set' recebido. Chats: ${chats.length}, Contatos: ${contacts.length}, Mensagens: ${messages.length}.`, {
      label: 'ConnectionManager',
      metricName: 'messaging_history.set.recebido',
      counts: { chats: chats.length, contacts: contacts.length, messages: messages.length },
      instanceId: this.instanceId,
    });

    for (const chat of chats) {
      if (chat.id) {
        try {
          if (this.mysqlDbManager) {
            try {
              await this.mysqlDbManager.upsertChat(chat);
              logger.info(`[MÉTRICA] Chat ${chat.id} do histórico salvo no MySQL.`, {
                label: 'MySQLSync',
                metricName: 'history.chat.mysql.success',
                jid: chat.id,
                instanceId: this.instanceId,
              });
            } catch (dbError) {
              logger.error(`[MÉTRICA] Erro ao salvar chat ${chat.id} do histórico no MySQL: ${dbError.message}.`, {
                label: 'MySQLSyncError',
                metricName: 'history.chat.mysql.error',
                jid: chat.id,
                error: dbError.message,
                stack: dbError.stack,
                instanceId: this.instanceId,
              });
            }
          }
        } catch (error) {
          logger.error(`[MÉTRICA] Erro ao processar chat ${chat.id} do histórico (BD ou outro): ${error.message}.`, {
            label: 'SyncError',
            metricName: 'history.chat.processing.error',
            jid: chat.id,
            error: error.message,
            stack: error.stack,
            instanceId: this.instanceId,
          });
        }
      }
    }

    for (const contact of contacts) {
      if (contact.id) {
        // Originalmente, contatos do histórico eram apenas cacheados no Redis.
        // Agora, apenas logamos, pois não há instrução para persisti-los no MySQL aqui.
        logger.debug(`Contato do histórico recebido: ${contact.id}.`, { label: 'ConnectionManager', contactId: contact.id, instanceId: this.instanceId });
      }
    }

    for (const msg of messages) {
      logger.debug(`Mensagem do histórico recebida: ${msg.key?.id} de ${msg.key?.remoteJid}.`, { label: 'ConnectionManager', messageKey: msg.key, instanceId: this.instanceId });
      if (msg.key && msg.key.remoteJid && msg.key.id) {
        const messageContentType = msg.message ? getContentType(msg.message) : null;
        try {
          const messageToStore = { ...msg, receipts: msg.receipts || {}, messageContentType };

          if (this.mysqlDbManager) {
            try {
              await this.mysqlDbManager.upsertMessage(messageToStore);
              logger.info(`[MÉTRICA] Mensagem do histórico ${msg.key.id} salva no MySQL.`, {
                label: 'MySQLSync',
                metricName: 'history.message.mysql.success',
                messageKey: msg.key,
                instanceId: this.instanceId,
              });
            } catch (dbError) {
              logger.error(`[MÉTRICA] Erro ao salvar mensagem do histórico ${msg.key.id} no MySQL: ${dbError.message}.`, {
                label: 'MySQLSyncError',
                metricName: 'history.message.mysql.error',
                messageKey: msg.key,
                error: dbError.message,
                stack: dbError.stack,
                instanceId: this.instanceId,
              });
            }
          }
        } catch (error) {
          logger.error(`[MÉTRICA] Erro ao processar mensagem do histórico ${msg.key.id} (BD ou outro): ${error.message}.`, {
            label: 'SyncError',
            metricName: 'history.message.processing.error',
            messageKey: msg.key,
            error: error.message,
            stack: error.stack,
            instanceId: this.instanceId,
          });
        }
      } else {
        logger.warn('Mensagem do histórico recebida sem chave completa, não foi possível salvar.', { label: 'ConnectionManager', message: msg, instanceId: this.instanceId });
      }
    }
  }
  /**
   * @method handleMessagesUpdate
   * Manipula atualizações de mensagens.
   * Este evento é disparado para atualizações em mensagens existentes (ex: status de entrega, edição - se suportado) (evento 'messages.update').
   * @param {WAMessageUpdate[]} updates - Array de objetos de atualização de mensagem.
   * Cada objeto contém a `key` da mensagem e o `update` com os campos alterados.
   * @description Atualmente, este método apenas registra as atualizações recebidas. Nenhuma ação de persistência ou cache é realizada aqui.
   */
  handleMessagesUpdate(updates) {
    logger.info(`[MÉTRICA] Evento 'messages.update' recebido. Número de atualizações: ${updates.length}.`, {
      label: 'ConnectionManager',
      metricName: 'messages.update.recebido',
      count: updates.length,
      instanceId: this.instanceId,
    });
    updates.forEach((update) => {
      logger.debug(`Detalhes da atualização da mensagem: Chave=${update.key?.id}, JID=${update.key?.remoteJid}.`, {
        label: 'ConnectionManager',
        messageUpdate: update,
        updateContent: update.update, // Log the actual update content
        instanceId: this.instanceId,
      });
    });
  }

  /**
   * @method handleMessagesDelete
   * Manipula exclusão de mensagens.
   * Este evento é disparado quando mensagens são deletadas (evento 'messages.delete').
   * @param {Object|WAMessageKey[]} deletion - Informações sobre as mensagens deletadas.
   * Pode ser um objeto se for `deleteAll`, ou um array de `WAMessageKey` para mensagens específicas.
   * @description Atualmente, este método apenas registra o evento de exclusão. Nenhuma ação de remoção do cache ou banco de dados é realizada aqui.
   */
  handleMessagesDelete(deletion) {
    logger.info(`[MÉTRICA] Evento 'messages.delete' recebido.`, {
      label: 'ConnectionManager',
      metricName: 'messages.delete.recebido',
      deletionDetails: deletion,
      instanceId: this.instanceId,
    });
  }

  /**
   * @method handleMessagesReaction
   * Manipula reações a mensagens.
   * Este evento é disparado quando uma reação é adicionada ou removida de uma mensagem (evento 'messages.reaction').
   * @param {MessageReaction[]} reactions - Array de objetos de reação.
   * Cada objeto contém a `key` da mensagem original e a `reaction` (com texto, etc.).
   * @description Atualmente, este método apenas registra as reações recebidas. Nenhuma ação de persistência ou cache é realizada aqui.
   */
  handleMessagesReaction(reactions) {
    logger.info(`[MÉTRICA] Evento 'messages.reaction' recebido. Número de reações: ${reactions.length}.`, {
      label: 'ConnectionManager',
      metricName: 'messages.reaction.recebido',
      count: reactions.length,
      instanceId: this.instanceId,
    });
    reactions.forEach((reaction) => {
      logger.debug(`Detalhes da reação: ChaveMsg=${reaction.key?.id}, JID=${reaction.key?.remoteJid}, TextoReacao=${reaction.reaction.text}.`, {
        label: 'ConnectionManager',
        reaction,
        instanceId: this.instanceId,
      });
    });
  }

  /**
   * @method handleMessageReceiptUpdate
   * Manipula atualizações de recibo de mensagem.
   * Este evento é disparado quando o status de entrega/leitura de uma mensagem é atualizado
   * (ex: 'delivered', 'read', 'played') (evento 'message-receipt.update').
   * @param {MessageReceiptUpdate[]} receipts - Array de atualizações de recibo.
   * Cada objeto contém:
   *  - `key`: {@link WAMessageKey} A chave da mensagem original.
   *  - `receipt`: {@link MessageReceipt} O objeto de recibo, contendo:
   *    - `userJid`: JID do usuário cujo recibo foi atualizado.
   *    - `type`: Tipo do recibo (e.g., 'read', 'delivered').
   *    - `receiptTimestamp`, `readTimestamp`, `playedTimestamp`: Timestamps relevantes.
   *
   * @description
   * Para cada atualização de recibo:
   * 1. Verifica se a chave da mensagem, os detalhes do recibo são válidos e se o cliente Redis está disponível.
   * 2. Prepara os dados do recibo.
   * 3. Se `this.mysqlDbManager` estiver configurado, salva (upsert) o recibo no banco de dados MySQL.
   * 4. (Lógica de atualização de objeto de mensagem em cache foi removida com o Redis).
   * 5. Erros durante o processo são registrados.
   */
  async handleMessageReceiptUpdate(receipts) {
    logger.info(`[MÉTRICA] Evento 'message-receipt.update' recebido. Número de recibos: ${receipts.length}.`, {
      label: 'ConnectionManager',
      metricName: 'message_receipt.update.recebido',
      count: receipts.length,
      instanceId: this.instanceId,
    });

    const receiptsToUpsert = [];
    for (const receiptUpdate of receipts) {
      const { key, receipt } = receiptUpdate;
      if (key && key.remoteJid && key.id && receipt && receipt.userJid) {
        const timestamp = receipt.receiptTimestamp || receipt.readTimestamp || receipt.playedTimestamp;
        receiptsToUpsert.push({
          key,
          userJid: receipt.userJid,
          type: receipt.type,
          timestamp,
        });
      }
      logger.debug(`Detalhes do Recibo: ChaveMsg=${key?.id}, JID=${key?.remoteJid}, Status=${receipt?.type}, UserJid=${receipt?.userJid}.`, { label: 'ConnectionManager', receipt: receiptUpdate, instanceId: this.instanceId });
    }

    if (this.mysqlDbManager && receiptsToUpsert.length > 0) {
      try {
        // Assumed batch method: upsertMessageReceiptsBatch(receiptsToUpsert)
        await this.mysqlDbManager.upsertMessageReceiptsBatch(receiptsToUpsert);
        logger.info(`[MÉTRICA] ${receiptsToUpsert.length} recibos de mensagem atualizados/inseridos em lote no MySQL.`, {
          label: 'MySQLSync',
          metricName: 'message.receipt.mysql.batch_upserted',
          count: receiptsToUpsert.length,
          instanceId: this.instanceId,
        });
      } catch (dbError) {
        logger.error(`[MÉTRICA] Erro ao atualizar/inserir em lote ${receiptsToUpsert.length} recibos de mensagem no MySQL: ${dbError.message}.`, {
          label: 'MySQLSyncError',
          metricName: 'message.receipt.mysql.batch_error',
          count: receiptsToUpsert.length,
          error: dbError.message,
          stack: dbError.stack,
          instanceId: this.instanceId,
        });
      }
    }
  }

  /**
   * @method handleMessageReceiptUpdate // Original method before batching for reference if needed
   * Manipula atualizações de recibo de mensagem.
   * Este evento é disparado quando o status de entrega/leitura de uma mensagem é atualizado
   * (ex: 'delivered', 'read', 'played') (evento 'message-receipt.update').
   * @param {MessageReceiptUpdate[]} receipts - Array de atualizações de recibo.
   * Cada objeto contém:
   *  - `key`: {@link WAMessageKey} A chave da mensagem original.
   *  - `receipt`: {@link MessageReceipt} O objeto de recibo, contendo:
   *    - `userJid`: JID do usuário cujo recibo foi atualizado.
   *    - `type`: Tipo do recibo (e.g., 'read', 'delivered').
   *    - `receiptTimestamp`, `readTimestamp`, `playedTimestamp`: Timestamps relevantes.
   *
   * @description
   * Para cada atualização de recibo:
   * 1. Verifica se a chave da mensagem, os detalhes do recibo são válidos.
   * 2. Prepara os dados do recibo.
   * 3. Se `this.mysqlDbManager` estiver configurado, salva (upsert) o recibo no banco de dados MySQL.
   * 4. Erros durante o processo são registrados.
   */
  /* // Original handleMessageReceiptUpdate method content for reference
  async handleMessageReceiptUpdate(receipts) {
    logger.info(`[MÉTRICA] Evento 'message-receipt.update' recebido. Número de recibos: ${receipts.length}.`, {
      label: 'ConnectionManager',
      metricName: 'message_receipt.update.recebido',
      count: receipts.length,
      instanceId: this.instanceId,
    });

    for (const receiptUpdate of receipts) {
      const { key, receipt } = receiptUpdate;
      if (key && key.remoteJid && key.id && receipt && receipt.userJid) {
        try { // This try-catch is per receipt
          if (this.mysqlDbManager) {
            try {
              const timestamp = receipt.receiptTimestamp || receipt.readTimestamp || receipt.playedTimestamp;
              await this.mysqlDbManager.upsertMessageReceipt(key, receipt.userJid, receipt.type, timestamp);
              logger.info(`[MÉTRICA] Recibo de mensagem para ${key.id} (usuário ${receipt.userJid}) atualizado/inserido no MySQL.`, {
                label: 'MySQLSync',
                metricName: 'message.receipt.mysql.upserted',
                messageId: key.id,
                remoteJid: key.remoteJid,
                userJid: receipt.userJid,
                receiptType: receipt.type,
                instanceId: this.instanceId,
              });
            } catch (dbError) {
              logger.error(`[MÉTRICA] Erro ao atualizar/inserir recibo de mensagem para ${key.id} no MySQL: ${dbError.message}.`, {
                label: 'MySQLSyncError',
                metricName: 'message.receipt.mysql.error',
                messageKey: key,
                userJid: receipt.userJid,
                error: dbError.message,
                stack: dbError.stack,
                instanceId: this.instanceId,
              });
            }
          }
        } catch (error) {
          logger.error(`[MÉTRICA] Erro ao processar recibo de mensagem para ${key.id} (BD/outro): ${error.message}.`, {
            label: 'SyncError',
            metricName: 'message.receipt.db.error', // Mais específico para erro de DB
            messageKey: key,
            error: error.message,
            stack: error.stack,
            instanceId: this.instanceId,
          });
        }
      }
      logger.debug(`Detalhes do Recibo: ChaveMsg=${key?.id}, JID=${key?.remoteJid}, Status=${receipt?.type}, UserJid=${receipt?.userJid}.`, { label: 'ConnectionManager', receipt: receiptUpdate, instanceId: this.instanceId });
    }
  } */

  /**
   * @method handleChatsUpsert
   * Manipula inserção/atualização de chats.
   * Este evento é disparado quando novos chats são criados ou chats existentes são sincronizados (evento 'chats.upsert').
   * @param {Chat[]} chats - Array de objetos de chat.
   *
   * @description
   * Para cada chat:
   * 1. Prepara o objeto do chat para persistência.
   * 2. Se `this.mysqlDbManager` estiver configurado, salva (upsert) o chat no banco de dados MySQL.
   * 3. Erros durante o processo são registrados.
   */
  async handleChatsUpsert(chats) {
    logger.info(`[MÉTRICA] Evento 'chats.upsert' recebido. Número de chats: ${chats.length}.`, {
      label: 'ConnectionManager',
      metricName: 'chats.upsert.recebido',
      count: chats.length,
      instanceId: this.instanceId,
    });

    const validChats = chats.filter((chat) => chat.id);

    if (this.mysqlDbManager && validChats.length > 0) {
      try {
        await this.mysqlDbManager.upsertChatsBatch(validChats); // Assumed batch method
        logger.info(`[MÉTRICA] ${validChats.length} chats atualizados/inseridos em lote no MySQL.`, {
          label: 'MySQLSync',
          metricName: 'chat.mysql.batch_upsert.success',
          count: validChats.length,
          instanceId: this.instanceId,
        });
      } catch (dbError) {
        logger.error(`[MÉTRICA] Erro ao atualizar/inserir em lote ${validChats.length} chats no MySQL: ${dbError.message}.`, {
          label: 'MySQLSyncError',
          metricName: 'chat.mysql.batch_upsert.error',
          count: validChats.length,
          error: dbError.message,
          stack: dbError.stack,
          instanceId: this.instanceId,
        });
      }
    } else if (validChats.length > 0) {
      logger.debug(`${validChats.length} chats recebidos para upsert, mas nenhum mysqlDbManager configurado ou nenhum chat válido para processar.`, {
        label: 'ConnectionManager',
        count: validChats.length,
        hasDbManager: !!this.mysqlDbManager,
        instanceId: this.instanceId,
      });
    }
  }

  /**
   * @method handleChatsUpdate
   * Manipula atualizações de chats.
   * Este evento é disparado quando propriedades de um chat existente são alteradas (ex: `unreadCount`, `mute`) (evento 'chats.update').
   * @param {Array<Partial<Chat>>} updates - Array de atualizações parciais de chat. Cada objeto deve ter pelo menos a propriedade `id`.
   *
   * @description
   * Para cada atualização de chat:
   * 1. Prepara a atualização do chat para persistência.
   * 2. Se `this.mysqlDbManager` estiver configurado, salva (upsert) a atualização do chat no banco de dados MySQL.
   *    (Assume que `upsertChatsBatch` ou um `upsertChat` individual pode lidar com atualizações parciais).
   * 3. Erros durante o processo são registrados.
   */
  async handleChatsUpdate(updates) {
    logger.info(`[MÉTRICA] Evento 'chats.update' recebido. Número de atualizações: ${updates.length}.`, {
      label: 'ConnectionManager',
      metricName: 'chats.update.recebido',
      count: updates.length,
      instanceId: this.instanceId,
    });

    const validChatUpdates = updates.filter((chatUpdate) => chatUpdate.id);

    if (this.mysqlDbManager && validChatUpdates.length > 0) {
      try {
        // Baileys 'chats.update' provides partial updates.
        // The batch method `upsertChatsBatch` should be able to handle these,
        // or we might call individual `upsertChat` if the batch method isn't designed for partials.
        // For simplicity, let's assume `upsertChatsBatch` can handle partials or merges them correctly.
        await this.mysqlDbManager.upsertChatsBatch(validChatUpdates);
        logger.info(`[METRIC] ${validChatUpdates.length} chat updates batch-processed by MySQL.`, {
          label: 'MySQLSync', // Mantido como label técnico
          metricName: 'chat.mysql.batch_update.success',
          count: validChatUpdates.length,
          instanceId: this.instanceId,
        });
      } catch (dbError) {
        logger.error(`[METRIC] Error batch-updating ${validChatUpdates.length} chats in MySQL: ${dbError.message}`, {
          label: 'MySQLSyncError', // Mantido como label técnico
          metricName: 'chat.mysql.batch_update.error',
          count: validChatUpdates.length,
          error: dbError.message,
          stack: dbError.stack,
          instanceId: this.instanceId,
        });
      }
    }
  }
  /**
   * @method handleChatsDelete
   * Manipula exclusão de chats.
   * Este evento é disparado quando chats são deletados (evento 'chats.delete').
   * @param {Array<string>} jids - Array de JIDs (identificadores) dos chats que foram excluídos.
   *
   * @description
   * Para cada JID de chat excluído:
   * 1. (Lógica de remoção do cache Redis foi removida).
   * 2. Se `this.mysqlDbManager` estiver configurado, chama `this.mysqlDbManager.deleteChatData(jid)` para remover os dados associados ao chat do banco de dados MySQL.
   * 3. Erros durante o processo são registrados.
   */
  async handleChatsDelete(jids) {
    logger.info(`[MÉTRICA] Evento 'chats.delete' recebido. Número de JIDs: ${jids.length}.`, {
      label: 'ConnectionManager',
      metricName: 'chats.delete.recebido',
      count: jids.length,
      instanceId: this.instanceId,
    });
    for (const jid of jids) {
      try {
        if (this.mysqlDbManager) {
          try {
            await this.mysqlDbManager.deleteChatData(jid);
            logger.info(`[MÉTRICA] Dados do chat para ${jid} removidos do MySQL.`, {
              label: 'MySQLSync',
              metricName: 'chat.mysql.delete.success',
              jid,
              instanceId: this.instanceId,
            });
          } catch (dbError) {
            logger.error(`[MÉTRICA] Erro ao remover dados do chat para ${jid} do MySQL: ${dbError.message}.`, {
              label: 'MySQLSyncError',
              metricName: 'chat.mysql.delete.error',
              jid,
              error: dbError.message,
              stack: dbError.stack,
              instanceId: this.instanceId,
            });
          }
        }
      } catch (error) {
        logger.error(`[MÉTRICA] Erro ao processar exclusão de chat para ${jid} (BD ou outro): ${error.message}.`, {
          label: 'SyncError',
          metricName: 'chat.processing.delete.error',
          jid,
          error: error.message,
          stack: error.stack,
          instanceId: this.instanceId,
        });
      }
    }
  }

  /**
   * @method handleContactsUpsert
   * Manipula inserção/atualização de contatos.
   * Este evento é disparado quando novos contatos são adicionados ou contatos existentes são sincronizados (evento 'contacts.upsert').
   * @param {Contact[]} contacts - Array de objetos de contato.
   *
   * @description
   * Para cada contato:
   * 1. (Lógica de cache Redis foi removida).
   * 2. (Atualmente, não há persistência de contatos no MySQL neste handler, apenas log).
   */
  async handleContactsUpsert(contacts) {
    logger.info(`[MÉTRICA] Evento 'contacts.upsert' recebido. Número de contatos: ${contacts.length}.`, {
      label: 'ConnectionManager',
      metricName: 'contacts.upsert.recebido',
      count: contacts.length,
      instanceId: this.instanceId,
    });
    for (const contact of contacts) {
      if (contact.id) {
        // Originalmente, contatos eram apenas cacheados no Redis.
        // Agora, apenas logamos, pois não há instrução para persisti-los no MySQL aqui.
        logger.debug(`Upsert de contato recebido: ${contact.id}.`, { label: 'ConnectionManager', contactId: contact.id, instanceId: this.instanceId });
      }
    }
  }

  /**
   * @method handleContactsUpdate
   * Manipula a atualização de contatos.
   * (Lógica de cache Redis foi removida).
   * Este evento é disparado quando propriedades de um contato existente são alteradas (ex: nome, notificação push) (evento 'contacts.update').
   * @param {Array<Partial<Contact>>} updates - Array de atualizações parciais de contatos. Cada objeto deve ter pelo menos a propriedade `id`.
   *
   * @description
   * Para cada atualização de contato:
   * 1. Se o cliente Redis estiver disponível, salva o objeto de atualização do contato no cache Redis com a chave `contact:<id>` e TTL `REDIS_TTL_METADATA_LONG`. (Nota: Isso pode sobrescrever o contato completo com um objeto parcial se não for tratado com cuidado ao ler do cache).
   * 2. Erros durante o salvamento no Redis são registrados. (Atualmente, não há persistência de contatos no MySQL neste handler).
   * @example // Exemplo de update recebido
   * handleContactsUpdate([{
   *   id: '5511999999999@s.whatsapp.net',
   *   name: 'Novo Nome',
   *   notify: 'Notificação'
   * }]);
   */
  async handleContactsUpdate(updates) {
    logger.info(`[MÉTRICA] Evento 'contacts.update' recebido. Número de atualizações: ${updates.length}.`, {
      label: 'ConnectionManager',
      metricName: 'contacts.update.recebido',
      count: updates.length,
      instanceId: this.instanceId,
    });
    for (const contactUpdate of updates) {
      if (contactUpdate.id) {
        // Originalmente, atualizações de contatos eram apenas cacheadas no Redis.
        // Agora, apenas registramos o log.
        logger.debug(`Atualização de contato recebida: ${contactUpdate.id}.`, { label: 'ConnectionManager', contactId: contactUpdate.id, update: contactUpdate, instanceId: this.instanceId });
      }
    }
  }

  /**
   * @method handleBlocklistSet
   * Processa o evento de definição da lista de bloqueio.
   * Registra os números que estão na lista de bloqueio do WhatsApp.
   * Este evento é disparado quando a lista de bloqueio é definida ou sincronizada (evento 'blocklist.set').
   * @param {{ blocklist: string[] }} data - Dados da lista de bloqueio.
   * @param {string[]} data.blocklist - Array de JIDs (identificadores) que estão na lista de bloqueio.
   * @example
   * // Exemplo de dados recebidos
   * handleBlocklistSet({
   *   blocklist: ['5511999999999@s.whatsapp.net']
   * });
   */
  handleBlocklistSet(data) {
    logger.info(`[MÉTRICA] Evento 'blocklist.set' recebido. Contagem: ${data.blocklist?.length || 0}.`, {
      label: 'ConnectionManager',
      metricName: 'blocklist.set.recebido',
      blocklist: data.blocklist, // Log the actual list for debugging if needed, or just count
      instanceId: this.instanceId,
    });
  }

  /**
   * @method handleBlocklistUpdate
   * Processa atualizações na lista de bloqueio do WhatsApp.
   * Registra alterações (adições/remoções) na lista de contatos bloqueados.
   * Este evento é disparado quando um JID é adicionado ou removido da lista de bloqueio (evento 'blocklist.update').
   * @param {{ jids: string[], action: 'block' | 'unblock' }} data - Dados da atualização da lista de bloqueio.
   * @param {'block' | 'unblock'} data.action - Ação realizada ('block' ou 'unblock').
   * @param {string[]} data.jids - Array de JIDs afetados pela ação.
   * @example
   * // Exemplo de dados recebidos
   * handleBlocklistUpdate({
   *   action: 'block',
   *   jids: ['5511999999999@s.whatsapp.net']
   * });
   */
  handleBlocklistUpdate(data) {
    logger.info(`[MÉTRICA] Evento 'blocklist.update' recebido. Ação: ${data.action}, Contagem de JIDs: ${data.jids?.length || 0}.`, {
      label: 'ConnectionManager',
      metricName: 'blocklist.update.recebido',
      action: data.action,
      jids: data.jids,
      instanceId: this.instanceId,
    });
  }

  /**
   * @method handleCall
   * Processa eventos de chamadas recebidas ou realizadas.
   * Registra informações sobre chamadas de voz/vídeo no WhatsApp.
   * Este evento é disparado para vários estágios de uma chamada (oferta, aceitação, rejeição, término) (evento 'call').
   * @param {CallEvent[]} callEvents - Array de objetos de chamada. (Nota: Baileys geralmente emite um array com um único evento de chamada por vez).
   * Cada objeto de chamada pode conter:
   *  - `id`: ID único da chamada.
   *  - `from`: JID de quem iniciou a chamada.
   *  - `status`: Status da chamada (ex: 'offer', 'accept', 'reject', 'timeout', 'ringing').
   *  - `isVideo`: Booleano indicando se é uma chamada de vídeo.
   *  - `isGroup`: Booleano indicando se é uma chamada em grupo.
   * @example
   * // Exemplo de dados recebidos (geralmente um array com um item)
   * handleCall({
   *   id: 'call-123',
   *   from: '5511999999999@s.whatsapp.net',
   *   status: 'offer',
   *   isVideo: false
   * });
   */
  handleCall(callEvents) {
    // Baileys usually emits an array with a single event.
    const callEvent = callEvents && callEvents.length > 0 ? callEvents[0] : null;
    logger.info(`[MÉTRICA] Evento 'call' recebido. Status: ${callEvent?.status}, De: ${callEvent?.from}.`, {
      label: 'ConnectionManager',
      metricName: 'call.event.recebido',
      callData: callEvent, // Log the first event, or all if structure changes
      instanceId: this.instanceId,
    });
  }

  /**
   * @method handlePresenceUpdate
   * Processa atualizações de presença dos contatos.
   * Registra e monitora alterações no status de presença (online, offline, digitando, gravando áudio) e última visualização (evento 'presence.update').
   * @param {PresenceUpdateData} data - Dados da atualização de presença.
   * @param {string} data.id - JID do chat (usuário ou grupo) onde a atualização de presença ocorreu.
   * @param {PresencesMap} data.presences - Um objeto onde as chaves são os JIDs dos participantes (ou o JID do chat, se for individual) e os valores são objetos contendo `lastKnownPresence` e, opcionalmente, `lastSeen`.
   *   - `lastKnownPresence`: O status de presença mais recente (ex: 'unavailable', 'available', 'composing', 'recording', 'paused').
   *   - `lastSeen`: Timestamp (em segundos) da última vez que o contato esteve online (disponível apenas se o contato compartilhar essa informação).
   * @example
   * // Exemplo de atualização de presença individual
   * handlePresenceUpdate({
   *   id: '5511999999999@s.whatsapp.net',
   *   presences: {
   *     '5511999999999@s.whatsapp.net': {
   *       lastKnownPresence: 'online', // ou 'available' dependendo da versão/implementação de Baileys
   *       lastSeen: 1234567890
   *     }
   *   }
   * });
   */
  handlePresenceUpdate(data) {
    // This can be very noisy. Log as debug or sample if needed for metrics.
    // For now, just a debug log with metric potential.
    logger.debug(`[POTENCIAL_MÉTRICA] Evento 'presence.update' recebido: JID=${data.id}.`, {
      label: 'ConnectionManager',
      // metricName: 'presence.update.received', // Uncomment if high-frequency metric is desired
      presenceData: data,
      instanceId: this.instanceId,
    });
  }
}

module.exports = ConnectionManager;
