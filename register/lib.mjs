// Shared helpers for the manual ZCore validator scripts (register / unstake).
// No dashboard involved — everything talks to public endpoints + your local node.
import { ethers } from 'ethers';
import * as ax from '@avalabs/avalanchejs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const { Interface, Contract, Wallet, JsonRpcProvider, SigningKey, getBytes, hexlify, ripemd160, sha256 } = ethers;

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---------- config ----------
export const NET = JSON.parse(fs.readFileSync(path.join(HERE, 'network.json'), 'utf8'));

// .env (optional) + process.env — .env wins if present
const env = { ...process.env };
try {
  for (const ln of fs.readFileSync(path.join(HERE, '.env'), 'utf8').split('\n')) {
    const m = ln.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '').replace(/\r$/, '');
  }
} catch { /* no .env, rely on process.env */ }

// One secp256k1 key funds everything: its EVM address holds ZEUS, its P-Chain
// address holds AVAX. You can override the P-Chain key separately if you want.
const RAW_EVM = env.PRIVATE_KEY || env.EVM_PRIVATE_KEY;
if (!RAW_EVM) throw new Error('Set PRIVATE_KEY in register/.env (see .env.example)');
export const EVM_KEY = (RAW_EVM.startsWith('0x') ? '' : '0x') + RAW_EVM.trim();
export const PCHAIN_KEY = (env.PCHAIN_PRIVATE_KEY || RAW_EVM).replace(/^0x/, '').trim();
export const NODE_URL = (env.NODE_URL || 'http://127.0.0.1:9650').replace(/\/$/, '');

export const L1_RPC = NET.rpc;
export const PCHAIN = NET.pchainApi;
export const SUBNET_ID = NET.subnetId;
export const NETWORK_ID = NET.networkId;
export const SIGAGG = NET.sigAgg;
export const ZEUS_ADDR = NET.contracts.ZEUS;
export const STAKING_MANAGER = NET.contracts.StakingManager;
export const VALIDATOR_MANAGER = NET.contracts.ValidatorManager;
export const VALIDATOR_REWARDS = NET.contracts.ValidatorRewards;
export const WARP_PRECOMPILE = '0x0200000000000000000000000000000000000005';
export const DELEGATION_FEE_BIPS = 100, MIN_STAKE_DURATION = 100;

export const STATE_FILE = path.join(HERE, 'validator-state.json');
export const loadState = () => { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; } };
export const saveState = (s) => fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export { ethers, ax, Interface, Contract, Wallet, JsonRpcProvider, getBytes, hexlify, sha256 };

// ---------- identity from your local node ----------
export async function fetchNodeIdentity() {
  const r = await fetch(`${NODE_URL}/ext/info`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'info.getNodeID' }),
  });
  const d = await r.json();
  const res = d?.result;
  if (!res?.nodeID || !res?.nodePOP) throw new Error(`Could not read node identity from ${NODE_URL} — is the node running? (${JSON.stringify(d?.error || d)})`);
  return { nodeID: res.nodeID, blsPub: res.nodePOP.publicKey, blsPop: res.nodePOP.proofOfPossession };
}

// ---------- address derivation ----------
export function pAddr20FromPriv(privHex) {
  const pub = new SigningKey(privHex.startsWith('0x') ? privHex : '0x' + privHex).compressedPublicKey;
  return ripemd160(sha256(pub));
}
export function pchainAddr() {
  return 'P-' + ax.utils.formatBech32('fuji', ax.secp256k1.publicKeyBytesToAddress(ax.secp256k1.getPublicKey(ax.utils.hexToBuffer(PCHAIN_KEY))));
}

