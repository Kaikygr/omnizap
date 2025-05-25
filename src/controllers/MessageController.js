const logger = require('../utils/logs/logger');

/**
 * Extrai texto de um objeto de mensagem usando uma lista priorizada de caminhos.
 * @param {object | null | undefined} msgObj O objeto (ou parte do objeto) da mensagem para pesquisar.
 * @param {string[]} paths Um array de strings representando os caminhos para o texto (ex: 'conversation', 'extendedTextMessage.text').
 * @returns {string} O texto encontrado e trimado, ou uma string vazia se nada for encontrado.
 */
function _extractTextFromMessageObject(msgObj, paths) {
  if (!msgObj || typeof msgObj !== 'object') {
    return '';
  }
  for (const path of paths) {
    const keys = path.split('.');
    let current = msgObj;
    let pathIsValid = true;

    for (const key of keys) {
      if (current && typeof current === 'object' && Object.prototype.hasOwnProperty.call(current, key)) {
        current = current[key];
      } else {
        pathIsValid = false;
        break;
      }
    }
    if (pathIsValid && typeof current === 'string') {
      const trimmedText = current.trim();
      if (trimmedText !== '') {
        return trimmedText;
      }
    }
  }
  return ''; // No text found for any path
}

/**
 * Processa uma mensagem recebida do WhatsApp.
 *
 * @param {object} message - O objeto da mensagem, conforme preparado pelo ConnectionManager.
 *                           Espera-se que contenha propriedades como:
 *                           - key: { remoteJid, fromMe, id, participant }
 *                           - messageTimestamp: timestamp da mensagem
 *                           - pushName: nome do remetente
 *                           - message: { conversation, extendedTextMessage: { text }, ... }
 *                           - instanceId: ID da instância que recebeu a mensagem
 *                           - ... (outras propriedades relevantes)
 * @param {import('baileys').WASocket | null} baileysClient - A instância do cliente Baileys para interagir com o WhatsApp (ex: enviar mensagens).
 */
async function processIncomingMessage(message, baileysClient) {
  logger.info(`[MessageController] Processando mensagem ID: ${message.key?.id} de ${message.key?.remoteJid}`, {
    label: 'MessageController',
    messageId: message.key?.id,
    remoteJid: message.key?.remoteJid,
    instanceId: message.instanceId,
  });

  const from = message.key?.remoteJid;
  const messageId = message.key?.id;
  const instanceId = message.instanceId;
  const isFromMe = message.key?.fromMe || false;

  const mainMessagePart = message.message;

  let commandInputText = '';

  const textExtractionPaths = ['conversation', 'extendedTextMessage.text', 'imageMessage.caption', 'videoMessage.caption', 'documentMessage.caption'];

  commandInputText = _extractTextFromMessageObject(mainMessagePart, textExtractionPaths);

  if (!commandInputText) {
    const quotedMessagePart = mainMessagePart?.extendedTextMessage?.contextInfo?.quotedMessage;
    if (quotedMessagePart) {
      commandInputText = _extractTextFromMessageObject(quotedMessagePart, textExtractionPaths);
    }
  }

  let descriptiveMessageText = '';
  if (message.message?.conversation) {
    descriptiveMessageText = message.message.conversation;
  } else if (message.message?.extendedTextMessage?.text) {
    descriptiveMessageText = message.message.extendedTextMessage.text;
  } else if (message.message?.imageMessage?.caption) {
    descriptiveMessageText = `Imagem: ${message.message.imageMessage.caption || '(sem legenda)'}`;
  } else if (message.message?.imageMessage) {
    // Imagem sem legenda
    descriptiveMessageText = 'Imagem (sem legenda)';
  } else if (message.message?.videoMessage?.caption) {
    descriptiveMessageText = `Vídeo: ${message.message.videoMessage.caption || '(sem legenda)'}`;
  } else if (message.message?.videoMessage) {
    // Vídeo sem legenda
    descriptiveMessageText = 'Vídeo (sem legenda)';
  } else if (message.message?.documentMessage?.caption) {
    descriptiveMessageText = `Documento: ${message.message.documentMessage.caption}`;
  } else if (message.message?.documentMessage?.fileName) {
    descriptiveMessageText = `Documento: ${message.message.documentMessage.fileName}`;
  } else if (message.message?.documentMessage) {
    descriptiveMessageText = 'Documento (sem legenda/nome)';
  } else if (commandInputText) {
    // Se commandInputText foi extraído (ex: de citação) mas não houve descrição primária
    descriptiveMessageText = `(Conteúdo para comando: "${commandInputText}")`;
  } else {
    descriptiveMessageText = '(Conteúdo não textual ou não identificado)';
  }

  logger.debug(`[MessageController] Conteúdo da mensagem de ${from}: "${descriptiveMessageText}"`, {
    label: 'MessageController',
    messageId,
    from,
    content: descriptiveMessageText,
    instanceId,
  });

  console.log(message);

  if (isFromMe) {
    logger.debug(`[MessageController] Mensagem ID: ${messageId} é de mim mesmo, ignorando para respostas automáticas.`, { label: 'MessageController', messageId, instanceId });
  } else {
    const command = commandInputText.trim().toLowerCase();

    switch (command) {
      case 'ping':
        if (baileysClient && from) {
          try {
            await baileysClient.sendMessage(from, { text: JSON.stringify(message, null, 2) });
            logger.info(`[MessageController] 'pong' enviado com sucesso para ${from}.`, { label: 'MessageController', messageId, from, instanceId });
          } catch (error) {
            logger.error(`[MessageController] Erro ao enviar 'pong' para ${from}: ${error.message}`, { label: 'MessageController', messageId, from, instanceId, error: error.stack });
          }
        } else {
          logger.warn(`[MessageController] Não foi possível enviar 'pong' para ${from}: cliente Baileys indisponível ou 'from' (remoteJid) ausente.`, { label: 'MessageController', messageId, from, instanceId, clientAvailable: !!baileysClient });
        }
        break;
      default:
        if (command) {
          logger.debug(`[MessageController] Texto "${command}" de ${from} não corresponde a um comando conhecido.`, {
            label: 'MessageController',
            messageId,
            from,
            commandReceived: command,
            sourceTextForCommand: commandInputText,
            fullDescriptiveText: descriptiveMessageText,
            instanceId,
          });
        }
        break;
    }
  }

  logger.info(`[MessageController] Mensagem ID: ${messageId} processada.`, { label: 'MessageController', messageId, instanceId });

  return {
    processed: true,
    messageId,
    status: 'Mensagem processada com sucesso pelo controller.',
  };
}

module.exports = {
  processIncomingMessage,
};
