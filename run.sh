#!/usr/bin/env bash

# Antigravity Dedicated Mobile Web Dashboard (PWA) Supervisor
# Runs local HTTP/SSE bridge daemon alongside caffeinate

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_FILE="$SCRIPT_DIR/web_dashboard.pid"
LOG_FILE="$SCRIPT_DIR/web_dashboard.log"
PORT=${PORT:-3847}

get_local_ip() {
    ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo "localhost"
}

start_dashboard() {
    # 1. Check if already running
    if [ -f "$PID_FILE" ]; then
        OLD_PID=$(cat "$PID_FILE")
        if ps -p "$OLD_PID" > /dev/null 2>&1; then
            LOCAL_IP=$(get_local_ip)
            echo "⚡ Mobile Dashboard is already running (PID: $OLD_PID)."
            echo "👉 Open on your phone: http://$LOCAL_IP:$PORT"
            return 0
        fi
    fi

    # 2. Ensure caffeinate is running if on macOS
    if [ "$(uname)" = "Darwin" ]; then
        if ! pgrep -x "caffeinate" > /dev/null; then
            echo "☕ Starting caffeinate sleep inhibitor..."
            caffeinate -dimsu &
        else
            echo "☕ caffeinate is already active."
        fi
    fi

    # 3. Start supervisor loop
    LOCAL_IP=$(get_local_ip)
    echo "🚀 Starting Antigravity Mobile Web Dashboard on port $PORT..."
    nohup bash -c "
        cd '$SCRIPT_DIR'
        while true; do
            echo '[$(date)] Starting server.mjs...' >> '$LOG_FILE'
            PORT=$PORT node '$SCRIPT_DIR/server.mjs' >> '$LOG_FILE' 2>&1
            EXIT_CODE=\$?
            echo '[$(date)] Server exited with code '$EXIT_CODE'. Restarting in 2s...' >> '$LOG_FILE'
            sleep 2
        done
    " > /dev/null 2>&1 &

    SUPERVISOR_PID=$!
    echo $SUPERVISOR_PID > "$PID_FILE"
    echo "✅ Mobile Dashboard started successfully (PID: $SUPERVISOR_PID)."
    echo "=================================================="
    echo "📱 CONNECT FROM YOUR PHONE:"
    echo "   👉 URL: http://$LOCAL_IP:$PORT"
    echo "   (Open in Safari or Chrome on your phone)"
    echo "   (Tip: Tap 'Share' -> 'Add to Home Screen' for native full-screen app)"
    echo "=================================================="
    echo "📄 Logs: $LOG_FILE"
}

stop_dashboard() {
    if [ -f "$PID_FILE" ]; then
        PID=$(cat "$PID_FILE")
        echo "🛑 Stopping Mobile Dashboard (PID: $PID)..."
        kill "$PID" > /dev/null 2>&1 || true
        rm -f "$PID_FILE"
        pkill -f "node.*antigravity-remote/server.mjs" > /dev/null 2>&1 || true
        echo "Mobile Dashboard stopped."
    else
        echo "No PID file found. Killing any rogue instances..."
        pkill -f "node.*antigravity-remote/server.mjs" > /dev/null 2>&1 || true
        echo "Done."
    fi
}

TUNNEL_PID_FILE="$SCRIPT_DIR/mac_tunnel.pid"
TUNNEL_LOG_FILE="$SCRIPT_DIR/mac_tunnel.log"

start_tunnel() {
    # Ensure local server is running first
    start_dashboard

    if [ -f "$TUNNEL_PID_FILE" ]; then
        OLD_PID=$(cat "$TUNNEL_PID_FILE")
        if ps -p "$OLD_PID" > /dev/null 2>&1; then
            echo "⚡ Mac Outbound Cloud Tunnel is already running (PID: $OLD_PID)."
            echo "📄 Logs: $TUNNEL_LOG_FILE"
            return 0
        fi
    fi

    echo "🚀 Starting Antigravity Mac Outbound Tunnel to Cloud Run..."
    nohup bash -c "
        cd '$SCRIPT_DIR'
        while true; do
            echo '[$(date)] Starting mac_tunnel.mjs...' >> '$TUNNEL_LOG_FILE'
            node '$SCRIPT_DIR/mac_tunnel.mjs' >> '$TUNNEL_LOG_FILE' 2>&1
            EXIT_CODE=\$?
            echo '[$(date)] Tunnel exited with code '\$EXIT_CODE'. Reconnecting in 2s...' >> '$TUNNEL_LOG_FILE'
            sleep 2
        done
    " > /dev/null 2>&1 &

    TUNNEL_PID=$!
    echo $TUNNEL_PID > "$TUNNEL_PID_FILE"
    echo "✅ Mac Cloud Tunnel connected successfully (PID: $TUNNEL_PID)."
    echo "🌐 Cloud Run URL: ${CLOUD_RUN_URL:-https://antigravity-remote-356302263933.europe-west2.run.app}"
    echo "📄 Tunnel Logs: $TUNNEL_LOG_FILE"
}

