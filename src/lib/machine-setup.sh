#!/usr/bin/env bash
#
# AJ Pilot — one-file setup for a fresh Ubuntu machine.
#
# Turns a just-installed Ubuntu (or Debian) PC, laptop, mini-PC or VM into a
# server the panel can manage: SSH on, never sleeps, keeps running with the lid
# closed, screen off but computer on, firewall, automatic security updates, and
# the rest of what was ticked in the panel.
#
#   sudo bash aj-pilot-setup.sh             do it
#   sudo bash aj-pilot-setup.sh --dry-run   show what would change, change nothing
#   bash aj-pilot-setup.sh --help           every option
#
# Safe to run again: each step looks first and changes only what is not set up.
# One step failing does not stop the others; the summary at the end says which.

set -uo pipefail

# ---------------------------------------------------------------------------
# Options chosen in the panel. Edit them here, or override on the command line.
# ---------------------------------------------------------------------------
# @@OPTIONS@@
# ---------------------------------------------------------------------------

VERSION='1'
DRY_RUN=0
FORCE=0
REBOOT=0
LOG=/var/log/aj-pilot-setup.log
ORIG_ARGS=("$@")

usage() {
  cat <<EOF
AJ Pilot machine setup (v$VERSION)

Usage: sudo bash $(basename "$0") [options]

  --dry-run            Show what would be done; change nothing (no root needed)
  --user NAME          The account AJ Pilot signs in as (default: whoever ran sudo)
  --ssh-port N         SSH port (default: $SSH_PORT)
  --timezone ZONE      e.g. Asia/Kolkata (default: ${TIMEZONE:-leave as is})
  --hostname NAME      Rename the machine
  --no-docker          Do not install Docker, even if it was ticked
  --docker             Install Docker
  --reboot             Restart at the end when a change needs it
  --force              Run on a system that is not Ubuntu or Debian
  -h, --help           This help

Every step is logged to $LOG.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --force) FORCE=1 ;;
    --reboot) REBOOT=1 ;;
    --docker) DO_DOCKER=1 ;;
    --no-docker) DO_DOCKER=0 ;;
    --user) PANEL_USER="${2:-}"; shift ;;
    --user=*) PANEL_USER="${1#*=}" ;;
    --ssh-port) SSH_PORT="${2:-}"; shift ;;
    --ssh-port=*) SSH_PORT="${1#*=}" ;;
    --timezone) TIMEZONE="${2:-}"; shift ;;
    --timezone=*) TIMEZONE="${1#*=}" ;;
    --hostname) NEW_HOSTNAME="${2:-}"; shift ;;
    --hostname=*) NEW_HOSTNAME="${1#*=}" ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; echo >&2; usage >&2; exit 2 ;;
  esac
  shift
done

# --------------------------------------------------------------- output ----

if [ -t 1 ]; then B=$'\e[1m'; G=$'\e[32m'; Y=$'\e[33m'; R=$'\e[31m'; D=$'\e[2m'; N=$'\e[0m'; else B=''; G=''; Y=''; R=''; D=''; N=''; fi
say()  { printf '%b\n' "$*"; }
title() { printf '\n%s▶ %s%s\n' "$B" "$*" "$N"; }

RESULTS=()
CUR=''
ok()   { RESULTS+=("ok|$CUR|$*");   printf '  %s✓%s %s\n' "$G" "$N" "$*"; }
skip() { RESULTS+=("skip|$CUR|$*"); printf '  %s–%s %s\n' "$D" "$N" "$*"; }
warn() { printf '  %s!%s %s\n' "$Y" "$N" "$*"; }
fail() { RESULTS+=("fail|$CUR|$*"); printf '  %s✗%s %s\n' "$R" "$N" "$*"; }
NEEDS_REBOOT=0

# Every change goes through these two, so --dry-run never changes anything.
run() {
  if [ "$DRY_RUN" = 1 ]; then printf '    %swould run:%s %s\n' "$D" "$N" "$*"; return 0; fi
  "$@"
}
# put_file PATH MODE  (content on stdin) — writes only when it differs.
put_file() {
  local path="$1" mode="$2" tmp
  tmp="$(mktemp)"
  cat > "$tmp"
  if [ -f "$path" ] && cmp -s "$tmp" "$path"; then rm -f "$tmp"; return 1; fi
  if [ "$DRY_RUN" = 1 ]; then
    printf '    %swould write %s:%s\n' "$D" "$path" "$N"; sed 's/^/      /' "$tmp"; rm -f "$tmp"; return 0
  fi
  mkdir -p "$(dirname "$path")"
  install -m "$mode" "$tmp" "$path"
  rm -f "$tmp"
  return 0
}

