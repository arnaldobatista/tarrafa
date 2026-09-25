#!/usr/bin/env bash
# Remove o registro do host nativo da Tarrafa.
set -euo pipefail
NOME="com.arnaldo.tarrafa"
n=0
source "$(dirname "$0")/navegadores.sh"
for dir in "${DESTINOS[@]}"; do
  if [ -f "$dir/$NOME.json" ]; then
    rm "$dir/$NOME.json"
    echo "  removido: $dir/$NOME.json"
    n=$((n+1))
  fi
done
APP="$HOME/Library/Application Support/Tarrafa"
if [ -d "$APP" ]; then
  rm -rf "$APP"
  echo "  removido: $APP"
fi
echo "$n manifesto(s) removido(s). Remova a extensão em chrome://extensions."
