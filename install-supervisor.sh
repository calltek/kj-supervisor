#!/usr/bin/env bash
# kj-supervisor installer.
#
# Usage:
#   curl -fsSL https://kujira.run/install-supervisor.sh | \
#     KJ_PROVISIONING_TOKEN=kjprov_xxx KJ_CONTROL_URL=https://api.kujira.run sh
#
# What it does:
#   1. Detect OS, install Docker if missing.
#   2. Create /etc/kj-supervisor (0700) with provisioning_token.
#   3. docker pull the supervisor image.
#   4. docker run the supervisor with the right binds and env.
#   5. Tail the container logs until 'handshake complete' or timeout.
#
# Idempotent: re-running upgrades the image and recreates the container.

set -euo pipefail

# ──────────────────────────────────────────────────────────────────────────
# Configuration
# ──────────────────────────────────────────────────────────────────────────

SUPERVISOR_IMAGE="${KJ_SUPERVISOR_IMAGE:-ghcr.io/calltek/kj-supervisor:latest}"
SUPERVISOR_CONTAINER="${KJ_SUPERVISOR_CONTAINER:-kj-supervisor}"
CONFIG_DIR="${KJ_CONFIG_DIR:-/etc/kj-supervisor}"
HANDSHAKE_TIMEOUT_SECONDS="${KJ_INSTALL_HANDSHAKE_TIMEOUT:-30}"
# Where the `kujira` control CLI is fetched from (same host as this
# installer). Override for staging/self-hosted mirrors.
KJ_CLI_URL="${KJ_CLI_URL:-https://kujira.run/kujira}"
KJ_CLI_PATH="${KJ_CLI_PATH:-/usr/local/bin/kujira}"

# ──────────────────────────────────────────────────────────────────────────
# Logging helpers
# ──────────────────────────────────────────────────────────────────────────

log()  { printf '\033[1;34m[kj-install]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[kj-install]\033[0m %s\n' "$*" >&2; }
fail() { printf '\033[1;31m[kj-install] ✗ %s\033[0m\n' "$*" >&2; exit 1; }
ok()   { printf '\033[1;32m[kj-install] ✓ %s\033[0m\n' "$*"; }

# ──────────────────────────────────────────────────────────────────────────
# 0. Inputs and sudo
# ──────────────────────────────────────────────────────────────────────────

: "${KJ_CONTROL_URL:?Missing KJ_CONTROL_URL (e.g. https://api.kujira.run)}"
: "${KJ_PROVISIONING_TOKEN:?Missing KJ_PROVISIONING_TOKEN (kjprov_… from the operator panel)}"

# Sudo only when we need it. If Docker is already installed and reachable
# without sudo, and the config dir is writable by us, we skip sudo entirely.
# This makes the script usable on dev boxes (macOS, rootless Docker) without
# weakening the production install on a fresh Linux VPS.
if [ "$(id -u)" -eq 0 ]; then
    SUDO=""
elif command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
    SUDO="sudo"
else
    SUDO=""
    if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
        fail "Docker is not installed (or not reachable as $USER). Re-run as root or with passwordless sudo so we can install it."
    fi
    if [ ! -w "$(dirname "$CONFIG_DIR")" ] && [ ! -w "$CONFIG_DIR" ]; then
        fail "Cannot write to $CONFIG_DIR. Re-run as root or with passwordless sudo, or set KJ_CONFIG_DIR to a writable path."
    fi
    warn "Running without sudo. Skipping Docker install (it's already up) and using $CONFIG_DIR as-is."
fi

# ──────────────────────────────────────────────────────────────────────────
# 1. Detect OS (only needed if we'll have to install Docker)
# ──────────────────────────────────────────────────────────────────────────

OS_ID="unknown"
if [ -r /etc/os-release ]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    OS_ID="${ID:-unknown}"
    # Normalize some derivatives we treat the same as their parent.
    case "$OS_ID" in
        manjaro|manjaro-arm) OS_ID="arch" ;;
        pop|linuxmint|zorin) OS_ID="ubuntu" ;;
        fedora-asahi-remix)  OS_ID="fedora" ;;
    esac
fi
ARCH="$(uname -m)"
log "OS=$OS_ID  arch=$ARCH"

# ──────────────────────────────────────────────────────────────────────────
# 2. Install Docker if missing
# ──────────────────────────────────────────────────────────────────────────

