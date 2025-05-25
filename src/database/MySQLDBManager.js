const mysql = require('mysql2/promise');
const path = require('path');
const { cleanEnv, num, str, host, port } = require('envalid');
const logger = require('../utils/logs/logger');

require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const env = cleanEnv(process.env, {
  MYSQL_HOST: host({ default: 'localhost' }),
  MYSQL_PORT: port({ default: 3306 }),
  MYSQL_USER: str(),
  MYSQL_PASSWORD: str(),
  MYSQL_DATABASE_NAME: str({ default: 'omnizap_db' }),
  REDIS_PREFIX_CONTACT: str({ default: 'contact:' }),
  REDIS_PREFIX_CHAT: str({ default: 'chat:' }),
  REDIS_PREFIX_GROUP: str({ default: 'group:' }),
  REDIS_PREFIX_MESSAGE: str({ default: 'message:' }),
});

class MySQLDBManager {
  constructor() {
    this.pool = null;
    this.dbConfig = {
      host: env.MYSQL_HOST,
      port: env.MYSQL_PORT,
      user: env.MYSQL_USER,
      password: env.MYSQL_PASSWORD,
    };
    this.dbName = env.MYSQL_DATABASE_NAME;

    this.REDIS_PREFIX_CONTACT = env.REDIS_PREFIX_CONTACT;
    this.REDIS_PREFIX_CHAT = env.REDIS_PREFIX_CHAT;
    this.REDIS_PREFIX_GROUP = env.REDIS_PREFIX_GROUP;
    this.REDIS_PREFIX_MESSAGE = env.REDIS_PREFIX_MESSAGE;
  }

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
      logger.info(`Banco de dados '${this.dbName}' verificado/criado com sucesso.`, { label: 'MySQLDBManager' });

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

