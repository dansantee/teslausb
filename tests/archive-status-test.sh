#!/bin/bash -eu
#
# Tests run/archive-status.sh (the writer) and cgi-bin/status.sh (the reader).
# status.sh reads Pi system files, so run this on a TeslaUSB device:
#   tests/archive-status-test.sh
# from a checkout of this repo, or with the repo copied anywhere on the Pi.

here=$(cd "$(dirname "$0")/.." && pwd)
tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT
export ARCHIVE_STATUS_FILE="$tmpdir/archive_status"

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

# shellcheck source=../run/archive-status.sh
source "$here/run/archive-status.sh"

function value_of () {
  sed -n "s/^$1=//p" "$ARCHIVE_STATUS_FILE"
}

archive_status_set last_check 1700000000 last_check_result ok
check "writes a new file" "1700000000" "$(value_of last_check)"
check "writes several keys at once" "ok" "$(value_of last_check_result)"

archive_status_set last_copy 1700000100 last_copy_files 12 last_copy_result ok
archive_status_set last_check 1700000200 last_check_result unreachable
check "updates an existing key" "1700000200" "$(value_of last_check)"
check "keeps keys it wasn't given" "12" "$(value_of last_copy_files)"
check "has no duplicate keys" "5" "$(wc -l < "$ARCHIVE_STATUS_FILE" | tr -d ' ')"

if archive_status_set last_check 'bad value; rm -rf /'
then
  rejected=no
else
  rejected=yes
fi
check "rejects unsafe values" "yes" "$rejected"
check "leaves the file alone after a rejected write" "1700000200" "$(value_of last_check)"

if archive_status_set last_check
then
  rejected=no
else
  rejected=yes
fi
check "rejects an odd number of arguments" "yes" "$rejected"

# a hand-edited or corrupted line must not reach the JSON
echo 'last_copy_result=ok"} injected' >> "$ARCHIVE_STATUS_FILE"

json=$(bash "$here/teslausb-www/html/cgi-bin/status.sh" | sed '1,/^$/d')
function json_field () {
  python3 -c 'import json,sys; print(json.load(sys.stdin).get(sys.argv[1], "<missing>"))' "$1" <<< "$json"
}
check "status.sh output is valid JSON" "ok" "$(python3 -c 'import json,sys; json.load(sys.stdin); print("ok")' <<< "$json" 2>&1)"
check "status.sh reports last_check" "1700000200" "$(json_field last_check)"
check "status.sh reports last_check_result" "unreachable" "$(json_field last_check_result)"
check "status.sh reports last_copy" "1700000100" "$(json_field last_copy)"
check "status.sh reports last_copy_files" "12" "$(json_field last_copy_files)"
check "status.sh ignores a corrupted line" "ok" "$(json_field last_copy_result)"

rm -f "$ARCHIVE_STATUS_FILE"
json=$(bash "$here/teslausb-www/html/cgi-bin/status.sh" | sed '1,/^$/d')
check "status.sh reports empty fields with no status file" "" "$(json_field last_check)"

if (( failures > 0 ))
then
  echo "$failures check(s) failed"
  exit 1
fi
echo "all checks passed"
