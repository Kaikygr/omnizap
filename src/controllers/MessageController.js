const logger = require('../utils/logs/logger');
const moduleManager = require('../modules/ModuleManager');

// Carrega variáveis de ambiente
require('dotenv').config();

// Obtém o prefixo de comando do .env (padrão: '/')
const COMMAND_PREFIX = process.env.COMMAND_PREFIX || '/';

// Inicializa o gerenciador de módulos
(async () => {
  try {
    await moduleManager.initialize();
  } catch (error) {
    logger.error(`[MessageController] Erro ao inicializar ModuleManager: ${error.message}`, {
      label: 'MessageController.initialization',
      error: error.stack,
    });
  }
})();

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
  return '';
}

/**
 * Processa múltiplas mensagens em lote para maior eficiência
 * @param {Array} messages Array de mensagens para processar
 * @param {object} baileysClient Cliente Baileys para envio de respostas
 * @returns {object} Resultado do processamento em lote
 */
async function processBatchMessages(messages, baileysClient) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return {
      processed: false,
      count: 0,
      status: 'Nenhuma mensagem para processar',
    };
  }

  logger.info(`[MessageController] Processando lote de ${messages.length} mensagens (prefixo: '${COMMAND_PREFIX}')`, {
    label: 'MessageController.processBatchMessages',
    count: messages.length,
    prefix: COMMAND_PREFIX,
  });

  const results = [];
  const commandQueue = [];
  const textExtractionPaths = ['conversation', 'extendedTextMessage.text', 'imageMessage.caption', 'videoMessage.caption', 'documentMessage.caption'];

  // Processa todas as mensagens do lote
  for (const message of messages) {
    const result = await processMessageCore(message, textExtractionPaths);
    results.push(result);

    // Se é um comando válido, adiciona à fila de comandos
    if (result.isCommand && !result.isFromMe && baileysClient) {
      commandQueue.push({
        command: result.command,
        from: result.from,
        messageId: result.messageId,
        message: message,
      });
    }
  }

  // Executa comandos em lote se houverem
  if (commandQueue.length > 0) {
    await executeBatchCommands(commandQueue, baileysClient);
  }

  logger.info(`[MessageController] Lote de ${messages.length} mensagens processado com ${commandQueue.length} comandos`, {
    label: 'MessageController.processBatchMessages',
    messagesProcessed: messages.length,
    commandsExecuted: commandQueue.length,
  });

  return {
    processed: true,
    count: messages.length,
    commandsExecuted: commandQueue.length,
    results,
    status: 'Lote processado com sucesso',
  };
}

/**
 * Processa o núcleo de uma mensagem individual
 * @param {object} message Mensagem a ser processada
 * @param {Array} textExtractionPaths Caminhos para extração de texto
 * @returns {object} Resultado do processamento
 */
async function processMessageCore(message, textExtractionPaths) {
  const from = message.key?.remoteJid;
  const messageId = message.key?.id;
  const instanceId = message.instanceId;
  const isFromMe = message.key?.fromMe || false;
  const mainMessagePart = message.message;

  let commandInputText = _extractTextFromMessageObject(mainMessagePart, textExtractionPaths);

  if (!commandInputText) {
    const quotedMessagePart = mainMessagePart?.extendedTextMessage?.contextInfo?.quotedMessage;
    if (quotedMessagePart) {
      commandInputText = _extractTextFromMessageObject(quotedMessagePart, textExtractionPaths);
    }
  }

  const descriptiveMessageText = message.message?.conversation || message.message?.extendedTextMessage?.text || (message.message?.imageMessage?.caption ? `Imagem: ${message.message.imageMessage.caption}` : message.message?.imageMessage ? 'Imagem (sem legenda)' : message.message?.videoMessage?.caption ? `Vídeo: ${message.message.videoMessage.caption}` : message.message?.videoMessage ? 'Vídeo (sem legenda)' : message.message?.documentMessage?.caption ? `Documento: ${message.message.documentMessage.caption}` : message.message?.documentMessage?.fileName ? `Documento: ${message.message.documentMessage.fileName}` : message.message?.documentMessage ? 'Documento (sem legenda/nome)' : commandInputText ? `(Conteúdo para comando: "${commandInputText}")` : '(Conteúdo não textual ou não identificado)');

  const fullCommand = commandInputText.trim();

  // Verifica se o comando começa com o prefixo definido
  let command = '';
  let isValidCommand = false;

  if (fullCommand.startsWith(COMMAND_PREFIX)) {
    // Remove o prefixo e obtém o comando
    command = fullCommand.substring(COMMAND_PREFIX.length).toLowerCase();
    isValidCommand = Boolean(command && !isFromMe);

    logger.debug(`[MessageController] Comando detectado: '${COMMAND_PREFIX}${command}'`, {
      label: 'MessageController.processMessageCore',
      fullCommand,
      command,
      prefix: COMMAND_PREFIX,
      from,
    });
  } else if (fullCommand) {
    // Log quando há texto mas não é um comando válido
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
    instanceId,
    isFromMe,
    command,
    fullCommand,
    isCommand: isValidCommand,
    hasPrefix: fullCommand.startsWith(COMMAND_PREFIX),
    prefix: COMMAND_PREFIX,
    descriptiveText: descriptiveMessageText,
    originalMessage: message,
  };
}

