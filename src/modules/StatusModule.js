const logger = require('../utils/logs/logger');
const path = require('path');
const fs = require('fs').promises;
const os = require('os');
const BaseModule = require('./BaseModule');

/**
 * Módulo responsável por coletar e fornecer informações completas sobre o status do projeto
 */
class StatusModule extends BaseModule {
  constructor() {
    super('StatusModule');
    this.description = 'Coleta informações completas sobre o status do projeto';
    this.version = '1.0.0';
    this.author = 'Sistema Omnizap';
    this.projectRoot = path.resolve(__dirname, '../..');
    this.startTime = Date.now();
  }

  /**
   * Implementação do método execute da BaseModule
   * @param {object} params - Parâmetros do comando
   * @param {object} context - Contexto da execução
   * @returns {Promise<object>} Dados completos do status
   */
  async execute(params = {}, context = {}) {
    return await this.getProjectStatus();
  }

  /**
   * Coleta todas as informações de status do projeto
   * @returns {Promise<object>} Dados completos do status
   */
  async getProjectStatus() {
    try {
      logger.info('[StatusModule] Coletando informações de status do projeto', {
        label: 'StatusModule.getProjectStatus',
      });

      const [systemInfo, projectInfo, performanceInfo, servicesInfo, configurationsInfo] = await Promise.all([this.getSystemInfo(), this.getProjectInfo(), this.getPerformanceInfo(), this.getServicesInfo(), this.getConfigurationsInfo()]);

      const statusData = {
        timestamp: new Date().toISOString(),
        uptime: this.getUptime(),
        system: systemInfo,
        project: projectInfo,
        performance: performanceInfo,
        services: servicesInfo,
        configurations: configurationsInfo,
        health: this.calculateHealthScore({
          system: systemInfo,
          performance: performanceInfo,
          services: servicesInfo,
        }),
      };

      logger.info('[StatusModule] Status coletado com sucesso', {
        label: 'StatusModule.getProjectStatus',
        dataSize: JSON.stringify(statusData).length,
      });

      return statusData;
    } catch (error) {
      logger.error(`[StatusModule] Erro ao coletar status: ${error.message}`, {
        label: 'StatusModule.getProjectStatus',
        error: error.stack,
      });

      return {
        timestamp: new Date().toISOString(),
        error: 'Erro ao coletar informações de status',
        details: error.message,
      };
    }
  }

  /**
   * Coleta informações do sistema
   */
  async getSystemInfo() {
    return {
      platform: os.platform(),
      arch: os.arch(),
      nodeVersion: process.version,
      cpus: os.cpus().length,
      totalMemory: this.formatBytes(os.totalmem()),
      freeMemory: this.formatBytes(os.freemem()),
      loadAverage: os.loadavg(),
      hostname: os.hostname(),
      uptime: this.formatUptime(os.uptime()),
    };
  }

  /**
   * Coleta informações do projeto
   */
  async getProjectInfo() {
    try {
      const packageJsonPath = path.join(this.projectRoot, 'package.json');
      const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));

