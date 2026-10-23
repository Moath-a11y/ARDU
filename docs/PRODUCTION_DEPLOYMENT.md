# BARQ LINK — Production Network and Cloud Deployment Architecture

**System:** BARQ LINK Autonomous Cellular IoT Cloud Gateway  
**Document Version:** 1.0.0  
**Target Environments:** Public Cloud VPS (Ubuntu 22.04/24.04 LTS / Debian 12) & Development Tunnels  

---

## 1. Network Ingress Architecture

The production architecture supports two ingress topologies:

### Topology A: Persistent Public Cloud VPS (Recommended for 24/7 Production)
A dedicated Linux VPS (e.g. Oracle Cloud, DigitalOcean, Hetzner, AWS EC2) with a static public IPv4 address:

```
[ Operator Web Browser ] -------- HTTPS / Port 443 / 4000 -------> [ BARQ Web & REST API ]
[ Operator Web Dashboard ] <------ WSS / Port 4001 ---------------> [ WebSocket Gateway   ]
[ Quectel M25 Modem ] ------------ TCP / Port 5050 ---------------> [ BARQ RelayServer   ]
```

- **Port 4000 (TCP):** HTTP REST API and React SPA Dashboard.
- **Port 4001 (TCP):** WebSocket real-time telemetry and state broadcasting.
- **Port 5050 (TCP):** High-throughput, low-latency line-delimited TCP Relay (`BARQ-RELAY-v1`).

### Topology B: Automated Dual Pinggy Tunnel (Development & Dynamic Testing)
Managed automatically by `backend/src/server/TunnelManager.js`:
- Maps local TCP port 5050 to a public dynamic `tcp://<host>:<port>` endpoint.
- Maps local HTTP port 4000 to a public HTTPS `https://<host>.free.pinggy.net` console URL.
- Resolves hostname to raw numeric IP via `dns.lookup` for 2G cellular modem DNS reliability.

---

## 2. Firewall and Port Configuration

Execute the following commands on the VPS host:

```bash
# Enable UFW firewall
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp comment 'SSH Remote Access'
sudo ufw allow 80/tcp comment 'HTTP Web'
sudo ufw allow 443/tcp comment 'HTTPS Secure Web'
sudo ufw allow 4000/tcp comment 'BARQ REST API & Web Dashboard'
sudo ufw allow 4001/tcp comment 'BARQ WebSocket Gateway'
sudo ufw allow 5050/tcp comment 'BARQ Cellular TCP Relay'
sudo ufw enable

# For Oracle Cloud Infrastructure (OCI) iptables compatibility:
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 5050 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 4000 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 4001 -j ACCEPT
sudo netfilter-persistent save 2>/dev/null || true
```

---

## 3. Production Systemd Service

Create `/etc/systemd/system/barq-link.service`:

```ini
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

# Resource & File Descriptor Limits
LimitNOFILE=65535

# Logging configuration
StandardOutput=journal
StandardError=journal
SyslogIdentifier=barq-link

[Install]
WantedBy=multi-user.target
```

### Service Management Commands
```bash
sudo systemctl daemon-reload
sudo systemctl enable barq-link.service
sudo systemctl restart barq-link.service

# Inspect live status and logs
sudo systemctl status barq-link.service
sudo journalctl -u barq-link.service -f --output=cat
```

---

## 4. Health Monitoring & Watchdog Endpoints

- **REST State Snapshot:** `GET http://<vps-ip>:4000/api/nodes` (Returns connected nodes, relay session status, and message audit history).
- **Relay Endpoint:** `GET http://<vps-ip>:4000/api/tunnel/endpoint` (Returns current active TCP IP and port).
- **Relay TCP Reachability:** Test with netcat:
  ```bash
  nc -zv <vps-ip> 5050
  ```

---

## 5. Rollback and Disaster Recovery

If an update fails:
1. **Service Rollback:**
   ```bash
   cd /opt/barq-link
   git checkout HEAD~1
   sudo systemctl restart barq-link.service
   ```
2. **Process Teardown:**
   ```bash
   sudo systemctl stop barq-link.service
   sudo killall -9 node 2>/dev/null || true
   ```
3. **Session Recovery:** On server restart, active cellular modems automatically detect socket closure via TCP FIN/RST or heartbeat timeout, triggering their internal exponential backoff and re-registering automatically within 2–15 seconds.
