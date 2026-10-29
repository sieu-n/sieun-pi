#!/usr/bin/env bash
# One box follow step of the Box tools parity duty (box-parity.ts): installs version $1 of a tool on us-metal02 with the recipe in $2, the
# `follow` of its probe in box-parity.rows.json, into ~/.local without root. One lock keeps the precheck and box-follow.timer from installing at once.
# A recipe sees $V and the helpers below, which put each version in its own ~/.local/opt/<name>-$V and link it, so an older one stays whole.
set -euo pipefail
V=$1
OPT=$HOME/.local/opt
BIN=$HOME/.local/bin
export PATH=$BIN:$HOME/.bun/bin:$HOME/.local/node/bin:$PATH
export MAMBA_ROOT_PREFIX=$OPT/micromamba/root
MAMBA=$OPT/micromamba/micromamba
mkdir -p "$HOME/.cache/box-parity" "$OPT" "$BIN"
exec 9>"$HOME/.cache/box-parity/follow.lock"
flock 9
work=$(mktemp -d "$OPT/.follow.XXXXXX")
trap 'rm -rf "$work"' EXIT

# Links each named file of a tool folder into ~/.local/bin; a name with a slash is matched as the end of the file's path, such as bin/go.
link_bins() {
  local dest=$1 bin found
  shift
  for bin; do
    found=$(find "$dest" -path "*/$bin" \( -type f -o -type l \) | sort | head -1)
    [ -n "$found" ] || { echo "no $bin in $dest" >&2; return 1; }
    chmod +x "$found"
    ln -sfn "$found" "$BIN/$(basename "$bin")"
  done
}

