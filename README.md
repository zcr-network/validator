# Run a ZCore validator

Spin up a **ZCore Network** validator node with Docker — you only configure your **public IP**.
The node builds its own identity (NodeID + BLS key) locally; no keys ship in the image.

## Network

| | |
|---|---|
| Chain ID (ZCore L1) | **92673** |
| Base network | **Avalanche Fuji** (the ZCore L1 runs on top; registered on Fuji's P-Chain) |
| Native gas token | **ZCR** |
| Validator token (gate) | **ZEUS** — 1 ZEUS = 1 validator slot |
| RPC | https://testnet.zcore.network/rpc |
| Explorer | https://testnet.zcore.network |
| Dashboard | https://dashboard.zcore.network |
| Stack | avalanchego **v1.14.0** + subnet-evm **v0.8.0** |

## What you need

1. **1 ZEUS** — the validation gate (1 ZEUS = 1 slot). Without it you can't register.
2. **A server** with a **public IP** and **port 9651/tcp open to the internet** (P2P/staking). Port 9650 is the API (keep it local if you prefer).
3. Docker + Docker Compose.

## Configuration (env vars)

The node is configured entirely by environment variables — normally you set only `PUBLIC_IP`.

| Variable | Required | Default | Description |
|---|---|---|---|
| `PUBLIC_IP` | **yes** | — | Your server's public IP (advertised to peers). |
| `SUBNET_ID` | no | ZCore L1 | The subnet the node tracks. |

Everything else (Fuji network config, the subnet-evm plugin, partial sync) is baked into the image.
The node bootstraps from Avalanche Fuji's official network — no custom genesis or seed list needed —
and runs with **partial sync** (P-Chain + the ZCore L1 only), keeping disk usage low.

## 1) Run the node

The official image is on Docker Hub — **no build needed**, just pull and run.

**Fastest — one command** (asks for your public IP, pulls the image, starts the node):

```bash
curl -fsSL https://raw.githubusercontent.com/zcr-network/validator/main/install.sh | sh
```

**Or manually:**

```bash
docker run -d --name zcore-validator --restart unless-stopped \
  -e PUBLIC_IP=<your-server-ip> \
  -p 9650:9650 -p 9651:9651 \
  -v zcore-data:/root/.avalanchego \
  zcorenetwork/validator:latest
docker logs -f zcore-validator   # watch it bootstrap
```

**Or with Compose:**

```bash
cp .env.example .env        # set PUBLIC_IP=<your server public IP>
docker compose up -d
```

> **Persist the volume** (`zcore-data`) — it holds your identity (NodeID/BLS). Lose it and your NodeID changes.

## 2) Wait for it to sync

The node bootstraps from the Avalanche Fuji network and tracks the ZCore L1. Check health:

```bash
curl -s http://localhost:9650/ext/health | grep -o '"healthy":[a-z]*'
```

## 3) Get your NodeID + BLS (proof of possession)

You'll need these to register. Ask the node:

```bash
curl -sX POST http://localhost:9650/ext/info \
  -H 'content-type:application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"info.getNodeID"}'
```

It returns your `nodeID` and a `nodePOP` with `publicKey` + `proofOfPossession` (the BLS bits).

## 4) Register as a validator (lock 1 ZEUS)

Registration adds your node to the L1 validator set through the **ValidatorManager**
(an ERC20-staking manager gated by ZEUS), which locks **1 ZEUS** and sends a Warp message
to the P-Chain. Submit your `nodeID` + BLS proof-of-possession from step 3.

Open **Become a Validator** on the [dashboard](https://dashboard.zcore.network/validators)
for the current registration flow. Once registered, your node earns ZCR:
- **Rotation reward** — the treasury pays validators in round-robin.
- **Fee tips** — a share of gas fees (the rest is burned).

Payouts are triggered by the permissionless `distribute()` / `settle()` — do it yourself
from the dashboard or let the network keeper automate it. Nothing is lost if no one triggers;
it just stays pending on-chain.

## 5) Leave the validator set (unstake — get your 1 ZEUS + AVAX back)

Validating on ZCore is **fully reversible**: you can leave whenever you want and get everything
back. Leaving (a.k.a. *unstake* / **"Desfazer / Undo"**) does three things:

- returns your **1 ZEUS** to the wallet that staked it,
- refunds your validator's **AVAX balance** to your **P-Chain** owner address (the
  `remainingBalanceOwner` you set when registering),
- removes your node from the L1 validator set.

Do it from **"Desfazer / Undo"** on the [dashboard](https://dashboard.zcore.network/validators)
(the same page you registered on). It walks the removal through the P-Chain and unlocks your ZEUS
in one flow — no funds are lost.

> **You can re-join anytime.** ZCore does **not** gate re-entry on churn or weight — the only limit
> is the ZEUS gate (1 ZEUS = 1 slot). Leave today, come back tomorrow with the same node: just run
> **Become a Validator** again. (Right after leaving, the P-Chain validator set takes a few minutes
> to settle before a fresh registration confirms — if it doesn't go through on the first try, wait
> a couple of minutes and retry.)

Leaving is independent of the box: your node keeps running (and can re-register). If you also want
to **decommission the server**, do the uninstall in step 6 — but **unstake here first** so your
ZEUS/AVAX come back.

## 6) Uninstall (remove the node from this server)

Use `uninstall.sh` when you want to **completely remove** the validator from a server — you're
decommissioning the box, moving to another host, or you simply no longer want to validate. It
**permanently deletes** from this server:

- the container (`zcore-validator`),
- the data volume (`zcore-data`) — this holds your node **identity** (NodeID + BLS key), so it
  **cannot be recovered** afterwards,
- the image.

```bash
curl -fsSL https://raw.githubusercontent.com/zcr-network/validator/main/uninstall.sh | sh
```

It asks you to type the exact phrase `DELETE VALIDATOR` to confirm — nothing is removed otherwise.

> 🔴 **Unstake first (step 5) if you're still registered.** Deleting the node does **not** return
> your funds — the **1 ZEUS** stays locked and the **AVAX** stays on the P-Chain validation until it
> drains/expires. Always run **"Desfazer / Undo"** on the
> [dashboard](https://dashboard.zcore.network/validators) **before** you uninstall. The firewall
> port `9651/tcp` is left as-is — close it manually if you like.

## Notes

- **Versions are pinned** (avalanchego v1.14.0 + subnet-evm v0.8.0) and must match — don't bump them.
- Firewall: `9651/tcp` must be reachable from the internet; `9650/tcp` only if you expose the API.
- Registering a validator on Fuji's P-Chain carries a small **continuous fee in Fuji AVAX** (testnet
  AVAX, free from the faucet) — the registration flow handles it.
