const ConnectionManager = require('./ConnectionManager');
const { getInstance: getMySQLDBManagerInstance } = require('./../database/MySQLDBManager');
const logger = require('./../utils/logs/logger');

async function start() {
  try {
    logger.info('Iniciando aplicação Omnizap...', { label: 'Application' });

    // 1. Inicializa o MySQLDBManager primeiro
    const mysqlDbManager = await getMySQLDBManagerInstance();
    logger.info('MySQLDBManager inicializado.', { label: 'Application' });

    // 2. Inicializa o ConnectionManager, passando a instância do mysqlDbManager
    const connectionManager = new ConnectionManager(mysqlDbManager);
    await connectionManager.initialize();

    // 3. Realiza a sincronização inicial do Redis para o MySQL (opcional, mas recomendado)
    if (connectionManager.redisClient) {
      logger.info('Iniciando sincronização inicial de dados do Redis para o MySQL...', { label: 'Application' });
      await mysqlDbManager.syncFromRedis(connectionManager.redisClient);
    } else {
      logger.warn('Cliente Redis não disponível no ConnectionManager, pulando sincronização inicial do Redis para MySQL.', { label: 'Application' });
    }

    logger.info('Aplicação Omnizap iniciada e pronta.', { label: 'Application' });
  } catch (error) {
    logger.error('Falha ao iniciar a aplicação Omnizap:', { label: 'Application', message: error.message, stack: error.stack });
    process.exit(1);
  }
}

start();
