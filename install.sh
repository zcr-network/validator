#!/bin/sh
# ============================================================================
# ZCore Network — validator installer.
# Detects your OS, installs Docker (asks first), opens the staking port
# (asks first), then pulls the image and starts your node. You only give
# your public IP.
#
#   curl -fsSL https://raw.githubusercontent.com/zcr-network/validator/main/install.sh | sh
#   # non-interactive (auto-yes, IP from env):
#   PUBLIC_IP=203.0.113.10 ASSUME_YES=1 sh install.sh
# ============================================================================
set -e

IMAGE="zcorenetwork/validator:latest"
STAKE_PORT=9651   # P2P/staking — MUST be reachable from the internet
API_PORT=9650     # JSON-RPC/API — kept local by default (bound to 127.0.0.1)

say()  { printf '%s\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }

# root / sudo wrapper (Docker install + firewall need root)
SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  if have sudo; then SUDO="sudo"; else
    say "⚠️  Not root and 'sudo' not found — Docker install / firewall steps may fail."
  fi
fi

# y/n prompt — reads from /dev/tty so it also works under 'curl | sh'
ask() {
  [ "${ASSUME_YES:-}" = "1" ] && return 0
  if [ -e /dev/tty ]; then
    printf '%s [y/N]: ' "$1" > /dev/tty; read ans < /dev/tty || ans=""
  else
    return 1
  fi
  case "$ans" in [yY]*) return 0 ;; *) return 1 ;; esac
}

# free-text prompt with a default. If a default is given, Enter accepts it.
prompt() {
  a=""
  if [ -e /dev/tty ]; then
    if [ -n "$2" ]; then
      printf '%s [%s]  (press Enter to accept, or type another): ' "$1" "$2" > /dev/tty
    else
      printf '%s: ' "$1" > /dev/tty
    fi
    read a < /dev/tty || a=""
  fi
  [ -n "$a" ] && printf '%s' "$a" || printf '%s' "$2"
}

# --- 0) OS ---
OS="unknown"; OSVER=""; PRETTY=""
if [ -r /etc/os-release ]; then . /etc/os-release; OS="$ID"; OSVER="$VERSION_ID"; PRETTY="$PRETTY_NAME"; fi
say "==> System: ${PRETTY:-$OS $OSVER} · $(uname -sm)"
case "$(uname -s)" in Linux) : ;; *) say "⚠️  This installer targets Linux servers."; esac

# --- 1) Docker ---
if have docker; then
  say "==> Docker: $(docker --version 2>/dev/null | head -1)"
else
  say "Docker is not installed."
  if ask "Install Docker now (get.docker.com)?"; then
    say "==> installing Docker ..."
    curl -fsSL https://get.docker.com | $SUDO sh
    $SUDO systemctl enable --now docker 2>/dev/null || $SUDO service docker start 2>/dev/null || true
  else
    say "Docker is required. Aborting."; exit 1
  fi
fi
have docker || { say "Docker still not available. Aborting."; exit 1; }

# --- 2) Public IP (auto-detected; just press Enter to accept) ---
if [ -z "${PUBLIC_IP:-}" ]; then
  DET="$(curl -s https://api.ipify.org 2>/dev/null || true)"
  [ -n "$DET" ] && say "==> detected this server's public IP: $DET"
  PUBLIC_IP="$(prompt 'Your server public IP' "$DET")"
fi
[ -n "$PUBLIC_IP" ] || { say "PUBLIC_IP is required. Aborting."; exit 1; }
say "==> using public IP: $PUBLIC_IP"

# --- 3) Firewall: staking port 9651 open? ---
FW=""; NEEDS_OPEN=0
if have ufw && $SUDO ufw status 2>/dev/null | grep -qi "Status: active"; then
  FW="ufw"
  $SUDO ufw status 2>/dev/null | grep -qE "(^|[[:space:]])${STAKE_PORT}(/tcp)?[[:space:]]+ALLOW" || NEEDS_OPEN=1
elif have firewall-cmd && $SUDO firewall-cmd --state 2>/dev/null | grep -qi running; then
  FW="firewalld"
  $SUDO firewall-cmd --list-ports 2>/dev/null | grep -q "${STAKE_PORT}/tcp" || NEEDS_OPEN=1
fi

