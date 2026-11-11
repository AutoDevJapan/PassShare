#!/usr/bin/env bash
set -euo pipefail
dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# Exercise the actual finite archive loop with an injected apt command. No
# network, package install, root privileges or system source mutation occurs.
loop="$(sed -n '/^installed=false/,$p' "$dir/install-ubuntu-deps.sh")"
for mode in first fallback installfallback allfail installfail; do
 (
  sources="$(mktemp)"; trap 'rm -- "$sources"' EXIT
  keyring=/usr/share/keyrings/ubuntu-archive-keyring.gpg
  VERSION_CODENAME=noble; root=(); apt_options=(); updates=0; installs=0
  dpkg(){ printf 'amd64\n'; }
  dpkg-query(){ :; }
  timeout(){
   local operation="${*: -1}"
   if [[ " $* " == *' update '* || "$operation" == update ]]; then
    updates=$((updates+1))
    grep -q 'signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg' "$sources" || exit 97
    if [[ "$mode" == first || "$mode" == installfallback || "$mode" == installfail ]]; then return 0; fi
    if ((updates==1)); then return 100; fi
    grep -q 'https://archive.ubuntu.com/ubuntu/ noble ' "$sources" || exit 97
    grep -q 'https://security.ubuntu.com/ubuntu/ noble-security ' "$sources" || exit 97
    [[ "$mode" != allfail ]]
   else
    installs=$((installs+1)); [[ " $* " == *' libfixture '* ]] || exit 97
    if [[ "$mode" == installfail || ( "$mode" == installfallback && "$installs" == 1 ) ]]; then return 100; fi
    return 0
   fi
  }
  set -- libfixture
  if [[ "$mode" == allfail || "$mode" == installfail ]]; then
   set +e; eval "$loop"; exit 98
  fi
  eval "$loop"
  [[ "$installed" == true ]] || exit 96
  if [[ "$mode" == installfallback ]]; then [[ "$installs" == 2 ]] || exit 96; else [[ "$installs" == 1 ]] || exit 96; fi
  if [[ "$mode" == first ]]; then [[ "$updates" == 1 ]] || exit 96; else [[ "$updates" == 2 ]] || exit 96; fi
 ) && status=0 || status=$?
 if [[ "$mode" == allfail || "$mode" == installfail ]]; then [[ "$status" == 100 ]] || exit 1; else [[ "$status" == 0 ]] || exit 1; fi
done
printf 'Signed archive finite fallback: 5 cases PASS\n'
