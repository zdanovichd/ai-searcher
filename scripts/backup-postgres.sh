#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

: "${DATABASE_URL:?Задайте DATABASE_URL в .env}"

BACKUP_DIR="${PG_BACKUP_DIR:-$PROJECT_ROOT/backups/postgres}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT_FILE="$BACKUP_DIR/ai-searcher-$STAMP.sql.gz"

mkdir -p "$BACKUP_DIR"
pg_dump "$DATABASE_URL" --no-owner --no-privileges | gzip -9 > "$OUT_FILE"

find "$BACKUP_DIR" -type f -name 'ai-searcher-*.sql.gz' -mtime +"${PG_BACKUP_RETENTION_DAYS:-14}" -delete

echo "Бэкап: $OUT_FILE"