# release <name> <url> [bin...]: unpacks a tar or zip, or keeps a bare binary as its first bin, in ~/.local/opt/<name>-$V, with a single top folder
# lifted out, and links each bin.
release() {
  local name=$1 url=$2 dest=$OPT/$1-$V
  shift 2
  if [ ! -d "$dest" ]; then
    mkdir "$work/x"
    curl -fsSL -o "$work/download" "$url"
    case $url in
      *.zip) unzip -q "$work/download" -d "$work/x" ;;
      *.tar.*|*.tgz) tar -xf "$work/download" -C "$work/x" ;;
      *) mv "$work/download" "$work/x/$(basename "${1:-$name}")" ;;
    esac
    local top=("$work/x"/*)
    if [ ${#top[@]} = 1 ] && [ -d "${top[0]}" ]; then mv "${top[0]}" "$dest"; else mv "$work/x" "$dest"; fi
  fi
  link_bins "$dest" "$@"
}

# conda <name> <package> [bin...]: a conda-forge environment with <package>=$V in ~/.local/opt/<name>-$V, and its bins linked.
conda() {
  local name=$1 package=$2 dest=$OPT/$1-$V
  shift 2
  [ -d "$dest/conda-meta" ] || "$MAMBA" create -y -q -p "$dest" -c conda-forge --override-channels "$package=$V"
  link_bins "$dest/bin" "$@"
}

# media <package> [bin...]: <package>=$V into the media environment that holds vips, ImageMagick and Poppler, and its bins linked.
media() {
  local package=$1
  shift
  "$MAMBA" install -y -q -p "$OPT/media-env" -c conda-forge --override-channels "$package=$V"
  link_bins "$OPT/media-env/bin" "$@"
}

# vips_source: libvips $V built from its release tarball in ~/.local/opt/vips-$V, for a version conda-forge does not have yet. On 10-28 Homebrew
# had 8.18.7 while conda-forge's newest was 8.18.6. The environment's own libvips brings every library and header the build needs.
vips_source() {
  local dest=$OPT/vips-$V
  if [ ! -x "$dest/bin/vips" ] || ! "$dest/bin/vips" --version | grep -qF "vips-$V"; then
    "$MAMBA" create -y -q -p "$dest" -c conda-forge --override-channels libvips meson ninja pkg-config expat glib
    curl -fsSL "https://github.com/libvips/libvips/releases/download/v$V/vips-$V.tar.xz" | tar -xJ -C "$work"
    (cd "$work/vips-$V" && PATH=$dest/bin:$PATH PKG_CONFIG_PATH=$dest/lib/pkgconfig:$dest/share/pkgconfig \
      meson setup build --prefix="$dest" --libdir=lib --buildtype=release -Dintrospection=disabled -Dmodules=disabled -Dexamples=false >/dev/null \
      && ninja -C build install >/dev/null)
  fi
  link_bins "$dest/bin" vips vipsthumbnail vipsheader vipsedit
}

# npm_global <package>: <package>@$V into the npm prefix of ~/.local/node, where the box keeps claude, codex, vercel and pnpm.
npm_global() {
  "$HOME/.local/node/bin/npm" install -g --no-fund --no-audit "$1@$V"
}

# nvm_default: node $V through nvm as its default, with ~/.local/bin/node, npm and npx linked to it.
nvm_default() {
  set +u
  . "$HOME/.nvm/nvm.sh"
  nvm install "$V" >/dev/null
  nvm alias default "$V" >/dev/null
  set -u
  link_bins "$HOME/.nvm/versions/node/v$V/bin" node npm npx
}

# venv: each name==version in $V into the Prime kernel venv. A package the box installed from a local folder, such as a skill, is installed
# again from that folder, because the index holds no such package or another one under its name.
venv() {
  local python=$HOME/.prime/agent/kernel-venv/bin/python spec folder from_index=()
  for spec in $V; do
    folder=$("$python" - "${spec%%==*}" <<'EOF'
import importlib.metadata as metadata, json, sys
try:
    url = json.loads(metadata.distribution(sys.argv[1]).read_text("direct_url.json") or "{}").get("url", "")
except metadata.PackageNotFoundError:
    url = ""
print(url[7:] if url.startswith("file://") else "")
EOF
)
    if [ -n "$folder" ]; then uv pip install -q --python "$python" -e "$folder"; else from_index+=("$spec"); fi
  done
  [ ${#from_index[@]} = 0 ] || uv pip install -q --python "$python" "${from_index[@]}"
}

# playwright_browsers: each Playwright browser folder in $V, such as chromium_headless_shell-1248, installed into ~/.cache/ms-playwright by the
# newest stable Playwright whose browsers.json gives that revision. A folder is the browser's name with - turned to _ and its revision
# (playwright-core lib/server/registry/index.js), so its install name turns _ back to -. A revision only a Mac `revisionOverrides` entry gives,
# such as WebKit's for mac14, is a Mac build no box install makes, so no release matches it and the step fails with its name.
playwright_browsers() {
  local folder name revision version found versions
  versions=$(npm view playwright-core versions --json | python3 -c 'import json, re, sys
stable = [v for v in json.load(sys.stdin) if re.fullmatch(r"\d+\.\d+\.\d+", v)]
print("\n".join(sorted(stable, key=lambda v: tuple(map(int, v.split("."))), reverse=True)))')
  for folder in $V; do
    name=${folder%-*}
    name=${name//_/-}
    revision=${folder##*-}
    found=
    for version in $versions; do
      if curl -fsSL "https://raw.githubusercontent.com/microsoft/playwright/v$version/packages/playwright-core/browsers.json" 2>/dev/null \
        | python3 -c 'import json, sys
sys.exit(not any(b["name"] == sys.argv[1] and b["revision"] == sys.argv[2] for b in json.load(sys.stdin)["browsers"]))' "$name" "$revision" 2>/dev/null; then
        found=$version
        break
      fi
    done
    [ -n "$found" ] || { echo "no stable Playwright release's browsers.json on GitHub gives $name revision $revision" >&2; return 1; }
    npx -y "playwright@$found" install "$name"
  done
}

eval "$2"
