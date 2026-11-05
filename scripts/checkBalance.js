// scripts/checkBalance.js
import { ethers } from "ethers";

// Load dotenv dynamically only in Node.js environments (prevents browser/Remix bundler crashes on 'child_process')
if (typeof process !== "undefined" && process?.versions?.node) {
  try {
    const dotenv = await import("dotenv");
    dotenv.default?.config?.();
  } catch (_) {}
}

const RPC_URL = (typeof process !== "undefined" && process.env?.ARBITRUM_RPC_URL) || "https://arb1.arbitrum.io/rpc";
const PRIVATE_KEY = typeof process !== "undefined" ? process.env?.PRIVATE_KEY : null;

async function checkDeployerBalance() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);

  let rawAddress;
  if (PRIVATE_KEY && PRIVATE_KEY !== "0x0000000000000000000000000000000000000000000000000000000000000000") {
    const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
    rawAddress = wallet.address;
  } else {
    rawAddress = process.argv[2] || "0x71c6136b3454b677a281878b301077759fe1c693";
  }

  const address = ethers.getAddress(rawAddress.toLowerCase());

  console.log("=========================================");
  console.log(`Checking Arbitrum One Balance for: ${address}`);
  console.log("=========================================");

  try {
    const balanceWei = await provider.getBalance(address);
    const balanceEth = ethers.formatEther(balanceWei);

    console.log(`Current Balance: ${balanceEth} ETH`);

    // Minimum required to deploy contract (~0.0002 ETH on Arbitrum)
    const minRequired = ethers.parseEther("0.0002");

    if (balanceWei >= minRequired) {
      console.log("✅ STATUS: READY TO DEPLOY!");
      console.log("You have sufficient ETH to deploy ArbitrageFlashLoan.sol on Arbitrum.");
    } else {
      console.log("❌ STATUS: INSUFFICIENT ETH FOR GAS");
      console.log(`You need at least ~0.0005 - 0.002 ETH (~$1.50 - $5.00 USD) on Arbitrum One to deploy.`);
    }
  } catch (error) {
    console.error("RPC Error querying balance:", error.message || error);
  }
}

checkDeployerBalance();
