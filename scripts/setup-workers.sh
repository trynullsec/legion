#!/usr/bin/env bash
# Provisions the Hermes worker runtime: a uv-managed Python 3.11 venv at
# <repo>/.venv-workers with the vendored hermes-agent installed.
# Non-interactive; safe to re-run (idempotent).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV="$ROOT/.venv-workers"
VENDOR="$ROOT/vendor/hermes-agent"

if ! command -v uv >/dev/null 2>&1; then
  echo "error: uv is required (https://docs.astral.sh/uv/)" >&2
  exit 1
fi

if [ ! -f "$VENDOR/pyproject.toml" ]; then
  echo "error: vendored hermes-agent missing — run: git submodule update --init" >&2
  exit 1
fi

echo "[setup-workers] creating venv (python 3.11) at $VENV"
uv venv --python 3.11 --allow-existing "$VENV"

echo "[setup-workers] installing vendored hermes-agent"
uv pip install --python "$VENV/bin/python" --quiet "$VENDOR"
# setuptools leaves a build/ artifact inside the source tree — keep the
# vendored checkout pristine (we never modify vendored code).
rm -rf "$VENDOR/build"

echo "[setup-workers] smoke check"
"$VENV/bin/python" -c "import run_agent; print('hermes-agent importable: OK')"

echo "[setup-workers] done"
