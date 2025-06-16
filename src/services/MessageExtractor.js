const logger = require('../utils/logs/logger');

/**
 * Caminhos conhecidos onde o texto pode ser encontrado em objetos de mensagem do WhatsApp.
 * Esta lista é usada para percorrer as possíveis localizações de texto em diferentes tipos de mensagens.
 *
 * @constant {string[]}
 */
const TEXT_EXTRACTION_PATHS = [
  // Mensagens básicas de texto
  'conversation',
  'extendedTextMessage.text',

  // Mensagens de mídia com legendas
  'imageMessage.caption',
  'videoMessage.caption',
  'documentMessage.caption',

  // Mensagens de visualização única
  'viewOnceMessageV2.message.imageMessage.caption',
  'viewOnceMessageV2.message.videoMessage.caption',
  'viewOnceMessage.message.videoMessage.caption',
  'viewOnceMessage.message.imageMessage.caption',

  // Mensagens com documentos e legendas
  'documentWithCaptionMessage.message.documentMessage.caption',

  // Mensagens com botões e interações
  'buttonsMessage.imageMessage.caption',
  'buttonsResponseMessage.selectedButtonId',
  'listResponseMessage.singleSelectReply.selectedRowId',
  'templateButtonReplyMessage.selectedId',

  // Mensagens editadas
  'editedMessage.message.protocolMessage.editedMessage.extendedTextMessage.text',
  'editedMessage.message.protocolMessage.editedMessage.imageMessage.caption',

  // Mensagens interativas com JSON
  'interactiveResponseMessage.nativeFlowResponseMessage.paramsJson',
];

/**
 * Classe de erro personalizada para problemas relacionados à extração de mensagens
 *
 * @class MessageExtractorError
 * @extends Error
 */
class MessageExtractorError extends Error {
  /**
   * Cria uma nova instância de MessageExtractorError
   *
   * @param {string} message - Mensagem de erro
   * @param {Object} [metadata={}] - Metadados adicionais sobre o erro
   */
  constructor(message, metadata = {}) {
    super(message);
    this.name = 'MessageExtractorError';
    this.metadata = metadata;
    this.timestamp = new Date().toISOString();
  }
}

/**
 * Navegue por um caminho de propriedades em um objeto
 *
 * @param {Object} obj - O objeto para navegar
 * @param {string[]} path - Array com o caminho das propriedades
 * @param {Object} [options={}] - Opções de navegação
 * @param {boolean} [options.throwOnMissing=false] - Se deve lançar erro quando um caminho estiver faltando
 * @returns {*} O valor encontrado no caminho ou undefined se não existir
 * @throws {MessageExtractorError} Se throwOnMissing for true e o caminho não existir
 */
function getValueByPath(obj, path, options = {}) {
  const { throwOnMissing = false } = options;

  if (!obj || typeof obj !== 'object') {
    if (throwOnMissing) {
      throw new MessageExtractorError('Objeto base inválido', { obj, path });
    }
    return undefined;
  }

  try {
    let current = obj;

    for (const key of path) {
      if (current && typeof current === 'object' && Object.prototype.hasOwnProperty.call(current, key) && current[key] !== null && current[key] !== undefined) {
        current = current[key];
      } else {
        if (throwOnMissing) {
          throw new MessageExtractorError(`Caminho ${path.join('.')} inválido: propriedade '${key}' não encontrada`, { path, failedAt: key });
        }
        return undefined;
      }
    }

    return current;
  } catch (error) {
    if (error instanceof MessageExtractorError) {
      throw error;
    }

    throw new MessageExtractorError(`Erro ao navegar no caminho: ${error.message}`, { originalError: error.message, path });
  }
}

/**
 * Extrai texto de um objeto de mensagem do WhatsApp, verificando vários caminhos possíveis.
 *
 * @param {Object} msgObj - O objeto de mensagem do WhatsApp
 * @param {Object} [options={}] - Opções de configuração
 * @param {boolean} [options.debug=false] - Se deve registrar logs de depuração
 * @param {boolean} [options.includePathInfo=false] - Se deve incluir informações sobre o caminho no resultado
 * @param {string[]} [options.customPaths=[]] - Caminhos adicionais para verificar
 * @returns {Object} Objeto contendo o texto extraído e metadados
 * @throws {MessageExtractorError} Se ocorrer um erro durante a extração
 */
