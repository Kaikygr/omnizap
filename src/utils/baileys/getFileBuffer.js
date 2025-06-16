const { downloadContentFromMessage } = require('baileys');
const logger = require('./../logs/logger');
const VALID_MEDIA_TYPES = new Set(['audio', 'video', 'image', 'document', 'sticker']);

const DEFAULT_MAX_ALLOWED_SIZE_BYTES = 50 * 1024 * 1024;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 30 * 1000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_DELAY_MS = 2000;

/**
 * Obtém o buffer de um arquivo a partir de uma mensagem do WhatsApp
 * @param {Object} mediaKey - Objeto contendo as informações da mídia
 * @param {string} mediaType - Tipo de mídia (audio, video, image, document, sticker)
 * @param {Object} options - Opções adicionais
 * @param {boolean} [options.allowUnknownType=false] - Permite tipos desconhecidos
 * @param {number} [options.maxSize=50MB] - Tamanho máximo permitido em bytes
 * @param {number} [options.timeoutMs=30000] - Timeout para download em milissegundos
 * @param {number} [options.maxRetries=3] - Número máximo de tentativas
 * @param {number} [options.retryDelayMs=2000] - Tempo de espera entre tentativas
 * @returns {Promise<Buffer|null>} Buffer do arquivo ou null em caso de erro
 */
const getFileBuffer = async (mediaKey, mediaType, options = {}) => {
  const { allowUnknownType = false, maxSize = DEFAULT_MAX_ALLOWED_SIZE_BYTES, timeoutMs = DEFAULT_DOWNLOAD_TIMEOUT_MS, maxRetries = DEFAULT_MAX_RETRIES, retryDelayMs = DEFAULT_RETRY_DELAY_MS } = options;

  // Validação de parâmetros
  if (!mediaKey || typeof mediaKey !== 'object') {
    logger.warn(`[ getFileBuffer ] Invalid or missing 'mediaKey' parameter. Expected an object, received: ${typeof mediaKey}`);
    return null;
  }

  if (!mediaType || typeof mediaType !== 'string') {
    logger.warn(`[ getFileBuffer ] Invalid or missing 'mediaType' parameter. Expected a string, received: ${typeof mediaType}`);
    return null;
  }

  if (!VALID_MEDIA_TYPES.has(mediaType)) {
    if (!allowUnknownType) {
      logger.warn(`[ getFileBuffer ] Invalid mediaType specified: '${mediaType}'. Must be one of: ${[...VALID_MEDIA_TYPES].join(', ')}. Set options.allowUnknownType=true to attempt download anyway.`);
      return null;
    } else {
      logger.info(`[ getFileBuffer ] Unknown mediaType specified: '${mediaType}'. Proceeding with download attempt as allowUnknownType is true.`);
    }
  }

  let lastError = null;
  for (let attemptCount = 0; attemptCount <= maxRetries; attemptCount++) {
    if (attemptCount > 0) {
      logger.info(`[ getFileBuffer ] Retry attempt ${attemptCount}/${maxRetries} for media type '${mediaType}' after ${retryDelayMs}ms delay...`);
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }

    let stream = null;
    const controller = new AbortController();
    let timeoutId = null;

    try {
      timeoutId = setTimeout(() => {
        logger.warn(`[ getFileBuffer ] Download timed out after ${timeoutMs}ms for type '${mediaType}'. Aborting.`);
        controller.abort('TIMEOUT');
      }, timeoutMs);

      logger.debug(`[ getFileBuffer ] Attempting to download media type '${mediaType}' (Attempt: ${attemptCount + 1}/${maxRetries + 1}, Limit: ${maxSize.toLocaleString()} bytes, Timeout: ${timeoutMs}ms)...`);

      stream = await downloadContentFromMessage(mediaKey, mediaType);

      const chunks = [];
      let totalSize = 0;

      for await (const chunk of stream) {
        if (controller.signal.aborted) {
          throw new Error(`Download aborted: ${controller.signal.reason || 'Unknown reason'}`);
        }

        totalSize += chunk.length;

        if (totalSize > maxSize) {
          controller.abort('SIZE_LIMIT_EXCEEDED');
          throw new Error(`Size limit exceeded. Received ${totalSize.toLocaleString()} bytes, limit is ${maxSize.toLocaleString()} bytes`);
        }
        chunks.push(chunk);
      }

      clearTimeout(timeoutId);
      timeoutId = null;

      if (controller.signal.aborted) {
        throw new Error(`Download aborted: ${controller.signal.reason || 'Unknown reason'}`);
      }

      if (chunks.length === 0 && totalSize === 0) {
        throw new Error(`No data received from stream for media type '${mediaType}'. The media might be empty or inaccessible.`);
      }

      const buffer = Buffer.concat(chunks);

      if (buffer.length === 0) {
        throw new Error(`Download resulted in an empty buffer for media type '${mediaType}' after concatenation, despite receiving ${totalSize} bytes.`);
      }

      if (buffer.length !== totalSize) {
        logger.warn(`[ getFileBuffer ] Integrity check: Buffer size (${buffer.length}) doesn't match expected size (${totalSize}). This could indicate data corruption.`);
      }

      logger.info(`[ getFileBuffer ] Download successful: ${buffer.length.toLocaleString()} bytes (${(buffer.length / 1024 / 1024).toFixed(2)} MB) downloaded for media type '${mediaType}'. Limit: ${maxSize.toLocaleString()} bytes.`);
      return buffer;
    } catch (error) {
      lastError = error;

      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }

      if (stream) {
        try {
          if (typeof stream.destroy === 'function') stream.destroy();
          else if (typeof stream.cancel === 'function') stream.cancel();
        } catch (cleanupError) {
          logger.debug(`[ getFileBuffer ] Error while cleaning up stream: ${cleanupError?.message || cleanupError}`);
        }
      }

      const isAbortError = error.name === 'AbortError' || controller.signal.aborted;
      const abortReason = controller.signal.reason;

      if (isAbortError && abortReason === 'SIZE_LIMIT_EXCEEDED') {
        logger.warn(`[ getFileBuffer ] Download aborted due to size limit for type '${mediaType}'. No more retries will be attempted.`);
        return null;
      } else if (isAbortError && abortReason === 'TIMEOUT') {
        logger.warn(`[ getFileBuffer ] Download timed out for type '${mediaType}'. ${attemptCount < maxRetries ? 'Will retry.' : 'No more retries.'}`);
        // Continue para a próxima tentativa
      } else {
        logger.error(`[ getFileBuffer ] Failed to download media type '${mediaType}' (Attempt ${attemptCount + 1}/${maxRetries + 1}). Error: ${error?.message || error}`, {
          message: error?.message,
          name: error?.name,
          stack: error?.stack,
          mediaType: mediaType,
          attempt: attemptCount + 1,
          maxRetries: maxRetries,
          isAborted: isAbortError,
          abortReason: abortReason,
        });
        // Continue para a próxima tentativa
      }
    }
  }

  // Se chegamos aqui, todas as tentativas falharam
  logger.error(`[ getFileBuffer ] All ${maxRetries + 1} attempts failed to download media type '${mediaType}'. Last error: ${lastError?.message || lastError}`);
  return null;
};

module.exports = {
  getFileBuffer,
  DEFAULT_MAX_ALLOWED_SIZE_BYTES,
  DEFAULT_DOWNLOAD_TIMEOUT_MS,
  DEFAULT_MAX_RETRIES,
  DEFAULT_RETRY_DELAY_MS,
};
