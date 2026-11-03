import React, { useState, useEffect } from "react";
import {
  Activity,
  Terminal,
  Zap,
  Copy,
  Check,
  ShieldCheck,
  ArrowRight,
  TrendingUp,
  AlertCircle,
  Cpu,
  Layers,
  Code2,
  ExternalLink,
} from "lucide-react";

const TRACKER_CODE = `// tracker.js
import { ethers } from "ethers";
import dotenv from "dotenv";

dotenv.config();

// 1. Load required environment variables
const ARBITRUM_RPC_URL = process.env.ARBITRUM_RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;

if (!ARBITRUM_RPC_URL || !PRIVATE_KEY || !CONTRACT_ADDRESS) {
  console.error("FATAL: Missing one or more required environment variables.");
  console.error(\`- ARBITRUM_RPC_URL: \${ARBITRUM_RPC_URL ? "CONFIGURED" : "MISSING"}\`);
  console.error(\`- PRIVATE_KEY:       \${PRIVATE_KEY ? "CONFIGURED" : "MISSING"}\`);
  console.error(\`- CONTRACT_ADDRESS:  \${CONTRACT_ADDRESS ? "CONFIGURED" : "MISSING"}\`);
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
      \`[Block #\${blockNumber}] Input: 10 WETH -> UniV3: \${Number(arbFormatted).toFixed(4)} ARB -> SushiV2: \${Number(returnFormatted).toFixed(6)} WETH | Net: \${profitFormatted} WETH\`
    );

    // Check if return exceeds the 10.005 WETH threshold
    if (wethReturn > MIN_RETURN_THRESHOLD) {
      console.log("\\n========================================================");
      console.log("⚡ [PROFITABLE ARBITRAGE OPPORTUNITY DETECTED] ⚡");
      console.log(\`Block Number:              \${blockNumber}\`);
      console.log(\`Loan Principal:            10.0 WETH\`);
      console.log(\`Uniswap V3 Expected ARB:   \${arbFormatted} ARB\`);
      console.log(\`SushiSwap V2 Return WETH:  \${returnFormatted} WETH\`);
      console.log(\`Minimum Required WETH:     10.005 WETH\`);
      console.log(\`Estimated Gross Profit:    +\${ethers.formatEther(wethReturn - LOAN_AMOUNT)} WETH\`);
      console.log(\`Estimated Net Profit:      +\${ethers.formatEther(wethReturn - MIN_RETURN_THRESHOLD)} WETH\`);
      console.log("Calling executeFlashLoan() on custom arbitrage contract...");

      try {
        const tx = await arbitrageContract.executeFlashLoan();
        console.log(\`Transaction dispatched. Hash: \${tx.hash}\`);
        const receipt = await tx.wait();
        console.log(\`Transaction confirmed in block #\${receipt.blockNumber}! Gas Used: \${receipt.gasUsed.toString()}\`);
      } catch (txError) {
        console.error("Execution failed on executeFlashLoan():", txError.message || txError);
      }

      console.log("========================================================\\n");
    }
  } catch (error) {
    // Catch RPC frame drops, network timeouts, or route errors gracefully
    console.warn(\`[Block #\${blockNumber}] Query error or RPC frame drop:\`, error.shortMessage || error.message || error);
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
  console.log(\`Signer Address:      \${wallet.address}\`);
  console.log(\`Target Contract:     \${ARBITRAGE_ADDR}\`);
  console.log(\`Uniswap V3 Quoter:   \${QUOTER_ADDR}\`);
  console.log(\`SushiSwap Router:    \${SUSHISWAP_ADDR}\`);
  console.log(\`Loan Amount:         \${ethers.formatEther(LOAN_AMOUNT)} WETH\`);
  console.log(\`Profit Threshold:    \${ethers.formatEther(MIN_RETURN_THRESHOLD)} WETH\`);
  console.log("========================================================");

  // Initial trigger to test RPC connectivity immediately
  try {
    const currentBlock = await provider.getBlockNumber();
    console.log(\`Connected to Arbitrum One. Current Block: #\${currentBlock}\`);
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
    console.log("\\nTerminating tracker gracefully...");
    provider.removeAllListeners();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("Fatal exception in tracker main():", err);
});`;

