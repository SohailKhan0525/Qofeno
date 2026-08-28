#!/usr/bin/env bash
# Qofeno One-Line Installer
# Installs Qofeno Terminal CLI and sets up user environment.
# https://github.com/SohailKhan0525/Qofeno

set -euo pipefail

# ANSI Colors
BOLD="\033[1m"
GREEN="\033[32m"
BLUE="\033[34m"
YELLOW="\033[33m"
RED="\033[31m"
RESET="\033[0m"

echo -e "${BOLD}${BLUE}╔════════════════════════════════════════════════════════════╗${RESET}"
echo -e "${BOLD}${BLUE}║                  QOFENO CLI INSTALLER                      ║${RESET}"
echo -e "${BOLD}${BLUE}╚════════════════════════════════════════════════════════════╝${RESET}"
echo ""

# 1. Platform Detection
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"

case "$ARCH" in
  x86_64|amd64)
    ARCH="x64"
    ;;
  aarch64|arm64)
    ARCH="arm64"
    ;;
  armv7l|armhf)
    ARCH="arm"
    ;;
  *)
    echo -e "${YELLOW}Warning: Unknown architecture $ARCH. Continuing with generic install.${RESET}"
    ;;
esac

echo -e "${BLUE}▶ Detected Platform:${RESET} $OS ($ARCH)"

# 2. Check Node.js
MIN_NODE_VERSION=22
if ! command -v node >/dev/null 2>&1; then
  echo -e "${RED}✗ Node.js is required but was not found on PATH.${RESET}"
  echo -e "Please install Node.js >= $MIN_NODE_VERSION using your package manager or nvm:"
  echo -e "  curl -fsSL https://nodejs.org/install.sh | bash"
  echo -e "  or: nvm install 22 && nvm use 22"
  exit 1
fi

NODE_VERSION="$(node -v | sed 's/v//' | cut -d. -f1)"
if [ "$NODE_VERSION" -lt "$MIN_NODE_VERSION" ]; then
  echo -e "${RED}✗ Found Node.js $(node -v), but Qofeno requires Node.js >= $MIN_NODE_VERSION.${RESET}"
  echo -e "Please update Node.js to version 22 or higher."
  exit 1
fi

echo -e "${GREEN}✓ Node.js $(node -v) satisfies requirement (>= $MIN_NODE_VERSION)${RESET}"

# 3. Determine installation mode
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd || echo "")"
IS_REPO=false
if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/package.json" ] && [ -d "$SCRIPT_DIR/packages/cli" ]; then
  IS_REPO=true
fi

# Determine target binary directory
BIN_DIR="/usr/local/bin"
if [ -n "${PREFIX:-}" ] && [ -d "$PREFIX/bin" ]; then
  # Termux / Android environment
  BIN_DIR="$PREFIX/bin"
elif [ -d "$HOME/.local/bin" ] && [[ ":$PATH:" == *":$HOME/.local/bin:"* ]]; then
  BIN_DIR="$HOME/.local/bin"
elif [ ! -w "$BIN_DIR" ] && [ -d "$HOME/.local/bin" ]; then
  BIN_DIR="$HOME/.local/bin"
fi

if [ "$IS_REPO" = true ]; then
  echo -e "${BLUE}▶ Installing from local source repository...${RESET}"
  cd "$SCRIPT_DIR"
  npm ci --silent
  npm run build
  
  TARGET_BIN="$SCRIPT_DIR/packages/cli/dist/src/main.js"
  chmod +x "$TARGET_BIN"
  
  if [ -w "$BIN_DIR" ]; then
    ln -sf "$TARGET_BIN" "$BIN_DIR/qofeno"
    echo -e "${GREEN}✓ Linked $TARGET_BIN → $BIN_DIR/qofeno${RESET}"
  else
    echo -e "${YELLOW}! $BIN_DIR requires sudo or write permission. Linking with sudo...${RESET}"
    sudo ln -sf "$TARGET_BIN" "$BIN_DIR/qofeno" || {
      mkdir -p "$HOME/.local/bin"
      ln -sf "$TARGET_BIN" "$HOME/.local/bin/qofeno"
      echo -e "${GREEN}✓ Linked $TARGET_BIN → $HOME/.local/bin/qofeno${RESET}"
    }
  fi
else
  echo -e "${BLUE}▶ Installing @agent-qofeno/qofeno-cli from npm registry...${RESET}"
  npm install -g @agent-qofeno/qofeno-cli
fi

# 4. Verify Installation
echo ""
echo -e "${BLUE}▶ Verifying Qofeno installation...${RESET}"
if command -v qofeno >/dev/null 2>&1; then
  INSTALLED_VER="$(qofeno --version 2>/dev/null || node "$SCRIPT_DIR/packages/cli/dist/src/main.js" --version)"
  echo -e "${BOLD}${GREEN}✓ Qofeno v${INSTALLED_VER} successfully installed!${RESET}"
  echo ""
  qofeno doctor || true
  echo ""
  echo -e "${BOLD}${GREEN}Ready to start!${RESET}"
  echo -e "Run ${BOLD}qofeno onboarding${RESET} for the guided setup wizard, or ${BOLD}qofeno${RESET} to begin an interactive session."
else
  # Check if linked in local bin
  if [ -f "$HOME/.local/bin/qofeno" ]; then
    INSTALLED_VER="$("$HOME/.local/bin/qofeno" --version)"
    echo -e "${BOLD}${GREEN}✓ Qofeno v${INSTALLED_VER} installed in $HOME/.local/bin/qofeno${RESET}"
    echo -e "${YELLOW}Note: Make sure $HOME/.local/bin is in your PATH:${RESET}"
    echo -e "  export PATH=\"\$HOME/.local/bin:\$PATH\""
  else
    echo -e "${GREEN}✓ CLI built at $SCRIPT_DIR/packages/cli/dist/src/main.js${RESET}"
  fi
fi
