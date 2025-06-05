const mysql = require('mysql2/promise');
const path = require('path');
const { cleanEnv, str, host, port } = require('envalid');
const { getContentType } = require('baileys');
const logger = require('../utils/logs/logger');

require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const env = cleanEnv(process.env, {
  MYSQL_HOST: host({ default: 'localhost' }),
  MYSQL_PORT: port({ default: 3306 }),
  MYSQL_USER: str(),
  MYSQL_PASSWORD: str(),
  MYSQL_DATABASE_NAME: str({ default: 'omnizap' }),
});

class MySQLDBManager {
  /**
   * @constructor
   * @description
   * Cria uma nova instância do `MySQLDBManager`.
   * Inicializa as propriedades de configuração do banco de dados (`dbConfig`, `dbName`)
   * com base nas variáveis de ambiente processadas por `envalid`.
   * O pool de conexões (`this.pool`) é inicializado como `null` e será configurado
   * posteriormente pelo método `initialize`.
   */
  constructor() {
    this.pool = null;
    this.dbConfig = {
      host: env.MYSQL_HOST,
      port: env.MYSQL_PORT,
      user: env.MYSQL_USER,
      password: env.MYSQL_PASSWORD,
    };
    this.dbName = env.MYSQL_DATABASE_NAME;
  }

  /**
   * @async
   * @method initialize
   * @description
   * Inicializa o `MySQLDBManager`. Este método realiza as seguintes etapas:
   * 1. Cria uma conexão temporária com o servidor MySQL para verificar se o banco de dados
   *    especificado em `this.dbName` existe. Se não existir, o banco de dados é criado.
   * 2. Cria um pool de conexões MySQL (`this.pool`) configurado para usar o banco de dados
   *    `this.dbName`. O pool gerencia múltiplas conexões para otimizar o desempenho.
   * 3. Testa a conexão do pool obtendo uma conexão e liberando-a.
   * 4. Chama `this.initializeTables()` para garantir que todas as tabelas necessárias
   *    (Chats, Groups, GroupParticipants, Messages, MessageReceipts) existam e estejam
   *    com a estrutura correta.
   *
   * Este método deve ser chamado antes de qualquer outra operação de banco de dados.
   *
   * @returns {Promise<void>} Uma promessa que resolve quando a inicialização é concluída com sucesso.
   * @throws {Error} Lança um erro se houver falha ao conectar ao MySQL, criar o banco de dados,
   * estabelecer o pool de conexões ou inicializar as tabelas. O erro original é registrado
   * e propagado.
   *
   * @example
   * // Geralmente chamado através do getInstance
   * const dbManager = await MySQLDBManager.getInstance();
   * // A inicialização já ocorreu dentro do getInstance.
   */
  async initialize() {
    try {
      const tempConnection = await mysql.createConnection({
        host: this.dbConfig.host,
        port: this.dbConfig.port,
        user: this.dbConfig.user,
        password: this.dbConfig.password,
      });
      await tempConnection.query(`CREATE DATABASE IF NOT EXISTS \`${this.dbName}\`;`);
      await tempConnection.end();
      logger.info(`Banco de dados '${this.dbName}' verificado/criado com sucesso.`, { label: 'MySQLDBManager.initialize' });

      this.pool = mysql.createPool({
        ...this.dbConfig,
        database: this.dbName,
        waitForConnections: true,
        connectionLimit: 10,
        queueLimit: 0,
      });

      const connection = await this.pool.getConnection();
      logger.info('Conectado ao banco de dados MySQL com sucesso via pool.', {
        label: 'MySQLDBManager',
        dbName: this.dbName,
      });
      connection.release();

      await this.initializeTables();
    } catch (err) {
      logger.error('Erro ao inicializar o MySQLDBManager:', {
        label: 'MySQLDBManager',
        message: err.message,
        stack: err.stack,
      });
      throw err;
    }
  }

  /**
   * @async
   * @method initializeTables
   * @private
   * @description
   * Garante que todas as tabelas necessárias para a aplicação existam no banco de dados.
   * Executa uma série de queries `CREATE TABLE IF NOT EXISTS` para as tabelas:
   * `Chats`, `Groups`, `GroupParticipants`, `Messages`, e `MessageReceipts`.
   * Define a estrutura, tipos de dados, chaves primárias, chaves estrangeiras, índices
   * e collation para cada tabela.
   * Utiliza `ENGINE=InnoDB` e `CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci` para
   * suportar uma ampla gama de caracteres, incluindo emojis.
   *
   * Este método é chamado internamente por `initialize()`.
   *
   * @returns {Promise<void>} Uma promessa que resolve quando todas as tabelas foram
   * verificadas/criadas com sucesso.
   * @throws {Error} Lança um erro se houver falha na criação de qualquer uma das tabelas.
   * O erro original é registrado e propagado.
   */
  async initializeTables() {
    const queries = [
      `CREATE TABLE IF NOT EXISTS \`Chats\` (
        jid VARCHAR(255) PRIMARY KEY,
        name VARCHAR(255),
        unread_count INT DEFAULT 0,
        last_message_timestamp BIGINT,
        is_group BOOLEAN DEFAULT 0,
        pinned_timestamp BIGINT DEFAULT 0,
        mute_until_timestamp BIGINT DEFAULT 0,
        archived BOOLEAN DEFAULT 0,
        ephemeral_duration INT,
        created_at BIGINT,
        updated_at BIGINT
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`,

      `CREATE TABLE IF NOT EXISTS \`Groups\` (
        jid VARCHAR(255) PRIMARY KEY,
        subject VARCHAR(255),
        owner_jid VARCHAR(255),
        creation_timestamp BIGINT,
        description TEXT,
        restrict_mode BOOLEAN DEFAULT 0,
        announce_mode BOOLEAN DEFAULT 0,
        img_url TEXT,
        created_at BIGINT,
        updated_at BIGINT,
        FOREIGN KEY (jid) REFERENCES \`Chats\`(jid) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`,

      `CREATE TABLE IF NOT EXISTS \`GroupParticipants\` (
        group_jid VARCHAR(255) NOT NULL,
        participant_jid VARCHAR(255) NOT NULL,
        admin_status VARCHAR(50) COMMENT 'e.g., admin, superadmin, null',
        PRIMARY KEY (group_jid, participant_jid),
        FOREIGN KEY (group_jid) REFERENCES \`Groups\`(jid) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`,

      `CREATE TABLE IF NOT EXISTS \`Messages\` (
        message_id VARCHAR(255) NOT NULL,
        chat_jid VARCHAR(255) NOT NULL,
        sender_jid VARCHAR(255),
        from_me BOOLEAN NOT NULL,
        message_timestamp BIGINT NOT NULL,
        push_name VARCHAR(255),
        message_type VARCHAR(50),
        quoted_message_id VARCHAR(255),
        quoted_message_sender_jid VARCHAR(255),
        raw_message_content JSON COMMENT 'Store the raw Baileys message object as JSON',
        created_at BIGINT,
        updated_at BIGINT,
        PRIMARY KEY (message_id, chat_jid),
        INDEX idx_messages_chat_timestamp (chat_jid, message_timestamp),
        INDEX idx_messages_sender (sender_jid),
        FOREIGN KEY (chat_jid) REFERENCES \`Chats\`(jid) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`,

      `CREATE TABLE IF NOT EXISTS \`MessageReceipts\` (
        message_id VARCHAR(255) NOT NULL,
        chat_jid VARCHAR(255) NOT NULL,
        recipient_jid VARCHAR(255) NOT NULL,
        receipt_type VARCHAR(50) NOT NULL COMMENT 'e.g., delivered, read, played',
        receipt_timestamp BIGINT NOT NULL,
        PRIMARY KEY (message_id(191), chat_jid(191), recipient_jid(191), receipt_type),
        FOREIGN KEY (message_id, chat_jid) REFERENCES \`Messages\`(message_id, chat_jid) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`,
    ];

    const connection = await this.pool.getConnection();
    try {
      for (const query of queries) {
        await connection.query(query);
      }
      logger.info('Tabelas MySQL inicializadas/verificadas.', { label: 'MySQLDBManager.initializeTables' });
    } catch (err) {
      logger.error('Erro ao criar tabelas MySQL:', {
        label: 'MySQLDBManager',
        message: err.message,
      });
      throw err;
    } finally {
      connection.release();
    }
  }

