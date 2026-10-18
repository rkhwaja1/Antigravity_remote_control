#!/usr/bin/env bash

# Antigravity Dedicated Mobile Web Dashboard (PWA) Supervisor
# Runs local HTTP/SSE bridge daemon alongside caffeinate

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PID_FILE="$SCRIPT_DIR/web_dashboard.pid"
LOG_FILE="$SCRIPT_DIR/web_dashboard.log"
PORT=3847

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
            exit 0
        fi
    fi

    # 2. Ensure caffeinate is running
    if ! pgrep -x "caffeinate" > /dev/null; then
        echo "☕ Starting caffeinate sleep inhibitor..."
        caffeinate -dimsu &
    else
        echo "☕ caffeinate is already active."
    fi

    # 3. Start supervisor loop
    LOCAL_IP=$(get_local_ip)
    echo "🚀 Starting Antigravity Mobile Web Dashboard on port $PORT..."
    nohup bash -c "
        cd '$WORKSPACE_ROOT'
        while true; do
            echo '[$(date)] Starting web_bridge_server.mjs...' >> '$LOG_FILE'
            PORT=$PORT node '$SCRIPT_DIR/web_bridge_server.mjs' >> '$LOG_FILE' 2>&1
            EXIT_CODE=\$?
            echo '[$(date)] Server exited with code '\$EXIT_CODE'. Restarting in 2s...' >> '$LOG_FILE'
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
        pkill -f "node.*web_bridge_server.mjs" > /dev/null 2>&1 || true
        echo "Mobile Dashboard stopped."
    else
        echo "No PID file found. Killing any rogue instances..."
        pkill -f "node.*web_bridge_server.mjs" > /dev/null 2>&1 || true
        echo "Done."
    fi
}

status_dashboard() {
    if [ -f "$PID_FILE" ]; then
        PID=$(cat "$PID_FILE")
        if ps -p "$PID" > /dev/null 2>&1; then
            LOCAL_IP=$(get_local_ip)
            echo "🟢 Mobile Dashboard is RUNNING (PID: $PID)"
            echo "👉 Phone URL: http://$LOCAL_IP:$PORT"
            if pgrep -x "caffeinate" > /dev/null; then
                echo "☕ Caffeinate: Active (System Sleep Prevented)"
            else
                echo "⚠️ Caffeinate: Inactive"
            fi
            echo ""
            tail -n 12 "$LOG_FILE"
            exit 0
        fi
    fi
    echo "🔴 Mobile Dashboard is NOT running."
}

case "$1" in
    start)
        start_dashboard
        ;;
    stop)
        stop_dashboard
        ;;
    restart)
        stop_dashboard
        sleep 1
        start_dashboard
        ;;
    status)
        status_dashboard
        ;;
    *)
        echo "Usage: scratch/run_mobile_dashboard.sh {start|stop|restart|status}"
        exit 1
        ;;
esac
