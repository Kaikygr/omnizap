const ConnectionManager = require('./ConnectionManager');
const { getInstance: getMySQLDBManagerInstance } = require('./../database/MySQLDBManager');
const logger = require('./../utils/logs/logger');
const messageController = require('../controllers/MessageController'); // Importar o controller

/**
 * @async
 * @function start
 * @description
 * Ponto de entrada principal para iniciar a aplicação Omnizap.
 * Este script orquestra a inicialização dos componentes chave:
 * 1. Inicializa o `MySQLDBManager` para interação com o banco de dados.
 * 2. Inicializa o `ConnectionManager`, passando a instância do `mysqlDbManager`, para conectar ao WhatsApp.
 * 3. Realiza uma sincronização inicial de dados do Redis para o MySQL, se o `redisClient` no `ConnectionManager`
 *    estiver disponível e conectado.
 * @throws {Error} Se ocorrer qualquer falha crítica durante a inicialização (ex: falha ao conectar ao MySQL, erro fatal no ConnectionManager), a aplicação registrará o erro e terminará com `process.exit(1)`.
 */
async function start() {
  try {
    logger.info('Iniciando aplicação Omnizap...', { label: 'Application' });

    const mysqlDbManager = await getMySQLDBManagerInstance();
    logger.info('MySQLDBManager inicializado.', { label: 'Application' });

    const connectionManager = new ConnectionManager(mysqlDbManager);
    await connectionManager.initialize();

    if (connectionManager.redisClient) {
      logger.info('Iniciando sincronização inicial de dados do Redis para o MySQL...', { label: 'Application' });
      await mysqlDbManager.syncFromRedis(connectionManager.redisClient);
    } else {
      logger.warn('Cliente Redis não disponível no ConnectionManager, pulando sincronização inicial do Redis para MySQL.', { label: 'Application' });
    }

    const messageEmitter = connectionManager.getEventEmitter();
    messageEmitter.on('message:upsert:received', (message) => {
      logger.info(`[Application] Nova mensagem (ID: ${message.key?.id}) encaminhada para MessageController.`, { label: 'Application', messageId: message.key?.id, instanceId: message.instanceId });
      messageController
        .processIncomingMessage(message, connectionManager.client)
        .then((result) => {
          logger.debug(`[Application] MessageController processou a mensagem ID: ${message.key?.id}. Resultado: ${result?.status || 'N/A'}`, { label: 'Application', messageId: message.key?.id, controllerResult: result });
        })
        .catch((error) => {
          logger.error(`[Application] Erro ao processar mensagem ID: ${message.key?.id} pelo MessageController: ${error.message}`, { label: 'Application', messageId: message.key?.id, error: error.message, stack: error.stack });
        });
    });

    logger.info('Aplicação Omnizap iniciada e pronta.', { label: 'Application' });
  } catch (error) {
    logger.error('Falha ao iniciar a aplicação Omnizap:', { label: 'Application', message: error.message, stack: error.stack });
    process.exit(1);
  }
}

start();
