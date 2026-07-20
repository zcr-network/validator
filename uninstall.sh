#!/bin/sh
# ============================================================================
# ZCore Network - validator UNINSTALLER.
# Removes the node container + data volume (identity) + image from this server.
#
#   curl -fsSL https://raw.githubusercontent.com/zcr-network/validator/main/uninstall.sh | sh
# ============================================================================
say() { printf '%s\n' "$*"; }

# root / sudo wrapper (docker needs root on most servers)
SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  if command -v sudo >/dev/null 2>&1; then SUDO="sudo"; fi
fi

BAR="======================================================================================"
printf '\n%s\n' "$BAR"
printf '   ⚠️   ⚠️   ⚠️     UNINSTALL THE ZCORE VALIDATOR     ⚠️   ⚠️   ⚠️\n'
printf '%s\n\n' "$BAR"
printf '   This will PERMANENTLY DELETE from THIS server:\n'
printf '     • the validator container  (zcore-validator)\n'
printf '     • the data volume          (zcore-data)  - holds your node IDENTITY\n'
printf '       (NodeID + BLS key). This CANNOT be recovered afterwards.\n\n'
printf '   🔴  If your validator is STILL REGISTERED (1 ZEUS staked), run\n'
printf '       "Desfazer / Undo" in the dashboard FIRST:\n'
printf '           https://dashboard.zcore.network/validators\n'
printf '       That unlocks your 1 ZEUS and refunds your AVAX. If you delete the node\n'
printf '       WITHOUT undoing first, the ZEUS/AVAX stay locked until the validation\n'
printf '       drains/expires on the P-Chain.\n\n'
printf '%s\n' "$BAR"

# BIG confirmation: must type the exact phrase (not just y/n)
CONFIRM="DELETE VALIDATOR"
printf '\n   To confirm, type EXACTLY this phrase and press Enter:\n\n       %s\n\n   > ' "$CONFIRM"
ans=""
if [ -e /dev/tty ]; then read ans < /dev/tty || ans=""; fi
if [ "$ans" != "$CONFIRM" ]; then
  printf '\n   ❌ Cancelled - the phrase did not match. NOTHING was deleted.\n\n'
  exit 0
fi

printf '\n==> stopping + removing the containers ...\n'
$SUDO docker rm -f zcore-validator zcore-status >/dev/null 2>&1 || true
printf '==> removing the data volume (identity) ...\n'
$SUDO docker volume rm zcore-data >/dev/null 2>&1 || true
printf '==> removing the internal network ...\n'
$SUDO docker network rm zcore-net >/dev/null 2>&1 || true
printf '==> removing the images ...\n'
$SUDO docker rmi zcorenetwork/validator:latest zcorenetwork/validator-status:latest >/dev/null 2>&1 || true

printf '\n%s\n' "$BAR"
printf '   ✅  Validator uninstalled - container, data and image removed from this server.\n'
printf '%s\n' "$BAR"
printf '      (Firewall ports 9651/tcp and 9055/tcp were left as-is - close them manually if you like.)\n\n'
