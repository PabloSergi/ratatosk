#!/bin/sh
# Xvfb gives Chromium a real screen; node stays PID 1 so that when it dies the container dies with it.
# Without this, a crashed server hides behind a live Xvfb and the container reports itself healthy
# while refusing every connection.
set -e
Xvfb :99 -screen 0 1920x1080x24 -nolisten tcp >/dev/null 2>&1 &
export DISPLAY=:99
sleep 1
exec "$@"
