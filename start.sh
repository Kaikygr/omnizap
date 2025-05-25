
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

# Função de cleanup para restaurar o cursor em caso de interrupção
cleanup() {
    if [ -n "$CURSOR_HIDDEN" ] && command -v tput >/dev/null 2>&1; then
        tput cnorm # Restaura o cursor
    fi
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

# Helper para executar comandos NVM em um subshell com NVM carregado
# Retorna a saída do comando nvm ou string vazia em caso de falha/nvm não encontrado.
run_nvm_command() {
    local nvm_script_path=""
    # Prioriza NVM_DIR se estiver definido, caso contrário, o caminho padrão.
    if [ -n "$NVM_DIR" ] && [ -s "$NVM_DIR/nvm.sh" ]; then
        nvm_script_path="$NVM_DIR/nvm.sh"
    elif [ -s "$HOME/.nvm/nvm.sh" ]; then
        nvm_script_path="$HOME/.nvm/nvm.sh"
    fi

    if [ -n "$nvm_script_path" ]; then
        ( # Abre subshell
        # shellcheck source=/dev/null
        . "$nvm_script_path" --no-use # Carrega NVM sem ativar .nvmrc automaticamente
        nvm "$@" # Executa o comando nvm passado como argumento (ex: nvm current, nvm version x.y.z)
        ) 2>/dev/null # Suprime erros do nvm ou do source, retorna apenas a saída padrão
    fi
    # Se nvm_script_path estiver vazio, a função implicitamente retorna string vazia (sem saída)
}

# Função para exibir informações do sistema
display_system_info() {
    type_echo "🔍 Verificando informações do ambiente..." "${BRIGHT_MAGENTA}${BOLD}"

    local os_info kernel_info arch_info
    os_info=$(uname -s)
    kernel_info=$(uname -r)
    arch_info=$(uname -m)
    type_echo "   Sistema Operacional: ${BRIGHT_BLUE}${os_info} ${kernel_info} (${arch_info})${RESET}"

    # Node.js e NVM
    if command -v node >/dev/null 2>&1; then
        local node_version
        node_version=$(node -v)
        type_echo "   Versão do Node.js:   ${BRIGHT_GREEN}${node_version}${RESET}"

        local nvm_current_node
        nvm_current_node=$(run_nvm_command current)

        if [ -n "$nvm_current_node" ] && [ "$nvm_current_node" != "none" ] && [ "$nvm_current_node" != "system" ]; then
            type_echo "   NVM Node Ativo:    ${BRIGHT_CYAN}${nvm_current_node}${RESET}"
            if [ "$node_version" != "$nvm_current_node" ]; then
                 type_echo "   ${BRIGHT_YELLOW}Nota: 'node -v' (${node_version}) difere de 'nvm current' (${nvm_current_node}). Verifique sua configuração NVM/PATH.${RESET}"
            fi
        elif [ -n "$nvm_current_node" ]; then # NVM detectado, mas 'current' é 'system' ou 'none'
            type_echo "   NVM Detectado:     (nvm current: ${nvm_current_node})" "${BRIGHT_BLUE}"
        fi

        if [ -f .nvmrc ]; then
            local nvmrc_content nvmrc_resolved_version current_resolved_version
            nvmrc_content=$(cat .nvmrc | tr -d '[:space:]') # Remove espaços
            type_echo "   Projeto .nvmrc:    ${BRIGHT_CYAN}Requer Node ~${nvmrc_content}${RESET}"

            if [ -n "$nvm_current_node" ]; then # Só faz sentido comparar se NVM está ativo
                nvmrc_resolved_version=$(run_nvm_command version "$nvmrc_content")
                current_resolved_version=$(run_nvm_command version current) # 'nvm version current' resolve alias como 'default' para a versão real

                if [ -n "$nvmrc_resolved_version" ] && [ -n "$current_resolved_version" ] && [ "$nvmrc_resolved_version" != "$current_resolved_version" ]; then
                    type_echo "   ${BRIGHT_YELLOW}Atenção: NVM Node ativo (${current_resolved_version}) difere do .nvmrc (~${nvmrc_content} -> ${nvmrc_resolved_version}).${RESET}"
                    type_echo "   ${BRIGHT_YELLOW}Considere executar 'nvm use' ou 'nvm install ${nvmrc_content}'.${RESET}"
                elif [ -z "$nvmrc_resolved_version" ] && [ "$nvm_current_node" != "none" ] && [ "$nvm_current_node" != "system" ]; then # nvmrc não resolvido pelo nvm
                    type_echo "   ${BRIGHT_YELLOW}Atenção: Versão do .nvmrc (~${nvmrc_content}) não reconhecida/instalada via NVM.${RESET}"
                fi
            fi
        fi
    else
        type_echo "   Versão do Node.js:   ${BRIGHT_YELLOW}Não encontrado${RESET}"
        if [ -f .nvmrc ]; then type_echo "   Projeto .nvmrc:    ${BRIGHT_CYAN}Requer Node ~$(cat .nvmrc | tr -d '[:space:]') (Node.js não encontrado)${RESET}"; fi
    fi

    if command -v npm >/dev/null 2>&1; then
        local npm_version
        npm_version=$(npm -v)
        type_echo "   Versão do NPM:       ${BRIGHT_GREEN}${npm_version}${RESET}"

        # Verificar e oferecer atualização do NPM
        local latest_npm_version
        # Silenciar erros do npm view caso não haja conexão ou npm esteja quebrado
        latest_npm_version=$(npm view npm version 2>/dev/null)

        if [[ -n "$latest_npm_version" && "$npm_version" != "$latest_npm_version" ]]; then
            type_echo "   Nova versão do NPM disponível: ${BRIGHT_YELLOW}${latest_npm_version}${RESET}"
            
            # Usar echo -e para o prompt do read para garantir a interpretação das cores
            echo -n -e "${BOLD}${BRIGHT_CYAN}Deseja atualizar o NPM para a versão ${latest_npm_version}? (s/N): ${RESET}"
            read -r confirm_npm_update

            if [[ "$confirm_npm_update" =~ ^[SsYy]$ ]]; then
                type_echo "   Atualizando NPM... (Isso pode levar um momento e pode exigir privilégios de administrador)" "${BRIGHT_MAGENTA}"
                if npm install -g npm@"$latest_npm_version"; then # Tenta instalar a versão específica mais recente
                    local new_npm_version
                    new_npm_version=$(npm -v) # Pega a versão atualizada
                    type_echo "   NPM atualizado com sucesso para: ${BRIGHT_GREEN}${new_npm_version}${RESET}"
                else
                    type_echo "   Falha ao atualizar o NPM. Verifique os erros acima ou tente manualmente (ex: sudo npm install -g npm@latest)." "${BRIGHT_RED}"
                fi
            else
                type_echo "   Atualização do NPM ignorada." "${BRIGHT_YELLOW}"
            fi
        fi
    else
        type_echo "   Versão do NPM:       ${BRIGHT_YELLOW}Não encontrado${RESET}"
    fi

    if command -v git >/dev/null 2>&1; then
        local git_version
        git_version=$(git --version)
        type_echo "   Versão do Git:       ${BRIGHT_GREEN}${git_version}${RESET}"

        # Informações adicionais do Git se estiver em um repositório
        if git rev-parse --is-inside-work-tree > /dev/null 2>&1; then
            local current_branch remote_url
            current_branch=$(git symbolic-ref --short HEAD 2>/dev/null || git rev-parse --short HEAD 2>/dev/null) # Lida com detached HEAD
            type_echo "   Git Branch Atual:    ${BRIGHT_CYAN}${current_branch}${RESET}"
            remote_url=$(git config --get remote.origin.url 2>/dev/null)
            if [ -n "$remote_url" ]; then
                type_echo "   Git Remote (origin): ${BRIGHT_CYAN}${remote_url}${RESET}"
            fi
        fi
    else
        type_echo "   Versão do Git:       ${BRIGHT_YELLOW}Não encontrado${RESET}"
    fi

    if ping -c 1 -W 1 8.8.8.8 > /dev/null 2>&1; then
        type_echo "   Conexão Internet:  ${BRIGHT_GREEN}Ativa ✅${RESET}"
    else
        type_echo "   Conexão Internet:  ${BRIGHT_RED}Inativa ou instável ❌${RESET}"
    fi
    echo ""
}

type_echo "Bem-vindo ao inicializador do OmniZap!" "${BRIGHT_CYAN}${BOLD}"
type_echo "Este script irá configurar o NODE_ENV e, em seguida, tentará executar o script de inicialização." "${BRIGHT_BLUE}"
echo ""
display_system_info # Chama a função para exibir as informações

# Verifica se NODE_ENV foi passado como argumento
PRESET_NODE_ENV=""
if [ -n "$1" ]; then
    case "$1" in
        development|production)
            PRESET_NODE_ENV="$1"
            export NODE_ENV="$PRESET_NODE_ENV"
            type_echo "NODE_ENV definido via argumento: ${BRIGHT_GREEN}${BOLD}$NODE_ENV${RESET}"
            ;;
        *)
            type_echo "Argumento inválido para NODE_ENV: '$1'. Ignorando e mostrando o menu." "${BRIGHT_YELLOW}"
            ;;
    esac
