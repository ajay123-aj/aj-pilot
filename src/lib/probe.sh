#!/usr/bin/env bash
# Collects a full Ubuntu system profile. Every section is best-effort: a missing
# tool prints nothing for that section instead of failing the run.
export LC_ALL=C
export PATH="$PATH:/usr/sbin:/sbin:/usr/local/bin"

sec() { printf '\n@@@%s\n' "$1"; }
have() { command -v "$1" >/dev/null 2>&1; }

SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  if have sudo && sudo -n true 2>/dev/null; then SUDO="sudo -n"; fi
fi

sec probe_meta
echo "collected_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "run_as=$(id -un)"
echo "uid=$(id -u)"
echo "sudo_available=$([ -n "$SUDO" ] && echo yes || echo no)"
echo "shell=$SHELL"

sec os_release
cat /etc/os-release 2>/dev/null

sec identity
echo "hostname=$(hostname 2>/dev/null)"
echo "fqdn=$(hostname -f 2>/dev/null)"
echo "kernel=$(uname -r 2>/dev/null)"
echo "kernel_full=$(uname -sr 2>/dev/null)"
echo "arch=$(uname -m 2>/dev/null)"
echo "machine_id=$(cat /etc/machine-id 2>/dev/null)"
echo "timezone=$(timedatectl show -p Timezone --value 2>/dev/null || cat /etc/timezone 2>/dev/null)"
echo "local_time=$(date '+%Y-%m-%d %H:%M:%S %Z' 2>/dev/null)"
echo "virtualization=$(systemd-detect-virt 2>/dev/null || echo unknown)"
echo "boot_time=$(uptime -s 2>/dev/null)"
echo "init=$(ps -p 1 -o comm= 2>/dev/null)"
echo "selinux_apparmor=$(have aa-status && ($SUDO aa-status --enabled 2>/dev/null && echo apparmor-enabled || echo apparmor-present) || echo none)"

sec uptime
cat /proc/uptime 2>/dev/null
sec loadavg
cat /proc/loadavg 2>/dev/null
sec logged_in
who 2>/dev/null

sec cpu
lscpu 2>/dev/null
sec cpu_fallback
grep -m1 'model name' /proc/cpuinfo 2>/dev/null
echo "cores=$(nproc 2>/dev/null)"

sec meminfo
head -n 8 /proc/meminfo 2>/dev/null
grep -E '^(SwapTotal|SwapFree|Cached|Buffers)' /proc/meminfo 2>/dev/null

sec disk
df -PB1 -T -x tmpfs -x devtmpfs -x squashfs -x overlay 2>/dev/null
sec inodes
df -Pi -x tmpfs -x devtmpfs -x squashfs -x overlay 2>/dev/null
sec blockdev
lsblk -b -P -o NAME,SIZE,TYPE,MOUNTPOINT,FSTYPE,MODEL 2>/dev/null

