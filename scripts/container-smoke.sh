#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."

case "${1:-}" in
  podman|both) mode=$1 ;;
  *) printf 'Usage: bash scripts/container-smoke.sh {podman|both} <registry-npmrc> [--browser]\n' >&2; exit 2 ;;
esac
[[ $# -ge 2 && $# -le 3 && -f $2 && ( $# -eq 2 || $3 == --browser ) ]] || exit 2
npm_config=$2
browser=${3:-}

# Windows CLI clients need native paths; Linux container and VM arguments must remain untouched.
export MSYS2_ARG_CONV_EXCL='*'
native_path() {
  if command -v cygpath >/dev/null; then cygpath -am -- "$1"; else realpath -- "$1"; fi
}
vm_path() {
  local path
  path=$(native_path "$1")
  case "$path" in
    [A-Za-z]:/*) local drive=${path:0:1}; printf '/mnt/%s/%s\n' "${drive,,}" "${path:3}" ;;
    *) printf '%s\n' "$path" ;;
  esac
}
ssh_command() {
  local arg
  for arg; do printf "'%s' " "${arg//\'/\'\\\'\'}"; done
}

if command -v cygpath >/dev/null; then
  machine=$(command podman machine list --format '{{.Name}} {{.Running}}' |
    awk '$2=="true" && $1 ~ /\*$/ {sub(/\*$/, "", $1); print $1; exit}')
  [[ -n $machine ]] || { printf 'The default Podman machine is not running.\n' >&2; exit 1; }
  connection=$(command podman system connection list --format '{{.Name}} {{.URI}}' |
    awk -v name="$machine" '$1==name {print $2}')
  [[ $connection =~ ^ssh://user@127\.0\.0\.1:[0-9]+/run/user/1000/podman/podman\.sock$ ]] ||
    { printf 'The default Podman machine needs an explicit local rootless connection.\n' >&2; exit 1; }
  podman() { command podman --connection "$machine" "$@"; }
else
  podman() { env -u CONTAINER_HOST -u CONTAINER_CONNECTION podman --remote=false "$@"; }
fi

scratch=$(mktemp -d "$PWD/.smoke.XXXXXX")
token="sf-smoke-${scratch##*.}"
token=${token,,}
tag="localhost/software-factory:$token"
fixture=src/server/persistence/open.image.test.ts
podman_names=("$token" "$token-fail")
moby_names=("$token" "$token-job")
volumes=("$token-data" "$token-restore")
moby_loaded=false
podman_built=false
public_fixture="src/web/public/$token.txt"
made_public=false

moby() { rdctl shell curl -fsS --unix-socket /var/run/docker.sock "$@"; }
api() { local method=$1 path=$2; shift 2; moby -X "$method" "http://localhost$path" "$@"; }
create() {
  api POST "/containers/create?name=$1" -H 'Content-Type: application/json' --data-binary "$2" >/dev/null
  api POST "/containers/$1/start" >/dev/null
}
forget() { api DELETE "/containers/$1?force=true" >/dev/null; }
archive_config_id() {
  local archive=$1 config
  config=$(tar -xOf "$archive" manifest.json | sed -n 's/.*"Config":[[:space:]]*"\([^"]*\)".*/\1/p')
  [[ -n $config ]] || return 1
  tar -xOf "$archive" "$config" | sha256sum | cut -d ' ' -f 1
}

cleanup() {
  local name
  if $podman_built; then
    for name in "${podman_names[@]}"; do podman rm -f "$name" >/dev/null 2>&1 || :; done
    for name in "${volumes[@]}"; do podman volume rm "$name" >/dev/null 2>&1 || :; done
    podman rmi "$tag" >/dev/null 2>&1 || :
  fi
  if $moby_loaded; then
    for name in "${moby_names[@]}"; do forget "$name" 2>/dev/null || :; done
    for name in "${volumes[@]}"; do api DELETE "/volumes/$name" >/dev/null 2>&1 || :; done
    api DELETE "/images/$tag" >/dev/null 2>&1 || :
  fi
  rm -f -- "$scratch/image.tar" "$scratch/moby-image.tar" "$public_fixture"
  rmdir -- "$scratch"
  if $made_public; then rmdir -- src/web/public 2>/dev/null || :; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [[ ! -d src/web/public ]]; then mkdir -- src/web/public; made_public=true; fi
printf 'Local files must not be packaged.\n' > "$public_fixture"
if command -v cygpath >/dev/null; then
  # Podman's Windows client expects the native OpenSSH executable, not the MSYS shim.
  openssh="$(cygpath -u "${SYSTEMROOT:-C:\\Windows}")/System32/OpenSSH"
  remote=$(ssh_command podman build --format docker --file Containerfile --tag "$tag" \
    --secret "id=npm_config,src=$(vm_path "$npm_config")" "$(vm_path "$PWD")")
  PATH="$openssh:$PATH" command podman machine ssh "$machine" "$remote"
else
  podman build --format docker --file Containerfile --tag "$tag" \
    --secret "id=npm_config,src=$(native_path "$npm_config")" .
fi
podman image exists "$tag"
podman_built=true

curl_portal() {
  if [[ $engine == podman ]]; then curl "$@"; else rdctl shell curl "$@"; fi
}

portal() {
  local volume=$1
  if [[ $engine == podman ]]; then
    podman run -d --name "$token" --read-only --cap-drop ALL --security-opt no-new-privileges \
      --stop-timeout 10 -v "$volume:/data" -p '127.0.0.1::3000' "$tag" >/dev/null
    address=$(podman port "$token" 3000/tcp)
  else
    create "$token" "{\"Image\":\"$tag\",\"StopTimeout\":10,\"HostConfig\":{
      \"ReadonlyRootfs\":true,\"CapDrop\":[\"ALL\"],\"SecurityOpt\":[\"no-new-privileges\"],
      \"Binds\":[\"$volume:/data\"],\"PortBindings\":{\"3000/tcp\":[{\"HostIp\":\"127.0.0.1\",\"HostPort\":\"\"}]}}}"
    address=127.0.0.1:$(api GET "/containers/$token/json" |
      sed -n 's/.*"HostPort":"\([0-9][0-9]*\)".*/\1/p')
  fi
  origin="http://$address"
  local attempt
  for ((attempt=0; attempt<40; attempt++)); do
    if curl_portal -fsS --max-time 2 "$origin/healthz" 2>/dev/null | grep -q '"status":"ok"'; then return; fi
    sleep .25
  done
  printf '%s did not reach readiness at %s\n' "$engine" "$origin" >&2
  return 1
}

stop_portal() {
  if [[ $engine == podman ]]; then
    podman stop -t 10 "$token" >/dev/null
    [[ $(podman inspect --format '{{.State.ExitCode}}' "$token") == 0 ]]
    podman rm "$token" >/dev/null
  else
    api POST "/containers/$token/stop?t=10" >/dev/null
    api POST "/containers/$token/wait" | grep -q '"StatusCode":0'
    forget "$token"
  fi
}

mount_job() {
  local volume=$1 operation=$2 other=${3:-} user=node
  local binds="\"$volume:/data\""
  local -a args=(-v "$volume:/data")
  if [[ -n $other ]]; then args+=(-v "$other:/backup"); binds+=",\"$other:/backup\""; fi
  local entry command call
  case "$operation" in
    prepare) user=0:0; entry=sh; command='chown 1000:1000 /data && chmod 700 /data'; call="[\"-ec\",\"$command\"]" ;;
    readonly) user=0:0; entry=chmod; command='/data/factory.sqlite'; call="[\"400\",\"$command\"]" ;;
    *) entry=node; command=/fixture.test.ts; call="[\"$command\",\"$operation\"]" ;;
  esac

  if [[ $engine == podman ]]; then
    case "$operation" in
      prepare) podman run --rm "${args[@]}" --user "$user" --entrypoint "$entry" "$tag" -ec "$command" ;;
      readonly) podman run --rm "${args[@]}" --user "$user" --entrypoint "$entry" "$tag" 400 "$command" ;;
      *) podman run --rm "${args[@]}" --mount "type=bind,source=$(native_path "$fixture"),target=$command,ro=true" \
        --entrypoint node "$tag" "$command" "$operation" ;;
    esac
  else
    if [[ $user == node ]]; then binds+=",\"$(vm_path "$fixture"):/fixture.test.ts:ro\""; fi
    create "$token-job" "{\"Image\":\"$tag\",\"User\":\"$user\",\"Entrypoint\":[\"$entry\"],\"Cmd\":$call,
      \"HostConfig\":{\"Binds\":[$binds]}}"
    api POST "/containers/$token-job/wait" | grep -q '"StatusCode":0'
    forget "$token-job"
  fi
}

