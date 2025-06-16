const logger = require('../utils/logs/logger');
const { getTextSimple } = require('../services/MessageExtractor');
const { getFileBuffer } = require('../utils/baileys/getFileBuffer');
const fs = require('fs').promises;
const path = require('path');

require('dotenv').config();

const COMMAND_PREFIX = process.env.COMMAND_PREFIX || '/';

const processedMessageIds = new Set();
const MAX_PROCESSED_IDS = 1000;

/**
 * Extrai detalhes da mídia da mensagem
 * @param {object} message - O objeto da mensagem
 * @returns {{mediaType: string, mediaKey: object}|null} - Detalhes da mídia ou null se não encontrada
 */
function extractMediaDetails(message) {
  const messageContent = message.message;

  // Verificar se é uma resposta a outra mensagem
  const quotedMessage = messageContent?.extendedTextMessage?.contextInfo?.quotedMessage;

  // Verificar mídia na mensagem original
  if (messageContent?.imageMessage) {
    return { mediaType: 'image', mediaKey: messageContent.imageMessage };
  } else if (messageContent?.videoMessage) {
    return { mediaType: 'video', mediaKey: messageContent.videoMessage };
  } else if (messageContent?.audioMessage) {
    return { mediaType: 'audio', mediaKey: messageContent.audioMessage };
  } else if (messageContent?.documentMessage) {
    return { mediaType: 'document', mediaKey: messageContent.documentMessage };
  } else if (messageContent?.stickerMessage) {
    return { mediaType: 'sticker', mediaKey: messageContent.stickerMessage };
  }

  // Verificar mídia na mensagem citada
  if (quotedMessage) {
    if (quotedMessage.imageMessage) {
      return { mediaType: 'image', mediaKey: quotedMessage.imageMessage, isQuoted: true };
    } else if (quotedMessage.videoMessage) {
      return { mediaType: 'video', mediaKey: quotedMessage.videoMessage, isQuoted: true };
    } else if (quotedMessage.audioMessage) {
      return { mediaType: 'audio', mediaKey: quotedMessage.audioMessage, isQuoted: true };
    } else if (quotedMessage.documentMessage) {
      return { mediaType: 'document', mediaKey: quotedMessage.documentMessage, isQuoted: true };
    } else if (quotedMessage.stickerMessage) {
      return { mediaType: 'sticker', mediaKey: quotedMessage.stickerMessage, isQuoted: true };
    }
  }

  return null;
}