install_docker() {
    log "Docker not found — installing"
    case "$OS_ID" in
        ubuntu|debian|raspbian)
            export DEBIAN_FRONTEND=noninteractive
            $SUDO apt-get update -y >/dev/null
            $SUDO apt-get install -y ca-certificates curl >/dev/null
            curl -fsSL https://get.docker.com | $SUDO sh
            ;;
        alpine)
            $SUDO apk add --no-cache docker docker-cli-compose curl >/dev/null
            $SUDO rc-update add docker default >/dev/null 2>&1 || true
            $SUDO service docker start >/dev/null 2>&1 || $SUDO rc-service docker start
            ;;
        arch)
            $SUDO pacman -Sy --noconfirm --needed docker docker-compose >/dev/null
            $SUDO systemctl enable --now docker >/dev/null 2>&1 || true
            ;;
        centos|rhel|rocky|almalinux|ol)
            if ! command -v dnf >/dev/null 2>&1; then
                $SUDO yum install -y dnf >/dev/null
            fi
            $SUDO dnf config-manager --add-repo=https://download.docker.com/linux/centos/docker-ce.repo >/dev/null 2>&1 || true
            $SUDO dnf install -y docker-ce docker-ce-cli containerd.io >/dev/null
            $SUDO systemctl enable --now docker >/dev/null
            ;;
        fedora)
            $SUDO dnf install -y dnf-plugins-core >/dev/null
            $SUDO dnf config-manager --add-repo=https://download.docker.com/linux/fedora/docker-ce.repo >/dev/null 2>&1 || true
            $SUDO dnf install -y docker-ce docker-ce-cli containerd.io >/dev/null
            $SUDO systemctl enable --now docker >/dev/null
            ;;
        amzn)
            $SUDO dnf install -y docker >/dev/null
            $SUDO systemctl enable --now docker >/dev/null
            ;;
        *)
            fail "Don't know how to install Docker on '$OS_ID'. Install it manually and re-run."
            ;;
    esac
    ok "Docker installed"
}

if command -v docker >/dev/null 2>&1 && $SUDO docker info >/dev/null 2>&1; then
    ok "Docker already installed and running"
else
    if [ "$OS_ID" = "unknown" ]; then
        fail "Need to install Docker but couldn't detect the OS. Install Docker manually and re-run."
    fi
    install_docker
    if ! $SUDO docker info >/dev/null 2>&1; then
        fail "Docker installed but the daemon isn't responding. Check 'systemctl status docker'."
    fi
fi

# ──────────────────────────────────────────────────────────────────────────
# 3. Prepare config dir
# ──────────────────────────────────────────────────────────────────────────

if [ ! -d "$CONFIG_DIR" ]; then
    $SUDO mkdir -p "$CONFIG_DIR"
    $SUDO chmod 0700 "$CONFIG_DIR"
    ok "Created $CONFIG_DIR (mode 0700)"
else
    ok "$CONFIG_DIR already exists"
fi

# Persist the non-secret config the `kujira` CLI needs to operate the
# container (start/recreate). The agent_token stays in its own file —
# this one carries no secrets. Rewritten on every install so upgrades to
# the image / control URL are picked up.
printf 'KJ_CONTROL_URL=%s\nKJ_SUPERVISOR_IMAGE=%s\nKJ_SUPERVISOR_CONTAINER=%s\nKJ_CONFIG_DIR=%s\n' \
    "$KJ_CONTROL_URL" "$SUPERVISOR_IMAGE" "$SUPERVISOR_CONTAINER" "$CONFIG_DIR" \
    | $SUDO tee "$CONFIG_DIR/supervisor.env" >/dev/null
$SUDO chmod 0600 "$CONFIG_DIR/supervisor.env"
ok "Wrote $CONFIG_DIR/supervisor.env"

# ──────────────────────────────────────────────────────────────────────────
# 4. Pull image
# ──────────────────────────────────────────────────────────────────────────

log "Pulling $SUPERVISOR_IMAGE (this may take a moment)"
if $SUDO docker pull "$SUPERVISOR_IMAGE" >/dev/null 2>&1; then
    ok "Image pulled"
elif $SUDO docker image inspect "$SUPERVISOR_IMAGE" >/dev/null 2>&1; then
    # Pull failed (offline registry, dev image, etc.) but the image is
    # already cached locally — that's fine, we can still run.
    warn "Could not pull $SUPERVISOR_IMAGE, falling back to local cached image"
