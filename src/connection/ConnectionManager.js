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
 * @property {import('@WhiskeySockets/Baileys').WASocket | null} client - A instância do cliente Baileys (socket) para interagir com o WhatsApp.
 * Inicializado como `null` e populado após a conexão bem-sucedida.
 * @property {import('ioredis').Redis} redisClient - Cliente para interagir com o servidor Redis,
 * utilizado para cache de metadados, mensagens, chats e contatos.
 * @property {Object} mysqlDbManager - Instância do gerenciador do banco de dados MySQL,
 * responsável pela persistência dos dados.
 * @property {{ state: import('@WhiskeySockets/Baileys').AuthenticationState, saveCreds: () => Promise<void> }} auth - Objeto contendo o estado de autenticação (`state`) e o método `saveCreds`
 * fornecido por `useMultiFileAuthState` para gerenciar as credenciais de login.
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
 */
class ConnectionManager {
  /**
   * @constructor
   * @description Cria uma nova instância do `ConnectionManager`.
   * Inicializa os parâmetros de configuração para a conexão, reconexão,
   * e o cliente Redis.
   * @param {Object} mysqlDbManager - A instância do gerenciador do banco de dados MySQL.
   * @param {number} [initialBackoffDelayMs=env.BACKOFF_INITIAL_DELAY_MS] - Atraso inicial para reconexão em milissegundos.
   * @param {number} [maxBackoffDelayMs=env.BACKOFF_MAX_DELAY_MS] - Atraso máximo para reconexão em milissegundos.
   * @param {string} [authStatePath=env.AUTH_STATE_PATH] - Caminho para o diretório onde o estado de autenticação será salvo.
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
   * @method initializeRedisClient
   * @private
   * Inicializa o cliente Redis para cache de dados.
   * Configura conexão, eventos e tratamento de erros do Redis.
   * Os detalhes da conexão (host, porta, senha, db) são obtidos das variáveis de ambiente.
   * Registra listeners para os eventos 'connect' e 'error' do cliente Redis.
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

    this.redisClient.on('error', (err) => {
      logger.error('Erro na conexão com o Redis:', { label: 'RedisClient', message: err.message, stack: err.stack });
    });
  }
  /**
   * @method initialize
   * @async
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
   * @async
   * @private
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
   * @async
   * @private
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
   * @method setupEventHandlers
   * @private
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
   * @async
   * @private
   * Manipula atualizações de conexão do cliente WhatsApp.
   * Este método é chamado quando o estado da conexão com o WhatsApp muda (evento 'connection.update').
   * @param {Partial<import('@WhiskeySockets/Baileys').ConnectionState>} update - O objeto de atualização da conexão fornecido por Baileys.
   * @param {string} [update.connection] - O estado atual da conexão ('open', 'close', 'connecting').
   * @param {{ error?: import('@hapi/boom').Boom<any>, date: Date }} [update.lastDisconnect] - Informações sobre a última desconexão, contendo o erro (do tipo Boom) e a data.
   * @param {string} [update.qr] - O código QR para autenticação, se aplicável.
   *
   * @description
   * - Se um QR code for recebido, ele é exibido no terminal.
   * - Se a conexão for 'open', o estado de reconexão é resetado.
   * - Se a conexão for 'close', analisa o motivo da desconexão. Se for uma desconexão recuperável e não estiver já em processo de reconexão, inicia `reconnectWithBackoff`. Caso contrário, trata como desconexão irrecuperável.
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
   * @method shouldReconnect
   * @private
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
   * @async
   * @private
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
   * @private
   * Manipula desconexão irrecuperável (ex: logout ou máximo de tentativas atingido).
   * Registra um erro informando o usuário sobre a situação e a necessidade de
   * remover os dados de autenticação e reiniciar para gerar um novo QR code.
   * Reseta o estado de reconexão.
   * @param {number|undefined} statusCode - O código de status da desconexão.
   */
  handleIrrecoverableDisconnect(statusCode) {
    logger.error(`Deslogado ou alcançou o número máximo de tentativas de reconexão. Por favor, remova o diretório 'auth_info_baileys' e reinicie a aplicação para gerar um novo QR code. (Código: ${statusCode})`, { label: 'ConnectionManager' });
    this.resetReconnectionState();
  }

