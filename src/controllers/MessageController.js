const logger = require('../utils/logs/logger');
const { extractTextFromMessageObject } = require('../services/MessageExtractor');

require('dotenv').config();

const COMMAND_PREFIX = process.env.COMMAND_PREFIX || '/';

async function processBatchMessages(messages, baileysClient) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return {
      processed: false,
      count: 0,
      status: 'Nenhuma mensagem para processar',
    };
  }

  logger.info(`[MessageController] Processando lote de ${messages.length} mensagens (prefixo: '${COMMAND_PREFIX}')`, {
    label: 'MessageController.processBatchMessages.processBatchMessages',
    count: messages.length,
    prefix: COMMAND_PREFIX,
  });

  const commandQueue = [];

  for (const message of messages) {
    const result = await processMessageCore(message);
    if (result.isCommand && !result.isFromMe && baileysClient) {
      commandQueue.push({
        command: result.command,
        from: result.from,
        messageId: result.messageId,
        originalMessage: message,
      });
    }
  }

  if (commandQueue.length > 0) {
    await executeBatchCommands(commandQueue, baileysClient);
  }

  logger.info(`[MessageController] Lote de ${messages.length} mensagens processado com ${commandQueue.length} comandos 'ola'`, {
    label: 'MessageController.processBatchMessages',
    messagesProcessed: messages.length,
    commandsExecuted: commandQueue.length,
  });

  return {
    processed: true,
    count: messages.length,
    commandsExecuted: commandQueue.length,
    status: 'Lote processado com sucesso',
  };
}

/**
 * Processa o núcleo de uma mensagem individual
 * @param {object} message Mensagem a ser processada
 * @returns {object} Resultado do processamento
 */
async function processMessageCore(message) {
  const from = message.key?.remoteJid;
  const messageId = message.key?.id;
  const isFromMe = message.key?.fromMe || false;
  const mainMessagePart = message.message;

  let commandInputText = extractTextFromMessageObject(mainMessagePart);

  if (!commandInputText && typeof message.text === 'string' && message.text.trim() !== '') {
    commandInputText = message.text.trim();
    logger.debug('[MessageController.processMessageCore] Texto extraído de message.text (nível raiz)', { label: 'MessageController.processMessageCore' });
  }

  if (!commandInputText) {
    const quotedMessagePart = mainMessagePart?.extendedTextMessage?.contextInfo?.quotedMessage;
    if (quotedMessagePart) {
      commandInputText = extractTextFromMessageObject(quotedMessagePart);
    }
  }

  const fullCommand = commandInputText.trim();
  let command = '';
  let isValidCommand = false;

  if (fullCommand.startsWith(COMMAND_PREFIX)) {
    const potentialCommand = fullCommand.substring(COMMAND_PREFIX.length).toLowerCase();
    if (potentialCommand.length > 0) {
      command = potentialCommand;
      isValidCommand = !isFromMe;
      logger.debug(`[MessageController] Comando potencial detectado: '${COMMAND_PREFIX}${command}'`, {
        label: 'MessageController.processMessageCore',
        fullCommand,
        command,
        prefix: COMMAND_PREFIX,
        from,
      });
    } else {
      logger.debug(`[MessageController] Prefixo detectado sem comando: '${fullCommand}'`, {
        label: 'MessageController.processMessageCore',
        fullCommand,
        prefix: COMMAND_PREFIX,
        from,
      });
    }
  } else if (fullCommand) {
    logger.debug(`[MessageController] Texto não é comando (sem prefixo '${COMMAND_PREFIX}'): '${fullCommand}'`, {
      label: 'MessageController.processMessageCore',
      fullCommand,
      prefix: COMMAND_PREFIX,
      from,
    });
  }

  return {
    messageId,
    from,
    isFromMe,
    command,
    fullCommand,
    isCommand: isValidCommand,
    hasPrefix: fullCommand.startsWith(COMMAND_PREFIX),
    prefix: COMMAND_PREFIX,
  };
}

async function executeBatchCommands(commandQueue, baileysClient) {
  for (const item of commandQueue) {
    switch (item.command) {
      case 'ping':
        try {
          await baileysClient.sendMessage(
            item.from,
            {
              text: 'a',
            },
            { quoted: item.originalMessage },
          );
          logger.info(`[MessageController] Comando '${COMMAND_PREFIX}ping' respondido com "Pong!" para ${item.from}`, {
            label: 'MessageController.executeBatchCommands.ping',
            messageId: item.messageId,
            from: item.from,
          });
        } catch (error) {
          logger.error(`[MessageController] Erro ao enviar resposta "Pong!" para ${item.from}: ${error.message}`, {
            label: 'MessageController.executeBatchCommands.ping',
            messageId: item.messageId,
            from: item.from,
            error: error.stack,
          });
        }
        break;

      default:
        logger.warn(`[MessageController] Comando desconhecido ou não manipulado na fila: '${item.command}' de ${item.from}`, {
          label: 'MessageController.executeBatchCommands',
          command: item.command,
          from: item.from,
          messageId: item.messageId,
        });
        break;
    }
  }
}

async function processIncomingMessage(message, baileysClient) {
  logger.info(`[MessageController] Processando mensagem individual ID: ${message.key?.id} de ${message.key?.remoteJid}`, {
    label: 'MessageController.processIncomingMessage',
    messageId: message.key?.id,
    remoteJid: message.key?.remoteJid,
    instanceId: message.instanceId,
  });

  const result = await processBatchMessages([message], baileysClient);

  logger.info(`[MessageController] Mensagem ID: ${message.key?.id} processada via lote. Comandos 'ola' executados: ${result.commandsExecuted}`, {
    label: 'MessageController.processIncomingMessage',
    messageId: message.key?.id,
    instanceId: message.instanceId,
    batchResultStatus: result.status,
    commandsExecuted: result.commandsExecuted,
  });

  return {
    processed: true,
    messageId: message.key?.id,
    status: 'Mensagem processada com sucesso pelo controller.',
    batchResult: {
      count: result.count,
      commandsExecuted: result.commandsExecuted,
      status: result.status,
    },
  };
}

module.exports = {
  processIncomingMessage,
  processBatchMessages,
};
