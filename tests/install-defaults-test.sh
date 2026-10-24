#!/bin/bash -eu
#
# Checks that a fresh install sets up this fork (dansantee/teslausb), not upstream, and that
# setup applies the Pi tuning. Runs anywhere with bash and grep, from a checkout of this repo:
#   tests/install-defaults-test.sh

here=$(cd "$(dirname "$0")/.." && pwd)
cd "$here"

failures=0
function check () {
  local what="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]
  then
    echo "ok   - $what"
  else
    echo "FAIL - $what: expected '$expected', got '$actual'"
    failures=$((failures + 1))
  fi
}

# Nothing fetches this repo's own files from upstream. (Other marcone repos, such as the
# prebuilt rsync and teslausb-webui downloads, are separate projects and stay.)
upstream=$(grep -rn 'githubusercontent.com/marcone/teslausb/' setup pi-gen-sources run || true)
check "no setup script fetches from marcone/teslausb" "" "$upstream"

# Every place that defaults REPO points at the fork.
defaults=$(grep -rhoE 'REPO=\$\{REPO:-[^}]*\}' setup pi-gen-sources run | sort -u)
check "REPO defaults to dansantee everywhere" 'REPO=${REPO:-dansantee}' "$defaults"
check "the sample config names the fork" "1" "$(grep -c '^# export REPO=dansantee$' pi-gen-sources/00-teslausb-tweaks/files/teslausb_setup_variables.conf.sample)"
check "diagnostics only warns about a repo other than the fork" "1" "$(grep -c '"$REPO" != "dansantee"' setup/pi/setup-teslausb)"

# install.sh fetches everything through $RAW, and every file it names exists in this repo.
install=setup/generic/install.sh
check "install.sh builds its URLs from REPO and BRANCH" "1" \
  "$(grep -c '^RAW="https://raw.githubusercontent.com/$REPO/teslausb/$BRANCH"$' "$install")"
missing=""
count=0
for path in $(grep -oE '\$RAW/[^ "]+' "$install" | sed 's@^\$RAW/@@' | sort -u)
do
  count=$((count + 1))
  [ -f "$path" ] || missing="$missing $path"
done
check "install.sh fetches 5 files" "5" "$count"
check "every file install.sh fetches exists" "" "$missing"
check "the resize re-run hook keeps REPO and BRANCH" "1" "$(grep -c 'REPO=\$REPO BRANCH=\$BRANCH bash' "$install")"

# Pi tuning: Wi-Fi power saving off, ModemManager off.
check "setup turns Wi-Fi power saving off" "1" \
  "$(grep -c "printf '\[connection\]\\\\nwifi.powersave = 2\\\\n' > /etc/NetworkManager/conf.d/99-wifi-powersave-off.conf" setup/pi/setup-teslausb)"
# Subcommands such as `setup-teslausb diagnose` and `upgrade` run on a read-only root, so the
# write must come after they've been dispatched, i.e. only in a full setup run.
dispatch=$(grep -n 'command=cmd_\$1' setup/pi/setup-teslausb | cut -d: -f1)
powersave=$(grep -n 'wifi.powersave = 2' setup/pi/setup-teslausb | cut -d: -f1)
check "the Wi-Fi write comes after subcommand dispatch" "yes" "$([ -n "$dispatch" ] && [ -n "$powersave" ] && [ "$powersave" -gt "$dispatch" ] && echo yes || echo "no ($powersave vs $dispatch)")"
check "setup masks ModemManager" "1" "$(grep -c '^systemctl mask ModemManager' setup/pi/make-root-fs-readonly.sh)"

for f in "$install" setup/pi/setup-teslausb setup/pi/envsetup.sh setup/pi/make-root-fs-readonly.sh pi-gen-sources/00-teslausb-tweaks/files/rc.local
do
  check "$f parses" "0" "$(bash -n "$f" > /dev/null 2>&1; echo $?)"
done

if [ "$failures" -ne 0 ]
then
  echo "$failures failed"
  exit 1
fi
echo "all passed"