  /**
   * @async
   * @method executeQuery
   * @description
   * Executa uma query SQL parametrizada no banco de dados.
   * Obtém uma conexão do pool, executa a query e libera a conexão de volta ao pool.
   * Este é um método genérico para interagir com o banco de dados.
   *
   * @param {string} sql - A string da query SQL a ser executada. Pode conter placeholders `?`
   * para os parâmetros.
   * @param {Array<any>} [params=[]] - Um array de parâmetros para substituir os placeholders na query SQL.
   * O padrão é um array vazio se não houver parâmetros.
   *
   * @returns {Promise<any>} Uma promessa que resolve com os resultados da query.
   * O formato dos resultados depende do tipo de query (SELECT, INSERT, UPDATE, DELETE).
   * Para SELECT, retorna um array de linhas. Para INSERT, retorna um objeto com `insertId`, etc.
   * @throws {Error} Lança um erro se a execução da query falhar. O erro original é
   * registrado e propagado.
   *
   * @example
   * // Exemplo de SELECT
   * const users = await dbManager.executeQuery('SELECT * FROM Users WHERE status = ?', ['active']);
   *
   * // Exemplo de INSERT
   * const result = await dbManager.executeQuery('INSERT INTO Logs (message) VALUES (?)', ['Nova entrada de log']);
   * console.log('ID do log inserido:', result.insertId);
   */
  async executeQuery(sql, params = []) {
    let connection;
    try {
      connection = await this.pool.getConnection();
      const [results] = await connection.query(sql, params);
      return results;
    } catch (err) {
      logger.error('Erro ao executar query MySQL:', { label: 'MySQLDBManager.executeQuery', sql, params, message: err.message });
      throw err;
    } finally {
      if (connection) connection.release();
    }
  }

  /**
   * @async
   * @method upsertChat
   * @description
   * Insere um novo registro de chat na tabela `Chats` ou atualiza um existente se o `jid` já existir.
   * A lógica de atualização (`ON DUPLICATE KEY UPDATE`) é projetada para:
   * - Atualizar `name` apenas se o novo valor não for nulo.
   * - Sempre atualizar `unread_count`.
   * - Atualizar `last_message_timestamp` apenas se o novo valor for mais recente que o existente ou se o existente for nulo.
   * - Sempre atualizar `is_group`, `pinned_timestamp`, `mute_until_timestamp`, `archived`, `ephemeral_duration`.
   * - `created_at` é definido no momento da inserção.
   * - `updated_at` é atualizado para o timestamp atual em cada operação de inserção ou atualização.
   *
   * @param {Object} chat - O objeto de chat, geralmente proveniente da biblioteca Baileys.
   * @param {string} chat.id - O JID (identificador único) do chat. Ex: 'xxxxxxxxxxx@s.whatsapp.net' ou 'xxxxxxxxxxxx-xxxx@g.us'.
   * @param {string} [chat.name] - O nome do chat (para contatos) ou assunto (para grupos).
   * @param {number} [chat.unreadCount=0] - O número de mensagens não lidas. Padrão é 0.
   * @param {number} [chat.conversationTimestamp] - Timestamp da última conversa/mensagem. Usado para `last_message_timestamp`.
   * @param {number} [chat.lastMessageTimestamp] - Timestamp da última mensagem (alternativa a `conversationTimestamp`).
   * @param {number} [chat.pinned=0] - Timestamp de quando o chat foi fixado, ou 0 se não estiver fixado.
   * @param {number} [chat.muteEndTime] - Timestamp de quando o silenciamento do chat expira. Pode ser `null` ou `undefined` se não estiver silenciado.
   * @param {boolean} [chat.archived=false] - Indica se o chat está arquivado.
   * @param {boolean} [chat.archive=false] - Alternativa para `chat.archived`.
   * @param {number} [chat.ephemeralDuration] - Duração das mensagens efêmeras em segundos. Pode ser `null` ou `undefined`.
   *
   * @returns {Promise<void>} Uma promessa que resolve quando a operação de upsert é concluída.
   * Não retorna dados, mas registra um log em caso de sucesso ou erro.
   * @throws {Error} Erros são registrados pelo logger, mas não são propagados (re-lançados) por este método.
   * Isso significa que falhas aqui não interromperão o fluxo de chamadas, a menos que o chamador
   * verifique os logs ou o estado do banco de dados.
   *
   * @example
   * const chatData = {
   *   id: '5511999999999@s.whatsapp.net',
   *   name: 'John Doe',
   *   unreadCount: 2,
   *   conversationTimestamp: 1678886400, // Exemplo de timestamp UNIX
   *   pinned: 0,
   *   muteEndTime: null,
   *   archived: false,
   *   ephemeralDuration: 86400 // 1 dia
   * };
   * await dbManager.upsertChat(chatData);
   */
  async upsertChat(chat) {
    const sql = `
      INSERT INTO Chats (jid, name, unread_count, last_message_timestamp, is_group, pinned_timestamp, mute_until_timestamp, archived, ephemeral_duration, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, UNIX_TIMESTAMP(), UNIX_TIMESTAMP())
      ON DUPLICATE KEY UPDATE
        name = IF(VALUES(name) IS NOT NULL, VALUES(name), Chats.name),
        unread_count = VALUES(unread_count), -- Assume-se que o valor passado (chat.unreadCount || 0) é o desejado
        last_message_timestamp = CASE
        WHEN VALUES(last_message_timestamp) IS NOT NULL AND (Chats.last_message_timestamp IS NULL OR VALUES(last_message_timestamp) > Chats.last_message_timestamp)
        THEN VALUES(last_message_timestamp)
        ELSE Chats.last_message_timestamp
        END,
        is_group = VALUES(is_group), -- Assume-se que o valor passado é o desejado
        pinned_timestamp = VALUES(pinned_timestamp), -- Assume-se que o valor passado é o desejado
        mute_until_timestamp = VALUES(mute_until_timestamp), -- Permite definir como NULL para remover o mute
        archived = VALUES(archived), -- Assume-se que o valor passado é o desejado
        ephemeral_duration = VALUES(ephemeral_duration), -- Permite definir como NULL
        updated_at = UNIX_TIMESTAMP();
    `;
    try {
      await this.executeQuery(sql, [chat.id, chat.name, chat.unreadCount || 0, chat.conversationTimestamp || chat.lastMessageTimestamp, chat.id.endsWith('@g.us') ? 1 : 0, chat.pinned || 0, chat.muteEndTime, chat.archived || chat.archive ? 1 : 0, chat.ephemeralDuration]);
      logger.debug(`Chat ${chat.id} salvo/atualizado no MySQL.`, { label: 'MySQLDBManager.upsertChat', jid: chat.id });
    } catch (error) {
      logger.error(`Erro ao fazer upsert do chat ${chat.id} no MySQL: ${error.message}`, { label: 'MySQLDBManager.upsertChat', jid: chat.id, error: error.message, stack: error.stack });
    }
  }