  async initializeTables() {
    const queries = [
      `CREATE TABLE IF NOT EXISTS \`Contacts\` (
        jid VARCHAR(255) PRIMARY KEY,
        name VARCHAR(255),
        push_name VARCHAR(255),
        verified_name VARCHAR(255),
        img_url TEXT,
        is_blocked BOOLEAN DEFAULT 0,
        last_presence_type VARCHAR(50),
        last_presence_timestamp BIGINT,
        created_at BIGINT,
        updated_at BIGINT
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`,

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
        FOREIGN KEY (jid) REFERENCES \`Chats\`(jid) ON DELETE CASCADE,
        FOREIGN KEY (owner_jid) REFERENCES \`Contacts\`(jid) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`,

      `CREATE TABLE IF NOT EXISTS \`GroupParticipants\` (
        group_jid VARCHAR(255) NOT NULL,
        participant_jid VARCHAR(255) NOT NULL,
        admin_status VARCHAR(50) COMMENT 'e.g., admin, superadmin, null',
        PRIMARY KEY (group_jid, participant_jid),
        FOREIGN KEY (group_jid) REFERENCES \`Groups\`(jid) ON DELETE CASCADE,
        FOREIGN KEY (participant_jid) REFERENCES \`Contacts\`(jid) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`,

      `CREATE TABLE IF NOT EXISTS \`Messages\` (
        message_id VARCHAR(255) NOT NULL,
        chat_jid VARCHAR(255) NOT NULL,
        sender_jid VARCHAR(255),
        from_me BOOLEAN NOT NULL,
        message_timestamp BIGINT NOT NULL,
        push_name VARCHAR(255),
        message_type VARCHAR(50),
        media_thumbnail LONGBLOB,
        quoted_message_id VARCHAR(255),
        quoted_message_sender_jid VARCHAR(255),
        raw_message_content JSON COMMENT 'Store the raw Baileys message object as JSON',
        created_at BIGINT,
        updated_at BIGINT,
        PRIMARY KEY (message_id, chat_jid),
        INDEX idx_messages_chat_timestamp (chat_jid, message_timestamp),
        INDEX idx_messages_sender (sender_jid),
        FOREIGN KEY (chat_jid) REFERENCES \`Chats\`(jid) ON DELETE CASCADE,
        FOREIGN KEY (sender_jid) REFERENCES \`Contacts\`(jid) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`,

      `CREATE TABLE IF NOT EXISTS \`MessageReceipts\` (
        message_id VARCHAR(255) NOT NULL,
        chat_jid VARCHAR(255) NOT NULL,
        recipient_jid VARCHAR(255) NOT NULL,
        receipt_type VARCHAR(50) NOT NULL COMMENT 'e.g., delivered, read, played',
        receipt_timestamp BIGINT NOT NULL,
        PRIMARY KEY (message_id(191), chat_jid(191), recipient_jid(191), receipt_type),
        FOREIGN KEY (message_id, chat_jid) REFERENCES \`Messages\`(message_id, chat_jid) ON DELETE CASCADE,
        FOREIGN KEY (recipient_jid) REFERENCES \`Contacts\`(jid) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`,
    ];

    const connection = await this.pool.getConnection();
    try {
      for (const query of queries) {
        await connection.query(query);
      }
      logger.info('Tabelas MySQL inicializadas/verificadas.', { label: 'MySQLDBManager' });
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

  async executeQuery(sql, params = []) {
    let connection;
    try {
      connection = await this.pool.getConnection();
      const [results] = await connection.query(sql, params);
      return results;
    } catch (err) {
      logger.error('Erro ao executar query MySQL:', { label: 'MySQLDBManager', sql, params, message: err.message });
      throw err;
    } finally {
      if (connection) connection.release();
    }
  }

  async upsertContact(contact) {
    const sql = `
      INSERT INTO Contacts (jid, name, push_name, verified_name, img_url, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, UNIX_TIMESTAMP(), UNIX_TIMESTAMP())
      ON DUPLICATE KEY UPDATE
        name = VALUES(name),
        push_name = VALUES(push_name),
        verified_name = VALUES(verified_name),
        img_url = VALUES(img_url),
        updated_at = UNIX_TIMESTAMP();
    `;
    try {
      await this.executeQuery(sql, [contact.id, contact.name, contact.notify, contact.verifiedName, contact.imgUrl]);
      logger.debug(`Contato ${contact.id} salvo/atualizado no MySQL.`, { label: 'MySQLDBManager', jid: contact.id });
    } catch (error) {}
  }

  async upsertChat(chat) {
    const sql = `
      INSERT INTO Chats (jid, name, unread_count, last_message_timestamp, is_group, pinned_timestamp, mute_until_timestamp, archived, ephemeral_duration, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, UNIX_TIMESTAMP(), UNIX_TIMESTAMP())
      ON DUPLICATE KEY UPDATE
        name = VALUES(name),
        unread_count = VALUES(unread_count),
        last_message_timestamp = VALUES(last_message_timestamp),
        is_group = VALUES(is_group),
        pinned_timestamp = VALUES(pinned_timestamp),
        mute_until_timestamp = VALUES(mute_until_timestamp),
        archived = VALUES(archived),
        ephemeral_duration = VALUES(ephemeral_duration),
        updated_at = UNIX_TIMESTAMP();
    `;
    try {
      await this.executeQuery(sql, [chat.id, chat.name, chat.unreadCount || 0, chat.conversationTimestamp || chat.lastMessageTimestamp, chat.id.endsWith('@g.us') ? 1 : 0, chat.pinned || 0, chat.muteEndTime, chat.archived || chat.archive ? 1 : 0, chat.ephemeralDuration]);
      logger.debug(`Chat ${chat.id} salvo/atualizado no MySQL.`, { label: 'MySQLDBManager', jid: chat.id });
    } catch (error) {}
  }

  async upsertGroup(groupMetadata) {
    await this.upsertChat({
      id: groupMetadata.id,
      name: groupMetadata.subject,
      is_group: 1,
      lastMessageTimestamp: groupMetadata.creation,
      unreadCount: 0,
    });

    const sql = `
      INSERT INTO Groups (jid, subject, owner_jid, creation_timestamp, description, restrict_mode, announce_mode, img_url, created_at, updated_at)
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
    try {
      await this.executeQuery(sql, [groupMetadata.id, groupMetadata.subject, groupMetadata.owner, groupMetadata.creation, groupMetadata.desc, groupMetadata.restrict ? 1 : 0, groupMetadata.announce ? 1 : 0, groupMetadata.profilePictureUrl]);
      logger.debug(`Grupo ${groupMetadata.id} salvo/atualizado no MySQL.`, { label: 'MySQLDBManager', jid: groupMetadata.id });

      if (groupMetadata.participants && groupMetadata.participants.length > 0) {
        await this.updateGroupParticipants(groupMetadata.id, groupMetadata.participants);
      }
    } catch (error) {}
  }

  async updateGroupParticipants(groupJid, participants) {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.query('DELETE FROM GroupParticipants WHERE group_jid = ?', [groupJid]);

      const contactUpsertPromises = participants.map((p) => this.upsertContact({ id: p.id, notify: p.push_name || p.id.split('@')[0] }));

      const contactResults = await Promise.allSettled(contactUpsertPromises);
      contactResults.forEach((result, index) => {
        if (result.status === 'rejected') {
          const participant = participants[index];
          logger.error(`Falha ao fazer upsert do contato ${participant.id} durante atualização de grupo ${groupJid}`, {
            label: 'MySQLDBManager',
            participantId: participant.id,
            groupJid,
            error: result.reason?.message,
          });
        }
      });

      const participantSql = 'INSERT INTO GroupParticipants (group_jid, participant_jid, admin_status) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE admin_status = VALUES(admin_status)';
      const participantInsertPromises = participants.map((p) => connection.query(participantSql, [groupJid, p.id, p.admin]));
      await Promise.all(participantInsertPromises);

      await connection.commit();
      logger.debug(`Participantes do grupo ${groupJid} atualizados no MySQL.`, { label: 'MySQLDBManager', groupJid });
    } catch (error) {
      await connection.rollback();
      logger.error('Erro ao atualizar participantes do grupo no MySQL (transação revertida):', { label: 'MySQLDBManager', groupJid, error: error.message });
    } finally {
      connection.release();
    }
  }

  async upsertMessage(msg) {
    const senderJid = msg.key.participant || msg.key.remoteJid;
    const chatJid = msg.key.remoteJid;

    const relatedUpsertPromises = [];
    if (senderJid) {
      relatedUpsertPromises.push(this.upsertContact({ id: senderJid, notify: msg.pushName || senderJid.split('@')[0] }));
    }
    relatedUpsertPromises.push(
      this.upsertChat({
        id: chatJid,
        name: chatJid.endsWith('@g.us') ? 'Grupo' : msg.pushName || (senderJid ? senderJid.split('@')[0] : chatJid.split('@')[0]),
      }),
    );

    const preparatoryResults = await Promise.allSettled(relatedUpsertPromises);
    preparatoryResults.forEach((result) => {
      if (result.status === 'rejected') {
        logger.warn(`Falha no upsert preparatório (contato/chat) para mensagem ${msg.key.id}. Erro: ${result.reason?.message}`, {
          label: 'MySQLDBManager',
          messageKey: msg.key,
          error: result.reason?.message,
        });
      }
    });
    let messageType = 'unknown';
    let textContent = null;

    if (msg.message) {
      if (msg.message.conversation) {
        messageType = 'text';
        textContent = msg.message.conversation;
      } else if (msg.message.extendedTextMessage) {
        messageType = 'text_extended';
        textContent = msg.message.extendedTextMessage.text;
      } else if (msg.message.imageMessage) {
        messageType = 'image';
        textContent = msg.message.imageMessage.caption;
      } else if (msg.message.videoMessage) {
        messageType = 'video';
        textContent = msg.message.videoMessage.caption;
      } else if (msg.message.protocolMessage && msg.message.protocolMessage.type === 0) {
        messageType = 'revoked';
      }
    }

    const sql = `
      INSERT INTO Messages (
        message_id, chat_jid, sender_jid, from_me, message_timestamp, push_name,
        message_type, media_thumbnail, quoted_message_id, quoted_message_sender_jid, raw_message_content,
        created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, UNIX_TIMESTAMP(), UNIX_TIMESTAMP())
      ON DUPLICATE KEY UPDATE
        push_name = VALUES(push_name),
        message_type = VALUES(message_type),
        raw_message_content = VALUES(raw_message_content),
        updated_at = UNIX_TIMESTAMP();
    `;
    try {
      let mediaThumbnail = null;
      if (messageType === 'image' && msg.message.imageMessage?.jpegThumbnail) {
        mediaThumbnail = msg.message.imageMessage.jpegThumbnail;
      } else if (messageType === 'video' && msg.message.videoMessage?.jpegThumbnail) {
        mediaThumbnail = msg.message.videoMessage.jpegThumbnail;
      }

      await this.executeQuery(sql, [msg.key.id, msg.key.remoteJid, senderJid, msg.key.fromMe ? 1 : 0, typeof msg.messageTimestamp === 'number' ? msg.messageTimestamp : msg.messageTimestamp?.low || msg.messageTimestamp?.toNumber?.(), msg.pushName, messageType, mediaThumbnail, msg.message?.extendedTextMessage?.contextInfo?.stanzaId, msg.message?.extendedTextMessage?.contextInfo?.participant, JSON.stringify(msg.message || {})]);
      logger.debug(`Mensagem ${msg.key.id} salva/atualizada no MySQL.`, { label: 'MySQLDBManager', messageKey: msg.key });

      const updateChatSql = 'UPDATE Chats SET last_message_timestamp = ?, unread_count = CASE WHEN ? = 0 THEN unread_count + 1 ELSE unread_count END, updated_at = UNIX_TIMESTAMP() WHERE jid = ?';
      await this.executeQuery(updateChatSql, [typeof msg.messageTimestamp === 'number' ? msg.messageTimestamp : msg.messageTimestamp?.low || msg.messageTimestamp?.toNumber?.(), msg.key.fromMe ? 1 : 0, msg.key.remoteJid]);
    } catch (error) {}
  }

  async upsertMessageReceipt(messageKey, recipientJid, receiptType, receiptTimestamp) {
    await this.upsertContact({ id: recipientJid, notify: recipientJid.split('@')[0] });

    const sql = `
      INSERT INTO MessageReceipts (message_id, chat_jid, recipient_jid, receipt_type, receipt_timestamp)
      VALUES (?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        receipt_timestamp = VALUES(receipt_timestamp);
    `;
    try {
      await this.executeQuery(sql, [messageKey.id, messageKey.remoteJid, recipientJid, receiptType, typeof receiptTimestamp === 'number' ? receiptTimestamp : receiptTimestamp?.low || receiptTimestamp?.toNumber?.()]);
      logger.debug(`Recibo para msg ${messageKey.id} (tipo ${receiptType}, user ${recipientJid}) salvo no MySQL.`, { label: 'MySQLDBManager' });
    } catch (error) {}
  }

  async deleteChatData(chatJid) {
    try {
      if (chatJid.endsWith('@g.us')) {
        await this.executeQuery('DELETE FROM Groups WHERE jid = ?', [chatJid]);
      }
      await this.executeQuery('DELETE FROM Chats WHERE jid = ?', [chatJid]);
      logger.info(`Dados do chat ${chatJid} removidos do MySQL.`, { label: 'MySQLDBManager', jid: chatJid });
    } catch (error) {}
  }

  /**
   * Sincroniza dados do Redis para o MySQL.
   * Este método deve ser chamado após o redisClient estar disponível e potencialmente populado.
   * @param {import('ioredis').Redis} redisClient - Instância do cliente ioredis.
   */
  async syncFromRedis(redisClient) {
    logger.info('Iniciando sincronização de dados do Redis para o MySQL...', { label: 'MySQLDBManager' });

    // Sincronizar Contatos
    try {
      logger.info('Sincronizando contatos...', { label: 'MySQLDBManager' });
      let cursor = '0';
      do {
        const [nextCursor, keys] = await redisClient.scan(cursor, 'MATCH', `${this.REDIS_PREFIX_CONTACT}*`, 'COUNT', 100);
        const upsertPromises = keys.map(async (key) => {
          try {
            const contactData = await redisClient.get(key);
            if (contactData) {
              return this.upsertContact(JSON.parse(contactData));
            }
          } catch (err) {
            logger.error(`Erro ao processar chave Redis ${key} para contato: ${err.message}`, { label: 'MySQLDBManager', key });
            return Promise.reject(err);
          }
        });

        const results = await Promise.allSettled(upsertPromises);
        results.forEach((result, index) => {
          if (result.status === 'rejected') {
            const failedKey = keys[index];
            logger.error(`Falha no upsert do contato via Redis (chave: ${failedKey}):`, { label: 'MySQLDBManager', key: failedKey, error: result.reason?.message, stack: result.reason?.stack });
          }
        });
        cursor = nextCursor;
      } while (cursor !== '0');
      logger.info('Contatos sincronizados.', { label: 'MySQLDBManager' });
    } catch (error) {
      logger.error('Erro durante a varredura de contatos do Redis:', { label: 'MySQLDBManager', error: error.message });
    }

    try {
      logger.info('Sincronizando chats...', { label: 'MySQLDBManager' });
      let cursor = '0';
      do {
        const [nextCursor, keys] = await redisClient.scan(cursor, 'MATCH', `${this.REDIS_PREFIX_CHAT}*`, 'COUNT', 100);
        const upsertPromises = keys.map(async (key) => {
          try {
            const chatData = await redisClient.get(key);
            if (chatData) {
              return this.upsertChat(JSON.parse(chatData));
            }
          } catch (err) {
            logger.error(`Erro ao processar chave Redis ${key} para chat: ${err.message}`, { label: 'MySQLDBManager', key });
            return Promise.reject(err);
          }
        });
        const results = await Promise.allSettled(upsertPromises);
        results.forEach((result, index) => {
          if (result.status === 'rejected') {
            const failedKey = keys[index];
            logger.error(`Falha no upsert do chat via Redis (chave: ${failedKey}):`, { label: 'MySQLDBManager', key: failedKey, error: result.reason?.message, stack: result.reason?.stack });
          }
        });
        cursor = nextCursor;
      } while (cursor !== '0');
      logger.info('Chats sincronizados.', { label: 'MySQLDBManager' });
    } catch (error) {
      logger.error('Erro durante a varredura de chats do Redis:', { label: 'MySQLDBManager', error: error.message });
    }

    try {
      logger.info('Sincronizando grupos...', { label: 'MySQLDBManager' });
      let cursor = '0';
      do {
        const [nextCursor, keys] = await redisClient.scan(cursor, 'MATCH', `${this.REDIS_PREFIX_GROUP}*`, 'COUNT', 100);
        const upsertPromises = keys.map(async (key) => {
          try {
            const groupData = await redisClient.get(key);
            if (groupData) {
              return this.upsertGroup(JSON.parse(groupData));
            }
          } catch (err) {
            logger.error(`Erro ao processar chave Redis ${key} para grupo: ${err.message}`, { label: 'MySQLDBManager', key });
            return Promise.reject(err);
          }
        });
        const results = await Promise.allSettled(upsertPromises);
        results.forEach((result, index) => {
          if (result.status === 'rejected') {
            const failedKey = keys[index];
            logger.error(`Falha no upsert do grupo via Redis (chave: ${failedKey}):`, { label: 'MySQLDBManager', key: failedKey, error: result.reason?.message, stack: result.reason?.stack });
          }
        });
        cursor = nextCursor;
      } while (cursor !== '0');
      logger.info('Grupos sincronizados.', { label: 'MySQLDBManager' });
    } catch (error) {
      logger.error('Erro durante a varredura de grupos do Redis:', { label: 'MySQLDBManager', error: error.message });
    }

    try {
      logger.info('Sincronizando mensagens...', { label: 'MySQLDBManager' });
      let messageCursor = '0';
      do {
        const [nextCursor, keys] = await redisClient.scan(messageCursor, 'MATCH', `${this.REDIS_PREFIX_MESSAGE}*`, 'COUNT', 100); // Ajuste COUNT conforme necessário
        const messageProcessingPromises = keys.map(async (key) => {
          try {
            const messageData = await redisClient.get(key);
            if (messageData) {
              const msg = JSON.parse(messageData);
              await this.upsertMessage(msg);

              if (msg.receipts) {
                const receiptUpsertPromises = Object.entries(msg.receipts).map(([recipientJid, receipt]) =>
                  this.upsertMessageReceipt(msg.key, recipientJid, receipt.type, receipt.timestamp).catch((errRec) => {
                    logger.error(`Falha ao sincronizar recibo para msg ${msg.key.id}, user ${recipientJid} (chave Redis: ${key})`, {
                      label: 'MySQLDBManager',
                      messageKey: msg.key,
                      recipientJid,
                      redisKey: key,
                      error: errRec.message,
                    });
                  }),
                );
                await Promise.allSettled(receiptUpsertPromises);
              }
            }
          } catch (err) {
            logger.error(`Erro ao processar chave Redis ${key} para mensagem: ${err.message}`, { label: 'MySQLDBManager', key });
            throw err;
          }
        });

        const results = await Promise.allSettled(messageProcessingPromises);
        results.forEach((result, index) => {
          if (result.status === 'rejected') {
            const failedKey = keys[index];
            logger.error(`Falha geral ao processar mensagem/recibos do Redis (chave: ${failedKey}):`, { label: 'MySQLDBManager', key: failedKey, error: result.reason?.message, stack: result.reason?.stack });
          }
        });
        messageCursor = nextCursor;
      } while (messageCursor !== '0');
      logger.info('Mensagens sincronizadas.', { label: 'MySQLDBManager' });
    } catch (error) {
      logger.error('Erro durante a varredura de mensagens do Redis:', { label: 'MySQLDBManager', error: error.message });
    }

    logger.info('Sincronização de dados do Redis para o MySQL concluída.', { label: 'MySQLDBManager' });
  }

  async closePool() {
    if (this.pool) {
      try {
        await this.pool.end();
        logger.info('Pool de conexões MySQL fechado com sucesso.', { label: 'MySQLDBManager' });
        this.pool = null;
      } catch (err) {
        logger.error('Erro ao fechar pool de conexões MySQL:', { label: 'MySQLDBManager', message: err.message });
      }
    }
  }
}

let instance = null;

module.exports = {
  getInstance: async () => {
    if (!instance) {
      const tempInstance = new MySQLDBManager();
      await tempInstance.initialize();
      instance = tempInstance;
    }
    return instance;
  },
  MySQLDBManagerClass: MySQLDBManager,
};