expect_bad_storage() {
  local name="$token-fail" volume=${1:-} options='{}' state attempt
  if [[ $engine == podman ]]; then
    local -a args=(--env FACTORY_DATA_DIR=/tmp)
    if [[ -n $volume ]]; then args=(-v "$volume:/data"); fi
    podman run -d --name "$name" "${args[@]}" "$tag" >/dev/null
  else
    name=$token-job
    if [[ -n $volume ]]; then options="{\"HostConfig\":{\"Binds\":[\"$volume:/data\"]}}"
    else options='{"Env":["FACTORY_DATA_DIR=/tmp"]}'; fi
    create "$name" "{\"Image\":\"$tag\",${options:1}"
  fi
  for ((attempt=0; attempt<20; attempt++)); do
    if [[ $engine == podman ]]; then
      state=$(podman inspect --format '{{.State.Status}} {{.State.ExitCode}}' "$name")
      if [[ $state == 'exited 1' ]]; then podman rm "$name" >/dev/null; return; fi
    elif api GET "/containers/$name/json" | grep -q '"Status":"exited","Running":false.*"ExitCode":1,'; then
      forget "$name"
      return
    fi
    sleep .25
  done
  printf '%s accepted unusable storage or exited unexpectedly\n' "$engine" >&2
  return 1
}

