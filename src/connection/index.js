const connectionManager = require('./ConnectionManager');
const logger = require('./../utils/logs/logger');
const messageController = require('../controllers/MessageController');

// Buffer para acumular mensagens para processamento em lote
let batchBuffer = [];
let batchTimer = null;
const BATCH_SIZE = 10;
const BATCH_TIMEOUT = 2000; // 2 segundos

async function start() {
  try {
    logger.info('Iniciando aplicação Omnizap...', { label: 'Application.start' });

    await connectionManager.initialize();

    const messageEmitter = connectionManager.getEventEmitter();
    const waClient = connectionManager.getClient();

    // Processamento individual para compatibilidade
    messageEmitter.on('message:upsert:received', (message) => {
      logger.info(`[Application] Nova mensagem (ID: ${message.key?.id}) encaminhada para MessageController.`, {
        label: 'Application.messageEmitter',
        messageId: message.key?.id,
        instanceId: message.instanceId,
      });

      messageController
        .processIncomingMessage(message, waClient)
        .then((result) => {
          logger.debug(`[Application.messageEmitter] MessageController processou a mensagem ID: ${message.key?.id}. Resultado: ${result?.status || 'N/A'}`, {
            label: 'Application.messageEmitter',
            messageId: message.key?.id,
            controllerResult: result,
          });
        })
        .catch((error) => {
          logger.error(`[Application.messageEmitter] Erro ao processar mensagem ID: ${message.key?.id} pelo MessageController: ${error.message}`, {
            label: 'Application.messageEmitter',
            messageId: message.key?.id,
            error: error.message,
            stack: error.stack,
          });
        });
    });

    // Processamento em lote otimizado
    messageEmitter.on('messages:batch:received', async (batchData) => {
      logger.info(`[Application] Lote de ${batchData.count} mensagens recebido para processamento`, {
        label: 'Application.batchProcessor',
        count: batchData.count,
        instanceId: batchData.instanceId,
      });

      try {
        const result = await messageController.processBatchMessages(batchData.messages, waClient);
        logger.info(`[Application] Lote processado com sucesso: ${result.count} mensagens, ${result.commandsExecuted || 0} comandos`, {
          label: 'Application.batchProcessor',
          messagesProcessed: result.count,
          commandsExecuted: result.commandsExecuted || 0,
          instanceId: batchData.instanceId,
        });
      } catch (error) {
        logger.error(`[Application] Erro ao processar lote de mensagens: ${error.message}`, {
          label: 'Application.batchProcessor',
          error: error.message,
          stack: error.stack,
          batchCount: batchData.count,
          instanceId: batchData.instanceId,
        });
      }
    });

    // Outros eventos em lote
    messageEmitter.on('chats:batch:upserted', (batchData) => {
      logger.info(`[Application] Lote de ${batchData.count} chats processados`, {
        label: 'Application.chatsBatch',
        count: batchData.count,
        instanceId: batchData.instanceId,
      });
    });

    messageEmitter.on('groups:batch:upserted', (batchData) => {
      logger.info(`[Application] Lote de ${batchData.count} grupos processados`, {
        label: 'Application.groupsBatch',
        count: batchData.count,
        instanceId: batchData.instanceId,
      });
    });

    logger.info('Aplicação Omnizap iniciada e pronta.', { label: 'Application.start' });
  } catch (error) {
    logger.error('Falha ao iniciar a aplicação Omnizap:', { label: 'Application.start', message: error.message, stack: error.stack });
    process.exit(1);
  }
}

start();
