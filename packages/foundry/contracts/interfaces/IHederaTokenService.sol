// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice The subset of the Hedera Token Service system contract (0x167) used by this template.
/// @dev Struct layouts and signatures match the canonical IHederaTokenService so ABI encoding is identical.
///      Full interface: https://github.com/hashgraph/hedera-smart-contracts/tree/main/contracts/system-contracts
interface IHederaTokenService {
    struct Expiry {
        int64 second;
        address autoRenewAccount;
        int64 autoRenewPeriod;
    }

    struct KeyValue {
        bool inheritAccountKey;
        address contractId;
        bytes ed25519;
        bytes ECDSA_secp256k1;
        address delegatableContractId;
    }

    struct TokenKey {
        uint256 keyType;
        KeyValue key;
    }

    struct HederaToken {
        string name;
        string symbol;
        address treasury;
        string memo;
        bool tokenSupplyType;
        int64 maxSupply;
        bool freezeDefault;
        TokenKey[] tokenKeys;
        Expiry expiry;
    }

    function createFungibleToken(HederaToken memory token, int64 initialTotalSupply, int32 decimals)
        external
        payable
        returns (int64 responseCode, address tokenAddress);

    /// @notice Mints `amount` to the token treasury. Caller must satisfy the token's supply key.
    function mintToken(address token, int64 amount, bytes[] memory metadata)
        external
        returns (int64 responseCode, int64 newTotalSupply, int64[] memory serialNumbers);

    /// @notice Burns `amount` from the token treasury. Caller must satisfy the token's supply key.
    function burnToken(address token, int64 amount, int64[] memory serialNumbers)
        external
        returns (int64 responseCode, int64 newTotalSupply);

    /// @notice Moves `amount` from `sender` to `recipient`. The caller must be `sender`.
    function transferToken(address token, address sender, address recipient, int64 amount)
        external
        returns (int64 responseCode);

    /// @notice HIP-376 allowance-based transfer: moves `amount` from `from` using the caller's allowance.
    function transferFrom(address token, address from, address to, uint256 amount) external returns (int64 responseCode);
}
