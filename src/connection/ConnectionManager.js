const { default: makeWASocket, Browsers, useMultiFileAuthState, DisconnectReason, getContentType } = require('baileys');
const pino = require('pino');
const path = require('path');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const { cleanEnv, num, str } = require('envalid');
const Redis = require('ioredis');
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
 * @typedef {Object} AuthenticationState - Estado de autenticação do Baileys.
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
  REDIS_HOST: str({ default: 'localhost' }),
  REDIS_PORT: num({ default: 6379 }),
  REDIS_PASSWORD: str({ default: ' ' }),
  REDIS_DB: num({ default: 0 }),
});

// Constantes para status de conexão
const STATUS = {
  CONNECTED: 'open',
  DISCONNECTED: 'close',
  CONNECTING: 'connecting',
};

/**
 * @const {string}
 * @description Prefixo utilizado para chaves de metadados de grupo no Redis.
 */
const REDIS_PREFIX_GROUP = 'group:';
/**
 * @const {string}
 * @description Prefixo utilizado para chaves de dados de chat no Redis.
 */
const REDIS_PREFIX_CHAT = 'chat:';
/**
 * @const {string}
 * @description Prefixo utilizado para chaves de dados de contato no Redis.
 */
const REDIS_PREFIX_CONTACT = 'contact:';
/**
 * @const {string}
 * @description Prefixo utilizado para chaves de dados de mensagem no Redis.
 */
const REDIS_PREFIX_MESSAGE = 'message:';

/**
 * @const {number}
 * @description TTL (Time To Live) em segundos para metadados de curta duração no Redis (e.g., grupos, chats). (1 hora)
 */
const REDIS_TTL_METADATA_SHORT = 3600;
/**
 * @const {number}
 * @description TTL (Time To Live) em segundos para metadados de longa duração no Redis (e.g., contatos). (24 horas)
 */
const REDIS_TTL_METADATA_LONG = 24 * 3600;
/**
 * @const {number}
 * @description TTL (Time To Live) em segundos para mensagens no Redis. (7 dias)
 */
const REDIS_TTL_MESSAGE = 7 * 24 * 3600;
/**
 * @const {number}
 * @description TTL (Time To Live) em segundos para recibos de mensagem no Redis (usado como fallback se o TTL da mensagem original não puder ser determinado). (7 dias)
 */
const REDIS_TTL_RECEIPT = 7 * 24 * 3600;

