// Leave the ZCore validator set — MANUAL, no dashboard.
// Removes this node from the L1, returns your 1 ZEUS to the EVM wallet and refunds
// the validator's AVAX to your P-Chain address. Reversible: run register.mjs to rejoin.
//
//   node unstake.mjs
//
import {
  ethers, ax, Contract, sha256,
  ZEUS_ADDR, STAKING_MANAGER, VALIDATOR_MANAGER, SUBNET_ID, WARP_PRECOMPILE,
  loadState, saveState, sleep, fetchNodeIdentity, nodeIDToBytes,
  buildAckMessage, buildJustification, extractInnerRegisterMsg, packWarpPredicate,
  aggregateViaNode, aggregateAck, findInitiateForNode, setup, pchainBalanceNano, isOnPChain,
} from './lib.mjs';

const { formatEther } = ethers;

const { provider, owner, pvmapi, ctx, pk, pAddr, pBytes } = await setup();

// Recover validationID + warpMsg: from the local state file, else by scanning the chain for this node.
let st = loadState();
if (!st.validationID || !st.warpMsg) {
  const id = await fetchNodeIdentity();
  const found = await findInitiateForNode(nodeIDToBytes(id.nodeID));
  if (!found?.validationID) throw new Error('No registration found for this node — nothing to unstake.');
  st = { ...st, validationID: found.validationID, warpMsg: found.warpMsg };
  saveState(st);
}
const vidCb58 = ax.Id.fromHex(st.validationID.replace(/^0x/, '')).toString();

const zeusRO = new Contract(ZEUS_ADDR, ['function balanceOf(address) view returns (uint256)'], provider);
const sm = new Contract(STAKING_MANAGER, [
  'function forceInitiateValidatorRemoval(bytes32,bool,uint32)',
  'function completeValidatorRemoval(uint32) returns (bytes32)',
  'event SendWarpMessage(address indexed sender, bytes32 indexed messageID, bytes message)',
], owner);

console.log('validationID:', st.validationID);
const zeusBefore = await zeusRO.balanceOf(owner.address);
const avaxBefore = await pchainBalanceNano(pAddr);
console.log('BEFORE — ZEUS(EVM):', formatEther(zeusBefore), '| AVAX(P-Chain):', Number(avaxBefore) / 1e9);
console.log('');