  /**
   * @method resetReconnectionState
   * @private
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
   * @async
   * @private
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
   * @async
   * @private
   * Manipula mensagens novas/atualizadas.
   * Este método é chamado quando novas mensagens são recebidas ou mensagens existentes são atualizadas (evento 'messages.upsert').
   * @param {import('@WhiskeySockets/Baileys').MessagesUpsertEvent} data - Os dados do evento 'messages.upsert' de Baileys.
   * @param {Array<import('@WhiskeySockets/Baileys').WAMessage>} data.messages - Array de mensagens recebidas/atualizadas.
   * @param {import('@WhiskeySockets/Baileys').MessageUpsertType} data.type - O tipo de "upsert" (ex: 'notify', 'append').
   *
   * @description
   * Para cada mensagem:
   * 1. Determina o tipo de conteúdo da mensagem usando `getContentType`.
   * 2. Se a mensagem tiver uma chave válida (`remoteJid` e `id`), ela é processada.
   * 3. A mensagem, junto com seu tipo de conteúdo e um objeto `receipts` inicializado, é salva no cache Redis com um TTL definido por `REDIS_TTL_MESSAGE`.
   * 4. Se `this.mysqlDbManager` estiver configurado, a mensagem também é salva (upsert) no banco de dados MySQL.
   * 5. Erros durante o salvamento no Redis ou MySQL são registrados.
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
   * @method handleGroupsUpdate
   * @private
   * Manipula atualizações de grupos.
   * Este método é chamado quando há atualizações nos metadados de grupos existentes (ex: mudança de nome, descrição) (evento 'groups.update').
   * @param {Array<Partial<import('@WhiskeySockets/Baileys').GroupMetadata>>} updates - Array de objetos contendo atualizações parciais dos metadados do grupo. Cada objeto deve ter pelo menos a propriedade `id` (JID do grupo).
   *
   * @description
   * Para cada atualização de grupo:
   * 1. Obtém o JID do grupo.
   * 2. Busca os metadados completos do grupo usando `this.client.groupMetadata(jid)`.
   * 3. Se os metadados forem obtidos com sucesso, eles são salvos no cache Redis com a chave `group:<jid>` e TTL `REDIS_TTL_METADATA_SHORT`.
   * 4. Se `this.mysqlDbManager` estiver configurado, os metadados do grupo também são salvos (upsert) no banco de dados MySQL.
   * 5. Erros durante o processo são registrados.
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
          } else {
            logger.warn(`Metadados do grupo ${jid} não puderam ser obtidos (groups.update). O grupo não será atualizado no DB.`, { label: 'ConnectionManager', jid });
          }
        } catch (error) {
          logger.error(`Erro ao atualizar metadados do grupo ${jid} no Redis ou MySQL (groups.update): ${error.message}`, { label: 'SyncError', jid, error: error.message });
        }
      }
    });
  }

  /**
   * @method handleGroupParticipantsUpdate
   * @async
   * @private
   * Manipula atualizações de participantes de grupos.
   * Chamado quando participantes entram, saem, são promovidos ou rebaixados em um grupo (evento 'group-participants.update').
   * @param {import('@WhiskeySockets/Baileys').GroupParticipantsUpdateData} event - Os dados do evento 'group-participants.update' de Baileys.
   * @param {string} event.id - O JID do grupo afetado.
   * @param {Array<string>} event.participants - Array de JIDs dos participantes afetados.
   * @param {import('@WhiskeySockets/Baileys').ParticipantAction} event.action - Ação realizada ('add', 'remove', 'promote', 'demote').
   *
   * @description
   * 1. Após uma atualização de participante, busca os metadados atualizados do grupo usando `this.client.groupMetadata(jid)`.
   * 2. Se os metadados forem obtidos com sucesso, eles são salvos no cache Redis com a chave `group:<jid>` e TTL `REDIS_TTL_METADATA_SHORT`.
   * 3. Se `this.mysqlDbManager` estiver configurado, os metadados atualizados do grupo também são salvos (upsert) no banco de dados MySQL.
   * 4. Erros durante o processo são registrados.
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
          await this.mysqlDbManager.upsertGroup(metadata);
        }
      } else {
        logger.warn(`Metadados do grupo ${jid} não puderam ser obtidos (group-participants.update). O grupo não será atualizado no DB.`, { label: 'ConnectionManager', jid });
      }
    } catch (error) {
      logger.error(`Erro ao obter ou salvar metadados do grupo ${jid} no Redis ou MySQL (group-participants.update): ${error.message}`, { label: 'SyncError', jid, error: error.message });
    }
  }

  /**
   * @method handleGroupsUpsert
   * @async
   * @private
   * Manipula a inserção/atualização de grupos (quando o usuário entra em um novo grupo ou sincronização inicial).
   * Este evento é geralmente disparado quando o cliente se conecta e sincroniza a lista de grupos,
   * ou quando o usuário entra em um novo grupo (evento 'groups.upsert').
   * @param {Array<import('@WhiskeySockets/Baileys').GroupMetadata>} groups - Array de objetos completos de metadados de grupo.
   *
   * @description
   * Para cada metadado de grupo recebido:
   * 1. Salva os metadados no cache Redis com a chave `group:<jid>` e TTL `REDIS_TTL_METADATA_SHORT`.
   * 2. Se `this.mysqlDbManager` estiver configurado, os metadados do grupo também são salvos (upsert) no banco de dados MySQL.
   * 3. Erros durante o processo são registrados.
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
   * @method handleMessagingHistorySet
   * @async
   * @private
   * Manipula o evento de conjunto de histórico de mensagens.
   * Este evento é disparado durante a sincronização inicial do histórico (evento 'messaging-history.set'),
   * fornecendo um conjunto de chats, contatos e mensagens.
   * @param {import('@WhiskeySockets/Baileys').MessagingHistorySet} data - Os dados do evento 'messaging-history.set' de Baileys.
   * @param {Array<import('@WhiskeySockets/Baileys').Chat>} data.chats - Array de objetos de chat do histórico.
   * @param {Array<import('@WhiskeySockets/Baileys').Contact>} data.contacts - Array de objetos de contato do histórico.
   * @param {Array<import('@WhiskeySockets/Baileys').WAMessage>} data.messages - Array de mensagens do histórico.
   *
   * @description
   * - Para cada chat: Salva no Redis (chave `chat:<id>`, TTL `REDIS_TTL_METADATA_SHORT`) e no MySQL (via `this.mysqlDbManager.upsertChat`).
   * - Para cada contato: Salva no Redis (chave `contact:<id>`, TTL `REDIS_TTL_METADATA_LONG`). (Atualmente não salva contatos no MySQL neste handler).
   * - Para cada mensagem: Determina o tipo de conteúdo, salva no Redis (chave `message:<remoteJid>:<id>`, TTL `REDIS_TTL_MESSAGE`) e no MySQL (via `this.mysqlDbManager.upsertMessage`).
   * Erros durante o salvamento são registrados.
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
        } catch (error) {
          logger.error(`Erro ao salvar contato ${contact.id} do histórico no Redis: ${error.message}`, { label: 'RedisCache', jid: contact.id, error: error.message });
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
   * @method handleMessagesUpdate
   * @private
   * Manipula atualizações de mensagens.
   * Este evento é disparado para atualizações em mensagens existentes (ex: status de entrega, edição - se suportado) (evento 'messages.update').
   * @param {Array<import('@WhiskeySockets/Baileys').WAMessageUpdate>} updates - Array de objetos de atualização de mensagem.
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
   * @private
   * Manipula exclusão de mensagens.
   * Este evento é disparado quando mensagens são deletadas (evento 'messages.delete').
   * @param {Object|Array<import('@WhiskeySockets/Baileys').WAMessageKey>} deletion - Informações sobre as mensagens deletadas.
   * Pode ser um objeto se for `deleteAll`, ou um array de `WAMessageKey` para mensagens específicas.
   * @description Atualmente, este método apenas registra o evento de exclusão. Nenhuma ação de remoção do cache ou banco de dados é realizada aqui.
   */
  handleMessagesDelete(deletion) {
    logger.debug(`Evento 'messages.delete' recebido: ${JSON.stringify(deletion)}`, { label: 'ConnectionManager', deletion });
  }

