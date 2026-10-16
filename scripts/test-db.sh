#!/usr/bin/env bash
# Throwaway PostgreSQL pair for AccessLease tests (QA-owned).
#
#   scripts/test-db.sh up [RUN_ID]      start two postgres:17 containers, print `export` lines on stdout
#   scripts/test-db.sh down RUN_ID      stop and remove exactly this run's containers (and nothing else)
#   scripts/test-db.sh env RUN_ID       re-print the export lines for a running pair
#   scripts/test-db.sh status RUN_ID    list this run's containers
#   scripts/test-db.sh with -- CMD...   up, run CMD with the env exported, always down afterwards (exit code of CMD)
#   scripts/test-db.sh exec RUN_ID -- CMD...  run CMD against an already running pair (env exported, pair left running)
#   scripts/test-db.sh list             list every accesslease-test=1 container (read-only)
#
# Two disposable servers per run:
#   al-meta-<run>  metadata store          -> ACCESSLEASE_TEST_DATABASE_URL
#   al-prov-<run>  provider target cluster -> ACCESSLEASE_TEST_PROVIDER_DATABASE_URL (target of the real `postgres-role` provider)
# Containers carry the label accesslease-test=1, publish only to 127.0.0.1 on random host ports, are capped at 768 MB,
# use random credentials, and are removed on stop (--rm). Other containers are never touched; no prune is ever run.
# Test files create uniquely named databases/roles inside these servers (tests/helpers/db.ts), so concurrent
# agents sharing a pair, or each owning one, never collide.
set -euo pipefail

IMAGE="${ACCESSLEASE_TEST_PG_IMAGE:-postgres:17-alpine}"
LABEL="accesslease-test=1"

rand() { node -e 'process.stdout.write(require("crypto").randomBytes(+process.argv[1]).toString("hex"))' "$1"; }

names() { # RUN_ID -> sets META PROV
  META="al-meta-$1"
  PROV="al-prov-$1"
}

wait_ready() {
  local name="$1" user="$2"
  for _ in $(seq 1 90); do
    # pg_isready answers during the init-time temporary server; require a real query twice, a second apart.
    if docker exec "$name" psql -U "$user" -d postgres -Atc 'select 1' >/dev/null 2>&1; then
      sleep 1
      docker exec "$name" psql -U "$user" -d postgres -Atc 'select 1' >/dev/null 2>&1 && return 0
    fi
    sleep 1
  done
  echo "test-db: $name did not become ready" >&2
  return 1
}

host_port() { docker port "$1" 5432/tcp | head -1 | sed 's/.*://'; }

