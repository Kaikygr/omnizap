#!/bin/bash

RESET='\033[0m'
BOLD='\033[1m'
BRIGHT_RED='\033[0;91m'
BRIGHT_GREEN='\033[0;92m'
BRIGHT_YELLOW='\033[0;93m'
BRIGHT_BLUE='\033[0;94m'
BRIGHT_MAGENTA='\033[0;95m'
BRIGHT_CYAN='\033[0;96m'
WHITE='\033[0;97m'

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" &>/dev/null && pwd)
cd "$SCRIPT_DIR"

TARGET_ENV="production"
if [ "$1" == "development" ]; then
    TARGET_ENV="development"
elif [ "$1" == "production" ]; then
    TARGET_ENV="production"
fi
echo -e "${BOLD}${BRIGHT_MAGENTA}OmniZap - Ambiente Alvo: ${BRIGHT_CYAN}$TARGET_ENV${RESET}"

get_env_var() {
    local var_name="$1"
    local env_file=".env"
    if [ -f "$env_file" ]; then
        VAR_VALUE=$(grep -E "^\s*${var_name}\s*=" "$env_file" | sed -e 's/#.*//' -e 's/^\s*//' -e 's/\s*$//' -e "s/${var_name}=//")
        VAR_VALUE=$(echo "$VAR_VALUE" | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//")
        echo "$VAR_VALUE"
    else
        echo ""
    fi
}

AUTH_STATE_PATH_FROM_ENV=$(get_env_var AUTH_STATE_PATH)

if [ -z "$AUTH_STATE_PATH_FROM_ENV" ]; then
    echo -e "${BOLD}${BRIGHT_RED}Erro: AUTH_STATE_PATH não encontrado no arquivo .env.${RESET}"
    AUTH_STATE_PATH_FROM_ENV="./temp/auth_state_minimal"
    echo -e "${BRIGHT_YELLOW}Usando caminho padrão para o estado de autenticação: ${WHITE}$AUTH_STATE_PATH_FROM_ENV${RESET}"
fi

AUTH_STATE_DIR_NAME=$(echo "$AUTH_STATE_PATH_FROM_ENV" | sed 's|^\./||')

PROJECT_ROOT=$(pwd)
AUTH_STATE_FULL_PATH="$PROJECT_ROOT/$AUTH_STATE_DIR_NAME"
AUTH_CREDS_FILE="$AUTH_STATE_FULL_PATH/creds.json"
AUTH_SUCCESS_FLAG_FILE="$PROJECT_ROOT/omnizap_auth_successful.flag"

if ! command -v pm2 &> /dev/null; then
    echo -e "${BOLD}${BRIGHT_RED}PM2 não pôde ser encontrado. Por favor, instale-o: ${BRIGHT_YELLOW}npm install -g pm2${RESET}"
    exit 1
fi

if ! command -v node &> /dev/null; then
    echo -e "${BOLD}${BRIGHT_RED}Node.js não pôde ser encontrado. Por favor, instale-o.${RESET}"
    exit 1
fi

echo -e "${BRIGHT_BLUE}Verificando dados de autenticação em: ${WHITE}$AUTH_CREDS_FILE${RESET}"

if [ -f "$AUTH_SUCCESS_FLAG_FILE" ]; then
    echo -e "${BRIGHT_YELLOW}Removendo flag de sucesso de autenticação antigo.${RESET}"
    rm -f "$AUTH_SUCCESS_FLAG_FILE"
fi

if [ ! -d "$AUTH_STATE_FULL_PATH" ] || [ ! -f "$AUTH_CREDS_FILE" ]; then
    echo -e "${BRIGHT_YELLOW}Dados de autenticação (creds.json) não encontrados ou diretório ausente.${RESET}"
    echo -e "${BRIGHT_GREEN}Iniciando OmniZap para escaneamento do QR Code...${RESET}"
    echo -e "${BRIGHT_CYAN}Por favor, escaneie o QR Code com o WhatsApp.${RESET}"
    echo -e "${BRIGHT_CYAN}A aplicação iniciará automaticamente com PM2 após autenticação bem-sucedida.${RESET}"

    if [ ! -d "$AUTH_STATE_FULL_PATH" ]; then
        echo -e "${BRIGHT_BLUE}Criando diretório de estado de autenticação: ${WHITE}$AUTH_STATE_FULL_PATH${RESET}"
        mkdir -p "$AUTH_STATE_FULL_PATH"
    fi
    
    node src/connection/index.js &
    NODE_PID=$!

    SPINNER_CHARS=("◐" "◓" "◑" "◒")
    SPINNER_INDEX=0
    echo -e "${BRIGHT_YELLOW}Aguardando autenticação bem-sucedida (arquivo de sinalização: ${WHITE}$AUTH_SUCCESS_FLAG_FILE${BRIGHT_YELLOW})...${RESET}"
    TIMEOUT_SECONDS=300
    ELAPSED_SECONDS=0

    while [ ! -f "$AUTH_SUCCESS_FLAG_FILE" ]; do
        printf "\r${BRIGHT_YELLOW}Aguardando autenticação ${SPINNER_CHARS[$SPINNER_INDEX]} ${RESET}(Tempo decorrido: ${ELAPSED_SECONDS}s de ${TIMEOUT_SECONDS}s) "
        SPINNER_INDEX=$(((SPINNER_INDEX + 1) % ${#SPINNER_CHARS[@]}))

        sleep 1 
        ELAPSED_SECONDS=$((ELAPSED_SECONDS + 1))

        if [ "$ELAPSED_SECONDS" -ge "$TIMEOUT_SECONDS" ]; then
            printf "\r\033[K" 
            echo -e "${BOLD}${BRIGHT_RED}Timeout (${TIMEOUT_SECONDS}s) esperando pelo arquivo de sinalização de autenticação.${RESET}"
            echo -e "${BRIGHT_YELLOW}Encerrando processo de geração de QR Code (PID: ${WHITE}$NODE_PID${BRIGHT_YELLOW}).${RESET}"
            kill $NODE_PID
            wait $NODE_PID 2>/dev/null
            echo -e "${BOLD}${BRIGHT_RED}Por favor, tente executar o script novamente.${RESET}"
            exit 1
        fi
        if ! ps -p $NODE_PID > /dev/null; then
            printf "\r\033[K" 
            echo -e "${BOLD}${BRIGHT_RED}Processo de geração de QR Code (PID: ${WHITE}$NODE_PID${BRIGHT_RED}) encerrou inesperadamente.${RESET}"
            echo -e "${BRIGHT_YELLOW}Por favor, verifique os logs e tente novamente.${RESET}"
            if [ -f "$AUTH_CREDS_FILE" ]; then
                 echo -e "${BRIGHT_GREEN}Arquivo de credenciais ${WHITE}$AUTH_CREDS_FILE${BRIGHT_GREEN} encontrado. Assumindo que a autenticação foi bem-sucedida antes da saída.${RESET}"
                 break
            fi
            exit 1
        fi
    done
    printf "\r\033[K"
    echo -e "${BOLD}${BRIGHT_GREEN}Autenticação bem-sucedida (arquivo de sinalização encontrado)!${RESET}"

    echo -e "${BRIGHT_YELLOW}Parando o processo temporário de geração de QR Code (PID: ${WHITE}$NODE_PID${BRIGHT_YELLOW})...${RESET}"
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

    if ps -p $NODE_PID > /dev/null; then
        echo -e "${BOLD}${BRIGHT_RED}Processo ${WHITE}$NODE_PID${BRIGHT_RED} não terminou graciosamente, enviando SIGKILL.${RESET}"
        kill -9 $NODE_PID
    fi
    wait $NODE_PID 2>/dev/null
    echo -e "${BRIGHT_GREEN}Processo temporário parado.${RESET}"

    if [ -f "$AUTH_SUCCESS_FLAG_FILE" ]; then
        rm -f "$AUTH_SUCCESS_FLAG_FILE"
    fi

    echo -e "${BRIGHT_BLUE}Aguardando um momento antes de iniciar com PM2...${RESET}"
    sleep 3
else
    echo -e "${BRIGHT_GREEN}Dados de autenticação (creds.json) encontrados em ${WHITE}$AUTH_CREDS_FILE${BRIGHT_GREEN}.${RESET}"
fi

echo -e "${BOLD}${BRIGHT_MAGENTA}Iniciando/Reiniciando aplicação OmniZap com PM2 (ambiente: ${BRIGHT_CYAN}$TARGET_ENV${BRIGHT_MAGENTA})...${RESET}"
PM2_APP_NAME="omnizap"

if pm2 describe $PM2_APP_NAME &> /dev/null; then
    echo -e "${BRIGHT_GREEN}OmniZap já é gerenciado pelo PM2. Reiniciando com ambiente ${BRIGHT_CYAN}$TARGET_ENV${BRIGHT_GREEN}...${RESET}"
    pm2 startOrRestart ecosystem.config.js --env $TARGET_ENV
else
    echo -e "${BRIGHT_GREEN}OmniZap ainda não é gerenciado pelo PM2. Iniciando com ambiente ${BRIGHT_CYAN}$TARGET_ENV${BRIGHT_GREEN}...${RESET}"
    pm2 start ecosystem.config.js --env $TARGET_ENV
fi

echo ""
echo -e "${BOLD}${BRIGHT_GREEN}OmniZap deve estar rodando com PM2.${RESET}"
echo -e "${BRIGHT_CYAN}Você pode verificar o status com: ${BRIGHT_YELLOW}pm2 status${RESET}"
echo -e "${BRIGHT_CYAN}E os logs com: ${BRIGHT_YELLOW}pm2 logs $PM2_APP_NAME${RESET}"

exit 0