fi

# Se NODE_ENV não foi definido por argumento, mostra o menu de seleção
if [ -z "$NODE_ENV" ]; then
    PS3="${BOLD}${BRIGHT_YELLOW}🚀 Por favor, escolha o modo de início para NODE_ENV: ${RESET}"
    options=("development" "production" "Cancelar")
    select opt in "${options[@]}"
    do
        case $opt in
            "development")
                export NODE_ENV="development"
                echo -e "${BRIGHT_GREEN}NODE_ENV foi definido como: ${BOLD}$NODE_ENV${RESET}"
                break
                ;;
            "production")
                export NODE_ENV="production"
                echo -e "${BRIGHT_GREEN}NODE_ENV foi definido como: ${BOLD}$NODE_ENV${RESET}"
                break
                ;;
            "Cancelar")
                echo -e "${BRIGHT_YELLOW}Operação cancelada pelo usuário.${RESET}"
                exit 0
                ;;
            *)
                # A variável $REPLY contém a entrada do usuário se não corresponder a um número de opção
                echo -e "${BRIGHT_RED}Opção inválida '$REPLY'. Tente novamente.${RESET}"
                ;;
        esac
    done

    # Verifica se NODE_ENV foi definido (caso o usuário pressione Ctrl+D ou outra interrupção no select)
    if [ -z "$NODE_ENV" ]; then
        echo -e "${BRIGHT_RED}Nenhum ambiente foi selecionado. Saindo sem inicializar.${RESET}"
        exit 1
    fi