  /**
   * @async
   * @method upsertChatsBatch
   * @description
   * Insere ou atualiza múltiplos registros de chat na tabela `Chats` em lote.
   * Utiliza uma única query `INSERT ... ON DUPLICATE KEY UPDATE`.
   * @param {Array<Object>} chats - Array de objetos de chat para upsert.
   * Cada objeto deve ter propriedades compatíveis com a tabela `Chats`.
   * @returns {Promise<void>}
   * @throws {Error} Se o upsert em lote falhar.
   */
  async upsertChatsBatch(chats) {
    if (!chats || chats.length === 0) {
      logger.debug('upsertChatsBatch chamado com array de chats vazio ou nulo.', { label: 'MySQLDBManager.upsertChatsBatch' });
      return;
    }

    const sql = `
      INSERT INTO Chats (jid, name, unread_count, last_message_timestamp, is_group, pinned_timestamp, mute_until_timestamp, archived, ephemeral_duration, created_at, updated_at)
      VALUES ?
      ON DUPLICATE KEY UPDATE
        name = IF(VALUES(name) IS NOT NULL, VALUES(name), Chats.name),
        unread_count = VALUES(unread_count),
        last_message_timestamp = CASE
          WHEN VALUES(last_message_timestamp) IS NOT NULL AND (Chats.last_message_timestamp IS NULL OR VALUES(last_message_timestamp) > Chats.last_message_timestamp)
          THEN VALUES(last_message_timestamp)
          ELSE Chats.last_message_timestamp
        END,
        is_group = VALUES(is_group),
        pinned_timestamp = VALUES(pinned_timestamp),
        mute_until_timestamp = VALUES(mute_until_timestamp),
        archived = VALUES(archived),
        ephemeral_duration = VALUES(ephemeral_duration),
        updated_at = UNIX_TIMESTAMP();
    `;

    const queryValues = chats.map((chat) => [
      chat.id,
      chat.name,
      chat.unreadCount || 0,
      chat.conversationTimestamp || chat.lastMessageTimestamp,
      chat.id.endsWith('@g.us') ? 1 : 0,
      chat.pinned || 0,
      chat.muteEndTime,
      chat.archived || chat.archive ? 1 : 0,
      chat.ephemeralDuration,
      Math.floor(Date.now() / 1000), // created_at for new entries
      Math.floor(Date.now() / 1000), // updated_at for new entries
    ]);

    await this.executeQuery(sql, [queryValues]);
    logger.info(`[METRIC] Lote de ${chats.length} chats salvo/atualizado no MySQL.`, { label: 'MySQLDBManager.upsertChatsBatch', count: chats.length, metricName: 'mysql.batch_upsert.chats.success' });
  }

  /**
   * @async
   * @method upsertGroup
   * @description
   * Insere ou atualiza os metadados de um grupo no banco de dados.
   * Esta operação envolve duas etapas principais:
   * 1. Chama `this.upsertChat()` para garantir que uma entrada correspondente exista na tabela `Chats`,
   *    marcando-o como um grupo (`is_group: 1`).
   * 2. Insere ou atualiza os detalhes específicos do grupo (assunto, proprietário, descrição, etc.)
   *    na tabela `Groups`.
   * 3. Se `groupMetadata.participants` for fornecido e não estiver vazio, chama
   *    `this.updateGroupParticipants()` para atualizar a lista de participantes do grupo.
   *
   * Se `groupMetadata` ou `groupMetadata.id` forem nulos ou indefinidos, a operação é abortada
   * e um aviso é registrado.
   *
   * @param {Object} groupMetadata - O objeto de metadados do grupo, geralmente da biblioteca Baileys.
   * @param {string} groupMetadata.id - O JID (identificador único) do grupo. Ex: 'xxxxxxxxxxxx-xxxx@g.us'. Essencial.
   * @param {string} [groupMetadata.subject] - O assunto (nome) do grupo.
   * @param {string} [groupMetadata.owner] - O JID do proprietário do grupo.
   * @param {number} [groupMetadata.creation] - Timestamp UNIX da criação do grupo.
   * @param {string} [groupMetadata.desc] - A descrição do grupo.
   * @param {boolean} [groupMetadata.restrict=false] - `true` se apenas administradores podem enviar mensagens.
   * @param {boolean} [groupMetadata.announce=false] - `true` se apenas administradores podem alterar informações do grupo (modo anúncio).
   * @param {string} [groupMetadata.profilePictureUrl] - URL da imagem de perfil do grupo.
   * @param {Array<GroupParticipant>} [groupMetadata.participants] - Array de objetos de participantes.
   *   Cada participante deve ter `id` (JID) e `admin` (pode ser 'admin', 'superadmin', ou `null`/`undefined`).
   *
   * @returns {Promise<void>} Uma promessa que resolve quando a operação de upsert do grupo
   * e de seus participantes (se aplicável) é concluída.
   * @throws {Error} Lança um erro se qualquer parte da operação de upsert (chat, grupo, participantes)
   * falhar. O erro original é registrado e propagado.
   *
   * @example
   * const groupData = {
   *   id: '1234567890@g.us',
   *   subject: 'Grupo de Teste',
   *   owner: '5511999999999@s.whatsapp.net',
   *   creation: 1678880000,
   *   desc: 'Este é um grupo para testes.',
   *   restrict: false,
   *   announce: false,
   *   participants: [
   *     { id: '5511999999999@s.whatsapp.net', admin: 'superadmin' },
   *     { id: '5511888888888@s.whatsapp.net', admin: null }
   *   ]
   * };
   * await dbManager.upsertGroup(groupData);
   */
  async upsertGroup(groupMetadata) {
    if (!groupMetadata || !groupMetadata.id) {
      logger.warn('Tentativa de upsert de grupo com dados inválidos', {
        label: 'MySQLDBManager.upsertGroup',
        metadata: groupMetadata,
      });
      return;
    }

    try {
      await this.upsertChat({
        id: groupMetadata.id,
        name: groupMetadata.subject,
        is_group: 1,
        lastMessageTimestamp: groupMetadata.creation,
        unreadCount: 0,
      });

      const sql = `
        INSERT INTO \`Groups\` (
          jid, subject, owner_jid, creation_timestamp, 
          description, restrict_mode, announce_mode, 
          img_url, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, UNIX_TIMESTAMP(), UNIX_TIMESTAMP())
        ON DUPLICATE KEY UPDATE
          subject = VALUES(subject),
          owner_jid = VALUES(owner_jid),
          creation_timestamp = VALUES(creation_timestamp),
          description = VALUES(description),
          restrict_mode = VALUES(restrict_mode),
          announce_mode = VALUES(announce_mode),
          img_url = VALUES(img_url),
          updated_at = UNIX_TIMESTAMP();
      `;

      await this.executeQuery(sql, [groupMetadata.id, groupMetadata.subject, groupMetadata.owner, groupMetadata.creation, groupMetadata.desc, groupMetadata.restrict ? 1 : 0, groupMetadata.announce ? 1 : 0, groupMetadata.profilePictureUrl]);

      logger.info(`Grupo ${groupMetadata.id} atualizado com sucesso no MySQL`, {
        label: 'MySQLDBManager.upsertGroup',
        jid: groupMetadata.id,
        subject: groupMetadata.subject,
      });

      if (Array.isArray(groupMetadata.participants) && groupMetadata.participants.length > 0) {
        await this.updateGroupParticipants(groupMetadata.id, groupMetadata.participants);
      } else {
        logger.warn(`Grupo ${groupMetadata.id} sem participantes para atualizar ou lista de participantes vazia.`, {
          label: 'MySQLDBManager.upsertGroup',
          jid: groupMetadata.id,
        });
      }
    } catch (error) {
      logger.error(`Erro ao fazer upsert do grupo ${groupMetadata.id} no MySQL`, {
        label: 'MySQLDBManager.upsertGroup',
        jid: groupMetadata.id,
        error: error.message,
        stack: error.stack,
      });
      throw error;
    }
  }

