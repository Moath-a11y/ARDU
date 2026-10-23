#!/usr/bin/env bash
# =========================================================================
# BARQ LINK — AUTOMATED PRODUCTION CLOUD / VPS DEPLOYMENT SCRIPT
# Tested on: Ubuntu 22.04 / 24.04 LTS & Debian 12 (Oracle Cloud / Any VPS)
# =========================================================================

set -e

echo "=========================================================="
echo "  ⚡ BARQ LINK · PRODUCTION CLOUD SERVER INSTALLATION"
echo "=========================================================="

# 1. Update OS and install prerequisites
echo "📦 [1/6] Updating system packages and installing curl & git..."
sudo apt-get update -y
sudo apt-get install -y curl git build-essential ufw

# 2. Install Node.js 20 LTS
if ! command -v node &> /dev/null; then
    echo "📦 [2/6] Installing Node.js 20 LTS..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
else
    echo "✅ [2/6] Node.js is already installed: $(node -v)"
fi

# 3. Setup Application Directory
APP_DIR="/opt/barq-link"
echo "📂 [3/6] Setting up application in ${APP_DIR}..."
sudo mkdir -p ${APP_DIR}
sudo chown -R $USER:$USER ${APP_DIR}

# Copy files or clone if not already present
if [ -d "./backend" ]; then
    echo "  -> Copying local project files..."
    cp -r ./backend ./frontend ./firmware ./docs ${APP_DIR}/ 2>/dev/null || cp -r ./* ${APP_DIR}/
fi

cd ${APP_DIR}/backend
echo "📥 [4/6] Installing Node.js production dependencies..."
npm install --omit=dev

# 4. Configure Firewall (UFW / iptables)
echo "🛡️ [5/6] Opening required network ports in firewall..."
sudo ufw allow 22/tcp comment 'SSH' || true
sudo ufw allow 80/tcp comment 'HTTP' || true
sudo ufw allow 443/tcp comment 'HTTPS' || true
sudo ufw allow 4000/tcp comment 'BARQ Web Dashboard & REST' || true
sudo ufw allow 4001/tcp comment 'BARQ WebSocket Gateway' || true
sudo ufw allow 5050/tcp comment 'BARQ Quectel M25 TCP Relay' || true

# Also flush iptables for Oracle Cloud VCN compatibility
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 5050 -j ACCEPT 2>/dev/null || true
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 4000 -j ACCEPT 2>/dev/null || true
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 4001 -j ACCEPT 2>/dev/null || true

# 5. Create Systemd Service for 24/7 Autonomous Operation
echo "⚙️ [6/6] Creating systemd service for 24/7 background operation..."
cat << 'EOF' | sudo tee /etc/systemd/system/barq-link.service > /dev/null
[Unit]
Description=BARQ LINK Enterprise IoT Cloud Server & Cellular TCP Relay
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/barq-link/backend
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
Environment=PORT=4000
Environment=WS_PORT=4001
Environment=TCP_PORT=5050

# Security limits
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
EOF

# Reload and start service
sudo systemctl daemon-reload
sudo systemctl enable barq-link.service
sudo systemctl restart barq-link.service

echo ""
echo "=========================================================="
echo "  🎉 BARQ LINK PRODUCTION SERVER DEPLOYED SUCCESSFULLY!"
echo "=========================================================="
echo "  - Service Status: sudo systemctl status barq-link"
echo "  - Live Logs:      sudo journalctl -u barq-link -f"
echo "  - Web Dashboard:  http://$(curl -s ifconfig.me):4000"
echo "  - Cellular TCP:   $(curl -s ifconfig.me):5050"
echo "=========================================================="
