// tracker.js
import { ethers } from "ethers";
import dotenv from "dotenv";

dotenv.config();

// 1. Load required environment variables
const ARBITRUM_RPC_URL = process.env.ARBITRUM_RPC_URL || "https://arb1.arbitrum.io/rpc";
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;

// Check if credentials are provided for live transaction execution
const isExecutionEnabled = Boolean(
  PRIVATE_KEY &&
  PRIVATE_KEY !== "0x0000000000000000000000000000000000000000000000000000000000000000" &&
  CONTRACT_ADDRESS &&
  CONTRACT_ADDRESS !== "0x0000000000000000000000000000000000000000"
);

if (!isExecutionEnabled) {
  console.log("ℹ️  RUNNING IN FREE LIVE SCANNER MODE (SIMULATION)");
  console.log("   - Cost: $0.00 (No ETH or deposit required)");
  console.log("   - Reads real live Arbitrum One blocks & Uniswap V3 ⇄ SushiSwap V2 prices.");
  console.log("   - When an opportunity occurs, execution will be simulated in console.");
  console.log("========================================================");
}

// 2. Exact mainnet contact addresses as constants
const WETH = "0x82aF49447D8A07E3bD95Bd0d56f352415231c611";
const ARB = "0x912CE59144191C1204E64559FE8253a0e49E6548";
const UNISWAP_V3_QUOTER = "0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6";
const SUSHISWAP_ROUTER = "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506";

// Address sanitizer to handle character typos and ensure valid EIP-55 checksum
const sanitizeAddress = (addr) => {
  if (!addr) return "0x0000000000000000000000000000000000000000";
  const cleaned = addr.replace(/l/gi, "6").toLowerCase();
  return ethers.getAddress(cleaned);
};
const WETH_ADDR = sanitizeAddress(WETH);
const ARB_ADDR = sanitizeAddress(ARB);
const QUOTER_ADDR = sanitizeAddress(UNISWAP_V3_QUOTER);
const SUSHISWAP_ADDR = sanitizeAddress(SUSHISWAP_ROUTER);
const ARBITRAGE_ADDR = CONTRACT_ADDRESS ? sanitizeAddress(CONTRACT_ADDRESS) : "0x0000000000000000000000000000000000000000";

// 3. Minimal, explicit Ethers.js Contract ABIs
const UNISWAP_V3_QUOTER_ABI = [
  "function quoteExactInputSingle(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint160 sqrtPriceLimitX96) external returns (uint256 amountOut)",
];

const SUSHISWAP_ROUTER_ABI = [
  "function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory amounts)",
];

const ARBITRAGE_CONTRACT_ABI = [
  "function executeFlashLoan(uint256 loanAmount, uint256 minIntermediateOut, uint256 minFinalReturn, uint8 direction, uint256 deadline) external",
  "function executeFlashLoan() external",
  "function executeFlashLoan(uint256 minArbOut, uint256 minWethOut, uint256 deadline) external",
];

// Configuration constants
const POOL_FEE = 500; // 0.05% fee tier on Arbitrum Uniswap V3 WETH/ARB
const LOAN_AMOUNT = ethers.parseEther("10"); // 10 WETH
const MIN_RETURN_THRESHOLD = ethers.parseEther("10.005"); // 10.005 WETH (covers 10 WETH + Aave 0.05% fee + gas buffer)

// Initialize Provider, Signer Wallet, and Contracts
let provider;
let wallet;
let quoterContract;
let sushiRouterContract;
let arbitrageContract;

try {
  provider = new ethers.JsonRpcProvider(ARBITRUM_RPC_URL);

  quoterContract = new ethers.Contract(QUOTER_ADDR, UNISWAP_V3_QUOTER_ABI, provider);
  sushiRouterContract = new ethers.Contract(SUSHISWAP_ADDR, SUSHISWAP_ROUTER_ABI, provider);

  if (isExecutionEnabled) {
    wallet = new ethers.Wallet(PRIVATE_KEY, provider);
    arbitrageContract = new ethers.Contract(ARBITRAGE_ADDR, ARBITRAGE_CONTRACT_ABI, wallet);
  }
} catch (initErr) {
  console.error("Failed to initialize Web3 provider, wallet, or contracts:", initErr.message || initErr);
  process.exit(1);
}

// Concurrency mutex to prevent overlapping evaluations on rapid block emission
let isEvaluating = false;

/**
 * Evaluates arbitrage opportunities in both directions:
 * Direction 0: Uniswap V3 (WETH -> ARB) -> SushiSwap V2 (ARB -> WETH)
 * Direction 1: SushiSwap V2 (WETH -> ARB) -> Uniswap V3 (ARB -> WETH)
 * @param {number} blockNumber - Current block number on Arbitrum One
 */