  /**
   * @async
   * @method upsertGroupsBatch
   * @description
   * Insere ou atualiza múltiplos metadados de grupo no banco de dados em lote.
   * 1. Garante que as entradas de chat para os grupos existam usando `upsertChatsBatch`.
   * 2. Faz upsert em lote na tabela `Groups`.
   * 3. Atualiza os participantes de cada grupo iterativamente (pois `updateGroupParticipants` é transacional por grupo).
   * @param {Array<Object>} groupsMetadata - Array de objetos de metadados de grupo.
   * @returns {Promise<void>}
   * @throws {Error} Se o upsert em lote dos grupos (tabela Groups) falhar. Erros na atualização de participantes são logados mas não interrompem o processo para outros grupos.
   */
  async upsertGroupsBatch(groupsMetadata) {
    if (!groupsMetadata || groupsMetadata.length === 0) {
      logger.debug('upsertGroupsBatch chamado com array de metadados de grupo vazio ou nulo.', { label: 'MySQLDBManager.upsertGroupsBatch' });
      return;
    }

    const chatDataForGroups = groupsMetadata.map((group) => ({
      id: group.id,
      name: group.subject,
      is_group: 1,
      lastMessageTimestamp: group.creation,
      unreadCount: 0,
    }));
    await this.upsertChatsBatch(chatDataForGroups);

    const groupSql = `
      INSERT INTO \`Groups\` (
        jid, subject, owner_jid, creation_timestamp,
        description, restrict_mode, announce_mode,
        img_url, created_at, updated_at
      )
      VALUES ?
      ON DUPLICATE KEY UPDATE
        subject = VALUES(subject),
        owner_jid = VALUES(owner_jid),
        creation_timestamp = VALUES(creation_timestamp),
        description = VALUES(description),
        restrict_mode = VALUES(restrict_mode),
        announce_mode = VALUES(announce_mode),
        img_url = VALUES(img_url),
        updated_at = UNIX_TIMESTAMP();
    `;
    const groupValues = groupsMetadata.map((group) => [group.id, group.subject, group.owner, group.creation, group.desc, group.restrict ? 1 : 0, group.announce ? 1 : 0, group.profilePictureUrl, Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000)]);

    await this.executeQuery(groupSql, [groupValues]);
    logger.info(`[METRIC] Lote de ${groupsMetadata.length} metadados de grupo salvo/atualizado na tabela Groups.`, { label: 'MySQLDBManager.upsertGroupsBatch', count: groupsMetadata.length, metricName: 'mysql.batch_upsert.groups.success' });

