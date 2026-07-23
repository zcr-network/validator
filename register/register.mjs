// Register this node as a ZCore validator — MANUAL, no dashboard.
// Reads the node identity from your local node, locks 1 ZEUS, registers on the
// P-Chain and activates. Resumable + retries through the P-Chain settle lags.
//
//   node register.mjs
//
import {
  ethers, ax, Interface, Contract, sha256,
  NET, L1_RPC, PCHAIN, ZEUS_ADDR, STAKING_MANAGER, VALIDATOR_MANAGER, VALIDATOR_REWARDS,
  SUBNET_ID, WARP_PRECOMPILE, DELEGATION_FEE_BIPS, MIN_STAKE_DURATION,
  loadState, saveState, sleep, fetchNodeIdentity, nodeIDToBytes, pAddr20FromPriv,
  buildAckMessage, buildJustification, extractInnerRegisterMsg, packWarpPredicate,
  aggregateViaNode, aggregateAck, findInitiateForNode, setup, pchainBalanceNano, isOnPChain, PCHAIN_KEY,
  vmStatus, isResumableRegistration,
} from './lib.mjs';

const { parseEther, formatEther } = ethers;
const REG_IFACE = new Interface([
  'event InitiatedValidatorRegistration(bytes32 indexed validationID, bytes20 indexed nodeID, bytes32 registrationMessageID, uint64 registrationExpiry, uint64 weight)',
  'event SendWarpMessage(address indexed sender, bytes32 indexed messageID, bytes message)',
  'function initiateValidatorRegistration(bytes nodeID, bytes blsPublicKey, (uint32 threshold, address[] addresses) remainingBalanceOwner, (uint32 threshold, address[] addresses) disableOwner, uint16 delegationFeeBips, uint64 minStakeDuration, uint256 stakeAmount, address rewardRecipient) returns (bytes32)',
]);

const { provider, owner, pvmapi, ctx, pk, pAddr, pBytes } = await setup();
const id = await fetchNodeIdentity();
const nodeBytes = nodeIDToBytes(id.nodeID);
let st = loadState();

console.log('Node:      ', id.nodeID);
console.log('EVM wallet:', owner.address, '(holds ZEUS + pays L1 gas)');
console.log('P-Chain:   ', pAddr, '(holds AVAX + gets it back on unstake)');
console.log('');

// ===== STEP A: approve 1 ZEUS + initiateValidatorRegistration =====
// CHAIN = SOURCE OF TRUTH. A saved validationID (or an initiate log found on-chain) is only worth
// resuming if the ValidatorManager still reports it as PendingAdded/Active. A REMOVED validator
// (Completed/Invalidated) leaves its initiate log behind forever — resuming it would burn ~19min of
// futile RegisterL1ValidatorTx retries. So: verify status first, and fall through to a FRESH initiate
// if it's dead. This is what makes "register again after removing" actually work.
if (st.validationID && !isResumableRegistration(await vmStatus(provider, st.validationID))) {
  console.log('↺ saved registration is finished/removed on-chain — ignoring it and registering fresh.');
  st = {}; saveState(st);
}
if (!st.validationID) {
  const existing = await findInitiateForNode(nodeBytes);
  if (existing?.validationID && isResumableRegistration(await vmStatus(provider, existing.validationID))) {
    console.log('↺ this node already has a LIVE initiate on-chain (1 ZEUS already locked) — resuming:', existing.validationID);
    st = { ...st, validationID: existing.validationID, warpMsg: existing.warpMsg, step: 'initiated' }; saveState(st);
  } else {
    if (existing?.validationID) console.log('↺ found an old removed/expired initiate on-chain — ignoring it, registering fresh.');
    const zeusRO = new Contract(ZEUS_ADDR, ['function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)'], provider);
    const bal = await zeusRO.balanceOf(owner.address);
    console.log('ZEUS balance:', formatEther(bal));
    if (bal < parseEther('1')) throw new Error('Need at least 1 ZEUS in the EVM wallet to register.');
    const zeus = new Contract(ZEUS_ADDR, ['function approve(address,uint256) returns (bool)'], owner);
    if ((await zeusRO.allowance(owner.address, STAKING_MANAGER)) < parseEther('1')) {
      console.log('→ approving 1 ZEUS to the StakingManager…'); const a = await zeus.approve(STAKING_MANAGER, parseEther('1')); await a.wait(); console.log('  approve tx:', a.hash);
    } else console.log('  allowance already sufficient');
    const ownerTuple = { threshold: 1, addresses: [pAddr20FromPriv(PCHAIN_KEY)] }; // AVAX refund goes here
    const sm = new Contract(STAKING_MANAGER, REG_IFACE, owner);
    console.log('→ initiateValidatorRegistration (locks 1 ZEUS)…');
    const tx = await sm.initiateValidatorRegistration(nodeBytes, id.blsPub, ownerTuple, ownerTuple, DELEGATION_FEE_BIPS, MIN_STAKE_DURATION, parseEther('1'), owner.address);
    const rc = await tx.wait(); console.log('  initiate tx:', rc.hash);
    let validationID = '', warpMsg = '';
    for (const lg of rc.logs) { try { const p = REG_IFACE.parseLog({ topics: lg.topics, data: lg.data }); if (p?.name === 'InitiatedValidatorRegistration') validationID = p.args.validationID; if (p?.name === 'SendWarpMessage' && lg.address.toLowerCase() === WARP_PRECOMPILE) warpMsg = p.args.message; } catch { /* */ } }
    if (!validationID || !warpMsg) throw new Error('no validationID/warpMsg in the initiate receipt');
    st = { validationID, warpMsg, step: 'initiated', nodeID: id.nodeID }; saveState(st);
    console.log('✅ STEP A done | validationID:', validationID);
  }
}
console.log('');