sec net_ipv4
ip -o -4 addr show 2>/dev/null
sec net_ipv6
ip -o -6 addr show scope global 2>/dev/null
sec net_gateway
ip route show default 2>/dev/null
sec net_dns
(resolvectl dns 2>/dev/null || grep -E '^nameserver' /etc/resolv.conf 2>/dev/null)
sec net_public_ip
(curl -fsS --max-time 4 https://api.ipify.org 2>/dev/null || curl -fsS --max-time 4 https://ifconfig.me 2>/dev/null || echo "")
sec net_ports
$SUDO ss -H -tulpn 2>/dev/null || ss -H -tulpn 2>/dev/null

sec proc_cpu
ps -eo pid,user:20,pcpu,pmem,rss,comm --sort=-pcpu 2>/dev/null | head -n 11
sec proc_mem
ps -eo pid,user:20,pcpu,pmem,rss,comm --sort=-rss 2>/dev/null | head -n 11
sec proc_count
echo "total=$(ps -e --no-headers 2>/dev/null | wc -l)"

sec services
systemctl list-units --type=service --state=running --no-pager --no-legend 2>/dev/null | head -n 40
sec services_failed
systemctl list-units --type=service --state=failed --no-pager --no-legend 2>/dev/null

sec packages
echo "dpkg_installed=$(dpkg-query -f '.\n' -W 2>/dev/null | wc -l)"
echo "snap_installed=$(have snap && (snap list 2>/dev/null | tail -n +2 | wc -l) || echo 0)"
if [ -x /usr/lib/update-notifier/apt-check ]; then
  echo "apt_check=$(/usr/lib/update-notifier/apt-check 2>&1)"
fi
echo "reboot_required=$([ -f /var/run/reboot-required ] && echo yes || echo no)"
echo "reboot_packages=$(cat /var/run/reboot-required.pkgs 2>/dev/null | tr '\n' ',')"
echo "unattended_upgrades=$(systemctl is-enabled unattended-upgrades 2>/dev/null || echo unknown)"

sec security
echo "ufw=$($SUDO ufw status 2>/dev/null | head -n1 || echo 'not-installed')"
echo "fail2ban=$(systemctl is-active fail2ban 2>/dev/null || echo 'not-installed')"
echo "ssh_port=$(grep -Ei '^\s*Port\s+' /etc/ssh/sshd_config 2>/dev/null | awk '{print $2}' | tr '\n' ',')"
echo "permit_root_login=$(grep -Ei '^\s*PermitRootLogin\s+' /etc/ssh/sshd_config 2>/dev/null | awk '{print $2}' | head -n1)"
echo "password_auth=$(grep -Ei '^\s*PasswordAuthentication\s+' /etc/ssh/sshd_config 2>/dev/null | awk '{print $2}' | head -n1)"
echo "sudo_users=$(getent group sudo 2>/dev/null | cut -d: -f4)"
echo "last_logins=$(last -n 3 2>/dev/null | head -n 3 | tr '\n' '|')"

sec tooling
for t in docker git node npm yarn pnpm python3 pip3 nginx apache2 caddy certbot pm2 mysql psql redis-server java go rsync ufw fail2ban-client; do
  if have "$t"; then
    v=$("$t" --version 2>/dev/null | head -n1)
    [ -z "$v" ] && v=$("$t" -v 2>/dev/null | head -n1)
    [ -z "$v" ] && v=installed
    echo "$t=$v"
  fi
done
if have docker; then
  echo "docker_compose=$(docker compose version 2>/dev/null | head -n1)"
fi

sec docker_state
if have docker; then
  if $SUDO docker info >/dev/null 2>&1 || docker info >/dev/null 2>&1; then
    D="docker"; $SUDO docker info >/dev/null 2>&1 && D="$SUDO docker"
    echo "accessible=yes"
    echo "server_version=$($D info --format '{{.ServerVersion}}' 2>/dev/null)"
    echo "containers_running=$($D info --format '{{.ContainersRunning}}' 2>/dev/null)"
    echo "containers_stopped=$($D info --format '{{.ContainersStopped}}' 2>/dev/null)"
    echo "images=$($D info --format '{{.Images}}' 2>/dev/null)"
    echo "storage_driver=$($D info --format '{{.Driver}}' 2>/dev/null)"
  else
    echo "accessible=no"
  fi
else
  echo "accessible=absent"
fi

sec docker_containers
if have docker; then
  D="docker"; $SUDO docker info >/dev/null 2>&1 && D="$SUDO docker"
  $D ps -a --format '{{.Names}}\t{{.Image}}\t{{.State}}\t{{.Status}}\t{{.Ports}}' 2>/dev/null | head -n 30
fi

sec mysql_server
echo "client_installed=$(have mysql && echo yes || echo no)"
if have mysqld || have mariadbd || [ -d /var/lib/mysql ]; then
  echo "installed=yes"
  echo "client_version=$(mysql --version 2>/dev/null | head -n1)"
  echo "server_version=$( (mysqld --version 2>/dev/null || mariadbd --version 2>/dev/null) | head -n1)"
  svc="none"
  for s in mysql mariadb mysqld; do
    st=$(systemctl is-active "$s" 2>/dev/null)
    if [ "$st" = "active" ]; then svc="$s"; break; fi
  done
  echo "service=$svc"
  echo "service_state=$([ "$svc" != "none" ] && echo active || echo inactive)"
  echo "enabled=$([ "$svc" != "none" ] && systemctl is-enabled "$svc" 2>/dev/null || echo unknown)"
  conf=$(grep -rhE '^\s*(bind-address|port|datadir)\s*=' /etc/mysql /etc/my.cnf /etc/my.cnf.d 2>/dev/null)
  echo "bind_address=$(echo "$conf" | grep bind-address | head -n1 | cut -d= -f2 | tr -d ' ')"
  echo "port=$(echo "$conf" | grep -E '^\s*port' | head -n1 | cut -d= -f2 | tr -d ' ')"
  echo "datadir=$(echo "$conf" | grep datadir | head -n1 | cut -d= -f2 | tr -d ' ')"
  echo "datadir_bytes=$($SUDO du -sb /var/lib/mysql 2>/dev/null | awk '{print $1}')"
  echo "listening=$( ($SUDO ss -H -tlnp 2>/dev/null || ss -H -tln 2>/dev/null) | grep -E ':(3306|33060)\s' | head -n2 | tr '\n' '|')"
else
  echo "installed=no"
fi

sec web_sites
ls -1 /etc/nginx/sites-enabled 2>/dev/null
sec crontab
crontab -l 2>/dev/null | grep -v '^#' | head -n 20

sec probe_end
echo done