/**
 * Executa comandos em lote para maior eficiência
 * @param {Array} commandQueue Fila de comandos para executar
 * @param {object} baileysClient Cliente Baileys
 */
async function executeBatchCommands(commandQueue, baileysClient) {
  const commandGroups = {};

  // Agrupa comandos por tipo
  for (const item of commandQueue) {
    if (!commandGroups[item.command]) {
      commandGroups[item.command] = [];
    }
    commandGroups[item.command].push(item);
  }

  // Executa cada grupo de comandos
  for (const [commandType, commands] of Object.entries(commandGroups)) {
    await executeCommandGroup(commandType, commands, baileysClient);
  }
}

/**
 * Executa um grupo específico de comandos usando o sistema modular
 * @param {string} commandType Tipo do comando
 * @param {Array} commands Lista de comandos do mesmo tipo
 * @param {object} baileysClient Cliente Baileys
 */
async function executeCommandGroup(commandType, commands, baileysClient) {
  logger.info(`[MessageController] Executando ${commands.length} comandos do tipo '${commandType}'`, {
    label: 'MessageController.executeCommandGroup',
    commandType,
    count: commands.length,
  });

  // Verifica se existe um módulo para este comando
  if (moduleManager.hasModule(commandType)) {
    await executeModularCommands(commandType, commands, baileysClient);
  } else {
    // Fallback para comandos legados ou não implementados como módulos
    switch (commandType) {
      case 'ping':
        // Redireciona ping para status
        logger.info(`[MessageController] Redirecionando comando '${COMMAND_PREFIX}ping' para '${COMMAND_PREFIX}status'`, {
          label: 'MessageController.executeCommandGroup',
          commandType: 'ping -> status',
          prefix: COMMAND_PREFIX,
        });
        await executeModularCommands('status', commands, baileysClient);
        break;
      default:
        logger.warn(`[MessageController] Comando '${COMMAND_PREFIX}${commandType}' não possui módulo nem handler específico`, {
          label: 'MessageController.executeCommandGroup',
          commandType,
          fullCommand: `${COMMAND_PREFIX}${commandType}`,
          count: commands.length,
          availableModules: moduleManager.listModules().map((m) => m.name),
        });

        // Envia mensagem informando comandos disponíveis
        await sendAvailableCommands(commands, baileysClient);
        break;
    }
  }
}

/**
 * Executa comandos usando o sistema modular
 * @param {string} moduleName Nome do módulo
 * @param {Array} commands Lista de comandos
 * @param {object} baileysClient Cliente Baileys
 */
