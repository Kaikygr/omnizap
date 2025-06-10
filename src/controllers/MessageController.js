const logger = require('../utils/logs/logger');

require('dotenv').config();

const COMMAND_PREFIX = process.env.COMMAND_PREFIX || '/';

const TEXT_EXTRACTION_PATHS = ['conversation', 'viewOnceMessageV2.message.imageMessage.caption', 'viewOnceMessageV2.message.videoMessage.caption', 'imageMessage.caption', 'videoMessage.caption', 'extendedTextMessage.text', 'viewOnceMessage.message.videoMessage.caption', 'viewOnceMessage.message.imageMessage.caption', 'documentWithCaptionMessage.message.documentMessage.caption', 'buttonsMessage.imageMessage.caption', 'buttonsResponseMessage.selectedButtonId', 'listResponseMessage.singleSelectReply.selectedRowId', 'templateButtonReplyMessage.selectedId', 'editedMessage.message.protocolMessage.editedMessage.extendedTextMessage.text', 'editedMessage.message.protocolMessage.editedMessage.imageMessage.caption', 'interactiveResponseMessage.nativeFlowResponseMessage.paramsJson', 'documentMessage.caption'];

function _extractTextFromMessageObject(msgObj) {
  if (!msgObj || typeof msgObj !== 'object') {
    return '';
  }

  for (const path of TEXT_EXTRACTION_PATHS) {
    const keys = path.split('.');
    let current = msgObj;
    let pathIsValid = true;

    for (const key of keys) {
      if (current && typeof current === 'object' && Object.prototype.hasOwnProperty.call(current, key) && current[key] !== null && current[key] !== undefined) {
        current = current[key];
      } else {
        pathIsValid = false;
        break;
      }
    }

    if (pathIsValid) {
      let textToReturn = '';
      if (path === 'interactiveResponseMessage.nativeFlowResponseMessage.paramsJson') {
        if (typeof current === 'string' && current.length > 0) {
          try {
            const parsedJson = JSON.parse(current);
            if (parsedJson && typeof parsedJson.id === 'string') {
              textToReturn = parsedJson.id;
            } else if (parsedJson && typeof parsedJson.id === 'number') {
              textToReturn = String(parsedJson.id);
            }
          } catch (e) {
            logger.warn(`[MessageController._extractTextFromMessageObject] Erro ao parsear paramsJson: ${e.message}`, { label: 'MessageController._extractTextFromMessageObject', path, value: typeof current });
          }
        }
      } else if (typeof current === 'string') {
        textToReturn = current;
      } else if (typeof current === 'number') {
        textToReturn = String(current);
      }

      if (textToReturn.trim() !== '') {
        return textToReturn.trim();
      }
    }
  }
  return '';
}

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
        originalMessage: message, // Adicionar a mensagem original aqui
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

  let commandInputText = _extractTextFromMessageObject(mainMessagePart);

  if (!commandInputText && typeof message.text === 'string' && message.text.trim() !== '') {
    commandInputText = message.text.trim();
    logger.debug('[MessageController.processMessageCore] Texto extraído de message.text (nível raiz)', { label: 'MessageController.processMessageCore' });
  }

  if (!commandInputText) {
    const quotedMessagePart = mainMessagePart?.extendedTextMessage?.contextInfo?.quotedMessage;
    if (quotedMessagePart) {
      commandInputText = _extractTextFromMessageObject(quotedMessagePart);
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
      case 'ola':
        try {
          await baileysClient.sendMessage(
            item.from,
            {
              text: 'Olá',
            },
            { quoted: item.originalMessage },
          ); // Modificado para usar a mensagem original
          logger.info(`[MessageController] Comando '${COMMAND_PREFIX}ola' respondido com "Olá" para ${item.from}`, {
            label: 'MessageController.executeBatchCommands.ola',
            messageId: item.messageId,
            from: item.from,
          });
        } catch (error) {
          logger.error(`[MessageController] Erro ao enviar resposta "Olá" para ${item.from}: ${error.message}`, {
            label: 'MessageController.executeBatchCommands.ola',
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
