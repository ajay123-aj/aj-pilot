# A throwaway Ubuntu server for the test suite: SSH on 22, a sudo user, cron.
# Not systemd — features that need systemd are expected to report it, not crash.
FROM ubuntu:22.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssh-server sudo cron curl ca-certificates procps iproute2 lsb-release less nano \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /run/sshd \
 && useradd -m -s /bin/bash -G sudo deploy \
 && echo 'deploy:Deploy-Pass-123' | chpasswd \
 && echo 'root:Root-Pass-123' | chpasswd \
 && sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin yes/; s/^#\?PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config
EXPOSE 22
CMD ["/bin/sh", "-c", "service cron start >/dev/null 2>&1; exec /usr/sbin/sshd -D -e"]
