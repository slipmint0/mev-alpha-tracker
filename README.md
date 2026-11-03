# Arbitrum MEV Flash Loan Arbitrage Tracker (WETH / ARB)

A production-grade, event-driven MEV arbitrage scanner and automated flash loan execution engine targeting the **WETH / ARB** token pair on **Arbitrum One (Chain ID: 42161)**. The tracker queries price discrepancies across **Uniswap V3** (0.05% concentrated liquidity) and **SushiSwap V2** (constant product AMM), triggering on-chain flash loan arbitrage execution via a custom smart contract when returns exceed profitability thresholds.

---

## ⚡ Overview & Arbitrage Strategy

Arbitrage arises when external trades or market shifts create a price imbalance between decentralized exchanges. Because Uniswap V3 uses concentrated liquidity and SushiSwap V2 uses constant product reserves ($x \cdot y = k$), their price slippage curves diverge under size.

### The Execution Loop:
1. **Borrow**: The custom smart contract draws an uncollateralized flash loan of **10.0 WETH** (e.g., from Aave V3 or Balancer).
2. **Hop 1 (Uniswap V3)**: Swap 10.0 WETH for ARB on Uniswap V3 (`fee = 500` / 0.05% tier).
3. **Hop 2 (SushiSwap V2)**: Sell the received ARB tokens for WETH on SushiSwap V2.
4. **Repay**: Return the 10.0 WETH principal plus the flash loan protocol premium (0.09% on Aave = 0.009 WETH).
5. **Profit**: The residual WETH surplus remains in the arbitrage contract or is forwarded directly to the operator's wallet.

```
                  ┌────────────────────────────────────────┐
                  │          Aave V3 Flash Loan            │
                  │           (Borrow 10 WETH)             │
                  └──────────────────┬─────────────────────┘
                                     │ 10 WETH
                                     ▼
                  ┌────────────────────────────────────────┐
                  │       Uniswap V3 Pool (500 bps)        │
                  │          Swap WETH ➔ ARB               │
                  └──────────────────┬─────────────────────┘
                                     │ Exact ARB Out
                                     ▼
                  ┌────────────────────────────────────────┐
                  │         SushiSwap V2 Router            │
                  │          Swap ARB ➔ WETH               │
                  └──────────────────┬─────────────────────┘
                                     │ WETH Return
                                     ▼
   ┌─────────────────────────────────────────────────────────────────────┐
   │ Check: Does Return > 10.005 WETH?                                    │
   │ - Repay 10.000 WETH Principal                                       │
   │ - Cover Aave 0.09% Fee (0.009 WETH) + Arbitrum Gas (~0.001-0.004 WETH)│
   │ - If Valid ➔ Call executeFlashLoan()                                 │
   └─────────────────────────────────────────────────────────────────────┘
```

---

## 📐 Mathematical Model & Thresholds

| Parameter | Value | Description |
|---|---|---|
| **Loan Principal ($L$)** | `10.0 WETH` | Base capital borrowed via flash loan. |
| **Aave V3 Fee ($F_{flash}$)** | `0.09%` (`0.009 WETH`) | Standard flash loan premium for uncollateralized borrowing. |
| **Trigger Threshold** | `> 10.005 WETH` | Minimum return required before dispatching on-chain transaction. |
| **Gross Profit ($\Pi_{gross}$)** | $R_{weth} - 10.0\text{ WETH}$ | Total return minus principal. |
| **Net Target ($\Pi_{net}$)** | $R_{weth} - 10.005\text{ WETH}$ | Net spread after amortizing premium and estimated Arbitrum L2 gas. |

---

## 📌 Configured Mainnet Addresses (Arbitrum One)

| Contract | Address | Purpose |
|---|---|---|
| **WETH** | `0x82aF49447D8a07e3bd95BD0d56f352415231C611` | Wrapped Ether ERC-20 on Arbitrum One |
| **ARB** | `0x912CE59144191C1204E64559FE8253a0e49E6548` | Arbitrum Governance Token ERC-20 |
| **Uniswap V3 Quoter** | `0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6` | Uniswap V1 Quoter contract for simulation |
| **SushiSwap Router** | `0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506` | SushiSwap V2 Router (`getAmountsOut`) |

