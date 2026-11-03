import { ethers } from "ethers";
import dotenv from "dotenv";

dotenv.config();

const ARBITRUM_RPC_URL = process.env.ARBITRUM_RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;

if (!ARBITRUM_RPC_URL || !PRIVATE_KEY || !CONTRACT_ADDRESS) {
  console.error("FATAL: Missing required environment variables in process.env:");
  if (!ARBITRUM_RPC_URL) console.error(" - ARBITRUM_RPC_URL is missing");
  if (!PRIVATE_KEY) console.error(" - PRIVATE_KEY is missing");
  if (!CONTRACT_ADDRESS) console.error(" - CONTRACT_ADDRESS is missing");
  process.exit(1);
}

const WETH = "0x82aF49447D8a07e3bd95BD0d56f352415231Cl11";
const ARB = "0x912CE59144191C1204E64559FE8253a0e49E6548";
const UNISWAP_V3_QUOTER = "0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6";
const SUSHISWAP_ROUTER = "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506";

const normalizeAddress = (addr) => (ethers.isAddress(addr) ? addr : addr.replace(/l/g, "6"));
const WETH_ADDR = normalizeAddress(WETH);
const ARB_ADDR = normalizeAddress(ARB);
const QUOTER_ADDR = normalizeAddress(UNISWAP_V3_QUOTER);
const SUSHISWAP_ADDR = normalizeAddress(SUSHISWAP_ROUTER);
const ARBITRAGE_ADDR = normalizeAddress(CONTRACT_ADDRESS);

const UNISWAP_V3_QUOTER_ABI = [
  "function quoteExactInputSingle(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint160 sqrtPriceLimitX96) external returns (uint256 amountOut)",
];

const SUSHISWAP_ROUTER_ABI = [
  "function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory amounts)",
];

const ARBITRAGE_CONTRACT_ABI = [
  "function executeFlashLoan() external",
];

const UNISWAP_V3_POOL_FEE = 500;
const LOAN_AMOUNT = ethers.parseEther("10");
const MIN_RETURN_THRESHOLD = ethers.parseEther("10.005");

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
} catch (initError) {
  console.error("Initialization failure:", initError.message || initError);
  process.exit(1);
}

let isProcessing = false;

async function checkArbitrageOpportunity(blockNumber) {
  if (isProcessing) return;
  isProcessing = true;

  try {
    const arbAmountOut = await quoterContract.quoteExactInputSingle.staticCall(
      WETH_ADDR,
      ARB_ADDR,
      UNISWAP_V3_POOL_FEE,
      LOAN_AMOUNT,
      0
    );

    const sushiAmountsOut = await sushiRouterContract.getAmountsOut(
      arbAmountOut,
      [ARB_ADDR, WETH_ADDR]
    );

    const wethAmountBack = sushiAmountsOut[1];
    const formattedArb = ethers.formatUnits(arbAmountOut, 18);
    const formattedWethReturn = ethers.formatEther(wethAmountBack);
    const rawProfit = ethers.formatEther(wethAmountBack - LOAN_AMOUNT);

    console.log(
      `[Block #${blockNumber}] Input: 10 WETH -> UniV3: ${Number(formattedArb).toFixed(4)} ARB -> SushiV2: ${Number(formattedWethReturn).toFixed(6)} WETH | Net Diff: ${rawProfit} WETH`
    );

    if (wethAmountBack > MIN_RETURN_THRESHOLD) {
      const grossProfit = wethAmountBack - LOAN_AMOUNT;
      const netProfit = wethAmountBack - MIN_RETURN_THRESHOLD;

      console.log("\n========================================================");
      console.log("⚡ [PROFITABLE ARBITRAGE DETECTED] ⚡");
      console.log(`Block Number:              #${blockNumber}`);
      console.log(`Loan Principal:            10.0 WETH`);
      console.log(`Uniswap V3 Expected ARB:   ${formattedArb} ARB`);
      console.log(`SushiSwap V2 Return WETH:  ${formattedWethReturn} WETH`);
      console.log(`Threshold Required:        ${ethers.formatEther(MIN_RETURN_THRESHOLD)} WETH`);
      console.log(`Estimated Gross Profit:    +${ethers.formatEther(grossProfit)} WETH`);
      console.log(`Estimated Net Spread:      +${ethers.formatEther(netProfit)} WETH`);
      console.log("Dispatching executeFlashLoan() to arbitrage contract...");

      try {
        const tx = await arbitrageContract.executeFlashLoan();
        console.log(`Transaction submitted! Hash: ${tx.hash}`);
        const receipt = await tx.wait();
        console.log(`Transaction confirmed in block #${receipt.blockNumber} (Gas Used: ${receipt.gasUsed.toString()})`);
      } catch (txError) {
        console.error("Execution failed during executeFlashLoan():", txError.message || txError);
      }
      console.log("========================================================\n");
    }
  } catch (rpcError) {
    console.warn(
      `[Block #${blockNumber}] Network frame issue or quote reverted:`,
      rpcError.shortMessage || rpcError.message || rpcError
    );
  } finally {
    isProcessing = false;
  }
}

async function main() {
  console.log("========================================================");
  console.log("🚀 Arbitrum WETH/ARB Flash Loan MEV Tracker Initialized");
  console.log(`Signer Address:       ${wallet.address}`);
  console.log(`Arbitrage Contract:   ${ARBITRAGE_ADDR}`);
  console.log(`Uniswap V3 Quoter:    ${QUOTER_ADDR}`);
  console.log(`SushiSwap Router:     ${SUSHISWAP_ADDR}`);
  console.log(`Loan Amount:          ${ethers.formatEther(LOAN_AMOUNT)} WETH`);
  console.log(`Profit Threshold:     ${ethers.formatEther(MIN_RETURN_THRESHOLD)} WETH`);
  console.log("========================================================");

  try {
    const latestBlock = await provider.getBlockNumber();
    console.log(`Connected to Arbitrum One. Latest Block: #${latestBlock}`);
    await checkArbitrageOpportunity(latestBlock);
  } catch (connectionError) {
    console.warn("Initial block query notice:", connectionError.message || connectionError);
  }

  provider.on("block", async (blockNumber) => {
    await checkArbitrageOpportunity(blockNumber);
  });

  process.on("SIGINT", () => {
    console.log("\nTerminating tracker daemon...");
    provider.removeAllListeners();
    process.exit(0);
  });
}

main().catch((fatalError) => {
  console.error("Fatal exception in tracker process:", fatalError);
});
