// scripts/addArbitrumToMetaMask.js
/**
 * EIP-3085 & EIP-3326 standard script to add and switch to Arbitrum One network in MetaMask.
 * Can be run in browser console or included in web interfaces.
 */

export const ARBITRUM_ONE_PARAMS = {
  chainId: "0xa4b1", // 42161 in hexadecimal
  chainName: "Arbitrum One",
  nativeCurrency: {
    name: "Ether",
    symbol: "ETH",
    decimals: 18,
  },
  rpcUrls: [
    "https://arb1.arbitrum.io/rpc",
    "https://arbitrum.llamarpc.com",
    "https://rpc.ankr.com/arbitrum"
  ],
  blockExplorerUrls: [
    "https://arbiscan.io/"
  ],
};

/**
 * Requests MetaMask to add Arbitrum One if not present, and switch to it.
 */
export async function setupArbitrumInMetaMask() {
  if (typeof window === "undefined" || !window.ethereum) {
    throw new Error("MetaMask is not installed. Please install it from https://metamask.io");
  }

  try {
    // Attempt to switch to Arbitrum One directly
    await window.ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: ARBITRUM_ONE_PARAMS.chainId }],
    });
    console.log("Successfully switched to Arbitrum One network in MetaMask.");
  } catch (switchError) {
    // Error 4902 indicates that the chain has not been added to MetaMask yet
    if (switchError.code === 4902) {
      try {
        await window.ethereum.request({
          method: "wallet_addEthereumChain",
          params: [ARBITRUM_ONE_PARAMS],
        });
        console.log("Successfully added and switched to Arbitrum One network in MetaMask.");
      } catch (addError) {
        console.error("User rejected adding Arbitrum One to MetaMask:", addError);
        throw addError;
      }
    } else {
      console.error("Failed to switch to Arbitrum One:", switchError);
      throw switchError;
    }
  }
}
