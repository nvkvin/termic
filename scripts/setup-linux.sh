#!/usr/bin/env bash
# One-shot Linux dev setup. `make setup` calls this on Linux; run it directly
# (`bash scripts/setup-linux.sh`) when make is not installed yet, since it
# installs make too. A stock Ubuntu desktop has neither make nor a compiler.
#
# Installs what is missing and skips what is there:
#   the C toolchain + make, the WebKitGTK / GTK dev packages Tauri links
#   against, Rust (rustup, stable), Node 22.
# Then: npm install, the e2e fixture seed, and a first cargo check.
#
# System packages go through the distro's package manager (apt, dnf or
# pacman) and that one step asks for sudo. Nothing else runs as root: rustup
# installs into your home.
#
# WITH_E2E=1 also installs what `make e2e` needs to run headless the way CI
# does (xvfb, a session bus, xclip, and xdotool for the real-key spec).
set -euo pipefail

say()  { printf '→ %s\n' "$*"; }
ok()   { printf '  ✓ %s\n' "$*"; }
warn() { printf '  ! %s\n' "$*"; }
die()  { printf '✗ %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Linux" ] || die "this is the Linux setup; on macOS and Windows run: make setup"

# An AppImage (Termic's own included) exports an LD_LIBRARY_PATH pointing at
# the libraries it bundles, and every terminal it opens inherits it. System
# binaries then load those instead of the host's: on Ubuntu 25.10+ `env` and
# `ls` are the Rust coreutils, they link libsystemd, and they die on the
# older bundled copy. Nothing below wants an AppImage's libraries.
unset LD_LIBRARY_PATH

as_root() { if [ "$(id -u)" -eq 0 ]; then "$@"; else sudo "$@"; fi; }

# The installed Node's major version, or 0 when there is none.
node_major() {
  local v
  v="$(node --version 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/')"
  echo "${v:-0}"
}

echo "→ Termic dev environment bootstrap (Linux)"

# ── system packages ──────────────────────────────────────────────────────

# The same lists as the README's "Linux (build it yourself)", plus make.
APT_PKGS=(build-essential make curl wget file git pkg-config
  libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev
  librsvg2-dev libssl-dev libsoup-3.0-dev libxdo-dev)
DNF_PKGS=(gcc gcc-c++ make curl wget file git pkgconfig
  webkit2gtk4.1-devel gtk3-devel libappindicator-gtk3-devel
  librsvg2-devel openssl-devel libsoup3-devel libxdo-devel)
PACMAN_PKGS=(base-devel curl wget file git pkgconf
  webkit2gtk-4.1 gtk3 libayatana-appindicator librsvg openssl libsoup3 xdotool)
if [ "${WITH_E2E:-0}" = "1" ]; then
  APT_PKGS+=(xvfb dbus-x11 at-spi2-core xclip xdotool)
  DNF_PKGS+=(xorg-x11-server-Xvfb dbus-x11 at-spi2-core xclip xdotool)
  PACMAN_PKGS+=(xorg-server-xvfb at-spi2-core xclip xdotool)
fi

if command -v apt-get >/dev/null 2>&1; then
  # Ask dpkg first, so a machine that has everything needs no sudo at all.
  missing=()
  for p in "${APT_PKGS[@]}"; do
    dpkg-query -W -f='${Status}' "$p" 2>/dev/null | grep -q "install ok installed" || missing+=("$p")
  done
  if [ "${#missing[@]}" -eq 0 ]; then
    ok "system packages"
  else
    say "Installing system packages (sudo apt-get): ${missing[*]}"
    as_root apt-get update
    as_root apt-get install -y "${missing[@]}"
    ok "system packages"
  fi
elif command -v dnf >/dev/null 2>&1; then
  missing=()
  for p in "${DNF_PKGS[@]}"; do
    rpm -q "$p" >/dev/null 2>&1 || missing+=("$p")
  done
  if [ "${#missing[@]}" -eq 0 ]; then
    ok "system packages"
  else
    say "Installing system packages (sudo dnf): ${missing[*]}"
    as_root dnf install -y "${missing[@]}"
    ok "system packages"
  fi
elif command -v pacman >/dev/null 2>&1; then
  say "Installing system packages (sudo pacman)"
  as_root pacman -S --needed --noconfirm "${PACMAN_PKGS[@]}"
  ok "system packages"
else
  warn "no apt, dnf or pacman here: install the WebKitGTK 4.1, GTK 3, libsoup 3,"
  warn "librsvg, OpenSSL and appindicator dev packages, a C toolchain and make by hand."
fi

# ── toolchains ───────────────────────────────────────────────────────────

# rustup installs into ~/.cargo/bin, which a shell only has on PATH after it
# re-reads its profile. Add it for the rest of this script either way.
CARGO_WAS_ON_PATH=0
command -v cargo >/dev/null 2>&1 && CARGO_WAS_ON_PATH=1
[ -d "$HOME/.cargo/bin" ] && PATH="$HOME/.cargo/bin:$PATH"
if ! command -v cargo >/dev/null 2>&1; then
  if command -v rustup >/dev/null 2>&1; then
    say "rustup present but no cargo, installing the stable toolchain"
    rustup default stable
  else
    say "Installing rustup + the stable toolchain (into ~/.cargo)"
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
    PATH="$HOME/.cargo/bin:$PATH"
  fi
  hash -r
fi
command -v cargo >/dev/null 2>&1 || die "cargo is not on PATH after installing rust; open a new shell and re-run"
ok "rust ($(cargo --version))"

if [ "$(node_major)" -lt 22 ]; then
  # The distro's own package where it is new enough (Ubuntu 26.04 ships 22).
  # An older distro's is not, and replacing the system Node behind someone's
  # back is not this script's call, so that case stops with the options.
  say "Installing node (distro package)"
  if command -v apt-get >/dev/null 2>&1; then as_root apt-get install -y nodejs npm
  elif command -v dnf >/dev/null 2>&1; then as_root dnf install -y nodejs npm
  elif command -v pacman >/dev/null 2>&1; then as_root pacman -S --needed --noconfirm nodejs npm
  fi
  hash -r
fi
[ "$(node_major)" -ge 22 ] \
  || die "Node 22+ is required and this distro's package is $(node --version 2>/dev/null || echo missing). Install it with nvm, fnm or mise, then re-run."
command -v npm >/dev/null 2>&1 || die "node is installed but npm is not; install your distro's npm package and re-run"
ok "node ($(node --version))"

# ── the repo ─────────────────────────────────────────────────────────────

cd "$(dirname "$0")/.."
say "Installing npm packages"
npm install --no-fund --no-audit
say "Seeding the e2e fixture profile"
node scripts/e2e-seed.mjs || true
say "Pre-fetching Rust crates (cargo check)"
(cd src-tauri && cargo check)

echo ""
echo "✓ Setup complete. Try: make dev"
if [ "$CARGO_WAS_ON_PATH" = "0" ]; then
  # The shell that ran this read its profile before rustup edited it, so a
  # bare `cargo` (and `npm run tauri:dev`) fails there with "No such file or
  # directory". make looks in ~/.cargo/bin itself and is unaffected.
  echo ""
  echo "  ┌──────────────────────────────────────────────────────────────────┐"
  echo "  │ ! OPEN A NEW TERMINAL before running cargo or npm directly.      │"
  echo "  │   Rust was just installed and this shell cannot see it yet.      │"
  echo "  │   Or, in this one:   . \"\$HOME/.cargo/env\"                      │"
  echo "  │   (make targets already work here.)                              │"
  echo "  └──────────────────────────────────────────────────────────────────┘"
fi
