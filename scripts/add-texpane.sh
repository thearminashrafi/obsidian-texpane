#!/usr/bin/env bash
# add-texpane.sh — install or update TeXPane and link it into Obsidian vaults.
#
#   bash add-texpane.sh "/path/to/My Vault"        link TeXPane into one vault
#   bash add-texpane.sh "/vault one" "/vault two"  ...or several at once
#   bash add-texpane.sh --update                   refresh the shared copy only
#   bash add-texpane.sh --help
#
# How it works: the three plugin files (./plugin, or ../release in a source checkout) are copied to ONE shared folder.
# Each vault gets a link to that folder, so every vault runs the same copy and an
# update reaches all of them. Your TeXPane settings live in the shared folder too.
#
# Safe to re-run. It never deletes anything: an existing real texpane folder inside
# a vault is renamed to texpane.old-<timestamp>, and community-plugins.json is
# backed up to community-plugins.json.bak before it is edited.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Plugin files: ./plugin next to this script (distribution folder), else ../release (source checkout).
if [ -n "${TEXPANE_SRC:-}" ]; then SRC="$TEXPANE_SRC"
elif [ -d "$HERE/plugin" ]; then SRC="$HERE/plugin"
else SRC="$HERE/../release"; fi
SHARED="${TEXPANE_SHARED:-$HOME/Documents/.obsidian-shared-plugins/texpane}"
FILES=(main.js manifest.json styles.css)

usage() {
  sed -n '2,15p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  echo
  echo "Shared copy location: $SHARED"
  echo "(change it by setting TEXPANE_SHARED before running)"
}

say() { printf '%s\n' "$*"; }

update_shared() {
  for f in "${FILES[@]}"; do
    if [ ! -f "$SRC/$f" ]; then
      say "✗ Missing $SRC/$f — build first (npm run build) or keep this script next to a plugin/ folder."
      return 1
    fi
  done
  mkdir -p "$SHARED" || { say "✗ Cannot create $SHARED"; return 1; }
  for f in "${FILES[@]}"; do cp "$SRC/$f" "$SHARED/$f" || return 1; done
  local ver
  ver="$(grep -m1 '"version"' "$SRC/manifest.json" | sed 's/.*: *"\([^"]*\)".*/\1/')"
  say "✓ Shared copy updated (TeXPane $ver): $SHARED"
}

same_dir() { [ "$(cd "$1" 2>/dev/null && pwd -P)" = "$(cd "$2" 2>/dev/null && pwd -P)" ]; }

enable_in_vault() {
  local cp="$1/.obsidian/community-plugins.json"
  if [ ! -s "$cp" ] || ! grep -q '[^[:space:]]' "$cp"; then
    printf '[\n  "texpane"\n]\n' > "$cp"
  elif grep -q '"texpane"' "$cp"; then
    return 0
  elif perl -0777 -ne 'exit(!/\A\s*\[\s*\]\s*\z/)' "$cp"; then
    cp "$cp" "$cp.bak"
    printf '[\n  "texpane"\n]\n' > "$cp"
  elif perl -0777 -ne 'exit(!/\A\s*\[.*\]\s*\z/s)' "$cp"; then
    cp "$cp" "$cp.bak"
    perl -0777 -pi -e 's/\s*\]\s*\z/,\n  "texpane"\n]\n/' "$cp"
  else
    say "  ! community-plugins.json looks unusual; not edited. Enable TeXPane by hand in Obsidian."
    return 1
  fi
}

link_vault() {
  local vault="${1%/}"
  if [ ! -d "$vault" ]; then say "✗ $vault: folder not found"; return 1; fi
  if [ ! -d "$vault/.obsidian" ]; then
    say "✗ $vault: no .obsidian folder. Open it as a vault in Obsidian once, then run this again."
    return 1
  fi
  mkdir -p "$vault/.obsidian/plugins" || return 1
  local target="$vault/.obsidian/plugins/texpane"

  if [ -L "$target" ]; then
    if same_dir "$target" "$SHARED"; then
      say "• $vault: already linked"
    else
      rm "$target" && ln -s "$SHARED" "$target" || return 1
      say "✓ $vault: link re-pointed to the shared copy"
    fi
  elif [ -e "$target" ]; then
    local old="$target.old-$(date +%Y%m%d%H%M%S)"
    mv "$target" "$old" && ln -s "$SHARED" "$target" || return 1
    say "✓ $vault: linked (your previous texpane folder was kept as $(basename "$old"))"
  else
    ln -s "$SHARED" "$target" || return 1
    say "✓ $vault: linked"
  fi

  enable_in_vault "$vault" || true
  return 0
}

case "${1:-}" in
  "" | -h | --help) usage; [ -z "${1:-}" ] && exit 1; exit 0 ;;
  --update) update_shared; exit $? ;;
esac

update_shared || exit 1
failed=0
for v in "$@"; do link_vault "$v" || failed=1; done

say
if [ "$failed" -eq 0 ]; then
  say "Next, in Obsidian: Settings → Community plugins → turn off Restricted mode if it is on,"
  say "click the reload icon next to “Installed plugins”, and switch TeXPane on."
  say "If that vault is open right now and TeXPane shows as off, just switch it on; Obsidian"
  say "can overwrite the enabled list when it saves."
else
  say "Some vaults were skipped (see ✗ above). The others are done."
fi
exit "$failed"