function cleanupProcessedIds() {
  if (processedMessageIds.size > MAX_PROCESSED_IDS) {
    const idsArray = Array.from(processedMessageIds);
    const toRemove = idsArray.slice(0, Math.floor(MAX_PROCESSED_IDS * 0.3));
    toRemove.forEach((id) => processedMessageIds.delete(id));
    logger.debug(`[MessageController] Limpeza de cache: ${toRemove.length} IDs de mensagens removidos`, {
      label: 'MessageController.cleanupProcessedIds',
      beforeCount: idsArray.length,
      afterCount: processedMessageIds.size,
    });
  }
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

  const uniqueMessages = messages.filter((message) => {
    const messageId = message.key?.id;
    if (!messageId) return true;

    if (processedMessageIds.has(messageId)) {
      logger.debug(`[MessageController] Ignorando mensagem duplicada ID: ${messageId}`, {
        label: 'MessageController.processBatchMessages.filterDuplicates',
        messageId,
      });
      return false;
    }

    processedMessageIds.add(messageId);
    return true;
  });

  cleanupProcessedIds();

  if (uniqueMessages.length === 0) {
    return {
      processed: true,
      count: 0,
      status: 'Todas as mensagens já foram processadas anteriormente',
      duplicatesSkipped: messages.length,
    };
  }

  const commandQueue = [];

  for (const message of uniqueMessages) {
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

  logger.info(`[MessageController] Lote de ${uniqueMessages.length} mensagens processado com ${commandQueue.length} comandos`, {
    label: 'MessageController.processBatchMessages',
    messagesProcessed: uniqueMessages.length,
    commandsExecuted: commandQueue.length,
    duplicatesSkipped: messages.length - uniqueMessages.length,
  });

  return {
    processed: true,
    count: uniqueMessages.length,
    commandsExecuted: commandQueue.length,
    duplicatesSkipped: messages.length - uniqueMessages.length,
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

  // Verifica se a mensagem tem mídia
  let hasMedia = false;
  let mediaType = null;

  if (mainMessagePart) {
    if (mainMessagePart.imageMessage) {
      hasMedia = true;
      mediaType = 'image';
    } else if (mainMessagePart.videoMessage) {
      hasMedia = true;
      mediaType = 'video';
    } else if (mainMessagePart.audioMessage) {
      hasMedia = true;
      mediaType = 'audio';
    } else if (mainMessagePart.documentMessage) {
      hasMedia = true;
      mediaType = 'document';
    } else if (mainMessagePart.stickerMessage) {
      hasMedia = true;
      mediaType = 'sticker';
    }
  }

  let commandInputText = getTextSimple(mainMessagePart);

  if (!commandInputText && typeof message.text === 'string' && message.text.trim() !== '') {
    commandInputText = message.text.trim();
    logger.debug('[MessageController.processMessageCore] Texto extraído de message.text (nível raiz)', { label: 'MessageController.processMessageCore' });
  }

  if (!commandInputText) {
    const quotedMessagePart = mainMessagePart?.extendedTextMessage?.contextInfo?.quotedMessage;
    if (quotedMessagePart) {
      commandInputText = getTextSimple(quotedMessagePart);
    }
  }

  const fullCommand = commandInputText.trim();
  let command = '';
  let isValidCommand = false;

  if (fullCommand.startsWith(COMMAND_PREFIX)) {
    const potentialCommand = fullCommand.substring(COMMAND_PREFIX.length).toLowerCase();
    if (potentialCommand.length > 0) {
      // Extrair apenas a primeira palavra como comando
      const commandParts = potentialCommand.split(/\s+/);
      command = commandParts[0];

      // Verificar se o comando pode ser um comando composto como '/sopma' quando deveria ser '/s opma'
      if (command.startsWith('s') && command.length > 1 && !['sticker'].includes(command)) {
        // Este é um caso especial para o comando 's' sem espaço após ele
        command = 's';
        logger.debug(`[MessageController] Comando 's' detectado sem espaço: '${potentialCommand}', corrigido para 's'`);
      }
      // Verificar se o comando pode ser um comando composto como '/stickertexto' quando deveria ser '/sticker texto'
      else if (command.startsWith('sticker') && command.length > 7) {
        // Este é um caso especial para o comando 'sticker' sem espaço após ele
        command = 'sticker';
        logger.debug(`[MessageController] Comando 'sticker' detectado sem espaço: '${potentialCommand}', corrigido para 'sticker'`);
      }

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
    hasMedia,
    mediaType,
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
              text: JSON.stringify({ status: item }, null, 2),
            },
            { quoted: item.originalMessage },
          );
          logger.info(`[MessageController] Comando '${COMMAND_PREFIX}ping' respondido para ${item.from}`, {
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

      case 'sticker':
      case 's':
        try {
          const { processSticker } = require('../commandModules/stickerCommand');
          const { extractTextFromMessageObject } = require('../services/MessageExtractor');

          // Obter texto adicional para nome do pacote/autor usando o MessageExtractor
          const fullCommand = item.fullCommand || '';
          let params = '';

          // Extrair texto da mensagem original (para comandos como "/s texto")
          if (fullCommand.startsWith(COMMAND_PREFIX)) {
            // Primeiro, remover o prefixo do comando
            const textWithoutPrefix = fullCommand.substring(COMMAND_PREFIX.length).trim();

            // Verificar se o comando é 's' ou 'sticker'
            if (textWithoutPrefix.startsWith('s ')) {
              params = textWithoutPrefix.substring(2).trim();
            } else if (textWithoutPrefix.startsWith('sticker ')) {
              params = textWithoutPrefix.substring(8).trim();
            } else if (textWithoutPrefix === 's' || textWithoutPrefix === 'sticker') {
              params = '';
            } else if (textWithoutPrefix.startsWith('s') && !textWithoutPrefix.startsWith('sticker')) {
              // Caso especial: "/sopma" -> comando 's', parâmetro 'opma'
              params = textWithoutPrefix.substring(1).trim();
            } else if (textWithoutPrefix.startsWith('sticker') && textWithoutPrefix.length > 7) {
              // Caso especial: "/stickertexto" -> comando 'sticker', parâmetro 'texto'
              params = textWithoutPrefix.substring(7).trim();
            }

            logger.debug(`[MessageController] Parâmetros extraídos do comando: "${params}"`);
          }

          // Log detalhado para diagnóstico
          logger.warn(`[MessageController] Análise do comando sticker:`, {
            fullCommand: fullCommand,
            extractedParams: params,
            originalCommand: item.command,
            hasTextAfterCommand: params.length > 0,
            textAfterPrefix: fullCommand.startsWith(COMMAND_PREFIX) ? fullCommand.substring(COMMAND_PREFIX.length).trim() : '',
            containsPipe: params.includes('|'),
            splitResult: params.includes('|') ? params.split('|').map((part) => part.trim()) : [],
          });

          // Enviar reação de processamento
          await baileysClient.sendMessage(item.from, { react: { text: '⏳', key: item.originalMessage.key } });

          logger.info(`[MessageController] Processando comando '${COMMAND_PREFIX}sticker' para ${item.from}`, {
            label: 'MessageController.executeBatchCommands.sticker',
            messageId: item.messageId,
            from: item.from,
            params,
            fullCommand,
          });

          // Verificar se é apenas um comando de texto sem mídia
          const mediaDetails = extractMediaDetails(item.originalMessage);

          // Se não há parâmetros no comando, tenta extrair da mensagem de texto principal
          if (!params && item.originalMessage && item.originalMessage.message) {
            const extracted = extractTextFromMessageObject(item.originalMessage.message, { debug: true });
            if (extracted && extracted.found && extracted.text) {
              // Remover o prefixo do comando se estiver presente
              const extractedText = extracted.text.trim();
              if (extractedText.startsWith(COMMAND_PREFIX)) {
                const textWithoutPrefix = extractedText.substring(COMMAND_PREFIX.length).trim();
                // Remover o comando (s ou sticker) se estiver presente
                if (textWithoutPrefix.startsWith('s ')) {
                  params = textWithoutPrefix.substring(2).trim();
                } else if (textWithoutPrefix.startsWith('sticker ')) {
                  params = textWithoutPrefix.substring(8).trim();
                } else if (textWithoutPrefix.startsWith('s') && !textWithoutPrefix.startsWith('sticker')) {
                  params = textWithoutPrefix.substring(1).trim();
                } else if (textWithoutPrefix.startsWith('sticker') && textWithoutPrefix.length > 7) {
                  params = textWithoutPrefix.substring(7).trim();
                } else {
                  params = textWithoutPrefix;
                }
              } else {
                // Se não há prefixo, usar o texto completo como parâmetro
                params = extractedText;
              }

              logger.debug(`[MessageController] Parâmetros extraídos do texto da mensagem: "${params}"`);
            }
          }

          // Log adicional para o texto extraído
          logger.debug(`[MessageController] Parâmetros finais para sticker: "${params}"`);

          if (!mediaDetails || !mediaDetails.mediaType) {
            // Se não há mídia e há texto após o comando, informar que é necessário enviar mídia
            await baileysClient.sendMessage(
              item.from,
              {
                text: '❌ Você precisa enviar uma mídia junto com o comando ou responder a uma mensagem com mídia.\n\n' + '💡 Exemplos:\n' + '- Envie uma imagem com a legenda /s Meu Sticker\n' + '- Responda a uma imagem com /s Meu Sticker',
              },
              { quoted: item.originalMessage },
            );

            logger.info(`[MessageController] Comando '${COMMAND_PREFIX}sticker' sem mídia para ${item.from}`, {
              label: 'MessageController.executeBatchCommands.sticker.noMedia',
              messageId: item.messageId,
              from: item.from,
              params,
            });
            break;
          }

          // Processar o sticker
          const result = await processSticker(baileysClient, item.originalMessage, item.from, item.from, params);

          // Log adicional para verificar o resultado
          logger.debug(`[MessageController] Resultado do processamento de sticker:`, {
            success: result.success,
            message: result.message,
            params: params,
            hasStickerPath: !!result.stickerPath,
          });

          if (result.success) {
            // Enviar sticker
            await baileysClient.sendMessage(item.from, { react: { text: '✅', key: item.originalMessage.key } });

            await baileysClient.sendMessage(item.from, { sticker: { url: result.stickerPath } }, { quoted: item.originalMessage });

            logger.info(`[MessageController] Sticker enviado com sucesso para ${item.from}`, {
              label: 'MessageController.executeBatchCommands.sticker.success',
              messageId: item.messageId,
              from: item.from,
            });

            // Limpar o arquivo do sticker após o envio
            try {
              const fs = require('fs').promises;
              await fs.unlink(result.stickerPath);
            } catch (cleanupError) {
              logger.warn(`[MessageController] Erro ao limpar arquivo de sticker: ${cleanupError.message}`);
            }
          } else {
            // Enviar mensagem de erro
            await baileysClient.sendMessage(item.from, { react: { text: '❌', key: item.originalMessage.key } });

            await baileysClient.sendMessage(item.from, { text: result.message }, { quoted: item.originalMessage });

            logger.warn(`[MessageController] Falha ao criar sticker para ${item.from}: ${result.message}`, {
              label: 'MessageController.executeBatchCommands.sticker.failed',
              messageId: item.messageId,
              from: item.from,
              error: result.message,
            });
          }
        } catch (error) {
          logger.error(`[MessageController] Erro ao processar comando '${COMMAND_PREFIX}sticker': ${error.message}`, {
            label: 'MessageController.executeBatchCommands.sticker.error',
            messageId: item.messageId,
            from: item.from,
            error: error.stack,
          });

          try {
            await baileysClient.sendMessage(item.from, { react: { text: '❌', key: item.originalMessage.key } });

            await baileysClient.sendMessage(item.from, { text: `❌ Erro ao criar sticker: ${error.message}` }, { quoted: item.originalMessage });
          } catch (replyError) {
            logger.error(`[MessageController] Erro ao enviar mensagem de erro para '${COMMAND_PREFIX}sticker': ${replyError.message}`);
          }
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
  const messageId = message.key?.id;

  if (messageId && processedMessageIds.has(messageId)) {
    logger.debug(`[MessageController] Ignorando mensagem duplicada ID: ${messageId} em processamento individual`, {
      label: 'MessageController.processIncomingMessage.duplicate',
      messageId,
      remoteJid: message.key?.remoteJid,
    });

    return {
      processed: false,
      messageId,
      status: 'Mensagem já processada anteriormente (duplicada)',
      isDuplicate: true,
    };
  }

  logger.info(`[MessageController] Processando mensagem individual ID: ${messageId} de ${message.key?.remoteJid}`, {
    label: 'MessageController.processIncomingMessage',
    messageId,
    remoteJid: message.key?.remoteJid,
    instanceId: message.instanceId,
  });

  const result = await processBatchMessages([message], baileysClient);

  logger.info(`[MessageController] Mensagem ID: ${messageId} processada via lote. Comandos executados: ${result.commandsExecuted}`, {
    label: 'MessageController.processIncomingMessage',
    messageId,
    instanceId: message.instanceId,
    batchResultStatus: result.status,
    commandsExecuted: result.commandsExecuted,
  });

  return {
    processed: true,
    messageId,
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
  clearProcessedMessagesCache: () => {
    const count = processedMessageIds.size;
    processedMessageIds.clear();
    return { clearedCount: count };
  },
};