async function executeModularCommands(moduleName, commands, baileysClient) {
  const promises = commands.map(async (item) => {
    try {
      // Prepara contexto para o módulo
      const context = {
        sender: item.from,
        messageId: item.messageId,
        instanceId: item.message.instanceId,
        isFromMe: item.message.key?.fromMe || false,
        originalMessage: item.message,
      };

      // Executa o módulo
      const moduleResult = await moduleManager.executeModule(moduleName, {}, context);

      // Formata resposta baseada no resultado do módulo
      let responseText;
      if (moduleResult.success) {
        if (moduleName === 'status') {
          responseText = formatStatusResponse(moduleResult.data);
        } else if (moduleName === 'info') {
          responseText = formatInfoResponse(moduleResult.data);
        } else {
          responseText = JSON.stringify(moduleResult.data, null, 2);
        }
      } else {
        responseText = `❌ Erro ao executar comando '${moduleName}': ${moduleResult.error}`;
      }

      // Envia resposta
      await baileysClient.sendMessage(item.from, {
        text: responseText,
      });

      logger.info(`[MessageController] Comando '${moduleName}' executado com sucesso para ${item.from}`, {
        label: 'MessageController.executeModularCommands',
        module: moduleName,
        messageId: item.messageId,
        from: item.from,
        instanceId: item.message.instanceId,
        executionTime: moduleResult.executionTime,
      });

      return { success: true, messageId: item.messageId, from: item.from, module: moduleName };
    } catch (error) {
      logger.error(`[MessageController] Erro ao executar módulo '${moduleName}' para ${item.from}: ${error.message}`, {
        label: 'MessageController.executeModularCommands',
        module: moduleName,
        messageId: item.messageId,
        from: item.from,
        instanceId: item.message.instanceId,
        error: error.stack,
      });

      // Envia mensagem de erro
      try {
        await baileysClient.sendMessage(item.from, {
          text: `❌ Erro interno ao executar comando '${moduleName}'. Tente novamente mais tarde.`,
        });
      } catch (sendError) {
        logger.error(`[MessageController] Erro ao enviar mensagem de erro: ${sendError.message}`, {
          label: 'MessageController.executeModularCommands',
          sendError: sendError.stack,
        });
      }

      return { success: false, messageId: item.messageId, from: item.from, module: moduleName, error: error.message };
    }
  });

  const results = await Promise.allSettled(promises);
  const successful = results.filter((r) => r.status === 'fulfilled' && r.value.success).length;
  const failed = results.length - successful;

  logger.info(`[MessageController] Módulo '${moduleName}' executado: ${successful} sucessos, ${failed} falhas`, {
    label: 'MessageController.executeModularCommands',
    module: moduleName,
    successful,
    failed,
    total: commands.length,
  });
}

/**
 * Formata resposta do módulo de info de forma legível
 * @param {object} infoData Dados de informação
 * @returns {string} Resposta formatada
 */
function formatInfoResponse(infoData) {
  if (!infoData || infoData.error) {
    return `❌ Erro ao obter informações: ${infoData?.details || 'Erro desconhecido'}`;
  }

  const { system, modules, capabilities, support } = infoData;

  let response = `ℹ️ *${system.name} v${system.version}*\n\n`;

  // Descrição
  response += `📝 *Descrição:* ${system.description}\n\n`;

  // Funcionalidades
  if (system.features && system.features.length > 0) {
    response += `✨ *Funcionalidades:*\n`;
    system.features.forEach((feature) => {
      response += `${feature}\n`;
    });
    response += `\n`;
  }

  // Módulos
  if (modules) {
    response += `🧩 *Módulos:* ${modules.total} disponíveis\n`;
    if (modules.available && modules.available.length > 0) {
      modules.available.forEach((module) => {
        response += `• ${module}\n`;
      });
    }
    response += `\n`;
  }

  // Capacidades
  if (capabilities) {
    response += `⚡ *Capacidades:*\n`;
    Object.entries(capabilities).forEach(([key, value]) => {
      const emoji = value ? '✅' : '❌';
      const label = key.replace(/([A-Z])/g, ' $1').toLowerCase();
      response += `${emoji} ${label}\n`;
    });
    response += `\n`;
  }

  // Suporte
  if (support) {
    response += `🆘 *Suporte:*\n`;
    if (support.documentation) {
      response += `📖 Documentação: ${support.documentation}\n`;
    }
    if (support.github) {
      response += `🐙 GitHub: ${support.github}\n`;
    }
    if (support.issues) {
      response += `🐛 Issues: ${support.issues}\n`;
    }
  }

  return response;
}

/**
 * Formata resposta do módulo de status de forma legível
 * @param {object} statusData Dados do status
 * @returns {string} Resposta formatada
 */
