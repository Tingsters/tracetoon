#!/bin/sh
# Tracetoon installer for macOS, Linux and Git Bash on Windows.
#
#   curl -fsSL https://raw.githubusercontent.com/Tingsters/tracetoon/main/install.sh | sh
#
# Installs the Tracetoon skill for every agent found on this machine (Claude Code,
# Codex, Antigravity, Gemini CLI) and caches the matching prebuilt binary, so
# nothing else (Bun, Node) is needed. Re-run to update.
#
# Options (environment variables):
#   TRACETOON_VERSION=v1.2.3   install a specific release (default: newest)
#   TRACETOON_UNINSTALL=1      remove the skill from every agent and the cached binaries
set -eu

REPO="Tingsters/tracetoon"
say() { printf '%s\n' "$*"; }
die() { printf 'tracetoon install: %s\n' "$*" >&2; exit 1; }

fetch() { # url dest
  if command -v curl >/dev/null 2>&1; then curl -fsSL "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then wget -qO "$2" "$1"
  else die "need curl or wget"; fi
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
cache_root="${XDG_CACHE_HOME:-$HOME/.cache}/tracetoon"

if [ "${TRACETOON_UNINSTALL:-}" = 1 ]; then
  targets | while IFS='|' read -r name dir; do
    if [ -d "$dir" ]; then rm -rf "$dir" && say "removed from $name ($dir)"; fi
  done
  rm -rf "$cache_root"
  if [ -n "${LOCALAPPDATA:-}" ] && command -v cygpath >/dev/null 2>&1; then
    rm -rf "$(cygpath -u "$LOCALAPPDATA")/tracetoon/cache"
  fi
  say "Tracetoon uninstalled."
  exit 0
fi

[ -n "$(targets)" ] || die "no supported agent found (Claude Code, Codex, Antigravity, Gemini CLI)"

tag="${TRACETOON_VERSION:-}"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
if [ -z "$tag" ]; then
  # Newest release, including release candidates.
  fetch "https://api.github.com/repos/$REPO/releases?per_page=1" "$tmp/releases.json"
  tag=$(sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' "$tmp/releases.json" | head -1)
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

# The binary goes where the launchers look for it. On Windows that is the
# PowerShell launcher's cache, which the sh launcher checks too.
if [ "$os" = windows ] && [ -n "${LOCALAPPDATA:-}" ] && command -v cygpath >/dev/null 2>&1; then
  cache_root="$(cygpath -u "$LOCALAPPDATA")/tracetoon/cache"
fi
mkdir -p "$cache_root/$ver"
cp "$tmp/$bin" "$cache_root/$ver/$bin"
chmod +x "$cache_root/$ver/$bin"

targets | while IFS='|' read -r name dir; do
  rm -rf "$dir"
  mkdir -p "$(dirname "$dir")"
  cp -R "$tmp/skill/tracetoon" "$dir"
  say "  $name: $dir"
done

"$cache_root/$ver/$bin" --version >/dev/null 2>&1 || die "installed binary does not run"
say "Done. Restart your agent, then ask it to \"open a PR with Tracetoon\"."