secret_of() { docker inspect "$1" --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^POSTGRES_PASSWORD=//p'; }

print_env() { # RUN_ID
  names "$1"
  local mp pp mpw ppw
  mp="$(host_port "$META")"; pp="$(host_port "$PROV")"
  mpw="$(secret_of "$META")"; ppw="$(secret_of "$PROV")"
  printf 'export ACCESSLEASE_TEST_RUN_ID=%q\n' "$1"
  printf 'export ACCESSLEASE_TEST_DATABASE_URL=%q\n' "postgres://al_admin:${mpw}@127.0.0.1:${mp}/postgres"
  printf 'export ACCESSLEASE_TEST_PROVIDER_DATABASE_URL=%q\n' "postgres://al_admin:${ppw}@127.0.0.1:${pp}/postgres"
  printf 'export ACCESSLEASE_TEST_PROVIDER_CONTAINER=%q\n' "$PROV"
  printf 'export ACCESSLEASE_TEST_META_CONTAINER=%q\n' "$META"
}

start_one() { # container-name
  local name="$1" pw
  pw="$(rand 18)"
  docker run --rm -d --name "$name" --label "$LABEL" \
    --memory 768m --memory-swap 768m \
    -e POSTGRES_USER=al_admin -e POSTGRES_PASSWORD="$pw" \
    -p 127.0.0.1::5432 "$IMAGE" -c max_connections=100 -c fsync=off -c synchronous_commit=off >/dev/null
}

cmd_up() {
  local run="${1:-$(rand 4)}"
  [[ "$run" =~ ^[a-f0-9]{4,16}$ ]] || { echo "test-db: RUN_ID must be 4-16 lowercase hex characters" >&2; exit 2; }
  names "$run"
  if docker inspect "$META" >/dev/null 2>&1 || docker inspect "$PROV" >/dev/null 2>&1; then
    echo "test-db: run ${run} already exists; use env/down" >&2; exit 2
  fi
  start_one "$META"
  start_one "$PROV"
  wait_ready "$META" al_admin
  wait_ready "$PROV" al_admin
  print_env "$run"
}

cmd_down() {
  local run="${1:?RUN_ID required}"
  names "$run"
  for n in "$META" "$PROV"; do
    # Only ever stop containers that carry our label.
    if [[ "$(docker inspect "$n" --format '{{index .Config.Labels "accesslease-test"}}' 2>/dev/null || true)" == "1" ]]; then
      docker stop -t 3 "$n" >/dev/null 2>&1 || true
      docker rm -f "$n" >/dev/null 2>&1 || true
    fi
  done
  echo "test-db: run ${run} removed" >&2
}

# Globals (not locals): the EXIT/TERM traps run after the function body, when locals no longer exist, which under `set -u` used to fail with
# "run: unbound variable", leak the pair and flip the exit code. The wrapped command runs in the background and is waited for, so SIGTERM/SIGINT
# delivered to this script is handled immediately (a foreground child would defer the trap). Only this call's own run id is ever torn down.
WITH_RUN=""
WITH_ENVFILE=""
WITH_CHILD=""

with_cleanup() {
  local status=$?
  trap - EXIT TERM INT
  if [[ -n "${WITH_CHILD:-}" ]]; then kill "${WITH_CHILD}" 2>/dev/null || true; fi
  if [[ -n "${WITH_RUN:-}" ]]; then cmd_down "${WITH_RUN}" >/dev/null 2>&1 || true; fi
  if [[ -n "${WITH_ENVFILE:-}" ]]; then rm -f "${WITH_ENVFILE}"; fi
  exit "$status"
}

cmd_with() {
  [[ "${1:-}" == "--" ]] && shift
  [[ $# -gt 0 ]] || { echo "usage: test-db.sh with -- CMD..." >&2; exit 2; }
  WITH_RUN="$(rand 4)"
  WITH_ENVFILE="$(mktemp)"
  trap with_cleanup EXIT
  trap 'exit 143' TERM
  trap 'exit 130' INT
  cmd_up "$WITH_RUN" >"$WITH_ENVFILE"
  # shellcheck disable=SC1090
  source "$WITH_ENVFILE"
  rm -f "$WITH_ENVFILE"
  WITH_ENVFILE=""
  local rc=0
  "$@" &
  WITH_CHILD=$!
  wait "$WITH_CHILD" || rc=$?
  WITH_CHILD=""
  exit "$rc"
}

case "${1:-}" in
  up) cmd_up "${2:-}" ;;
  down) cmd_down "${2:-}" ;;
  env) print_env "${2:?RUN_ID required}" ;;
  status) docker ps --filter "label=${LABEL}" --filter "name=${2:?RUN_ID required}" --format '{{.Names}} {{.Status}} {{.Ports}}' ;;
  with) shift; cmd_with "$@" ;;
  exec) # exec RUN_ID -- CMD...: run CMD against an already running pair
    run="${2:?RUN_ID required}"; shift 2; [[ "${1:-}" == "--" ]] && shift
    envfile="$(mktemp)"; print_env "$run" >"$envfile"
    # shellcheck disable=SC1090
    source "$envfile"; rm -f "$envfile"
    exec "$@" ;;
  list) docker ps -a --filter "label=${LABEL}" --format '{{.Names}} {{.Status}} {{.Ports}}' ;;
  *) sed -n '2,12p' "$0" >&2; exit 2 ;;
esac