function formatStatusResponse(statusData) {
  if (!statusData || statusData.error) {
    return `❌ Erro ao obter status: ${statusData?.details || 'Erro desconhecido'}`;
  }

  const { health, project, system, performance, services, timestamp, uptime } = statusData;

  let response = `🔰 *Status do Sistema Omnizap*\n\n`;

  // Saúde geral
  const healthEmoji = health.score >= 80 ? '🟢' : health.score >= 60 ? '🟡' : '🔴';
  response += `${healthEmoji} *Saúde Geral:* ${health.score}/100 (${health.status})\n`;
  if (health.issues && health.issues.length > 0) {
    response += `⚠️ *Alertas:* ${health.issues.join(', ')}\n`;
  }
  response += `\n`;

  // Informações do projeto
  if (project && !project.error) {
    response += `📦 *Projeto:* ${project.name} v${project.version}\n`;
    response += `⏱️ *Tempo Ativo:* ${uptime}\n`;
    response += `🔧 *PID:* ${project.processId}\n`;
    response += `\n`;
  }

  // Sistema
  if (system) {
    response += `💻 *Sistema:*\n`;
    response += `• Plataforma: ${system.platform} (${system.arch})\n`;
    response += `• Node.js: ${system.nodeVersion}\n`;
    response += `• CPUs: ${system.cpus}\n`;
    response += `• Memória: ${system.freeMemory}/${system.totalMemory}\n`;
    response += `\n`;
  }

  // Performance
  if (performance && performance.memory) {
    response += `⚡ *Performance:*\n`;
    response += `• Heap: ${performance.memory.heapUsed}/${performance.memory.heapTotal}\n`;
    response += `• RSS: ${performance.memory.rss}\n`;
    if (performance.eventLoop) {
      response += `• Event Loop: ${performance.eventLoop.delay}\n`;
    }
    response += `\n`;
  }

  // Serviços
  if (services) {
    const serviceNames = Object.keys(services);
    const loadedServices = serviceNames.filter((name) => services[name].status === 'loaded');
    response += `🔌 *Serviços:* ${loadedServices.length}/${serviceNames.length} ativos\n`;

    if (loadedServices.length < serviceNames.length) {
      const failedServices = serviceNames.filter((name) => services[name].status !== 'loaded');
      response += `❌ *Falhas:* ${failedServices.join(', ')}\n`;
    }
    response += `\n`;
  }

  response += `🕐 *Atualizado em:* ${new Date(timestamp).toLocaleString('pt-BR')}`;

  return response;
}

/**
 * Envia lista de comandos disponíveis
 * @param {Array} commands Lista de comandos
 * @param {object} baileysClient Cliente Baileys
 */
async function sendAvailableCommands(commands, baileysClient) {
  const availableModules = moduleManager.listModules();

  let responseText = `ℹ️ *Comandos Disponíveis:*\n\n`;
  responseText += `🔧 *Prefixo:* Use \`${COMMAND_PREFIX}\` antes do comando\n\n`;

  if (availableModules.length > 0) {
    availableModules.forEach((module) => {
      responseText += `• *${COMMAND_PREFIX}${module.name}* - ${module.info.description || 'Comando do sistema'}\n`;
    });
  } else {
    responseText += `Nenhum comando disponível no momento.`;
  }

  responseText += `\n💡 *Exemplo:* Digite "${COMMAND_PREFIX}status" para ver informações do sistema.`;

  const promises = commands.map(async (item) => {
    try {
      await baileysClient.sendMessage(item.from, {
        text: responseText,
      });

      return { success: true, messageId: item.messageId, from: item.from };
    } catch (error) {
      logger.error(`[MessageController] Erro ao enviar lista de comandos para ${item.from}: ${error.message}`, {
        label: 'MessageController.sendAvailableCommands',
        messageId: item.messageId,
        from: item.from,
        error: error.stack,
      });

      return { success: false, messageId: item.messageId, from: item.from, error: error.message };
    }
  });

  await Promise.allSettled(promises);
}

async function processIncomingMessage(message, baileysClient) {
  logger.info(`[MessageController] Processando mensagem individual ID: ${message.key?.id} de ${message.key?.remoteJid}`, {
    label: 'MessageController.processIncomingMessage',
    messageId: message.key?.id,
    remoteJid: message.key?.remoteJid,
    instanceId: message.instanceId,
  });

  // Processa a mensagem usando o sistema de lote (mesmo para mensagens individuais)
  const result = await processBatchMessages([message], baileysClient);

  logger.info(`[MessageController] Mensagem ID: ${message.key?.id} processada via lote.`, {
    label: 'MessageController.processIncomingMessage',
    messageId: message.key?.id,
    instanceId: message.instanceId,
    batchResult: result,
  });

  return {
    processed: true,
    messageId: message.key?.id,
    status: 'Mensagem processada com sucesso pelo controller.',
    batchResult: result,
  };
}

module.exports = {
  processIncomingMessage,
  processBatchMessages,
  processMessageCore,
  executeBatchCommands,
  executeCommandGroup,
  executeModularCommands,
  formatStatusResponse,
  formatInfoResponse,
  sendAvailableCommands,
};
