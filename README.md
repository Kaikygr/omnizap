[![3DG6WBV.md.png](https://iili.io/3DG6WBV.md.png)](https://freeimage.host/i/3DG6WBV)

Bot multifuncional para WhatsApp, desenvolvido em JavaScript como um projeto open-source e educacional.

## 📋 Sobre

OmniZap é um bot versátil para WhatsApp que atende tanto usuários pessoais quanto administradores de grupos e pequenas automações empresariais. Desenvolvido com foco em aprendizado e colaboração da comunidade, com suporte a persistência de dados e cache.

## ⚙️ Funcionalidades Principais

- Gerenciamento de grupos e automações administrativas
- Download de mídias (áudios, vídeos, imagens, links)
- Integração com APIs externas e webhooks
- Sistema de persistência de dados com MySQL
- Cache de dados com Redis
- Sistema modular e expansível
- Automação de respostas e notificações

## 🚀 Começando

### Pré-requisitos

- Node.js
- NPM ou Yarn
- MySQL Server
- Redis Server

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

# Outros
BACKOFF_INITIAL_DELAY_MS=5000
BACKOFF_MAX_DELAY_MS=60000
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
- Outras dependências listadas no `package.json`

## 🗄️ Estrutura do Banco de Dados

O sistema utiliza MySQL para persistência de dados com as seguintes tabelas:

- `Contacts` - Informações de contatos
- `Chats` - Dados de conversas
- `Groups` - Informações de grupos
- `GroupParticipants` - Participantes dos grupos
- `Messages` - Histórico de mensagens
- `MessageReceipts` - Confirmações de leitura/entrega

## 📦 Cache

Utiliza Redis para cache com os seguintes prefixos:

- `contact:` - Cache de contatos
- `chat:` - Cache de conversas
- `group:` - Cache de grupos
- `message:` - Cache de mensagens

## 📄 Licença

Este projeto está sob a licença MIT - veja o arquivo [LICENSE](LICENSE) para detalhes.

## 🤝 Contribuindo

Contribuições são bem-vindas! Sinta-se à vontade para abrir issues e pull requests.

## 💰 Apoie o Projeto

Se você gostou do projeto e quer apoiar seu desenvolvimento: [Apoiar](https://bit.ly/m/Kaally)

---

🚀 **OmniZap** — Seu WhatsApp sem limites, para aprender, criar e evoluir.

⚠️ **Aviso**: Este é um projeto educacional e não se destina a fins comerciais ou spam.
