#!/usr/bin/env bash
set -euo pipefail

fail() { printf '%s\n' "$1" >&2; exit 1; }

[[ $# == 2 ]] || fail 'Usage: package-windows-sidecar.sh <Windows Node ZIP> <new output directory>'
[[ $(uname -s) == MINGW* && $(uname -m) == x86_64 ]] || fail 'Use native Windows x64 Git Bash.'

archive=$(realpath -e -- "$(cygpath -u "$1")")
output=$(cygpath -u "$2")
parent=$(realpath -e -- "$(dirname -- "$output")")
[[ -d $parent ]] || fail 'The output parent must be an existing directory.'
target="$parent/$(basename -- "$output")"
[[ ! -e $target && ! -L $target ]] || fail 'The output directory must not already exist.'

repo=$(git -C "$(dirname -- "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)
revision=$(git -C "$repo" rev-parse --verify HEAD)
scratch=$(mktemp -d -- "$parent/.factory-sidecar.XXXXXX")
trap 'rm -rf -- "$scratch"' EXIT

cp -- "$archive" "$scratch/node.zip"
read -r checksum _ < <(sha256sum --binary < "$scratch/node.zip")
[[ $checksum == e612af99f626ab415ea225af6bce5c971feb448cb5cae250bb1c3fa50c5f7d9f ]] ||
  fail 'The Windows Node archive does not match the pinned SHA-256.'

release=node-v24.22.3-win-x64
"$(cygpath -u "$SYSTEMROOT")/System32/tar.exe" -xf "$scratch/node.zip" -C "$scratch"
node_home="$scratch/$release"
export PATH="$node_home:$PATH"
[[ $(node -p '`${process.version}:${process.platform}:${process.arch}`') == 'v24.22.3:win32:x64' ]] ||
  fail 'The build did not resolve the pinned native Node runtime.'
node "$node_home/node_modules/npm/bin/npm-cli.js" install --prefix "$scratch/tools" --no-package-lock --ignore-scripts --no-audit --no-fund npm@12.2.3
npm_cli="$scratch/tools/node_modules/npm/bin/npm-cli.js"
[[ $(node "$npm_cli" --version) == 12.2.3 ]] || fail 'The build did not resolve the pinned npm version.'

build="$scratch/build"
staged="$scratch/package"
mkdir -- "$build" "$staged"
git -C "$repo" archive "$revision" -- .npmrc package.json package-lock.json src tsconfig.json tsconfig.base.json \
  tsconfig.build.json vite.config.ts scripts/build-artifacts.sh | tar -xf - -C "$build"
(
  cd "$build"
  node "$npm_cli" ci --include=dev --ignore-scripts --strict-peer-deps --no-audit --no-fund
  BUILD_REVISION="$revision" node "$npm_cli" run build
  rm -- dist/server/identity/copilot-access.js dist/server/tasks/copilot-cloud-trial.js dist/server/tasks/copilot-portal-trial.js
  node "$npm_cli" ci --omit=dev --include=optional --ignore-scripts --strict-peer-deps --no-audit --no-fund
  mv -- dist node_modules package.json "$staged/"
)
cp -- "$node_home/node.exe" "$node_home/LICENSE" "$staged/"
(
  cd "$staged"
  ./node.exe --input-type=module -e '
    import { openDatabase } from "./dist/server/persistence/open.js";
    import { hasCurrentSchema, migrate } from "./dist/server/persistence/migrations.js";
    const db = openDatabase("../staging-smoke.sqlite");
    try {
      migrate(db);
      if (!hasCurrentSchema(db)) throw new Error("Staged database is missing required schema objects.");
    } finally {
      db.close();
    }
  '
)
mv -nT -- "$staged" "$target"
[[ ! -e $staged ]] || fail 'The output directory was created during packaging.'
printf 'Staged Windows x64 runtime for %s in %s\n' "$revision" "$target"
