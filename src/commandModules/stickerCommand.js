const fs = require('fs').promises;
const path = require('path');
const util = require('util');
const { exec } = require('child_process');
const execProm = util.promisify(exec);
const logger = require('../utils/logs/logger');
const { getFileBuffer } = require('../utils/baileys/getFileBuffer');

// Diretório onde os arquivos temporários serão armazenados
const TEMP_DIR = path.join(process.cwd(), 'temp', 'stickers');
const STICKER_PREFS_DIR = path.join(process.cwd(), 'temp', 'prefs');

/**
 * Garante que os diretórios necessários existam
 * @returns {Promise<boolean>} true se os diretórios existem ou foram criados com sucesso
 */
async function ensureDirectories() {
  try {
    await fs.mkdir(TEMP_DIR, { recursive: true });
    await fs.mkdir(STICKER_PREFS_DIR, { recursive: true });
    return true;
  } catch (error) {
    logger.error(`[StickerCommand] Erro ao criar diretórios necessários: ${error.message}`, {
      label: 'StickerCommand.ensureDirectories',
      error: error.stack,
    });
    return false;
  }
}

/**
 * Extrai detalhes da mídia da mensagem
 * @param {object} message - O objeto da mensagem
 * @returns {{mediaType: string, mediaKey: object}|null} - Detalhes da mídia ou null se não encontrada
 */
function extractMediaDetails(message) {
  logger.debug('[StickerCommand] Extraindo detalhes da mídia');

  const messageContent = message.message;

  // Verificar se é uma resposta a outra mensagem
  const quotedMessage = messageContent?.extendedTextMessage?.contextInfo?.quotedMessage;

  // Verificar mídia na mensagem original
  if (messageContent?.imageMessage) {
    return { mediaType: 'image', mediaKey: messageContent.imageMessage };
  } else if (messageContent?.videoMessage) {
    return { mediaType: 'video', mediaKey: messageContent.videoMessage };
  } else if (messageContent?.stickerMessage) {
    return { mediaType: 'sticker', mediaKey: messageContent.stickerMessage };
  } else if (messageContent?.documentMessage) {
    return { mediaType: 'document', mediaKey: messageContent.documentMessage };
  }

  // Verificar mídia na mensagem citada
  if (quotedMessage) {
    if (quotedMessage.imageMessage) {
      return { mediaType: 'image', mediaKey: quotedMessage.imageMessage, isQuoted: true };
    } else if (quotedMessage.videoMessage) {
      return { mediaType: 'video', mediaKey: quotedMessage.videoMessage, isQuoted: true };
    } else if (quotedMessage.stickerMessage) {
      return { mediaType: 'sticker', mediaKey: quotedMessage.stickerMessage, isQuoted: true };
    } else if (quotedMessage.documentMessage) {
      return { mediaType: 'document', mediaKey: quotedMessage.documentMessage, isQuoted: true };
    }
  }

  logger.debug('[StickerCommand] Nenhuma mídia encontrada');
  return null;
}

/**
 * Verifica se o tamanho da mídia é aceitável
 * @param {object} mediaKey - Objeto contendo as informações da mídia
 * @param {string} mediaType - Tipo de mídia
 * @returns {boolean} - true se o tamanho for aceitável
 */
function checkMediaSize(mediaKey, mediaType) {
  const fileLength = mediaKey?.fileLength || 0;
  const maxFileSize = 5 * 1024 * 1024; // 5 MB

  logger.debug(`[StickerCommand] Verificando tamanho da mídia. Tipo: ${mediaType}, Tamanho: ${fileLength} bytes`);

  if (fileLength > maxFileSize) {
    logger.warn(`[StickerCommand] Mídia muito grande. Tipo: ${mediaType}, Tamanho: ${fileLength} bytes`);
    return false;
  }

  return true;
}

/**
 * Obtém informações do pacote de sticker
 * @param {string} text - Texto do comando (pode conter nome do pacote e autor)
 * @param {string} sender - ID do remetente
 * @param {string} pushName - Nome do usuário
 * @returns {Promise<{packName: string, packAuthor: string}>} - Informações do pacote
 */
