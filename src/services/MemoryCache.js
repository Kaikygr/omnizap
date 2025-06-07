const logger = require('../utils/logs/logger');

/**
 * Sistema de cache em memória para dados temporários
 * Substitui a necessidade de database para operações simples
 */
class MemoryCache {
  constructor(options = {}) {
    this.defaultTTL = options.defaultTTL || 300000; // 5 minutos
    this.maxSize = options.maxSize || 10000; // Máximo de 10k entries
    this.instanceId = options.instanceId || 'default';

    this.cache = new Map();
    this.timers = new Map();
    this.stats = {
      hits: 0,
      misses: 0,
      sets: 0,
      deletes: 0,
      evictions: 0,
    };
  }

  /**
   * Define um valor no cache
   */
  set(key, value, ttl = this.defaultTTL) {
    // Remove entrada existente se houver
    if (this.cache.has(key)) {
      this.delete(key);
    }

    // Verifica se precisa fazer eviction por tamanho
    if (this.cache.size >= this.maxSize) {
      this.evictOldest();
    }

    const entry = {
      value,
      timestamp: Date.now(),
      ttl,
      instanceId: this.instanceId,
    };

    this.cache.set(key, entry);
    this.stats.sets++;

    // Agenda remoção automática
    if (ttl > 0) {
      const timer = setTimeout(() => {
        this.delete(key);
      }, ttl);
      this.timers.set(key, timer);
    }

    logger.debug(`Cache set: ${key}`, {
      label: 'MemoryCache.set',
      key,
      ttl,
      cacheSize: this.cache.size,
      instanceId: this.instanceId,
    });

    return true;
  }

  /**
   * Obtém um valor do cache
   */
  get(key) {
    const entry = this.cache.get(key);

    if (!entry) {
      this.stats.misses++;
      logger.debug(`Cache miss: ${key}`, {
        label: 'MemoryCache.get',
        key,
        instanceId: this.instanceId,
      });
      return null;
    }

    // Verifica se expirou
    const now = Date.now();
    if (entry.ttl > 0 && now - entry.timestamp > entry.ttl) {
      this.delete(key);
      this.stats.misses++;
      logger.debug(`Cache expired: ${key}`, {
        label: 'MemoryCache.get',
        key,
        instanceId: this.instanceId,
      });
      return null;
    }

    this.stats.hits++;
    logger.debug(`Cache hit: ${key}`, {
      label: 'MemoryCache.get',
      key,
      instanceId: this.instanceId,
    });

    return entry.value;
  }

  /**
   * Verifica se uma chave existe no cache
   */
  has(key) {
    const entry = this.cache.get(key);
    if (!entry) return false;

    // Verifica se expirou
    const now = Date.now();
    if (entry.ttl > 0 && now - entry.timestamp > entry.ttl) {
      this.delete(key);
      return false;
    }

    return true;
  }

  /**
   * Remove uma entrada do cache
   */
  delete(key) {
    const existed = this.cache.delete(key);

    if (this.timers.has(key)) {
      clearTimeout(this.timers.get(key));
      this.timers.delete(key);
    }

    if (existed) {
      this.stats.deletes++;
      logger.debug(`Cache delete: ${key}`, {
        label: 'MemoryCache.delete',
        key,
        instanceId: this.instanceId,
      });
    }

    return existed;
  }

  /**
   * Remove a entrada mais antiga para fazer espaço
   */
  evictOldest() {
    if (this.cache.size === 0) return;

    let oldestKey = null;
    let oldestTimestamp = Date.now();

    for (const [key, entry] of this.cache.entries()) {
      if (entry.timestamp < oldestTimestamp) {
        oldestTimestamp = entry.timestamp;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.delete(oldestKey);
      this.stats.evictions++;
      logger.debug(`Cache eviction: ${oldestKey}`, {
        label: 'MemoryCache.evictOldest',
        key: oldestKey,
        instanceId: this.instanceId,
      });
    }
  }

  /**
   * Limpa entradas expiradas
   */
  cleanup() {
    const now = Date.now();
    const keysToDelete = [];

    for (const [key, entry] of this.cache.entries()) {
      if (entry.ttl > 0 && now - entry.timestamp > entry.ttl) {
        keysToDelete.push(key);
      }
    }

    keysToDelete.forEach((key) => this.delete(key));

    if (keysToDelete.length > 0) {
      logger.debug(`Cache cleanup: ${keysToDelete.length} entries removed`, {
        label: 'MemoryCache.cleanup',
        removedCount: keysToDelete.length,
        instanceId: this.instanceId,
      });
    }

    return keysToDelete.length;
  }

  /**
   * Obtém ou define um valor (cache-aside pattern)
   */
  async getOrSet(key, valueFactory, ttl = this.defaultTTL) {
    let value = this.get(key);

    if (value === null) {
      // Cache miss, obtém o valor
      try {
        if (typeof valueFactory === 'function') {
          value = await valueFactory();
        } else {
          value = valueFactory;
        }

        this.set(key, value, ttl);

        logger.debug(`Cache getOrSet - computed value: ${key}`, {
          label: 'MemoryCache.getOrSet',
          key,
          instanceId: this.instanceId,
        });
      } catch (error) {
        logger.error(`Erro ao computar valor para cache key ${key}: ${error.message}`, {
          label: 'MemoryCache.getOrSet',
          key,
          error: error.message,
          instanceId: this.instanceId,
        });
        throw error;
      }
    }

    return value;
  }

  /**
   * Retorna estatísticas do cache
   */
  getStats() {
    const hitRate = this.stats.hits + this.stats.misses > 0 ? ((this.stats.hits / (this.stats.hits + this.stats.misses)) * 100).toFixed(2) : 0;

    return {
      ...this.stats,
      size: this.cache.size,
      hitRate: `${hitRate}%`,
      maxSize: this.maxSize,
      instanceId: this.instanceId,
    };
  }

  /**
   * Lista todas as chaves no cache
   */
  keys() {
    return Array.from(this.cache.keys());
  }

  /**
   * Limpa todo o cache
   */
  clear() {
    // Limpa todos os timers
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }

    this.cache.clear();
    this.timers.clear();

    logger.info('Cache limpo completamente', {
      label: 'MemoryCache.clear',
      instanceId: this.instanceId,
    });
  }

  /**
   * Agenda limpeza automática
   */
  startAutoCleanup(interval = 60000) {
    // 1 minuto
    setInterval(() => {
      this.cleanup();
    }, interval);

    logger.info(`Auto cleanup iniciado com intervalo de ${interval}ms`, {
      label: 'MemoryCache.startAutoCleanup',
      interval,
      instanceId: this.instanceId,
    });
  }

  /**
   * Destrói o cache e limpa recursos
   */
  destroy() {
    this.clear();

    logger.info('MemoryCache destruído', {
      label: 'MemoryCache.destroy',
      finalStats: this.getStats(),
      instanceId: this.instanceId,
    });
  }
}

module.exports = MemoryCache;