# A step: a name, then a function that reports with ok / skip / fail.
step() {
  CUR="$1"
  local before=${#RESULTS[@]}
  title "$1"
  "$2"
  local rc=$?
  if [ ${#RESULTS[@]} -eq "$before" ]; then
    if [ "$rc" -eq 0 ]; then ok "done"; else fail "did not complete (exit $rc)"; fi
  fi
}

# ------------------------------------------------------------- preflight ----

if [ "$DRY_RUN" != 1 ] && [ "$(id -u)" -ne 0 ]; then
  if [ -f "$0" ] && command -v sudo >/dev/null 2>&1; then
    echo "This needs root — asking sudo…"
    exec sudo bash "$0" "${ORIG_ARGS[@]}"
  fi
  echo "Run it as root: sudo bash $(basename "$0")" >&2
  exit 1
fi

if [ "$DRY_RUN" != 1 ]; then
  # Everything that follows also goes to the log file.
  touch "$LOG" 2>/dev/null && chmod 600 "$LOG" && exec > >(tee -a "$LOG") 2>&1
fi

say "${B}AJ Pilot machine setup${N} — $(date '+%Y-%m-%d %H:%M:%S')"
[ "$DRY_RUN" = 1 ] && say "${Y}Dry run: nothing will be changed.${N}"

# What is this system?
OS_ID=''; OS_LIKE=''; OS_NAME='unknown'; OS_VERSION=''
if [ -r /etc/os-release ]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  OS_ID="${ID:-}"; OS_LIKE="${ID_LIKE:-}"; OS_NAME="${PRETTY_NAME:-$OS_ID}"; OS_VERSION="${VERSION_ID:-}"
fi
case " $OS_ID $OS_LIKE " in
  *" ubuntu "*|*" debian "*) ;;
  *)
    if [ "$FORCE" != 1 ]; then
      say "${R}This is $OS_NAME, not Ubuntu or Debian.${N} AJ Pilot manages Ubuntu servers."
      say "Run it again with --force to try anyway."
      exit 3
    fi
    warn "Not Ubuntu or Debian ($OS_NAME) — continuing because of --force." ;;
esac

HAS_SYSTEMD=0; [ -d /run/systemd/system ] && HAS_SYSTEMD=1
VIRT='none'
if command -v systemd-detect-virt >/dev/null 2>&1; then
  VIRT="$(systemd-detect-virt 2>/dev/null || true)"; VIRT="${VIRT:-none}"
elif [ -f /.dockerenv ] || grep -qa 'container=' /proc/1/environ 2>/dev/null; then
  VIRT='container'
fi
IN_CONTAINER=0
case "$VIRT" in docker|podman|lxc|lxc-libvirt|systemd-nspawn|openvz|wsl|container|rkt|proot|pouch) IN_CONTAINER=1 ;; esac
[ -f /.dockerenv ] && IN_CONTAINER=1
PHYSICAL=0; [ "$VIRT" = 'none' ] && [ "$IN_CONTAINER" = 0 ] && PHYSICAL=1

IS_LAPTOP=0
ls /sys/class/power_supply/BAT* >/dev/null 2>&1 && IS_LAPTOP=1
CHASSIS="$(hostnamectl chassis 2>/dev/null || cat /sys/class/dmi/id/chassis_type 2>/dev/null || true)"
case "$CHASSIS" in laptop|notebook|convertible|tablet|8|9|10|14|31|32) IS_LAPTOP=1 ;; esac

