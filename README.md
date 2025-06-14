[![3DG6WBV.md.png](https://iili.io/3DG6WBV.md.png)](https://freeimage.host/i/3DG6WBV)

# OmniZap

Bot multifuncional para WhatsApp, desenvolvido em JavaScript como um projeto open-source e educacional.

## 📋 Sobre

OmniZap é um bot versátil para WhatsApp que atende tanto usuários pessoais quanto administradores de grupos e pequenas automações empresariais. Desenvolvido com foco em aprendizado e colaboração da comunidade, com uma arquitetura robusta e performática.

## ⚙️ Funcionalidades Principais

- Sistema robusto de gerenciamento de conexão com reconexão automática
- Processamento de dados em lote para alta performance
- Cache em memória para acesso rápido a dados frequentes
- Persistência completa de dados com suporte a operações em lote
- Gerenciamento avançado de grupos e mensagens
- Sistema de monitoramento e métricas detalhado
- Arquitetura modular e expansível
- Suporte a múltiplas instâncias via INSTANCE_ID
- Gerenciamento automatizado de processos zumbis
- Monitoramento de recursos do sistema (CPU, memória, disco)

## 🏗️ Componentes Principais

### ConnectionManager
Gerencia toda a comunicação com a API do WhatsApp Web:
- Conexão WebSocket robusta com reconexão automática
- Autenticação via QR Code com monitoramento de estado
- Tratamento centralizado de eventos do WhatsApp
- Backoff exponencial para tentativas de reconexão
- Emissão de eventos para outros componentes do sistema

### BatchProcessor
Motor de processamento em lote altamente otimizado:
- Agrupamento de operações semelhantes para processamento eficiente
- Flush automático baseado em tamanho ou intervalo de tempo
- Priorização de tipos de dados para processamento
- Estatísticas detalhadas de performance
- Mecanismo de retry com delay exponencial

### DataManager
Gerenciamento de dados em memória com alta performance:
- Cache em memória para acesso rápido a dados frequentes
- Estruturas de dados otimizadas para diferentes entidades
- Processamento em lote de atualizações
- Minimiza necessidade de banco de dados para operações frequentes
- Rastreamento de estatísticas de processamento

### MessageController
Processamento inteligente de mensagens e comandos:
- Extração de texto de diferentes tipos de mensagem
- Detecção de comandos via prefixo configurável
- Processamento em lote para maior eficiência
- Suporte a diferentes tipos de mensagem (texto, mídia, botões, etc.)
- Gerenciamento de filas de comandos

### PerformanceMonitor
Monitoramento detalhado de performance do sistema:
- Métricas de tempo de processamento
- Contadores de operações por tipo
- Taxas de sucesso/falha
- Alertas para gargalos de performance
- Relatórios periódicos de estatísticas

## 🏗️ Arquitetura

O projeto é composto por vários componentes principais:

### ConnectionManager
- Gerencia a conexão WebSocket com o WhatsApp
- Implementa reconexão automática com backoff exponencial
- Sistema avançado de logging e métricas
- Suporte a processamento em lote de mensagens e eventos
- EventEmitter customizado para comunicação entre módulos
- Gerenciamento automático de autenticação com QR Code

### DataManager
- Gerencia operações de dados com processamento otimizado em memória
- Implementa cache eficiente para dados frequentemente acessados
- Suporte a operações em lote para melhor performance
- Mantém estado em memória minimizando necessidade de banco de dados
- Gerencia entidades como mensagens, chats, grupos e contatos

### BatchProcessor e BatchManager
- Sistema centralizado de processamento em lote
- Buffers otimizados para diferentes tipos de dados
- Configurações personalizáveis por tipo de dado
- Mecanismo de flush automático por intervalo ou tamanho do lote
- Estatísticas detalhadas de performance

### MessageController
- Processa e gerencia mensagens recebidas
- Filtra e identifica comandos com prefixo configurável
- Processamento em lote para maior eficiência
- Extrai texto de diferentes tipos de mensagem
- Implementa handlers para diferentes comandos

### DatabaseManager
- Gerencia todas as operações com o banco de dados
- Implementa padrão Singleton para conexão
- Suporte a operações em lote para melhor performance
- Pool de conexões otimizado
- Transações atômicas para operações críticas
- Validação de dados e tratamento de erros robusto

## 🗄️ Estrutura do Banco de Dados

> **Nota**: As estruturas SQL apresentadas são compatíveis com MySQL e PostgreSQL. Para SQLite, algumas adaptações podem ser necessárias (como usar INTEGER ao invés de BIGINT).

### Tabelas Principais

#### Chats
```sql
CREATE TABLE Chats (
    jid VARCHAR(255) PRIMARY KEY,
    name VARCHAR(255),
    unread_count INT DEFAULT 0,
    last_message_timestamp BIGINT,
    is_group BOOLEAN DEFAULT 0,
    pinned_timestamp BIGINT DEFAULT 0,
    mute_until_timestamp BIGINT DEFAULT 0,
    archived BOOLEAN DEFAULT 0,
    ephemeral_duration INT,
    created_at BIGINT,
    updated_at BIGINT
);
```

#### Groups
```sql
CREATE TABLE Groups (
    jid VARCHAR(255) PRIMARY KEY,
    subject VARCHAR(255),
    owner_jid VARCHAR(255),
    creation_timestamp BIGINT,
    description TEXT,
    restrict_mode BOOLEAN DEFAULT 0,
    announce_mode BOOLEAN DEFAULT 0,
    img_url TEXT,
    created_at BIGINT,
    updated_at BIGINT,
    FOREIGN KEY (jid) REFERENCES Chats(jid) ON DELETE CASCADE
);
```

#### GroupParticipants
```sql
CREATE TABLE GroupParticipants (
    group_jid VARCHAR(255) NOT NULL,
    participant_jid VARCHAR(255) NOT NULL,
    admin_status VARCHAR(50),
    PRIMARY KEY (group_jid, participant_jid),
    FOREIGN KEY (group_jid) REFERENCES Groups(jid) ON DELETE CASCADE
);
```

#### Messages
```sql
CREATE TABLE Messages (
    message_id VARCHAR(255) NOT NULL,
    chat_jid VARCHAR(255) NOT NULL,
    sender_jid VARCHAR(255),
    from_me BOOLEAN NOT NULL,
    message_timestamp BIGINT NOT NULL,
    push_name VARCHAR(255),
    message_type VARCHAR(50),
    quoted_message_id VARCHAR(255),
    quoted_message_sender_jid VARCHAR(255),
    raw_message_content TEXT,  -- JSON format
    created_at BIGINT,
    updated_at BIGINT,
    PRIMARY KEY (message_id, chat_jid),
    INDEX idx_messages_chat_timestamp (chat_jid, message_timestamp),
    INDEX idx_messages_sender (sender_jid),
    FOREIGN KEY (chat_jid) REFERENCES Chats(jid) ON DELETE CASCADE
);
```

#### MessageReceipts
```sql
CREATE TABLE MessageReceipts (
    message_id VARCHAR(255) NOT NULL,
    chat_jid VARCHAR(255) NOT NULL,
    recipient_jid VARCHAR(255) NOT NULL,
    receipt_type VARCHAR(50) NOT NULL,
    receipt_timestamp BIGINT NOT NULL,
    PRIMARY KEY (message_id, chat_jid, recipient_jid, receipt_type),
    FOREIGN KEY (message_id, chat_jid) REFERENCES Messages(message_id, chat_jid) ON DELETE CASCADE
);
```

## 🎯 Sistema de Eventos

### Eventos Principais

#### Conexão
- `connection.update` - Atualizações de estado da conexão
- `creds.update` - Atualizações de credenciais

#### Mensagens
- `messages.upsert` - Novas mensagens/atualizações
- `messages.update` - Atualizações de status
- `messages.delete` - Exclusão de mensagens
- `messages.reaction` - Reações em mensagens
- `message-receipt.update` - Recibos de mensagem

#### Grupos
- `groups.update` - Atualizações de metadados
- `groups.upsert` - Novos grupos
- `group-participants.update` - Mudanças de participantes

#### Chats e Contatos
- `chats.upsert` - Novos chats
- `chats.update` - Atualizações de chat
- `chats.delete` - Exclusão de chats
- `contacts.upsert` - Novos contatos
- `contacts.update` - Atualizações de contato

#### Outros
- `blocklist.set` - Lista de bloqueio
- `blocklist.update` - Atualizações de bloqueio
- `call` - Chamadas de voz/vídeo
- `presence.update` - Status de presença

### Fluxo de Dados
1. Evento recebido do WhatsApp
2. Processamento pelo handler específico
3. Persistência no banco de dados (se aplicável)
4. Emissão de eventos customizados para subscribers

### Monitoramento e Logs

- Sistema de métricas detalhado para todas as operações
- Logging estruturado com níveis e contextos
- Rastreamento de instâncias via INSTANCE_ID
- Monitoramento de performance de operações em lote
- Alertas para erros críticos e reconexões
- Métricas de sucesso/falha para operações de processamento
- Rotação e compressão automática de logs antigos
- Verificação proativa de recursos do sistema

## 🚀 Começando

### Pré-requisitos

- Node.js v14+
- NPM ou Yarn
- Banco de dados compatível (MySQL 8.0+, PostgreSQL, SQLite)

### Configuração do Ambiente

Configure as variáveis de ambiente em um arquivo `.env`:

```env
# === Identificação da Instância ===
SYSTEM_NAME=omnizap                    # Nome do sistema (usado pelo PM2)
INSTANCE_ID=omnizap-instance-01        # ID único da instância para logs

# === Configuração do Banco de Dados ===
DB_HOST=localhost
DB_PORT=3306
DB_USER=seu_usuario
DB_PASSWORD=sua_senha
DB_NAME=omnizap_db
DB_TYPE=mysql                          # mysql, postgresql, sqlite

# === Sistema de Reconexão ===
BACKOFF_INITIAL_DELAY_MS=5000          # Delay inicial para reconexão (5s)
BACKOFF_MAX_DELAY_MS=60000             # Delay máximo para reconexão (60s)

# === Autenticação WhatsApp ===
AUTH_STATE_PATH=./temp/auth_state_minimal   # Diretório para credenciais

# === Configurações Opcionais ===
NODE_ENV=production                    # Ambiente de execução
LOG_LEVEL=info                        # Nível de log (debug, info, warn, error)

# === Sistema de Processamento em Lote ===
BATCH_SIZE=30                           # Tamanho do lote para processamento
BATCH_FLUSH_INTERVAL=3000               # Intervalo de flush automático (ms)
BATCH_MAX_RETRIES=3                     # Máximo de tentativas em caso de erro
BATCH_RETRY_DELAY=1000                  # Delay entre tentativas (ms)

# === Sistema de Cache ===
CACHE_TTL=300000                        # Tempo de vida do cache (5 min)
CACHE_MAX_SIZE=10000                    # Máximo de entradas no cache
CACHE_CLEANUP_INTERVAL=60000            # Intervalo de limpeza (1 min)

# === Sistema de Gerenciamento de Zumbis ===
ZOMBIE_CLEANUP_RETRIES=3                # Tentativas de limpeza de processos zumbis
ZOMBIE_CLEANUP_WAIT=2                   # Espera entre tentativas (segundos)
```

#### Estrutura dos Ambientes PM2

O arquivo `ecosystem.config.js` suporta múltiplos ambientes:

```javascript
// Ambientes disponíveis
env: {                    // Desenvolvimento (padrão)
  NODE_ENV: 'development',
  INSTANCE_ID: `${SYSTEM_NAME}-dev`
},
env_test: {              // Testes
  NODE_ENV: 'test', 
  INSTANCE_ID: `${SYSTEM_NAME}-test`
},
env_staging: {           // Homologação
  NODE_ENV: 'staging',
  INSTANCE_ID: `${SYSTEM_NAME}-staging`
},
env_production: {        // Produção
  NODE_ENV: 'production',
  INSTANCE_ID: `${SYSTEM_NAME}-prod`
}
```

### Instalação

```bash
# Clone o repositório
git clone https://github.com/Kaikygr/OmniZap.git

# Entre no diretório
cd OmniZap

# Instale as dependências
npm install

# Inicie o bot
npm start
```

### 🚦 Executando o Projeto

O OmniZap utiliza um sistema automatizado de execução com PM2, gerenciado pelo script `start-omnizap.sh`:

#### Primeira Execução (Autenticação)
```bash
# Inicia o bot e gera QR Code para autenticação
npm start

# O script automaticamente:
# 1. Verifica dependências (Node.js e PM2)
# 2. Carrega variáveis do arquivo .env
# 3. Limpa processos zumbis relacionados
# 4. Verifica conectividade com internet
# 5. Gerencia arquivos de log (rotação e compressão)
# 6. Monitora recursos do sistema (CPU, memória, disco)
# 7. Gera e exibe o QR Code para autenticação
# 8. Aguarda até 300 segundos pela autenticação
# 9. Inicia automaticamente com PM2 após autenticação bem-sucedida
```

#### Ambientes de Execução
```bash
# Desenvolvimento - Carrega env.development do ecosystem.config.js
npm run dev

# Produção - Carrega env.production do ecosystem.config.js  
npm start
```

#### Gerenciamento com PM2
```bash
# Para a aplicação
npm run stop

# Reinicia a aplicação
npm run restart

# Remove do gerenciamento PM2
npm run delete

# Visualiza logs em tempo real
npm run logs

# Status da aplicação
pm2 status
```

#### Configuração Dinâmica

O sistema suporta múltiplas instâncias através da variável `SYSTEM_NAME`:

```bash
# .env
SYSTEM_NAME=omnizap-dev  # Nome personalizado da instância PM2
INSTANCE_ID=omnizap-dev-001  # Identificador único da instância
```

#### Processo de Autenticação

1. **Verificação de Credenciais**: O script verifica a existência do arquivo `creds.json` no diretório configurado em `AUTH_STATE_PATH`
2. **Geração do QR Code**: Se não encontrar credenciais válidas, gera e exibe o QR Code no terminal
3. **Aguarda Autenticação**: Monitora com spinner animado até 300 segundos pela autenticação
4. **Flag de Sucesso**: Cria um arquivo `.auth_success_flag` no diretório de autenticação quando bem-sucedida
5. **Início Automático**: Após autenticação, inicia automaticamente com PM2 no ambiente especificado
6. **Reutilização**: Nas próximas execuções, usa as credenciais salvas automaticamente

> **Localização das Credenciais**: Armazenadas em `AUTH_STATE_PATH` (configurado no .env)  
> **Flag de Controle**: `<AUTH_STATE_PATH>/.auth_success_flag` para comunicação entre processos

#### Logs e Monitoramento
```bash
# Logs em tempo real
npm run logs

# Logs específicos por tipo
tail -f logs/connection-combined.log  # Logs combinados da conexão
tail -f logs/connection-error.log     # Apenas erros
tail -f logs/connection-out.log       # Saída padrão

# Logs da aplicação com rotação diária
tail -f logs/application-$(date +%Y-%m-%d).log
tail -f logs/error-$(date +%Y-%m-%d).log
tail -f logs/warn-$(date +%Y-%m-%d).log
```

### 🔄 Sistema de Inicialização

O OmniZap utiliza um processo robusto e automatizado de inicialização:

#### 1. Pré-inicialização
- **Verificação de Dependências**: Valida Node.js e PM2
- **Carregamento de Configurações**: Lê variáveis do arquivo `.env`
- **Validação de Ambiente**: Verifica configurações essenciais
- **Preparação de Diretórios**: Cria estrutura de pastas necessárias

#### 2. Gerenciamento de Autenticação
- **Verificação de Credenciais**: Busca por `creds.json` existente
- **Processo de QR Code**: Geração automática se necessário
- **Monitoramento de Status**: Aguarda autenticação com feedback visual
- **Controle de Timeout**: Encerra após 300 segundos se não autenticado
- **Gestão de Processos**: Encerramento gracioso de processos temporários

#### 3. Inicialização do Banco de Dados
- **Verificação de Conectividade**: Testa conexão com banco de dados
- **Criação de Schema**: Inicializa banco de dados se necessário
- **Criação de Tabelas**: Configura estrutura completa automaticamente
- **Validação de Integridade**: Verifica foreign keys e indexes
- **Pool de Conexões**: Estabelece pool otimizado para performance

#### 4. Configuração do Connection Manager
- **Carregamento de Estado**: Inicializa estado de autenticação
- **Configuração de Socket**: Estabelece conexão WebSocket com WhatsApp
- **Sistema de Eventos**: Registra todos os handlers de eventos
- **Reconexão Automática**: Configura sistema de backoff exponencial
- **Monitoramento**: Ativa logging estruturado e métricas

#### 5. Ativação do Sistema PM2
- **Detecção de Processo**: Verifica se já existe instância PM2
- **Escolha de Ação**: Decide entre start ou restart baseado no estado
- **Aplicação de Ambiente**: Carrega configurações do ambiente especificado
- **Monitoramento Ativo**: Ativa supervisão e restart automático
- **Logging Configurado**: Direciona logs para arquivos específicos

#### 6. Pós-inicialização
- **Sincronização Inicial**: Carrega histórico e estado atual do WhatsApp
- **Ativação de Handlers**: Processa eventos pendentes
- **Sistema de Métricas**: Inicia coleta de estatísticas
- **Estado Operacional**: Confirma sistema totalmente funcional

#### Fluxo de Recuperação de Erros
- **Falhas de Conexão**: Reconexão automática com backoff exponencial
- **Problemas de Banco**: Tentativas de reconexão com pool alternativo
- **Erros de Autenticação**: Reset automático de credenciais
- **Falhas de Sistema**: Restart automático via PM2
- **Logging Completo**: Rastreamento detalhado para diagnóstico

### Script de Inicialização

O script `start-omnizap.sh` gerencia todo o processo de inicialização:

```bash
# Verificar e limpar processos zumbis relacionados ao OmniZap
cleanup_zombie_processes() {
    # ...identifica e limpa processos zumbis de execuções anteriores
}

# Função para verificar o uso de recursos e desempenho do sistema
check_system_resources() {
    # ...monitora CPU, memória e disco antes da inicialização
}

# Função para verificar conectividade com internet
check_internet_connectivity() {
    # ...testa conectividade com servidores essenciais
}

# Função para limpeza e rotação de logs antigos
manage_log_files() {
    # ...gerencia rotação e compressão de logs
}
```

Este script fornece:
- Verificação de dependências e ambiente
- Limpeza de processos zumbis anteriores
- Monitoramento de recursos do sistema
- Verificação de conectividade com internet
- Gerenciamento de arquivos de log
- Processo de autenticação automatizado
- Integração com PM2 para produção

## 📊 Status do Projeto

- ✅ **Conexão robusta** com WhatsApp Web API
- ✅ **Processamento em lote** de alta performance
- ✅ **Cache em memória** para dados frequentes
- ✅ **Sistema de logs** estruturado com rotação
- ✅ **Reconexão automática** com backoff exponencial
- ✅ **Gerenciamento PM2** completo
- ✅ **Suporte a múltiplas instâncias**
- ✅ **Limpeza de processos zumbis**
- ✅ **Monitoramento de recursos do sistema**
- 🔄 **Comandos de bot** (em desenvolvimento)
- 🔄 **Interface web** (planejado)
- 🔄 **API REST** (planejado)

## 🛠️ Tecnologias

- **JavaScript/Node.js** - Runtime e linguagem principal
- **[Baileys](https://github.com/WhiskeySockets/Baileys)** - Framework WhatsApp Web API
- **Estruturas em Memória** - Armazenamento otimizado para dados frequentemente acessados
- **BatchProcessor** - Sistema customizado de processamento em lote
- **Winston** - Sistema de logs estruturado com rotação diária
- **PM2** - Gerenciador de processos para produção
- **Envalid** - Validação robusta de variáveis de ambiente
- **MemoryCache** - Implementação de cache em memória com TTL
- **Pino** - Logger de alta performance para debugging
- **QRCode Terminal** - Geração de QR codes no terminal

## 🔧 Configurações Avançadas

### PM2 Ecosystem

O arquivo `ecosystem.config.js` oferece configurações robustas:

```javascript
module.exports = {
  apps: [{
    name: SYSTEM_NAME,
    script: './src/connection/index.js',
    
    // Configurações de execução
    exec_mode: 'fork',
    instances: 1,
    max_memory_restart: '1G',
    autorestart: true,
    min_uptime: '60s',
    max_restarts: 5,
    restart_delay: 5000,
    
    // Logs estruturados
    error_file: './logs/connection-error.log',
    out_file: './logs/connection-out.log',
    log_file: './logs/connection-combined.log',
    merge_logs: true,
    
    // Ambientes múltiplos
    env_development: { NODE_ENV: 'development' },
    env_production: { NODE_ENV: 'production' }
  }]
};
```

### Sistema de Processamento em Lote

O arquivo `batchConfig.js` oferece configurações detalhadas para o processamento em lote:

```javascript
const batchConfig = {
  // Configurações do BatchManager principal
  batchManager: {
    batchSize: 30,               // Tamanho do lote para processamento
    flushInterval: 3000,         // Intervalo em ms para flush automático
    maxRetries: 3,               // Máximo de tentativas em caso de erro
    retryDelay: 1000,            // Delay entre tentativas (ms)
  },
  
  // Configurações do DataManager
  dataManager: {
    batchSize: 50,               // Tamanho do lote para operações de dados
    flushInterval: 5000,         // Intervalo em ms para flush automático
    cacheTTL: 300000,            // TTL do cache (5 minutos)
    cacheMaxSize: 10000,         // Máximo de entradas no cache
    cleanupInterval: 60000,      // Intervalo de limpeza do cache (1 minuto)
  },
  
  // Tipos de dados para processamento
  dataTypes: {
    messages: {
      priority: 1,               // Alta prioridade
      batchSize: 30,
      flushInterval: 2000,
    },
    // ...outros tipos de dados...
  },
};
```

### Estrutura de Logs

O sistema implementa logging avançado com rotação automática:

```
logs/
├── connection-combined.log     # Logs combinados da conexão
├── connection-error.log        # Apenas erros de conexão
├── connection-out.log          # Saída padrão da conexão
├── application-YYYY-MM-DD.log  # Logs da aplicação (rotação diária)
├── error-YYYY-MM-DD.log        # Erros gerais (rotação diária)
└── warn-YYYY-MM-DD.log         # Avisos (rotação diária)
```

### Performance e Monitoramento

- **Pool de Conexões**: Otimizado para alta concorrência
- **Operações em Lote**: Processamento eficiente de múltiplos eventos
- **Backoff Exponencial**: Sistema inteligente de reconexão
- **Métricas Detalhadas**: Rastreamento completo de performance
- **Memory Management**: Restart automático em caso de vazamentos

## 🚨 Troubleshooting

### Problemas Comuns

#### 1. Erro de Autenticação
```bash
# Limpe o estado de autenticação
rm -rf ./temp/auth_state_minimal/*
npm start  # Gere novo QR Code
```

#### 2. Problemas de Conexão com Banco de Dados
```bash
# Verifique as configurações no .env
# Teste a conexão manualmente conforme o tipo de banco
# Para MySQL:
mysql -h $DB_HOST -P $DB_PORT -u $DB_USER -p
# Para PostgreSQL:
psql -h $DB_HOST -p $DB_PORT -U $DB_USER -d $DB_NAME
```

#### 3. PM2 não Responde
```bash
# Reset completo do PM2
pm2 kill
pm2 resurrect
npm start
```

#### 4. Logs Muito Verbosos
```bash
# Ajuste o nível de log no .env
LOG_LEVEL=warn  # ou error para menos verbosidade
```

#### 5. Processos Zumbis Persistentes
```bash
# Execute limpeza manual de processos zumbis
ps axo pid,ppid,state,cmd | grep -i "node.*omni" | grep -E "Z|defunct"
# Para cada PID de processo zumbi encontrado:
kill -SIGCHLD <PID_DO_PROCESSO_PAI>
# Em casos extremos:
kill -9 <PID_DO_ZUMBI>
```

#### 6. Problema de Desempenho
```bash
# Ajuste as configurações de batch no .env
BATCH_SIZE=20  # Diminua para menor uso de memória
CACHE_TTL=180000  # Reduza o tempo de vida do cache (3 min)
CACHE_MAX_SIZE=5000  # Limite o tamanho máximo do cache
```

### Comandos Úteis
```bash
# Verificar e limpar processos zumbis
ps axo pid,ppid,state,cmd | grep -i "node.*omni" | grep -E "Z|defunct"

# Verificar uso de recursos
top -b -n 1 | head -20

# Verificar espaço em disco
df -h

# Verificar tamanho dos logs
du -sh ./logs

# Compactar logs antigos manualmente
find ./logs -type f -name "*.log" -mtime +7 -exec gzip {} \;

# Limpar logs mais antigos que 30 dias
find ./logs -type f -name "*.log*" -mtime +30 -delete

# Monitorar performance do sistema em tempo real
pm2 monit

# Analisar logs de erro rapidamente
grep -n "ERROR" ./logs/connection-error.log | tail -50
```

## 🔐 Segurança

- **Credenciais**: Nunca commite arquivos `.env` ou credenciais
- **Auth State**: O diretório de autenticação deve ser ignorado no git
- **Logs**: Logs podem conter informações sensíveis - configure rotação adequada
- **Processos Zumbis**: Limpeza automática de processos zumbis para evitar exposição de memória
- **Validação de Dados**: Sanitização robusta para prevenir injeção
- **Monitoramento de Recursos**: Alertas para condições de alto uso de recursos