      return {
        name: packageJson.name || 'omnizap',
        version: packageJson.version || '1.0.0',
        description: packageJson.description || 'Sistema Omnizap',
        author: packageJson.author || 'Equipe Omnizap',
        dependencies: Object.keys(packageJson.dependencies || {}),
        devDependencies: Object.keys(packageJson.devDependencies || {}),
        scripts: Object.keys(packageJson.scripts || {}),
        projectRoot: this.projectRoot,
        processId: process.pid,
        processUptime: this.formatUptime(process.uptime()),
      };
    } catch (error) {
      return {
        error: 'Erro ao ler package.json',
        details: error.message,
      };
    }
  }

  /**
   * Coleta informações de performance
   */
  async getPerformanceInfo() {
    const memUsage = process.memoryUsage();

    return {
      memory: {
        rss: this.formatBytes(memUsage.rss),
        heapTotal: this.formatBytes(memUsage.heapTotal),
        heapUsed: this.formatBytes(memUsage.heapUsed),
        external: this.formatBytes(memUsage.external),
        arrayBuffers: this.formatBytes(memUsage.arrayBuffers),
      },
      cpu: {
        usage: process.cpuUsage(),
        loadAverage: os.loadavg(),
      },
      eventLoop: {
        delay: await this.getEventLoopDelay(),
      },
    };
  }

  /**
   * Coleta informações dos serviços
   */
  async getServicesInfo() {
    try {
      // Tenta importar os serviços dinamicamente para verificar status
      const services = {};

      try {
        const BatchManager = require('../services/BatchManager');
        services.batchManager = {
          status: 'loaded',
          hasInstance: !!BatchManager,
        };
      } catch (e) {
        services.batchManager = { status: 'not_loaded', error: e.message };
      }

      try {
        const PerformanceMonitor = require('../services/PerformanceMonitor');
        services.performanceMonitor = {
          status: 'loaded',
          hasInstance: !!PerformanceMonitor,
        };
      } catch (e) {
        services.performanceMonitor = { status: 'not_loaded', error: e.message };
      }

      try {
        const MemoryCache = require('../services/MemoryCache');
        services.memoryCache = {
          status: 'loaded',
          hasInstance: !!MemoryCache,
        };
      } catch (e) {
        services.memoryCache = { status: 'not_loaded', error: e.message };
      }

      try {
        const DataManager = require('../services/DataManager');
        services.dataManager = {
          status: 'loaded',
          hasInstance: !!DataManager,
        };
      } catch (e) {
        services.dataManager = { status: 'not_loaded', error: e.message };
      }

      return services;
    } catch (error) {
      return {
        error: 'Erro ao verificar serviços',
        details: error.message,
      };
    }
  }

  /**
   * Coleta informações de configurações
   */
  async getConfigurationsInfo() {
    try {
      const configs = {};

      try {
        const batchConfig = require('../config/batchConfig');
        configs.batch = {
          status: 'loaded',
          config: batchConfig,
        };
      } catch (e) {
        configs.batch = { status: 'not_loaded', error: e.message };
      }

      return configs;
    } catch (error) {
      return {
        error: 'Erro ao verificar configurações',
        details: error.message,
      };
    }
  }

  /**
   * Calcula pontuação de saúde do sistema
   */
  calculateHealthScore(data) {
    let score = 100;
    const issues = [];

    // Verifica uso de memória
    const memUsage = process.memoryUsage();
    const heapUsagePercent = (memUsage.heapUsed / memUsage.heapTotal) * 100;

    if (heapUsagePercent > 90) {
      score -= 30;
      issues.push('Alto uso de memória heap');
    } else if (heapUsagePercent > 70) {
      score -= 15;
      issues.push('Uso moderado de memória heap');
    }

    // Verifica load average
    const loadAvg = os.loadavg()[0];
    const cpuCount = os.cpus().length;
    const loadPercentage = (loadAvg / cpuCount) * 100;

    if (loadPercentage > 80) {
      score -= 25;
      issues.push('Alta carga de CPU');
    } else if (loadPercentage > 60) {
      score -= 10;
      issues.push('Carga moderada de CPU');
    }

    // Verifica serviços
    const serviceErrors = Object.values(data.services || {}).filter((service) => service.status === 'not_loaded').length;

    if (serviceErrors > 0) {
      score -= serviceErrors * 10;
      issues.push(`${serviceErrors} serviço(s) com problema`);
    }

    return {
      score: Math.max(0, score),
      status: score >= 80 ? 'excellent' : score >= 60 ? 'good' : score >= 40 ? 'warning' : 'critical',
      issues,
    };
  }

  /**
   * Calcula tempo de atividade desde o início do módulo
   */
  getUptime() {
    const uptimeMs = Date.now() - this.startTime;
    return this.formatUptime(uptimeMs / 1000);
  }

  /**
   * Formata bytes em formato legível
   */
  formatBytes(bytes) {
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    if (bytes === 0) return '0 Bytes';
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return Math.round((bytes / Math.pow(1024, i)) * 100) / 100 + ' ' + sizes[i];
  }

  /**
   * Formata tempo em formato legível
   */
  formatUptime(seconds) {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    let result = '';
    if (days > 0) result += `${days}d `;
    if (hours > 0) result += `${hours}h `;
    if (minutes > 0) result += `${minutes}m `;
    result += `${secs}s`;

    return result.trim();
  }

  /**
   * Mede delay do event loop
   */
  async getEventLoopDelay() {
    return new Promise((resolve) => {
      const start = process.hrtime.bigint();
      setImmediate(() => {
        const delay = Number(process.hrtime.bigint() - start) / 1000000; // Convert to ms
        resolve(`${delay.toFixed(2)}ms`);
      });
    });
  }
}

module.exports = StatusModule;
