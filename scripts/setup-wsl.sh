#!/usr/bin/env bash
set -eo pipefail

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

check_checkout() {
  local target=$1 repository=$2 branch=$3
  if [[ ! -e "$target" ]]; then return; fi
  [[ -d "$target" ]] || fail "Checkout path is not a directory: $target"
  command -v git >/dev/null || fail "Git is required to inspect the existing checkout."
  local root origin
  root=$(git -C "$target" rev-parse --show-toplevel)
  [[ "$root" == "$target" ]] || fail "Target is not a repository root: $target"
  origin=$(git -C "$target" remote get-url origin)
  [[ "${origin%.git}" == "${repository%.git}" ]] || fail "Existing origin differs from the requested repository."
  [[ "$(git -C "$target" branch --show-current)" == "$branch" ]] ||
    fail "Existing checkout is on a different branch; switch it yourself before retrying."
}

configure() {
  local source=$1 target=$2 file
  for file in .env .npmrc; do
    [[ ! -L "$target/$file" ]] || fail "Refusing to modify a symlink: $target/$file"
    if [[ -e "$target/$file" ]]; then
      [[ -f "$target/$file" ]] || fail "Not a regular file: $target/$file"
      chmod 600 "$target/$file"
      printf 'Preserved existing %s\n' "$file"
    elif [[ -f "$source/$file" ]]; then
      install -m 600 -- "$source/$file" "$target/$file"
      printf 'Copied %s (contents hidden)\n' "$file"
    elif [[ "$file" == .env ]]; then
      fail "The source checkout has no .env."
    fi
  done

  node --input-type=module - "$target" <<'JS'
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
const target = process.argv[2];
const file = resolve(target, ".env");
const text = readFileSync(file, "utf8").replaceAll("\r\n", "\n");
const env = parseEnv(text);
const value = env.DNA_DATA_DIR?.trim() ||
  (env.DNA_PROVIDER === "github-copilot" ? "data/copilot" : "data");
if (/^[a-z]:/i.test(value) || value.startsWith("\\\\")) {
  throw new Error("DNA_DATA_DIR is a Windows absolute path. Set a Linux path in the WSL .env and retry.");
}
const dataDir = resolve(target, value.replaceAll("\\", "/"));
const line = `DNA_DATA_DIR=${JSON.stringify(dataDir)}`;
const pattern = /^[ \t]*(?:export[ \t]+)?DNA_DATA_DIR[ \t]*=.*$/gm;
const updated = pattern.test(text)
  ? text.replace(pattern, () => line)
  : `${text.replace(/\n*$/, "")}\n${line}\n`;
writeFileSync(file, updated, { mode: 0o600 });
console.log("Configured an absolute Linux data directory (no saved state copied).");
JS
}

install_packages() {
  [[ $EUID -eq 0 ]] || fail "The packages phase must run as WSL root."
  local missing=() pair binary package
  for pair in git:git curl:curl xz:xz-utils just:just zsh:zsh cron:cron crontab:cron tmux:tmux; do
    binary=${pair%%:*}
    package=${pair#*:}
    if ! command -v "$binary" >/dev/null; then missing+=("$package"); fi
  done
  if [[ ! -s /etc/ssl/certs/ca-certificates.crt ]]; then missing+=(ca-certificates); fi
  if [[ ${#missing[@]} -gt 0 ]]; then
    apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "${missing[@]}"
  else
    printf 'System dependencies already installed.\n'
  fi
}

setup() {
  local source=$1 repository=$2 branch=$3 target="$HOME/src/pi-durable-news-agent"
  check_checkout "$target" "$repository" "$branch"
  if [[ ! -e "$target" ]]; then
    mkdir -p "$HOME/src"
    GIT_TERMINAL_PROMPT=0 git clone --single-branch --branch "$branch" -- "$repository" "$target"
  fi
  cd "$target"
  if git remote get-url upstream >/dev/null 2>&1; then
    local upstream
    upstream=$(git remote get-url upstream)
    [[ "${upstream%.git}" == https://github.com/disler/pi-durable-news-agent ]] ||
      fail "Existing upstream differs from Indy's repository."
  else
    git remote add upstream https://github.com/disler/pi-durable-news-agent.git
  fi

  export NVM_DIR="$HOME/.nvm"
  if [[ ! -s "$NVM_DIR/nvm.sh" ]]; then
    curl -fsSL --retry 3 https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.8/install.sh |
      PROFILE="$HOME/.bashrc" bash
  fi
  . "$NVM_DIR/nvm.sh"
  nvm install 24
  nvm alias default 24
  nvm use 24
  [[ "$(node -p 'process.platform')" == linux ]] || fail "Node must be the Linux installation."

  configure "$source" "$target"
  npm ci --no-audit --no-fund
  local pi_version
  pi_version=$(node -p 'require("./apps/shared/packages/durable-agent/package.json").dependencies["@earendil-works/pi-coding-agent"]')
  [[ -n "$pi_version" ]] || fail "The repository does not declare its Pi version."
  if ! command -v pi >/dev/null || [[ "$(pi --version)" != "$pi_version" ]]; then
    npm install --global "@earendil-works/pi-coding-agent@$pi_version" --no-audit --no-fund
  fi
  just api tokens

  printf '\n=== Installed tools ===\n'
  node --version
  npm --version
  pi --version
  just --version
  zsh --version
  node --import tsx --input-type=module -e 'await import("@dna/durable-agent"); await import("@dna/jev"); await import("@dna/sdk"); await import("vite"); console.log("Workspace runtime imports succeeded.");'
  git check-ignore .env
  if [[ -f .npmrc ]]; then git check-ignore .npmrc; fi
  printf '\nCheckout: %s\n' "$target"
  printf 'Pi login remains interactive. No app processes or app cron jobs were started.\n'
  if [[ "$(ps -p 1 -o comm=)" == systemd ]]; then
    if systemctl is-active --quiet cron; then
      printf 'Cron service is active; no application tick was registered.\n'
    else
      printf 'WARNING: Cron service is inactive; start it before enabling scheduled sweeps.\n'
    fi
  else
    printf 'WARNING: systemd is not PID 1; configure WSL services before enabling scheduled sweeps.\n'
  fi
}

main() {
  local phase=${1:-}
  . /etc/os-release
  [[ "$ID" == ubuntu ]] || fail "This bootstrap supports Ubuntu WSL distributions."
  if [[ "$phase" == packages ]]; then
    [[ $# -eq 1 ]] || fail "Unexpected packages arguments."
    install_packages
    return
  fi
  [[ $# -eq 4 ]] || fail "Expected: inspect|setup <Windows checkout> <repository> <branch>"
  [[ $EUID -ne 0 ]] || fail "Set a non-root default WSL user before running setup."
  [[ -f "$2/.env" ]] || fail "The Windows checkout has no .env."
  case "$phase" in
    inspect)
      check_checkout "$HOME/src/pi-durable-news-agent" "$3" "$4"
      printf 'Ubuntu user: %s; architecture: %s\n' "$(id -un)" "$(uname -m)"
      ;;
    setup) setup "$2" "$3" "$4" ;;
    *) fail "Unknown phase: $phase" ;;
  esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then main "$@"; fi