    for (const group of groupsMetadata) {
      if (Array.isArray(group.participants) && group.participants.length > 0) {
        await this.updateGroupParticipants(group.id, group.participants).catch((e) => logger.error(`Erro ao atualizar participantes para grupo ${group.id} em lote: ${e.message}`, { label: 'MySQLDBManager.upsertGroupsBatch', jid: group.id }));
      }
    }
  }

  /**
   * @async
   * @method updateGroupParticipants
   * @description
   * Atualiza a lista de participantes de um grupo específico na tabela `GroupParticipants`.
   * A operação é transacional:
   * 1. Inicia uma transação.
   * 2. Remove todos os participantes existentes para o `groupJid` fornecido.
   * 3. Insere os novos participantes da lista `participants`.
   * 4. Se todas as operações forem bem-sucedidas, a transação é confirmada (commit).
   * 5. Se ocorrer qualquer erro, a transação é revertida (rollback).
   *
   * @param {string} groupJid - O JID do grupo cujos participantes serão atualizados.
   * @param {Array<GroupParticipant>} participants - Um array de objetos de participantes.
   *   Cada objeto deve ter `id` (o JID do participante) e `admin` (o status de administrador,
   *   que pode ser 'admin', 'superadmin', ou `null`/`undefined` se não for admin).
   *
   * @returns {Promise<void>} Uma promessa que resolve quando os participantes são atualizados com sucesso.
   * @throws {Error} Lança um erro se a atualização dos participantes falhar. O erro original é
   * registrado, a transação é revertida e o erro é propagado.
   *
   * @example
   * const groupJid = '1234567890@g.us';
   * const newParticipants = [
   *   { id: '5511999999999@s.whatsapp.net', admin: 'admin' },
   *   { id: '5511888888888@s.whatsapp.net', admin: null }
   * ];
   * await dbManager.updateGroupParticipants(groupJid, newParticipants);
   */
  async updateGroupParticipants(groupJid, participants) {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();

      await connection.query('DELETE FROM GroupParticipants WHERE group_jid = ?', [groupJid]);

      const participantSql = 'INSERT INTO GroupParticipants (group_jid, participant_jid, admin_status) VALUES ?';
      const values = participants.map((p) => [groupJid, p.id, p.admin || null]);

      if (values.length > 0) {
        await connection.query(participantSql, [values]);
      }

      await connection.commit();
      logger.info(`${participants.length} participantes atualizados para o grupo ${groupJid}`, {
        label: 'MySQLDBManager.updateGroupParticipants',
        groupJid,
        participantCount: participants.length,
      });
    } catch (error) {
      await connection.rollback();
      logger.error(`Erro ao atualizar participantes do grupo ${groupJid}`, {
        label: 'MySQLDBManager.updateGroupParticipants',
        groupJid,
        error: error.message,
        stack: error.stack,
      });
      throw error;
    } finally {
      connection.release();
    }
  }

  /**
   * @async
   * @method upsertMessage
   * @description
   * Insere uma nova mensagem na tabela `Messages` ou atualiza uma existente (baseado na chave primária composta `message_id` e `chat_jid`).
   * Antes de inserir/atualizar a mensagem, este método tenta garantir que o chat (`chat_jid`)
   * associado à mensagem exista na tabela `Chats` chamando `this.upsertChat`.
   * O nome do chat para `upsertChat` é inferido do `pushName` da mensagem ou do JID do remetente/chat.
   *
   * Após o upsert da mensagem, atualiza a tabela `Chats` para refletir o `last_message_timestamp`
   * e incrementar `unread_count` se a mensagem não for do próprio usuário (`from_me` é falso).
   *
   * O tipo de mensagem (`message_type`) é determinado usando `getContentType` da biblioteca Baileys.
   * O conteúdo textual da mensagem (`textContent`) é extraído para fins de logging, mas o
   * conteúdo completo da mensagem Baileys (`msg.message`) é armazenado como JSON na coluna `raw_message_content`.
   *
   * @param {BaileysWAMessage} msg - O objeto da mensagem, geralmente da biblioteca Baileys.
   * @param {BaileysWAMessageKey} msg.key - Chave da mensagem, contendo `id`, `remoteJid`, `fromMe`, `participant` (opcional).
   * @param {string} msg.key.id - ID único da mensagem (ex: 'ABCDEF123456').
   * @param {string} msg.key.remoteJid - JID do chat ao qual a mensagem pertence (ex: 'xxxxxxxxxxx@s.whatsapp.net' ou 'xxxxxxxxxxxx-xxxx@g.us').
   * @param {string} [msg.key.participant] - JID do remetente em um chat de grupo (ex: 'yyyyyyyyyyy@s.whatsapp.net').
   * @param {boolean} msg.key.fromMe - `true` se a mensagem foi enviada pelo usuário da sessão atual.
   * @param {(number | LongJsObject)} msg.messageTimestamp - Timestamp UNIX da mensagem (pode ser um número ou um objeto Long.js).
   * @param {string} [msg.pushName] - Nome de exibição (push name) do remetente da mensagem.
   * @param {BaileysWAMessageContent} [msg.message] - O conteúdo real da mensagem (ex: `conversation`, `extendedTextMessage`, `imageMessage`).
   * @param {Object} [msg.message.extendedTextMessage.contextInfo] - Informações de contexto, como mensagem citada.
   * @param {string} [msg.message.extendedTextMessage.contextInfo.stanzaId] - ID da mensagem citada.
   * @param {string} [msg.message.extendedTextMessage.contextInfo.participant] - JID do remetente da mensagem citada.
   *
   * @returns {Promise<void>} Uma promessa que resolve quando a operação de upsert da mensagem e
   * a atualização do chat associado são concluídas.
   * @throws {Error} Erros são registrados pelo logger, mas não são propagados por este método.
   * Falhas aqui podem levar a inconsistências de dados se não monitoradas.
   *
   * @example
   * const messageData = {
   *   key: {
   *     remoteJid: '5511999999999@s.whatsapp.net',
   *     fromMe: false,
   *     id: 'ABCDEF123456',
   *     participant: undefined // Em chat individual
   *   },
   *   messageTimestamp: 1678886450,
   *   pushName: 'John Doe',
   *   message: {
   *     conversation: 'Olá, mundo!'
   *   }
   * };
   * await dbManager.upsertMessage(messageData);
   *
   * const groupMessageData = {
   *   key: {
   *     remoteJid: '1234567890@g.us',
   *     fromMe: true,
   *     id: 'GHIJKL789012',
   *     participant: '5511222222222@s.whatsapp.net' // JID do remetente no grupo (o próprio usuário)
   *   },
   *   messageTimestamp: 1678886500,
   *   pushName: 'MyUser', // Push name do remetente
   *   message: {
   *     extendedTextMessage: {
   *       text: 'Resposta em grupo',
   *       contextInfo: {
   *         stanzaId: 'XYZMSGID',
   *         participant: '5511999999999@s.whatsapp.net'
   *       }
   *     }
   *   }
   * };
   * await dbManager.upsertMessage(groupMessageData);
   */
  async upsertMessage(msg) {
    const senderJid = msg.key.participant || (msg.key.fromMe ? null : msg.key.remoteJid);
    const chatJid = msg.key.remoteJid;

    const relatedUpsertPromises = [];
    relatedUpsertPromises.push(
      this.upsertChat({
        id: chatJid,
        name: chatJid.endsWith('@g.us') ? 'Grupo' : msg.pushName || (senderJid ? senderJid.split('@')[0] : chatJid.split('@')[0]), // Tenta obter um nome para o chat
      }),
    );

    const preparatoryResults = await Promise.allSettled(relatedUpsertPromises);
    preparatoryResults.forEach((result) => {
      if (result.status === 'rejected') {
        logger.warn(`Falha no upsert preparatório (chat) para mensagem ${msg.key.id}. Erro: ${result.reason?.message}`, {
          label: 'MySQLDBManager.upsertMessage',
          messageKey: msg.key,
          error: result.reason?.message,
        });
      }
    });
    let messageType = 'unknown';
    let textContent = null;

    if (msg.message) {
      messageType = getContentType(msg.message) || 'unknown';

      if (msg.message.conversation) {
        textContent = msg.message.conversation;
      } else if (msg.message.extendedTextMessage) {
        textContent = msg.message.extendedTextMessage.text;
      } else if (msg.message.imageMessage) {
        textContent = msg.message.imageMessage.caption;
      } else if (msg.message.videoMessage) {
        textContent = msg.message.videoMessage.caption;
      }

      logger.debug(`Tipo de mensagem detectado: ${messageType} para mensagem ${msg.key.id}`, {
        label: 'MySQLDBManager.upsertMessage',
        messageId: msg.key.id,
        messageType,
        hasContent: !!textContent,
      });
    }

    const sql = `
      INSERT INTO Messages (
        message_id, chat_jid, sender_jid, from_me, message_timestamp, push_name,
        message_type, quoted_message_id, quoted_message_sender_jid, raw_message_content,
        created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, UNIX_TIMESTAMP(), UNIX_TIMESTAMP())
      ON DUPLICATE KEY UPDATE
        push_name = VALUES(push_name),
        message_type = VALUES(message_type),
        raw_message_content = VALUES(raw_message_content),
        updated_at = UNIX_TIMESTAMP();
    `;
    try {
      const messageTimestamp = typeof msg.messageTimestamp === 'number' ? msg.messageTimestamp : msg.messageTimestamp?.low || msg.messageTimestamp?.toNumber?.();

      await this.executeQuery(sql, [msg.key.id, chatJid, senderJid, msg.key.fromMe ? 1 : 0, messageTimestamp, msg.pushName, messageType, msg.message?.extendedTextMessage?.contextInfo?.stanzaId || null, msg.message?.extendedTextMessage?.contextInfo?.participant || null, JSON.stringify(msg.message || {})]);

      const updateChatSql = 'UPDATE Chats SET last_message_timestamp = ?, unread_count = CASE WHEN ? = 0 THEN unread_count + 1 ELSE unread_count END, updated_at = UNIX_TIMESTAMP() WHERE jid = ? AND (? > COALESCE(last_message_timestamp, 0))';
      await this.executeQuery(updateChatSql, [messageTimestamp, msg.key.fromMe ? 1 : 0, chatJid, messageTimestamp]);
    } catch (error) {
      logger.error(`Erro ao fazer upsert da mensagem ${msg.key?.id} no MySQL: ${error.message}`, { label: 'MySQLDBManager.upsertMessage', messageKey: msg.key, error: error.message, stack: error.stack });
    }
  }

  /**
   * @async
   * @method upsertMessagesBatch
   * @description
   * Insere ou atualiza múltiplas mensagens em lote.
   * 1. Garante que as entradas de chat para as mensagens existam usando `upsertChatsBatch`.
   * 2. Faz upsert em lote na tabela `Messages`.
   * 3. Atualiza `last_message_timestamp` e `unread_count` na tabela `Chats` para os chats afetados.
   * @param {Array<BaileysWAMessage>} messages - Array de objetos de mensagem Baileys.
   * @returns {Promise<Array<BaileysWAMessage>>} Uma promessa que resolve com o array original de mensagens (potencialmente para uso posterior com dados aumentados, embora atualmente não aumente).
   * @throws {Error} Se o upsert em lote das mensagens (tabela Messages) falhar.
   */
  async upsertMessagesBatch(messages) {
    if (!messages || messages.length === 0) {
      logger.debug('upsertMessagesBatch chamado com array de mensagens vazio ou nulo.', { label: 'MySQLDBManager.upsertMessagesBatch' });
      return [];
    }

    const chatDataMap = new Map();
    messages.forEach((msg) => {
      const chatJid = msg.key.remoteJid;
      if (!chatDataMap.has(chatJid)) {
        const senderJid = msg.key.participant || (msg.key.fromMe ? null : msg.key.remoteJid);
        chatDataMap.set(chatJid, {
          id: chatJid,
          name: chatJid.endsWith('@g.us') ? 'Grupo' : msg.pushName || (senderJid ? senderJid.split('@')[0] : chatJid.split('@')[0]),
          is_group: chatJid.endsWith('@g.us') ? 1 : 0,
        });
      }
    });
    if (chatDataMap.size > 0) {
      await this.upsertChatsBatch(Array.from(chatDataMap.values())).catch((e) => logger.error(`Erro no upsertChatsBatch dentro de upsertMessagesBatch: ${e.message}`, { label: 'MySQLDBManager.upsertMessagesBatch' }));
    }

    const messageSql = `
      INSERT INTO Messages (
        message_id, chat_jid, sender_jid, from_me, message_timestamp, push_name,
        message_type, quoted_message_id, quoted_message_sender_jid, raw_message_content,
        created_at, updated_at
      )
      VALUES ?
      ON DUPLICATE KEY UPDATE
        push_name = VALUES(push_name),
        message_type = VALUES(message_type),
        raw_message_content = VALUES(raw_message_content),
        updated_at = UNIX_TIMESTAMP();
    `;
    const messageValues = messages.map((msg) => {
      const senderJid = msg.key.participant || (msg.key.fromMe ? null : msg.key.remoteJid);
      const messageTimestamp = typeof msg.messageTimestamp === 'number' ? msg.messageTimestamp : msg.messageTimestamp?.low || msg.messageTimestamp?.toNumber?.();
      let messageType = msg.messageContentType || 'unknown';
      if (messageType === 'unknown' && msg.message) {
        messageType = getContentType(msg.message) || 'unknown';
      }
      return [msg.key.id, msg.key.remoteJid, senderJid, msg.key.fromMe ? 1 : 0, messageTimestamp, msg.pushName, messageType, msg.message?.extendedTextMessage?.contextInfo?.stanzaId || null, msg.message?.extendedTextMessage?.contextInfo?.participant || null, JSON.stringify(msg.message || {}), Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000)];
    });

    if (messageValues.length > 0) {
      await this.executeQuery(messageSql, [messageValues]);
      logger.info(`[METRIC] Lote de ${messages.length} mensagens salvo/atualizado na tabela Messages.`, { label: 'MySQLDBManager.upsertMessagesBatch', count: messages.length, metricName: 'mysql.batch_upsert.messages.success' });
    }

    const chatUpdates = new Map();
    messages.forEach((msg) => {
      const chatJid = msg.key.remoteJid;
      const messageTimestamp = typeof msg.messageTimestamp === 'number' ? msg.messageTimestamp : msg.messageTimestamp?.low || msg.messageTimestamp?.toNumber?.();
      const update = chatUpdates.get(chatJid) || { latestTimestamp: 0, newUnread: 0 };
      if (messageTimestamp > update.latestTimestamp) {
        update.latestTimestamp = messageTimestamp;
      }
      if (!msg.key.fromMe) {
        update.newUnread += 1;
      }
      chatUpdates.set(chatJid, update);
    });

    const updateChatPromises = [];
    for (const [jid, update] of chatUpdates.entries()) {
      if (update.latestTimestamp > 0 || update.newUnread > 0) {
        const sqlUpdateChat = `
          UPDATE Chats SET
            last_message_timestamp = GREATEST(COALESCE(last_message_timestamp, 0), ?),
            unread_count = unread_count + ?,
            updated_at = UNIX_TIMESTAMP()
          WHERE jid = ?;`;
        updateChatPromises.push(this.executeQuery(sqlUpdateChat, [update.latestTimestamp, update.newUnread, jid]));
      }
    }
    await Promise.allSettled(updateChatPromises);
    return messages; // Retorna as mensagens originais
  }

  /**
   * @async
   * @method upsertMessageReceipt
   * @description
   * Insere ou atualiza um recibo de mensagem na tabela `MessageReceipts`.
   * Um recibo indica o status de uma mensagem para um destinatário específico (ex: 'delivered', 'read', 'played').
   * A chave primária da tabela `MessageReceipts` é composta por `(message_id, chat_jid, recipient_jid, receipt_type)`,
   * então uma nova entrada é criada para cada tipo de recibo diferente para o mesmo destinatário,
   * ou o `receipt_timestamp` é atualizado se o mesmo tipo de recibo for recebido novamente.
   *
   * Se `receiptType` for nulo ou indefinido, ele é padronizado para 'delivered'.
   * O `receiptTimestamp` é normalizado para um número. Se não puder ser normalizado,
   * `UNIX_TIMESTAMP()` (timestamp atual do servidor MySQL) é usado como fallback na query.
   * @param {BaileysWAMessageKey} messageKey - A chave da mensagem à qual o recibo se refere.
   * @param {{id: string, remoteJid: string}} messageKey - A chave da mensagem à qual o recibo se refere.
   * Deve conter `id` (ID da mensagem) e `remoteJid` (JID do chat).
   * @param {string} recipientJid - O JID do usuário/participante que gerou o recibo.
   * @param {string} [receiptType='delivered'] - O tipo de recibo (ex: 'delivered', 'read', 'played').
   *                                            Padrão é 'delivered' se não fornecido.
   * @param {number | Long | null} receiptTimestamp - O timestamp UNIX do recibo. Pode ser um número,
   *                                                  um objeto Long.js, ou `null`/`undefined`.
   *
   * @returns {Promise<void>} Uma promessa que resolve quando a operação de upsert do recibo é concluída.
   * @throws {Error} Erros são registrados pelo logger, mas não são propagados por este método.
   *
   * @example
   * const msgKey = { id: 'ABCDEF123456', remoteJid: '5511999999999@s.whatsapp.net' };
   * const recipient = '5511888888888@s.whatsapp.net'; // JID do destinatário que leu a mensagem
   * await dbManager.upsertMessageReceipt(msgKey, recipient, 'read', 1678886500);
   *
   * // Exemplo com timestamp nulo (usará o tempo atual do DB)
   * await dbManager.upsertMessageReceipt(msgKey, recipient, 'delivered', null);
   */
  async upsertMessageReceipt(messageKey, recipientJid, receiptType, receiptTimestamp) {
    if (!messageKey?.id || !messageKey?.remoteJid || !recipientJid) {
      logger.warn('Dados inválidos para upsert de recibo (faltando messageKey.id, messageKey.remoteJid ou recipientJid).', {
        label: 'MySQLDBManager.upsertMessageReceipt',
        messageKey,
        recipientJid,
        originalReceiptType: receiptType,
      });
      return;
    }

    const finalReceiptType = receiptType || 'delivered';

    try {
      const checkMessageSql = 'SELECT 1 FROM Messages WHERE message_id = ? AND chat_jid = ? LIMIT 1';
      const rows = await this.executeQuery(checkMessageSql, [messageKey.id, messageKey.remoteJid]);

      if (rows.length === 0) {
        logger.warn(`Mensagem pai (ID: ${messageKey.id}, ChatJID: ${messageKey.remoteJid}) não encontrada. Recibo para ${recipientJid} (tipo ${finalReceiptType}) não será inserido.`, {
          label: 'MySQLDBManager.upsertMessageReceipt',
          messageKey,
          recipientJid,
          receiptType: finalReceiptType,
          reason: 'Parent message not found in Messages table',
        });
        return;
      }
    } catch (checkError) {
      logger.error(`Erro ao verificar a existência da mensagem pai para o recibo (MsgID: ${messageKey.id}, ChatJID: ${messageKey.remoteJid}): ${checkError.message}`, {
        label: 'MySQLDBManager.upsertMessageReceipt',
        messageKey,
        recipientJid,
        error: checkError.message,
        stack: checkError.stack,
      });
      return;
    }

    const sql = `
      INSERT INTO MessageReceipts (message_id, chat_jid, recipient_jid, receipt_type, receipt_timestamp)
      VALUES (?, ?, ?, ?, COALESCE(?, UNIX_TIMESTAMP()))
      ON DUPLICATE KEY UPDATE
        receipt_timestamp = COALESCE(VALUES(receipt_timestamp), receipt_timestamp);
        -- Atualiza o timestamp se o novo valor for fornecido e válido, 
        -- caso contrário, mantém o timestamp existente.
        -- COALESCE(?, UNIX_TIMESTAMP()) no INSERT garante que um timestamp seja sempre inserido.
    `;
    try {
      const timestamp = typeof receiptTimestamp === 'number' ? receiptTimestamp : receiptTimestamp?.low || receiptTimestamp?.toNumber?.() || null;

      await this.executeQuery(sql, [messageKey.id, messageKey.remoteJid, recipientJid, finalReceiptType, timestamp]);

      logger.debug(`Recibo para msg ${messageKey.id} (tipo ${finalReceiptType}, user ${recipientJid}) salvo no MySQL.`, { label: 'MySQLDBManager' });
    } catch (error) {
      logger.error(`Erro ao fazer upsert do recibo para msg ${messageKey?.id} (user ${recipientJid}) no MySQL: ${error.message}`, {
        label: 'MySQLDBManager.upsertMessageReceipt',
        messageKey,
        recipientJid,
        error: error.message,
        stack: error.stack,
      });
    }
  }

  /**
   * @async
   * @method upsertMessageReceiptsBatch
   * @description
   * Insere ou atualiza múltiplos recibos de mensagem em lote.
   * Filtra recibos para garantir que as mensagens pai existam antes de tentar o upsert.
   * @param {Array<Object>} receipts - Array de objetos de recibo. Cada objeto deve ter `key` (da mensagem), `userJid`, `type`, `timestamp`.
   * @returns {Promise<void>}
   * @throws {Error} Se o upsert em lote dos recibos falhar.
   */
  async upsertMessageReceiptsBatch(receipts) {
    if (!receipts || receipts.length === 0) {
      logger.debug('upsertMessageReceiptsBatch chamado com array de recibos vazio ou nulo.', { label: 'MySQLDBManager.upsertMessageReceiptsBatch' });
      return;
    }

    const messageKeysToCheck = receipts.map((r) => [r.key.id, r.key.remoteJid]);
    const uniqueMessageKeys = Array.from(new Set(messageKeysToCheck.map(JSON.stringify))).map(JSON.parse);

    const existingMessages = new Set();
    if (uniqueMessageKeys.length > 0) {
      const placeholders = uniqueMessageKeys.map(() => '(?,?)').join(',');
      const checkMessagesSql = `SELECT DISTINCT message_id, chat_jid FROM Messages WHERE (message_id, chat_jid) IN (${placeholders})`;
      const flatKeys = uniqueMessageKeys.flat();
      try {
        const rows = await this.executeQuery(checkMessagesSql, flatKeys);
        rows.forEach((row) => existingMessages.add(`${row.message_id}|${row.chat_jid}`));
      } catch (checkError) {
        logger.error(`Erro ao verificar mensagens existentes para lote de recibos: ${checkError.message}`, { label: 'MySQLDBManager.upsertMessageReceiptsBatch', error: checkError.message });
      }
    }

    const validReceipts = receipts.filter((r) => existingMessages.has(`${r.key.id}|${r.key.remoteJid}`));
    if (receipts.length !== validReceipts.length) {
      logger.warn(`${receipts.length - validReceipts.length} recibos ignorados (mensagem pai não encontrada).`, { label: 'MySQLDBManager.upsertMessageReceiptsBatch' });
    }

    if (validReceipts.length === 0) return;

    const receiptSql = `
      INSERT INTO MessageReceipts (message_id, chat_jid, recipient_jid, receipt_type, receipt_timestamp)
      VALUES ?
      ON DUPLICATE KEY UPDATE
        receipt_timestamp = COALESCE(VALUES(receipt_timestamp), MessageReceipts.receipt_timestamp);
    `;
    const receiptValues = validReceipts.map((receipt) => {
      let ts = typeof receipt.timestamp === 'number' ? receipt.timestamp : receipt.timestamp?.low || receipt.timestamp?.toNumber?.();
      if (ts == null) ts = Math.floor(Date.now() / 1000);
      return [receipt.key.id, receipt.key.remoteJid, receipt.userJid, receipt.type || 'delivered', ts];
    });

    await this.executeQuery(receiptSql, [receiptValues]);
    logger.info(`[METRIC] Lote de ${validReceipts.length} recibos de mensagem salvo/atualizado no MySQL.`, {
      label: 'MySQLDBManager.upsertMessageReceiptsBatch',
      count: validReceipts.length,
      metricName: 'mysql.batch_upsert.receipts.success',
    });
  }

  /**
   * @async
   * @method deleteChatData
   * @description
   * Remove todos os dados associados a um chat específico do banco de dados.
   * A remoção é em cascata devido às chaves estrangeiras `ON DELETE CASCADE`:
   * - Se o `chatJid` pertencer a um grupo (termina com '@g.us'), a entrada correspondente
   *   na tabela `Groups` (e, por cascata, `GroupParticipants`) é removida.
   * - A entrada na tabela `Chats` é removida.
   * - Por cascata, todas as mensagens (`Messages`) e recibos de mensagens (`MessageReceipts`)
   *   associados a este `chatJid` também são removidos.
   *
   * @param {string} chatJid - O JID do chat cujos dados devem ser removidos.
   *
   * @returns {Promise<void>} Uma promessa que resolve quando os dados do chat são removidos.
   * @throws {Error} Erros são registrados pelo logger, mas não são propagados por este método.
   *
   * @example
   * const chatToDeletJid = '5511999999999@s.whatsapp.net';
   * await dbManager.deleteChatData(chatToDeletJid);
   *
   * const groupToDeleteJid = '1234567890@g.us';
   * await dbManager.deleteChatData(groupToDeleteJid);
   */
  async deleteChatData(chatJid) {
    try {
      if (chatJid.endsWith('@g.us')) {
        await this.executeQuery('DELETE FROM Groups WHERE jid = ?', [chatJid]);
      }
      await this.executeQuery('DELETE FROM Chats WHERE jid = ?', [chatJid]);
      logger.info(`Dados do chat ${chatJid} removidos do MySQL.`, { label: 'MySQLDBManager.deleteChatData', jid: chatJid });
    } catch (error) {
      logger.error(`Erro ao deletar dados do chat ${chatJid} no MySQL: ${error.message}`, { label: 'MySQLDBManager.deleteChatData', jid: chatJid, error: error.message, stack: error.stack });
    }
  }

  /**
   * @async
   * @method deleteChatsDataBatch
   * @description
   * Remove todos os dados associados a múltiplos chats em lote.
   * Utiliza uma transação para garantir atomicidade.
   * @param {Array<string>} jids - Array de JIDs dos chats a serem removidos.
   * @returns {Promise<void>}
   * @throws {Error} Se a remoção em lote falhar.
   */
  async deleteChatsDataBatch(jids) {
    if (!jids || jids.length === 0) {
      logger.debug('deleteChatsDataBatch chamado com array de JIDs vazio ou nulo.', { label: 'MySQLDBManager.deleteChatsDataBatch' });
      return;
    }

    const groupJids = jids.filter((jid) => jid.endsWith('@g.us'));
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      if (groupJids.length > 0) {
        const groupPlaceholders = groupJids.map(() => '?').join(',');
        await connection.query(`DELETE FROM Groups WHERE jid IN (${groupPlaceholders})`, groupJids);
      }
      const chatPlaceholders = jids.map(() => '?').join(',');
      await connection.query(`DELETE FROM Chats WHERE jid IN (${chatPlaceholders})`, jids);
      await connection.commit();
      logger.info(`[METRIC] Dados para ${jids.length} chats removidos em lote do MySQL.`, { label: 'MySQLDBManager.deleteChatsDataBatch', count: jids.length, metricName: 'mysql.batch_delete.chats.success' });
    } catch (error) {
      await connection.rollback();
      logger.error(`[METRIC] Erro ao deletar dados para ${jids.length} chats em lote no MySQL: ${error.message}`, { label: 'MySQLDBManager.deleteChatsDataBatch', count: jids.length, error: error.message, stack: error.stack, metricName: 'mysql.batch_delete.chats.error' });
      throw error;
    } finally {
      connection.release();
    }
  }

  /**
   * @async
   * @method closePool
   * @description
   * Fecha o pool de conexões MySQL, liberando todos os recursos associados.
   * Este método deve ser chamado quando a aplicação está sendo encerrada para garantir
   * que todas as conexões com o banco de dados sejam fechadas corretamente.
   * Se o pool já estiver fechado ou não tiver sido inicializado (`this.pool` é `null`),
   * o método não faz nada além de registrar um aviso (se aplicável).
   *
   * @returns {Promise<void>} Uma promessa que resolve quando o pool é fechado com sucesso.
   * @throws {Error} Erros ao fechar o pool são registrados pelo logger, mas não são propagados.
   *
   * @example
   * // Em um processo de desligamento da aplicação:
   * await dbManager.closePool();
   * logger.info('Aplicação encerrada.');
   */
  async closePool() {
    if (this.pool) {
      try {
        await this.pool.end();
        logger.info('Pool de conexões MySQL fechado com sucesso.', { label: 'MySQLDBManager.closePool' });
        this.pool = null;
      } catch (err) {
        logger.error('Erro ao fechar pool de conexões MySQL:', { label: 'MySQLDBManager.closePool', message: err.message });
      }
    } else {
      logger.warn('Tentativa de fechar pool de conexões MySQL que não está inicializado ou já foi fechado.', { label: 'MySQLDBManager' });
    }
  }
}