  /**
   * @method handleMessagesReaction
   * @private
   * Manipula reações a mensagens.
   * Este evento é disparado quando uma reação é adicionada ou removida de uma mensagem (evento 'messages.reaction').
   * @param {Array<import('@WhiskeySockets/Baileys').MessageReaction>} reactions - Array de objetos de reação.
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
   * @async
   * @private
   * Manipula atualizações de recibo de mensagem.
   * Este evento é disparado quando o status de entrega/leitura de uma mensagem é atualizado
   * (ex: 'delivered', 'read', 'played') (evento 'message-receipt.update').
   * @param {Array<import('@WhiskeySockets/Baileys').MessageReceiptUpdate>} receipts - Array de atualizações de recibo.
   * Cada objeto contém:
   *  - `key`: {@link import('@WhiskeySockets/Baileys').WAMessageKey} A chave da mensagem original.
   *  - `receipt`: {@link import('@WhiskeySockets/Baileys').MessageReceipt} O objeto de recibo, contendo:
   *    - `userJid`: JID do usuário cujo recibo foi atualizado.
   *    - `type`: Tipo do recibo (e.g., 'read', 'delivered').
   *    - `receiptTimestamp`, `readTimestamp`, `playedTimestamp`: Timestamps relevantes.
   *
   * @description
   * Para cada atualização de recibo:
   * 1. Verifica se a chave da mensagem e os detalhes do recibo são válidos.
   * 2. Tenta buscar a mensagem correspondente no cache Redis.
   * 3. Se a mensagem for encontrada:
   *    a. Atualiza o objeto `receipts` dentro dos dados da mensagem com as novas informações do recibo.
   *    b. Salva a mensagem atualizada de volta no Redis, preservando o TTL original se possível, ou usando `REDIS_TTL_MESSAGE` como fallback.
   *    c. Se `this.mysqlDbManager` estiver configurado, salva (upsert) o recibo no banco de dados MySQL.
   * 4. Se a mensagem não for encontrada no cache, registra um aviso.
   * 5. Erros durante o processo são registrados.
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
   * @method handleChatsUpsert
   * @async
   * @private
   * Manipula inserção/atualização de chats.
   * Este evento é disparado quando novos chats são criados ou chats existentes são sincronizados (evento 'chats.upsert').
   * @param {Array<import('@WhiskeySockets/Baileys').Chat>} chats - Array de objetos de chat.
   *
   * @description
   * Para cada chat:
   * 1. Salva o objeto do chat no cache Redis com a chave `chat:<id>` e TTL `REDIS_TTL_METADATA_SHORT`.
   * 2. Se `this.mysqlDbManager` estiver configurado, salva (upsert) o chat no banco de dados MySQL.
   * 3. Erros durante o processo são registrados.
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
   * @method handleChatsUpdate
   * @async
   * @private
   * Manipula atualizações de chats.
   * Este evento é disparado quando propriedades de um chat existente são alteradas (ex: `unreadCount`, `mute`) (evento 'chats.update').
   * @param {Array<Partial<import('@WhiskeySockets/Baileys').Chat>>} updates - Array de atualizações parciais de chat. Cada objeto deve ter pelo menos a propriedade `id`.
   *
   * @description
   * Para cada atualização de chat:
   * 1. Salva o objeto de atualização do chat no cache Redis com a chave `chat:<id>` e TTL `REDIS_TTL_METADATA_SHORT`. (Nota: Isso pode sobrescrever o chat completo com um objeto parcial se não for tratado com cuidado ao ler do cache).
   * 2. Se `this.mysqlDbManager` estiver configurado, salva (upsert) a atualização do chat no banco de dados MySQL.
   * 3. Erros durante o processo são registrados.
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
   * @method handleChatsDelete
   * @async
   * @private
   * Manipula exclusão de chats.
   * Este evento é disparado quando chats são deletados (evento 'chats.delete').
   * @param {Array<string>} jids - Array de JIDs (identificadores) dos chats que foram excluídos.
   *
   * @description
   * Para cada JID de chat excluído:
   * 1. Remove o chat do cache Redis usando a chave `chat:<jid>`.
   * 2. Se `this.mysqlDbManager` estiver configurado, chama `this.mysqlDbManager.deleteChatData(jid)` para remover os dados associados ao chat do banco de dados MySQL.
   * 3. Erros durante o processo são registrados.
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
   * @method handleContactsUpsert
   * @async
   * @private
   * Manipula inserção/atualização de contatos.
   * Este evento é disparado quando novos contatos são adicionados ou contatos existentes são sincronizados (evento 'contacts.upsert').
   * @param {Array<import('@WhiskeySockets/Baileys').Contact>} contacts - Array de objetos de contato.
   *
   * @description
   * Para cada contato:
   * 1. Salva o objeto do contato no cache Redis com a chave `contact:<id>` e TTL `REDIS_TTL_METADATA_LONG`.
   * 2. Erros durante o salvamento no Redis são registrados. (Atualmente, não há persistência de contatos no MySQL neste handler).
   */
  async handleContactsUpsert(contacts) {
    logger.debug(`Evento 'contacts.upsert' recebido. Número de contatos: ${contacts.length}`, { label: 'ConnectionManager', count: contacts.length });
    for (const contact of contacts) {
      if (contact.id) {
        try {
          const cacheKey = `${REDIS_PREFIX_CONTACT}${contact.id}`;
          await this.redisClient.set(cacheKey, JSON.stringify(contact), 'EX', REDIS_TTL_METADATA_LONG);
          logger.info(`Contato ${contact.id} (upsert) salvo no Redis.`, { label: 'RedisCache', jid: contact.id });
        } catch (error) {
          logger.error(`Erro ao salvar contato ${contact.id} (upsert) no Redis: ${error.message}`, { label: 'RedisCache', jid: contact.id, error: error.message });
        }
      }
    }
  }

