#!/usr/bin/env bash
# Install/verify script for Super Pi (spi) multi-agent orchestrator

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXTENSION_DIR="$HOME/.pi/agent/extensions/multi-agent-orchestrator"
SPI_BIN="$HOME/.local/bin/spi"

echo "🔧 Super Pi (spi) Installation/Verification"
echo "============================================"
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

check_command() {
    if command -v "$1" >/dev/null 2>&1; then
        echo -e "${GREEN}✓${NC} $1 found: $(which $1)"
        return 0
    else
        echo -e "${RED}✗${NC} $1 not found in PATH"
        return 1
    fi
}

check_file() {
    if [ -f "$1" ]; then
        echo -e "${GREEN}✓${NC} $2"
        return 0
    else
        echo -e "${RED}✗${NC} $2 not found"
        return 1
    fi
}

check_dir() {
    if [ -d "$1" ]; then
        echo -e "${GREEN}✓${NC} $2"
        return 0
    else
        echo -e "${RED}✗${NC} $2 not found"
        return 1
    fi
}

echo "1. Checking required binaries..."
echo "--------------------------------"
check_command "pi" || echo "   Install Pi: https://shittycodingagent.ai/"
check_command "tmux" || echo "   Install tmux: sudo apt-get install tmux (or equivalent)"
check_command "claude" || echo "   Install Claude Code: npm install -g @anthropics/claude-code"
check_command "opencode" || echo "   Install OpenCode: https://opencode.ai/"
check_command "codex" || echo "   Install Codex: npm install -g @openai/codex"
echo ""

echo "2. Checking extension files..."
echo "------------------------------"
check_dir "$EXTENSION_DIR" "Extension directory"
check_file "$EXTENSION_DIR/index.ts" "Extension main file"
check_file "$EXTENSION_DIR/config.json" "Extension config"
check_file "$EXTENSION_DIR/README.md" "Extension documentation"
echo ""

echo "3. Checking spi wrapper..."
echo "--------------------------"
check_file "$SPI_BIN" "spi binary"
if [ -f "$SPI_BIN" ]; then
    if [ -x "$SPI_BIN" ]; then
        echo -e "${GREEN}✓${NC} spi is executable"
    else
        echo -e "${YELLOW}!${NC} spi is not executable, fixing..."
        chmod +x "$SPI_BIN"
        echo -e "${GREEN}✓${NC} Fixed: spi is now executable"
    fi
fi
echo ""

echo "4. Checking PATH..."
echo "-------------------"
if [[ ":$PATH:" == *":$HOME/.local/bin:"* ]]; then
    echo -e "${GREEN}✓${NC} ~/.local/bin is in PATH"
else
    echo -e "${YELLOW}!${NC} ~/.local/bin is NOT in PATH"
    echo "   Add this to your ~/.bashrc or ~/.zshrc:"
    echo '   export PATH="$HOME/.local/bin:$PATH"'
fi
echo ""

echo "5. Checking Kimi configuration..."
echo "---------------------------------"
MODELS_FILE="$HOME/.pi/agent/models.json"
if [ -f "$MODELS_FILE" ]; then
    if grep -q "kimi-coding" "$MODELS_FILE"; then
        echo -e "${GREEN}✓${NC} Kimi provider found in models.json"
        
        # Check if API key is set
        if grep -q '"apiKey".*"sk-' "$MODELS_FILE"; then
            echo -e "${GREEN}✓${NC} API key appears to be configured"
        else
            echo -e "${YELLOW}!${NC} API key might not be configured"
        fi
    else
        echo -e "${RED}✗${NC} Kimi provider not found in models.json"
        echo "   Please configure Kimi in $MODELS_FILE"
    fi
else
    echo -e "${RED}✗${NC} models.json not found"
    echo "   Expected at: $MODELS_FILE"
fi
echo ""

echo "6. Checking Pi settings..."
echo "--------------------------"
PI_SETTINGS="$HOME/.pi/agent/settings.json"
if [ -f "$PI_SETTINGS" ]; then
    echo -e "${GREEN}✓${NC} Pi settings found"
    if grep -q "kimi-coding" "$PI_SETTINGS" || grep -q "k2p5" "$PI_SETTINGS"; then
        echo -e "${GREEN}✓${NC} Kimi appears to be default provider"
    else
        echo -e "${YELLOW}!${NC} Kimi might not be the default provider"
        echo "   You can set it with: pi /provider kimi-coding"
    fi
else
    echo -e "${YELLOW}!${NC} Pi settings not found (will be created on first run)"
fi
echo ""

echo "============================================"
echo ""
echo "To use Super Pi:"
echo "  spi                    # Launch with orchestrator"
echo "  /delegate <task>       # Delegate a task"
echo "  /agents                # Check orchestrator status & models"
echo "  /limits                # Check usage limits"
echo "  /models                # View/set agent models"
echo ""
echo "Regular Pi (unchanged):"
echo "  pi                     # Launch normal Pi"
echo ""
echo "For help:"
echo "  cat $EXTENSION_DIR/README.md"
echo ""
