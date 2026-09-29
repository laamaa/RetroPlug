#!/bin/sh
# Starts sshd so tooling on another machine can drive this container directly.
# Orca dials the loopback port published on the Docker host, so nothing is
# exposed beyond it. Runs as root via sudo from postStartCommand; $1 is the
# login user (the container's remoteUser).
#
# Opt-in: without DEVCONTAINER_SSH_PUBLIC_KEY this exits silently, so a normal
# `devcontainer up` is unchanged for anyone not using it.
set -eu

user="${1:-node}"
[ -n "${DEVCONTAINER_SSH_PUBLIC_KEY:-}" ] || exit 0
pgrep -x sshd >/dev/null 2>&1 && exit 0

# The Dockerfile writes this when the project has one; create it here when it
# does not, so an image-only devcontainer works with no Dockerfile at all.
mkdir -p /run/sshd /etc/ssh/sshd_config.d
if [ ! -f /etc/ssh/sshd_config.d/devcontainer-ssh.conf ]; then
  printf '%s\n' \
    'PasswordAuthentication no' \
    'PermitRootLogin no' \
    'KbdInteractiveAuthentication no' \
    'HostKey /etc/ssh/keys/ssh_host_ed25519_key' \
    > /etc/ssh/sshd_config.d/devcontainer-ssh.conf
  rm -f /etc/ssh/ssh_host_*
fi

# Generated on first start rather than baked into the image, which would hand
# every container built from it the same identity. /etc/ssh/keys is a volume, so
# the identity survives rebuilds and clients never have to re-pin.
if [ ! -f /etc/ssh/keys/ssh_host_ed25519_key ]; then
  mkdir -p /etc/ssh/keys
  ssh-keygen -q -t ed25519 -N '' -f /etc/ssh/keys/ssh_host_ed25519_key
fi
chmod 700 /etc/ssh/keys
chmod 600 /etc/ssh/keys/ssh_host_ed25519_key
chmod 644 /etc/ssh/keys/ssh_host_ed25519_key.pub
chown -R root:root /etc/ssh/keys

home="$(getent passwd "$user" | cut -d: -f6)"
group="$(id -gn "$user")"
install -d -m 700 -o "$user" -g "$group" "$home/.ssh"
printf '%s\n' "$DEVCONTAINER_SSH_PUBLIC_KEY" > "$home/.ssh/authorized_keys"
chmod 600 "$home/.ssh/authorized_keys"
chown "$user:$group" "$home/.ssh/authorized_keys"

/usr/sbin/sshd
