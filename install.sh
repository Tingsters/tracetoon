#!/bin/sh
# Tracetoon installer for macOS, Linux and Git Bash on Windows.
#
#   curl -fsSL https://raw.githubusercontent.com/Tingsters/tracetoon/main/install.sh | sh
#
# Installs the Tracetoon skill for every agent found on this machine (Claude Code,
# Codex, Antigravity, Gemini CLI), caches the matching prebuilt binary so nothing
# else (Bun, Node) is needed, and adds a small hook to each agent that routes
# `gh pr create` through Tracetoon. Re-run to update.
#
# Options (environment variables):
#   TRACETOON_VERSION=v1.2.3   install a specific release (default: newest)
#   TRACETOON_NO_HOOK=1        skip the PR hook (add it later: tracetoon hook install)
#   TRACETOON_UNINSTALL=1      remove the skill, the hooks and the cached binaries
set -eu

REPO="Tingsters/tracetoon"
say() { printf '%s\n' "$*"; }
die() { printf 'tracetoon install: %s\n' "$*" >&2; exit 1; }

fetch() { # url dest
  if command -v curl >/dev/null 2>&1; then curl -fsSL "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then wget -qO "$2" "$1"
  else die "need curl or wget"; fi
}

# The tag of the most recently published release in a GitHub releases JSON list
# (stdin). Pairs each tag_name with its published_at; drafts (null) are skipped.
latest_tag() {
  grep -oE '"(tag_name|published_at)": *("[^"]*"|null)' |
    sed -E 's/^"[a-z_]+": *//; s/"//g' |
    paste - - |
    awk -F'\t' '$2 != "null" && $2 != "" { print $2 "\t" $1 }' |
    sort | tail -n 1 | cut -f2
}

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

unzip_to() { # zip dir
  if command -v unzip >/dev/null 2>&1; then unzip -q "$1" -d "$2"
  elif command -v bsdtar >/dev/null 2>&1; then bsdtar -xf "$1" -C "$2"
  elif command -v python3 >/dev/null 2>&1; then python3 -m zipfile -e "$1" "$2"
  else die "need unzip, bsdtar or python3 to unpack the skill"; fi
}

# Where each agent looks for skills. Only agents that are present get the skill.
targets() {
  claude_home="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
  if [ -d "$claude_home" ] || command -v claude >/dev/null 2>&1; then
    printf 'Claude Code|%s\n' "$claude_home/skills/tracetoon"
  fi
  if [ -d "${CODEX_HOME:-$HOME/.codex}" ] || command -v codex >/dev/null 2>&1; then
    printf 'Codex|%s\n' "$HOME/.agents/skills/tracetoon"
  fi
  gemini_home="${GEMINI_HOME:-$HOME/.gemini}"
  if [ -d "$gemini_home/antigravity-cli" ] || [ -d "$gemini_home/antigravity-ide" ] || command -v agy >/dev/null 2>&1; then
    printf 'Antigravity|%s\n' "$gemini_home/config/skills/tracetoon"
  fi
  if command -v gemini >/dev/null 2>&1; then
    printf 'Gemini CLI|%s\n' "$gemini_home/skills/tracetoon"
  fi
}

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  MINGW* | MSYS* | CYGWIN*) os=windows ;;
  *) die "unsupported OS $(uname -s)" ;;
esac
case "$(uname -m)" in
  arm64 | aarch64) arch=arm64 ;;
  x86_64 | amd64) arch=x64 ;;
  *) die "unsupported CPU $(uname -m)" ;;
esac
exe=""
[ "$os" = windows ] && exe=".exe"
bin="tracetoon-$os-$arch$exe"
# The binary lives at a fixed path, so agent hooks keep working (and Codex keeps
# its trust) across updates. The launchers check it first.
home_root="${XDG_DATA_HOME:-$HOME/.local/share}/tracetoon"
if [ "$os" = windows ] && [ -n "${LOCALAPPDATA:-}" ] && command -v cygpath >/dev/null 2>&1; then
  home_root="$(cygpath -u "$LOCALAPPDATA")/tracetoon"
fi
stable="$home_root/bin/tracetoon$exe"
cache_root="${XDG_CACHE_HOME:-$HOME/.cache}/tracetoon"

if [ "${TRACETOON_UNINSTALL:-}" = 1 ]; then
  # Hooks first, while the binary is still around to remove them.
  if [ -x "$stable" ]; then "$stable" hook uninstall || true; fi
  targets | while IFS='|' read -r name dir; do
    if [ -d "$dir" ]; then rm -rf "$dir" && say "removed from $name ($dir)"; fi
  done
  rm -rf "$home_root" "$cache_root"
  # The terminal command, only if it's our link.
  if [ -L "$HOME/.local/bin/tracetoon" ] && [ "$(readlink "$HOME/.local/bin/tracetoon")" = "$stable" ]; then
    rm -f "$HOME/.local/bin/tracetoon"
  fi
  say "Tracetoon uninstalled."
  exit 0
