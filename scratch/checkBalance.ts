import { ethers } from 'ethers';
const rpc = 'https://polygon-rpc.com';
const provider = new ethers.providers.JsonRpcProvider(rpc);
const pusdAddr = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const address = '0xc5a8111a7e0d9160c41096a13457d7f6348ec229';
const abi = ['function balanceOf(address) view returns (uint256)'];
const contract = new ethers.Contract(pusdAddr, abi, provider);
contract.balanceOf(address).then(b => {
    console.log('BAL:', ethers.utils.formatUnits(b, 6));
    process.exit(0);
}).catch(e => {
    console.error(e);
    process.exit(1);
});
