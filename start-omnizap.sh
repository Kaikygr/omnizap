#!/bin/bash

# Configurações gerais
AUTH_TIMEOUT_SECONDS=300
PROCESS_KILL_TIMEOUT=10
POST_AUTH_WAIT=3
DEFAULT_AUTH_PATH="./temp/auth_state_minimal"
MAX_ZOMBIE_CLEANUP_RETRIES=3
ZOMBIE_CLEANUP_WAIT=2
ESSENTIAL_VARS=("AUTH_STATE_PATH" "NODE_ENV" "LOG_LEVEL" "PORT" "SYSTEM_NAME")

# Verificar e limpar processos zumbis relacionados ao OmniZap
cleanup_zombie_processes() {
    local process_pattern="$1"
    echo -e "${BRIGHT_BLUE}Verificando processos zumbis relacionados a: ${WHITE}$process_pattern${RESET}"
    
    # Função para obter lista de processos zumbis
    get_zombie_pids() {
        ps axo pid,ppid,state,cmd | grep -i "$process_pattern" | grep -E "Z|defunct" | awk '{print $1}'
    }
    
    # Função para obter os processos pai
    get_parent_pids() {
        ps axo pid,ppid,state,cmd | grep -i "$process_pattern" | grep -E "Z|defunct" | awk '{print $2}' | sort -u
    }
    
    local zombie_pids=($(get_zombie_pids))
    if [ ${#zombie_pids[@]} -gt 0 ]; then
        echo -e "${BRIGHT_YELLOW}Encontrados ${#zombie_pids[@]} processos zumbis. Limpando...${RESET}"
        
        # Primeiro, tenta limpar os processos pai
        local parent_pids=($(get_parent_pids))
        if [ ${#parent_pids[@]} -gt 0 ]; then
            echo -e "${BRIGHT_YELLOW}Enviando SIGCHLD para ${#parent_pids[@]} processos pai...${RESET}"
            for ppid in "${parent_pids[@]}"; do
                if [ "$ppid" != "1" ] && [ "$ppid" != "0" ]; then
                    echo -e "${BRIGHT_YELLOW}Enviando SIGCHLD para processo pai PID: ${WHITE}$ppid${RESET}"
                    kill -SIGCHLD "$ppid" 2>/dev/null || true
                fi
            done
            
            # Pequena pausa para permitir que os sinais sejam processados
            sleep 1
        fi
        
        # Verifica novamente os zumbis
        zombie_pids=($(get_zombie_pids))
        
        # Se ainda houver zumbis, tenta medidas mais agressivas
        if [ ${#zombie_pids[@]} -gt 0 ]; then
            echo -e "${BRIGHT_YELLOW}Ainda existem ${#zombie_pids[@]} processos zumbis. Tentando abordagem mais agressiva...${RESET}"
            
            # Tenta várias vezes com diferentes sinais
            for attempt in $(seq 1 $MAX_ZOMBIE_CLEANUP_RETRIES); do
                echo -e "${BRIGHT_YELLOW}Tentativa $attempt de $MAX_ZOMBIE_CLEANUP_RETRIES${RESET}"
                
                for pid in "${zombie_pids[@]}"; do
                    echo -e "${BRIGHT_YELLOW}Tentando limpar zumbi PID: ${WHITE}$pid${RESET}"
                    # Tenta diferentes sinais em sequência
                    kill -SIGTERM "$pid" 2>/dev/null || true
                    kill -9 "$pid" 2>/dev/null || true
                    
                    # Tenta lidar com o processo pai também
                    local ppid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
                    if [ -n "$ppid" ] && [ "$ppid" != "1" ] && [ "$ppid" != "0" ]; then
                        echo -e "${BRIGHT_YELLOW}Enviando sinais para processo pai PID: ${WHITE}$ppid${RESET}"
                        kill -SIGCHLD "$ppid" 2>/dev/null || true
                    fi
                done
                
                # Espera um pouco entre tentativas
                sleep "$ZOMBIE_CLEANUP_WAIT"
                
                # Verifica se os zumbis foram eliminados
                zombie_pids=($(get_zombie_pids))
                if [ ${#zombie_pids[@]} -eq 0 ]; then
                    echo -e "${BRIGHT_GREEN}Todos os processos zumbis foram limpos com sucesso.${RESET}"
                    break
                fi
            done
            
            # Verifica o resultado final
            zombie_pids=($(get_zombie_pids))
            if [ ${#zombie_pids[@]} -gt 0 ]; then
                echo -e "${BRIGHT_RED}Ainda restam ${#zombie_pids[@]} processos zumbis após todas as tentativas.${RESET}"
                echo -e "${BRIGHT_RED}Você pode precisar reiniciar o sistema para eliminá-los completamente.${RESET}"
            fi
        else
            echo -e "${BRIGHT_GREEN}Todos os processos zumbis foram limpos com sucesso.${RESET}"
        fi
    else
        echo -e "${BRIGHT_GREEN}Nenhum processo zumbi encontrado.${RESET}"
    fi
}

# Função para verificar o uso de recursos e desempenho do sistema
check_system_resources() {
    echo -e "${BRIGHT_BLUE}Verificando recursos do sistema...${RESET}"
    
    # Verifica uso de CPU
    local cpu_usage=$(top -bn1 | grep "Cpu(s)" | sed "s/.*, *\([0-9.]*\)%* id.*/\1/" | awk '{print 100 - $1}')
    echo -e "  ${BRIGHT_CYAN}Uso de CPU: ${WHITE}${cpu_usage}%${RESET}"
    
    # Verifica uso de memória
    local mem_info=$(free -m | grep Mem)
    local mem_total=$(echo "$mem_info" | awk '{print $2}')
    local mem_used=$(echo "$mem_info" | awk '{print $3}')
    local mem_usage=$(awk "BEGIN { printf \"%.1f\", ($mem_used/$mem_total)*100 }")
    echo -e "  ${BRIGHT_CYAN}Uso de memória: ${WHITE}${mem_usage}% (${mem_used}MB de ${mem_total}MB)${RESET}"
    
    # Verifica espaço em disco
    local disk_info=$(df -h . | tail -1)
    local disk_usage=$(echo "$disk_info" | awk '{print $5}')
    local disk_avail=$(echo "$disk_info" | awk '{print $4}')
    echo -e "  ${BRIGHT_CYAN}Uso de disco: ${WHITE}${disk_usage} (${disk_avail} disponível)${RESET}"
    
    # Aviso se recursos estiverem baixos
    if (( $(echo "$cpu_usage > 80" | bc -l) )); then
        echo -e "  ${BRIGHT_RED}AVISO: Uso de CPU elevado pode afetar o desempenho do OmniZap${RESET}"
    fi
    
    if (( $(echo "$mem_usage > 85" | bc -l) )); then
        echo -e "  ${BRIGHT_RED}AVISO: Memória baixa pode causar problemas de desempenho${RESET}"
    fi
    
    if [[ "$disk_usage" == *"9"* ]] || [[ "$disk_usage" == "100%" ]]; then
        echo -e "  ${BRIGHT_RED}AVISO: Espaço em disco crítico. Considere liberar espaço.${RESET}"
    fi
}

# Verifica se bc está instalado (usado para cálculos)
check_bc_installed() {
    if ! command -v bc &> /dev/null; then
        echo -e "${BRIGHT_YELLOW}A ferramenta 'bc' não está instalada. Alguns cálculos de recursos podem não funcionar corretamente.${RESET}"
        return 1
    fi
    return 0
}

# Função para verificar conectividade com internet
check_internet_connectivity() {
    echo -e "${BRIGHT_BLUE}Verificando conectividade com a internet...${RESET}"
    
    # Lista de servidores para testar conexão
    local servers=("google.com" "whatsapp.com" "web.whatsapp.com" "cloudflare.com")
    local connected=false
    
    for server in "${servers[@]}"; do
        if ping -c 1 -W 2 "$server" &> /dev/null; then
            echo -e "  ${BRIGHT_GREEN}Conectado à internet (ping para ${WHITE}$server${BRIGHT_GREEN} bem-sucedido)${RESET}"
            connected=true
            break
        fi
    done
    
    if [ "$connected" = false ]; then
        echo -e "  ${BRIGHT_RED}AVISO: Não foi possível conectar à internet. O OmniZap pode não funcionar corretamente.${RESET}"
        echo -e "  ${BRIGHT_YELLOW}Verifique sua conexão de rede antes de continuar.${RESET}"
        
        # Pergunta se deseja continuar
        read -p "  Deseja continuar mesmo assim? (s/N): " -r continue_anyway
        if [[ ! $continue_anyway =~ ^[Ss]$ ]]; then
            echo -e "${BRIGHT_RED}Encerrando por falta de conectividade.${RESET}"
            exit 1
        fi
    fi
}

# Função para limpeza e rotação de logs antigos
manage_log_files() {
    echo -e "${BRIGHT_BLUE}Verificando arquivos de log...${RESET}"
    
    # Define o diretório de logs
    local log_dir="./logs"
    if [ ! -d "$log_dir" ]; then
        echo -e "${BRIGHT_YELLOW}Diretório de logs não encontrado. Criando...${RESET}"
        mkdir -p "$log_dir"
        return
    fi
    
    # Conta arquivos de log
    local log_count=$(find "$log_dir" -type f -name "*.log*" | wc -l)
    echo -e "  ${BRIGHT_CYAN}Total de arquivos de log: ${WHITE}$log_count${RESET}"
    
    # Verifica tamanho total dos logs
    local log_size=$(du -sh "$log_dir" | awk '{print $1}')
    echo -e "  ${BRIGHT_CYAN}Tamanho total dos logs: ${WHITE}$log_size${RESET}"
    
    # Limpa logs mais antigos que 30 dias
    local old_logs=$(find "$log_dir" -type f -name "*.log*" -mtime +30 | wc -l)
    if [ "$old_logs" -gt 0 ]; then
        echo -e "  ${BRIGHT_YELLOW}Removendo $old_logs arquivos de log com mais de 30 dias...${RESET}"
        find "$log_dir" -type f -name "*.log*" -mtime +30 -exec rm {} \;
    fi
    
    # Comprime logs não comprimidos com mais de 7 dias
    local logs_to_compress=$(find "$log_dir" -type f -name "*.log" -not -name "*.gz" -mtime +7 | wc -l)
    if [ "$logs_to_compress" -gt 0 ]; then
        echo -e "  ${BRIGHT_YELLOW}Comprimindo $logs_to_compress arquivos de log com mais de 7 dias...${RESET}"
        find "$log_dir" -type f -name "*.log" -not -name "*.gz" -mtime +7 -exec gzip {} \;
    fi
}

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
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
cd "$SCRIPT_DIR" || {
    echo -e "${BOLD}${BRIGHT_RED}Erro ao acessar diretório do script: ${WHITE}${SCRIPT_DIR}${RESET}"
    exit 1
}

# Carrega variáveis do .env
if [ -f ".env" ]; then
    source .env
else
    echo -e "${BRIGHT_YELLOW}Arquivo .env não encontrado. Utilizando valores padrão.${RESET}"
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

# Função para extrair variáveis do .env - versão robusta
get_env_var() {
    local var_name="$1"
    local default_value="$2"
    local env_file=".env"
    
    if [ ! -f "$env_file" ]; then
        echo "$default_value"
        return
    fi
    
    # Abordagem mais robusta para extrair valores de variáveis
    # Suporta múltiplos formatos: 
    # - VAR=value
    # - VAR="value com espaços"
    # - VAR='value com espaços'
    # - VAR = value
    # - VAR="value # não é comentário"
    # - Ignora comentários: # comentário
    # - Ignora linhas em branco
    local VAR_VALUE
    
    # Primeiro tenta extrair usando padrão regex mais preciso
    VAR_VALUE=$(grep -E "^[ \t]*${var_name}[ \t]*=[ \t]*" "$env_file" | head -1)
    
    if [ -z "$VAR_VALUE" ]; then
        echo "$default_value"
        return
    fi
    
    # Remove comentários após a linha (se não estiverem entre aspas)
    VAR_VALUE=$(echo "$VAR_VALUE" | sed -E 's/([^"'\'']*["'\''][^"'\'']*["'\''])*[^"'\'']*#.*/\1/')
    
    # Remove espaços em branco no início e fim
    VAR_VALUE=$(echo "$VAR_VALUE" | sed -E 's/^[ \t]+|[ \t]+$//g')
    
    # Remove o nome da variável e o sinal de igual
    VAR_VALUE=$(echo "$VAR_VALUE" | sed -E "s/^${var_name}[ \t]*=[ \t]*//")
    
    # Remove aspas se presentes
    if [[ "$VAR_VALUE" =~ ^\"(.*)\"$ ]]; then
        # Valor entre aspas duplas
        VAR_VALUE="${BASH_REMATCH[1]}"
    elif [[ "$VAR_VALUE" =~ ^\'(.*)\'$ ]]; then
        # Valor entre aspas simples
        VAR_VALUE="${BASH_REMATCH[1]}"
    fi
    
    echo "$VAR_VALUE"
}

# Validação de variáveis de ambiente essenciais
validate_env_vars() {
    local missing_vars=()
    local warning_vars=()
    
    # Validação de todas as variáveis essenciais
    for var_name in "${ESSENTIAL_VARS[@]}"; do
        local var_value
        var_value=$(get_env_var "$var_name" "")
        
        # Atribui valores às variáveis globais e verifica
        case "$var_name" in
            "AUTH_STATE_PATH")
                AUTH_STATE_PATH="$var_value"
                if [ -z "$AUTH_STATE_PATH" ]; then
                    missing_vars+=("AUTH_STATE_PATH")
                    AUTH_STATE_PATH="$DEFAULT_AUTH_PATH"
                fi
                ;;
                
            "NODE_ENV")
                NODE_ENV="$var_value"
                if [ -z "$NODE_ENV" ]; then
                    warning_vars+=("NODE_ENV")
                    NODE_ENV="$TARGET_ENV"
                fi
                ;;
                
            "LOG_LEVEL")
                LOG_LEVEL="$var_value"
                if [ -z "$LOG_LEVEL" ]; then
                    warning_vars+=("LOG_LEVEL")
                    LOG_LEVEL="info"
                fi
                # Validação de valores permitidos
                if ! [[ "$LOG_LEVEL" =~ ^(trace|debug|info|warn|error|fatal)$ ]]; then
                    warning_vars+=("LOG_LEVEL (valor inválido: $LOG_LEVEL)")
                    LOG_LEVEL="info"
                fi
                ;;
                
            "PORT")
                PORT="$var_value"
                if [ -z "$PORT" ]; then
                    warning_vars+=("PORT")
                    PORT="3000"
                fi
                # Verifica se é um número
                if ! [[ "$PORT" =~ ^[0-9]+$ ]]; then
                    warning_vars+=("PORT (valor inválido: $PORT)")
                    PORT="3000"
                fi
                ;;
                
            "SYSTEM_NAME")
                SYSTEM_NAME="$var_value"
                if [ -z "$SYSTEM_NAME" ]; then
                    warning_vars+=("SYSTEM_NAME")
                    SYSTEM_NAME="omnizap"
                fi
                ;;
        esac
    done
    
    # Exibe variáveis em falta (críticas)
    if [ ${#missing_vars[@]} -gt 0 ]; then
        echo -e "${BRIGHT_YELLOW}Variáveis de ambiente críticas ausentes ou inválidas:${RESET}"
        for var in "${missing_vars[@]}"; do
            echo -e "  ${BRIGHT_RED}$var${RESET}"
        done
        echo -e "${BRIGHT_YELLOW}Usando valores padrão para as variáveis ausentes.${RESET}"
    fi
    
    # Exibe avisos (não críticos)
    if [ ${#warning_vars[@]} -gt 0 ]; then
        echo -e "${BRIGHT_YELLOW}Avisos para variáveis de ambiente:${RESET}"
        for var in "${warning_vars[@]}"; do
            echo -e "  ${BRIGHT_YELLOW}$var${RESET}"
        done
        echo -e "${BRIGHT_YELLOW}Usando valores padrão para as variáveis com aviso.${RESET}"
    fi
    
    # Exibe configuração atual
    echo -e "${BRIGHT_BLUE}Configuração atual:${RESET}"
    echo -e "  ${BRIGHT_CYAN}AUTH_STATE_PATH: ${WHITE}\"$AUTH_STATE_PATH\"${RESET}"
    echo -e "  ${BRIGHT_CYAN}NODE_ENV: ${WHITE}\"$NODE_ENV\"${RESET}"
    echo -e "  ${BRIGHT_CYAN}LOG_LEVEL: ${WHITE}\"$LOG_LEVEL\"${RESET}"
    echo -e "  ${BRIGHT_CYAN}PORT: ${WHITE}\"$PORT\"${RESET}"
    echo -e "  ${BRIGHT_CYAN}SYSTEM_NAME: ${WHITE}\"$SYSTEM_NAME\"${RESET}"
}

# Validação das variáveis de ambiente
validate_env_vars

# Configuração de caminhos de autenticação com tratamento de espaços
AUTH_STATE_DIR_NAME=$(echo "$AUTH_STATE_PATH" | sed 's|^\./||')
PROJECT_ROOT="$(pwd)"
AUTH_STATE_FULL_PATH="${PROJECT_ROOT}/${AUTH_STATE_DIR_NAME}"
AUTH_CREDS_FILE="${AUTH_STATE_FULL_PATH}/creds.json"
AUTH_SUCCESS_FLAG_FILE="${AUTH_STATE_FULL_PATH}/.auth_success_flag"

# Garante que os caminhos estão escapados corretamente
AUTH_STATE_FULL_PATH_ESCAPED="${AUTH_STATE_FULL_PATH// /\\ }"
AUTH_CREDS_FILE_ESCAPED="${AUTH_CREDS_FILE// /\\ }"
AUTH_SUCCESS_FLAG_FILE_ESCAPED="${AUTH_SUCCESS_FLAG_FILE// /\\ }"

# Exibe informações sobre caminhos para debug
echo -e "${BRIGHT_BLUE}Caminhos configurados:${RESET}"
echo -e "  ${BRIGHT_CYAN}Diretório de autenticação: ${WHITE}\"$AUTH_STATE_FULL_PATH\"${RESET}"
echo -e "  ${BRIGHT_CYAN}Arquivo de credenciais: ${WHITE}\"$AUTH_CREDS_FILE\"${RESET}"

# Verificações de dependências
if ! command -v pm2 &> /dev/null; then
    echo -e "${BOLD}${BRIGHT_RED}PM2 não encontrado. Instale com: ${BRIGHT_YELLOW}npm install -g pm2${RESET}"
    exit 1
fi

if ! command -v node &> /dev/null; then
    echo -e "${BOLD}${BRIGHT_RED}Node.js não encontrado. Por favor, instale-o.${RESET}"
    exit 1
fi

# Verifica conectividade com a internet
check_internet_connectivity

# Limpa processos zumbis relacionados a node/omni/zap antes de continuar
cleanup_zombie_processes "node.*omnizap"

echo -e "${BRIGHT_BLUE}Verificando autenticação em: ${WHITE}\"$AUTH_CREDS_FILE\"${RESET}"

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
        echo -e "${BRIGHT_BLUE}Criando diretório: ${WHITE}\"$AUTH_STATE_FULL_PATH\"${RESET}"
        mkdir -p "$AUTH_STATE_FULL_PATH"
    fi
    
    # Inicia processo temporário
    node src/connection/index.js &
    NODE_PID=$!

    # Aguarda autenticação com spinner
    SPINNER_CHARS=("◐" "◓" "◑" "◒")
    SPINNER_INDEX=0
    echo -e "${BRIGHT_YELLOW}Aguardando autenticação (flag: ${WHITE}\"$AUTH_SUCCESS_FLAG_FILE\"${BRIGHT_YELLOW})...${RESET}"
    ELAPSED_SECONDS=0

    while [ ! -f "$AUTH_SUCCESS_FLAG_FILE" ]; do
        printf "\r${BRIGHT_YELLOW}Aguardando autenticação ${SPINNER_CHARS[$SPINNER_INDEX]} ${RESET}(${ELAPSED_SECONDS}s/${AUTH_TIMEOUT_SECONDS}s) "
        SPINNER_INDEX=$(((SPINNER_INDEX + 1) % ${#SPINNER_CHARS[@]}))

        sleep 1 
        ELAPSED_SECONDS=$((ELAPSED_SECONDS + 1))

        # Verifica timeout
        if [ "$ELAPSED_SECONDS" -ge "$AUTH_TIMEOUT_SECONDS" ]; then
            printf "\r\033[K" 
            echo -e "${BOLD}${BRIGHT_RED}Timeout (${AUTH_TIMEOUT_SECONDS}s) aguardando autenticação.${RESET}"
            echo -e "${BRIGHT_YELLOW}Encerrando processo QR Code (PID: ${WHITE}$NODE_PID${BRIGHT_YELLOW}).${RESET}"
            kill "$NODE_PID" 2>/dev/null || true
            wait "$NODE_PID" 2>/dev/null || true
            echo -e "${BOLD}${BRIGHT_RED}Tente executar novamente.${RESET}"
            exit 1
        fi
        
        # Verifica se processo ainda está rodando
        if ! ps -p "$NODE_PID" > /dev/null; then
            printf "\r\033[K" 
            echo -e "${BOLD}${BRIGHT_RED}Processo QR Code (PID: ${WHITE}$NODE_PID${BRIGHT_RED}) encerrou inesperadamente.${RESET}"
            echo -e "${BRIGHT_YELLOW}Verifique os logs e tente novamente.${RESET}"
            if [ -f "$AUTH_CREDS_FILE" ]; then
                 echo -e "${BRIGHT_GREEN}Credenciais ${WHITE}\"$AUTH_CREDS_FILE\"${BRIGHT_GREEN} encontradas. Autenticação assumida como bem-sucedida.${RESET}"
                 break
            fi
            exit 1
        fi
    done
    printf "\r\033[K"
    echo -e "${BOLD}${BRIGHT_GREEN}Autenticação bem-sucedida!${RESET}"

    # Para processo temporário graciosamente
    echo -e "${BRIGHT_YELLOW}Parando processo temporário (PID: ${WHITE}$NODE_PID${BRIGHT_YELLOW})...${RESET}"
    kill "$NODE_PID" 2>/dev/null || true
    
    for i in $(seq 1 $PROCESS_KILL_TIMEOUT); do
        if ! ps -p "$NODE_PID" > /dev/null; then
            break
        fi
        if [ $i -eq 1 ]; then
            echo -e "${BRIGHT_CYAN}Enviado SIGTERM para ${WHITE}$NODE_PID${BRIGHT_CYAN}.${RESET}"
        fi
        sleep 1
    done

    # Força encerramento se necessário
    if ps -p "$NODE_PID" > /dev/null; then
        echo -e "${BOLD}${BRIGHT_RED}Processo ${WHITE}$NODE_PID${BRIGHT_RED} resistente, enviando SIGKILL.${RESET}"
        kill -9 "$NODE_PID" 2>/dev/null || true
    fi
    wait "$NODE_PID" 2>/dev/null || true
    echo -e "${BRIGHT_GREEN}Processo temporário encerrado.${RESET}"

    # Remove flag temporária
    if [ -f "$AUTH_SUCCESS_FLAG_FILE" ]; then
        rm -f "$AUTH_SUCCESS_FLAG_FILE"
    fi

    echo -e "${BRIGHT_BLUE}Aguardando antes de iniciar com PM2 (${POST_AUTH_WAIT}s)...${RESET}"
    sleep "$POST_AUTH_WAIT"
else
    echo -e "${BRIGHT_GREEN}Credenciais encontradas em ${WHITE}\"$AUTH_CREDS_FILE\"${BRIGHT_GREEN}.${RESET}"
fi

# Verifica recursos do sistema antes de iniciar
if command -v bc &> /dev/null; then
    check_system_resources
else
    echo -e "${BRIGHT_YELLOW}Verificação de recursos desativada. Instale 'bc' para habilitar: ${WHITE}sudo apt-get install bc${RESET}"
fi

# Gerencia arquivos de log
manage_log_files

# Inicia aplicação com PM2
echo -e "${BOLD}${BRIGHT_MAGENTA}Iniciando/Reiniciando ${BRIGHT_CYAN}$SYSTEM_NAME${BRIGHT_MAGENTA} com PM2 (ambiente: ${BRIGHT_CYAN}$TARGET_ENV${BRIGHT_MAGENTA})...${RESET}"

if pm2 describe "$PM2_APP_NAME" &> /dev/null; then
    echo -e "${BRIGHT_GREEN}$SYSTEM_NAME já é gerenciado pelo PM2. Reiniciando com ambiente ${BRIGHT_CYAN}$TARGET_ENV${BRIGHT_GREEN}...${RESET}"
    pm2 startOrRestart ecosystem.config.js --env "$TARGET_ENV"
else
    echo -e "${BRIGHT_GREEN}$SYSTEM_NAME ainda não é gerenciado pelo PM2. Iniciando com ambiente ${BRIGHT_CYAN}$TARGET_ENV${BRIGHT_GREEN}...${RESET}"
    pm2 start ecosystem.config.js --env "$TARGET_ENV"
fi

# Limpa processos zumbis novamente após inicialização
cleanup_zombie_processes "node.*omnizap"

# Mensagens finais
echo ""
echo -e "${BOLD}${BRIGHT_GREEN}$SYSTEM_NAME deve estar rodando com PM2.${RESET}"
echo -e "${BRIGHT_CYAN}Status: ${BRIGHT_YELLOW}pm2 status${RESET}"
echo -e "${BRIGHT_CYAN}Logs: ${BRIGHT_YELLOW}pm2 logs $PM2_APP_NAME${RESET}"

exit 0
