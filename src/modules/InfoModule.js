const BaseModule = require('./BaseModule');
const logger = require('../utils/logs/logger');

/**
 * Módulo de informações do sistema
 * Fornece informações básicas sobre o sistema e projeto
 */
class InfoModule extends BaseModule {
  constructor() {
    super('InfoModule');
    this.description = 'Fornece informações básicas sobre o sistema';
    this.version = '1.0.0';
    this.author = 'Sistema Omnizap';
  }

  /**
   * Valida parâmetros do comando info
   * @param {object} params - Parâmetros do comando
   * @returns {boolean|string} true se válido, string com erro se inválido
   */
  validateParams(params) {
    // Info não requer parâmetros específicos
    return true;
  }

  /**
   * Executa o comando info
   * @param {object} params - Parâmetros do comando
   * @param {object} context - Contexto da execução
   * @returns {Promise<object>} Informações do sistema
   */
  async execute(params = {}, context = {}) {
    try {
      logger.info('[InfoModule] Coletando informações básicas do sistema', {
        label: 'InfoModule.execute',
        sender: context.sender,
      });

      const info = {
        system: {
          name: 'Omnizap',
          version: '2.0.0',
          description: 'Sistema de automação WhatsApp com processamento em lote',
          features: ['🚀 Processamento em lote otimizado', '📊 Monitoramento de performance', '🧩 Sistema modular de comandos', '💾 Cache em memória', '📈 Métricas em tempo real'],
        },
        modules: {
          total: this.getModuleCount(),
          available: ['status - Status completo do sistema', 'info - Informações básicas', 'ping - Redirecionado para status'],
        },
        capabilities: {
          batchProcessing: true,
          performanceMonitoring: true,
          modularCommands: true,
          memoryCache: true,
          realTimeMetrics: true,
        },
        support: {
          github: 'https://github.com/omnizap/omnizap',
          documentation: 'Consulte o README.md',
          issues: 'Reporte problemas no GitHub',
        },
      };

      return info;
    } catch (error) {
      logger.error(`[InfoModule] Erro ao coletar informações: ${error.message}`, {
        label: 'InfoModule.execute',
        error: error.stack,
      });

      throw error;
    }
  }

  /**
   * Obtém contagem de módulos disponíveis
   * @returns {number} Número de módulos
   */
  getModuleCount() {
    try {
      const ModuleManager = require('./ModuleManager');
      return ModuleManager.listModules().length;
    } catch (error) {
      return 0;
    }
  }
}

module.exports = InfoModule;
