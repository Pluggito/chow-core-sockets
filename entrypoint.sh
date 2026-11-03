#!/bin/bash
set -e

echo "=========================================="
echo " Starting LagChow All-in-One Service"
echo "=========================================="

# 1. Start Valhalla routing daemon in the background on port 8002
if [ -f "/custom_files/valhalla.json" ]; then
  echo "[Valhalla] Found Valhalla tiles config. Starting Valhalla engine..."
  valhalla_service /custom_files/valhalla.json 1 &
  VALHALLA_PID=$!

  echo "[Valhalla] Waiting for Valhalla engine to respond on localhost:8002..."
  COUNT=0
  until curl -s http://localhost:8002/status > /dev/null 2>&1 || [ $COUNT -ge 30 ]; do
    sleep 1
    COUNT=$((COUNT+1))
  done

  if [ $COUNT -lt 30 ]; then
    echo "[Valhalla] SUCCESS: Valhalla is UP and routing on localhost:8002!"
  else
    echo "[Valhalla] WARNING: Valhalla took too long to start; proceeding with Haversine fallback."
  fi
else
  echo "[Valhalla] INFO: No /custom_files/valhalla.json found; dispatch will use Haversine fallback."
fi

# 2. Start LagChow Sockets / Dispatch server in foreground
echo "[Node] Starting LagChow Sockets Server on port ${PORT:-3010}..."
cd /app
exec node dist/index.js