// ===== 1) forceInitiateValidatorRemoval → 2) aggregate → 3) SetL1ValidatorWeightTx(0) on the P-Chain =====
if (await isOnPChain(pvmapi, st.validationID)) {
  // Active (2) -> forceInitiateValidatorRemoval. PendingRemoved (3, unstake que travou no passo 2) -> resend:
  // o forceInitiate REVERTE num validador ja PendingRemoved; resendValidatorRemovalMessage (publico) re-emite
  // a MESMA msg de peso 0 pra retomar (o AVAX segue preso no validador ate o SetL1ValidatorWeightTx completar).
  const vm = new Contract(VALIDATOR_MANAGER, ['function getValidator(bytes32) view returns (tuple(uint8 status, bytes nodeID, uint64 sw, uint64 sn, uint64 rn, uint64 weight))', 'function resendValidatorRemovalMessage(bytes32)'], owner);
  let vstatus = 2; try { vstatus = Number((await vm.getValidator(st.validationID)).status); } catch { /* rede fora: segue normal */ }
  console.log(vstatus === 3 ? '→ 1) resendValidatorRemovalMessage (retomando unstake travado)…' : '→ 1) forceInitiateValidatorRemoval…');
  const rc = vstatus === 3
    ? await (await vm.resendValidatorRemovalMessage(st.validationID)).wait()
    : await (await sm.forceInitiateValidatorRemoval(st.validationID, false, 0)).wait();
  console.log('  tx:', rc.hash);
  let wmsg = '';
  for (const lg of rc.logs) { try { const p = sm.interface.parseLog({ topics: lg.topics, data: lg.data }); if (p?.name === 'SendWarpMessage' && lg.address.toLowerCase() === WARP_PRECOMPILE) wmsg = p.args.message; } catch { /* */ } }
  if (!wmsg) throw new Error('no SendWarpMessage in the removal receipt');

  // 2) aggregate + 3) SetL1ValidatorWeightTx — retry through transient sigagg/settle errors.
  // Aggregate via the SIGAGG service, NOT the node's warp API (which hangs on this infra
  // node — same reason as register.mjs STEP B).
  let gone = false;
  for (let attempt = 1; attempt <= 25 && !gone; attempt++) {
    if (!(await isOnPChain(pvmapi, st.validationID))) { gone = true; break; } // a prior attempt may have settled late
    try {
      console.log('→ 2) aggregating (sigagg)…');
      const signed = await aggregateAck(wmsg); // sigagg, sem justification (msg de remoção on-chain)
      console.log('→ 3) SetL1ValidatorWeightTx (weight 0) on the P-Chain — removes the validator + refunds AVAX…');
      const feeState = await pvmapi.getFeeState();
      const { utxos } = await pvmapi.getUTXOs({ addresses: [pAddr] });
      const setTx = ax.pvm.newSetL1ValidatorWeightTx({ message: ax.utils.hexToBuffer(signed.replace(/^0x/, '')), feeState, fromAddressesBytes: [pBytes], utxos }, ctx);
      await ax.addTxSignatures({ unsignedTx: setTx, privateKeys: [pk] });
      const resp = await pvmapi.issueSignedTx(setTx.getSignedTx());
      console.log('  tx:', resp.txID || JSON.stringify(resp));
      for (let i = 0; i < 40 && !gone; i++) { await sleep(3000); if (!(await isOnPChain(pvmapi, st.validationID))) gone = true; else process.stdout.write('.'); }
      console.log(gone ? '\n  ✅ removed from the P-Chain (AVAX refunded to your P-Chain address)' : '\n  still on the P-Chain, retrying…');
    } catch (e) {
      const msg = e?.message || String(e);
      if (/insufficient|warp agg|canonical|p-?chain height|validator set|aggregat|empty result/i.test(msg)) {
        console.log(`  (attempt ${attempt}) P-Chain/warp still settling — waiting 45s and retrying… (${msg.slice(0, 140)})`);
        await sleep(45000);
      } else throw e;
    }
  }
  if (!gone) console.log('  still on the P-Chain after retries — re-run unstake.mjs in a few minutes to finish.');
} else console.log('↺ already off the P-Chain — skipping steps 1-3');
console.log('');

// ===== 4) ack(registered=false) → 5) completeValidatorRemoval (unlocks the 1 ZEUS), retry through the settle lag =====
console.log('→ 4/5) completeValidatorRemoval (unlocks your 1 ZEUS)…');
const justification = buildJustification(extractInnerRegisterMsg(st.warpMsg));
let done = false;
for (let attempt = 1; attempt <= 25 && !done; attempt++) {
  try {
    const signedAck = await aggregateAck(buildAckMessage(st.validationID, false), justification);
    const accessList = [{ address: WARP_PRECOMPILE, storageKeys: packWarpPredicate(signedAck) }];
    await (await sm.completeValidatorRemoval(0, { accessList, gasLimit: 1500000n, type: 2 })).wait();
    done = true;
  } catch (e) {
    const msg = e?.shortMessage || e?.reason || e?.message || String(e);
    if (/revert|insufficient|aggregat/i.test(msg)) {
      console.log(`  (attempt ${attempt}) P-Chain still settling — waiting 45s and retrying…`);
      await sleep(45000);
    } else throw e;
  }
}
if (!done) throw new Error('completeValidatorRemoval did not settle after retries — run unstake.mjs again in a few minutes.');

await sleep(2000);
const zeusAfter = await zeusRO.balanceOf(owner.address);
const avaxAfter = await pchainBalanceNano(pAddr);
console.log('\nAFTER  — ZEUS(EVM):', formatEther(zeusAfter), `(+${formatEther(zeusAfter - zeusBefore)})`, '| AVAX(P-Chain):', Number(avaxAfter) / 1e9, `(+${Number(avaxAfter - avaxBefore) / 1e9})`);
st.step = 'removed'; saveState(st);
console.log('\n🎉 DONE — validator removed. Your 1 ZEUS is back in the EVM wallet and the AVAX is on your P-Chain address.');
console.log('Rejoin anytime (no churn/weight wait):  node register.mjs');
