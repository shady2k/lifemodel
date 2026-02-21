#!/bin/bash
# Browser Authentication Entrypoint
#
# Starts Xvfb + x11vnc + noVNC so the user can interact with
# a Chromium instance through their browser at http://localhost:6080.
# The browser navigates to $AUTH_URL for login flows.
#
# Container is stopped externally once the user is done authenticating.

set -euo pipefail

# Validate required env
if [ -z "${AUTH_URL:-}" ]; then
  echo "ERROR: AUTH_URL environment variable is required" >&2
  exit 1
fi

echo "Starting Xvfb on :99..."
Xvfb :99 -screen 0 1920x1080x24 -ac &
XVFB_PID=$!
sleep 1

export DISPLAY=:99

echo "Starting x11vnc on :5900..."
x11vnc -display :99 -forever -nopw -rfbport 5900 -shared -quiet &
X11VNC_PID=$!
sleep 0.5

echo "Starting noVNC on :6080..."
/opt/novnc/utils/novnc_proxy --vnc localhost:5900 --listen 6080 &
NOVNC_PID=$!
sleep 0.5

echo "Launching browser at: ${AUTH_URL}"
node /scripts/launch-browser.js &
BROWSER_PID=$!

echo ""
echo "========================================"
echo "  noVNC available at:"
echo "  http://localhost:6080/vnc.html"
echo "========================================"
echo ""

# Wait for any child to exit (signals container stop)
cleanup() {
  echo "Shutting down..."
  kill $BROWSER_PID $NOVNC_PID $X11VNC_PID $XVFB_PID 2>/dev/null || true
  wait 2>/dev/null || true
  exit 0
}

trap cleanup SIGTERM SIGINT

# Block until stopped
wait -n || true
cleanup
