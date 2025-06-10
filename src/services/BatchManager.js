const logger = require('../utils/logs/logger');
const PerformanceMonitor = require('./PerformanceMonitor');

/**
 * Gerenciador centralizado de processamento em lote
 * Coordena o fluxo de dados entre ConnectionManager, DataManager e MessageController
 */
class BatchManager {
  constructor(options = {}) {
    this.instanceId = options.instanceId || 'omnizap-instance';
    this.batchSize = options.batchSize || 50;
    this.flushInterval = options.flushInterval || 5000;
    this.buffers = {
      messages: [],
      chats: [],
      groups: [],
      contacts: [],
      receipts: [],
      reactions: [],
    };

    this.flushTimers = {};

    this.processors = {};

    this.performanceMonitor = new PerformanceMonitor({
      instanceId: this.instanceId,
      reportInterval: 60000,
    });

    this.stats = {
      totalProcessed: 0,
      batchesProcessed: 0,
      lastFlush: null,
      bufferSizes: {},
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
      label: 'BatchManager.registerProcessor',
      type,
      instanceId: this.instanceId,
    });
  }

  /**
   * Adiciona item ao buffer e agenda flush se necessário
   */
  addToBuffer(type, item) {
    if (!this.buffers[type]) {
      logger.warn(`Tipo de buffer desconhecido: ${type}`, {
        label: 'BatchManager.addToBuffer',
        type,
        instanceId: this.instanceId,
      });
      return;
    }

    this.buffers[type].push(item);

    this.stats.bufferSizes[type] = this.buffers[type].length;

    if (this.buffers[type].length >= this.batchSize) {
      this.flushBuffer(type);
    } else {
      this.scheduleFlush(type);
    }
  }

  /**
   * Agenda flush automático por timeout
   */
  scheduleFlush(type) {
    if (this.flushTimers[type]) {
      return;
    }

    this.flushTimers[type] = setTimeout(() => {
      this.flushBuffer(type);
    }, this.flushInterval);
  }

  /**
   * Força o flush de um buffer específico
   */
  async flushBuffer(type) {
    if (this.flushTimers[type]) {
      clearTimeout(this.flushTimers[type]);
      delete this.flushTimers[type];
    }

    const items = this.buffers[type].splice(0);

    if (items.length === 0) {
      return;
    }

    const startTime = Date.now();

    this.stats.bufferSizes[type] = 0;
    this.stats.totalProcessed += items.length;
    this.stats.batchesProcessed++;
    this.stats.lastFlush = new Date().toISOString();

    logger.info(`Processando lote de ${items.length} itens do tipo '${type}'`, {
      label: 'BatchManager.flushBuffer',
      type,
      count: items.length,
      instanceId: this.instanceId,
    });

    try {
      if (this.processors[type]) {
        await this.processors[type](items);

        const processingTime = Date.now() - startTime;
        this.performanceMonitor.recordBatchProcessing(items.length, processingTime);

        logger.debug(`Lote do tipo '${type}' processado em ${processingTime}ms`, {
          label: 'BatchManager.flushBuffer',
          type,
          count: items.length,
          processingTime,
          instanceId: this.instanceId,
        });
      } else {
        logger.warn(`Nenhum processador registrado para tipo: ${type}`, {
          label: 'BatchManager.flushBuffer',
          type,
          count: items.length,
          instanceId: this.instanceId,
        });
      }
    } catch (error) {
      this.performanceMonitor.recordError();
      logger.error(`Erro ao processar lote do tipo '${type}': ${error.message}`, {
        label: 'BatchManager.flushBuffer',
        type,
        count: items.length,
        error: error.message,
        stack: error.stack,
        instanceId: this.instanceId,
      });
    }
  }

  /**
   * Força o flush de todos os buffers
   */
  async flushAll() {
    const types = Object.keys(this.buffers);
    const promises = types.map((type) => this.flushBuffer(type));
    await Promise.allSettled(promises);
  }

  /**
   * Retorna estatísticas do gerenciador
   */
  getStats() {
    return {
      ...this.stats,
      uptime: Date.now() - (this.startTime || Date.now()),
      currentBufferSizes: { ...this.stats.bufferSizes },
    };
  }

  /**
   * Inicia o gerenciador
   */
  start() {
    this.startTime = Date.now();
    this.performanceMonitor.start();

    logger.info('BatchManager iniciado', {
      label: 'BatchManager.start',
      batchSize: this.batchSize,
      flushInterval: this.flushInterval,
      instanceId: this.instanceId,
    });
  }

  /**
   * Para o gerenciador e faz flush de todos os buffers
   */
  async stop() {
    logger.info('Parando BatchManager...', {
      label: 'BatchManager.stop',
      instanceId: this.instanceId,
    });

    Object.values(this.flushTimers).forEach((timer) => clearTimeout(timer));
    this.flushTimers = {};

    await this.flushAll();

    this.performanceMonitor.stop();

    logger.info('BatchManager parado', {
      label: 'BatchManager.stop',
      stats: this.getStats(),
      instanceId: this.instanceId,
    });
  }
}

module.exports = BatchManager;
