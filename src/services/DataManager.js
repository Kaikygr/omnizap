const BatchProcessor = require('./BatchProcessor');
const MemoryCache = require('./MemoryCache');
const logger = require('../utils/logs/logger');
const { getContentType } = require('baileys');

/**
 * Gerenciador de dados centralizado usando processamento em lote e cache em memória
 * Substitui operações de banco de dados por processamento otimizado em memória
 */
class DataManager {
  constructor(options = {}) {
    this.instanceId = options.instanceId || 'omnizap-instance';

    // Inicializa o processador em lote
    this.batchProcessor = new BatchProcessor({
      batchSize: options.batchSize || 50,
      flushInterval: options.flushInterval || 5000,
      instanceId: this.instanceId,
    });

    // Inicializa o cache em memória
    this.cache = new MemoryCache({
      defaultTTL: options.cacheTTL || 300000, // 5 minutos
      maxSize: options.cacheMaxSize || 10000,
      instanceId: this.instanceId,
    });

    // Estados dos dados em memória
    this.data = {
      messages: new Map(),
      chats: new Map(),
      contacts: new Map(),
      groups: new Map(),
      receipts: new Map(),
      reactions: new Map(),
    };

    this.stats = {
      messagesProcessed: 0,
      chatsProcessed: 0,
      contactsProcessed: 0,
      groupsProcessed: 0,
      receiptsProcessed: 0,
      reactionsProcessed: 0,
      startTime: Date.now(),
    };

    this.setupProcessors();
    this.startPeriodicTasks();
  }

  /**
   * Configura os processadores para cada tipo de dados
   */
  setupProcessors() {
    // Processador de mensagens
    this.batchProcessor.registerProcessor('messages', async (messages) => {
      await this.processMessagesBatch(messages);
    });

    // Processador de chats
    this.batchProcessor.registerProcessor('chats', async (chats) => {
      await this.processChatsBatch(chats);
    });

    // Processador de grupos
    this.batchProcessor.registerProcessor('groups', async (groups) => {
      await this.processGroupsBatch(groups);
    });

    // Processador de contatos
    this.batchProcessor.registerProcessor('contacts', async (contacts) => {
      await this.processContactsBatch(contacts);
    });

    // Processador de recibos
    this.batchProcessor.registerProcessor('receipts', async (receipts) => {
      await this.processReceiptsBatch(receipts);
    });

    // Processador de reações
    this.batchProcessor.registerProcessor('reactions', async (reactions) => {
      await this.processReactionsBatch(reactions);
    });

    logger.info('Processadores em lote configurados', {
      label: 'DataManager.setupProcessors',
      instanceId: this.instanceId,
    });
  }

  /**
   * Processa um lote de mensagens
   */
  async processMessagesBatch(messages) {
    logger.info(`Processando lote de ${messages.length} mensagens`, {
      label: 'DataManager.processMessagesBatch',
      count: messages.length,
      instanceId: this.instanceId,
    });

    for (const msg of messages) {
      try {
        const messageKey = `${msg.key.remoteJid}:${msg.key.id}`;
        const messageData = {
          key: msg.key,
          messageTimestamp: msg.messageTimestamp,
          pushName: msg.pushName,
          message: msg.message,
          messageContentType: msg.messageContentType,
          fromMe: msg.key.fromMe,
          remoteJid: msg.key.remoteJid,
          participant: msg.key.participant,
          processedAt: Date.now(),
          instanceId: this.instanceId,
        };

        // Armazena em memória
        this.data.messages.set(messageKey, messageData);

        // Cache para acesso rápido
        this.cache.set(`msg:${messageKey}`, messageData, 600000); // 10 minutos

        // Atualiza estatísticas do chat
        await this.updateChatFromMessage(msg);

        this.stats.messagesProcessed++;
      } catch (error) {
        logger.error(`Erro ao processar mensagem ${msg.key?.id}: ${error.message}`, {
          label: 'DataManager.processMessagesBatch',
          messageId: msg.key?.id,
          error: error.message,
          instanceId: this.instanceId,
        });
      }
    }

    logger.debug(`Lote de mensagens processado. Total em memória: ${this.data.messages.size}`, {
      label: 'DataManager.processMessagesBatch',
      processedCount: messages.length,
      totalInMemory: this.data.messages.size,
      instanceId: this.instanceId,
    });
  }

