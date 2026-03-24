#!/bin/bash
# Auto-start Ticket Alert monitor
# Lance le serveur web + la surveillance automatiquement

cd /Users/yasuke/claude/ticket-alert

# Charge les variables d'environnement
export $(cat .env | xargs)

# Lance le serveur en arriere-plan (si pas deja en cours)
if ! lsof -i :5555 > /dev/null 2>&1; then
    nohup python3 server.py > /tmp/ticket-alert-server.log 2>&1 &
    sleep 2
fi

# Demarre la surveillance via l'API
curl -s -X POST http://localhost:5555/api/monitor/start > /dev/null 2>&1

# Notification
osascript -e 'display notification "Surveillance lancee automatiquement" with title "Ticket Alert" sound name "Glass"' 2>/dev/null

echo "$(date): Ticket Alert started" >> /tmp/ticket-alert-autostart.log
