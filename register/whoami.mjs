// Show your addresses, this node's identity and balances — so you know where to
// send the 1 ZEUS (EVM) and the test AVAX (P-Chain) before registering.
//
//   node whoami.mjs
//
import { ethers, Contract, ZEUS_ADDR, setup, fetchNodeIdentity, pchainBalanceNano } from './lib.mjs';
const { formatEther } = ethers;

const { provider, owner, pAddr } = await setup();
console.log('EVM wallet (send 1 ZEUS + a little ZCR for gas here):');
console.log('  ', owner.address);
console.log('P-Chain address (send test AVAX here):');
console.log('  ', pAddr);

try {
  const zeus = new Contract(ZEUS_ADDR, ['function balanceOf(address) view returns (uint256)'], provider);
  console.log('\nBalances:');
  console.log('  ZEUS (EVM):   ', formatEther(await zeus.balanceOf(owner.address)));
  console.log('  ZCR  (EVM gas):', formatEther(await provider.getBalance(owner.address)));
  console.log('  AVAX (P-Chain):', Number(await pchainBalanceNano(pAddr)) / 1e9);
} catch (e) { console.log('  (could not read balances:', e.message + ')'); }

try {
  const id = await fetchNodeIdentity();
  console.log('\nThis node:');
  console.log('  NodeID:', id.nodeID);
  console.log('  (register.mjs reads the BLS key from the node automatically)');
} catch (e) { console.log('\nNode identity: NOT reachable —', e.message); }
