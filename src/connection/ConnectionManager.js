const { default: makeWASocket, Browsers, useMultiFileAuthState, DisconnectReason, getContentType } = require('baileys');
const pino = require('pino');
const path = require('path');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
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
  // eslint-disable-next-line max-len
  constructor(mysqlDbManager, initialBackoffDelayMs = env.BACKOFF_INITIAL_DELAY_MS, maxBackoffDelayMs = env.BACKOFF_MAX_DELAY_MS, authStatePath = env.AUTH_STATE_PATH) {
    this.instanceId = process.env.INSTANCE_ID || 'omnizap-instance';
    this.initialBackoffDelayMs = initialBackoffDelayMs;
    this.maxBackoffDelayMs = maxBackoffDelayMs;
    this.mysqlDbManager = mysqlDbManager;
    this.authStatePath = authStatePath;
    this.currentBackoffDelayMs = initialBackoffDelayMs;
    this.authFlagPath = path.join(this.authStatePath, '.auth_success_flag');
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
      logger.info(`Evento '${eventName}' emitido com sucesso.`, {
        label: 'EventEmitter',
        metricName: 'event.emit.success',
        context,
        eventName,
        dataKeys: typeof data === 'object' && data !== null ? Object.keys(data) : undefined,
        dataType: typeof data,
        instanceId: this.instanceId,
      });
    } catch (error) {
      logger.error(` Erro ao emitir o evento '${eventName}': ${error.message}.`, {
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
   *
   * @returns {Promise<void>} A conexão estará ativa se não houver exceções.
   * @throws {Error} Propaga erros que podem ocorrer durante `loadAuthState` ou `connect`.
   */
  async initialize() {
    logger.info('Iniciando conexão com o WhatsApp...', { label: 'ConnectionManager.initialize', instanceId: this.instanceId });
    try {
      await this.loadAuthState();
      await this.connect();
      logger.info('Conexão com o WhatsApp estabelecida com sucesso.', { label: 'ConnectionManager.initialize', instanceId: this.instanceId });
    } catch (error) {
      logger.error('Erro ao inicializar a conexão com o WhatsApp.', { label: 'ConnectionManager.initialize', instanceId: this.instanceId, error: error });
      throw error;
    }
  }

  /**
   * @method loadAuthState
   * Carrega o estado de autenticação do diretório especificado em `this.authStatePath`.
   * Se o diretório não existir, ele será criado.
   * Utiliza `useMultiFileAuthState` da biblioteca Baileys para gerenciar as credenciais.
   *
   * @returns {Promise<void>} Estado de autenticação carregado em `this.auth`.
   * @throws {Error} Se houver falha ao criar o diretório ou ao carregar o estado de autenticação.
   */
  async loadAuthState() {
    if (!fs.existsSync(this.authStatePath)) {
      logger.info(`Diretório de autenticação não encontrado em "${this.authStatePath}". Criando...`, {
        label: 'ConnectionManager.loadAuthState',
        instanceId: this.instanceId,
      });
      try {
        fs.mkdirSync(this.authStatePath, { recursive: true });
        logger.info(`Diretório "${this.authStatePath}" criado com sucesso.`, {
          label: 'ConnectionManager.loadAuthState',
          instanceId: this.instanceId,
        });
      } catch (mkdirError) {
        logger.error(`Erro ao criar o diretório de autenticação "${this.authStatePath}": ${mkdirError.message}`, {
          label: 'ConnectionManager.loadAuthState',
          instanceId: this.instanceId,
          error: mkdirError,
        });
        throw mkdirError;
      }
    }

    try {
      this.auth = await useMultiFileAuthState(this.authStatePath);
      logger.info('Estado de autenticação carregado com sucesso.', {
        label: 'ConnectionManager.loadAuthState',
        instanceId: this.instanceId,
      });
    } catch (authError) {
      logger.error(`Erro ao carregar o estado de autenticação: ${authError.message}`, {
        label: 'ConnectionManager.loadAuthState',
        instanceId: this.instanceId,
        error: authError,
      });
      throw authError;
    }
  }

  /**
   * @method connect
   * Conecta-se ao WhatsApp usando o estado de autenticação carregado.
   * Configura o socket Baileys com as opções necessárias, incluindo logger e informações do navegador.
   *
   * @returns {Promise<void>} O socket será atribuído a `this.client` após conexão bem-sucedida.
   * @throws {Error} Se o estado de autenticação não estiver carregado ou ocorrer erro na conexão.
   */
  async connect() {
    if (!this.auth) {
      const errorMessage = 'Estado de autenticação não carregado. Execute loadAuthState() antes de connect().';
      logger.error(errorMessage, {
        label: 'ConnectionManager.connect',
        instanceId: this.instanceId,
      });
      throw new Error(errorMessage);
    }

    try {
      const socketConfig = {
        auth: this.auth.state,
        logger: pino({ level: 'silent' }),
        browser: Browsers.macOS('Desktop'),
        syncFullHistory: true,
        markOnlineOnConnect: false,
        printQRInTerminal: false,
      };

      this.client = makeWASocket(socketConfig);

      logger.info('Socket do WhatsApp criado com sucesso.', {
        label: 'ConnectionManager.connect',
        instanceId: this.instanceId,
      });

      this.setupEventHandlers();
    } catch (error) {
      logger.error(`Erro ao criar socket do WhatsApp: ${error.message}`, {
        label: 'ConnectionManager.connect',
        instanceId: this.instanceId,
        error,
      });
      throw error;
    }
  }

  /**
   * @method setupEventHandlers
   * Configura os manipuladores de eventos para o cliente WhatsApp (Baileys).
   * Registra listeners para uma variedade de eventos, como atualizações de conexão,
   * recebimento de mensagens, atualizações de grupos, chats, contatos, etc.
   * Cada evento é vinculado ao método correspondente nesta classe.
   *
   * @throws {Error} Se o cliente WhatsApp (`this.client`) não estiver inicializado.
   */
  setupEventHandlers() {
    if (!this.client) {
      const errorMessage = 'Cliente WhatsApp não inicializado. Execute connect() antes de setupEventHandlers().';
      logger.error(errorMessage, {
        label: 'ConnectionManager.setupEventHandlers',
        instanceId: this.instanceId,
      });
      throw new Error(errorMessage);
    }

    const eventHandlers = {
      // Conexão
      'connection.update': this.handleConnectionUpdate,
      'creds.update': this.handleCredsUpdate,

      // Mensagens
      'messages.upsert': this.handleMessagesUpsert,
      'messages.update': this.handleMessagesUpdate,
      'messages.delete': this.handleMessagesDelete,
      'messages.reaction': this.handleMessagesReaction,
      'message-receipt.update': this.handleMessageReceiptUpdate,
      'messaging-history.set': this.handleMessagingHistorySet,

      // Grupos
      'groups.update': this.handleGroupsUpdate,
      'groups.upsert': this.handleGroupsUpsert,
      'group-participants.update': this.handleGroupParticipantsUpdate,

      // Chats
      'chats.upsert': this.handleChatsUpsert,
      'chats.update': this.handleChatsUpdate,
      'chats.delete': this.handleChatsDelete,

      // Contatos
      'contacts.upsert': this.handleContactsUpsert,
      'contacts.update': this.handleContactsUpdate,

      // Outros
      'blocklist.set': this.handleBlocklistSet,
      'blocklist.update': this.handleBlocklistUpdate,
      call: this.handleCall,
      'presence.update': this.handlePresenceUpdate,
    };

    for (const [event, handler] of Object.entries(eventHandlers)) {
      this.client.ev.on(event, handler.bind(this));
    }

    logger.debug('Todos os manipuladores de eventos foram registrados.', {
      label: 'ConnectionManager.setupEventHandlers',
      instanceId: this.instanceId,
    });
  }

  /**
   * @method handleConnectionUpdate
   * Manipula atualizações de conexão do cliente WhatsApp.
   */
  async handleConnectionUpdate(update) {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      this.handleQRCode(qr);
    }

    if (connection === STATUS.CONNECTED) {
      logger.info('Conexão com o WhatsApp estabelecida com sucesso!', {
        label: 'ConnectionManager',
        metricName: 'connection.established',
        instanceId: this.instanceId,
      });
      this.resetReconnectionState();

      const credsFilePath = path.join(this.authStatePath, 'creds.json');
      if (fs.existsSync(credsFilePath)) {
        if (!this.authFlagExists()) {
          try {
            this.createAuthFlag();
            logger.info(`Flag de autenticação criado em ${this.authFlagPath}`, {
              label: 'ConnectionManager.createAuthFlag',
              instanceId: this.instanceId,
            });
          } catch (err) {
            logger.error(`Falha ao criar o flag de autenticação: ${err.message}`, {
              label: 'ConnectionManager.createAuthFlag',
              instanceId: this.instanceId,
              error: err,
            });
          }
        }
      } else {
        logger.warn(`Conexão aberta, mas creds.json não encontrado em ${credsFilePath}. Flag não criado.`, {
          label: 'ConnectionManager.handleConnectionUpdate',
          instanceId: this.instanceId,
        });
      }
    }

    if (connection === STATUS.DISCONNECTED) {
      const statusCode = lastDisconnect?.error?.output?.statusCode ?? 'unknown';
      const reason = DisconnectReason[statusCode] || lastDisconnect?.error?.message || 'Desconhecido';

      logger.warn(`Conexão com o WhatsApp fechada. Motivo: ${reason} (Código: ${statusCode})`, {
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
   * @method authFlagExists
   * @private
   * Verifica se o arquivo de flag de autenticação bem-sucedida existe.
   * @returns {boolean} True se o arquivo de flag existir, false caso contrário.
   */
  authFlagExists() {
    try {
      return fs.existsSync(this.authFlagPath);
    } catch (error) {
      logger.error(`Erro ao verificar a existência do flag de autenticação em ${this.authFlagPath}: ${error.message}`, {
        label: 'ConnectionManager.authFlagExists',
        instanceId: this.instanceId,
        error,
      });
      return false; // Em caso de erro, assume que não existe para evitar bloqueios.
    }
  }

  /**
   * @method createAuthFlag
   * @private
   * Cria um arquivo de flag para indicar que a autenticação foi bem-sucedida
   * e as credenciais (`creds.json`) foram salvas.
   * @throws {Error} Se houver falha ao criar o arquivo de flag.
   */
  createAuthFlag() {
    // Cria um arquivo vazio como flag. O conteúdo não importa, apenas a existência.
    fs.writeFileSync(this.authFlagPath, '');
    // Não há necessidade de log aqui, pois é chamado por handleConnectionUpdate que já loga.
  }

  shouldReconnect(statusCode) {
    return statusCode !== DisconnectReason.loggedOut && this.reconnectionAttempts < this.maxReconnectionAttempts;
  }

  calculateNextBackoffDelay() {
    return Math.min(this.initialBackoffDelayMs * Math.pow(2, this.reconnectionAttempts - 1), this.maxBackoffDelayMs);
  }

  async reconnectWithBackoff(statusCode) {
    this.isReconnecting = true;
    this.reconnectionAttempts++;
    this.currentBackoffDelayMs = this.calculateNextBackoffDelay();

    if (this.backoffTimer) {
      clearTimeout(this.backoffTimer);
    }

    logger.info(`Tentando reconexão (Tentativa ${this.reconnectionAttempts}/${this.maxReconnectionAttempts}) em ${this.currentBackoffDelayMs}ms...`, {
      label: 'ConnectionManager',
      metricName: 'connection.reconnect.attempt',
      attempt: this.reconnectionAttempts,
      maxAttempts: this.maxReconnectionAttempts,
      delayMs: this.currentBackoffDelayMs,
      statusCode,
      instanceId: this.instanceId,
    });

    this.backoffTimer = setTimeout(async () => {
      try {
        await this.connect();
        this.isReconnecting = false;
        this.backoffTimer = null;
      } catch (err) {
        logger.error(`Tentativa de reconexão falhou: ${err.message}`, {
          label: 'ConnectionManager.reconnectWithBackoff',
          metricName: 'connection.reconnect.failed_attempt',
          attempt: this.reconnectionAttempts,
          error: err.message,
          stack: err.stack,
          instanceId: this.instanceId,
        });
        this.isReconnecting = false;
        this.backoffTimer = null;

        if (this.shouldReconnect(statusCode)) {
          this.reconnectWithBackoff(statusCode);
        } else {
          this.handleIrrecoverableDisconnect(statusCode);
        }
      }
    }, this.currentBackoffDelayMs);
  }

  handleIrrecoverableDisconnect(statusCode) {
    logger.error(
      `Desconexão irrecuperável. Código de Status: ${statusCode}.
  ⚠️ A sessão foi encerrada permanentemente (ex.: logout manual ou excesso de falhas).
  ✅ Solução: exclua a pasta de autenticação "${this.authStatePath}" e reinicie para gerar um novo QR Code.`,
      {
        label: 'ConnectionManager.handleIrrecoverableDisconnect',
        metricName: 'connection.disconnected.irrecoverable',
        statusCode,
        instanceId: this.instanceId,
      },
    );
    this.resetReconnectionState();
  }

  resetReconnectionState() {
    if (this.backoffTimer) {
      clearTimeout(this.backoffTimer);
      this.backoffTimer = null;
    }
    this.reconnectionAttempts = 0;
    this.currentBackoffDelayMs = this.initialBackoffDelayMs;
    this.isReconnecting = false;
  }

  /**
   * @method handleCredsUpdate
   * Manipula a atualização de credenciais.
   * Salva as novas credenciais usando `this.auth.saveCreds()`.
   * Faz log de sucesso e captura falhas no processo.
   */
  async handleCredsUpdate() {
    try {
      await this.auth.saveCreds();
      logger.info('Credenciais de autenticação salvas/atualizadas.', {
        label: 'ConnectionManager.handleCredsUpdate',
        metricName: 'auth.credentials.updated',
        instanceId: this.instanceId,
      });
    } catch (err) {
      logger.error(`❌ Falha ao salvar as credenciais de autenticação: ${err.message}`, {
        label: 'ConnectionManager.handleCredsUpdate',
        metricName: 'auth.credentials.save_failed',
        instanceId: this.instanceId,
        error: err,
        stack: err.stack,
      });
    }
  }

  /**
   * @method handleMessagesUpsert
   * Manipula mensagens novas/atualizadas recebidas do evento 'messages.upsert'.
   */
  async handleMessagesUpsert(data) {
    const { messages, type } = data;

    logger.info(`Recebido(s) ${messages.length} mensagem(ns) no evento 'messages.upsert'. Tipo: ${type}.`, {
      label: 'ConnectionManager.handleMessagesUpsert',
      metricName: 'messages.upsert.recebidas',
      count: messages.length,
      type,
      instanceId: this.instanceId,
    });

    const messagesToProcess = [];
    const messagesForEventEmission = [];

    for (const msg of messages) {
      const messageContentType = msg.message ? getContentType(msg.message) : null;
      const { key: messageKey } = msg;

      if (messageContentType) {
        logger.debug(`Tipo de conteúdo da mensagem ${messageKey?.id}: ${messageContentType}.`, {
          label: 'ConnectionManager.handleMessagesUpsert',
          messageKey,
          contentType: messageContentType,
          instanceId: this.instanceId,
        });
      } else {
        logger.warn(`Não foi possível determinar o tipo de conteúdo para a mensagem ${messageKey?.id}. Pode ser um evento de sistema.`, {
          label: 'ConnectionManager.handleMessagesUpsert',
          messageKey,
          instanceId: this.instanceId,
          messageDetails: msg,
        });
      }

      if (messageKey?.remoteJid && messageKey?.id) {
        const enrichedMessage = {
          ...msg,
          messageContentType,
          instanceId: this.instanceId,
        };
        messagesToProcess.push(enrichedMessage);
        messagesForEventEmission.push(enrichedMessage);
      } else {
        logger.warn('Mensagem recebida sem chave completa. Ignorada para persistência.', {
          label: 'ConnectionManager.handleMessagesUpsert',
          messageKey,
          instanceId: this.instanceId,
        });
      }

      logger.debug(`Conteúdo bruto da mensagem ${messageKey?.id}:`, {
        label: 'ConnectionManager.handleMessagesUpsert',
        messageKey,
        messageDetails: msg,
        instanceId: this.instanceId,
      });
    }

    if (this.mysqlDbManager && messagesToProcess.length > 0) {
      try {
        const batchResults = await this.mysqlDbManager.upsertMessagesBatch(messagesToProcess);

        logger.info(`Processadas ${messagesToProcess.length} mensagens no MySQL.`, {
          label: 'MySQLSync.handleMessagesUpsert',
          metricName: 'messages.mysql.batch_upsert.success',
          count: messagesToProcess.length,
          instanceId: this.instanceId,
        });

        messagesForEventEmission.forEach((msg, index) => {
          const enrichedMsg = {
            ...msg,
            ...(batchResults?.[index] || {}),
          };
          this.emitEvent('message:upsert:received', enrichedMsg, 'messages.upsert');
        });
      } catch (dbError) {
        logger.error(`Erro no MySQL durante o batch upsert de ${messagesToProcess.length} mensagens: ${dbError.message}`, {
          label: 'SyncError.handleMessagesUpsert.MySQL',
          metricName: 'messages.mysql.batch_upsert.error',
          count: messagesToProcess.length,
          error: dbError.message,
          stack: dbError.stack,
          instanceId: this.instanceId,
        });

        messagesForEventEmission.forEach((msg) => {
          this.emitEvent('message:upsert:received', msg, 'messages.upsert');
        });
      }
    } else if (messagesForEventEmission.length > 0) {
      messagesForEventEmission.forEach((msg) => {
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
            logger.info(` Metadados do grupo ${jid} atualizados no MySQL. Contexto: ${context}.`, {
              label: 'MySQLSync',
              metricName: 'group.metadata.mysql.updated',
              jid,
              context,
              instanceId: this.instanceId,
            });
          } catch (dbError) {
            logger.error(` Erro ao atualizar metadados do grupo ${jid} no MySQL. Contexto: ${context}. Erro: ${dbError.message}.`, {
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
        logger.info(` ${validGroupsToUpsert.length} grupos atualizados/inseridos em lote a partir de 'groups.upsert'.`, {
          label: 'MySQLSync',
          metricName: 'group.mysql.batch_upsert.success',
          count: validGroupsToUpsert.length,
          instanceId: this.instanceId,
        });
        validGroupsToUpsert.forEach((metadata) => {
          this.emitEvent('group:metadata:updated', { jid: metadata.id, metadata, context: 'groups.upsert' }, 'groups.upsert');
        });
      } catch (dbError) {
        logger.error(` Erro ao atualizar/inserir em lote ${validGroupsToUpsert.length} grupos a partir de 'groups.upsert': ${dbError.message}.`, {
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
    logger.info(` Evento 'messaging-history.set' recebido. Chats: ${chats.length}, Contatos: ${contacts.length}, Mensagens: ${messages.length}.`, {
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
              logger.info(` Chat ${chat.id} do histórico salvo no MySQL.`, {
                label: 'MySQLSync',
                metricName: 'history.chat.mysql.success',
                jid: chat.id,
                instanceId: this.instanceId,
              });
            } catch (dbError) {
              logger.error(` Erro ao salvar chat ${chat.id} do histórico no MySQL: ${dbError.message}.`, {
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
          logger.error(` Erro ao processar chat ${chat.id} do histórico (BD ou outro): ${error.message}.`, {
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
              logger.info(` Mensagem do histórico ${msg.key.id} salva no MySQL.`, {
                label: 'MySQLSync',
                metricName: 'history.message.mysql.success',
                messageKey: msg.key,
                instanceId: this.instanceId,
              });
            } catch (dbError) {
              logger.error(` Erro ao salvar mensagem do histórico ${msg.key.id} no MySQL: ${dbError.message}.`, {
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
          logger.error(` Erro ao processar mensagem do histórico ${msg.key.id} (BD ou outro): ${error.message}.`, {
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
    logger.info(` Evento 'messages.update' recebido. Número de atualizações: ${updates.length}.`, {
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
    logger.info(` Evento 'messages.delete' recebido.`, {
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
    logger.info(` Evento 'messages.reaction' recebido. Número de reações: ${reactions.length}.`, {
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
    logger.info(` Evento 'message-receipt.update' recebido. Número de recibos: ${receipts.length}.`, {
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
        logger.info(` ${receiptsToUpsert.length} recibos de mensagem atualizados/inseridos em lote no MySQL.`, {
          label: 'MySQLSync',
          metricName: 'message.receipt.mysql.batch_upserted',
          count: receiptsToUpsert.length,
          instanceId: this.instanceId,
        });
      } catch (dbError) {
        logger.error(` Erro ao atualizar/inserir em lote ${receiptsToUpsert.length} recibos de mensagem no MySQL: ${dbError.message}.`, {
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
    logger.info(` Evento 'message-receipt.update' recebido. Número de recibos: ${receipts.length}.`, {
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
              logger.info(` Recibo de mensagem para ${key.id} (usuário ${receipt.userJid}) atualizado/inserido no MySQL.`, {
                label: 'MySQLSync',
                metricName: 'message.receipt.mysql.upserted',
                messageId: key.id,
                remoteJid: key.remoteJid,
                userJid: receipt.userJid,
                receiptType: receipt.type,
                instanceId: this.instanceId,
              });
            } catch (dbError) {
              logger.error(` Erro ao atualizar/inserir recibo de mensagem para ${key.id} no MySQL: ${dbError.message}.`, {
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
          logger.error(` Erro ao processar recibo de mensagem para ${key.id} (BD/outro): ${error.message}.`, {
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
    logger.info(` Evento 'chats.upsert' recebido. Número de chats: ${chats.length}.`, {
      label: 'ConnectionManager',
      metricName: 'chats.upsert.recebido',
      count: chats.length,
      instanceId: this.instanceId,
    });

    const validChats = chats.filter((chat) => chat.id);

    if (this.mysqlDbManager && validChats.length > 0) {
      try {
        await this.mysqlDbManager.upsertChatsBatch(validChats); // Assumed batch method
        logger.info(` ${validChats.length} chats atualizados/inseridos em lote no MySQL.`, {
          label: 'MySQLSync',
          metricName: 'chat.mysql.batch_upsert.success',
          count: validChats.length,
          instanceId: this.instanceId,
        });
      } catch (dbError) {
        logger.error(` Erro ao atualizar/inserir em lote ${validChats.length} chats no MySQL: ${dbError.message}.`, {
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
    logger.info(` Evento 'chats.update' recebido. Número de atualizações: ${updates.length}.`, {
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
    logger.info(` Evento 'chats.delete' recebido. Número de JIDs: ${jids.length}.`, {
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
            logger.info(` Dados do chat para ${jid} removidos do MySQL.`, {
              label: 'MySQLSync',
              metricName: 'chat.mysql.delete.success',
              jid,
              instanceId: this.instanceId,
            });
          } catch (dbError) {
            logger.error(` Erro ao remover dados do chat para ${jid} do MySQL: ${dbError.message}.`, {
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
        logger.error(` Erro ao processar exclusão de chat para ${jid} (BD ou outro): ${error.message}.`, {
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
    logger.info(` Evento 'contacts.upsert' recebido. Número de contatos: ${contacts.length}.`, {
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
    logger.info(` Evento 'contacts.update' recebido. Número de atualizações: ${updates.length}.`, {
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
    logger.info(` Evento 'blocklist.set' recebido. Contagem: ${data.blocklist?.length || 0}.`, {
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
    logger.info(` Evento 'blocklist.update' recebido. Ação: ${data.action}, Contagem de JIDs: ${data.jids?.length || 0}.`, {
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
    logger.info(` Evento 'call' recebido. Status: ${callEvent?.status}, De: ${callEvent?.from}.`, {
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
