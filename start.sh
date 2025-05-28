
#!/bin/bash

# Script para inicializar o index dentro de connection,
# perguntando o ambiente NODE_ENV.

# Definições de Cores Vibrantes e Estilos
RESET=$'\033[0m' # Use ANSI-C quoting for actual escape characters
BOLD=$'\033[1m'   # Use ANSI-C quoting

# Cores Brilhantes
BRIGHT_RED=$'\033[1;91m'
BRIGHT_GREEN=$'\033[1;92m'
BRIGHT_YELLOW=$'\033[1;93m'
BRIGHT_BLUE=$'\033[1;94m'
BRIGHT_MAGENTA=$'\033[1;95m'
BRIGHT_CYAN=$'\033[1;96m'

# Flag para controle do cursor
CURSOR_HIDDEN=""

# Variável global para o caminho do script de inicialização, usada no logging
INIT_SCRIPT_PATH=""

# Função de cleanup para restaurar o cursor em caso de interrupção
cleanup() {
    if [ -n "$CURSOR_HIDDEN" ] && command -v tput >/dev/null 2>&1; then
        tput cnorm # Restaura o cursor
    fi
    log_execution $? # Log com o código de saída real
}
trap cleanup EXIT INT TERM
# Funções de Animação e Utilidades Visuais

# Função para simular digitação
type_echo() {
    local text="$1"
    local color_prefix="${2:-}" # Cor opcional
    local delay=0.03

    if [ -n "$color_prefix" ]; then
        echo -n -e "$color_prefix"
    fi

    for (( i=0; i<${#text}; i++ )); do
        echo -n "${text:$i:1}"
        sleep $delay
    done

    if [ -n "$color_prefix" ]; then
        echo -e "${RESET}" # Reseta a cor e adiciona nova linha
    else
        echo # Apenas nova linha
    fi
}

# Função Spinner
spinner() {
    local pid=$1
    local delay=0.1
    local spinstr='⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏' # Caracteres do spinner (braille)
    local i=0
    # Ocultar cursor
    if command -v tput >/dev/null 2>&1; then
        tput civis
        CURSOR_HIDDEN=true
    fi

    while ps -p "$pid" > /dev/null 2>&1; do
        printf "\b%s" "${spinstr:$i:1}"
        i=$(((i + 1) % ${#spinstr}))
        sleep $delay
    done
    printf "\b " # Limpa o caractere do spinner ao final
    # Restaurar cursor
    if [ -n "$CURSOR_HIDDEN" ] && command -v tput >/dev/null 2>&1; then
        tput cnorm
        CURSOR_HIDDEN="" # Limpa a flag pois o cursor foi restaurado
    fi
}

# --- Função de Execução Principal e Seleção de NODE_ENV ---
run_application_with_selected_env() {
    local selected_node_env=""
    PS3="${BOLD}${BRIGHT_YELLOW}🚀 Por favor, escolha o modo de início para NODE_ENV: ${RESET}"
    local options_env=("development" "production" "Cancelar")
    select opt_env in "${options_env[@]}"; do
        case $opt_env in
            "development"|"production")
                selected_node_env="$opt_env"
                export NODE_ENV="$selected_node_env"
                echo -e "${BRIGHT_GREEN}NODE_ENV foi definido como: ${BOLD}$NODE_ENV${RESET}"
                break
                ;;
            "Cancelar")
                type_echo "Operação cancelada pelo usuário." "${BRIGHT_YELLOW}"
                exit 0
                ;;
            *)
                echo -e "${BRIGHT_RED}Opção inválida '$REPLY'. Tente novamente.${RESET}"
                ;;
        esac
    done

    if [ -z "$NODE_ENV" ]; then
        type_echo "Nenhum ambiente foi selecionado. Saindo." "${BRIGHT_RED}"
        exit 1
    fi

    echo ""
    type_echo "Preparando para inicializar o aplicativo..." "${BRIGHT_BLUE}${BOLD}"

    local DEFAULT_INIT_SCRIPT_PATH="./src/connection/index.js"
    # INIT_SCRIPT_PATH é global para ser acessível pela função de log no trap EXIT
    INIT_SCRIPT_PATH="${OMNIZAP_INIT_SCRIPT:-$DEFAULT_INIT_SCRIPT_PATH}"

# Verifica se Node.js está instalado
if ! command -v node >/dev/null 2>&1; then
    type_echo "Erro: Node.js não encontrado. Por favor, instale o Node.js para continuar." "${BRIGHT_RED}${BOLD}"
    exit 1
fi

    if [ -f "$INIT_SCRIPT_PATH" ]; then
    echo -n -e "${BRIGHT_CYAN}🚀 Executando: node $INIT_SCRIPT_PATH (NODE_ENV=${BOLD}$NODE_ENV${RESET}${BRIGHT_CYAN})... ${RESET}"

    # O 'export NODE_ENV' acima garante que o processo filho (node) herde a variável.
    node "$INIT_SCRIPT_PATH" &
    local NODE_PID=$!

    spinner $NODE_PID # Mostra o spinner enquanto o node executa

    wait $NODE_PID # Aguarda o processo node terminar
    local exit_code=$?

    if [ $exit_code -eq 0 ]; then
        type_echo "Aplicativo concluído com sucesso." "${BRIGHT_GREEN}"
        exit 0
    else
        type_echo "Aplicativo falhou com o código de saída: $exit_code." "${BRIGHT_RED}"
        exit "$exit_code"
    fi
    else
    type_echo "Erro: Script de inicialização não encontrado em '$INIT_SCRIPT_PATH'." "${BRIGHT_RED}${BOLD}"
    type_echo "Verifique o caminho, o nome do arquivo ou a variável de ambiente OMNIZAP_INIT_SCRIPT." "${BRIGHT_YELLOW}"
        exit 1
    fi
}

# Função para Log de Execuções
log_execution() {
    local exit_c="${1:-$?}" # Usa o argumento ou o exit status do último comando
    local log_dir="logs"
    local log_file="$log_dir/start_script.log"
    mkdir -p "$log_dir"
    {
        echo "=== Execução em $(date) ==="
        echo "NODE_ENV: ${NODE_ENV:-Nao definido}"
        echo "Script de Inicialização: ${INIT_SCRIPT_PATH:-Nao definido}" # INIT_SCRIPT_PATH pode não estar setado globalmente aqui
        echo "Código de Saída do Script: $exit_c"
        echo "=========================="
        echo ""
    } >> "$log_file"
}

# --- Loop Principal do Menu ---
main_loop() {
    type_echo "Bem-vindo ao inicializador do OmniZap!" "${BRIGHT_CYAN}${BOLD}"
    type_echo "Este script irá configurar o NODE_ENV e executar o aplicativo." "${BRIGHT_BLUE}"
    echo ""
    run_application_with_selected_env
}

main_loop