  /**
   * Processa um lote de chats
   */
  async processChatsBatch(chats) {
    logger.info(`Processando lote de ${chats.length} chats`, {
      label: 'DataManager.processChatsBatch',
      count: chats.length,
      instanceId: this.instanceId,
    });

    for (const chat of chats) {
      try {
        const chatData = {
          id: chat.id,
          name: chat.name,
          unreadCount: chat.unreadCount || 0,
          lastMessageTimestamp: chat.conversationTimestamp || chat.lastMessageTimestamp,
          isGroup: chat.id.endsWith('@g.us'),
          pinned: chat.pinned || 0,
          archived: chat.archived || false,
          muted: chat.muteEndTime > Date.now(),
          updatedAt: Date.now(),
          instanceId: this.instanceId,
        };

        this.data.chats.set(chat.id, chatData);
        this.cache.set(`chat:${chat.id}`, chatData, 300000); // 5 minutos

        this.stats.chatsProcessed++;
      } catch (error) {
        logger.error(`Erro ao processar chat ${chat.id}: ${error.message}`, {
          label: 'DataManager.processChatsBatch',
          chatId: chat.id,
          error: error.message,
          instanceId: this.instanceId,
        });
      }
    }
  }

  /**
   * Processa um lote de grupos
   */
  async processGroupsBatch(groups) {
    logger.info(`Processando lote de ${groups.length} grupos`, {
      label: 'DataManager.processGroupsBatch',
      count: groups.length,
      instanceId: this.instanceId,
    });

    for (const group of groups) {
      try {
        const groupData = {
          id: group.id,
          subject: group.subject,
          owner: group.owner,
          creation: group.creation,
          description: group.desc,
          participants: group.participants || [],
          participantCount: group.participants?.length || 0,
          restrict: group.restrict || false,
          announce: group.announce || false,
          profilePictureUrl: group.profilePictureUrl,
          updatedAt: Date.now(),
          instanceId: this.instanceId,
        };

        this.data.groups.set(group.id, groupData);
        this.cache.set(`group:${group.id}`, groupData, 600000); // 10 minutos

        // Também atualiza como chat
        await this.updateChatFromGroup(group);

        this.stats.groupsProcessed++;
      } catch (error) {
        logger.error(`Erro ao processar grupo ${group.id}: ${error.message}`, {
          label: 'DataManager.processGroupsBatch',
          groupId: group.id,
          error: error.message,
          instanceId: this.instanceId,
        });
      }
    }
  }

  /**
   * Processa um lote de contatos
   */
  async processContactsBatch(contacts) {
    logger.info(`Processando lote de ${contacts.length} contatos`, {
      label: 'DataManager.processContactsBatch',
      count: contacts.length,
      instanceId: this.instanceId,
    });

    for (const contact of contacts) {
      try {
        const contactData = {
          id: contact.id,
          name: contact.name || contact.notify,
          notify: contact.notify,
          status: contact.status,
          profilePictureUrl: contact.profilePictureUrl,
          updatedAt: Date.now(),
          instanceId: this.instanceId,
        };

        this.data.contacts.set(contact.id, contactData);
        this.cache.set(`contact:${contact.id}`, contactData, 600000); // 10 minutos

        this.stats.contactsProcessed++;
      } catch (error) {
        logger.error(`Erro ao processar contato ${contact.id}: ${error.message}`, {
          label: 'DataManager.processContactsBatch',
          contactId: contact.id,
          error: error.message,
          instanceId: this.instanceId,
        });
      }
    }
  }

