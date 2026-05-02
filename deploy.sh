#!/bin/bash
# Deploy-Script: RessourcenPool auf Hetzner-Server
# Verwendung: ./deploy.sh

set -e

SERVER="root@178.104.46.6"
REMOTE_DIR="/var/www/ressourcenpool"
LOCAL_DIR="$(dirname "$0")"

echo "=== RessourcenPool Deploy ==="

# Dateien hochladen (ohne node_modules und .env)
echo "Dateien hochladen..."
rsync -avz --exclude 'node_modules' \
            --exclude '.env' \
            --exclude 'public/uploads' \
            "$LOCAL_DIR/" "$SERVER:$REMOTE_DIR/"

# Dependencies installieren und PM2 neustarten
echo "Dependencies & Neustart..."
ssh "$SERVER" "cd $REMOTE_DIR && npm install --production && pm2 restart ressourcenpool 2>/dev/null || pm2 start server.js --name ressourcenpool && pm2 save"

echo "=== Deploy abgeschlossen ==="
echo "App erreichbar unter: http://178.104.46.6:3001"