WIFI_IFACES=()
for d in /sys/class/net/*; do [ -d "$d/wireless" ] && WIFI_IFACES+=("$(basename "$d")"); done
HAS_GUI=0; { command -v gnome-shell || command -v Xorg || command -v Xwayland; } >/dev/null 2>&1 && HAS_GUI=1

# The account AJ Pilot will sign in as.
PANEL_USER="${PANEL_USER:-${SUDO_USER:-}}"
[ -z "$PANEL_USER" ] && PANEL_USER="$(logname 2>/dev/null || true)"
[ -z "$PANEL_USER" ] && PANEL_USER='root'
USER_OK=0; id "$PANEL_USER" >/dev/null 2>&1 && USER_OK=1

say "  System : $OS_NAME${OS_VERSION:+ ($OS_VERSION)}"
say "  Machine: $([ "$PHYSICAL" = 1 ] && { [ "$IS_LAPTOP" = 1 ] && echo laptop || echo 'physical computer'; } || echo "virtual ($VIRT)")$([ ${#WIFI_IFACES[@]} -gt 0 ] && echo ", Wi-Fi ${WIFI_IFACES[*]}")$([ "$HAS_GUI" = 1 ] && echo ', desktop installed')"
say "  User   : $PANEL_USER$([ "$USER_OK" = 1 ] || echo " ${R}(no such account)${N}")"

# Validate the options once, so a typo does not half-configure SSH.
if ! [[ "$SSH_PORT" =~ ^[0-9]+$ ]] || [ "$SSH_PORT" -lt 1 ] || [ "$SSH_PORT" -gt 65535 ]; then
  say "${R}SSH port \"$SSH_PORT\" is not a port number (1–65535).${N}"; exit 2
fi
if [ -n "$TIMEZONE" ] && [ ! -f "/usr/share/zoneinfo/$TIMEZONE" ]; then
  warn "Time zone \"$TIMEZONE\" is not known on this system — the time zone will be left as it is."
  TIMEZONE=''
fi
if [ -n "$NEW_HOSTNAME" ] && ! [[ "$NEW_HOSTNAME" =~ ^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$ ]]; then
  warn "\"$NEW_HOSTNAME\" is not a valid machine name — it will not be renamed."
  NEW_HOSTNAME=''
fi

# Can it reach the package mirrors? Without that, installs are skipped, settings still apply.
NET_OK=0
for h in archive.ubuntu.com deb.debian.org security.ubuntu.com; do
  if getent hosts "$h" >/dev/null 2>&1 && timeout 8 bash -c "</dev/tcp/$h/80" 2>/dev/null; then NET_OK=1; break; fi
done
[ "$NET_OK" = 1 ] || warn "No internet connection (cannot reach the Ubuntu mirrors) — anything that needs a download will be skipped. Plug in the network cable and run this again."

export DEBIAN_FRONTEND=noninteractive
APT=(apt-get -y -q -o DPkg::Lock::Timeout=600 -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold)

# Ubuntu runs its own updates right after the first boot; wait instead of failing on the lock.
wait_for_apt() {
  local waited=0
  while pgrep -x 'apt|apt-get|dpkg|unattended-upgr|unattended-upgrade' >/dev/null 2>&1; do
    [ "$waited" -eq 0 ] && warn "Ubuntu is installing updates — waiting for it to finish (up to 10 minutes)…"
    sleep 5; waited=$((waited + 5))
    [ "$waited" -ge 600 ] && { warn "Still busy after 10 minutes — trying anyway."; break; }
  done
}

APT_UPDATED=0
apt_install() {
  local missing=() p
  for p in "$@"; do dpkg -s "$p" >/dev/null 2>&1 || missing+=("$p"); done
  [ ${#missing[@]} -eq 0 ] && return 0
  if [ "$NET_OK" != 1 ]; then warn "needs ${missing[*]}, but there is no internet"; return 1; fi
  wait_for_apt
  if [ "$APT_UPDATED" = 0 ]; then run "${APT[@]}" update >/dev/null || true; APT_UPDATED=1; fi
  say "    installing ${missing[*]}…"
  run "${APT[@]}" install --no-install-recommends "${missing[@]}" >/dev/null
}

svc() {  # svc ACTION UNIT… — systemctl when there is systemd, nothing otherwise
  [ "$HAS_SYSTEMD" = 1 ] || return 0
  run systemctl "$@"
}

backup() { [ -f "$1" ] && [ "$DRY_RUN" != 1 ] && cp -a "$1" "$1.aj-pilot.bak"; return 0; }
restore() { [ -f "$1.aj-pilot.bak" ] && mv -f "$1.aj-pilot.bak" "$1"; return 0; }

# ------------------------------------------------------------------ steps ----

s_packages() {
  local pk=(ca-certificates)
  [ "$DO_TOOLS" = 1 ] && pk+=(curl git htop nano unzip)
  [ "$DO_FIREWALL" = 1 ] && pk+=(ufw)
  [ "$DO_FAIL2BAN" = 1 ] && pk+=(fail2ban)
  [ "$DO_UPDATES" = 1 ] && pk+=(unattended-upgrades)
  [ "$DO_WIFI" = 1 ] && [ ${#WIFI_IFACES[@]} -gt 0 ] && pk+=(iw)
  [ "$DO_WOL" = 1 ] && [ "$PHYSICAL" = 1 ] && pk+=(ethtool)
  if apt_install "${pk[@]}"; then ok "${pk[*]}"; else fail "could not install everything (${pk[*]})"; fi
}

s_ssh() {
  if ! command -v sshd >/dev/null 2>&1 && [ ! -x /usr/sbin/sshd ]; then
    apt_install openssh-server || { fail "openssh-server is not installed and could not be"; return 1; }
  fi
  local conf=/etc/ssh/sshd_config dropin=/etc/ssh/sshd_config.d/10-aj-pilot.conf changed=0 had_dropin=0
  [ -f "$dropin" ] && had_dropin=1
  [ "$DRY_RUN" != 1 ] && mkdir -p /run/sshd

  # The port: a drop-in where sshd reads them (Ubuntu 20.04+), the main file otherwise.
  if grep -qiE '^\s*Include\s+/etc/ssh/sshd_config\.d/' "$conf" 2>/dev/null; then
    if [ "$SSH_PORT" = 22 ]; then
      [ -f "$dropin" ] && { run rm -f "$dropin"; changed=1; }
    else
      backup "$dropin"
      printf '# Written by AJ Pilot setup\nPort %s\n' "$SSH_PORT" | put_file "$dropin" 0644 && changed=1
    fi
  else
    if ! grep -qE "^\s*Port\s+$SSH_PORT\s*$" "$conf" 2>/dev/null && { [ "$SSH_PORT" != 22 ] || grep -qE '^\s*Port\s' "$conf"; }; then
      backup "$conf"
      if [ "$DRY_RUN" = 1 ]; then say "    would set Port $SSH_PORT in $conf"
      else sed -i -E '/^\s*Port\s/d' "$conf"; echo "Port $SSH_PORT" >> "$conf"; fi
      changed=1
    fi
  fi

  # A config that would not start is never left in place.
  if [ "$DRY_RUN" != 1 ] && ! /usr/sbin/sshd -t 2>/tmp/aj-sshd-test; then
    if [ "$had_dropin" = 1 ]; then restore "$dropin"; else rm -f "$dropin"; fi
    restore "$conf"
    fail "the SSH config did not pass its check, so it was put back: $(head -c 200 /tmp/aj-sshd-test)"
    return 1
  fi
  rm -f "$dropin.aj-pilot.bak" "$conf.aj-pilot.bak" 2>/dev/null

  # Ubuntu 22.10+ starts SSH from a socket, which owns the port.
  if [ "$HAS_SYSTEMD" = 1 ] && systemctl list-unit-files ssh.socket >/dev/null 2>&1 \
     && systemctl is-enabled ssh.socket >/dev/null 2>&1; then
    local sock=/etc/systemd/system/ssh.socket.d/10-aj-pilot.conf
    if [ "$SSH_PORT" = 22 ]; then
      [ -f "$sock" ] && { run rm -f "$sock"; changed=1; }
    else
      printf '[Socket]\nListenStream=\nListenStream=%s\n' "$SSH_PORT" | put_file "$sock" 0644 && changed=1
    fi
    svc daemon-reload
    svc enable ssh.socket >/dev/null 2>&1
    [ "$changed" = 1 ] && { svc restart ssh.socket; svc restart ssh >/dev/null 2>&1; }
    svc start ssh.socket
  elif [ "$HAS_SYSTEMD" = 1 ]; then
    svc enable ssh >/dev/null 2>&1 || svc enable sshd >/dev/null 2>&1
    if [ "$changed" = 1 ]; then svc restart ssh || svc restart sshd; else svc start ssh || svc start sshd; fi
  else
    run service ssh restart >/dev/null 2>&1 || run /usr/sbin/sshd
  fi

  # An SSH public key the user pasted, for signing in with a key as well.
  if [ -n "$SSH_PUBKEY" ]; then
    if [ "$USER_OK" = 1 ]; then
      local home; home="$(getent passwd "$PANEL_USER" | cut -d: -f6)"
      local ak="$home/.ssh/authorized_keys"
      if [ -f "$ak" ] && grep -qF "$SSH_PUBKEY" "$ak"; then
        say "    the SSH key is already allowed for $PANEL_USER"
      elif [ "$DRY_RUN" = 1 ]; then
        say "    would add the SSH key to $ak"
      else
        install -d -m 700 -o "$PANEL_USER" -g "$(id -gn "$PANEL_USER")" "$home/.ssh"
        printf '%s\n' "$SSH_PUBKEY" >> "$ak"
        chown "$PANEL_USER:$(id -gn "$PANEL_USER")" "$ak"; chmod 600 "$ak"
        say "    the SSH key can now sign in as $PANEL_USER"
      fi
    else
      warn "no account \"$PANEL_USER\" to add the SSH key to"
    fi
  fi

  if [ "$DRY_RUN" = 1 ]; then ok "SSH on port $SSH_PORT"; return 0; fi
  sleep 1
  if command -v ss >/dev/null 2>&1 && ss -ltnH 2>/dev/null | grep -qE "[:.]$SSH_PORT\s"; then
    ok "SSH is running on port $SSH_PORT"
  elif [ "$IN_CONTAINER" = 1 ]; then
    ok "SSH configured for port $SSH_PORT (inside a container it starts with the container)"
  else
    fail "SSH is configured but nothing listens on port $SSH_PORT — see: systemctl status ssh"
    return 1
  fi
}

s_firewall() {
  [ "$IN_CONTAINER" = 1 ] && { skip "not inside a container"; return 0; }
  command -v ufw >/dev/null 2>&1 || apt_install ufw || { fail "ufw is not installed"; return 1; }
  # SSH is let in before the firewall goes up, so this run can never lock you out.
  run ufw allow "$SSH_PORT/tcp" comment 'SSH (AJ Pilot)' >/dev/null
  [ "$SSH_PORT" != 22 ] && say "    port 22 stays open too until you close it: sudo ufw delete allow 22/tcp"
  if [ "$WEB_PORTS" = 1 ]; then
    run ufw allow 80/tcp comment 'HTTP' >/dev/null
    run ufw allow 443/tcp comment 'HTTPS' >/dev/null
  fi
  if run ufw --force enable >/dev/null; then
    ok "on — allows SSH ($SSH_PORT)$([ "$WEB_PORTS" = 1 ] && echo ', 80 and 443')"
  else
    fail "ufw could not be turned on"; return 1
  fi
}

s_fail2ban() {
  [ "$IN_CONTAINER" = 1 ] && { skip "not inside a container"; return 0; }
  apt_install fail2ban || { fail "fail2ban is not installed"; return 1; }
  # Newer Ubuntu has no auth.log by default; the journal is always there.
  local backend=auto; [ "$HAS_SYSTEMD" = 1 ] && [ ! -f /var/log/auth.log ] && backend=systemd
  printf '# Written by AJ Pilot setup\n[sshd]\nenabled = true\nport = %s\nbackend = %s\nmaxretry = 5\nfindtime = 10m\nbantime = 1h\n' "$SSH_PORT" "$backend" \
    | put_file /etc/fail2ban/jail.d/aj-pilot.local 0644
  svc enable fail2ban >/dev/null 2>&1
  svc restart fail2ban && ok "bans an address for 1 hour after 5 failed SSH sign-ins" || { fail "fail2ban would not start — see: systemctl status fail2ban"; return 1; }
}

s_sleep() {
  [ "$PHYSICAL" = 1 ] || { skip "not needed on a virtual machine"; return 0; }
  [ "$HAS_SYSTEMD" = 1 ] || { skip "no systemd"; return 0; }
  run systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target suspend-then-hibernate.target >/dev/null 2>&1
  printf '# Written by AJ Pilot setup\n[Sleep]\nAllowSuspend=no\nAllowHibernation=no\nAllowHybridSleep=no\nAllowSuspendThenHibernate=no\n' \
    | put_file /etc/systemd/sleep.conf.d/aj-pilot.conf 0644
  # A desktop's own power settings ask to suspend when idle; tell it not to.
  if [ "$HAS_GUI" = 1 ] && command -v dconf >/dev/null 2>&1; then
    desktop_settings
  fi
  ok "the machine never sleeps, suspends or hibernates"
}

# GNOME's defaults for every user, through a system dconf profile.
DCONF_DONE=0
desktop_settings() {
  [ "$DCONF_DONE" = 1 ] && return 0
  local idle=0; [ "$DO_SCREEN" = 1 ] && idle=$((SCREEN_MINUTES * 60))
  printf 'user-db:user\nsystem-db:local\n' | put_file /etc/dconf/profile/user 0644
  printf "# Written by AJ Pilot setup\n[org/gnome/settings-daemon/plugins/power]\nsleep-inactive-ac-type='nothing'\nsleep-inactive-battery-type='nothing'\n\n[org/gnome/desktop/session]\nidle-delay=uint32 %s\n" "$idle" \
    | put_file /etc/dconf/db/local.d/00-aj-pilot 0644
  run dconf update
  DCONF_DONE=1
}

s_lid() {
  [ "$PHYSICAL" = 1 ] || { skip "not a physical machine"; return 0; }
  [ "$IS_LAPTOP" = 1 ] || { skip "no laptop lid on this machine"; return 0; }
  [ "$HAS_SYSTEMD" = 1 ] || { skip "no systemd"; return 0; }
  if printf '# Written by AJ Pilot setup\n[Login]\nHandleLidSwitch=ignore\nHandleLidSwitchExternalPower=ignore\nHandleLidSwitchDocked=ignore\nHandleSuspendKey=ignore\nHandleHibernateKey=ignore\nIdleAction=ignore\n' \
    | put_file /etc/systemd/logind.conf.d/aj-pilot.conf 0644; then
    # Restarting logind ends a desktop session; with one open, it waits for the restart.
    if loginctl list-sessions --no-legend 2>/dev/null | awk '{print $1}' | while read -r s; do loginctl show-session "$s" -p Type --value 2>/dev/null; done | grep -qE 'x11|wayland'; then
      NEEDS_REBOOT=1
      ok "closing the lid will do nothing (takes effect after a restart — a desktop session is open)"
    else
      svc restart systemd-logind
      ok "closing the lid does nothing — the laptop keeps running"
    fi
  else
    ok "closing the lid already does nothing"
  fi
}

s_screen() {
  [ "$PHYSICAL" = 1 ] || { skip "no screen on a virtual machine"; return 0; }
  local secs=$((SCREEN_MINUTES * 60))
  # Right now, on the console…
  if [ -e /dev/tty1 ] && command -v setterm >/dev/null 2>&1; then
    run sh -c "TERM=linux setterm --blank $SCREEN_MINUTES --powerdown $SCREEN_MINUTES </dev/tty1 >/dev/tty1 2>/dev/null" || true
  fi
  # …and after every restart, from the kernel command line.
  if [ -f /etc/default/grub ] && command -v update-grub >/dev/null 2>&1; then
    local g=/etc/default/grub
    if grep -qE "^GRUB_CMDLINE_LINUX_DEFAULT=.*consoleblank=$secs([ \"]|$)" "$g"; then
      :
    elif [ "$DRY_RUN" = 1 ]; then
      say "    would set consoleblank=$secs in $g and run update-grub"
    else
      backup "$g"
      if grep -qE '^GRUB_CMDLINE_LINUX_DEFAULT=.*consoleblank=' "$g"; then
        sed -i -E "s/consoleblank=[0-9]+/consoleblank=$secs/" "$g"
      elif grep -qE '^GRUB_CMDLINE_LINUX_DEFAULT=' "$g"; then
        sed -i -E "s/^GRUB_CMDLINE_LINUX_DEFAULT=\"/&consoleblank=$secs /" "$g"
      else
        echo "GRUB_CMDLINE_LINUX_DEFAULT=\"consoleblank=$secs\"" >> "$g"
      fi
      if update-grub >/dev/null 2>&1; then rm -f "$g.aj-pilot.bak"; NEEDS_REBOOT=1
      else restore "$g"; fail "update-grub failed, so the boot settings were put back"; return 1; fi
    fi
  else
    warn "no GRUB here — the screen setting lasts until the next restart"
  fi
  [ "$HAS_GUI" = 1 ] && command -v dconf >/dev/null 2>&1 && desktop_settings
  ok "the screen turns off after $SCREEN_MINUTES minute(s) of no typing; the computer keeps running"
}

s_wifi() {
  [ ${#WIFI_IFACES[@]} -gt 0 ] || { skip "no Wi-Fi on this machine"; return 0; }
  command -v iw >/dev/null 2>&1 || apt_install iw || true
  local i
  if command -v iw >/dev/null 2>&1; then
    for i in "${WIFI_IFACES[@]}"; do run iw dev "$i" set power_save off 2>/dev/null || true; done
  fi
  if [ -d /etc/NetworkManager ]; then
    printf '# Written by AJ Pilot setup\n[connection]\nwifi.powersave = 2\n' | put_file /etc/NetworkManager/conf.d/aj-pilot-wifi-powersave.conf 0644 \
      && svc reload NetworkManager >/dev/null 2>&1
  elif [ "$HAS_SYSTEMD" = 1 ]; then
    printf '[Unit]\nDescription=Wi-Fi power saving off (AJ Pilot)\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=oneshot\nExecStart=/bin/sh -c '"'"'for d in /sys/class/net/*; do [ -d "$d/wireless" ] && iw dev "$(basename "$d")" set power_save off; done; true'"'"'\n\n[Install]\nWantedBy=multi-user.target\n' \
      | put_file /etc/systemd/system/aj-pilot-wifi-powersave.service 0644
    svc daemon-reload; svc enable aj-pilot-wifi-powersave.service >/dev/null 2>&1
  fi
  ok "Wi-Fi power saving is off on ${WIFI_IFACES[*]} (a network cable is still steadier)"
}

s_wol() {
  [ "$PHYSICAL" = 1 ] || { skip "not a physical machine"; return 0; }
  command -v ethtool >/dev/null 2>&1 || apt_install ethtool || { fail "ethtool is not installed"; return 1; }
  local d i on=()
  for d in /sys/class/net/*; do
    i="$(basename "$d")"
    case "$i" in lo|docker*|veth*|br-*|virbr*|tun*|tap*|wg*) continue ;; esac
    [ -d "$d/wireless" ] && continue
    ethtool "$i" 2>/dev/null | grep -qE 'Supports Wake-on:.*g' || continue
    run ethtool -s "$i" wol g 2>/dev/null && on+=("$i ($(cat "$d/address"))")
  done
  [ ${#on[@]} -gt 0 ] || { skip "no wired network card here supports Wake-on-LAN"; return 0; }
  if [ "$HAS_SYSTEMD" = 1 ]; then
    printf '[Unit]\nDescription=Wake-on-LAN (AJ Pilot)\nAfter=network.target\n\n[Service]\nType=oneshot\nExecStart=/bin/sh -c '"'"'for d in /sys/class/net/*; do i=$(basename "$d"); [ -d "$d/wireless" ] && continue; ethtool "$i" 2>/dev/null | grep -q "Supports Wake-on:.*g" && ethtool -s "$i" wol g; done; true'"'"'\n\n[Install]\nWantedBy=multi-user.target\n' \
      | put_file /etc/systemd/system/aj-pilot-wol.service 0644
    svc daemon-reload; svc enable aj-pilot-wol.service >/dev/null 2>&1
  fi
  ok "Wake-on-LAN on for ${on[*]}"
}

s_time() {
  local parts=()
  if [ -n "$TIMEZONE" ]; then
    if [ "$HAS_SYSTEMD" = 1 ] && command -v timedatectl >/dev/null 2>&1; then
      run timedatectl set-timezone "$TIMEZONE" && parts+=("time zone $TIMEZONE")
    else
      run ln -sf "/usr/share/zoneinfo/$TIMEZONE" /etc/localtime && { [ "$DRY_RUN" = 1 ] || echo "$TIMEZONE" > /etc/timezone; } && parts+=("time zone $TIMEZONE")
    fi
  fi
  if [ "$HAS_SYSTEMD" = 1 ] && command -v timedatectl >/dev/null 2>&1 && [ "$IN_CONTAINER" = 0 ]; then
    run timedatectl set-ntp true >/dev/null 2>&1 && parts+=("clock synced automatically")
  fi
  if [ ${#parts[@]} -gt 0 ]; then ok "${parts[0]}${parts[1]:+, ${parts[1]}}"; else skip "nothing to change"; fi
}

s_updates() {
  apt_install unattended-upgrades || { fail "unattended-upgrades is not installed"; return 1; }
  printf 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\nAPT::Periodic::AutocleanInterval "7";\n' \
    | put_file /etc/apt/apt.conf.d/20auto-upgrades 0644
  ok "security updates install themselves every day"
}

s_sudo() {
  [ "$PANEL_USER" = root ] && { skip "signing in as root — no sudo needed"; return 0; }
  [ "$USER_OK" = 1 ] || { fail "there is no account \"$PANEL_USER\" (use --user NAME)"; return 1; }
  local f=/etc/sudoers.d/90-aj-pilot tmp
  if [ "$DRY_RUN" = 1 ]; then say "    would write $f: $PANEL_USER ALL=(ALL) NOPASSWD:ALL (checked with visudo first)"; ok "$PANEL_USER can use sudo without a password"; return 0; fi
  # A minimal Debian install with a root password has no sudo at all.
  if ! command -v visudo >/dev/null 2>&1; then
    apt_install sudo || { fail "sudo is not installed and could not be — install it (apt install sudo) and run this again"; return 1; }
  fi
  tmp="$(mktemp)"
  printf '# Written by AJ Pilot setup: lets the panel manage this machine without a sudo password.\n%s ALL=(ALL) NOPASSWD:ALL\n' "$PANEL_USER" > "$tmp"
  # Never install a sudoers file visudo rejects — a broken one locks sudo out for everyone.
  if ! visudo -cf "$tmp" >/dev/null 2>&1; then rm -f "$tmp"; fail "the sudo rule did not pass visudo, nothing was changed"; return 1; fi
  if put_file "$f" 0440 < "$tmp"; then ok "$PANEL_USER can use sudo without a password"; else ok "$PANEL_USER already has passwordless sudo"; fi
  rm -f "$tmp"
  id -nG "$PANEL_USER" | grep -qw sudo || run usermod -aG sudo "$PANEL_USER"
}

s_swap() {
  [ "$IN_CONTAINER" = 1 ] && { skip "not inside a container"; return 0; }
  if [ -n "$(swapon --show --noheadings 2>/dev/null)" ]; then skip "swap is already set up"; return 0; fi
  local mem_kb free_kb
  mem_kb="$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)"
  [ "${mem_kb:-0}" -ge 4000000 ] && { skip "$((mem_kb / 1024 / 1024)) GB of memory — no swap needed"; return 0; }
  free_kb="$(df -Pk / | awk 'NR==2 {print $4}')"
  [ "${free_kb:-0}" -lt 6000000 ] && { skip "less than 6 GB free on disk"; return 0; }
  if [ "$DRY_RUN" = 1 ]; then say "    would create a 2 GB /swapfile"; ok "2 GB swap"; return 0; fi
  if [ ! -f /swapfile ]; then
    fallocate -l 2G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
  fi
  chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile \
    || { fail "the swap file could not be turned on"; return 1; }
  grep -qE '^/swapfile\s' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  ok "2 GB swap file, used after every restart"
}

s_hostname() {
  [ -n "$NEW_HOSTNAME" ] || { skip "keeping the name $(hostname)"; return 0; }
  [ "$(hostname)" = "$NEW_HOSTNAME" ] && { ok "already called $NEW_HOSTNAME"; return 0; }
  if command -v hostnamectl >/dev/null 2>&1 && [ "$HAS_SYSTEMD" = 1 ]; then run hostnamectl set-hostname "$NEW_HOSTNAME"
  else [ "$DRY_RUN" = 1 ] || { echo "$NEW_HOSTNAME" > /etc/hostname; hostname "$NEW_HOSTNAME" 2>/dev/null; }; fi
  if [ "$DRY_RUN" != 1 ]; then
    if grep -qE '^127\.0\.1\.1\s' /etc/hosts; then sed -i -E "s/^127\.0\.1\.1\s.*/127.0.1.1\t$NEW_HOSTNAME/" /etc/hosts
    else printf '127.0.1.1\t%s\n' "$NEW_HOSTNAME" >> /etc/hosts; fi
  fi
  ok "renamed to $NEW_HOSTNAME"
}