const B58_CS = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function nodeIDToBytes(nodeId) {
  const s = nodeId.trim().replace(/^NodeID-/, ''); if (!s) throw new Error('empty nodeID');
  let num = 0n; for (const ch of s) { const v = B58_CS.indexOf(ch); if (v < 0) throw new Error('bad char in nodeID'); num = num * 58n + BigInt(v); }
  let hex = num.toString(16); if (hex.length % 2) hex = '0' + hex; let bytes = getBytes('0x' + hex);
  let pad = 0; for (const ch of s) { if (ch === '1') pad++; else break; }
  if (pad) { const z = new Uint8Array(pad + bytes.length); z.set(bytes, pad); bytes = z; }
  if (bytes.length !== 24) throw new Error('bad nodeID length'); const payload = bytes.slice(0, 20), check = bytes.slice(20);
  const h = getBytes(sha256(hexlify(payload))); for (let i = 0; i < 4; i++) if (check[i] !== h[28 + i]) throw new Error('nodeID checksum mismatch');
  return hexlify(payload);
}

// ---------- warp message builders (ACP-77) ----------
const _u32 = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n); return b; };
const _cat = (...arr) => { const t = new Uint8Array(arr.reduce((s, x) => s + x.length, 0)); let o = 0; for (const x of arr) { t.set(x, o); o += x.length; } return t; };
const _bytesField = (u8) => _cat(_u32(u8.length), u8);
const _CODEC0 = new Uint8Array([0, 0]);

export function buildAckMessage(validationIDHex, registered = true) {
  const vid = getBytes(validationIDHex);
  const inner = _cat(_CODEC0, _u32(2), vid, new Uint8Array([registered ? 1 : 0]));
  const acc = _cat(_CODEC0, _u32(1), _bytesField(new Uint8Array(0)), _bytesField(inner));
  const unsigned = _cat(_CODEC0, _u32(NETWORK_ID), new Uint8Array(32), _bytesField(acc));
  return hexlify(unsigned);
}
export function extractInnerRegisterMsg(warpMsgHex) {
  const b = getBytes(warpMsgHex); const u32at = (o) => new DataView(b.buffer, b.byteOffset + o, 4).getUint32(0);
  let o = 2 + 4 + 32; o += 4; let p = o + 2 + 4; const srcLen = u32at(p); p += 4 + srcLen; const payLen = u32at(p); p += 4; return b.slice(p, p + payLen);
}
export function buildJustification(inner) {
  const varint = []; let n = inner.length; while (n >= 0x80) { varint.push((n & 0x7f) | 0x80); n >>= 7; } varint.push(n);
  const out = new Uint8Array(1 + varint.length + inner.length); out[0] = 0x12; out.set(varint, 1); out.set(inner, 1 + varint.length); return hexlify(out);
}
export function packWarpPredicate(signedHex) {
  const msg = getBytes(signedHex); const padLen = Math.ceil((msg.length + 1) / 32) * 32; const padded = new Uint8Array(padLen);
  padded.set(msg); padded[msg.length] = 0xff; const keys = []; for (let i = 0; i < padLen; i += 32) keys.push(hexlify(padded.slice(i, i + 32))); return keys;
}

// ---------- signature aggregation ----------
// Etapa B: the L1 node itself aggregates (it holds the message it emitted).
export async function aggregateViaNode(warpMsgHex) {
  const midCb58 = ax.Id.fromHex(sha256(warpMsgHex).replace(/^0x/, '')).toString();
  const r = await (await fetch(L1_RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'warp_getMessageAggregateSignature', params: [midCb58, 67, SUBNET_ID] }) })).json();
  if (r?.error) throw new Error('node warp agg: ' + JSON.stringify(r.error));
  if (!r.result) throw new Error('node warp agg: empty result');
  return r.result;
}
// Etapa C (ack): the off-chain signature-aggregator service (self-hosted, public HTTP).
export async function aggregateAck(messageHex, justificationHex) {
  const body = { message: messageHex.replace(/^0x/, ''), 'quorum-percentage': 67, 'signing-subnet-id': SUBNET_ID };
  if (justificationHex) body.justification = justificationHex.replace(/^0x/, '');
  const r = await fetch(SIGAGG, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({})); const signed = d?.['signed-message'] || d?.signedMessage;
  if (!signed) throw new Error('ack aggregator: ' + (d?.error || `HTTP ${r.status}`));
  return signed.startsWith('0x') ? signed : '0x' + signed;
}