async function getStickerPackInfo(text, sender, pushName) {
  logger.debug(`[StickerCommand] Obtendo informações do pacote. Texto: "${text}"`);

  const formattedSender = sender.split('@')[0] || 'unknown';
  const prefsPath = path.join(STICKER_PREFS_DIR, `${formattedSender}.json`);

  // Valores padrão
  let defaultPackName = `🤖 OmniZAP`;
  let defaultPackAuthor = `👤 ${pushName || formattedSender}`;

  // Tentar carregar preferências salvas
  let savedPrefs = null;
  try {
    const prefsExists = await fs
      .access(prefsPath)
      .then(() => true)
      .catch(() => false);
    if (prefsExists) {
      const prefsData = await fs.readFile(prefsPath, 'utf-8');
      savedPrefs = JSON.parse(prefsData);
      logger.debug(`[StickerCommand] Preferências carregadas para ${formattedSender}`);
    }
  } catch (error) {
    logger.warn(`[StickerCommand] Erro ao carregar preferências: ${error.message}`);
  }

  // Usar preferências salvas se disponíveis
  if (savedPrefs) {
    defaultPackName = savedPrefs.packName || defaultPackName;
    defaultPackAuthor = savedPrefs.packAuthor || defaultPackAuthor;
  }

  // Se texto foi fornecido, atualiza as preferências
  let packName = defaultPackName;
  let packAuthor = defaultPackAuthor;

  if (text && text.trim()) {
    // Log para diagnóstico da entrada
    logger.debug(`[StickerCommand] Processando texto para pacote: "${text}"`, {
      textOriginal: text,
      textTrimmed: text.trim(),
      containsPipe: text.includes('|'),
    });

    const parts = text
      .trim()
      .split('|')
      .map((part) => part.trim());

    // Log das partes extraídas
    logger.debug(`[StickerCommand] Partes extraídas do texto:`, {
      partsCount: parts.length,
      parts: parts,
    });

    if (parts.length >= 1 && parts[0]) {
      packName = parts[0];
      logger.debug(`[StickerCommand] Definindo nome do pacote: "${packName}" (texto original: "${text}")`);
    }

    if (parts.length >= 2 && parts[1]) {
      packAuthor = parts[1];
      logger.debug(`[StickerCommand] Definindo autor do pacote: "${packAuthor}"`);
    }

    // Salvar novas preferências
    try {
      await fs.writeFile(prefsPath, JSON.stringify({ packName, packAuthor }, null, 2));
      logger.info(`[StickerCommand] Novas preferências salvas para ${formattedSender}`);
    } catch (error) {
      logger.error(`[StickerCommand] Erro ao salvar preferências: ${error.message}`);
    }
  } else {
    logger.debug(`[StickerCommand] Usando preferências padrão: Nome: "${packName}", Autor: "${packAuthor}"`);
  }

  // Processar variáveis especiais nos textos
  packName = packName
    .replace(/#nome/g, pushName || 'Usuário')
    .replace(/#id/g, formattedSender)
    .replace(/#data/g, new Date().toLocaleDateString('pt-BR'));

  packAuthor = packAuthor
    .replace(/#nome/g, pushName || 'Usuário')
    .replace(/#id/g, formattedSender)
    .replace(/#data/g, new Date().toLocaleDateString('pt-BR'));

  logger.debug(`[StickerCommand] Pacote final: Nome: "${packName}", Autor: "${packAuthor}"`);
  return { packName, packAuthor };
}

/**
 * Salva a mídia baixada como arquivo temporário
 * @param {Buffer} buffer - Buffer da mídia
 * @param {string} mediaType - Tipo de mídia
 * @returns {Promise<string>} - Caminho do arquivo salvo
 */
async function saveTempMedia(buffer, mediaType) {
  if (!buffer || !Buffer.isBuffer(buffer)) {
    throw new Error('Buffer inválido ou não fornecido');
  }

  // Definir extensão com base no tipo de mídia
  let extension = '.bin';
  switch (mediaType) {
    case 'image':
      extension = '.jpg';
      break;
    case 'video':
      extension = '.mp4';
      break;
    case 'sticker':
      extension = '.webp';
      break;
    case 'document':
      extension = '.bin';
      break;
  }

  const tempPath = path.join(TEMP_DIR, `media_${Date.now()}${extension}`);
  await fs.writeFile(tempPath, buffer);

  logger.debug(`[StickerCommand] Mídia salva em arquivo temporário: ${tempPath}`);
  return tempPath;
}

/**
 * Converte a mídia para o formato webp (sticker)
 * @param {string} inputPath - Caminho do arquivo de entrada
 * @param {string} mediaType - Tipo de mídia
 * @returns {Promise<string>} - Caminho do sticker
 */
async function convertToWebp(inputPath, mediaType) {
  logger.info(`[StickerCommand] Convertendo mídia para webp. Tipo: ${mediaType}`);

  const outputPath = path.join(TEMP_DIR, `sticker_${Date.now()}.webp`);

  try {
    // Para stickers já em formato webp, apenas copie o arquivo
    if (mediaType === 'sticker') {
      await fs.copyFile(inputPath, outputPath);
      return outputPath;
    }

    // Para outros tipos, use ffmpeg para converter
    const filter = mediaType === 'video' ? 'fps=10,scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:-1:-1:color=white@0.0,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse' : 'scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:-1:-1:color=white@0.0';

    let ffmpegCommand;
    if (mediaType === 'video') {
      // Para vídeos, crie stickers animados
      ffmpegCommand = `ffmpeg -i "${inputPath}" -vf "${filter}" -loop 0 -ss 00:00:00.0 -t 00:00:10.0 -preset default -an -vsync 0 -s 512x512 "${outputPath}"`;
    } else {
      // Para imagens
      ffmpegCommand = `ffmpeg -i "${inputPath}" -vf "${filter}" -f webp -preset default -loop 0 -vsync 0 -s 512x512 "${outputPath}"`;
    }

    logger.debug(`[StickerCommand] Comando ffmpeg: ${ffmpegCommand}`);
    await execProm(ffmpegCommand);

    // Verificar se o arquivo foi criado
    try {
      await fs.access(outputPath);
      logger.info(`[StickerCommand] Conversão bem-sucedida. Sticker salvo em: ${outputPath}`);
      return outputPath;
    } catch (error) {
      throw new Error(`Falha ao criar o arquivo de sticker: ${error.message}`);
    }
  } catch (error) {
    logger.error(`[StickerCommand] Erro na conversão para webp: ${error.message}`, {
      label: 'StickerCommand.convertToWebp',
      error: error.stack,
    });
    throw new Error(`Erro na conversão para webp: ${error.message}`);
  }
}

/**
 * Adiciona metadados ao sticker
 * @param {string} stickerPath - Caminho do arquivo de sticker
 * @param {string} packName - Nome do pacote
 * @param {string} packAuthor - Autor do pacote
 * @returns {Promise<string>} - Caminho do sticker com metadados
 */
async function addStickerMetadata(stickerPath, packName, packAuthor) {
  logger.info(`[StickerCommand] Adicionando metadados ao sticker. Nome: "${packName}", Autor: "${packAuthor}"`);

  try {
    // Criar JSON de metadados
    const exifData = {
      'sticker-pack-id': `com.omnizap.${Date.now()}`,
      'sticker-pack-name': packName,
      'sticker-pack-publisher': packAuthor,
    };

    // Gerar arquivo de metadados EXIF
    const exifPath = path.join(TEMP_DIR, `exif_${Date.now()}.exif`);

    // Construir cabeçalho EXIF e dados
    const exifAttr = Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x41, 0x57, 0x07, 0x00, 0x00, 0x00, 0x00, 0x00, 0x16, 0x00, 0x00, 0x00]);
    const jsonBuffer = Buffer.from(JSON.stringify(exifData), 'utf8');
    const exifBuffer = Buffer.concat([exifAttr, jsonBuffer]);
    exifBuffer.writeUIntLE(jsonBuffer.length, 14, 4);

    await fs.writeFile(exifPath, exifBuffer);

    // Verificar se webpmux está instalado
    try {
      await execProm('which webpmux');
    } catch (error) {
      logger.warn('[StickerCommand] webpmux não encontrado, tentando instalar...');
      try {
        await execProm('apt-get update && apt-get install -y webp');
      } catch (installError) {
        logger.error(`[StickerCommand] Falha ao instalar webpmux: ${installError.message}`);
        throw new Error('webpmux não está instalado e não foi possível instalá-lo');
      }
    }

    // Aplicar metadados com webpmux
    const outputPath = path.join(TEMP_DIR, `final_${Date.now()}.webp`);
    await execProm(`webpmux -set exif "${exifPath}" "${stickerPath}" -o "${outputPath}"`);

    // Limpar arquivo de metadados
    await fs.unlink(exifPath);

    logger.info(`[StickerCommand] Metadados adicionados com sucesso. Sticker final: ${outputPath}`);
    return outputPath;
  } catch (error) {
    logger.error(`[StickerCommand] Erro ao adicionar metadados: ${error.message}`, {
      label: 'StickerCommand.addStickerMetadata',
      error: error.stack,
    });

    // Se falhou, retorne o sticker original
    return stickerPath;
  }
}

/**
 * Processa uma mídia e cria um sticker
 * @param {object} baileysClient - Cliente do Baileys
 * @param {object} message - Mensagem original
 * @param {string} sender - ID do remetente
 * @param {string} from - ID do chat
 * @param {string} text - Texto adicional (para nome do pacote/autor)
 * @returns {Promise<{success: boolean, message: string, stickerPath?: string}>} - Resultado do processamento
 */
async function processSticker(baileysClient, message, sender, from, text) {
  logger.info(`[StickerCommand] Iniciando processamento de sticker para ${sender}`, {
    textParams: text ? `"${text}"` : 'sem texto',
    textLength: text ? text.length : 0,
    hasText: !!text,
    text: text,
    textType: typeof text,
    containsPipe: text ? text.includes('|') : false,
    splitResult: text ? text.split('|').map((part) => part.trim()) : [],
  });

  let tempMediaPath = null;
  let stickerPath = null;
  let finalStickerPath = null;

  try {
    // Garantir que os diretórios existam
    const dirsOk = await ensureDirectories();
    if (!dirsOk) {
      return {
        success: false,
        message: '❌ Erro interno: não foi possível criar os diretórios necessários',
      };
    }

    // Extrair detalhes da mídia
    const mediaDetails = extractMediaDetails(message);
    if (!mediaDetails) {
      return {
        success: false,
        message: '❌ Nenhuma mídia encontrada. Use este comando respondendo a uma mensagem com mídia ou envie uma mídia com o comando.',
      };
    }

    const { mediaType, mediaKey, isQuoted } = mediaDetails;

    // Verificar tamanho da mídia
    if (!checkMediaSize(mediaKey, mediaType)) {
      return {
        success: false,
        message: '❌ A mídia é muito grande. O limite é de 5MB.',
      };
    }

    // Baixar a mídia
    logger.info(`[StickerCommand] Baixando mídia do tipo ${mediaType}...`);
    const buffer = await getFileBuffer(mediaKey, mediaType, {
      maxRetries: 2,
      timeoutMs: 60000, // 60 segundos
      maxSize: 5 * 1024 * 1024, // 5MB
    });

    if (!buffer) {
      return {
        success: false,
        message: '❌ Não foi possível baixar a mídia. Tente novamente mais tarde.',
      };
    }

    // Salvar a mídia em um arquivo temporário
    tempMediaPath = await saveTempMedia(buffer, mediaType);

    // Converter para webp (formato de sticker)
    stickerPath = await convertToWebp(tempMediaPath, mediaType);

    // Obter informações do pacote de stickers
    const { packName, packAuthor } = await getStickerPackInfo(text, sender, message.pushName || 'Usuário');

    // Adicionar metadados ao sticker
    finalStickerPath = await addStickerMetadata(stickerPath, packName, packAuthor);

    return {
      success: true,
      message: '✅ Sticker criado com sucesso!',
      stickerPath: finalStickerPath,
    };
  } catch (error) {
    logger.error(`[StickerCommand] Erro ao processar sticker: ${error.message}`, {
      label: 'StickerCommand.processSticker',
      error: error.stack,
    });

    return {
      success: false,
      message: `❌ Erro ao criar sticker: ${error.message}`,
    };
  } finally {
    // Limpar arquivos temporários (exceto o sticker final)
    try {
      const filesToDelete = [tempMediaPath, stickerPath].filter((file) => file && file !== finalStickerPath);

      for (const file of filesToDelete) {
        if (file) {
          await fs.unlink(file).catch(() => {});
        }
      }
    } catch (error) {
      logger.warn(`[StickerCommand] Erro ao limpar arquivos temporários: ${error.message}`);
    }
  }
}

module.exports = {
  processSticker,
};