s_docker() {
  if command -v docker >/dev/null 2>&1; then ok "already installed ($(docker --version 2>/dev/null | cut -d, -f1))"; return 0; fi
  [ "$NET_OK" = 1 ] || { fail "needs the internet"; return 1; }
  apt_install curl ca-certificates || true
  wait_for_apt
  if [ "$DRY_RUN" = 1 ]; then say "    would run Docker's installer from get.docker.com"
  else curl -fsSL https://get.docker.com | sh >/dev/null 2>&1 || { fail "Docker's installer failed"; return 1; }; fi
  [ "$USER_OK" = 1 ] && [ "$PANEL_USER" != root ] && run usermod -aG docker "$PANEL_USER"
  svc enable --now docker >/dev/null 2>&1
  ok "Docker installed and starts on boot"
}

# ------------------------------------------------------------------- run ----

step 'Packages'                          s_packages
step 'SSH'                               s_ssh
[ "$DO_FIREWALL" = 1 ] && step 'Firewall'                 s_firewall
[ "$DO_FAIL2BAN" = 1 ] && step 'Block password guessing'  s_fail2ban
[ "$DO_SLEEP" = 1 ]    && step 'Never sleep'              s_sleep
[ "$DO_LID" = 1 ]      && step 'Lid closed keeps running' s_lid
[ "$DO_SCREEN" = 1 ]   && step 'Screen turns off'         s_screen
[ "$DO_WIFI" = 1 ]     && step 'Wi-Fi never dozes'        s_wifi
[ "$DO_WOL" = 1 ]      && step 'Wake-on-LAN'              s_wol
[ "$DO_TIME" = 1 ]     && step 'Time'                     s_time
[ "$DO_UPDATES" = 1 ]  && step 'Security updates'         s_updates
[ "$DO_SUDO" = 1 ]     && step 'Passwordless sudo'        s_sudo
[ "$DO_SWAP" = 1 ]     && step 'Swap'                     s_swap
step 'Machine name'                      s_hostname
[ "$DO_DOCKER" = 1 ]   && step 'Docker'                   s_docker

