#!/bin/sh
# The screen a headed browser needs, and the one thing that must not be assumed about it: that it is
# still there. A dead Xvfb leaves its socket and its lock behind, the container stays up, the health
# check stays green, and every browser launched from then on fails in a second — two days of that is
# what this line is paid for. So the leftovers go first, and whoever needs the screen later checks it
# again for itself (see src/browser-host.ts).
#
# node stays PID 1 so that when it dies the container dies with it.
set -e
rm -f /tmp/.X99-lock /tmp/.X11-unix/X99
Xvfb :99 -screen 0 1920x1080x24 -nolisten tcp >/dev/null 2>&1 &
export DISPLAY=:99
sleep 1
exec "$@"
