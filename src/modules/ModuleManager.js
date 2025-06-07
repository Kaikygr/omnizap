const logger = require('../utils/logs/logger');
const path = require('path');
const fs = require('fs').promises;

/**
 * Gerenciador de módulos de comando
 * Responsável por carregar, registrar e executar módulos de comando
 */
class ModuleManager {
  constructor() {
    this.modules = new Map();
    this.modulesPath = path.join(__dirname);
    this.initialized = false;
  }

  /**
   * Inicializa o gerenciador de módulos
   */
  async initialize() {
    if (this.initialized) {
      return;
    }

    try {
      logger.info('[ModuleManager] Inicializando gerenciador de módulos', {
        label: 'ModuleManager.initialize',
      });

      await this.loadModules();
      this.initialized = true;

      logger.info('[ModuleManager] Gerenciador de módulos inicializado', {
        label: 'ModuleManager.initialize',
        modulesLoaded: this.modules.size,
      });
    } catch (error) {
      logger.error(`[ModuleManager] Erro ao inicializar: ${error.message}`, {
        label: 'ModuleManager.initialize',
        error: error.stack,
      });
      throw error;
    }
  }

  /**
   * Carrega todos os módulos disponíveis
   */
  async loadModules() {
    try {
      // Registra módulos built-in
      await this.registerBuiltInModules();

      // Carrega módulos customizados se existirem
      await this.loadCustomModules();
    } catch (error) {
      logger.error(`[ModuleManager] Erro ao carregar módulos: ${error.message}`, {
        label: 'ModuleManager.loadModules',
        error: error.stack,
      });
    }
  }

  /**
   * Registra módulos built-in do sistema
   */
  async registerBuiltInModules() {
    try {
      // Módulo de Status
      const StatusModule = require('./StatusModule');
      this.registerModule('status', new StatusModule());

      logger.info('[ModuleManager] Módulos built-in registrados', {
        label: 'ModuleManager.registerBuiltInModules',
        modules: ['status'],
      });
    } catch (error) {
      logger.error(`[ModuleManager] Erro ao registrar módulos built-in: ${error.message}`, {
        label: 'ModuleManager.registerBuiltInModules',
        error: error.stack,
      });
    }
  }

  /**
   * Carrega módulos customizados do diretório
   */
  async loadCustomModules() {
    try {
      const files = await fs.readdir(this.modulesPath);
      const moduleFiles = files.filter((file) => file.endsWith('.js') && !file.startsWith('Base') && !file.startsWith('ModuleManager') && !file.startsWith('StatusModule'));

      for (const file of moduleFiles) {
        try {
          const modulePath = path.join(this.modulesPath, file);
          const ModuleClass = require(modulePath);
          const moduleName = path.basename(file, '.js').toLowerCase();

          if (typeof ModuleClass === 'function') {
            const moduleInstance = new ModuleClass();
            this.registerModule(moduleName, moduleInstance);

            logger.info(`[ModuleManager] Módulo customizado carregado: ${moduleName}`, {
              label: 'ModuleManager.loadCustomModules',
              module: moduleName,
              file,
            });
          }
        } catch (moduleError) {
          logger.warn(`[ModuleManager] Erro ao carregar módulo ${file}: ${moduleError.message}`, {
            label: 'ModuleManager.loadCustomModules',
            file,
            error: moduleError.message,
          });
        }
      }
    } catch (error) {
      logger.error(`[ModuleManager] Erro ao carregar módulos customizados: ${error.message}`, {
        label: 'ModuleManager.loadCustomModules',
        error: error.stack,
      });
    }
  }

  /**
   * Registra um módulo
   * @param {string} name - Nome do módulo
   * @param {object} moduleInstance - Instância do módulo
   */
  registerModule(name, moduleInstance) {
    try {
      this.modules.set(name.toLowerCase(), moduleInstance);

      logger.info(`[ModuleManager] Módulo registrado: ${name}`, {
        label: 'ModuleManager.registerModule',
        module: name,
        type: moduleInstance.constructor.name,
      });
    } catch (error) {
      logger.error(`[ModuleManager] Erro ao registrar módulo ${name}: ${error.message}`, {
        label: 'ModuleManager.registerModule',
        module: name,
        error: error.stack,
      });
    }
  }

  /**
   * Executa um módulo específico
   * @param {string} moduleName - Nome do módulo
   * @param {object} params - Parâmetros para o módulo
   * @param {object} context - Contexto da execução
   * @returns {Promise<object>} Resultado da execução
   */
  async executeModule(moduleName, params = {}, context = {}) {
    const normalizedName = moduleName.toLowerCase();

    if (!this.modules.has(normalizedName)) {
      return {
        success: false,
        error: `Módulo '${moduleName}' não encontrado`,
        availableModules: Array.from(this.modules.keys()),
        timestamp: new Date().toISOString(),
      };
    }

    try {
      const module = this.modules.get(normalizedName);

      // Executa o módulo usando o método run() da BaseModule
      if (typeof module.run === 'function') {
        return await module.run(params, context);
      } else {
        // Fallback para módulos que não herdam de BaseModule
        const result = await module.execute(params, context);
        return {
          success: true,
          data: result,
          module: moduleName,
          timestamp: new Date().toISOString(),
        };
      }
    } catch (error) {
      logger.error(`[ModuleManager] Erro ao executar módulo ${moduleName}: ${error.message}`, {
        label: 'ModuleManager.executeModule',
        module: moduleName,
        error: error.stack,
      });

      return {
        success: false,
        error: error.message,
        module: moduleName,
        timestamp: new Date().toISOString(),
      };
    }
  }

  /**
   * Verifica se um módulo existe
   * @param {string} moduleName - Nome do módulo
   * @returns {boolean}
   */
  hasModule(moduleName) {
    return this.modules.has(moduleName.toLowerCase());
  }

  /**
   * Lista todos os módulos disponíveis
   * @returns {Array} Lista de módulos
   */
  listModules() {
    return Array.from(this.modules.entries()).map(([name, module]) => ({
      name,
      info:
        typeof module.getInfo === 'function'
          ? module.getInfo()
          : {
              name,
              description: 'Módulo customizado',
              stats: typeof module.getStats === 'function' ? module.getStats() : {},
            },
    }));
  }

  /**
   * Obtém estatísticas de todos os módulos
   */
  getModuleStats() {
    const stats = {};

    for (const [name, module] of this.modules.entries()) {
      if (typeof module.getStats === 'function') {
        stats[name] = module.getStats();
      } else {
        stats[name] = {
          name,
          executionCount: 0,
          lastExecuted: null,
        };
      }
    }

    return {
      totalModules: this.modules.size,
      modules: stats,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Recarrega todos os módulos
   */
  async reloadModules() {
    logger.info('[ModuleManager] Recarregando módulos', {
      label: 'ModuleManager.reloadModules',
    });

    // Limpa cache de módulos
    for (const [name] of this.modules.entries()) {
      const modulePath = path.join(this.modulesPath, `${name}.js`);
      if (require.cache[require.resolve(modulePath)]) {
        delete require.cache[require.resolve(modulePath)];
      }
    }

    // Limpa módulos registrados
    this.modules.clear();
    this.initialized = false;

    // Recarrega
    await this.initialize();
  }
}

// Exporta instância singleton
module.exports = new ModuleManager();
