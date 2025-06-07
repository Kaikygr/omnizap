const logger = require('../utils/logs/logger');

/**
 * Monitor de performance para o sistema de processamento em lote
 * Coleta métricas e estatísticas de desempenho
 */
class PerformanceMonitor {
  constructor(options = {}) {
    this.instanceId = options.instanceId || 'omnizap-instance';
    this.reportInterval = options.reportInterval || 60000; // 1 minuto

    this.metrics = {
      messagesProcessed: 0,
      batchesProcessed: 0,
      averageBatchSize: 0,
      processingTime: {
        min: Infinity,
        max: 0,
        total: 0,
        count: 0,
        avg: 0,
      },
      memoryUsage: {
        heapUsed: 0,
        heapTotal: 0,
        rss: 0,
        external: 0,
      },
      errors: 0,
      startTime: Date.now(),
    };

    this.reportTimer = null;
    this.isRunning = false;
  }

  /**
   * Inicia o monitoramento
   */
  start() {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;
    this.metrics.startTime = Date.now();

    this.reportTimer = setInterval(() => {
      this.generateReport();
    }, this.reportInterval);

    logger.info('Monitor de performance iniciado', {
      label: 'PerformanceMonitor.start',
      reportInterval: this.reportInterval,
      instanceId: this.instanceId,
    });
  }

  /**
   * Para o monitoramento
   */
  stop() {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;

    if (this.reportTimer) {
      clearInterval(this.reportTimer);
      this.reportTimer = null;
    }

    // Gera relatório final
    this.generateReport(true);

    logger.info('Monitor de performance parado', {
      label: 'PerformanceMonitor.stop',
      instanceId: this.instanceId,
    });
  }

  /**
   * Registra processamento de lote
   */
  recordBatchProcessing(batchSize, processingTimeMs) {
    this.metrics.batchesProcessed++;
    this.metrics.messagesProcessed += batchSize;

    // Atualiza tempo de processamento
    this.metrics.processingTime.min = Math.min(this.metrics.processingTime.min, processingTimeMs);
    this.metrics.processingTime.max = Math.max(this.metrics.processingTime.max, processingTimeMs);
    this.metrics.processingTime.total += processingTimeMs;
    this.metrics.processingTime.count++;
    this.metrics.processingTime.avg = this.metrics.processingTime.total / this.metrics.processingTime.count;

    // Atualiza tamanho médio do lote
    this.metrics.averageBatchSize = this.metrics.messagesProcessed / this.metrics.batchesProcessed;
  }

  /**
   * Registra erro
   */
  recordError() {
    this.metrics.errors++;
  }

  /**
   * Atualiza uso de memória
   */
  updateMemoryUsage() {
    const memUsage = process.memoryUsage();
    this.metrics.memoryUsage = {
      heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024), // MB
      heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024), // MB
      rss: Math.round(memUsage.rss / 1024 / 1024), // MB
      external: Math.round(memUsage.external / 1024 / 1024), // MB
    };
  }

  /**
   * Gera relatório de performance
   */
  generateReport(isFinal = false) {
    this.updateMemoryUsage();

    const uptime = Date.now() - this.metrics.startTime;
    const uptimeHours = (uptime / 1000 / 60 / 60).toFixed(2);

    const report = {
      instanceId: this.instanceId,
      uptime: uptime,
      uptimeHours: parseFloat(uptimeHours),
      performance: {
        messagesProcessed: this.metrics.messagesProcessed,
        batchesProcessed: this.metrics.batchesProcessed,
        averageBatchSize: Math.round(this.metrics.averageBatchSize * 100) / 100,
        messagesPerMinute: Math.round((this.metrics.messagesProcessed / (uptime / 1000 / 60)) * 100) / 100,
        batchesPerMinute: Math.round((this.metrics.batchesProcessed / (uptime / 1000 / 60)) * 100) / 100,
      },
      processingTime: {
        min: this.metrics.processingTime.min === Infinity ? 0 : this.metrics.processingTime.min,
        max: this.metrics.processingTime.max,
        avg: Math.round(this.metrics.processingTime.avg * 100) / 100,
      },
      memoryUsage: this.metrics.memoryUsage,
      errors: this.metrics.errors,
      errorRate: this.metrics.batchesProcessed > 0 ? Math.round((this.metrics.errors / this.metrics.batchesProcessed) * 10000) / 100 : 0,
    };

    const logLevel = isFinal ? 'info' : 'debug';
    logger[logLevel](`Relatório de Performance ${isFinal ? '(Final)' : ''}`, {
      label: 'PerformanceMonitor.generateReport',
      report,
      instanceId: this.instanceId,
    });

    return report;
  }

  /**
   * Retorna métricas atuais
   */
  getMetrics() {
    this.updateMemoryUsage();
    return { ...this.metrics };
  }

  /**
   * Reseta métricas
   */
  reset() {
    this.metrics = {
      messagesProcessed: 0,
      batchesProcessed: 0,
      averageBatchSize: 0,
      processingTime: {
        min: Infinity,
        max: 0,
        total: 0,
        count: 0,
        avg: 0,
      },
      memoryUsage: {
        heapUsed: 0,
        heapTotal: 0,
        rss: 0,
        external: 0,
      },
      errors: 0,
      startTime: Date.now(),
    };

    logger.info('Métricas de performance resetadas', {
      label: 'PerformanceMonitor.reset',
      instanceId: this.instanceId,
    });
  }
}

module.exports = PerformanceMonitor;