# --------------------------------------------------------------- summary ----

FAILED=0
printf '\n%s──────────── Summary ────────────%s\n' "$B" "$N"
for r in "${RESULTS[@]}"; do
  IFS='|' read -r st name detail <<< "$r"
  case "$st" in
    ok)   printf '  %s✓%s %-26s %s\n' "$G" "$N" "$name" "$detail" ;;
    skip) printf '  %s–%s %-26s %s%s%s\n' "$D" "$N" "$name" "$D" "$detail" "$N" ;;
    fail) printf '  %s✗%s %-26s %s\n' "$R" "$N" "$name" "$detail"; FAILED=$((FAILED + 1)) ;;
  esac
done

LAN_IP="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i <= NF; i++) if ($i == "src") { print $(i + 1); exit }}')"
[ -z "$LAN_IP" ] && LAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
ALL_IPS="$(hostname -I 2>/dev/null | xargs || true)"
PUBLIC_IP=''
[ "$NET_OK" = 1 ] && command -v curl >/dev/null 2>&1 && PUBLIC_IP="$(curl -4 -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)"
FP="$(ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub 2>/dev/null | awk '{print $2}')"
SUDO_NOTE='your sudo password (the same as the login password)'
[ "$PANEL_USER" = root ] && SUDO_NOTE='leave empty (signing in as root)'
[ -f /etc/sudoers.d/90-aj-pilot ] && grep -q "^$PANEL_USER " /etc/sudoers.d/90-aj-pilot 2>/dev/null && SUDO_NOTE='leave empty (passwordless sudo is on)'