// ===== STEP B: aggregate + RegisterL1ValidatorTx on the P-Chain (retry through the settle lag) =====
if (!(await isOnPChain(pvmapi, st.validationID))) {
  const balNano = await pchainBalanceNano(pAddr);
  const balance = balNano - 50000000n; // leave 0.05 AVAX for the tx fee
  console.log('P-Chain AVAX:', Number(balNano) / 1e9, '→ validator balance:', Number(balance) / 1e9);
  if (balance <= 0n) throw new Error(`Not enough AVAX on ${pAddr}. Fund it with test AVAX first (see README).`);

  console.log('→ STEP B: registering on the P-Chain…');
  let done = false;
  for (let attempt = 1; attempt <= 25 && !done; attempt++) {
    // Aggregate via the SIGAGG service — NOT the node's warp_getMessageAggregateSignature.
    // The self-hosted infra node's built-in warp aggregator HANGS (never returns) when it
    // is not part of the validator set, so it can't collect the L1 signatures. The sigagg
    // is a dedicated aggregator that reaches the L1 validators directly (fast + reliable,
    // same service the ack step uses). Keep it INSIDE the retry so a transient sigagg/settle
    // error retries instead of aborting the whole run.
    try {
      const signed = await aggregateAck(st.warpMsg); // sigagg, sem justification (msg de registro on-chain)
      const feeState = await pvmapi.getFeeState();
      const { utxos } = await pvmapi.getUTXOs({ addresses: [pAddr] });
      const tx = ax.pvm.newRegisterL1ValidatorTx({ balance, blsSignature: ax.utils.hexToBuffer(id.blsPop.replace(/^0x/, '')), message: ax.utils.hexToBuffer(signed.replace(/^0x/, '')), feeState, fromAddressesBytes: [pBytes], utxos }, ctx);
      await ax.addTxSignatures({ unsignedTx: tx, privateKeys: [pk] });
      const resp = await pvmapi.issueSignedTx(tx.getSignedTx());
      console.log('  RegisterL1ValidatorTx:', resp.txID || JSON.stringify(resp));
      for (let i = 0; i < 40 && !done; i++) { await sleep(3000); if (await isOnPChain(pvmapi, st.validationID)) done = true; else process.stdout.write('.'); }
      console.log(done ? '\n✅ STEP B done — validator on the P-Chain' : '\n  not visible yet, retrying…');
    } catch (e) {
      const msg = e?.message || String(e);
      if (/insufficient|warp agg|canonical|p-?chain height|validator set|aggregat|empty result/i.test(msg)) {
        console.log(`  (attempt ${attempt}) P-Chain/warp still settling — waiting 45s and retrying… (${msg.slice(0, 140)})`);
        await sleep(45000);
      } else throw e;
    }
  }
  if (!done) throw new Error('STEP B did not confirm after retries — run register.mjs again in a few minutes.');
  st.step = 'pchain'; saveState(st);
} else { console.log('↺ already on the P-Chain — skipping STEP B'); st.step = 'pchain'; saveState(st); }
console.log('');

// ===== STEP C: ack + completeValidatorRegistration (retry through the observe lag) =====
const vm = new Contract(VALIDATOR_MANAGER, ['function getValidator(bytes32) view returns (tuple(uint8 status, bytes nodeID, uint64 sw, uint64 sn, uint64 rn, uint64 weight))'], provider);
let status = 0; try { status = Number((await vm.getValidator(st.validationID)).status); } catch { /* */ }
if (status !== 2) {
  console.log('→ STEP C: activating (completeValidatorRegistration)…');
  const sm = new Contract(STAKING_MANAGER, ['function completeValidatorRegistration(uint32 messageIndex) returns (bytes32)'], owner);
  const justification = buildJustification(extractInnerRegisterMsg(st.warpMsg));
  let active = false;
  for (let attempt = 1; attempt <= 25 && !active; attempt++) {
    try {
      const signedAck = await aggregateAck(buildAckMessage(st.validationID, true), justification);
      const accessList = [{ address: WARP_PRECOMPILE, storageKeys: packWarpPredicate(signedAck) }];
      const tx = await sm.completeValidatorRegistration(0, { accessList, gasLimit: 1000000n, type: 2 });
      await tx.wait();
      active = true;
    } catch (e) {
      const msg = e?.shortMessage || e?.reason || e?.message || String(e);
      if (/revert|insufficient|aggregat/i.test(msg)) {
        console.log(`  (attempt ${attempt}) L1 hasn't observed the registration yet — waiting 45s and retrying…`);
        await sleep(45000);
      } else throw e;
    }
  }
  if (!active) throw new Error('STEP C did not activate after retries — run register.mjs again in a few minutes.');
  console.log('✅ STEP C done — validator ACTIVE');
  st.step = 'active'; saveState(st);
} else { console.log('↺ already ACTIVE'); st.step = 'active'; saveState(st); }

// ===== join the reward rotation (best-effort) =====
try {
  const vr = new Contract(VALIDATOR_REWARDS, ['function join(bytes32 validationID)', 'function payoutOf(bytes32) view returns (address)'], owner);
  if ((await vr.payoutOf(st.validationID)) === '0x0000000000000000000000000000000000000000') {
    console.log('→ joining the reward rotation…'); const j = await vr.join(st.validationID); await j.wait(); console.log('  join tx:', j.hash);
  }
} catch (e) { console.log('  (rotation join is best-effort:', (e.shortMessage || e.message) + ')'); }

console.log('\n🎉 DONE — your validator is registered and active. validationID:', st.validationID);
console.log('To leave later and get your 1 ZEUS + AVAX back:  node unstake.mjs');
