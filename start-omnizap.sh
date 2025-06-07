#!/bin/bash

# Configurações de cores
RESET='\033[0m'
BOLD='\033[1m'
BRIGHT_RED='\033[0;91m'
BRIGHT_GREEN='\033[0;92m'
BRIGHT_YELLOW='\033[0;93m'
BRIGHT_BLUE='\033[0;94m'
BRIGHT_MAGENTA='\033[0;95m'
BRIGHT_CYAN='\033[0;96m'
WHITE='\033[0;97m'

# Configuração de diretório e ambiente
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" &>/dev/null && pwd)
cd "$SCRIPT_DIR"

# Carrega variáveis do .env
if [ -f ".env" ]; then
    source .env
fi

# Define ambiente alvo
TARGET_ENV="production"
if [ "$1" == "development" ]; then
    TARGET_ENV="development"
elif [ "$1" == "production" ]; then
    TARGET_ENV="production"
fi

# Define nome do sistema a partir do .env ou usa padrão
SYSTEM_NAME=${SYSTEM_NAME:-omnizap}
PM2_APP_NAME="$SYSTEM_NAME"

echo -e "${BOLD}${BRIGHT_MAGENTA}OmniZap - Sistema: ${BRIGHT_CYAN}$SYSTEM_NAME${BRIGHT_MAGENTA} | Ambiente: ${BRIGHT_CYAN}$TARGET_ENV${RESET}"