  /**
   * @method handleContactsUpdate
   * @async
   * @private
   * Manipula a atualização de contatos no sistema.
   * Responsável por atualizar as informações de contato no cache Redis.
   * Este evento é disparado quando propriedades de um contato existente são alteradas (ex: nome, notificação push) (evento 'contacts.update').
   * @param {Array<Partial<import('@WhiskeySockets/Baileys').Contact>>} updates - Array de atualizações parciais de contatos. Cada objeto deve ter pelo menos a propriedade `id`.
   *
   * @description
   * Para cada atualização de contato:
   * 1. Salva o objeto de atualização do contato no cache Redis com a chave `contact:<id>` e TTL `REDIS_TTL_METADATA_LONG`. (Nota: Isso pode sobrescrever o contato completo com um objeto parcial se não for tratado com cuidado ao ler do cache).
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
          const cacheKey = `${REDIS_PREFIX_CONTACT}${contactUpdate.id}`;
          await this.redisClient.set(cacheKey, JSON.stringify(contactUpdate), 'EX', REDIS_TTL_METADATA_LONG);
          logger.info(`Contato ${contactUpdate.id} (update) atualizado no Redis.`, { label: 'RedisCache', jid: contactUpdate.id });
        } catch (error) {
          logger.error(`Erro ao atualizar contato ${contactUpdate.id} (update) no Redis: ${error.message}`, { label: 'RedisCache', jid: contactUpdate.id, error: error.message });
        }
      }
    }
  }

  /**
   * @method handleBlocklistSet
   * @private
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
   * @private
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
   * @private
   * Processa eventos de chamadas recebidas ou realizadas.
   * Registra informações sobre chamadas de voz/vídeo no WhatsApp.
   * Este evento é disparado para vários estágios de uma chamada (oferta, aceitação, rejeição, término) (evento 'call').
   * @param {Array<import('@WhiskeySockets/Baileys').Call>} call - Array de objetos de chamada. (Nota: Baileys geralmente emite um array com um único evento de chamada por vez).
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
  handleCall(call) {
    logger.info(`Evento 'call' recebido: ${JSON.stringify(call)}`, { label: 'ConnectionManager', callData: call });
  }

  /**
   * @method handlePresenceUpdate
   * @private
   * Processa atualizações de presença dos contatos.
   * Registra e monitora alterações no status de presença (online, offline, digitando, gravando áudio) e última visualização (evento 'presence.update').
   * @param {import('@WhiskeySockets/Baileys').PresenceUpdateData} data - Dados da atualização de presença.
   * @param {string} data.id - JID do chat (usuário ou grupo) onde a atualização de presença ocorreu.
   * @param {Object<string, { lastKnownPresence?: import('@WhiskeySockets/Baileys').PresenceUpdate['presences'][string]['lastKnownPresence'], lastSeen?: number }>} data.presences - Um objeto onde as chaves são os JIDs dos participantes (ou o JID do chat, se for individual) e os valores são objetos contendo `lastKnownPresence` e, opcionalmente, `lastSeen`.
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