stop_tunnel() {
    if [ -f "$TUNNEL_PID_FILE" ]; then
        PID=$(cat "$TUNNEL_PID_FILE")
        echo "🛑 Stopping Mac Cloud Tunnel (PID: $PID)..."
        kill "$PID" > /dev/null 2>&1 || true
        rm -f "$TUNNEL_PID_FILE"
        pkill -f "node.*antigravity-remote/mac_tunnel.mjs" > /dev/null 2>&1 || true
        echo "Mac Cloud Tunnel stopped."
    else
        pkill -f "node.*antigravity-remote/mac_tunnel.mjs" > /dev/null 2>&1 || true
    fi
}

status_dashboard() {
    LOCAL_IP=$(get_local_ip)
    echo "=================================================="
    echo "📱 ANTIGRAVITY WORKSTATION & CLOUD BRIDGE STATUS"
    echo "=================================================="
    if [ -f "$PID_FILE" ]; then
        PID=$(cat "$PID_FILE")
        if ps -p "$PID" > /dev/null 2>&1; then
            echo "🟢 Local Web Server: RUNNING (PID: $PID) -> http://$LOCAL_IP:$PORT"
        else
            echo "🔴 Local Web Server: NOT RUNNING"
        fi
    else
        echo "🔴 Local Web Server: NOT RUNNING"
    fi

    if [ -f "$TUNNEL_PID_FILE" ]; then
        TPID=$(cat "$TUNNEL_PID_FILE")
        if ps -p "$TPID" > /dev/null 2>&1; then
            echo "🟢 Cloud Run Reverse Tunnel: RUNNING (PID: $TPID)"
            echo "🌐 Public Cloud URL: ${CLOUD_RUN_URL:-https://antigravity-remote-356302263933.europe-west2.run.app}"
        else
            echo "🔴 Cloud Run Reverse Tunnel: NOT RUNNING"
        fi
    else
        echo "🔴 Cloud Run Reverse Tunnel: NOT RUNNING"
    fi

    if [ "$(uname)" = "Darwin" ]; then
        if pgrep -x "caffeinate" > /dev/null; then
            echo "☕ Caffeinate: Active (System Sleep Prevented)"
        else
            echo "⚠️ Caffeinate: Inactive"
        fi
    fi
    echo "=================================================="
    if [ -f "$LOG_FILE" ]; then
        tail -n 8 "$LOG_FILE"
    fi
}

pair_device() {
    TARGET="$1"
    cd "$SCRIPT_DIR"
    node -e '
      import("./auth_manager.mjs").then(async m => {
        const target = process.argv[1];
        const res = m.approvePairing(target || null);
        if (res) {
          console.log("✅ Successfully approved pairing request:");
          console.log(`   • Device: ${res.clientName} (${res.ip})`);
          console.log(`   • PIN:    ${res.pin}`);
          console.log(`   • PairID: ${res.pairId}`);

          try {
            const { postToCloud } = await import("./mac_tunnel.mjs");
            await postToCloud("/api/tunnel/pair-decision", { pairId: res.pairId, approved: true });
            console.log("☁️ Synchronized approval with Cloud Run relay.");
          } catch (_) {}
        } else {
          console.log("❌ No active pending pairing found to approve.");
          const store = m.loadAuthStore();
          if (store.pendingPairings.length > 0) {
            console.log("\nPending pairing requests:");
            store.pendingPairings.forEach(p => {
              console.log(` - PIN: ${p.pin} | Device: ${p.clientName} (${p.ip}) | ID: ${p.pairId}`);
            });
          }
        }
      });
    ' "$TARGET"
}

unpair_all_devices() {
    cd "$SCRIPT_DIR"
    node -e '
      import("./auth_manager.mjs").then(m => {
        m.revokeAllSessions();
        console.log("🔒 All active paired mobile sessions have been revoked.");
      });
    '
}

list_sessions() {
    cd "$SCRIPT_DIR"
    node -e '
      import("./auth_manager.mjs").then(m => {
        const sessions = m.getActiveSessions();
        if (sessions.length === 0) {
          console.log("No active paired sessions.");
        } else {
          console.log(`Found ${sessions.length} active paired device(s):`);
          sessions.forEach((s, idx) => {
            console.log(`[${idx + 1}] ID: ${s.id} | Name: ${s.clientName} | IP: ${s.ip} | Created: ${s.createdAt} | Last Used: ${s.lastUsedAt}`);
          });
        }
      });
    '
}

case "$1" in
    start)
        start_dashboard
        ;;
    tunnel)
        start_tunnel
        ;;
    stop)
        stop_tunnel
        stop_dashboard
        ;;
    restart)
        stop_tunnel
        stop_dashboard
        sleep 1
        start_tunnel
        ;;
    status)
        status_dashboard
        ;;
    pair)
        pair_device "$2"
        ;;
    unpair-all)
        unpair_all_devices
        ;;
    sessions)
        list_sessions
        ;;
    *)
        echo "Usage: ./run.sh {start|tunnel|stop|restart|status|pair [pin]|unpair-all|sessions}"
        exit 1
        ;;
esac
