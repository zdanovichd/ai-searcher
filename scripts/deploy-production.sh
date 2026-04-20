#!/usr/bin/env bash
# Выгрузка на прод: gpt.seo-performance.ru (нужен SSH-доступ root@85.198.69.22)
set -euo pipefail
ROOT="${DEPLOY_USER:-root}@${DEPLOY_HOST:-85.198.69.22}"
REMOTE_DIR="${DEPLOY_DIR:-/var/www/gpt}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$PROJECT_ROOT"
# Важно: не копировать .env — иначе локальный файл перезапишет секреты на сервере (в т.ч. закомментированные строки).
# Логи на сервере тоже не трогаем.
rsync -az --delete \
  --exclude node_modules \
  --exclude .git \
  --exclude .env \
  --exclude logs \
  -e "ssh -o BatchMode=yes" \
  ./ "$ROOT:$REMOTE_DIR/"

ssh -o BatchMode=yes "$ROOT" "cd $REMOTE_DIR && npm ci --omit=dev && pm2 restart ai-searcher --update-env"
echo "Готово: https://gpt.seo-performance.ru"
