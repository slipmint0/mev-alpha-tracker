// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

/**
 * @dev Minimal ERC20 interface
 */
interface IERC20 {
    function totalSupply() external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function transfer(address recipient, uint256 amount) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function transferFrom(address sender, address recipient, uint256 amount) external returns (bool);
}

/**
 * @dev Aave V3 FlashLoanSimple receiver interface
 */
interface IFlashLoanSimpleReceiver {
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external returns (bool);
}

/**
 * @dev Aave V3 Pool contract interface
 */
interface IPool {
    function flashLoanSimple(
        address receiverAddress,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16 referralCode
    ) external;
}

/**
 * @dev Uniswap V3 SwapRouter interface
 */
interface ISwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

/**
 * @dev SushiSwap V2 Router interface
 */
interface IUniswapV2Router {
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);
}

/**
 * @title ArbitrageFlashLoan
 * @notice Production-hardened, bidirectional MEV arbitrage engine utilizing Aave V3 flash loans
 * across Uniswap V3 and SushiSwap V2 on Arbitrum One with dynamic parameterization,
 * strict multi-hop slippage enforcement, infinite upfront approvals, and deadline controls.
 */
contract ArbitrageFlashLoan is IFlashLoanSimpleReceiver {
    address public immutable owner;

    // Arbitrum One Canonical Mainnet Addresses (EIP-55 checksum compliant)
    address public constant WETH = 0x82aF49447D8A07E3bD95Bd0d56f352415231c611;
    address public constant ARB = 0x912CE59144191C1204E64559FE8253a0e49E6548;
    address public constant AAVE_POOL = 0x794a61358D6845594F94dc1DB02A252b5b4814aD;
    address public constant UNISWAP_V3_ROUTER = 0xE592427A0AEce92De3Edee1F18E0157C05861564;
    address public constant SUSHISWAP_ROUTER = 0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506;

    uint24 public constant UNISWAP_POOL_FEE = 500; // 0.05% fee tier

    enum Direction {
        UNISWAP_TO_SUSHISWAP, // 0: Borrow WETH -> UniV3 (ARB) -> SushiV2 (WETH)
        SUSHISWAP_TO_UNISWAP  // 1: Borrow WETH -> SushiV2 (ARB) -> UniV3 (WETH)
    }

    struct ArbitrageParams {
        uint256 loanAmount;         // Principal borrowed from Aave (e.g., 10 ether)
        uint256 minIntermediateOut; // Hop 1 slippage barrier (anti-sandwich protection)
        uint256 minFinalReturn;     // Hop 2 minimum final WETH return required
        Direction direction;        // Swap routing sequence
        uint256 deadline;           // Expiration timestamp to prevent stale execution
    }

    event ArbitrageExecuted(
        uint256 indexed loanAmount,
        uint8 indexed direction,
        uint256 intermediateReceived,
        uint256 finalWethReceived,
        uint256 netProfit
    );

    event EmergencyWithdrawal(address indexed token, uint256 amount);

    modifier onlyOwner() {
        require(msg.sender == owner, "Unauthorized: only owner");
        _;
    }

    constructor() {
        owner = msg.sender;

        // Upfront infinite approvals save ~25,000 - 45,000 gas per execution leg
        IERC20(WETH).approve(UNISWAP_V3_ROUTER, type(uint256).max);
        IERC20(WETH).approve(SUSHISWAP_ROUTER, type(uint256).max);
        IERC20(WETH).approve(AAVE_POOL, type(uint256).max);

        IERC20(ARB).approve(UNISWAP_V3_ROUTER, type(uint256).max);
        IERC20(ARB).approve(SUSHISWAP_ROUTER, type(uint256).max);
    }

    /**
     * @notice Primary execution entrypoint with dynamic parameters passed from off-chain tracker.
     */
    function executeFlashLoan(
        uint256 loanAmount,
        uint256 minIntermediateOut,
        uint256 minFinalReturn,
        uint8 direction,
        uint256 deadline
    ) external onlyOwner {
        require(block.timestamp <= deadline, "Transaction expired before execution");
        require(loanAmount > 0, "Loan amount must be > 0");

        bytes memory encodedParams = abi.encode(
            ArbitrageParams({
                loanAmount: loanAmount,
                minIntermediateOut: minIntermediateOut,
                minFinalReturn: minFinalReturn,
                direction: Direction(direction),
                deadline: deadline
            })
        );

        IPool(AAVE_POOL).flashLoanSimple(
            address(this),
            WETH,
            loanAmount,
            encodedParams,
            0
        );
    }

    /**
     * @notice Overloaded fallback entrypoint for simple 10 WETH UniV3 -> SushiV2 calls.
     */
    function executeFlashLoan() external onlyOwner {
        bytes memory encodedParams = abi.encode(
            ArbitrageParams({
                loanAmount: 10 ether,
                minIntermediateOut: 1, // Asserts non-zero receive; full execution protection in minFinalReturn
                minFinalReturn: 10.005 ether,
                direction: Direction.UNISWAP_TO_SUSHISWAP,
                deadline: block.timestamp + 120
            })
        );

        IPool(AAVE_POOL).flashLoanSimple(
            address(this),
            WETH,
            10 ether,
            encodedParams,
            0
        );
    }

    /**
     * @notice Aave V3 FlashLoan callback executed inside the uncollateralized lending transaction.
     */
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external override returns (bool) {
        require(msg.sender == AAVE_POOL, "Caller must be Aave Pool");
        require(initiator == address(this), "Initiator must be this contract");
        require(asset == WETH, "Asset must be WETH");

        ArbitrageParams memory arbParams = abi.decode(params, (ArbitrageParams));
        require(block.timestamp <= arbParams.deadline, "Deadline exceeded in callback");

        uint256 totalRepayment = amount + premium;
        uint256 intermediateReceived;
        uint256 finalWethReceived;

        if (arbParams.direction == Direction.UNISWAP_TO_SUSHISWAP) {
            // Leg 1: Uniswap V3 (WETH -> ARB) with strict anti-sandwich minIntermediateOut
            ISwapRouter.ExactInputSingleParams memory uniParams = ISwapRouter.ExactInputSingleParams({
                tokenIn: WETH,
                tokenOut: ARB,
                fee: UNISWAP_POOL_FEE,
                recipient: address(this),
                deadline: arbParams.deadline,
                amountIn: amount,
                amountOutMinimum: arbParams.minIntermediateOut,
                sqrtPriceLimitX96: 0
            });

            intermediateReceived = ISwapRouter(UNISWAP_V3_ROUTER).exactInputSingle(uniParams);

            // Leg 2: SushiSwap V2 (ARB -> WETH)
            address[] memory path = new address[](2);
            path[0] = ARB;
            path[1] = WETH;

            uint256[] memory sushiAmounts = IUniswapV2Router(SUSHISWAP_ROUTER).swapExactTokensForTokens(
                intermediateReceived,
                arbParams.minFinalReturn,
                path,
                address(this),
                arbParams.deadline
            );

            finalWethReceived = sushiAmounts[1];
        } else {
            // Leg 1: SushiSwap V2 (WETH -> ARB) with strict minIntermediateOut
            address[] memory path = new address[](2);
            path[0] = WETH;
            path[1] = ARB;

            uint256[] memory sushiAmounts = IUniswapV2Router(SUSHISWAP_ROUTER).swapExactTokensForTokens(
                amount,
                arbParams.minIntermediateOut,
                path,
                address(this),
                arbParams.deadline
            );

            intermediateReceived = sushiAmounts[1];

            // Leg 2: Uniswap V3 (ARB -> WETH) with strict minFinalReturn
            ISwapRouter.ExactInputSingleParams memory uniParams = ISwapRouter.ExactInputSingleParams({
                tokenIn: ARB,
                tokenOut: WETH,
                fee: UNISWAP_POOL_FEE,
                recipient: address(this),
                deadline: arbParams.deadline,
                amountIn: intermediateReceived,
                amountOutMinimum: arbParams.minFinalReturn,
                sqrtPriceLimitX96: 0
            });

            finalWethReceived = ISwapRouter(UNISWAP_V3_ROUTER).exactInputSingle(uniParams);
        }

        // Assert strictly profitable execution after loan repayment
        require(finalWethReceived >= arbParams.minFinalReturn, "Final return below requested threshold");
        require(finalWethReceived > totalRepayment, "Negative or zero net arbitrage profit");

        // Forward net profit to contract owner
        uint256 netProfit = finalWethReceived - totalRepayment;
        IERC20(WETH).transfer(owner, netProfit);

        emit ArbitrageExecuted(
            amount,
            uint8(arbParams.direction),
            intermediateReceived,
            finalWethReceived,
            netProfit
        );

        return true;
    }

    /**
     * @notice Emergency withdrawal for any ERC20 token held in the contract.
     */
    function emergencyWithdraw(address token) external onlyOwner {
        uint256 balance = IERC20(token).balanceOf(address(this));
        require(balance > 0, "No token balance");
        IERC20(token).transfer(owner, balance);
        emit EmergencyWithdrawal(token, balance);
    }

    /**
     * @notice Emergency withdrawal for native ETH.
     */
    function emergencyWithdrawETH() external onlyOwner {
        uint256 balance = address(this).balance;
        require(balance > 0, "No ETH balance");
        (bool success, ) = owner.call{value: balance}("");
        require(success, "ETH transfer failed");
    }

    receive() external payable {}
}
