#!/usr/bin/env bash
# Shell launcher aliases for cdpkit.
# Source this file in ~/.bashrc or ~/.zshrc:
#   source /path/to/cdpkit/scripts/aliases.sh
#
# Provides:
#   chromestart [url]   Chrome with CDP on port 9229. Attaches if CDP is up,
#                       starts from cold if Chrome is not running, errors if
#                       Chrome is already running without CDP.
#   chromestop          stop Chrome
#   slackstart          Slack with CDP on port 9228. Attaches, kills/restarts, or starts.
#   slackstop           stop Slack
#   notionstart         Notion with CDP on port 9230. Attaches, kills/restarts, or starts.
#   notionstop          stop Notion
#   granolastart        patched Granola with CDP on port 9231. Attaches if CDP is up,
#                       starts from cold if Granola is not running, errors if
#                       Granola is already running without CDP.
#   granolastop         stop Granola

# Resolve CDPKIT_DIR from this script's location when sourced.
if [ -z "$CDPKIT_DIR" ]; then
  if [ -n "${BASH_VERSION:-}" ]; then
    _cdpkit_script_path="${BASH_SOURCE[0]}"
  elif [ -n "${ZSH_VERSION:-}" ]; then
    _cdpkit_script_path="$0"
  else
    _cdpkit_script_path=""
  fi

  if [ -n "$_cdpkit_script_path" ]; then
    _cdpkit_script_dir="$(cd "$(dirname "$_cdpkit_script_path")" && pwd)"
    CDPKIT_DIR="$(cd "$_cdpkit_script_dir/.." && pwd)"
    unset _cdpkit_script_dir _cdpkit_script_path
  else
    # Fallback only works if cdpkit is cloned to the default location.
    CDPKIT_DIR="${CDPKIT_DIR:-$HOME/repo/work/cdpkit}"
  fi
fi

_cdpkit_stop() {
  local port="$1"
  local name="$2"

  if pgrep -f "remote-debugging-port=$port" >/dev/null 2>&1; then
    pkill -TERM -f "remote-debugging-port=$port" 2>/dev/null
  elif [ -n "$name" ] && pgrep -x "$name" >/dev/null 2>&1; then
    pkill -TERM -x "$name" 2>/dev/null
  fi

  for i in $(seq 1 20); do
    if ! pgrep -f "remote-debugging-port=$port" >/dev/null 2>&1 && \
       { [ -z "$name" ] || ! pgrep -x "$name" >/dev/null 2>&1; }; then
      break
    fi
    sleep 0.5
  done

  if pgrep -f "remote-debugging-port=$port" >/dev/null 2>&1 || \
     { [ -n "$name" ] && pgrep -x "$name" >/dev/null 2>&1; }; then
    pkill -9 -f "remote-debugging-port=$port" 2>/dev/null
    if [ -n "$name" ]; then
      pkill -9 -x "$name" 2>/dev/null
    fi
  fi

  echo "$name stopped"
}

chromestart() {
  ( cd "$CDPKIT_DIR" && node -e "require('./drivers/chrome').start({ url: process.argv[1] }).then(async s => { console.log('chrome started on port', s.port); await require('./transport').close(s.client); process.exit(0); }).catch(e => { console.error(e); process.exit(1); })" "$@" )
}

chromestop() {
  _cdpkit_stop 9229 "Google Chrome"
}

slackstart() {
  ( cd "$CDPKIT_DIR" && node -e "require('./drivers/slack').start().then(s => { console.log('slack started on port', s.port); process.exit(0); }).catch(e => { console.error(e); process.exit(1); })" )
}

slackstop() {
  _cdpkit_stop 9228 Slack
}

notionstart() {
  ( cd "$CDPKIT_DIR" && node -e "require('./drivers/notion').start().then(s => { console.log('notion started on port', s.port); process.exit(0); }).catch(e => { console.error(e); process.exit(1); })" )
}

notionstop() {
  _cdpkit_stop 9230 Notion
}

granolastart() {
  ( cd "$CDPKIT_DIR" && node -e "require('./drivers/granola').start({ launch: true }).then(s => { console.log('granola cdp on port', s.port); process.exit(0); }).catch(e => { console.error(e); process.exit(1); })" )
}

granolastop() {
  _cdpkit_stop 9231 Granola
}
