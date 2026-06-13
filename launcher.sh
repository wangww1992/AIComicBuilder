#!/usr/bin/env bash
# AIComicBuilder desktop launcher: start the Next.js dev server in the
# background if it is not already serving on $PORT, then open the URL in the
# default browser. Invoked by ~/.local/share/applications/aicomicbuilder.desktop.

set -u

PROJECT_DIR="/home/wang/codes/AIComicBuilder"
PORT="${AICB_PORT:-3000}"
URL="http://localhost:${PORT}"
LOG_FILE="${PROJECT_DIR}/.launcher.log"
PID_FILE="${PROJECT_DIR}/.launcher.pid"
READY_TIMEOUT="${AICB_READY_TIMEOUT:-90}"  # seconds to wait for the server

# Desktop launchers inherit a minimal PATH; bring in nvm's node and common bins.
export PATH="/home/wang/.nvm/versions/node/v24.16.0/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"
export NODE_ENV="${NODE_ENV:-development}"

log() { printf '[%s] %s\n' "$(date '+%F %T')" "$*" >> "$LOG_FILE"; }

is_running() {
    # Treat any HTTP response (2xx/3xx/4xx) as "server is up" — Next.js may
    # 404 the root briefly during compile but the port is bound.
    local code
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "$URL" 2>/dev/null || true)"
    [[ "$code" =~ ^[1-5][0-9][0-9]$ ]] && [[ "$code" != "000" ]]
}

mkdir -p "$(dirname "$LOG_FILE")"
: > /dev/null  # ensure $LOG_FILE writable later via log()

if is_running; then
    log "Server already responding at $URL; opening browser."
else
    log "Server not detected at $URL; starting 'pnpm dev' in $PROJECT_DIR."
    cd "$PROJECT_DIR" || { log "ERROR: cannot cd into $PROJECT_DIR"; exit 1; }

    # setsid + nohup so the dev server survives this launcher exiting and is
    # detached from any controlling terminal.
    setsid nohup pnpm dev >> "$LOG_FILE" 2>&1 < /dev/null &
    echo $! > "$PID_FILE"
    log "Started pnpm dev (pid $(cat "$PID_FILE"))."

    # Poll until the server answers or we hit the timeout.
    for ((i = 1; i <= READY_TIMEOUT; i++)); do
        if is_running; then
            log "Server ready after ${i}s."
            break
        fi
        sleep 1
    done

    if ! is_running; then
        log "WARNING: server did not respond within ${READY_TIMEOUT}s; opening browser anyway."
    fi
fi

# xdg-open returns immediately after handing off to the default browser.
xdg-open "$URL" >> "$LOG_FILE" 2>&1 &
exit 0