function extractTextFromMessageObject(msgObj, options = {}) {
  const { debug = false, includePathInfo = false, customPaths = [] } = options;

  // Resultado padrão
  const result = {
    text: '',
    found: false,
    path: null,
    type: null,
  };

  if (!msgObj || typeof msgObj !== 'object') {
    logger.warn('[MessageExtractor] Objeto de mensagem inválido ou não fornecido', {
      label: 'MessageExtractor.extractTextFromMessageObject',
      messageType: typeof msgObj,
    });
    return result;
  }

  try {
    // Combinar caminhos padrão com caminhos personalizados
    const pathsToCheck = [...TEXT_EXTRACTION_PATHS, ...customPaths];

    for (const path of pathsToCheck) {
      try {
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
          let valueType = typeof current;

          // Tratamento específico para o caminho de paramsJson
          if (path === 'interactiveResponseMessage.nativeFlowResponseMessage.paramsJson') {
            if (typeof current === 'string' && current.length > 0) {
              try {
                const parsedJson = JSON.parse(current);
                if (parsedJson && typeof parsedJson.id === 'string') {
                  textToReturn = parsedJson.id;
                  valueType = 'json-string';
                } else if (parsedJson && typeof parsedJson.id === 'number') {
                  textToReturn = String(parsedJson.id);
                  valueType = 'json-number';
                }
              } catch (e) {
                if (debug) {
                  logger.warn(`[MessageExtractor] Erro ao parsear paramsJson: ${e.message}`, {
                    label: 'MessageExtractor.extractTextFromMessageObject',
                    path,
                    value: typeof current,
                    error: e.message,
                  });
                }
                continue; // Vá para o próximo caminho
              }
            }
          } else if (typeof current === 'string') {
            textToReturn = current;
          } else if (typeof current === 'number') {
            textToReturn = String(current);
          }

          if (textToReturn.trim() !== '') {
            // Encontramos texto válido
            result.text = textToReturn.trim();
            result.found = true;
            result.type = valueType;

            if (includePathInfo) {
              result.path = path;
            }

            if (debug) {
              logger.debug(`[MessageExtractor] Texto extraído com sucesso`, {
                label: 'MessageExtractor.extractTextFromMessageObject',
                path,
                length: result.text.length,
                preview: result.text.substring(0, 50) + (result.text.length > 50 ? '...' : ''),
              });
            }

            return result;
          }
        }
      } catch (pathError) {
        // Registrar erro para este caminho, mas continuar tentando outros
        if (debug) {
          logger.warn(`[MessageExtractor] Erro ao processar caminho ${path}: ${pathError.message}`, {
            label: 'MessageExtractor.extractTextFromMessageObject',
            path,
            error: pathError.message,
          });
        }
        continue;
      }
    }

    // Se chegamos aqui, não encontramos texto em nenhum caminho
    if (debug) {
      logger.debug(`[MessageExtractor] Nenhum texto encontrado no objeto de mensagem`, {
        label: 'MessageExtractor.extractTextFromMessageObject',
        messageKeys: Object.keys(msgObj),
      });
    }

    return result;
  } catch (error) {
    // Erro geral na função
    logger.error(`[MessageExtractor] Erro ao extrair texto: ${error.message}`, {
      label: 'MessageExtractor.extractTextFromMessageObject',
      error: error.message,
      stack: error.stack,
    });

    throw new MessageExtractorError(`Falha ao extrair texto: ${error.message}`, {
      originalError: error.message,
    });
  }
}

/**
 * Determina o tipo de mensagem com base nas propriedades presentes
 *
 * @param {Object} msgObj - O objeto de mensagem a ser analisado
 * @returns {string} O tipo de mensagem identificado
 */
