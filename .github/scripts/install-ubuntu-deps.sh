#!/usr/bin/env bash
# Use bounded Ubuntu archive mirrors with the distribution's existing signing keys.
# Keep the hosted runner's source files and third-party repositories unchanged.
set -euo pipefail
if (( $# == 0 )); then
  printf 'At least one Ubuntu package is required\n' >&2
  exit 2
fi
for package in "$@"; do
  [[ "$package" =~ ^[a-z0-9][a-z0-9+.-]*$ ]] || {
    printf 'Invalid Ubuntu package name: %s\n' "$package" >&2
    exit 2
  }
done
source /etc/os-release
[[ "$ID" == ubuntu ]] || { printf 'Ubuntu runner required\n' >&2; exit 2; }
case "$VERSION_CODENAME" in
  jammy|noble|resolute) ;;
  *) printf 'Unsupported Ubuntu suite: %s\n' "$VERSION_CODENAME" >&2; exit 2 ;;
esac
keyring=/usr/share/keyrings/ubuntu-archive-keyring.gpg
[[ -r "$keyring" ]] || { printf 'Ubuntu archive keyring is missing\n' >&2; exit 2; }
sources="$(mktemp)"
trap 'rm -- "$sources"' EXIT
apt_options=(
  -o "Dir::Etc::sourcelist=$sources"
  -o Dir::Etc::sourceparts=-
  -o APT::Update::Error-Mode=any
  -o Acquire::Retries=0
  -o Acquire::http::Timeout=15
  -o Acquire::https::Timeout=15
)
root=()
if (( EUID != 0 )); then root=(sudo); fi
installed=false
for archive in https://mirrors.edge.kernel.org/ubuntu/ https://archive.ubuntu.com/ubuntu/; do
  : > "$sources"
  for pocket in '' -updates -security -backports; do
    uri="$archive"
    if [[ "$archive" == https://archive.ubuntu.com/ubuntu/ && "$pocket" == -security ]]; then
      uri=https://security.ubuntu.com/ubuntu/
    fi
    printf 'deb [signed-by=%s] %s %s%s main restricted universe multiverse\n' \
      "$keyring" "$uri" "$VERSION_CODENAME" "$pocket" >> "$sources"
  done
  chmod 644 "$sources"
  printf 'Ubuntu dependency archive: %s, suite=%s, architecture=%s\n' \
    "$archive" "$VERSION_CODENAME" "$(dpkg --print-architecture)"
  if timeout --kill-after=10s 180s "${root[@]}" apt-get "${apt_options[@]}" update && \
     timeout --kill-after=10s 600s "${root[@]}" apt-get "${apt_options[@]}" install --yes "$@"; then
    installed=true
    break
  fi
  printf 'Archive failed; trying the next signed Ubuntu archive if available\n' >&2
done
[[ "$installed" == true ]] || exit 100

dpkg-query -W -f='${Package}\t${Version}\t${Status}\n' "$@"
