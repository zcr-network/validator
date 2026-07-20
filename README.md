# Run a ZCore validator

Spin up a **ZCore Network** validator node with Docker and register it entirely from the
**command line**, no dashboard, no web UI. The node builds its own identity (NodeID + BLS key)
locally; the register/unstake scripts read it straight from the node.

## Network

| | |
|---|---|
| Chain ID (ZCore L1) | **92673** |
| Base network | **Avalanche Fuji** (the ZCore L1 runs on top; registered on Fuji's P-Chain) |
| Native gas token | **ZCR** |
| Validator token (gate) | **ZEUS**, 1 ZEUS = 1 validator slot |
| RPC | https://testnet.zcore.network/rpc |
| Explorer | https://testnet.zcore.network |
| Stack | avalanchego **v1.14.0** + subnet-evm **v0.8.0** |

## What you need

1. **1 ZEUS** in an EVM wallet, the validation gate (1 ZEUS = 1 slot). Without it you can't register.
2. **Test AVAX** on the Fuji **P-Chain**, funds the validator balance + the small continuous
   P-Chain fee. (Free from the Fuji faucet.)
3. A little **ZCR** for L1 gas (the approve/register txs). Free from the ZCore faucet.
4. **A server** with a **public IP** and **port 9651/tcp open to the internet** (P2P/staking).
   Port 9650 is the API (kept local). Port **9055/tcp** serves the read-only status page (safe to expose).
5. **Docker** (to run the node) and **Node.js 18+** (to run the register/unstake scripts).
6. Your **operator private key** (a secp256k1 hex key). The same key holds the ZEUS on the EVM
   side and the AVAX on the P-Chain side.

Everything below is done from a terminal on your VPS.

---

# Part 1: Turn the validator ON (register)

## 1) Run the node

The official image is on Docker Hub, **no build needed**, just pull and run.

**Fastest, one command** (auto-detects your public IP, pulls the image, starts the node):

```bash
curl -fsSL https://raw.githubusercontent.com/zcr-network/validator/main/install.sh | sh
```

**Or manually:**

```bash
docker run -d --name zcore-validator --restart unless-stopped \
  -p 9650:9650 -p 9651:9651 \
  -v zcore-data:/root/.avalanchego \
  zcorenetwork/validator:latest
docker logs -f zcore-validator   # watch it bootstrap
```

> The node **auto-detects its public IP** (via `https://api.ipify.org`). To set it explicitly (e.g.
> behind NAT), add `-e PUBLIC_IP=<your-server-ip>` to the `docker run`.

> **Persist the volume** (`zcore-data`), it holds your identity (NodeID/BLS). Lose it and your NodeID changes.

## 2) Wait for it to sync

The node bootstraps from Avalanche Fuji and tracks the ZCore L1. The installer also starts a
small **status page**, open it from anywhere in your browser:

```
http://<your-server-ip>:9055
```

It shows **Syncing… / ✅ Synced** and your NodeID, auto-refreshing. (It's a separate read-only
container that reads the node over an internal Docker network, your API port 9650 stays private
on localhost.) Wait until it says **Synced** before registering.

Prefer the terminal? On the server:

```bash
curl -s http://localhost:9650/ext/health | grep -o '"healthy":[a-z]*'   # "healthy":true when synced
```

## 3) Get the register scripts

Clone this repo and install the scripts' dependencies:

```bash
git clone https://github.com/zcr-network/validator
cd validator/register
npm install
cp .env.example .env
```

Open `.env` and set your operator key:

```
PRIVATE_KEY=<your secp256k1 private key, hex>
```

That single key is used for both sides (EVM wallet that holds ZEUS + P-Chain address that holds
AVAX). The scripts talk only to the public RPC and the P-Chain, never to a dashboard.

## 4) Fund your two addresses

Print the addresses derived from your key (and your node's identity):

```bash
node whoami.mjs
```

You'll see an **EVM address** and a **P-Chain address**. Fund them:

- **EVM address** → send **1 ZEUS** + a little **ZCR** for gas (ZCR from the faucet).
- **P-Chain address** → send **test AVAX**. Get it from the Fuji faucet
  (faucet.avax.network / core.app/tools/testnet-faucet); if the faucet only pays the C-Chain,
  move it **C→P** with the Core wallet's Cross-Chain transfer.

Re-run `node whoami.mjs` until it shows `ZEUS: 1`+ and some `AVAX (P-Chain)`.

## 5) Register (lock 1 ZEUS)

```bash
node register.mjs
```

This runs the full flow by itself:

1. reads your node's **NodeID + BLS** from the running node,
2. approves and **locks 1 ZEUS** in the StakingManager,
3. registers your node on the **P-Chain** (`RegisterL1ValidatorTx`),
4. **activates** it on the L1 (`completeValidatorRegistration`),
5. joins the reward rotation.

> ⏳ Steps 3–4 wait on the P-Chain to settle and can take a few minutes, the script **retries
> automatically**, so just let it run. It's **resumable**: if it's interrupted, run `node
> register.mjs` again and it picks up where it left off (it won't lock a second ZEUS).

When it prints **"your validator is registered and active"**, you're validating and earning ZCR:
- **Rotation reward**, the treasury pays validators round-robin.
- **Fee tips**, a share of gas fees (the rest is burned).

Keep an eye on the P-Chain balance over time (the validation charges a small continuous fee); top
it up by sending more AVAX to your P-Chain address if it runs low.

---

# Part 2: Turn the validator OFF (unstake, get your 1 ZEUS + AVAX back)

Validating is **fully reversible**, and you do it from the same scripts, **no dashboard**. From
`validator/register`:

```bash
node unstake.mjs
```

This does the reverse of registration:

1. removes your node from the L1 validator set (P-Chain `SetL1ValidatorWeight` to 0),
2. **refunds the validator's AVAX** to your **P-Chain** address,
3. **unlocks your 1 ZEUS** back to your EVM wallet.

It prints your ZEUS/AVAX **before and after** so you can see the funds come back.

> ⏳ Like registration, the final step waits on the P-Chain to settle and **retries
> automatically**. Let it run.

**Re-join anytime.** ZCore does **not** gate re-entry on churn or weight, the only limit is the
ZEUS gate. Leave today, come back tomorrow with the same node: just run `node register.mjs` again.

Leaving is independent of the box, your node keeps running and can re-register. If you also want to
**decommission the server**, do the uninstall below (but **unstake first**, or your funds stay locked).

---

# Part 3: Uninstall (remove the node from this server)

Use `uninstall.sh` when you want to **completely remove** the validator from a server, you're
decommissioning the box or moving to another host. It **permanently deletes** from this server:

- the containers (`zcore-validator` + `zcore-status`),
- the data volume (`zcore-data`), this holds your node **identity** (NodeID + BLS key), so it
  **cannot be recovered** afterwards,
- the internal network (`zcore-net`) and the images.

```bash
curl -fsSL https://raw.githubusercontent.com/zcr-network/validator/main/uninstall.sh | sh
```

It asks you to type the exact phrase `DELETE VALIDATOR` to confirm, nothing is removed otherwise.

> 🔴 **Unstake first (Part 2) if you're still registered.** Deleting the node does **not** return
> your funds, the **1 ZEUS** stays locked and the **AVAX** stays on the P-Chain validation until it
> drains/expires. Run `node unstake.mjs` **before** you uninstall. The firewall port `9651/tcp` is
> left as-is, close it manually if you like.

## Notes

- **Versions are pinned** (avalanchego v1.14.0 + subnet-evm v0.8.0) and must match, don't bump them.
- Firewall: `9651/tcp` must be reachable from the internet; `9650/tcp` only if you expose the API.
- The register/unstake scripts keep their state in `register/validator-state.json` (git-ignored).
  You can also recover it from the chain, `unstake.mjs` looks your validator up by NodeID if the
  file is missing.
- Registering on Fuji's P-Chain carries a small **continuous fee in Fuji AVAX** (testnet AVAX, free
  from the faucet), keep a little AVAX on your P-Chain address.
