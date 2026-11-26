#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C

fail() { printf 'Invalid %s\n' "$1" >&2; exit 1; }

revision=${BUILD_REVISION:-}
built_at=${BUILD_TIMESTAMP:-}
run_url=${BUILD_RUN_URL:-}
run_pattern='^https://github\.com/arolariu/software-factory/actions/runs/[1-9][0-9]*(/attempts/[1-9][0-9]*)?$'
timestamp_pattern='^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{3})?Z$'

[[ -z $revision || $revision =~ ^[0-9a-f]{40}$ ]] || fail BUILD_REVISION
[[ -z $run_url || $run_url =~ $run_pattern ]] || fail BUILD_RUN_URL
if [[ -n $built_at ]]; then
  [[ $built_at =~ $timestamp_pattern ]] || fail BUILD_TIMESTAMP
  if [[ ${#built_at} -eq 20 ]]; then built_at="${built_at%Z}.000Z"; fi
  normalized=$(date -u -d "$built_at" '+%Y-%m-%dT%H:%M:%S.%3NZ' 2>/dev/null) || fail BUILD_TIMESTAMP
  [[ $normalized == "$built_at" ]] || fail BUILD_TIMESTAMP
fi

json_optional() {
  if [[ -n $1 ]]; then printf '"%s"' "$1"; else printf null; fi
}

cp src/server/persistence/*.sql dist/server/persistence/
printf '{"revision":%s,"builtAt":%s,"runUrl":%s}\n' \
  "$(json_optional "$revision")" "$(json_optional "$built_at")" "$(json_optional "$run_url")" \
  > dist/build.json
