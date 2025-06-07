/**
 * Configurações otimizadas para processamento em lote
 * Valores ajustados para máxima eficiência sem usar database
 */

const batchConfig = {
  // Configurações do BatchManager principal
  batchManager: {
    batchSize: 30, // Tamanho do lote para processamento
    flushInterval: 3000, // Intervalo em ms para flush automático
    maxRetries: 3, // Máximo de tentativas em caso de erro
    retryDelay: 1000, // Delay entre tentativas (ms)
  },

  // Configurações do DataManager
  dataManager: {
    batchSize: 50, // Tamanho do lote para operações de dados
    flushInterval: 5000, // Intervalo em ms para flush automático
    cacheTTL: 300000, // TTL do cache (5 minutos)
    cacheMaxSize: 10000, // Máximo de entradas no cache
    cleanupInterval: 60000, // Intervalo de limpeza do cache (1 minuto)
  },

  // Configurações do MessageController
  messageController: {
    batchSize: 10, // Tamanho do lote para processamento de mensagens
    commandTimeout: 30000, // Timeout para execução de comandos (30s)
    maxConcurrentCommands: 5, // Máximo de comandos simultâneos
  },

  // Configurações de performance
  performance: {
    enableBatchProcessing: true, // Habilita processamento em lote
    enableCaching: true, // Habilita cache em memória
    enableCompression: false, // Desabilitado para evitar overhead
    enableMetrics: true, // Habilita coleta de métricas
    gcInterval: 300000, // Intervalo de garbage collection (5 min)
  },

  // Tipos de dados para processamento
  dataTypes: {
    messages: {
      priority: 1, // Alta prioridade
      batchSize: 30,
      flushInterval: 2000,
    },
    chats: {
      priority: 2, // Média prioridade
      batchSize: 50,
      flushInterval: 5000,
    },
    groups: {
      priority: 3, // Baixa prioridade
      batchSize: 100,
      flushInterval: 10000,
    },
    contacts: {
      priority: 3, // Baixa prioridade
      batchSize: 100,
      flushInterval: 10000,
    },
    receipts: {
      priority: 2, // Média prioridade
      batchSize: 50,
      flushInterval: 5000,
    },
    reactions: {
      priority: 2, // Média prioridade
      batchSize: 50,
      flushInterval: 5000,
    },
  },
};

module.exports = batchConfig;
