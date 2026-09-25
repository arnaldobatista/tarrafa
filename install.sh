#!/usr/bin/env bash
# Registra o host nativo da Tarrafa nos navegadores baseados em Chromium.
set -euo pipefail

AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST_DIR="$AQUI/host"
HOST_JS="$HOST_DIR/host.js"
NOME="com.arnaldo.tarrafa"
EXT_ID="$(cat "$HOST_DIR/extid.txt")"

azul() { printf "\033[36m%s\033[0m\n" "$1"; }
ok()   { printf "  \033[32m✓\033[0m %s\n" "$1"; }
erro() { printf "  \033[31m✗\033[0m %s\n" "$1"; }

azul "Tarrafa — instalação do host nativo"
echo

# ---------------------------------------------------------- 1. ferramentas
achar() {
  for d in /opt/homebrew/bin /usr/local/bin /usr/bin /bin /opt/local/bin "$HOME/.local/bin"; do
    [ -x "$d/$1" ] && { echo "$d/$1"; return 0; }
  done
  command -v "$1" 2>/dev/null || true
}

NODE="$(achar node)"
YTDLP="$(achar yt-dlp)"
FFMPEG="$(achar ffmpeg)"
DENO="$(achar deno)"

[ -n "$NODE" ] || { erro "node não encontrado — instale com: brew install node"; exit 1; }
ok "node    $NODE"

if [ -n "$YTDLP" ]; then ok "yt-dlp  $YTDLP"; else
  erro "yt-dlp não encontrado — instale com: brew install yt-dlp"; exit 1
fi

if [ -n "$FFMPEG" ]; then ok "ffmpeg  $FFMPEG"; else
  erro "ffmpeg não encontrado — sem ele a Tarrafa não junta áudio + vídeo"
  echo "        instale com: brew install ffmpeg"
fi

# O YouTube assina as URLs de mídia com um desafio em JavaScript. Sem um runtime
# para resolvê-lo, o yt-dlp entrega URLs sem assinatura e o YouTube responde 403.
if [ -n "$DENO" ]; then ok "deno    $DENO"; else
  erro "deno não encontrado — downloads do YouTube vão falhar com 403"
  echo "        instale com: brew install deno"
fi

cat > "$HOST_DIR/config.json" <<JSON
{
  "yt-dlp": "$YTDLP",
  "ffmpeg": "$FFMPEG",
  "deno": "$DENO"
}
JSON

# ------------------------------------------------------- 2. implantar o host
# O host NÃO pode morar em ~/Documents, ~/Desktop ou ~/Downloads: o macOS gateia
# essas pastas por TCC e o Chrome não consegue executar nada lá dentro — ele
# falha com "Native host has exited", sem deixar rastro. Por isso instalamos
# numa pasta de aplicação, e o repositório fica só como fonte.
DESTINO_HOST="$HOME/Library/Application Support/Tarrafa"
mkdir -p "$DESTINO_HOST"

# O Chrome roda o host com um PATH mínimo: fixamos o node absoluto no shebang.
{ echo "#!$NODE"; tail -n +2 "$HOST_JS"; } > "$DESTINO_HOST/host.js"
cp "$HOST_DIR/config.json" "$DESTINO_HOST/config.json"
chmod 755 "$DESTINO_HOST/host.js"
HOST_INSTALADO="$DESTINO_HOST/host.js"
ok "host implantado em ~/Library/Application Support/Tarrafa/"

# --------------------------------------------- 3. registrar nos navegadores
source "$(dirname "$0")/navegadores.sh"

echo
instalados=0
for dir in "${DESTINOS[@]}"; do
  pai="$(dirname "$dir")"
  [ -d "$pai" ] || continue
  mkdir -p "$dir"
  cat > "$dir/$NOME.json" <<JSON
{
  "name": "$NOME",
  "description": "Tarrafa — host nativo (yt-dlp/ffmpeg)",
  "path": "$HOST_INSTALADO",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://$EXT_ID/"
  ]
}
JSON
  # "Arc/User Data" virava só "User Data" — foi o que escondeu o Arc por tanto tempo.
  navegador="${dir#"$HOME/Library/Application Support/"}"
  navegador="${navegador%/NativeMessagingHosts}"
  navegador="${navegador%/User Data}"
  ok "registrado em $navegador"
  instalados=$((instalados + 1))
done

if [ "$instalados" -eq 0 ]; then
  erro "nenhum navegador Chromium encontrado em ~/Library/Application Support"
  exit 1
fi

echo
azul "Pronto. Agora carregue a extensão:"
cat <<FIM

  1. abra  chrome://extensions
  2. ligue o "Modo do desenvolvedor" (canto superior direito)
  3. clique em "Carregar sem compactação"
  4. escolha a pasta:

       $AQUI/extension

  O ID vai ser exatamente este (está fixado pela chave no manifest):

       $EXT_ID

  Se você já tinha carregado a extensão, clique no botão de recarregar
  dela em chrome://extensions para ela reconectar no host.

  Sempre que mexer em host/host.js, rode ./install.sh de novo — é ele que
  copia a versão nova para a pasta de onde o Chrome consegue executar.

FIM
