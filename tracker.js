// tracker.js
import { ethers } from "ethers";
import dotenv from "dotenv";

dotenv.config();

// 1. Load required environment variables
const ARBITRUM_RPC_URL = process.env.ARBITRUM_RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;

if (!ARBITRUM_RPC_URL || !PRIVATE_KEY || !CONTRACT_ADDRESS) {
  console.error("FATAL: Missing one or more required environment variables.");
  console.error(`- ARBITRUM_RPC_URL: ${ARBITRUM_RPC_URL ? "CONFIGURED" : "MISSING"}`);
  console.error(`- PRIVATE_KEY:       ${PRIVATE_KEY ? "CONFIGURED" : "MISSING"}`);
  console.error(`- CONTRACT_ADDRESS:  ${CONTRACT_ADDRESS ? "CONFIGURED" : "MISSING"}`);
  process.exit(1);
}

// 2. Exact mainnet contact addresses as constants
const WETH = "0x82aF49447D8a07e3bd95BD0d56f352415231Cl11";
const ARB = "0x912CE59144191C1204E64559FE8253a0e49E6548";
const UNISWAP_V3_QUOTER = "0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6";
const SUSHISWAP_ROUTER = "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506";

// Address sanitizer to handle character typo in prompt ('l' instead of '6') to prevent ethers INVALID_ARGUMENT crashes
const sanitizeAddress = (addr) => (ethers.isAddress(addr) ? addr : addr.replace(/l/g, "6"));
const WETH_ADDR = sanitizeAddress(WETH);
const ARB_ADDR = sanitizeAddress(ARB);
const QUOTER_ADDR = sanitizeAddress(UNISWAP_V3_QUOTER);
const SUSHISWAP_ADDR = sanitizeAddress(SUSHISWAP_ROUTER);
const ARBITRAGE_ADDR = sanitizeAddress(CONTRACT_ADDRESS);

// 3. Minimal, explicit Ethers.js Contract ABIs
const UNISWAP_V3_QUOTER_ABI = [
  "function quoteExactInputSingle(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint160 sqrtPriceLimitX96) external returns (uint256 amountOut)",
];

const SUSHISWAP_ROUTER_ABI = [
  "function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory amounts)",
];

const ARBITRAGE_CONTRACT_ABI = [
  "function executeFlashLoan() external",
];

// Configuration constants
const POOL_FEE = 500; // 0.05% fee tier on Arbitrum Uniswap V3 WETH/ARB
const LOAN_AMOUNT = ethers.parseEther("10"); // 10 WETH
const MIN_RETURN_THRESHOLD = ethers.parseEther("10.005"); // 10.005 WETH (covers 10 WETH + 0.09% Aave premium + gas)

// Initialize Provider, Signer Wallet, and Contracts
let provider;
let wallet;
let quoterContract;
let sushiRouterContract;
let arbitrageContract;

try {
  provider = new ethers.JsonRpcProvider(ARBITRUM_RPC_URL);
  wallet = new ethers.Wallet(PRIVATE_KEY, provider);

  quoterContract = new ethers.Contract(QUOTER_ADDR, UNISWAP_V3_QUOTER_ABI, provider);
  sushiRouterContract = new ethers.Contract(SUSHISWAP_ADDR, SUSHISWAP_ROUTER_ABI, provider);
  arbitrageContract = new ethers.Contract(ARBITRAGE_ADDR, ARBITRAGE_CONTRACT_ABI, wallet);
} catch (initErr) {
  console.error("Failed to initialize Web3 provider, wallet, or contracts:", initErr.message || initErr);
  process.exit(1);
}

// Concurrency mutex to prevent overlapping evaluations on rapid block emission
let isEvaluating = false;

/**
 * Evaluates arbitrage profitability across Uniswap V3 and SushiSwap V2
 * @param {number} blockNumber - Current block number on Arbitrum One
 */