fi

echo ""
type_echo "Preparando para inicializar o índice..." "${BRIGHT_BLUE}${BOLD}"

# Caminho para o script de inicialização. Pode ser sobrescrito pela variável de ambiente OMNIZAP_INIT_SCRIPT.
DEFAULT_INIT_SCRIPT_PATH="./src/connection/index.js"
INIT_SCRIPT_PATH="${OMNIZAP_INIT_SCRIPT:-$DEFAULT_INIT_SCRIPT_PATH}"

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

# Verifica se Node.js está instalado
if ! command -v node >/dev/null 2>&1; then
    type_echo "Erro: Node.js não encontrado. Por favor, instale o Node.js para continuar." "${BRIGHT_RED}${BOLD}"
    exit 1
fi

if [ -f "$INIT_SCRIPT_PATH" ]; then
    echo -n -e "${BRIGHT_CYAN}🚀 Executando: node $INIT_SCRIPT_PATH (NODE_ENV=${BOLD}$NODE_ENV${RESET}${BRIGHT_CYAN})... ${RESET}"

    # O 'export NODE_ENV' acima garante que o processo filho (node) herde a variável.
    node "$INIT_SCRIPT_PATH" &
    NODE_PID=$!

    spinner $NODE_PID # Mostra o spinner enquanto o node executa

    wait $NODE_PID # Aguarda o processo node terminar
    exit_code=$?

    if [ $exit_code -eq 0 ]; then
        echo -e "${BRIGHT_GREEN}${BOLD}✓ Sucesso!${RESET}"
        type_echo "Script de inicialização do índice concluído." "${BRIGHT_GREEN}"
    else
        echo -e "${BRIGHT_RED}${BOLD}✗ Falha!${RESET}"
        type_echo "Script de inicialização do índice falhou com o código de saída: $exit_code." "${BRIGHT_RED}"
        exit $exit_code # Propaga o código de erro
    fi
else
    type_echo "Erro: Script de inicialização não encontrado em '$INIT_SCRIPT_PATH'." "${BRIGHT_RED}${BOLD}"
    type_echo "Verifique o caminho, o nome do arquivo ou a variável de ambiente OMNIZAP_INIT_SCRIPT." "${BRIGHT_YELLOW}"
    echo -e "${BRIGHT_RED}Nenhuma ação de inicialização foi executada.${RESET}"
    exit 1 # Sair com erro se o script não for encontrado
fi

exit 0 # Sair com sucesso se tudo correu bem