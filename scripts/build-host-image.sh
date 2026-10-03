#!/usr/bin/env bash
# Builds the assistant host image (deploy/host/Dockerfile) from the host bundle
# and the plugin's CPython-WASM assets. Usage: scripts/build-host-image.sh [TAG]
set -euo pipefail
cd "$(dirname "$0")/.."
tag="${1:-grafana-assistant-host:dev}"
if [[ ! -d dist/cpython ]]; then
  echo "dist/cpython is missing; run npm run build (or build:variant) first" >&2
  exit 1
fi
npm run -s build:host
context="$(mktemp -d)"
trap 'rm -rf "$context"' EXIT
mkdir -p "$context/dist" "$context/node_modules"
cp -R dist-host "$context/"
cp -R dist/cpython "$context/dist/"
cp -R node_modules/jq-wasm "$context/node_modules/"
docker build -f deploy/host/Dockerfile -t "$tag" "$context"
echo "built $tag"