// Find an existing initiate for a node (to resume / to recover validationID for unstake).
const REG_TOPIC = '0x56600c567728a800c0aa927500f831cb451df66a7af570eb4df4dfbf4674887d';
export async function findInitiateForNode(nodeBytesHex) {
  const IFACE = new Interface(['event SendWarpMessage(address indexed sender, bytes32 indexed messageID, bytes message)']);
  const body = { jsonrpc: '2.0', id: 1, method: 'eth_getLogs', params: [{ fromBlock: '0x0', toBlock: 'latest', address: WARP_PRECOMPILE, topics: [REG_TOPIC] }] };
  const r = await (await fetch(L1_RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
  const logs = r?.result || []; const want = nodeBytesHex.toLowerCase();
  for (let i = logs.length - 1; i >= 0; i--) {
    try {
      const p = IFACE.parseLog({ topics: logs[i].topics, data: logs[i].data }); const msg = p.args.message;
      const inner = extractInnerRegisterMsg(msg); const typeId = new DataView(inner.buffer, inner.byteOffset + 2, 4).getUint32(0);
      if (typeId !== 1) continue;
      const dv = new DataView(inner.buffer, inner.byteOffset); let o = 2 + 4 + 32; const len = dv.getUint32(o); o += 4;
      const nid = hexlify(inner.slice(o, o + len)).toLowerCase();
      if (nid === want) return { validationID: sha256(hexlify(inner)), warpMsg: msg };
    } catch { /* skip */ }
  }
  return null;
}

// ---------- shared setup ----------
export async function setup() {
  const provider = new JsonRpcProvider(L1_RPC);
  const owner = new Wallet(EVM_KEY, provider);
  const pvmapi = new ax.pvm.PVMApi(PCHAIN);
  const ctx = await ax.Context.getContextFromURI(PCHAIN);
  const pk = ax.utils.hexToBuffer(PCHAIN_KEY);
  const pAddr = pchainAddr();
  const pBytes = ax.utils.bech32ToBytes(pAddr);
  return { provider, owner, pvmapi, ctx, pk, pAddr, pBytes };
}

export async function pchainBalanceNano(addr) {
  const r = await (await fetch(`${PCHAIN}/ext/bc/P`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'platform.getBalance', params: { addresses: [addr] } }) })).json();
  return BigInt(r.result.balance);
}
export async function isOnPChain(pvmapi, validationIDHex) {
  const vidCb58 = ax.Id.fromHex(validationIDHex.replace(/^0x/, '')).toString();
  try { const v = await pvmapi.getL1Validator(vidCb58); return !!(v && (v.nodeID || v.weight)); } catch { return false; }
}

// ---------- ValidatorManager status (chain = source of truth) ----------
// ACP-99 ValidatorStatus: 0 Unknown | 1 PendingAdded | 2 Active | 3 PendingRemoved | 4 Completed | 5 Invalidated.
// Reads it fresh from the VM. NEVER trust a saved validationID without checking this: a SendWarpMessage
// initiate log stays on-chain forever, so a REMOVED validator still "looks like" an initiate you can resume.
const VM_GETVALIDATOR_ABI = 'function getValidator(bytes32) view returns (tuple(uint8 status, bytes nodeID, uint64 sw, uint64 sn, uint64 rn, uint64 weight))';
export async function vmStatus(provider, validationIDHex) {
  try { return Number((await new Contract(VALIDATOR_MANAGER, [VM_GETVALIDATOR_ABI], provider).getValidator(validationIDHex)).status); }
  catch { return 0; }
}
// A registration you can RESUME (mid-flight or already active). 0/3/4/5 are dead for a fresh register.
export const isResumableRegistration = (s) => s === 1 || s === 2;
// Nothing left to unstake (already gone / never really there).
export const isAlreadyRemoved = (s) => s === 0 || s === 4 || s === 5;
