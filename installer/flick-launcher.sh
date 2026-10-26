#!/bin/sh
# Starts Flick on Linux with the switches this system needs: the tar.gz's "flick", and the AppImage's AppRun.
# (build_linux.sh puts it next to flick-bin, Electron's own program.)
HERE=$(dirname "$(readlink -f "$0")")
# Flick's overlay covers the whole screen and stays on top, which Wayland doesn't let a window do: under Wayland it
# runs through X11 (XWayland), where there is one
if [ -n "${WAYLAND_DISPLAY:-}" ] && [ -n "${DISPLAY:-}" ]; then
  set -- --ozone-platform=x11 "$@"
fi
# Chromium's sandbox needs unprivileged user namespaces. Where the system restricts them (Ubuntu 24.04's AppArmor rule,
# a kernel setting) it would fall back to a setuid helper, which neither an AppImage nor a tar.gz can provide.
if [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null)" = 1 ] ||
   [ "$(cat /proc/sys/kernel/unprivileged_userns_clone 2>/dev/null)" = 0 ] ||
   [ "$(cat /proc/sys/user/max_user_namespaces 2>/dev/null)" = 0 ]; then
  set -- --no-sandbox "$@"
fi
exec "$HERE/flick-bin" "$@"