/**
 * @type {MySQLDBManager | null}
 * @private
 * @description
 * Instância singleton da classe `MySQLDBManager`.
 * É inicializada na primeira chamada a `getInstance()`.
 */
let instance = null;

module.exports = {
  /**
   * @async
   * @function getInstance
   * @description
   * Obtém a instância singleton do `MySQLDBManager`.
   * Se a instância ainda não existir, ela é criada e o método `initialize()`
   * é chamado para configurar a conexão com o banco de dados e as tabelas.
   * Chamadas subsequentes retornam a instância já existente.
   * Este é o método preferencial para obter acesso ao `MySQLDBManager`.
   *
   * @returns {Promise<MySQLDBManager>} Uma promessa que resolve com a instância
   * inicializada do `MySQLDBManager`.
   * @throws {Error} Lança um erro se a inicialização da instância do `MySQLDBManager` falhar.
   * Este erro geralmente se origina do método `initialize()` da classe.
   *
   * @example
   * async function main() {
   *   try {
   *     const dbManager = await MySQLDBManager.getInstance();
   *     // Usar dbManager para operações de banco de dados
   *     const chats = await dbManager.executeQuery('SELECT * FROM Chats LIMIT 10');
   *     console.log(chats);
   *   } catch (error) {
   *     console.error('Falha ao obter instância do DBManager:', error);
   *   }
   * }
   * main();
   */
  getInstance: async () => {
    if (!instance) {
      const tempInstance = new MySQLDBManager();
      await tempInstance.initialize(); // A inicialização pode lançar um erro
      instance = tempInstance;
    }
    return instance;
  },
  /**
   * @description
   * Exporta a própria classe `MySQLDBManager` para permitir a criação de instâncias
   * de forma manual, se necessário, ou para fins de teste e extensão.
   * No entanto, para uso geral na aplicação, `getInstance()` é o método recomendado
   * para garantir o padrão singleton.
   *
   * @type {Class<MySQLDBManager>}
   * @example
   * // Uso menos comum, preferir getInstance()
   * const manualInstance = new MySQLDBManager.MySQLDBManagerClass();
   * await manualInstance.initialize();
   * // ... usar manualInstance
   * await manualInstance.closePool();
   */
  MySQLDBManagerClass: MySQLDBManager,
};
