// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

/**
 * @dev Minimal ERC20 interface for token approvals and transfers
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
 * @notice Executes atomic arbitrage between Uniswap V3 and SushiSwap V2 on Arbitrum One using Aave V3 flash loans.
 */
contract ArbitrageFlashLoan is IFlashLoanSimpleReceiver {
    address public immutable owner;

    // Arbitrum One Canonical Mainnet Addresses
    address public constant WETH = 0x82aF49447D8A07E3bD95Bd0d56f352415231c611;
    address public constant ARB = 0x912CE59144191C1204E64559FE8253a0e49E6548;
    
    // Aave V3 Pool on Arbitrum One
    address public constant AAVE_POOL = 0x794a61358D6845594F94dc1DB02A252b5b4814aD;

    // Uniswap V3 SwapRouter on Arbitrum One
    address public constant UNISWAP_V3_ROUTER = 0xE592427A0AEce92De3Edee1F18E0157C05861564;

    // SushiSwap V2 Router on Arbitrum One
    address public constant SUSHISWAP_ROUTER = 0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506;

    uint24 public constant POOL_FEE = 500; // 0.05% Uniswap V3 pool fee tier
    uint256 public constant LOAN_AMOUNT = 10 ether; // 10 WETH
    uint256 public constant MIN_RETURN_REQUIRED = 10.005 ether; // Covers 10 WETH loan + 0.09% fee + gas buffer

    event ArbitrageExecuted(
        uint256 indexed loanAmount,
        uint256 arbReceived,
        uint256 wethReturned,
        uint256 profit
    );

    event EmergencyWithdrawal(address indexed token, uint256 amount);

    modifier onlyOwner() {
        require(msg.sender == owner, "Only owner can execute");
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    /**
     * @notice Entrypoint invoked by tracker.js via the signer wallet.
     * Initiates the 10 WETH flash loan from Aave V3.
     */
    function executeFlashLoan() external onlyOwner {
        IPool(AAVE_POOL).flashLoanSimple(
            address(this),
            WETH,
            LOAN_AMOUNT,
            "",
            0
        );
    }

    /**
     * @notice Callback invoked by Aave V3 Pool after transferring 10 WETH to this contract.
     * @param asset The borrowed asset (WETH)
     * @param amount The borrowed amount (10 WETH)
     * @param premium The protocol fee (0.009 WETH)
     * @param initiator The address that initiated the flash loan
     * @param params Additional calldata (unused)
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

        // Total amount required to repay Aave (10.0 WETH + 0.009 WETH)
        uint256 totalRepayment = amount + premium;

        // -------------------------------------------------------------
        // Step 1: Swap 10 WETH -> ARB on Uniswap V3 (500 bps fee tier)
        // -------------------------------------------------------------
        IERC20(WETH).approve(UNISWAP_V3_ROUTER, amount);

        ISwapRouter.ExactInputSingleParams memory uniParams = ISwapRouter.ExactInputSingleParams({
            tokenIn: WETH,
            tokenOut: ARB,
            fee: POOL_FEE,
            recipient: address(this),
            deadline: block.timestamp,
            amountIn: amount,
            amountOutMinimum: 0, // Controlled by final WETH return assertion below
            sqrtPriceLimitX96: 0
        });

        uint256 arbReceived = ISwapRouter(UNISWAP_V3_ROUTER).exactInputSingle(uniParams);
        require(arbReceived > 0, "Uniswap V3 swap returned 0 ARB");

        // -------------------------------------------------------------
        // Step 2: Swap ARB -> WETH on SushiSwap V2
        // -------------------------------------------------------------
        IERC20(ARB).approve(SUSHISWAP_ROUTER, arbReceived);

        address[] memory path = new address[](2);
        path[0] = ARB;
        path[1] = WETH;

        uint256[] memory amountsOut = IUniswapV2Router(SUSHISWAP_ROUTER).swapExactTokensForTokens(
            arbReceived,
            totalRepayment, // Guarantees we receive at least enough to repay the loan
            path,
            address(this),
            block.timestamp
        );

        uint256 wethReturned = amountsOut[1];

        // -------------------------------------------------------------
        // Step 3: Strict Profitability Validation
        // -------------------------------------------------------------
        require(wethReturned >= MIN_RETURN_REQUIRED, "Return below 10.005 WETH threshold");
        require(wethReturned > totalRepayment, "Trade is not profitable");

        // -------------------------------------------------------------
        // Step 4: Approve Aave Pool for repayment
        // -------------------------------------------------------------
        IERC20(WETH).approve(AAVE_POOL, totalRepayment);

        // -------------------------------------------------------------
        // Step 5: Transfer net profit to contract owner
        // -------------------------------------------------------------
        uint256 profit = wethReturned - totalRepayment;
        IERC20(WETH).transfer(owner, profit);

        emit ArbitrageExecuted(amount, arbReceived, wethReturned, profit);

        return true;
    }

    /**
     * @notice Emergency withdrawal for any stuck tokens in the contract.
     * @param token Address of the ERC20 token to withdraw
     */
    function emergencyWithdraw(address token) external onlyOwner {
        uint256 balance = IERC20(token).balanceOf(address(this));
        require(balance > 0, "No balance to withdraw");
        IERC20(token).transfer(owner, balance);
        emit EmergencyWithdrawal(token, balance);
    }

    /**
     * @notice Emergency withdrawal for native ETH.
     */
    function emergencyWithdrawETH() external onlyOwner {
        uint256 balance = address(this).balance;
        require(balance > 0, "No ETH to withdraw");
        (bool success, ) = owner.call{value: balance}("");
        require(success, "ETH transfer failed");
    }

    receive() external payable {}
}