printf '\n%s════════════ Connect it in AJ Pilot ════════════%s\n' "$B" "$N"
say "  + Add server → My server is ready, then fill in:"
say ""
SHOW_IP="${LAN_IP:-the address shown by: hostname -I}"
say "    Host / IP       ${B}${SHOW_IP}${N}"
[ -n "$PUBLIC_IP" ] && [ "$PUBLIC_IP" != "$LAN_IP" ] && say "                    (from outside this network: ${B}$PUBLIC_IP${N} — only with port $SSH_PORT forwarded on the router)"
say "    Port            ${B}$SSH_PORT${N}"
say "    SSH username    ${B}$PANEL_USER${N}"
say "    Authentication  Password — the login password of $PANEL_USER$([ -n "$SSH_PUBKEY" ] && echo ' (or your private key)')"
say "    Sudo password   $SUDO_NOTE"
[ -n "$FP" ] && say "    Host key        $FP  ${D}(the panel shows it on first connect)${N}"
[ -n "$ALL_IPS" ] && [ "$ALL_IPS" != "$LAN_IP" ] && say "    ${D}All addresses: $ALL_IPS${N}"
say ""
case "$LAN_IP" in
  10.*|192.168.*|172.1[6-9].*|172.2[0-9].*|172.3[0-1].*)
    say "  ${Y}•${N} $LAN_IP is a home/office network address. Reserve it in your router (\"DHCP reservation\") so it never changes."
    say "  ${Y}•${N} If AJ Pilot runs outside this network, add a ${B}Connector${N} on a PC here — see Connectors in the panel." ;;
esac
[ "$PHYSICAL" = 1 ] && say "  ${Y}•${N} To switch back on after a power cut: BIOS → \"Restore on AC power loss\" → Power On."
[ "$IS_LAPTOP" = 1 ] && say "  ${Y}•${N} Keep the laptop plugged in; if its BIOS has a battery charge limit (60–80%), turn it on."
[ "$DRY_RUN" != 1 ] && say "  ${D}Full log: $LOG${N}"

if [ "$DRY_RUN" = 1 ]; then
  say "\n${Y}Dry run finished — nothing was changed.${N} Run without --dry-run to do it."
  exit 0
fi

if [ "$NEEDS_REBOOT" = 1 ]; then
  if [ "$REBOOT" = 1 ]; then say "\nRestarting in 10 seconds to finish (Ctrl+C to stop)…"; sleep 10; systemctl reboot 2>/dev/null || reboot
  else say "\n${Y}Restart once to finish:${N} sudo reboot"; fi
fi

if [ "$FAILED" -gt 0 ]; then
  say "\n${R}$FAILED step(s) failed${N} — the rest is done. Fix what the summary says and run this file again; finished steps are skipped."
  exit 1
fi
say "\n${G}All done.${N}"
exit 0
