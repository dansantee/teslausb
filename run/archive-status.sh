#!/bin/bash
#
# Records the outcome of archive runs so the web UI can show them.
# Sourced by archiveloop, which writes the file; cgi-bin/status.sh reads it.
#
# The file holds one key=value per line. Keys and values are limited to
# [A-Za-z0-9_.-] so the reader can parse it without any shell evaluation.
#
# Keys written by archiveloop:
#   last_check          epoch seconds of the last archive attempt
#   last_check_result   ok | error | unreachable
#   last_copy           epoch seconds of the last run that had clips to copy
#   last_copy_files     number of files copied in that run
#   last_copy_result    ok | error

ARCHIVE_STATUS_FILE="${ARCHIVE_STATUS_FILE:-/mutable/archive_status}"

# archive_status_set key value [key value ...]
# Updates the given keys and keeps all others.
function archive_status_set () {
  local file="$ARCHIVE_STATUS_FILE"
  local tmp="$file.tmp.$$"
  local -A new=()
  local key value

  if (( $# == 0 || $# % 2 != 0 ))
  then
    return 1
  fi
  while (( $# >= 2 ))
  do
    key=$1
    value=$2
    shift 2
    if ! [[ $key =~ ^[A-Za-z0-9_]+$ && $value =~ ^[A-Za-z0-9_.-]*$ ]]
    then
      return 1
    fi
    new[$key]=$value
  done

  {
    if [ -f "$file" ]
    then
      while IFS='=' read -r key value
      do
        if [[ -n $key && -z ${new[$key]+x} ]]
        then
          echo "$key=$value"
        fi
      done < "$file"
    fi
    for key in "${!new[@]}"
    do
      echo "$key=${new[$key]}"
    done
  } > "$tmp" && mv -f "$tmp" "$file"
}
