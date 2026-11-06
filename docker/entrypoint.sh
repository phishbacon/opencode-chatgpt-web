#!/bin/sh
# Browser container entrypoint: virtual display + noVNC (for ChatGPT login),
# first-run production setup with the OpenCode website MCP contract, then the
# production launcher. Electron owns the browser, tunnel-client and the
# Responses bridge daemon (17841 inside the container).
set -eu

export HOME=/home/bun
export DISPLAY=:1
# Launcher state — including the ChatGPT login in the browser partition — must
# live on the volume so container recreation never logs the session out again.
export CODEX_WEB_GPT_LAUNCHER_DATA_DIR=/home/bun/.codex-chatgpt-web/launcher
REPO=/opt/codex-chatgpt-web
LAUNCHER="$REPO/launcher"
CONFIG="$HOME/.codex-chatgpt-web/config.json"
DESCRIPTOR="$HOME/.codex-chatgpt-web/runtime/launcher-browser.json"
cd "$REPO"

# Virtual display for the Electron browser; noVNC websockify provides the view.
# The image publishes noVNC on the host only; VNC itself stays inside the
# container. Authentication precedence: VNC_PASSWORD from the environment
# (rendered into TigerVNC's passwd format at startup) > the operator's existing
# host VNC password file (mounted read-only) > none, with a loud warning.
# No credential is ever baked into the image.
VNC_ARGS="-SecurityTypes None"
if [ -n "${VNC_PASSWORD:-}" ]; then
    mkdir -p "$HOME/.vnc"
    x11vnc -storepasswd "$VNC_PASSWORD" "$HOME/.vnc/passwd" >/dev/null 2>&1 \
        || { echo "failed to render VNC_PASSWORD into $HOME/.vnc/passwd" >&2; exit 1; }
    VNC_ARGS="-SecurityTypes VncAuth -rfbauth $HOME/.vnc/passwd"
    echo "INFO: noVNC authentication uses VNC_PASSWORD from the environment" >&2
elif [ -f /run/secrets/vnc.passwd ]; then
    VNC_ARGS="-SecurityTypes VncAuth -rfbauth /run/secrets/vnc.passwd"
fi
# A previous container run leaves the display lock behind; a stale lock would
# silently kill Xvnc and take Electron (and the descriptor) down with it.
rm -f /tmp/.X1-lock /tmp/.X11-unix/X1
Xvnc :1 -localhost no $VNC_ARGS -geometry 1600x900 -depth 24 >/tmp/xvnc.log 2>&1 &
websockify --web=/usr/share/novnc 0.0.0.0:6080 127.0.0.1:5901 >/tmp/websockify.log 2>&1 &

# The Responses daemon is validated to bind loopback only inside the container;
# relay it to the container interface so the host port publish can reach it.
socat TCP-LISTEN:17842,fork,reuseaddr,bind=0.0.0.0 TCP:127.0.0.1:17841 >/tmp/socat.log 2>&1 &

start_electron() {
    cd "$LAUNCHER"
    ./node_modules/.bin/electron . --no-sandbox --disable-dev-shm-usage >>/tmp/electron.log 2>&1 &
    ELECTRON_PID=$!
    cd "$REPO"
}

# Signed OpenCode turn identity: the same key the host-side identity plugin
# holds, so the container bridge authenticates turns signed on the host.
[ -f /run/secrets/turn-signing.key ] || { echo "missing /run/secrets/turn-signing.key" >&2; exit 1; }
export OPENCODE_CHATGPT_WEB_TURN_KEY="$(cat /run/secrets/turn-signing.key)"

# First run: production configuration (no purpose flag) with the OpenCode
# website MCP contract and the fixed `opencode-chatgpt-web` connector name.
# Electron must be running first — setup waits for the browser-host descriptor
# it writes — and must restart afterwards so its supervisor reads the config.
# Setup verifies a signed-in ChatGPT session, so it retries while the operator
# completes the login in the container's noVNC view (host port 18086).
if [ ! -f "$CONFIG" ]; then
    : "${TUNNEL_ID:?TUNNEL_ID is required for first-run setup}"
    [ -f /run/secrets/tunnel-runtime.key ] || { echo "missing /run/secrets/tunnel-runtime.key" >&2; exit 1; }
    # Drop any descriptor from a previous container run so the wait below can
    # only pass on a file written by the Electron we are about to start.
    rm -f "$DESCRIPTOR"
    start_electron
    i=0
    while [ ! -f "$DESCRIPTOR" ] && [ "$i" -lt 120 ]; do sleep 1; i=$((i + 1)); done
    if [ ! -f "$DESCRIPTOR" ]; then
        echo "browser-host descriptor never appeared at $DESCRIPTOR" >&2
        exit 1
    fi
    echo "INFO: complete ChatGPT sign-in in the container noVNC view (host port 18086); setup retries until the session verifies." >&2
    attempt=0
    until bun run src/cli.ts setup --full --automatic-browser-interaction --opencode-website-tools \
        --acknowledge-unofficial \
        --browser-host-descriptor "$DESCRIPTOR" \
        --tunnel-id "$TUNNEL_ID" \
        --runtime-key-file /run/secrets/tunnel-runtime.key
    do
        attempt=$((attempt + 1))
        if [ "$attempt" -ge 12 ]; then
            echo "setup failed after $attempt attempts" >&2
            exit 1
        fi
        echo "setup attempt $attempt failed; sign in to ChatGPT via noVNC — retrying in 30s" >&2
        sleep 30
    done
    kill "$ELECTRON_PID" 2>/dev/null || true
    wait "$ELECTRON_PID" 2>/dev/null || true
    start_electron
else
    start_electron
fi

wait "$ELECTRON_PID"
