#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this script with sudo." >&2
  exit 1
fi

deploy_user="${SUDO_USER:-ubuntu}"

apt-get update
apt-get install -y ca-certificates curl
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc

. /etc/os-release
architecture="$(dpkg --print-architecture)"
echo "deb [arch=${architecture} signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
  > /etc/apt/sources.list.d/docker.list

apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker
usermod -aG docker "$deploy_user"

if ! swapon --show=NAME --noheadings | grep -qx /swapfile; then
  if [[ ! -f /swapfile ]]; then
    fallocate -l 2G /swapfile
    chmod 600 /swapfile
    mkswap /swapfile
  fi
  swapon /swapfile
fi
if ! grep -Eq '^/swapfile[[:space:]]' /etc/fstab; then
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

install -d -m 0750 -o "$deploy_user" -g "$deploy_user" /opt/telegram-news-agent

echo "Oracle host is ready. Reconnect once so Docker group membership takes effect."