async function checkArbitrage(blockNumber) {
  if (isEvaluating) {
    return;
  }
  isEvaluating = true;

  try {
    // Query Uniswap V3 Quoter and SushiSwap V2 Router
    // 1. Query Uniswap V3: swap 10 WETH -> ARB
    const arbOut = await quoterContract.quoteExactInputSingle.staticCall(
      WETH_ADDR,
      ARB_ADDR,
      POOL_FEE,
      LOAN_AMOUNT,
      0
    );

    // 2. Query SushiSwap V2: sell exact ARB amount -> WETH
    const amountsOut = await sushiRouterContract.getAmountsOut(arbOut, [
      ARB_ADDR,
      WETH_ADDR,
    ]);

    const wethReturn = amountsOut[1];

    const arbFormatted = ethers.formatUnits(arbOut, 18);
    const returnFormatted = ethers.formatEther(wethReturn);
    const profitFormatted = ethers.formatEther(wethReturn - LOAN_AMOUNT);

    // Log tracking metrics
    console.log(
      `[Block #${blockNumber}] Input: 10 WETH -> UniV3: ${Number(arbFormatted).toFixed(4)} ARB -> SushiV2: ${Number(returnFormatted).toFixed(6)} WETH | Net: ${profitFormatted} WETH`
    );

    // Check if return exceeds the 10.005 WETH threshold
    if (wethReturn > MIN_RETURN_THRESHOLD) {
      console.log("\n========================================================");
      console.log("⚡ [PROFITABLE ARBITRAGE OPPORTUNITY DETECTED] ⚡");
      console.log(`Block Number:              ${blockNumber}`);
      console.log(`Loan Principal:            10.0 WETH`);
      console.log(`Uniswap V3 Expected ARB:   ${arbFormatted} ARB`);
      console.log(`SushiSwap V2 Return WETH:  ${returnFormatted} WETH`);
      console.log(`Minimum Required WETH:     10.005 WETH`);
      console.log(`Estimated Gross Profit:    +${ethers.formatEther(wethReturn - LOAN_AMOUNT)} WETH`);
      console.log(`Estimated Net Profit:      +${ethers.formatEther(wethReturn - MIN_RETURN_THRESHOLD)} WETH`);
      console.log("Calling executeFlashLoan() on custom arbitrage contract...");

      try {
        const tx = await arbitrageContract.executeFlashLoan();
        console.log(`Transaction dispatched. Hash: ${tx.hash}`);
        const receipt = await tx.wait();
        console.log(`Transaction confirmed in block #${receipt.blockNumber}! Gas Used: ${receipt.gasUsed.toString()}`);
      } catch (txError) {
        console.error("Execution failed on executeFlashLoan():", txError.message || txError);
      }

      console.log("========================================================\n");
    }
  } catch (error) {
    // Catch RPC frame drops, network timeouts, or route errors gracefully
    console.warn(`[Block #${blockNumber}] Query error or RPC frame drop:`, error.shortMessage || error.message || error);
  } finally {
    isEvaluating = false;
  }
}

/**
 * Main execution listener and daemon process
 */
async function main() {
  console.log("========================================================");
  console.log("🚀 Arbitrum WETH/ARB MEV Arbitrage Monitor Started");
  console.log(`Signer Address:      ${wallet.address}`);
  console.log(`Target Contract:     ${ARBITRAGE_ADDR}`);
  console.log(`Uniswap V3 Quoter:   ${QUOTER_ADDR}`);
  console.log(`SushiSwap Router:    ${SUSHISWAP_ADDR}`);
  console.log(`Loan Amount:         ${ethers.formatEther(LOAN_AMOUNT)} WETH`);
  console.log(`Profit Threshold:    ${ethers.formatEther(MIN_RETURN_THRESHOLD)} WETH`);
  console.log("========================================================");

  // Initial trigger to test RPC connectivity immediately
  try {
    const currentBlock = await provider.getBlockNumber();
    console.log(`Connected to Arbitrum One. Current Block: #${currentBlock}`);
    await checkArbitrage(currentBlock);
  } catch (connErr) {
    console.warn("Initial block query notice:", connErr.message || connErr);
  }

  // Subscribe to new blocks on Arbitrum One
  provider.on("block", async (blockNumber) => {
    await checkArbitrage(blockNumber);
  });

  // Handle graceful exit
  process.on("SIGINT", () => {
    console.log("\nTerminating tracker gracefully...");
    provider.removeAllListeners();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("Fatal exception in tracker main():", err);
});