function getMessageType(msgObj) {
  if (!msgObj || typeof msgObj !== 'object') {
    return 'unknown';
  }

  try {
    // Checar tipos de mensagem comuns
    if (msgObj.conversation) return 'text';
    if (msgObj.extendedTextMessage) return 'extended-text';
    if (msgObj.imageMessage) return 'image';
    if (msgObj.videoMessage) return 'video';
    if (msgObj.audioMessage) return 'audio';
    if (msgObj.documentMessage) return 'document';
    if (msgObj.stickerMessage) return 'sticker';
    if (msgObj.contactMessage || msgObj.contactsArrayMessage) return 'contact';
    if (msgObj.locationMessage) return 'location';
    if (msgObj.liveLocationMessage) return 'live-location';
    if (msgObj.viewOnceMessage || msgObj.viewOnceMessageV2) return 'view-once';
    if (msgObj.buttonsMessage || msgObj.buttonsResponseMessage) return 'buttons';
    if (msgObj.listMessage || msgObj.listResponseMessage) return 'list';
    if (msgObj.templateMessage || msgObj.templateButtonReplyMessage) return 'template';
    if (msgObj.interactiveMessage || msgObj.interactiveResponseMessage) return 'interactive';
    if (msgObj.reactionMessage) return 'reaction';
    if (msgObj.editedMessage) return 'edited';

    // Se chegou aqui, não conseguimos identificar o tipo
    return 'unknown';
  } catch (error) {
    logger.warn(`[MessageExtractor] Erro ao determinar tipo de mensagem: ${error.message}`, {
      label: 'MessageExtractor.getMessageType',
      error: error.message,
    });
    return 'error';
  }
}

/**
 * Extrai todas as mídias presentes em um objeto de mensagem
 *
 * @param {Object} msgObj - O objeto de mensagem do WhatsApp
 * @returns {Object} Objeto contendo as informações de mídia encontradas
 */
function extractMediaInfo(msgObj) {
  const mediaInfo = {
    hasMedia: false,
    type: null,
    mimetype: null,
    caption: null,
    filename: null,
    url: null,
    metadata: {},
  };

  if (!msgObj || typeof msgObj !== 'object') {
    return mediaInfo;
  }

  try {
    // Verificar imagem
    if (msgObj.imageMessage) {
      const img = msgObj.imageMessage;
      mediaInfo.hasMedia = true;
      mediaInfo.type = 'image';
      mediaInfo.mimetype = img.mimetype;
      mediaInfo.caption = img.caption || null;
      mediaInfo.url = img.url || null;
      mediaInfo.metadata = {
        width: img.width,
        height: img.height,
        jpegThumbnail: img.jpegThumbnail ? 'presente' : 'ausente',
      };
      return mediaInfo;
    }

    // Verificar vídeo
    if (msgObj.videoMessage) {
      const video = msgObj.videoMessage;
      mediaInfo.hasMedia = true;
      mediaInfo.type = 'video';
      mediaInfo.mimetype = video.mimetype;
      mediaInfo.caption = video.caption || null;
      mediaInfo.url = video.url || null;
      mediaInfo.metadata = {
        seconds: video.seconds,
        jpegThumbnail: video.jpegThumbnail ? 'presente' : 'ausente',
      };
      return mediaInfo;
    }

    // Verificar áudio
    if (msgObj.audioMessage) {
      const audio = msgObj.audioMessage;
      mediaInfo.hasMedia = true;
      mediaInfo.type = 'audio';
      mediaInfo.mimetype = audio.mimetype;
      mediaInfo.metadata = {
        seconds: audio.seconds,
        ptt: audio.ptt || false,
      };
      return mediaInfo;
    }

    // Verificar documento
    if (msgObj.documentMessage) {
      const doc = msgObj.documentMessage;
      mediaInfo.hasMedia = true;
      mediaInfo.type = 'document';
      mediaInfo.mimetype = doc.mimetype;
      mediaInfo.caption = doc.caption || null;
      mediaInfo.filename = doc.fileName || null;
      mediaInfo.url = doc.url || null;
      mediaInfo.metadata = {
        fileLength: doc.fileLength,
      };
      return mediaInfo;
    }

    // Mensagens de visualização única
    if (msgObj.viewOnceMessage) {
      const viewOnce = msgObj.viewOnceMessage.message;
      if (viewOnce.imageMessage) {
        const img = viewOnce.imageMessage;
        mediaInfo.hasMedia = true;
        mediaInfo.type = 'view-once-image';
        mediaInfo.mimetype = img.mimetype;
        mediaInfo.caption = img.caption || null;
        return mediaInfo;
      } else if (viewOnce.videoMessage) {
        const video = viewOnce.videoMessage;
        mediaInfo.hasMedia = true;
        mediaInfo.type = 'view-once-video';
        mediaInfo.mimetype = video.mimetype;
        mediaInfo.caption = video.caption || null;
        return mediaInfo;
      }
    }

    // ViewOnceV2 tem estrutura semelhante
    if (msgObj.viewOnceMessageV2) {
      const viewOnce = msgObj.viewOnceMessageV2.message;
      if (viewOnce && viewOnce.imageMessage) {
        const img = viewOnce.imageMessage;
        mediaInfo.hasMedia = true;
        mediaInfo.type = 'view-once-image-v2';
        mediaInfo.mimetype = img.mimetype;
        mediaInfo.caption = img.caption || null;
        return mediaInfo;
      } else if (viewOnce && viewOnce.videoMessage) {
        const video = viewOnce.videoMessage;
        mediaInfo.hasMedia = true;
        mediaInfo.type = 'view-once-video-v2';
        mediaInfo.mimetype = video.mimetype;
        mediaInfo.caption = video.caption || null;
        return mediaInfo;
      }
    }

    return mediaInfo;
  } catch (error) {
    logger.warn(`[MessageExtractor] Erro ao extrair informações de mídia: ${error.message}`, {
      label: 'MessageExtractor.extractMediaInfo',
      error: error.message,
    });
    return mediaInfo;
  }
}

