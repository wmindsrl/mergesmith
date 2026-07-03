#!/usr/bin/env bash
# Cron wrapper for the Mergesmith tick: flock anti-overlap + run the provider-agnostic
# orchestrator over every repo registered in ~/.mergesmith/repos.json.
# Crontab example: */20 7-21 * * 1-6 /path/to/mergesmith-tick.sh
set -euo pipefail
export PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"

exec 9>/tmp/mergesmith-tick.lock
if ! flock -n 9; then
  echo "$(date -Is) tick already running, skip"
  exit 0
fi

mergesmith tick --all