  /**
   * Processa um lote de recibos
   */
  async processReceiptsBatch(receipts) {
    logger.info(`Processando lote de ${receipts.length} recibos`, {
      label: 'DataManager.processReceiptsBatch',
      count: receipts.length,
      instanceId: this.instanceId,
    });

    for (const receipt of receipts) {
      try {
        const receiptKey = `${receipt.key.remoteJid}:${receipt.key.id}:${receipt.userJid}:${receipt.type}`;
        const receiptData = {
          messageKey: receipt.key,
          userJid: receipt.userJid,
          type: receipt.type,
          timestamp: receipt.timestamp,
          receivedAt: Date.now(),
          instanceId: this.instanceId,
        };

        this.data.receipts.set(receiptKey, receiptData);
        this.cache.set(`receipt:${receiptKey}`, receiptData, 300000); // 5 minutos

        this.stats.receiptsProcessed++;
      } catch (error) {
        logger.error(`Erro ao processar recibo: ${error.message}`, {
          label: 'DataManager.processReceiptsBatch',
          error: error.message,
          instanceId: this.instanceId,
        });
      }
    }
  }

  /**
   * Processa um lote de reações
   */
  async processReactionsBatch(reactions) {
    logger.info(`Processando lote de ${reactions.length} reações`, {
      label: 'DataManager.processReactionsBatch',
      count: reactions.length,
      instanceId: this.instanceId,
    });

    for (const reaction of reactions) {
      try {
        const reactionKey = `${reaction.key.remoteJid}:${reaction.key.id}:${reaction.reaction.text}`;
        const reactionData = {
          messageKey: reaction.key,
          reaction: reaction.reaction,
          receivedAt: Date.now(),
          instanceId: this.instanceId,
        };

        this.data.reactions.set(reactionKey, reactionData);
        this.cache.set(`reaction:${reactionKey}`, reactionData, 300000); // 5 minutos

        this.stats.reactionsProcessed++;
      } catch (error) {
        logger.error(`Erro ao processar reação: ${error.message}`, {
          label: 'DataManager.processReactionsBatch',
          error: error.message,
          instanceId: this.instanceId,
        });
      }
    }
  }

  /**
   * Atualiza dados do chat baseado em uma mensagem
   */
  async updateChatFromMessage(message) {
    const chatId = message.key.remoteJid;
    const existingChat = this.data.chats.get(chatId) || {};

    const messageTimestamp = typeof message.messageTimestamp === 'number' ? message.messageTimestamp : message.messageTimestamp?.low || message.messageTimestamp?.toNumber?.() || Date.now();

    const chatData = {
      ...existingChat,
      id: chatId,
      name: existingChat.name || message.pushName || chatId.split('@')[0],
      lastMessageTimestamp: Math.max(existingChat.lastMessageTimestamp || 0, messageTimestamp),
      unreadCount: message.key.fromMe ? existingChat.unreadCount || 0 : (existingChat.unreadCount || 0) + 1,
      isGroup: chatId.endsWith('@g.us'),
      updatedAt: Date.now(),
      instanceId: this.instanceId,
    };

    this.data.chats.set(chatId, chatData);
    this.cache.set(`chat:${chatId}`, chatData, 300000);
  }

  /**
   * Atualiza dados do chat baseado em um grupo
   */
  async updateChatFromGroup(group) {
    const chatData = {
      id: group.id,
      name: group.subject,
      isGroup: true,
      lastMessageTimestamp: group.creation,
      unreadCount: 0,
      updatedAt: Date.now(),
      instanceId: this.instanceId,
    };

    this.data.chats.set(group.id, chatData);
    this.cache.set(`chat:${group.id}`, chatData, 300000);
  }

  /**
   * Métodos públicos para adicionar dados
   */
  addMessage(message) {
    this.batchProcessor.add('messages', message);
  }

  addChat(chat) {
    this.batchProcessor.add('chats', chat);
  }

  addGroup(group) {
    this.batchProcessor.add('groups', group);
  }

