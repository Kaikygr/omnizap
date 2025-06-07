const logger = require('../utils/logs/logger');

/**
 * Sistema de processamento em lote para maior eficiência
 * Processa dados em buffers temporários e executa operações em lote
 */
class BatchProcessor {
  constructor(options = {}) {
    this.batchSize = options.batchSize || 50;
    this.flushInterval = options.flushInterval || 5000; // 5 segundos
    this.instanceId = options.instanceId || 'default';

    // Buffers para diferentes tipos de dados
    this.buffers = {
      messages: [],
      receipts: [],
      chats: [],
      groups: [],
      contacts: [],
      reactions: [],
    };

    // Timers para flush automático
    this.flushTimers = {};

    // Callbacks para processamento
    this.processors = {};

    this.isProcessing = false;
    this.stats = {
      totalProcessed: 0,
      batchesProcessed: 0,
      lastFlush: null,
    };
  }

  /**
   * Registra um processador para um tipo específico de dados
   */
  registerProcessor(type, processor) {
    if (typeof processor !== 'function') {
      throw new Error('Processor deve ser uma função');
    }
    this.processors[type] = processor;
    logger.debug(`Processador registrado para tipo: ${type}`, {
      label: 'BatchProcessor.registerProcessor',
      type,
      instanceId: this.instanceId,
    });
  }

  /**
   * Adiciona um item ao buffer
   */
  add(type, item) {
    if (!this.buffers[type]) {
      logger.warn(`Tipo de buffer não reconhecido: ${type}`, {
        label: 'BatchProcessor.add',
        type,
        instanceId: this.instanceId,
      });
      return;
    }

    // Adiciona timestamp para tracking
    const enrichedItem = {
      ...item,
      _batchTimestamp: Date.now(),
      _instanceId: this.instanceId,
    };

    this.buffers[type].push(enrichedItem);

    logger.debug(`Item adicionado ao buffer ${type}. Tamanho atual: ${this.buffers[type].length}`, {
      label: 'BatchProcessor.add',
      type,
      bufferSize: this.buffers[type].length,
      instanceId: this.instanceId,
    });

    // Flush automático se o buffer atingir o tamanho máximo
    if (this.buffers[type].length >= this.batchSize) {
      this.flush(type);
    } else {
      // Agenda flush automático se não existe
      this.scheduleFlush(type);
    }
  }

  /**
   * Agenda um flush automático para um tipo de buffer
   */
  scheduleFlush(type) {
    if (this.flushTimers[type]) {
      return; // Já agendado
    }

    this.flushTimers[type] = setTimeout(() => {
      this.flush(type);
    }, this.flushInterval);
  }

  /**
   * Executa o flush de um tipo específico de buffer
   */
  async flush(type) {
    if (!this.buffers[type] || this.buffers[type].length === 0) {
      return;
    }

    // Limpa o timer de flush
    if (this.flushTimers[type]) {
      clearTimeout(this.flushTimers[type]);
      delete this.flushTimers[type];
    }

    const itemsToProcess = [...this.buffers[type]];
    this.buffers[type] = []; // Limpa o buffer

    logger.info(`Iniciando processamento em lote para ${type}. Items: ${itemsToProcess.length}`, {
      label: 'BatchProcessor.flush',
      type,
      count: itemsToProcess.length,
      instanceId: this.instanceId,
    });

    if (this.processors[type]) {
      try {
        await this.processors[type](itemsToProcess);

        this.stats.totalProcessed += itemsToProcess.length;
        this.stats.batchesProcessed += 1;
        this.stats.lastFlush = new Date().toISOString();

        logger.info(`Lote processado com sucesso para ${type}. Items: ${itemsToProcess.length}`, {
          label: 'BatchProcessor.flush',
          type,
          count: itemsToProcess.length,
          totalProcessed: this.stats.totalProcessed,
          instanceId: this.instanceId,
        });
      } catch (error) {
        logger.error(`Erro ao processar lote para ${type}: ${error.message}`, {
          label: 'BatchProcessor.flush',
          type,
          count: itemsToProcess.length,
          error: error.message,
          stack: error.stack,
          instanceId: this.instanceId,
        });

        // Rejeita os itens de volta para o buffer para retry
        this.buffers[type].unshift(...itemsToProcess);
      }
    } else {
      logger.warn(`Nenhum processador registrado para tipo ${type}`, {
        label: 'BatchProcessor.flush',
        type,
        count: itemsToProcess.length,
        instanceId: this.instanceId,
      });
    }
  }

  /**
   * Flush de todos os buffers
   */
  async flushAll() {
    logger.info('Iniciando flush de todos os buffers', {
      label: 'BatchProcessor.flushAll',
      instanceId: this.instanceId,
    });

    const flushPromises = Object.keys(this.buffers).map((type) => this.flush(type));
    await Promise.allSettled(flushPromises);

    logger.info('Flush de todos os buffers concluído', {
      label: 'BatchProcessor.flushAll',
      stats: this.stats,
      instanceId: this.instanceId,
    });
  }

  /**
   * Força o processamento imediato de um tipo
   */
  async forceFlush(type) {
    if (type) {
      await this.flush(type);
    } else {
      await this.flushAll();
    }
  }

  /**
   * Retorna estatísticas do processador
   */
  getStats() {
    const bufferStats = {};
    Object.keys(this.buffers).forEach((type) => {
      bufferStats[type] = this.buffers[type].length;
    });

    return {
      ...this.stats,
      bufferSizes: bufferStats,
      isProcessing: this.isProcessing,
      instanceId: this.instanceId,
    };
  }

  /**
   * Limpa todos os buffers
   */
  clear() {
    Object.keys(this.buffers).forEach((type) => {
      this.buffers[type] = [];
    });

    Object.keys(this.flushTimers).forEach((type) => {
      clearTimeout(this.flushTimers[type]);
      delete this.flushTimers[type];
    });

    logger.info('Todos os buffers foram limpos', {
      label: 'BatchProcessor.clear',
      instanceId: this.instanceId,
    });
  }

  /**
   * Destrói o processador e limpa recursos
   */
  destroy() {
    this.clear();
    this.processors = {};
    this.isProcessing = false;

    logger.info('BatchProcessor destruído', {
      label: 'BatchProcessor.destroy',
      finalStats: this.stats,
      instanceId: this.instanceId,
    });
  }
}

module.exports = BatchProcessor;
