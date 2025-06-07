const logger = require('../utils/logs/logger');

/**
 * Classe base para módulos de comando
 * Todos os módulos de comando devem herdar desta classe
 */
class BaseModule {
  constructor(name) {
    this.name = name;
    this.createdAt = new Date();
    this.executionCount = 0;
    this.lastExecuted = null;
  }

  /**
   * Método principal que deve ser implementado por cada módulo
   * @param {object} params - Parâmetros do comando
   * @param {object} context - Contexto da execução (sender, chat, etc.)
   * @returns {Promise<object>} Resultado do comando
   */
  async execute(params = {}, context = {}) {
    throw new Error(`Método execute() deve ser implementado no módulo ${this.name}`);
  }

  /**
   * Validação de parâmetros (pode ser sobrescrita)
   * @param {object} params - Parâmetros a serem validados
   * @returns {boolean|string} true se válido, string com erro se inválido
   */
  validateParams(params) {
    return true;
  }

  /**
   * Executa o módulo com logging e controle de estatísticas
   * @param {object} params - Parâmetros do comando
   * @param {object} context - Contexto da execução
   * @returns {Promise<object>} Resultado da execução
   */
  async run(params = {}, context = {}) {
    const startTime = Date.now();

    try {
      logger.info(`[${this.name}] Iniciando execução do módulo`, {
        label: `${this.name}.run`,
        params: Object.keys(params),
        context: context.sender ? { sender: context.sender } : {},
      });

      // Validação de parâmetros
      const validation = this.validateParams(params);
      if (validation !== true) {
        throw new Error(`Parâmetros inválidos: ${validation}`);
      }

      // Execução do módulo
      const result = await this.execute(params, context);

      // Atualização de estatísticas
      this.executionCount++;
      this.lastExecuted = new Date();

      const executionTime = Date.now() - startTime;

      logger.info(`[${this.name}] Módulo executado com sucesso`, {
        label: `${this.name}.run`,
        executionTime: `${executionTime}ms`,
        executionCount: this.executionCount,
      });

      return {
        success: true,
        data: result,
        executionTime,
        module: this.name,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      const executionTime = Date.now() - startTime;

      logger.error(`[${this.name}] Erro na execução do módulo: ${error.message}`, {
        label: `${this.name}.run`,
        error: error.stack,
        executionTime: `${executionTime}ms`,
      });

      return {
        success: false,
        error: error.message,
        executionTime,
        module: this.name,
        timestamp: new Date().toISOString(),
      };
    }
  }

  /**
   * Retorna estatísticas do módulo
   */
  getStats() {
    return {
      name: this.name,
      createdAt: this.createdAt,
      executionCount: this.executionCount,
      lastExecuted: this.lastExecuted,
      uptime: this.lastExecuted ? Date.now() - this.createdAt.getTime() : 0,
    };
  }

  /**
   * Retorna informações sobre o módulo
   */
  getInfo() {
    return {
      name: this.name,
      description: this.description || 'Módulo de comando',
      version: this.version || '1.0.0',
      author: this.author || 'Sistema Omnizap',
      stats: this.getStats(),
    };
  }
}

module.exports = BaseModule;
