[![3DG6WBV.md.png](https://iili.io/3DG6WBV.md.png)](https://freeimage.host/i/3DG6WBV)

# OmniZap

Bot multifuncional para WhatsApp, desenvolvido em JavaScript como um projeto open-source e educacional.

## 📋 Sobre

OmniZap é um bot versátil para WhatsApp que atende tanto usuários pessoais quanto administradores de grupos e pequenas automações empresariais. Desenvolvido com foco em aprendizado e colaboração da comunidade, com suporte a persistência de dados e cache.

## ⚙️ Funcionalidades Principais

- Sistema robusto de gerenciamento de conexão com reconexão automática
- Persistência completa de dados em MySQL
- Sistema de cache com Redis para melhor performance
- Gerenciamento avançado de grupos
- Tratamento de mensagens, recibos e eventos
- Sistema de logs detalhado
- Arquitetura modular e expansível

## 🏗️ Arquitetura

O projeto é composto por três componentes principais:

### ConnectionManager
- Gerencia a conexão WebSocket com o WhatsApp
- Implementa reconexão automática com backoff exponencial
- Gerencia eventos do WhatsApp (mensagens, grupos, contatos)
- Integra com Redis para cache e MySQL para persistência

### MySQLDBManager
- Gerencia todas as operações com o banco de dados MySQL
- Implementa padrão Singleton para conexão
- Gerencia pool de conexões para melhor performance
- Fornece métodos CRUD para todas as entidades:
  - Chats
  - Grupos e Participantes
  - Mensagens e Recibos
  - Contatos

### Sistema de Cache (Redis)
- Cache de metadados com TTL configurável
- Prefixos específicos para cada tipo de dado:
  - `chat:` - Dados de conversas
  - `group:` - Metadados de grupos
  - `contact:` - Informações de contatos
  - `message:` - Mensagens e recibos

## 🗄️ Estrutura do Banco de Dados

### Tabelas MySQL

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
    raw_message_content JSON,
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

## ⚡ Cache Redis

### TTLs Configurados
- `REDIS_TTL_METADATA_SHORT`: 3600s (1 hora) - Metadados de curta duração
- `REDIS_TTL_METADATA_LONG`: 86400s (24 horas) - Metadados de longa duração
- `REDIS_TTL_MESSAGE`: 604800s (7 dias) - Mensagens
- `REDIS_TTL_RECEIPT`: 604800s (7 dias) - Recibos

### Prefixos de Cache
- `chat:` - Dados de conversas
- `group:` - Metadados de grupos
- `contact:` - Informações de contatos
- `message:` - Mensagens e recibos

## 🚀 Começando

### Pré-requisitos

- Node.js v14+
- NPM ou Yarn
- MySQL Server 8.0+
- Redis Server 6.0+

### Configuração do Ambiente

Configure as variáveis de ambiente em um arquivo `.env`:

```env
# MySQL
MYSQL_HOST=localhost
MYSQL_PORT=3306
MYSQL_USER=seu_usuario
MYSQL_PASSWORD=sua_senha
MYSQL_DATABASE_NAME=omnizap_db

# Redis
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=
REDIS_DB=0

# Reconexão
BACKOFF_INITIAL_DELAY_MS=5000
BACKOFF_MAX_DELAY_MS=60000

# Auth State
AUTH_STATE_PATH=./auth_state
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

## 🛠️ Tecnologias

- JavaScript/Node.js
- [Baileys](https://github.com/WhiskeySockets/Baileys) - Framework WhatsApp Web API
- MySQL - Sistema de Banco de Dados
- Redis - Sistema de Cache
- Winston - Sistema de Logs
- Envalid - Validação de variáveis de ambiente
- ioredis - Cliente Redis
- mysql2 - Cliente MySQL

## 📄 Licença

Este projeto está sob a licença MIT - veja o arquivo [LICENSE](LICENSE) para detalhes.

## 🤝 Contribuindo

Contribuições são bem-vindas! Por favor, leia nosso guia de contribuição antes de submeter pull requests.

## 💰 Apoie o Projeto

Se você gostou do projeto e quer apoiar seu desenvolvimento: [Apoiar](https://bit.ly/m/Kaally)

---

🚀 **OmniZap** — Sistema robusto e escalável para automação do WhatsApp

⚠️ **Aviso**: Este é um projeto educacional e não se destina a fins comerciais ou spam.
