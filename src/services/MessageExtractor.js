const logger = require('../utils/logs/logger');

// Caminhos conhecidos onde o texto pode ser encontrado em objetos de mensagem do WhatsApp
const TEXT_EXTRACTION_PATHS = ['conversation', 'viewOnceMessageV2.message.imageMessage.caption', 'viewOnceMessageV2.message.videoMessage.caption', 'imageMessage.caption', 'videoMessage.caption', 'extendedTextMessage.text', 'viewOnceMessage.message.videoMessage.caption', 'viewOnceMessage.message.imageMessage.caption', 'documentWithCaptionMessage.message.documentMessage.caption', 'buttonsMessage.imageMessage.caption', 'buttonsResponseMessage.selectedButtonId', 'listResponseMessage.singleSelectReply.selectedRowId', 'templateButtonReplyMessage.selectedId', 'editedMessage.message.protocolMessage.editedMessage.extendedTextMessage.text', 'editedMessage.message.protocolMessage.editedMessage.imageMessage.caption', 'interactiveResponseMessage.nativeFlowResponseMessage.paramsJson', 'documentMessage.caption'];

/**
 * Extrai texto de um objeto de mensagem do WhatsApp, verificando vários caminhos possíveis.
 *
 * @param {Object} msgObj - O objeto de mensagem do WhatsApp
 * @returns {string} O texto extraído ou uma string vazia se não for encontrado
 */
function extractTextFromMessageObject(msgObj) {
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
            logger.warn(`[MessageExtractor] Erro ao parsear paramsJson: ${e.message}`, { label: 'MessageExtractor.extractTextFromMessageObject', path, value: typeof current });
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

module.exports = {
  extractTextFromMessageObject,
  TEXT_EXTRACTION_PATHS,
};