if [ -n "$FW" ] && [ "$NEEDS_OPEN" = "1" ]; then
  say "Port ${STAKE_PORT}/tcp (P2P/staking) looks CLOSED in ${FW}."
  if ask "Open ${STAKE_PORT}/tcp now?"; then
    case "$FW" in
      ufw)       $SUDO ufw allow ${STAKE_PORT}/tcp >/dev/null 2>&1 ;;
      firewalld) $SUDO firewall-cmd --permanent --add-port=${STAKE_PORT}/tcp >/dev/null 2>&1 && $SUDO firewall-cmd --reload >/dev/null 2>&1 ;;
    esac
    say "==> opened ${STAKE_PORT}/tcp in ${FW}."
  else
    say "⚠️  Left closed — peers can't reach your node until ${STAKE_PORT}/tcp is open."
  fi
elif [ -n "$FW" ]; then
  say "==> firewall (${FW}): ${STAKE_PORT}/tcp already open."
else
  say "==> no active ufw/firewalld found. Ensure your cloud security group allows ${STAKE_PORT}/tcp inbound."
fi

# --- 4) Pull + run (idempotente: se já estiver rodando, não recria) ---
if $SUDO docker ps --filter name=zcore-validator --filter status=running -q | grep -q .; then
  say "==> validator already running — will just verify and show your identity."
  $SUDO docker ps --filter name=zcore-validator --format '==> {{.Names}} {{.Status}}'
else
  say "==> pulling $IMAGE ..."
  $SUDO docker pull "$IMAGE"
  say "==> starting the validator ..."
  $SUDO docker rm -f zcore-validator >/dev/null 2>&1 || true
  $SUDO docker run -d --name zcore-validator --restart unless-stopped \
    -e PUBLIC_IP="$PUBLIC_IP" \
    -p 127.0.0.1:${API_PORT}:${API_PORT} \
    -p ${STAKE_PORT}:${STAKE_PORT} \
    -v zcore-data:/root/.avalanchego \
    "$IMAGE" >/dev/null
  sleep 2
  $SUDO docker ps --filter name=zcore-validator --format '==> {{.Names}} {{.Status}}'
fi

# --- 5) Aguarda a API e busca NodeID + BLS ---
say "==> waiting for the node API (NodeID/BLS) ..."
RESP=""; i=0
while [ $i -lt 60 ]; do
  RESP="$(curl -s -m 5 -X POST "http://localhost:${API_PORT}/ext/info" -H 'content-type:application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"info.getNodeID"}' 2>/dev/null || true)"
  case "$RESP" in *NodeID-*) break ;; esac
  i=$((i + 1)); sleep 2
done

case "$RESP" in
  *NodeID-*) : ;;
  *)
    say ""
    say "⚠️  Node still starting — NodeID not ready yet. Run this same command again in ~1 min,"
    say "    or fetch it manually:"
    say "    curl -sX POST http://localhost:${API_PORT}/ext/info -H 'content-type:application/json' -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"info.getNodeID\"}'"
    exit 0
    ;;
esac

# parse sem jq (JSON de uma linha)
NODEID="$(printf '%s' "$RESP" | sed -n 's/.*"nodeID":"\([^"]*\)".*/\1/p')"
BLSPUB="$(printf '%s' "$RESP" | sed -n 's/.*"publicKey":"\([^"]*\)".*/\1/p')"
BLSPOP="$(printf '%s' "$RESP" | sed -n 's/.*"proofOfPossession":"\([^"]*\)".*/\1/p')"

BAR="======================================================================================"
printf '\n\n%s\n' "$BAR"
printf '   ✅  YOUR VALIDATOR IDENTITY  —  copy these 3 into the dashboard to register\n'
printf '%s\n\n' "$BAR"
printf '   1) NodeID\n   >>  %s\n\n' "$NODEID"
printf '   2) BLS public key\n   >>  %s\n\n' "$BLSPUB"
printf '   3) BLS proof of possession\n   >>  %s\n' "$BLSPOP"
printf '%s\n' "$BAR"
printf '\n   👉  Register (locks 1 ZEUS):  https://dashboard.zcore.network/validators\n\n'
printf '   Notes:\n'
printf '    • Keep port %s/tcp open to the internet (P2P) — cloud firewall/security group too.\n' "$STAKE_PORT"
printf "    • Don't delete the 'zcore-data' volume — it holds your identity.\n"
printf '    • Re-run this command anytime to re-check status and show your identity again.\n\n'