# Função para extrair variáveis do .env
get_env_var() {
    local var_name="$1"
    local env_file=".env"
    if [ -f "$env_file" ]; then
        VAR_VALUE=$(grep -E "^\s*${var_name}\s*=" "$env_file" | head -1 | sed -e 's/#.*//' -e 's/^\s*//' -e 's/\s*$//' -e "s/${var_name}=//")
        VAR_VALUE=$(echo "$VAR_VALUE" | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//")
        echo "$VAR_VALUE"
    else
        echo ""
    fi
}

# Configuração de caminhos de autenticação
AUTH_STATE_PATH_FROM_ENV=$(get_env_var AUTH_STATE_PATH)

if [ -z "$AUTH_STATE_PATH_FROM_ENV" ]; then
    echo -e "${BOLD}${BRIGHT_RED}Erro: AUTH_STATE_PATH não encontrado no arquivo .env.${RESET}"
    AUTH_STATE_PATH_FROM_ENV="./temp/auth_state_minimal"
    echo -e "${BRIGHT_YELLOW}Usando caminho padrão: ${WHITE}$AUTH_STATE_PATH_FROM_ENV${RESET}"
fi

AUTH_STATE_DIR_NAME=$(echo "$AUTH_STATE_PATH_FROM_ENV" | sed 's|^\./||')
PROJECT_ROOT=$(pwd)
AUTH_STATE_FULL_PATH="$PROJECT_ROOT/$AUTH_STATE_DIR_NAME"
AUTH_CREDS_FILE="$AUTH_STATE_FULL_PATH/creds.json"
AUTH_SUCCESS_FLAG_FILE="$AUTH_STATE_FULL_PATH/.auth_success_flag"

# Verificações de dependências
if ! command -v pm2 &> /dev/null; then
    echo -e "${BOLD}${BRIGHT_RED}PM2 não encontrado. Instale com: ${BRIGHT_YELLOW}npm install -g pm2${RESET}"
    exit 1
fi

if ! command -v node &> /dev/null; then
    echo -e "${BOLD}${BRIGHT_RED}Node.js não encontrado. Por favor, instale-o.${RESET}"
    exit 1
fi

echo -e "${BRIGHT_BLUE}Verificando autenticação em: ${WHITE}$AUTH_CREDS_FILE${RESET}"

# Limpeza de flags antigas
if [ -f "$AUTH_SUCCESS_FLAG_FILE" ]; then
    echo -e "${BRIGHT_YELLOW}Removendo flag de autenticação anterior.${RESET}"
    rm -f "$AUTH_SUCCESS_FLAG_FILE"
fi

# Processo de autenticação
if [ ! -d "$AUTH_STATE_FULL_PATH" ] || [ ! -f "$AUTH_CREDS_FILE" ]; then
    echo -e "${BRIGHT_YELLOW}Credenciais não encontradas. Iniciando processo de autenticação...${RESET}"
    echo -e "${BRIGHT_GREEN}Iniciando OmniZap para escaneamento do QR Code...${RESET}"
    echo -e "${BRIGHT_CYAN}Escaneie o QR Code com o WhatsApp.${RESET}"
    echo -e "${BRIGHT_CYAN}A aplicação iniciará com PM2 após autenticação.${RESET}"

    # Cria diretório se necessário
    if [ ! -d "$AUTH_STATE_FULL_PATH" ]; then
        echo -e "${BRIGHT_BLUE}Criando diretório: ${WHITE}$AUTH_STATE_FULL_PATH${RESET}"
        mkdir -p "$AUTH_STATE_FULL_PATH"
    fi
    
    # Inicia processo temporário
    node src/connection/index.js &
    NODE_PID=$!

    # Aguarda autenticação com spinner
    SPINNER_CHARS=("◐" "◓" "◑" "◒")
    SPINNER_INDEX=0
    echo -e "${BRIGHT_YELLOW}Aguardando autenticação (flag: ${WHITE}$AUTH_SUCCESS_FLAG_FILE${BRIGHT_YELLOW})...${RESET}"
    TIMEOUT_SECONDS=300
    ELAPSED_SECONDS=0

    while [ ! -f "$AUTH_SUCCESS_FLAG_FILE" ]; do
        printf "\r${BRIGHT_YELLOW}Aguardando autenticação ${SPINNER_CHARS[$SPINNER_INDEX]} ${RESET}(${ELAPSED_SECONDS}s/${TIMEOUT_SECONDS}s) "
        SPINNER_INDEX=$(((SPINNER_INDEX + 1) % ${#SPINNER_CHARS[@]}))

        sleep 1 
        ELAPSED_SECONDS=$((ELAPSED_SECONDS + 1))

        # Verifica timeout
        if [ "$ELAPSED_SECONDS" -ge "$TIMEOUT_SECONDS" ]; then
            printf "\r\033[K" 
            echo -e "${BOLD}${BRIGHT_RED}Timeout (${TIMEOUT_SECONDS}s) aguardando autenticação.${RESET}"
            echo -e "${BRIGHT_YELLOW}Encerrando processo QR Code (PID: ${WHITE}$NODE_PID${BRIGHT_YELLOW}).${RESET}"
            kill $NODE_PID
            wait $NODE_PID 2>/dev/null
            echo -e "${BOLD}${BRIGHT_RED}Tente executar novamente.${RESET}"
            exit 1
        fi
        
        # Verifica se processo ainda está rodando
        if ! ps -p $NODE_PID > /dev/null; then
            printf "\r\033[K" 
            echo -e "${BOLD}${BRIGHT_RED}Processo QR Code (PID: ${WHITE}$NODE_PID${BRIGHT_RED}) encerrou inesperadamente.${RESET}"
            echo -e "${BRIGHT_YELLOW}Verifique os logs e tente novamente.${RESET}"
            if [ -f "$AUTH_CREDS_FILE" ]; then
                 echo -e "${BRIGHT_GREEN}Credenciais ${WHITE}$AUTH_CREDS_FILE${BRIGHT_GREEN} encontradas. Autenticação assumida como bem-sucedida.${RESET}"
                 break
            fi
            exit 1
        fi
    done
    printf "\r\033[K"
    echo -e "${BOLD}${BRIGHT_GREEN}Autenticação bem-sucedida!${RESET}"

    # Para processo temporário graciosamente
    echo -e "${BRIGHT_YELLOW}Parando processo temporário (PID: ${WHITE}$NODE_PID${BRIGHT_YELLOW})...${RESET}"
    kill $NODE_PID
    
    WAIT_PID_TIMEOUT=10
    for i in $(seq 1 $WAIT_PID_TIMEOUT); do
        if ! ps -p $NODE_PID > /dev/null; then
            break
        fi
        if [ $i -eq 1 ]; then
            echo -e "${BRIGHT_CYAN}Enviado SIGTERM para ${WHITE}$NODE_PID${BRIGHT_CYAN}.${RESET}"
        fi
        sleep 1
    done

    # Força encerramento se necessário
    if ps -p $NODE_PID > /dev/null; then
        echo -e "${BOLD}${BRIGHT_RED}Processo ${WHITE}$NODE_PID${BRIGHT_RED} resistente, enviando SIGKILL.${RESET}"
        kill -9 $NODE_PID
    fi
    wait $NODE_PID 2>/dev/null
    echo -e "${BRIGHT_GREEN}Processo temporário encerrado.${RESET}"

    # Remove flag temporária
    if [ -f "$AUTH_SUCCESS_FLAG_FILE" ]; then
        rm -f "$AUTH_SUCCESS_FLAG_FILE"
    fi

    echo -e "${BRIGHT_BLUE}Aguardando antes de iniciar com PM2...${RESET}"
    sleep 3
else
    echo -e "${BRIGHT_GREEN}Credenciais encontradas em ${WHITE}$AUTH_CREDS_FILE${BRIGHT_GREEN}.${RESET}"
fi

# Inicia aplicação com PM2
echo -e "${BOLD}${BRIGHT_MAGENTA}Iniciando/Reiniciando ${BRIGHT_CYAN}$SYSTEM_NAME${BRIGHT_MAGENTA} com PM2 (ambiente: ${BRIGHT_CYAN}$TARGET_ENV${BRIGHT_MAGENTA})...${RESET}"

if pm2 describe $PM2_APP_NAME &> /dev/null; then
    echo -e "${BRIGHT_GREEN}$SYSTEM_NAME já é gerenciado pelo PM2. Reiniciando com ambiente ${BRIGHT_CYAN}$TARGET_ENV${BRIGHT_GREEN}...${RESET}"
    pm2 startOrRestart ecosystem.config.js --env $TARGET_ENV
else
    echo -e "${BRIGHT_GREEN}$SYSTEM_NAME ainda não é gerenciado pelo PM2. Iniciando com ambiente ${BRIGHT_CYAN}$TARGET_ENV${BRIGHT_GREEN}...${RESET}"
    pm2 start ecosystem.config.js --env $TARGET_ENV
fi

# Mensagens finais
echo ""
echo -e "${BOLD}${BRIGHT_GREEN}$SYSTEM_NAME deve estar rodando com PM2.${RESET}"
echo -e "${BRIGHT_CYAN}Status: ${BRIGHT_YELLOW}pm2 status${RESET}"
echo -e "${BRIGHT_CYAN}Logs: ${BRIGHT_YELLOW}pm2 logs $PM2_APP_NAME${RESET}"

exit 0
