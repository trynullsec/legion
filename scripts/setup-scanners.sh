#!/usr/bin/env bash
# Provisions Legion's self-contained scan engine into ~/.legion/tools:
#   - gitleaks (pinned release binary)
#   - semgrep  (pinned version in an isolated uv venv)
# Idempotent; safe to re-run (setup-workers.sh precedent).
set -euo pipefail

# ---- pinned versions (record in README) ----
GITLEAKS_VERSION="8.30.1"
SEMGREP_VERSION="1.165.0"

TOOLS="$HOME/.legion/tools"
GITLEAKS_BIN="$TOOLS/gitleaks"
SEMGREP_VENV="$TOOLS/semgrep-venv"
SEMGREP_BIN="$SEMGREP_VENV/bin/semgrep"

mkdir -p "$TOOLS"

# ---- platform detection ----
OS="$(uname -s)"; ARCH="$(uname -m)"
case "$OS" in
  Darwin) GL_OS="darwin" ;;
  Linux)  GL_OS="linux" ;;
  *) echo "error: unsupported OS $OS" >&2; exit 1 ;;
esac
case "$ARCH" in
  arm64|aarch64) GL_ARCH="arm64" ;;
  x86_64|amd64)  GL_ARCH="x64" ;;
  *) echo "error: unsupported arch $ARCH" >&2; exit 1 ;;
esac

# ---- gitleaks ----
installed_gl=""
if [ -x "$GITLEAKS_BIN" ]; then
  installed_gl="$("$GITLEAKS_BIN" version 2>/dev/null || true)"
fi
if [ "$installed_gl" != "$GITLEAKS_VERSION" ]; then
  url="https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_${GL_OS}_${GL_ARCH}.tar.gz"
  echo "[setup-scanners] downloading gitleaks ${GITLEAKS_VERSION} (${GL_OS}/${GL_ARCH})"
  tmp="$(mktemp -d)"
  curl -fsSL "$url" -o "$tmp/gitleaks.tar.gz"
  tar -xzf "$tmp/gitleaks.tar.gz" -C "$tmp" gitleaks
  mv "$tmp/gitleaks" "$GITLEAKS_BIN"
  chmod +x "$GITLEAKS_BIN"
  rm -rf "$tmp"
else
  echo "[setup-scanners] gitleaks ${GITLEAKS_VERSION} already present"
fi

# ---- semgrep (isolated venv) ----
if ! command -v uv >/dev/null 2>&1; then
  echo "error: uv is required (https://docs.astral.sh/uv/)" >&2
  exit 1
fi
installed_sg=""
if [ -x "$SEMGREP_BIN" ]; then
  installed_sg="$("$SEMGREP_BIN" --version 2>/dev/null || true)"
fi
if [ "$installed_sg" != "$SEMGREP_VERSION" ]; then
  echo "[setup-scanners] installing semgrep ${SEMGREP_VERSION}"
  uv venv --python 3.11 --allow-existing "$SEMGREP_VENV"
  uv pip install --python "$SEMGREP_VENV/bin/python" --quiet "semgrep==${SEMGREP_VERSION}"
else
  echo "[setup-scanners] semgrep ${SEMGREP_VERSION} already present"
fi

# ---- smoke checks ----
echo "[setup-scanners] gitleaks: $("$GITLEAKS_BIN" version)"
echo "[setup-scanners] semgrep:  $("$SEMGREP_BIN" --version)"
echo "[setup-scanners] done"