verify_engine() {
  local data=${volumes[0]} restored=${volumes[1]} volume path code html script_path null_device=/dev/null
  if [[ $engine == podman ]] && command -v cygpath >/dev/null; then null_device=NUL; fi
  for volume in "$data" "$restored"; do
    if [[ $engine == podman ]]; then podman volume create "$volume" >/dev/null
    else api POST /volumes/create -H 'Content-Type: application/json' --data-binary "{\"Name\":\"$volume\"}" >/dev/null; fi
    mount_job "$volume" prepare
  done
  expect_bad_storage
  portal "$data"
  html=$(curl_portal -fsS -H 'Accept: text/html' "$origin/connections/example/issues")
  script_path=$(grep -oE '/assets/[^" ]+\.js' <<< "$html")
  [[ -n $(curl_portal -fsS "$origin$script_path") ]]
  curl_portal -fsS "$origin/api/build" | grep -q '"revision":null,"builtAt":null,"runUrl":null'
  for path in /api/missing /auth/github/callback /assets/missing.js "/$token.txt"; do
    code=$(curl_portal -sS -o "$null_device" -w '%{http_code}' -H 'Accept: text/html' "$origin$path")
    [[ $code == 404 ]]
  done
  if [[ $engine == podman ]]; then
    podman exec "$token" sh -ec 'test "$(id -u)" != 0 && test ! -e /app/src && test ! -e /app/.npmrc &&
      test ! -e "/app/dist/web/$1" && timeout 2 bash /app/healthcheck.sh' sh "$token.txt"
    if [[ $browser == --browser ]]; then FACTORY_SMOKE_URL=$origin npm run test:browser; fi
  fi
  stop_portal
  mount_job "$data" seed
  portal "$data"
  mount_job "$data" check
  mount_job "$data" backup "$restored"
  stop_portal
  portal "$restored"
  mount_job "$restored" check
  stop_portal
  mount_job "$restored" readonly
  expect_bad_storage "$restored"
  printf '%s smoke passed: readiness, route boundaries, shutdown, replacement, and SQLite online backup/restore.\n' "$engine"
}

engine=podman
verify_engine
if [[ $mode == both ]]; then
  [[ $(api GET /_ping) == OK ]]
  podman save --format docker-archive --output "$(native_path "$scratch")/image.tar" "$tag"
  archive_id=$(archive_config_id "$scratch/image.tar")
  origin_id=$(podman image inspect --format '{{.Id}}' "$tag")
  [[ ${origin_id#sha256:} == "$archive_id" ]] || { printf 'Archive config differs from the built image.\n' >&2; exit 1; }
  moby_loaded=true
  api POST '/images/load?quiet=true' -H 'Content-Type: application/x-tar' \
    --data-binary "@$(vm_path "$scratch/image.tar")" >/dev/null
  # Engine IDs differ; the exported config includes both runtime settings and root filesystem digests.
  api GET "/images/$tag/get" -o "$(vm_path "$scratch/moby-image.tar")"
  [[ $(archive_config_id "$scratch/moby-image.tar") == "$archive_id" ]] ||
    { printf 'Rancher imported a different image config or root filesystem.\n' >&2; exit 1; }
  engine=rancher-moby
  verify_engine
fi