*Note: The canonical checksum for Arbitrum WETH is `0x82aF49447D8a07e3bd95BD0d56f352415231C611`. `tracker.js` includes automated address normalization to prevent Ethers v6 argument validation errors while preserving strict constant compatibility.*

---

## 🛠️ Prerequisites & Installation

### Requirements
- **Node.js**: `v18.0.0` or higher (Node 20+ recommended).
- **npm** or **pnpm**.
- An active Arbitrum One RPC endpoint (Alchemy, Infura, QuickNode, or public RPC).
- A funded EVM wallet private key for gas fees on Arbitrum One.
- A deployed smart contract implementing `executeFlashLoan()`.

### 1. Install Dependencies
```bash
npm install
```

Required packages:
- `ethers`: `^6.13.0` (EVM provider, contract instances, and BigNumber math)
- `dotenv`: `^17.0.0` (Environment variable loading)

### 2. Configure Environment Variables
Create a `.env` file in the project root:

```env
# Arbitrum One RPC endpoint (HTTP or WebSocket)
ARBITRUM_RPC_URL="https://arb1.arbitrum.io/rpc"

# Wallet Private Key (Operator/Signer with ETH for Arbitrum L2 gas)
PRIVATE_KEY="0xYOUR_PRIVATE_KEY_HERE"

# Deployed Flash Loan Arbitrage Contract Address
CONTRACT_ADDRESS="0xYOUR_ARBITRAGE_CONTRACT_ADDRESS_HERE"
```

---

## 🚀 Running the Tracker

### Production Daemon
Run the tracker directly with Node.js (ES Module support is enabled):

```bash
node tracker.js
```

### Development UI & Visual Simulator
To view the live Web3 MEV dashboard, simulation terminal, and parameters:

```bash
npm run dev
```
Navigate to `http://localhost:3000` to inspect the visual terminal and interactive price spread calculator.

---

## 🔍 Code Walkthrough (`tracker.js`)

### 1. Uniswap V3 Static Call Simulation
The Uniswap V3 Quoter V1 contract executes quotes via a deliberately reverting pattern on-chain to save state gas. In Ethers v6, we execute this off-chain using `.staticCall(...)`:

```javascript
const arbAmountOut = await quoterContract.quoteExactInputSingle.staticCall(
  WETH_ADDR,
  ARB_ADDR,
  UNISWAP_V3_POOL_FEE,
  LOAN_AMOUNT,
  0
);
```

### 2. SushiSwap V2 Reserve Output Query
The exact token output from Uniswap V3 is piped directly into SushiSwap V2's router:

```javascript
const sushiAmountsOut = await sushiRouterContract.getAmountsOut(
  arbAmountOut,
  [ARB_ADDR, WETH_ADDR]
);
const wethAmountBack = sushiAmountsOut[1];
```

### 3. Concurrency Lock & RPC Shielding
Arbitrum One produces micro-blocks at roughly ~250ms intervals. To prevent call race conditions and nonce collisions, `tracker.js` implements an atomic mutex (`isProcessing = false`) and wraps all RPC queries in individual `try/catch` handlers to absorb dropped HTTP/WS frames.

---

## 🛡️ Production MEV Hardening & Best Practices

1. **Private Mempools / Builder RPCs**:
   - Public transactions on Arbitrum can be front-run or back-run by searchers monitoring the sequencer.
   - For high-value execution, route transactions through private endpoints or MEV protection relays.
2. **On-Chain Slippage Enforcement**:
   - Never rely exclusively on off-chain price checks. The smart contract's `executeFlashLoan()` must enforce `require(amountReceived >= minWethOut, "Slippage")` atomically.
3. **Gas Priority Fees**:
   - Arbitrum uses dynamic base fees plus small L2 priority tips. Ensure the transaction sets adequate `maxPriorityFeePerGas` during high congestion.
4. **Contract Reentrancy Protection**:
   - Ensure the flash loan receiver callback implements `ReentrancyGuard` and restricts calls strictly to the lending pool address.

---

## 📄 License
MIT License. For educational and research purposes in algorithmic decentralized finance and MEV systems.