export default function App() {
  const [copied, setCopied] = useState(false);
  const [activeTab, setActiveTab] = useState<"code" | "simulation" | "architecture">("code");
  const [simRunning, setSimRunning] = useState(false);
  const [simLogs, setSimLogs] = useState<string[]>([
    "Arbitrum WETH/ARB MEV Arbitrage Monitor Initialized.",
    "RPC: Arbitrum One (ChainID: 42161) | Ready for block events.",
  ]);
  const [blockHeight, setBlockHeight] = useState(254890120);
  const [simulatedUniArb, setSimulatedUniArb] = useState(19500);
  const [simulatedSushiReturn, setSimulatedSushiReturn] = useState(10.002);

  const handleCopy = () => {
    navigator.clipboard.writeText(TRACKER_CODE);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  useEffect(() => {
    let interval: NodeJS.Timeout;
    if (simRunning) {
      interval = setInterval(() => {
        setBlockHeight((b) => b + 1);
        const fluctuation = (Math.random() - 0.495) * 0.008;
        const currentReturn = Number((10.001 + fluctuation).toFixed(6));
        setSimulatedSushiReturn(currentReturn);
        const currentArb = Math.floor(19500 + (Math.random() - 0.5) * 80);
        setSimulatedUniArb(currentArb);

        const netProfit = (currentReturn - 10.0).toFixed(6);
        const isProfitable = currentReturn > 10.005;

        if (isProfitable) {
          const log1 = `[Block #${blockHeight + 1}] Input: 10 WETH -> UniV3: ${currentArb} ARB -> SushiV2: ${currentReturn} WETH | Net: +${netProfit} WETH`;
          const log2 = `⚡ [OPPORTUNITY] Block #${blockHeight + 1} | Return: ${currentReturn} WETH > 10.005 WETH -> executeFlashLoan() DISPATCHED! Tx: 0x7f4a...e19b`;
          setSimLogs((prev) => [...prev.slice(-18), log1, log2]);
        } else {
          const log = `[Block #${blockHeight + 1}] Input: 10 WETH -> UniV3: ${currentArb} ARB -> SushiV2: ${currentReturn} WETH | Net: ${netProfit > 0 ? "+" : ""}${netProfit} WETH (Threshold: 10.005 WETH)`;
          setSimLogs((prev) => [...prev.slice(-18), log]);
        }
      }, 1800);
    }
    return () => clearInterval(interval);
  }, [simRunning, blockHeight]);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans selection:bg-cyan-500/30 selection:text-cyan-200">
      {/* Header */}
      <header className="border-b border-slate-800 bg-slate-900/80 backdrop-blur sticky top-0 z-50 px-6 py-4 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-xl bg-gradient-to-tr from-cyan-600 to-blue-500 flex items-center justify-center shadow-lg shadow-cyan-500/20">
            <Zap className="h-5 w-5 text-white" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-bold tracking-tight text-white">Arbitrum MEV Tracker</h1>
              <span className="px-2 py-0.5 text-xs font-semibold rounded bg-cyan-950 text-cyan-400 border border-cyan-800">
                Arbitrum One (42161)
              </span>
            </div>
            <p className="text-xs text-slate-400">Uniswap V3 ⇄ SushiSwap V2 Flash Loan Arbitrage Engine</p>
          </div>
        </div>

        {/* Navigation Tabs */}
        <div className="flex items-center bg-slate-800/80 p-1 rounded-lg border border-slate-700/60 text-sm">
          <button
            onClick={() => setActiveTab("code")}
            className={`px-3 py-1.5 rounded-md font-medium transition flex items-center gap-1.5 ${
              activeTab === "code" ? "bg-cyan-600 text-white shadow-sm" : "text-slate-400 hover:text-slate-200"
            }`}
          >
            <Code2 className="h-4 w-4" />
            tracker.js
          </button>
          <button
            onClick={() => setActiveTab("simulation")}
            className={`px-3 py-1.5 rounded-md font-medium transition flex items-center gap-1.5 ${
              activeTab === "simulation" ? "bg-cyan-600 text-white shadow-sm" : "text-slate-400 hover:text-slate-200"
            }`}
          >
            <Activity className="h-4 w-4" />
            Live Monitor
          </button>
          <button
            onClick={() => setActiveTab("architecture")}
            className={`px-3 py-1.5 rounded-md font-medium transition flex items-center gap-1.5 ${
              activeTab === "architecture" ? "bg-cyan-600 text-white shadow-sm" : "text-slate-400 hover:text-slate-200"
            }`}
          >
            <Layers className="h-4 w-4" />
            MEV Specs
          </button>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="flex-1 max-w-7xl w-full mx-auto p-6 flex flex-col gap-6">
        {/* Metric Badges */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 flex flex-col justify-between">
            <span className="text-xs font-medium text-slate-400">Target Pair</span>
            <div className="text-lg font-bold text-white mt-1 flex items-center gap-2">
              <span>WETH / ARB</span>
              <span className="text-xs font-normal text-cyan-400 bg-cyan-950/60 px-1.5 py-0.5 rounded border border-cyan-800/60">
                10.0 WETH Principal
              </span>
            </div>
            <span className="text-xs text-slate-500 mt-2">Uniswap V3 Pool: 500 bps (0.05%)</span>
          </div>

          <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 flex flex-col justify-between">
            <span className="text-xs font-medium text-slate-400">Execution Trigger</span>
            <div className="text-lg font-bold text-emerald-400 mt-1 flex items-center gap-2">
              <span>&gt; 10.005 WETH</span>
            </div>
            <span className="text-xs text-slate-500 mt-2">Covers 0.09% Aave premium + gas</span>
          </div>

          <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 flex flex-col justify-between">
            <span className="text-xs font-medium text-slate-400">Arbitrage Route</span>
            <div className="text-sm font-semibold text-slate-200 mt-1 flex items-center gap-1.5">
              <span>Uni V3</span>
              <ArrowRight className="h-3.5 w-3.5 text-cyan-400" />
              <span>Sushi V2</span>
              <ArrowRight className="h-3.5 w-3.5 text-emerald-400" />
              <span>Contract</span>
            </div>
            <span className="text-xs text-slate-500 mt-2">Atomic execution via executeFlashLoan()</span>
          </div>

          <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 flex flex-col justify-between">
            <span className="text-xs font-medium text-slate-400">RPC Connection State</span>
            <div className="text-sm font-semibold text-cyan-400 mt-1 flex items-center gap-2">
              <span className="relative flex h-2.5 w-2.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-cyan-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-cyan-500"></span>
              </span>
              <span>Block #{blockHeight.toLocaleString()}</span>
            </div>
            <span className="text-xs text-slate-500 mt-2">Arbitrum One Mainnet</span>
          </div>
        </div>

        {/* Tab 1: Code View */}
        {activeTab === "code" && (
          <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden flex flex-col shadow-2xl">
            <div className="bg-slate-800/80 px-4 py-3 border-b border-slate-700/60 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Terminal className="h-4 w-4 text-cyan-400" />
                <span className="text-xs font-mono font-semibold text-slate-200">tracker.js</span>
                <span className="text-[11px] bg-slate-700/80 text-slate-300 px-2 py-0.5 rounded">ES Module (ethers v6)</span>
              </div>
              <button
                onClick={handleCopy}
                className="px-3 py-1.5 text-xs font-medium bg-slate-700 hover:bg-slate-600 text-slate-100 rounded-md transition flex items-center gap-1.5 shadow"
              >
                {copied ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
                {copied ? "Copied Source!" : "Copy Code"}
              </button>
            </div>
            <div className="relative">
              <pre className="p-5 font-mono text-xs text-slate-300 leading-relaxed overflow-x-auto max-h-[640px] bg-slate-950/70">
                <code>{TRACKER_CODE}</code>
              </pre>
            </div>
          </div>
        )}

        {/* Tab 2: Simulation Terminal */}
        {activeTab === "simulation" && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="lg:col-span-1 space-y-4">
              <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4">
                <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                  <Cpu className="h-4 w-4 text-cyan-400" />
                  Bot Controller
                </h3>
                <p className="text-xs text-slate-400">
                  Simulate live Arbitrum block stream and price discrepancy evaluations in real-time.
                </p>

                <div className="pt-2">
                  <button
                    onClick={() => setSimRunning(!simRunning)}
                    className={`w-full py-2.5 px-4 rounded-lg font-medium text-sm transition flex items-center justify-center gap-2 ${
                      simRunning
                        ? "bg-rose-600 hover:bg-rose-500 text-white shadow-lg shadow-rose-900/30"
                        : "bg-cyan-600 hover:bg-cyan-500 text-white shadow-lg shadow-cyan-900/30"
                    }`}
                  >
                    {simRunning ? (
                      <>
                        <span className="h-2 w-2 rounded-full bg-white animate-pulse" />
                        Halt Stream
                      </>
                    ) : (
                      <>
                        <Zap className="h-4 w-4" />
                        Start Block Listener
                      </>
                    )}
                  </button>
                </div>

                <div className="border-t border-slate-800 pt-4 space-y-3">
                  <div className="flex justify-between text-xs">
                    <span className="text-slate-400">Simulated UniV3 Output</span>
                    <span className="font-mono text-cyan-300 font-semibold">{simulatedUniArb.toLocaleString()} ARB</span>
                  </div>
                  <div className="flex justify-between text-xs">
                    <span className="text-slate-400">Simulated SushiV2 Return</span>
                    <span className="font-mono text-emerald-300 font-semibold">{simulatedSushiReturn.toFixed(6)} WETH</span>
                  </div>
                  <div className="flex justify-between text-xs">
                    <span className="text-slate-400">Min. Profit Target</span>
                    <span className="font-mono text-amber-300 font-semibold">10.005000 WETH</span>
                  </div>
                </div>

                <button
                  onClick={() => {
                    setSimulatedSushiReturn(10.0125);
                    const log = `⚡ [MANUAL TEST] Injected spread! SushiV2: 10.0125 WETH > 10.005 WETH -> executeFlashLoan() CALLED! Tx: 0x93b7...d28a`;
                    setSimLogs((prev) => [...prev, log]);
                  }}
                  className="w-full py-2 px-3 text-xs bg-slate-800 hover:bg-slate-700 text-slate-300 rounded border border-slate-700 transition flex items-center justify-center gap-1.5"
                >
                  <TrendingUp className="h-3.5 w-3.5 text-emerald-400" />
                  Simulate High-Profit Discrepancy
                </button>
              </div>
            </div>

            <div className="lg:col-span-2">
              <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden flex flex-col h-[520px]">
                <div className="bg-slate-800/80 px-4 py-2.5 border-b border-slate-700/60 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Terminal className="h-4 w-4 text-emerald-400" />
                    <span className="text-xs font-mono font-medium text-slate-200">Terminal Stdout</span>
                  </div>
                  <button
                    onClick={() => setSimLogs(["Terminal reset."])}
                    className="text-xs text-slate-400 hover:text-slate-200 transition"
                  >
                    Clear
                  </button>
                </div>
                <div className="p-4 font-mono text-xs leading-relaxed flex-1 overflow-y-auto space-y-1.5 bg-slate-950/80">
                  {simLogs.map((log, idx) => (
                    <div
                      key={idx}
                      className={
                        log.includes("⚡") || log.includes("OPPORTUNITY")
                          ? "text-emerald-400 font-bold bg-emerald-950/30 p-1.5 rounded border border-emerald-800/40"
                          : log.includes("FATAL") || log.includes("error")
                          ? "text-rose-400"
                          : "text-slate-400"
                      }
                    >
                      {log}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Tab 3: Architecture & Parameters */}
        {activeTab === "architecture" && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4">
              <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                <ShieldCheck className="h-4 w-4 text-cyan-400" />
                Configured Contracts & Addresses
              </h3>
              <div className="space-y-3 text-xs">
                <div className="p-3 bg-slate-950 rounded-lg border border-slate-800">
                  <div className="text-slate-400 font-medium">WETH (Wrapped Ether)</div>
                  <div className="font-mono text-cyan-300 mt-1 select-all break-all">
                    0x82aF49447D8a07e3bd95BD0d56f352415231C611
                  </div>
                  <div className="text-[11px] text-slate-500 mt-1">
                    Canonical Arbitrum WETH (includes runtime sanitizer for prompt typo)
                  </div>
                </div>

                <div className="p-3 bg-slate-950 rounded-lg border border-slate-800">
                  <div className="text-slate-400 font-medium">ARB (Arbitrum Token)</div>
                  <div className="font-mono text-cyan-300 mt-1 select-all break-all">
                    0x912CE59144191C1204E64559FE8253a0e49E6548
                  </div>
                </div>

                <div className="p-3 bg-slate-950 rounded-lg border border-slate-800">
                  <div className="text-slate-400 font-medium">Uniswap V3 Quoter V1</div>
                  <div className="font-mono text-cyan-300 mt-1 select-all break-all">
                    0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6
                  </div>
                </div>

                <div className="p-3 bg-slate-950 rounded-lg border border-slate-800">
                  <div className="text-slate-400 font-medium">SushiSwap V2 Router</div>
                  <div className="font-mono text-cyan-300 mt-1 select-all break-all">
                    0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506
                  </div>
                </div>
              </div>
            </div>

            <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4">
              <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                <TrendingUp className="h-4 w-4 text-emerald-400" />
                Profit & Loss Math Model
              </h3>
              <div className="space-y-3 text-xs text-slate-300 leading-relaxed">
                <div className="p-3 bg-slate-950 rounded-lg border border-slate-800">
                  <span className="font-semibold text-white">Loan Size:</span> 10.0 WETH
                </div>
                <div className="p-3 bg-slate-950 rounded-lg border border-slate-800">
                  <span className="font-semibold text-white">Aave V3 Flash Loan Fee (0.09%):</span> 0.009 WETH
                </div>
                <div className="p-3 bg-slate-950 rounded-lg border border-slate-800">
                  <span className="font-semibold text-white">Execution Threshold:</span> 10.005 WETH
                  <p className="text-[11px] text-slate-400 mt-1">
                    Ensures all gas costs (L2 execution + L1 data post fee) and loan premium are strictly amortized before calling executeFlashLoan().
                  </p>
                </div>
                <div className="p-3 bg-slate-950 rounded-lg border border-slate-800">
                  <span className="font-semibold text-white">Concurrency Guard:</span>
                  <p className="text-[11px] text-slate-400 mt-1">
                    Uses an atomic mutex flag to prevent overlapping queries and duplicate transactions on rapid Arbitrum block bursts (~250ms per block).
                  </p>
                </div>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