/**
 * Analisa completamente um objeto de mensagem, extraindo texto, mídia e metadados
 *
 * @param {Object} msgObj - O objeto de mensagem do WhatsApp
 * @param {Object} [options={}] - Opções de configuração
 * @returns {Object} Objeto contendo todas as informações extraídas
 */
function analyzeMessage(msgObj, options = {}) {
  const result = {
    messageType: 'unknown',
    text: {
      content: '',
      found: false,
    },
    media: {
      hasMedia: false,
    },
    metadata: {
      timestamp: new Date().toISOString(),
      success: false,
    },
  };

  if (!msgObj || typeof msgObj !== 'object') {
    result.metadata.error = 'Objeto de mensagem inválido';
    return result;
  }

  try {
    // Extrair tipo de mensagem
    result.messageType = getMessageType(msgObj);

    // Extrair texto
    const extractedText = extractTextFromMessageObject(msgObj, options);
    result.text = extractedText;

    // Extrair informações de mídia
    const mediaInfo = extractMediaInfo(msgObj);
    result.media = mediaInfo;

    // Adicionar metadados relevantes
    result.metadata.success = true;
    result.metadata.hasContent = extractedText.found || mediaInfo.hasMedia;

    return result;
  } catch (error) {
    logger.error(`[MessageExtractor] Erro durante análise completa da mensagem: ${error.message}`, {
      label: 'MessageExtractor.analyzeMessage',
      error: error.message,
      stack: error.stack,
    });

    result.metadata.success = false;
    result.metadata.error = `Erro durante análise: ${error.message}`;
    return result;
  }
}

/**
 * Obtém uma versão simplificada do texto extraído para compatibilidade com versões anteriores
 *
 * @param {Object} msgObj - O objeto de mensagem do WhatsApp
 * @returns {string} O texto extraído ou string vazia
 */
function getTextSimple(msgObj) {
  try {
    const result = extractTextFromMessageObject(msgObj);
    return result.text || '';
  } catch (error) {
    logger.warn(`[MessageExtractor] Erro ao obter texto simplificado: ${error.message}`, {
      label: 'MessageExtractor.getTextSimple',
      error: error.message,
    });
    return '';
  }
}

module.exports = {
  // Funções principais
  extractTextFromMessageObject,
  getMessageType,
  extractMediaInfo,
  analyzeMessage,
  getTextSimple,

  // Funções utilitárias
  getValueByPath,

  // Constantes
  TEXT_EXTRACTION_PATHS,

  // Classes de erro
  MessageExtractorError,
};