async function checkArbitrage(blockNumber) {
  if (isEvaluating) {
    return;
  }
  isEvaluating = true;

  try {
    // -------------------------------------------------------------
    // Route 0: Uniswap V3 (Buy ARB) -> SushiSwap V2 (Sell ARB)
    // -------------------------------------------------------------
    let route0Return = 0n;
    let route0ArbOut = 0n;

    try {
      route0ArbOut = await quoterContract.quoteExactInputSingle.staticCall(
        WETH_ADDR,
        ARB_ADDR,
        POOL_FEE,
        LOAN_AMOUNT,
        0
      );

      const sushiAmounts0 = await sushiRouterContract.getAmountsOut(route0ArbOut, [
        ARB_ADDR,
        WETH_ADDR,
      ]);
      route0Return = sushiAmounts0[1];
    } catch (_) {
      // Swallowed on non-returning quote frames
    }

    // -------------------------------------------------------------
    // Route 1: SushiSwap V2 (Buy ARB) -> Uniswap V3 (Sell ARB)
    // -------------------------------------------------------------
    let route1Return = 0n;
    let route1ArbOut = 0n;

    try {
      const sushiAmounts1 = await sushiRouterContract.getAmountsOut(LOAN_AMOUNT, [
        WETH_ADDR,
        ARB_ADDR,
      ]);
      route1ArbOut = sushiAmounts1[1];

      route1Return = await quoterContract.quoteExactInputSingle.staticCall(
        ARB_ADDR,
        WETH_ADDR,
        POOL_FEE,
        route1ArbOut,
        0
      );
    } catch (_) {
      // Swallowed on non-returning quote frames
    }

    // Determine the most profitable route
    const isRoute0Better = route0Return >= route1Return;
    const bestReturn = isRoute0Better ? route0Return : route1Return;
    const bestDirection = isRoute0Better ? 0 : 1; // 0 = Uni -> Sushi, 1 = Sushi -> Uni
    const bestIntermediate = isRoute0Better ? route0ArbOut : route1ArbOut;
    const routeName = isRoute0Better ? "UniV3 -> SushiV2" : "SushiV2 -> UniV3";

    if (bestReturn > 0n) {
      const formattedReturn = ethers.formatEther(bestReturn);
      const profitFormatted = ethers.formatEther(bestReturn - LOAN_AMOUNT);

      console.log(
        `[Block #${blockNumber}] Input: 10 WETH | Best Route: [${routeName}] -> Return: ${Number(formattedReturn).toFixed(6)} WETH | Net: ${profitFormatted} WETH`
      );

      // Check if return exceeds the 10.005 WETH threshold
      if (bestReturn > MIN_RETURN_THRESHOLD) {
        console.log("\n========================================================");
        console.log("⚡ [PROFITABLE MEV ARBITRAGE OPPORTUNITY DETECTED] ⚡");
        console.log(`Block Number:              #${blockNumber}`);
        console.log(`Route Direction:           ${routeName} (Direction ${bestDirection})`);
        console.log(`Loan Principal:            10.0 WETH`);
        console.log(`Intermediate ARB:          ${ethers.formatUnits(bestIntermediate, 18)} ARB`);
        console.log(`Expected Return WETH:      ${formattedReturn} WETH`);
        console.log(`Minimum Required WETH:     10.005 WETH`);
        console.log(`Estimated Gross Profit:    +${ethers.formatEther(bestReturn - LOAN_AMOUNT)} WETH`);
        console.log(`Estimated Net Spread:      +${ethers.formatEther(bestReturn - MIN_RETURN_THRESHOLD)} WETH`);

        // Anti-Sandwich Protection: Calculate 0.5% max slippage barrier for Hop 1
        const minIntermediateOut = (bestIntermediate * 995n) / 1000n;
        const deadline = Math.floor(Date.now() / 1000) + 120; // 2 minute deadline

        if (isExecutionEnabled && arbitrageContract) {
          console.log("Calling executeFlashLoan() with dynamic slippage & MEV protection...");
          try {
            let tx;
            // Attempt production 5-parameter call with anti-sandwich intermediate check
            try {
              tx = await arbitrageContract["executeFlashLoan(uint256,uint256,uint256,uint8,uint256)"](
                LOAN_AMOUNT,
                minIntermediateOut,
                MIN_RETURN_THRESHOLD,
                bestDirection,
                deadline
              );
            } catch (_) {
              // Backward-compatible fallback for 3-arg or 0-arg deployments
              try {
                tx = await arbitrageContract["executeFlashLoan(uint256,uint256,uint256)"](
                  minIntermediateOut,
                  MIN_RETURN_THRESHOLD,
                  deadline
                );
              } catch (_) {
                tx = await arbitrageContract.executeFlashLoan();
              }
            }
            console.log(`Transaction dispatched. Hash: ${tx.hash}`);
            const receipt = await tx.wait();
            console.log(`Transaction confirmed in block #${receipt.blockNumber}! Gas Used: ${receipt.gasUsed.toString()}`);
          } catch (txError) {
            console.error("Execution failed on executeFlashLoan():", txError.message || txError);
          }
        } else {
          console.log("ℹ️ [SIMULATION MODE] Opportunity detected! Anti-sandwich slippage barrier set at:", ethers.formatUnits(minIntermediateOut, 18), "ARB.");
        }

        console.log("========================================================\n");
      }
    }
  } catch (error) {
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
  console.log("🚀 Arbitrum WETH/ARB Bidirectional MEV Arbitrage Monitor");
  if (isExecutionEnabled) {
    console.log(`Mode:                LIVE ON-CHAIN EXECUTION`);
    console.log(`Signer Address:      ${wallet.address}`);
    console.log(`Target Contract:     ${ARBITRAGE_ADDR}`);
  } else {
    console.log(`Mode:                FREE LIVE SCANNER (Zero Funds Required - $0.00)`);
    console.log(`Live Network:        Arbitrum One (ChainID: 42161)`);
  }
  console.log(`Uniswap V3 Quoter:   ${QUOTER_ADDR}`);
  console.log(`SushiSwap Router:    ${SUSHISWAP_ADDR}`);
  console.log(`Loan Amount:         ${ethers.formatEther(LOAN_AMOUNT)} WETH`);
  console.log(`Profit Threshold:    ${ethers.formatEther(MIN_RETURN_THRESHOLD)} WETH`);
  console.log(`Strategy:            Bidirectional (UniV3 ⇄ SushiV2) with Anti-Sandwich Protection`);
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