  addContact(contact) {
    this.batchProcessor.add('contacts', contact);
  }

  addReceipt(receipt) {
    this.batchProcessor.add('receipts', receipt);
  }

  addReaction(reaction) {
    this.batchProcessor.add('reactions', reaction);
  }

  /**
   * Métodos de consulta
   */
  getMessage(remoteJid, messageId) {
    const key = `${remoteJid}:${messageId}`;
    return this.cache.get(`msg:${key}`) || this.data.messages.get(key);
  }

  getChat(chatId) {
    return this.cache.get(`chat:${chatId}`) || this.data.chats.get(chatId);
  }

  getGroup(groupId) {
    return this.cache.get(`group:${groupId}`) || this.data.groups.get(groupId);
  }

  getContact(contactId) {
    return this.cache.get(`contact:${contactId}`) || this.data.contacts.get(contactId);
  }

  /**
   * Obtém estatísticas gerais
   */
  getStats() {
    const memoryUsage = {
      messages: this.data.messages.size,
      chats: this.data.chats.size,
      contacts: this.data.contacts.size,
      groups: this.data.groups.size,
      receipts: this.data.receipts.size,
      reactions: this.data.reactions.size,
    };

    return {
      ...this.stats,
      memoryUsage,
      cacheStats: this.cache.getStats(),
      batchStats: this.batchProcessor.getStats(),
      uptime: Date.now() - this.stats.startTime,
      instanceId: this.instanceId,
    };
  }

  /**
   * Inicia tarefas periódicas
   */
  startPeriodicTasks() {
    // Limpeza automática do cache
    this.cache.startAutoCleanup();

    // Flush periódico dos buffers
    setInterval(() => {
      this.batchProcessor.flushAll();
    }, 30000); // 30 segundos

    // Limpeza periódica de dados antigos
    setInterval(() => {
      this.cleanupOldData();
    }, 300000); // 5 minutos

    logger.info('Tarefas periódicas iniciadas', {
      label: 'DataManager.startPeriodicTasks',
      instanceId: this.instanceId,
    });
  }

  /**
   * Limpa dados antigos para liberar memória
   */
  cleanupOldData() {
    const now = Date.now();
    const maxAge = 24 * 60 * 60 * 1000; // 24 horas

    let cleaned = 0;

    // Limpa mensagens antigas
    for (const [key, message] of this.data.messages.entries()) {
      if (now - message.processedAt > maxAge) {
        this.data.messages.delete(key);
        cleaned++;
      }
    }

    // Limpa recibos antigos
    for (const [key, receipt] of this.data.receipts.entries()) {
      if (now - receipt.receivedAt > maxAge) {
        this.data.receipts.delete(key);
        cleaned++;
      }
    }

    // Limpa reações antigas
    for (const [key, reaction] of this.data.reactions.entries()) {
      if (now - reaction.receivedAt > maxAge) {
        this.data.reactions.delete(key);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      logger.info(`Limpeza de dados antigos: ${cleaned} entries removidas`, {
        label: 'DataManager.cleanupOldData',
        cleaned,
        instanceId: this.instanceId,
      });
    }
  }

  /**
   * Força o flush de todos os dados pendentes
   */
  async flush() {
    await this.batchProcessor.flushAll();
  }

  /**
   * Limpa todos os dados
   */
  clear() {
    Object.keys(this.data).forEach((key) => {
      this.data[key].clear();
    });
    this.cache.clear();
    this.batchProcessor.clear();

    logger.info('Todos os dados foram limpos', {
      label: 'DataManager.clear',
      instanceId: this.instanceId,
    });
  }

  /**
   * Destrói o gerenciador e libera recursos
   */
  destroy() {
    this.clear();
    this.batchProcessor.destroy();
    this.cache.destroy();

    logger.info('DataManager destruído', {
      label: 'DataManager.destroy',
      finalStats: this.getStats(),
      instanceId: this.instanceId,
    });
  }
}

module.exports = DataManager;
