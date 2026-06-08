#!/usr/bin/env bash
#
# Dependency-free migration runner for @pma/storage.
#
# Applies every `NNN_*.sql` file in this directory, in lexicographic order,
# against the database in $DATABASE_URL using the `psql` client. Each migration
# runs inside a single transaction (ON_ERROR_STOP), and applied files are
# recorded in a `schema_migrations` table so re-runs are idempotent (already
# applied files are skipped).
#
# No npm / ORM dependencies — just the standard PostgreSQL `psql` client, which
# ships with Postgres and the timescale/timescaledb docker image.
#
# Usage:
#   DATABASE_URL=postgres://pma:pma@localhost:5432/pma ./apply.sh
#
# Or via the package script:
#   npm run migrate --workspace @pma/storage
#
# Environment:
#   DATABASE_URL   Postgres connection string (required).
#                  Defaults to the docker-compose.yml dev value if unset.

set -euo pipefail

DATABASE_URL="${DATABASE_URL:-postgres://pma:pma@localhost:5432/pma}"
MIGRATIONS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v psql >/dev/null 2>&1; then
  echo "error: psql is not installed or not on PATH" >&2
  echo "       install the PostgreSQL client, or run psql inside the container:" >&2
  echo "       docker compose exec -T postgres psql ..." >&2
  exit 1
fi

PSQL=(psql "$DATABASE_URL" --quiet --no-psqlrc --set ON_ERROR_STOP=1)

echo "Applying migrations from: $MIGRATIONS_DIR"
echo "Target database: ${DATABASE_URL%%\?*}"

# Bookkeeping table: tracks which migration files have been applied.
"${PSQL[@]}" --command \
  "CREATE TABLE IF NOT EXISTS schema_migrations (
     filename   TEXT PRIMARY KEY,
     applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
   );"

shopt -s nullglob
applied_count=0
for migration in "$MIGRATIONS_DIR"/[0-9]*.sql; do
  filename="$(basename "$migration")"

  already_applied="$("${PSQL[@]}" --tuples-only --no-align --command \
    "SELECT 1 FROM schema_migrations WHERE filename = '$filename';")"

  if [ "$already_applied" = "1" ]; then
    echo "  skip   $filename (already applied)"
    continue
  fi

  echo "  apply  $filename"
  # Run the migration and record it in one transaction: if the SQL fails,
  # nothing is committed and the bookkeeping row is not written.
  "${PSQL[@]}" --single-transaction \
    --file "$migration" \
    --command "INSERT INTO schema_migrations (filename) VALUES ('$filename');"
  applied_count=$((applied_count + 1))
done

echo "Done. Applied $applied_count new migration(s)."
