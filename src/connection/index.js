const connectionManager = require('./ConnectionManager'); // Import the module directly
const { getInstance: getMySQLDBManagerInstance } = require('./../database/MySQLDBManager');
const logger = require('./../utils/logs/logger');
const messageController = require('../controllers/MessageController');

/**
 * @async
 * @function start
 * @description
 * Ponto de entrada principal para iniciar a aplicação Omnizap.
 * Este script orquestra a inicialização dos componentes chave:
 * 1. Inicializa o `MySQLDBManager` para interação com o banco de dados.
 * 2. Inicializa o `ConnectionManager`, passando a instância do `mysqlDbManager`, para conectar ao WhatsApp.
 * @throws {Error} Se ocorrer qualquer falha crítica durante a inicialização (ex: falha ao conectar ao MySQL, erro fatal no ConnectionManager), a aplicação registrará o erro e terminará com `process.exit(1)`.
 */
async function start() {
  try {
    logger.info('Iniciando aplicação Omnizap...', { label: 'Application.start' });

    const mysqlDbManager = await getMySQLDBManagerInstance();
    logger.info('MySQLDBManager inicializado.', { label: 'Application.start' });

    // Initialize the connection using the exported function
    // The mysqlDbManager is no longer passed to ConnectionManager
    await connectionManager.initialize();

    const messageEmitter = connectionManager.getEventEmitter();
    const waClient = connectionManager.getClient(); // Get the Baileys client instance

    messageEmitter.on('message:upsert:received', (message) => {
      logger.info(`[Application] Nova mensagem (ID: ${message.key?.id}) encaminhada para MessageController.`, { label: 'Application.messageEmitter', messageId: message.key?.id, instanceId: message.instanceId });
      messageController
        .processIncomingMessage(message, waClient) // Pass the client instance
        .then((result) => {
          logger.debug(`[ Application.messageEmitter ] MessageController processou a mensagem ID: ${message.key?.id}. Resultado: ${result?.status || 'N/A'}`, { label: 'Application.messageEmitter', messageId: message.key?.id, controllerResult: result });
        })
        .catch((error) => {
          logger.error(`[ Application.messageEmitter ] Erro ao processar mensagem ID: ${message.key?.id} pelo MessageController: ${error.message}`, { label: 'Application.messageEmitter', messageId: message.key?.id, error: error.message, stack: error.stack });
        });
    });

    logger.info('Aplicação Omnizap iniciada e pronta.', { label: 'Application.start' });
  } catch (error) {
    logger.error('Falha ao iniciar a aplicação Omnizap:', { label: 'Application.start', message: error.message, stack: error.stack });
    process.exit(1);
  }
}

start();