fi

[ -n "$(targets)" ] || die "no supported agent found (Claude Code, Codex, Antigravity, Gemini CLI)"

tag="${TRACETOON_VERSION:-}"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
if [ -z "$tag" ]; then
  # Newest release, including release candidates. The API sorts by tag name
  # (so rc.10 lands before rc.2), not by date: pick the latest published one.
  fetch "https://api.github.com/repos/$REPO/releases?per_page=30" "$tmp/releases.json"
  tag=$(latest_tag < "$tmp/releases.json")
  [ -n "$tag" ] || die "could not find a Tracetoon release"
fi
ver=${tag#v}
base="https://github.com/$REPO/releases/download/$tag"
say "Installing Tracetoon $tag ($os-$arch)"

fetch "$base/checksums.txt" "$tmp/checksums.txt"
for f in tracetoon-skill.zip "$bin"; do
  fetch "$base/$f" "$tmp/$f"
  want=$(grep " $f\$" "$tmp/checksums.txt" | cut -d' ' -f1)
  [ -n "$want" ] && [ "$want" = "$(sha256 "$tmp/$f")" ] || die "checksum mismatch for $f; not installing"
done

mkdir -p "$tmp/skill"
unzip_to "$tmp/tracetoon-skill.zip" "$tmp/skill"
[ -f "$tmp/skill/tracetoon/SKILL.md" ] || die "skill archive is missing SKILL.md"
chmod +x "$tmp/skill/tracetoon/bin/tracetoon" 2>/dev/null || true
build=$(sed -n 's/.*"buildId"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$tmp/skill/tracetoon/build.json")
skill_version=$(cat "$tmp/skill/tracetoon/VERSION")
chmod +x "$tmp/$bin"
info=$("$tmp/$bin" build-info --json | tr -d ' \r\n') || die "downloaded runtime does not run"
[ "$skill_version" = "$ver" ] && [ -n "$build" ] || die "skill version does not match the release"
case "$info" in *"\"buildId\":\"$build\""*) ;; *) die "skill and runtime builds differ; nothing activated" ;; esac
targets > "$tmp/targets"
while IFS='|' read -r name dir; do
  [ "$(basename "$dir")" = tracetoon ] || die "unexpected skill install target: $dir"
  stage="$dir.new-$$"
  [ ! -e "$stage" ] || die "staging directory already exists: $stage"
  mkdir -p "$(dirname "$dir")"
  cp -R "$tmp/skill/tracetoon" "$stage"
done < "$tmp/targets"

mkdir -p "$(dirname "$stable")"
cp "$tmp/$bin" "$stable.new"
chmod +x "$stable.new"
"$stable.new" --version >/dev/null 2>&1 || die "downloaded binary does not run"
mv -f "$stable.new" "$stable"
# Binaries cached by older versions are no longer needed.
rm -rf "$cache_root" "$home_root/cache"

say "Skill:"
while IFS='|' read -r name dir; do
  backup="$dir.old-$$"
  [ ! -e "$backup" ] || die "backup directory already exists: $backup"
  [ ! -e "$dir" ] || mv "$dir" "$backup"
  if ! mv "$dir.new-$$" "$dir"; then
    [ ! -e "$backup" ] || mv "$backup" "$dir"
    die "could not activate $dir; previous skill restored"
  fi
  rm -rf "$backup"
  say "  $name: $dir"
done < "$tmp/targets"

if [ "${TRACETOON_NO_HOOK:-}" = 1 ]; then
  say "PR hook: skipped (add it later with: tracetoon hook install)"
else
  say "PR hook (routes gh pr create through Tracetoon; turn off with: tracetoon off):"
  "$stable" hook install || say "  could not add the PR hook; the skill still works"
fi

# A `tracetoon` command for your own terminal (Git Bash on Windows uses install.ps1's PATH).
if [ "$os" != windows ]; then
  user_bin="$HOME/.local/bin"
  mkdir -p "$user_bin" && ln -sf "$stable" "$user_bin/tracetoon"
  case ":$PATH:" in
    *":$user_bin:"*) say "Command: tracetoon (in $user_bin)" ;;
    *) say "Command: $user_bin/tracetoon. To type just 'tracetoon', add this to your shell profile: export PATH=\"\$HOME/.local/bin:\$PATH\"" ;;
  esac
fi

# Comics need an image route: say what's there and what to do next.
"$stable" images --brief 2>/dev/null || true
say "Done. Restart your agent, then ask it to open a PR."