else
    fail "docker pull failed and no local image found. Check KJ_SUPERVISOR_IMAGE and registry access."
fi

# ──────────────────────────────────────────────────────────────────────────
# 5. Stop old container if present, then run the new one
# ──────────────────────────────────────────────────────────────────────────

if $SUDO docker inspect "$SUPERVISOR_CONTAINER" >/dev/null 2>&1; then
    log "Stopping existing $SUPERVISOR_CONTAINER"
    $SUDO docker rm -f "$SUPERVISOR_CONTAINER" >/dev/null
fi

# Decide whether to inject the provisioning_token via env (first boot) or
# trust the persisted $CONFIG_DIR/token from a previous install.
ENV_ARGS=( -e "KJ_CONTROL_URL=$KJ_CONTROL_URL" )
if [ -f "$CONFIG_DIR/token" ]; then
    log "Found existing $CONFIG_DIR/token — reusing the persisted agent_token"
else
    log "First boot — passing KJ_PROVISIONING_TOKEN to the supervisor"
    ENV_ARGS+=( -e "KJ_PROVISIONING_TOKEN=$KJ_PROVISIONING_TOKEN" )
fi

# Always pass the self-identify env so the supervisor can blue/green
# itself when the control sends supervisor:upgrade-required.
ENV_ARGS+=( -e "KJ_SUPERVISOR_CONTAINER=$SUPERVISOR_CONTAINER" )

log "Starting $SUPERVISOR_CONTAINER"
$SUDO docker run -d \
    --name "$SUPERVISOR_CONTAINER" \
    --restart unless-stopped \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -v "$CONFIG_DIR":/etc/kj-supervisor \
    "${ENV_ARGS[@]}" \
    "$SUPERVISOR_IMAGE" >/dev/null
ok "Container started"

# ──────────────────────────────────────────────────────────────────────────
# 5b. Install the `kujira` control CLI
# ──────────────────────────────────────────────────────────────────────────

log "Installing the kujira CLI to $KJ_CLI_PATH"
if curl -fsSL "$KJ_CLI_URL" -o /tmp/kujira.$$ 2>/dev/null; then
    $SUDO install -m 0755 /tmp/kujira.$$ "$KJ_CLI_PATH"
    rm -f /tmp/kujira.$$
    ok "Installed kujira CLI ($KJ_CLI_PATH)"
else
    warn "Could not fetch the kujira CLI from $KJ_CLI_URL — skipping."
    warn "You can still operate the supervisor with raw docker commands."
fi

# ──────────────────────────────────────────────────────────────────────────
# 6. Verify handshake
# ──────────────────────────────────────────────────────────────────────────

log "Waiting up to ${HANDSHAKE_TIMEOUT_SECONDS}s for handshake with $KJ_CONTROL_URL"

deadline=$(( $(date +%s) + HANDSHAKE_TIMEOUT_SECONDS ))
last_logs=""
while [ "$(date +%s)" -lt "$deadline" ]; do
    if ! $SUDO docker inspect -f '{{.State.Running}}' "$SUPERVISOR_CONTAINER" 2>/dev/null | grep -q true; then
        last_logs="$($SUDO docker logs --tail 50 "$SUPERVISOR_CONTAINER" 2>&1 || true)"
        printf '%s\n' "$last_logs" >&2
        fail "Container exited before handshake. See logs above."
    fi
    if $SUDO docker logs "$SUPERVISOR_CONTAINER" 2>&1 | grep -q 'handshake complete'; then
        ok "Handshake complete — supervisor is online"
        cat <<EOF

═══════════════════════════════════════════════════════════════════════════
  kj-supervisor is up.

  Container:  $SUPERVISOR_CONTAINER
  Image:      $SUPERVISOR_IMAGE
  Config:     $CONFIG_DIR

  Manage it with the kujira CLI:
    Status:    kujira status     (is it online?)
    Logs:      kujira logs -f
    Restart:   kujira restart
    Stop:      kujira stop
    Start:     kujira start
═══════════════════════════════════════════════════════════════════════════
EOF
        exit 0
    fi
    sleep 1
done

log "Handshake timed out. Last 50 lines of supervisor logs:"
$SUDO docker logs --tail 50 "$SUPERVISOR_CONTAINER" >&2 || true
fail "Supervisor did not complete handshake in ${HANDSHAKE_TIMEOUT_SECONDS}s. Check the logs above and verify KJ_CONTROL_URL + provisioning token."