/**
 * @class ConnectionManager
 * @description
 * Gerencia a conexão com a API do WhatsApp Web, utilizando a biblioteca Baileys.
 * É responsável por estabelecer e manter a conexão, lidar com a autenticação,
 * gerenciar eventos de mensagens, grupos, contatos, e sincronizar esses dados
 * com um cache Redis e um banco de dados MySQL.
 * Implementa uma lógica de reconexão com backoff exponencial para lidar com
 * desconexões temporárias.
 *
 * @property {WASocket | null} client - A instância do cliente Baileys (socket) para interagir com o WhatsApp.
 * Inicializado como `null` e populado após a conexão bem-sucedida.
 * @property {RedisClient | null} redisClient - Cliente para interagir com o servidor Redis,
 * utilizado para cache de metadados, mensagens, chats e contatos.
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
   * e o cliente Redis.
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
    this.redisClient = null;
    this.client = null;
    this.reconnectionAttempts = 0;
    this.maxReconnectionAttempts = 10;
    this.isReconnecting = false;
    this.eventEmitter = new EventEmitter();

    this.initializeRedisClient();
  }

  /**
   * @method setCacheWithLog
   * @private
   * Método utilitário para salvar dados no cache Redis com logging.
   * @param {string} key - A chave para o cache.
   * @param {any} data - Os dados a serem salvos (serão stringificados).
   * @param {number} ttl - O Time To Live (TTL) em segundos.
   * @param {string} [context=''] - Contexto da operação para logging.
   * @returns {Promise<boolean>} True se salvo com sucesso, false caso contrário.
   */
  async setCacheWithLog(key, data, ttl, context = '') {
    try {
      if (this.redisClient) {
        await this.redisClient.set(key, JSON.stringify(data), 'EX', ttl);
        logger.debug(`Dados salvos no cache: ${key}`, {
          label: 'RedisCache',
          context,
          key,
          instanceId: this.instanceId,
        });
        return true;
      }
      logger.warn(`Cliente Redis não disponível. Não foi possível salvar no cache: ${key}`, {
        label: 'RedisCache',
        context,
        key,
        instanceId: this.instanceId,
      });
      return false;
    } catch (error) {
      logger.error(`Erro ao salvar no cache: ${key}. Erro: ${error.message}`, {
        label: 'RedisCache',
        error: error.message,
        stack: error.stack,
        context,
        key,
        instanceId: this.instanceId,
      });
      return false;
    }
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
      logger.debug(`Evento '${eventName}' emitido`, {
        label: 'EventEmitter',
        context,
        eventName,
        dataKeys: typeof data === 'object' && data !== null ? Object.keys(data) : undefined,
        dataType: typeof data,
        instanceId: this.instanceId,
      });
    } catch (error) {
      logger.error(`Erro ao emitir evento '${eventName}': ${error.message}`, {
        label: 'EventEmitter',
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
   * @method initializeRedisClient
   * Inicializa o cliente Redis para cache de dados.
   * Configura conexão, eventos e tratamento de erros do Redis.
   * Os detalhes da conexão (host, porta, senha, db) são obtidos das variáveis de ambiente.
   * Registra listeners para os eventos 'connect', 'ready' e 'error' do cliente Redis.
   * @throws {Error} Pode lançar um erro se a biblioteca `ioredis` não conseguir instanciar o cliente, embora a conexão em si seja assíncrona.
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

    this.redisClient.on('ready', () => {
      logger.info('Cliente Redis pronto para uso.', { label: 'RedisClient' });
    });

    this.redisClient.on('error', (err) => {
      logger.error('Erro na conexão com o Redis:', { label: 'RedisClient', message: err.message, stack: err.stack });
    });
  }
  /**
   * @method initialize
   * Inicializa a conexão principal com o WhatsApp.
   * Este método orquestra o carregamento do estado de autenticação e, em seguida,
   * tenta estabelecer a conexão com o WhatsApp.
   * @throws {Error} Propaga erros que podem ocorrer durante `loadAuthState` ou `connect`.
   */
  async initialize() {
    logger.info('Iniciando conexão com o WhatsApp...', { label: 'ConnectionManager' });
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
   * @method connect
   * Conecta-se ao WhatsApp usando o estado de autenticação carregado.
   * Configura o socket Baileys com as opções necessárias, incluindo logger, informações do navegador, e a função `cachedGroupMetadata` para otimizar o carregamento de metadados de grupo a partir do Redis.
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
        try {
          const data = await this.redisClient.get(`${REDIS_PREFIX_GROUP}${jid}`);
          if (data && this.redisClient) {
            logger.debug(`Cache HIT para metadados do grupo ${jid}`, { label: 'RedisCache', instanceId: this.instanceId });
            return JSON.parse(data);
          }
          logger.debug(`Cache MISS para metadados do grupo ${jid}`, { label: 'RedisCache', instanceId: this.instanceId });
        } catch (error) {
          logger.error(`Erro ao ler metadados do grupo ${jid} do cache Redis para cachedGroupMetadata: ${error.message}`, { label: 'RedisCache', jid, error: error.message, stack: error.stack, instanceId: this.instanceId });
        }
        return undefined; // Retorna undefined se não encontrar no cache ou se houver erro
      },
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
    logger.debug('Todos os manipuladores de eventos foram registrados.', { label: 'ConnectionManager' });
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
      logger.info('Código QR recebido. Por favor, escaneie com seu WhatsApp:');
      qrcode.generate(qr, { small: true });
    }

    if (connection === STATUS.CONNECTED) {
      logger.info('Conexão com o WhatsApp estabelecida com sucesso!', { label: 'ConnectionManager' });
      this.resetReconnectionState();
    }

    if (connection === STATUS.DISCONNECTED) {
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
   * @method handleIrrecoverableDisconnect
   * Manipula desconexão irrecuperável (ex: logout ou máximo de tentativas atingido).
   * Registra um erro informando o usuário sobre a situação e a necessidade de
   * remover os dados de autenticação e reiniciar para gerar um novo QR code.
   * Reseta o estado de reconexão.
   * @param {number|undefined} statusCode - O código de status da desconexão (pode ser `undefined`).
   */
  handleIrrecoverableDisconnect(statusCode) {
    logger.error(`Deslogado ou alcançou o número máximo de tentativas de reconexão. Por favor, remova o diretório 'auth_info_baileys' e reinicie a aplicação para gerar um novo QR code. (Código: ${statusCode})`, { label: 'ConnectionManager' });
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
    logger.info('Credenciais de autenticação salvas/atualizadas.', { label: 'ConnectionManager' });
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
   * 2. Se a mensagem tiver uma chave válida (`remoteJid` e `id`) e o cliente Redis estiver disponível, ela é processada.
   * 3. A mensagem, junto com seu tipo de conteúdo e um objeto `receipts` inicializado, é salva no cache Redis com um TTL definido por `REDIS_TTL_MESSAGE`.
   * 4. Se `this.mysqlDbManager` estiver configurado, a mensagem também é salva (upsert) no banco de dados MySQL.
   * 5. Erros durante o salvamento no Redis ou MySQL são registrados.
   */
  async handleMessagesUpsert(data) {
    const { messages, type } = data;
    logger.debug(`Evento 'messages.upsert' recebido. Número de mensagens: ${messages.length}. Tipo: ${type}`, { label: 'ConnectionManager', count: messages.length, type });

    for (const msg of messages) {
      const messageContentType = msg.message ? getContentType(msg.message) : null;

      const { key: messageKey } = msg;

      if (messageContentType) {
        logger.debug(`Tipo de conteúdo da mensagem ${messageKey?.id}: ${messageContentType}`, { label: 'ConnectionManager', messageKey, contentType: messageContentType, instanceId: this.instanceId });
      } else {
        logger.debug(`Não foi possível determinar o tipo de conteúdo para a mensagem ${messageKey?.id}`, { label: 'ConnectionManager', messageKey, instanceId: this.instanceId });
      }

      if (messageKey && messageKey.remoteJid && messageKey.id && this.redisClient) {
        const redisMessageCacheKey = `${REDIS_PREFIX_MESSAGE}${messageKey.remoteJid}:${messageKey.id}`;
        try {
          const messageToStore = {
            ...msg,
            receipts: msg.receipts || {},
            messageContentType,
            instanceId: this.instanceId,
          }; // prettier-ignore
          await this.setCacheWithLog(redisMessageCacheKey, messageToStore, REDIS_TTL_MESSAGE, 'messages.upsert');
          logger.info(`Mensagem ${messageKey.id} de ${messageKey.remoteJid} salva no Redis.`, { label: 'RedisCache', messageKey, instanceId: this.instanceId });

          let dataForEvent = { ...messageToStore }; // Manter a estrutura base do evento
          if (this.mysqlDbManager) {
            try {
              const dbPersistedMessage = await this.mysqlDbManager.upsertMessage(messageToStore);
              if (dbPersistedMessage && typeof dbPersistedMessage === 'object') {
                dataForEvent = { ...dataForEvent, ...dbPersistedMessage };
                logger.debug(`Mensagem ${messageKey.id} processada pelo MySQL. Dados do DB adicionados ao payload do evento.`, { label: 'ConnectionManager', messageKey, instanceId: this.instanceId });
              } else {
                logger.debug(`Mensagem ${messageKey.id} processada pelo MySQL, mas não retornou dados adicionais (ou retornou tipo inesperado). Evento usará dados pré-DB (com possível groupMetadata).`, { label: 'ConnectionManager', messageKey, dbReturn: dbPersistedMessage, instanceId: this.instanceId });
              }
            } catch (dbError) {
              logger.error(`Erro durante upsertMessage no MySQL para mensagem ${messageKey.id}: ${dbError.message}`, {
                label: 'SyncError',
                messageKey,
                error: dbError.message,
                stack: dbError.stack,
                instanceId: this.instanceId,
              });
            }
          }
          this.emitEvent('message:upsert:received', dataForEvent, 'messages.upsert');
        } catch (error) {
          logger.error(`Erro ao processar mensagem ${messageKey?.id} (Redis, enriquecimento ou emissão de evento): ${error.message}`, { label: 'SyncError', messageKey, error: error.message, stack: error.stack, instanceId: this.instanceId });
        }
      } else {
        logger.warn('Mensagem recebida sem chave completa, não foi possível processar.', { label: 'ConnectionManager', message: msg, instanceId: this.instanceId });
      }
      logger.debug(`Conteúdo da mensagem original: ${messageKey?.id}`, { label: 'ConnectionManager', messageKey, messageDetails: msg, instanceId: this.instanceId });
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
   * Método utilitário para buscar e atualizar metadados de grupo no Redis e MySQL.
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

      // Verificar cache primeiro se existingMetadata não for fornecido
      if (!existingMetadata && this.redisClient) {
        const cacheKey = `${REDIS_PREFIX_GROUP}${jid}`;
        const cachedData = await this.redisClient.get(cacheKey);
        if (cachedData) {
          existingMetadata = JSON.parse(cachedData);
          logger.debug(`Usando metadados em cache para grupo ${jid} no contexto '${context}'.`, {
            label: 'RedisCache',
            jid,
            context,
          });
        }
      }

      let finalMetadata = existingMetadata;
      if (!finalMetadata && this.client) {
        // Fetch from API if not provided or from cache
        finalMetadata = await this.client.groupMetadata(jid);
      }

      if (!this.validateGroupMetadata(finalMetadata)) {
        logger.warn(`Metadados de grupo inválidos ou não obtidos para ${jid} no contexto '${context}'.`, {
          label: 'ConnectionManager',
          jid,
          metadataAttempted: finalMetadata, // Log the attempted metadata
          context,
        });
        return null;
      }

      if (finalMetadata) {
        // Redundant check due to validateGroupMetadata, but safe
        const cacheKey = `${REDIS_PREFIX_GROUP}${jid}`;
        await this.setCacheWithLog(cacheKey, finalMetadata, REDIS_TTL_METADATA_SHORT, context);

        if (this.mysqlDbManager) {
          await this.mysqlDbManager.upsertGroup(finalMetadata);
          logger.debug(`Metadados do grupo ${jid} atualizados no MySQL${context ? ` (${context})` : ''}.`, {
            label: 'MySQLSync',
            jid,
            context,
          });
        }
        // Emitir evento após atualização bem-sucedida
        this.emitEvent('group:metadata:updated', { jid, metadata: finalMetadata, context }, context);
        return finalMetadata;
      }
      // This part should ideally not be reached if validateGroupMetadata works correctly
      // and finalMetadata is null/undefined. Kept for safety, but the log above is more specific.
      logger.warn(`Metadados do grupo ${jid} não puderam ser obtidos (após validação)${context ? ` (${context})` : ''}.`, {
        label: 'ConnectionManager',
        jid,
        context,
      });
      return null;
    } catch (error) {
      logger.error(`Erro ao atualizar metadados do grupo ${jid}${context ? ` (${context})` : ''}: ${error.message}`, {
        label: 'SyncError',
        jid,
        error: error.message,
        stack: error.stack,
        context,
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
   * 3. Se os metadados forem obtidos com sucesso e o cliente Redis estiver disponível, eles são salvos no cache Redis com a chave `group:<jid>` e TTL `REDIS_TTL_METADATA_SHORT`.
   * 4. Se `this.mysqlDbManager` estiver configurado, os metadados do grupo também são salvos (upsert) no banco de dados MySQL.
   * 5. Erros durante o processo são registrados.
   */
  async handleGroupsUpdate(updates) {
    logger.debug(`Evento 'groups.update' recebido. Número de atualizações: ${updates.length}`, {
      label: 'ConnectionManager',
      count: updates.length,
    });
    for (const groupUpdate of updates) {
      const jid = groupUpdate.id;
      if (jid) {
        await this.updateGroupMetadata(jid, null, 'groups.update');
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
   * 1. Após uma atualização de participante, busca os metadados atualizados do grupo usando `this.client.groupMetadata(jid)`.
   * 2. Se os metadados forem obtidos com sucesso e o cliente Redis estiver disponível, eles são salvos no cache Redis com a chave `group:<jid>` e TTL `REDIS_TTL_METADATA_SHORT`.
   * 3. Se `this.mysqlDbManager` estiver configurado, os metadados atualizados do grupo também são salvos (upsert) no banco de dados MySQL.
   * 4. Erros durante o processo são registrados.
   */
  async handleGroupParticipantsUpdate(event) {
    const { id: jid, action, participants } = event;
    logger.debug(`Evento 'group-participants.update' recebido para o grupo ${jid}. Ação: ${action}. Participantes: ${participants.join(', ')}`, {
      label: 'ConnectionManager',
      jid,
      action,
      participants,
    });

    await this.updateGroupMetadata(jid, null, 'group-participants.update');
  }

  /**
   * @method handleGroupsUpsert
   * Manipula a inserção/atualização de grupos (quando o usuário entra em um novo grupo ou sincronização inicial).
   * Este evento é geralmente disparado quando o cliente se conecta e sincroniza a lista de grupos,
   * ou quando o usuário entra em um novo grupo (evento 'groups.upsert').
   * @param {GroupMetadata[]} groups - Array de objetos completos de metadados de grupo.
   *
   * @description
   * Para cada metadado de grupo recebido:
   * 1. Se o cliente Redis estiver disponível, salva os metadados no cache Redis com a chave `group:<jid>` e TTL `REDIS_TTL_METADATA_SHORT`.
   * 2. Se `this.mysqlDbManager` estiver configurado, os metadados do grupo também são salvos (upsert) no banco de dados MySQL.
   * 3. Erros durante o processo são registrados.
   */
  async handleGroupsUpsert(groups) {
    logger.debug(`Evento 'groups.upsert' recebido. Número de grupos: ${groups.length}`, {
      label: 'ConnectionManager',
      count: groups.length,
    });
    for (const groupMetadata of groups) {
      const jid = groupMetadata.id;
      if (jid) {
        await this.updateGroupMetadata(jid, groupMetadata, 'groups.upsert');
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
   * - Para cada chat: Se o cliente Redis estiver disponível, salva no Redis (chave `chat:<id>`, TTL `REDIS_TTL_METADATA_SHORT`) e no MySQL (via `this.mysqlDbManager.upsertChat`).
   * - Para cada contato: Se o cliente Redis estiver disponível, salva no Redis (chave `contact:<id>`, TTL `REDIS_TTL_METADATA_LONG`). (Atualmente não salva contatos no MySQL neste handler).
   * - Para cada mensagem: Determina o tipo de conteúdo. Se o cliente Redis estiver disponível, salva no Redis (chave `message:<remoteJid>:<id>`, TTL `REDIS_TTL_MESSAGE`) e no MySQL (via `this.mysqlDbManager.upsertMessage`).
   * Erros durante o salvamento são registrados.
   */
  async handleMessagingHistorySet(data) {
    const { chats, contacts, messages } = data;
    logger.info(`Evento 'messaging-history.set' recebido. Chats: ${chats.length}, Contatos: ${contacts.length}, Mensagens: ${messages.length}`, { label: 'ConnectionManager', counts: { chats: chats.length, contacts: contacts.length, messages: messages.length } });

    for (const chat of chats) {
      if (chat.id) {
        try {
          // prettier-ignore
          await this.setCacheWithLog(`${REDIS_PREFIX_CHAT}${chat.id}`, chat, REDIS_TTL_METADATA_SHORT, 'messaging-history.set.chat');
          logger.debug(`Chat ${chat.id} do histórico salvo no Redis.`, { label: 'RedisCache', jid: chat.id });

          if (this.mysqlDbManager) {
            await this.mysqlDbManager.upsertChat(chat);
          }
        } catch (error) {
          logger.error(`Erro ao salvar chat ${chat.id} do histórico no Redis ou MySQL: ${error.message}`, { label: 'SyncError', jid: chat.id, errorMessage: error.message, errorStack: error.stack, chatObject: JSON.stringify(chat) });
        }
      }
    }

    for (const contact of contacts) {
      if (contact.id) {
        try {
          await this.setCacheWithLog(`${REDIS_PREFIX_CONTACT}${contact.id}`, contact, REDIS_TTL_METADATA_LONG, 'messaging-history.set.contact');
          logger.debug(`Contato ${contact.id} do histórico salvo no Redis.`, { label: 'RedisCache', jid: contact.id });
        } catch (error) {
          logger.error(`Erro ao salvar contato ${contact.id} do histórico no Redis: ${error.message}`, { label: 'RedisCache', jid: contact.id, error: error.message });
        }
      }
    }

    for (const msg of messages) {
      logger.debug(`Mensagem do histórico recebida: ${msg.key?.id} de ${msg.key?.remoteJid}`, { label: 'ConnectionManager', messageKey: msg.key });
      if (msg.key && msg.key.remoteJid && msg.key.id && this.redisClient) {
        const messageContentType = msg.message ? getContentType(msg.message) : null;
        try {
          const messageToStore = { ...msg, receipts: msg.receipts || {}, messageContentType };
          await this.setCacheWithLog(`${REDIS_PREFIX_MESSAGE}${msg.key.remoteJid}:${msg.key.id}`, messageToStore, REDIS_TTL_MESSAGE, 'messaging-history.set.message');
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
   * @method handleMessagesUpdate
   * Manipula atualizações de mensagens.
   * Este evento é disparado para atualizações em mensagens existentes (ex: status de entrega, edição - se suportado) (evento 'messages.update').
   * @param {WAMessageUpdate[]} updates - Array de objetos de atualização de mensagem.
   * Cada objeto contém a `key` da mensagem e o `update` com os campos alterados.
   * @description Atualmente, este método apenas registra as atualizações recebidas. Nenhuma ação de persistência ou cache é realizada aqui.
   */
  handleMessagesUpdate(updates) {
    logger.debug(`Evento 'messages.update' recebido. Número de atualizações: ${updates.length}`, { label: 'ConnectionManager', count: updates.length });
    updates.forEach((update) => {
      logger.debug(`Atualização de mensagem: Chave=${update.key?.id}, JID=${update.key?.remoteJid}, Update=${JSON.stringify(update.update)}`, { label: 'ConnectionManager', messageUpdate: update });
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
    logger.debug(`Evento 'messages.delete' recebido: ${JSON.stringify(deletion)}`, { label: 'ConnectionManager', deletion });
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
    logger.debug(`Evento 'messages.reaction' recebido. Número de reações: ${reactions.length}`, { label: 'ConnectionManager', count: reactions.length });
    reactions.forEach((reaction) => {
      logger.debug(`Reação: ChaveMsg=${reaction.key?.id}, JID=${reaction.key?.remoteJid}, Reação=${reaction.reaction.text}`, { label: 'ConnectionManager', reaction });
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
   * 2. Tenta buscar a mensagem correspondente no cache Redis.
   * 3. Se a mensagem for encontrada:
   *    a. Atualiza o objeto `receipts` dentro dos dados da mensagem com as novas informações do recibo.
   *    b. Salva a mensagem atualizada de volta no Redis, preservando o TTL original se possível, ou usando `REDIS_TTL_MESSAGE` como fallback.
   *    c. Se `this.mysqlDbManager` estiver configurado, salva (upsert) o recibo no banco de dados MySQL.
   * 4. Se a mensagem não for encontrada no cache (ou Redis não estiver disponível), registra um aviso.
   * 5. Erros durante o processo são registrados.
   */
  async handleMessageReceiptUpdate(receipts) {
    logger.debug(`Evento 'message-receipt.update' recebido. Número de recibos: ${receipts.length}`, { label: 'ConnectionManager', count: receipts.length });
    for (const receiptUpdate of receipts) {
      const { key, receipt } = receiptUpdate;
      if (key && key.remoteJid && key.id && receipt && receipt.userJid) {
        try {
          // prettier-ignore
          const messageCacheKey = `${REDIS_PREFIX_MESSAGE}${key.remoteJid}:${key.id}`;
          const messageJSON = this.redisClient ? await this.redisClient.get(messageCacheKey) : null;
          if (messageJSON && this.redisClient) {
            const messageData = JSON.parse(messageJSON);
            messageData.receipts = messageData.receipts || {};
            messageData.receipts[receipt.userJid] = {
              type: receipt.type,
              timestamp: receipt.receiptTimestamp || receipt.readTimestamp || receipt.playedTimestamp,
            };
            const ttl = await this.redisClient.ttl(messageCacheKey);
            const finalTTL = (ttl !== null && ttl > 0) ? ttl : REDIS_TTL_MESSAGE; // prettier-ignore
            await this.setCacheWithLog(messageCacheKey, messageData, finalTTL, 'message-receipt.update');
            logger.info(`Recibo para mensagem ${key.id} (usuário ${receipt.userJid}, tipo ${receipt.type}) atualizado no Redis.`, { label: 'RedisCache', messageKey: key, userJid: receipt.userJid, receiptType: receipt.type });

            if (this.mysqlDbManager) {
              const timestamp = receipt.receiptTimestamp || receipt.readTimestamp || receipt.playedTimestamp;
              await this.mysqlDbManager.upsertMessageReceipt(key, receipt.userJid, receipt.type, timestamp);
            }
          } else {
            logger.warn(`Mensagem ${key.id} não encontrada no cache Redis (ou Redis indisponível) para atualizar recibo.`, { label: 'RedisCache', messageKey: key });
          }
        } catch (error) {
          logger.error(`Erro ao processar recibo para mensagem ${key.id} no Redis ou MySQL: ${error.message}`, { label: 'SyncError', messageKey: key, error: error.message });
        }
      }
      logger.debug(`Detalhes do Recibo: ChaveMsg=${key?.id}, JID=${key?.remoteJid}, Status=${receipt?.type}, UserJid=${receipt?.userJid}`, { label: 'ConnectionManager', receipt: receiptUpdate });
    }
  }

  /**
   * @method handleChatsUpsert
   * Manipula inserção/atualização de chats.
   * Este evento é disparado quando novos chats são criados ou chats existentes são sincronizados (evento 'chats.upsert').
   * @param {Chat[]} chats - Array de objetos de chat.
   *
   * @description
   * Para cada chat:
   * 1. Se o cliente Redis estiver disponível, salva o objeto do chat no cache Redis com a chave `chat:<id>` e TTL `REDIS_TTL_METADATA_SHORT`.
   * 2. Se `this.mysqlDbManager` estiver configurado, salva (upsert) o chat no banco de dados MySQL.
   * 3. Erros durante o processo são registrados.
   */
  async handleChatsUpsert(chats) {
    logger.debug(`Evento 'chats.upsert' recebido. Número de chats: ${chats.length}`, { label: 'ConnectionManager', count: chats.length });
    for (const chat of chats) {
      if (chat.id) {
        try {
          await this.setCacheWithLog(`${REDIS_PREFIX_CHAT}${chat.id}`, chat, REDIS_TTL_METADATA_SHORT, 'chats.upsert');
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
   * @method handleChatsUpdate
   * Manipula atualizações de chats.
   * Este evento é disparado quando propriedades de um chat existente são alteradas (ex: `unreadCount`, `mute`) (evento 'chats.update').
   * @param {Array<Partial<Chat>>} updates - Array de atualizações parciais de chat. Cada objeto deve ter pelo menos a propriedade `id`.
   *
   * @description
   * Para cada atualização de chat:
   * 1. Se o cliente Redis estiver disponível, salva o objeto de atualização do chat no cache Redis com a chave `chat:<id>` e TTL `REDIS_TTL_METADATA_SHORT`. (Nota: Isso pode sobrescrever o chat completo com um objeto parcial se não for tratado com cuidado ao ler do cache).
   * 2. Se `this.mysqlDbManager` estiver configurado, salva (upsert) a atualização do chat no banco de dados MySQL.
   * 3. Erros durante o processo são registrados.
   */
  async handleChatsUpdate(updates) {
    logger.debug(`Evento 'chats.update' recebido. Número de atualizações: ${updates.length}`, { label: 'ConnectionManager', count: updates.length });
    for (const chatUpdate of updates) {
      if (chatUpdate.id) {
        try {
          await this.setCacheWithLog(`${REDIS_PREFIX_CHAT}${chatUpdate.id}`, chatUpdate, REDIS_TTL_METADATA_SHORT, 'chats.update');
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
   * @method handleChatsDelete
   * Manipula exclusão de chats.
   * Este evento é disparado quando chats são deletados (evento 'chats.delete').
   * @param {Array<string>} jids - Array de JIDs (identificadores) dos chats que foram excluídos.
   *
   * @description
   * Para cada JID de chat excluído:
   * 1. Se o cliente Redis estiver disponível, remove o chat do cache Redis usando a chave `chat:<jid>`.
   * 2. Se `this.mysqlDbManager` estiver configurado, chama `this.mysqlDbManager.deleteChatData(jid)` para remover os dados associados ao chat do banco de dados MySQL.
   * 3. Erros durante o processo são registrados.
   */
  async handleChatsDelete(jids) {
    logger.debug(`Evento 'chats.delete' recebido. Número de JIDs: ${jids.length}`, { label: 'ConnectionManager', count: jids.length });
    for (const jid of jids) {
      try {
        const cacheKey = `${REDIS_PREFIX_CHAT}${jid}`;
        if (this.redisClient) await this.redisClient.del(cacheKey);
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
   * @method handleContactsUpsert
   * Manipula inserção/atualização de contatos.
   * Este evento é disparado quando novos contatos são adicionados ou contatos existentes são sincronizados (evento 'contacts.upsert').
   * @param {Contact[]} contacts - Array de objetos de contato.
   *
   * @description
   * Para cada contato:
   * 1. Se o cliente Redis estiver disponível, salva o objeto do contato no cache Redis com a chave `contact:<id>` e TTL `REDIS_TTL_METADATA_LONG`.
   * 2. Erros durante o salvamento no Redis são registrados. (Atualmente, não há persistência de contatos no MySQL neste handler).
   */
  async handleContactsUpsert(contacts) {
    logger.debug(`Evento 'contacts.upsert' recebido. Número de contatos: ${contacts.length}`, { label: 'ConnectionManager', count: contacts.length });
    for (const contact of contacts) {
      if (contact.id) {
        try {
          await this.setCacheWithLog(`${REDIS_PREFIX_CONTACT}${contact.id}`, contact, REDIS_TTL_METADATA_LONG, 'contacts.upsert');
          logger.info(`Contato ${contact.id} (upsert) salvo no Redis.`, { label: 'RedisCache', jid: contact.id });
        } catch (error) {
          logger.error(`Erro ao salvar contato ${contact.id} (upsert) no Redis: ${error.message}`, { label: 'RedisCache', jid: contact.id, error: error.message });
        }
      }
    }
  }

  /**
   * @method handleContactsUpdate
   * Manipula a atualização de contatos no sistema.
   * Responsável por atualizar as informações de contato no cache Redis.
   * Este evento é disparado quando propriedades de um contato existente são alteradas (ex: nome, notificação push) (evento 'contacts.update').
   * @param {Array<Partial<Contact>>} updates - Array de atualizações parciais de contatos. Cada objeto deve ter pelo menos a propriedade `id`.
   *
   * @description
   * Para cada atualização de contato:
   * 1. Se o cliente Redis estiver disponível, salva o objeto de atualização do contato no cache Redis com a chave `contact:<id>` e TTL `REDIS_TTL_METADATA_LONG`. (Nota: Isso pode sobrescrever o contato completo com um objeto parcial se não for tratado com cuidado ao ler do cache).
   * 2. Erros durante o salvamento no Redis são registrados. (Atualmente, não há persistência de contatos no MySQL neste handler).
   * @example
   * // Exemplo de update recebido
   * handleContactsUpdate([{
   *   id: '5511999999999@s.whatsapp.net',
   *   name: 'Novo Nome',
   *   notify: 'Notificação'
   * }]);
   */
  async handleContactsUpdate(updates) {
    logger.debug(`Evento 'contacts.update' recebido. Número de atualizações: ${updates.length}`, { label: 'ConnectionManager', count: updates.length });
    for (const contactUpdate of updates) {
      if (contactUpdate.id) {
        try {
          await this.setCacheWithLog(`${REDIS_PREFIX_CONTACT}${contactUpdate.id}`, contactUpdate, REDIS_TTL_METADATA_LONG, 'contacts.update');
          logger.info(`Contato ${contactUpdate.id} (update) atualizado no Redis.`, { label: 'RedisCache', jid: contactUpdate.id });
        } catch (error) {
          logger.error(`Erro ao atualizar contato ${contactUpdate.id} (update) no Redis: ${error.message}`, { label: 'RedisCache', jid: contactUpdate.id, error: error.message });
        }
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
    logger.info(`Evento 'blocklist.set' recebido: ${JSON.stringify(data)}`, { label: 'ConnectionManager', blocklist: data });
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
    logger.info(`Evento 'blocklist.update' recebido: ${JSON.stringify(data)}`, { label: 'ConnectionManager', blocklistUpdate: data });
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
    logger.info(`Evento 'call' recebido: ${JSON.stringify(callEvents)}`, { label: 'ConnectionManager', callData: callEvents });
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
    logger.debug(`Evento 'presence.update' recebido: JID=${data.id}, Presences=${JSON.stringify(data.presences)}`, { label: 'ConnectionManager', presence: data });
  }
}

module.exports = ConnectionManager;
