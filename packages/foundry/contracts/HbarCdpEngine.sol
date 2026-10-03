// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Ownable2Step } from "@openzeppelin/contracts/access/Ownable2Step.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { IHederaTokenService } from "./interfaces/IHederaTokenService.sol";
import { IPriceOracle } from "./interfaces/IPriceOracle.sol";

/// @title HbarCdpEngine
/// @notice Collateralised debt positions on Hedera: lock HBAR, mint a USD stablecoin issued on the
///         Hedera Token Service (HTS), repay to unlock, and liquidate unsafe vaults.
/// @dev Units (the most common Hedera pitfall, so every variable says which one it holds):
///      - HBAR inside the EVM is denominated in tinybars (1 HBAR = 1e8 tinybars). `msg.value`,
///        `address(this).balance` and every `collateral` value in this contract are tinybars.
///        JSON-RPC clients send value in weibars (1e18 per HBAR); the relay converts before execution.
///      - The stablecoin has 6 decimals ("stable units"). HTS amounts are int64 on the wire.
///      - Prices are USD per 1 HBAR with 18 decimals (`priceE18`).
///      HTS model: the engine creates the token, is its treasury and holds its only key (supply). There is no
///      admin key, so nobody can change the token config, and no freeze/wipe/KYC/pause keys exist.
///      Minting goes to the treasury and is transferred out; burning pulls into the treasury (HIP-376
///      allowance) and burns there.
contract HbarCdpEngine is Ownable2Step, ReentrancyGuard {
    // ----------------------------------------------------------------------------------------------------------
    // Constants
    // ----------------------------------------------------------------------------------------------------------

    address private constant HTS = address(0x167);
    int64 private constant HTS_SUCCESS = 22;
    int64 private constant HTS_TOKEN_NOT_ASSOCIATED_TO_ACCOUNT = 184;
    uint256 private constant HTS_SUPPLY_KEY = 16;
    /// @dev 90 days; HTS accepts 30 to ~92 days.
    int64 private constant TOKEN_AUTO_RENEW_PERIOD = 7_776_000;

    uint256 public constant BPS = 10_000;
    int32 public constant STABLECOIN_DECIMALS = 6;
    /// @dev Converts tinybars x priceE18 into stable units: 1e8 (tinybars/HBAR) * 1e18 (price) / 1e6 (stable).
    uint256 private constant VALUE_SCALE = 1e20;
    /// @dev VALUE_SCALE / BPS, used when a ratio in basis points is folded into the same division.
    uint256 private constant RATIO_SCALE = 1e16;
    uint256 private constant MAX_RATIO_BPS = 50_000;
    uint256 private constant MAX_BONUS_BPS = 2_500;

    // ----------------------------------------------------------------------------------------------------------
    // Types
    // ----------------------------------------------------------------------------------------------------------

    struct Vault {
        uint256 collateral; // tinybars
        uint256 debt; // stable units
    }

    /// @notice Everything a UI or keeper needs about a vault, computed at the current oracle price.
    /// @dev When the oracle is unusable, price-dependent fields are zero and `liquidatable` is false.
    struct VaultView {
        address owner;
        uint256 collateral; // tinybars
        uint256 debt; // stable units
        uint256 collateralValue; // stable units
        uint256 collateralRatioBps; // type(uint256).max when debt == 0
        uint256 maxMintable; // stable units
        uint256 maxWithdrawable; // tinybars
        bool liquidatable;
    }

    // ----------------------------------------------------------------------------------------------------------
    // Configuration
    // ----------------------------------------------------------------------------------------------------------

    IPriceOracle public immutable oracle;
    /// @notice Collateral ratio a vault must keep after minting or withdrawing.
    uint256 public immutable minCollateralRatioBps;
    /// @notice Below this collateral ratio a vault can be liquidated.
    uint256 public immutable liquidationRatioBps;
    /// @notice Extra collateral, on top of the repaid value, paid to the liquidator.
    uint256 public immutable liquidationBonusBps;
    /// @notice Smallest non-zero debt a vault may carry, so every position is worth liquidating.
    uint256 public immutable minDebt;

    // ----------------------------------------------------------------------------------------------------------
    // State
    // ----------------------------------------------------------------------------------------------------------

    /// @notice HTS stablecoin address (zero until `createStablecoin`).
    address public stablecoin;
    /// @notice Cap on `totalDebt`.
    uint256 public debtCeiling;
    /// @notice Emergency switch for new debt only. Repay, withdraw and liquidate stay open.
    bool public mintingPaused;

    uint256 public totalCollateral; // tinybars
    uint256 public totalDebt; // stable units

    mapping(address owner => Vault) private _vaults;
    address[] private _vaultOwners;
    mapping(address owner => bool) private _isVaultOwner;

    // ----------------------------------------------------------------------------------------------------------
    // Events & errors
    // ----------------------------------------------------------------------------------------------------------

    event StablecoinCreated(address indexed token, string name, string symbol);
    event Deposited(address indexed owner, uint256 amount);
    event Withdrawn(address indexed owner, uint256 amount);
    event Minted(address indexed owner, uint256 amount);
    event Repaid(address indexed owner, uint256 amount);
    event Liquidated(
        address indexed owner,
        address indexed liquidator,
        uint256 debtRepaid,
        uint256 collateralSeized,
        uint256 priceE18
    );
    /// @notice Emitted after every state change of a vault; the latest event per owner is its current state.
    event VaultUpdated(address indexed owner, uint256 collateral, uint256 debt);
    event DebtCeilingUpdated(uint256 debtCeiling);
    event MintingPausedUpdated(bool paused);
    event ExcessHbarSwept(address indexed to, uint256 amount);

    error InvalidConfig();
    error StablecoinAlreadyCreated();
    error StablecoinNotCreated();
    error ZeroAmount();
    error AmountTooLarge();
    error MintingPaused();
    error DebtCeilingExceeded(uint256 available);
    error DebtBelowMinimum(uint256 minDebt);
    error InsufficientCollateral(uint256 available);
    error ExceedsDebt(uint256 debt);
    error Undercollateralised(uint256 requiredCollateral);
    error NotLiquidatable();
    error OracleUnusable(IPriceOracle.Status status);
    error NotAssociated(address account);
    error HtsCallFailed(bytes4 selector, int64 responseCode);
    error HbarTransferFailed();

    // ----------------------------------------------------------------------------------------------------------
    // Setup
    // ----------------------------------------------------------------------------------------------------------

    constructor(
        address initialOwner,
        IPriceOracle oracle_,
        uint256 minCollateralRatioBps_,
        uint256 liquidationRatioBps_,
        uint256 liquidationBonusBps_,
        uint256 minDebt_,
        uint256 debtCeiling_
    ) Ownable(initialOwner) {
        if (address(oracle_) == address(0)) revert InvalidConfig();
        if (liquidationBonusBps_ > MAX_BONUS_BPS) revert InvalidConfig();
        // Liquidating a vault exactly at the threshold must leave it solvent: value > debt * (1 + bonus).
        if (liquidationRatioBps_ <= BPS + liquidationBonusBps_) revert InvalidConfig();
        if (minCollateralRatioBps_ < liquidationRatioBps_ || minCollateralRatioBps_ > MAX_RATIO_BPS) {
            revert InvalidConfig();
        }
        if (minDebt_ == 0) revert InvalidConfig();

        oracle = oracle_;
        minCollateralRatioBps = minCollateralRatioBps_;
        liquidationRatioBps = liquidationRatioBps_;
        liquidationBonusBps = liquidationBonusBps_;
        minDebt = minDebt_;
        debtCeiling = debtCeiling_;
    }

    /// @notice Creates the HTS stablecoin with this contract as treasury, supply key and auto-renew account.
    /// @dev `msg.value` pays the HTS token-creation fee (about 1 USD in HBAR; send extra, the unused part
    ///      stays in this contract and can be recovered with `sweepExcessHbar`).
    function createStablecoin(string calldata name, string calldata symbol, string calldata memo)
        external
        payable
        onlyOwner
        returns (address token)
    {
        if (stablecoin != address(0)) revert StablecoinAlreadyCreated();

        IHederaTokenService.TokenKey[] memory keys = new IHederaTokenService.TokenKey[](1);
        keys[0] = IHederaTokenService.TokenKey({
            keyType: HTS_SUPPLY_KEY,
            key: IHederaTokenService.KeyValue({
                inheritAccountKey: false,
                contractId: address(this),
                ed25519: "",
                ECDSA_secp256k1: "",
                delegatableContractId: address(0)
            })
        });

        IHederaTokenService.HederaToken memory config = IHederaTokenService.HederaToken({
            name: name,
            symbol: symbol,
            treasury: address(this),
            memo: memo,
            tokenSupplyType: false, // infinite: supply is bounded by debtCeiling instead
            maxSupply: 0,
            freezeDefault: false,
            tokenKeys: keys,
            expiry: IHederaTokenService.Expiry({
                second: 0, autoRenewAccount: address(this), autoRenewPeriod: TOKEN_AUTO_RENEW_PERIOD
            })
        });

        int64 responseCode;
        (responseCode, token) =
            IHederaTokenService(HTS).createFungibleToken{ value: msg.value }(config, 0, STABLECOIN_DECIMALS);
        if (responseCode != HTS_SUCCESS || token == address(0)) {
            revert HtsCallFailed(IHederaTokenService.createFungibleToken.selector, responseCode);
        }

        stablecoin = token;
        emit StablecoinCreated(token, name, symbol);
    }

    // ----------------------------------------------------------------------------------------------------------
    // Vault actions
    // ----------------------------------------------------------------------------------------------------------

    /// @notice Adds `msg.value` tinybars of collateral to the caller's vault.
    function deposit() external payable nonReentrant {
        _deposit(msg.sender, msg.value);
        _emitVaultUpdated(msg.sender);
    }

    /// @notice Deposits `msg.value` and mints `amount` stable units in one transaction.
    function depositAndMint(uint256 amount) external payable nonReentrant {
        _deposit(msg.sender, msg.value);
        _mint(msg.sender, amount);
        _emitVaultUpdated(msg.sender);
    }

    /// @notice Mints `amount` stable units against the caller's collateral.
    /// @dev The caller's account must be associated with the stablecoin (or have a free auto-association slot).
    function mint(uint256 amount) external nonReentrant {
        _mint(msg.sender, amount);
        _emitVaultUpdated(msg.sender);
    }

    /// @notice Burns `amount` stable units from the caller to reduce their debt.
    /// @dev Requires an allowance of at least `amount` for this contract on the stablecoin.
    function repay(uint256 amount) external nonReentrant {
        _repay(msg.sender, amount);
        _emitVaultUpdated(msg.sender);
    }

    /// @notice Withdraws `amount` tinybars of collateral to the caller.
    /// @dev A vault with no debt can always withdraw, even while the oracle is down.
    function withdraw(uint256 amount) external nonReentrant {
        _withdraw(msg.sender, amount);
        _emitVaultUpdated(msg.sender);
    }

    /// @notice Repays `repayAmount` then withdraws `withdrawAmount` in one transaction (either may be zero).
    function repayAndWithdraw(uint256 repayAmount, uint256 withdrawAmount) external nonReentrant {
        if (repayAmount == 0 && withdrawAmount == 0) revert ZeroAmount();
        if (repayAmount > 0) _repay(msg.sender, repayAmount);
        if (withdrawAmount > 0) _withdraw(msg.sender, withdrawAmount);
        _emitVaultUpdated(msg.sender);
    }

    /// @notice Repays up to the full debt of an unsafe vault and receives the equivalent collateral plus a bonus.
    /// @dev If the vault is so far underwater that the bonus cannot be paid, the liquidator receives all remaining
    ///      collateral. Any debt left after that is unbacked; production systems need a backstop (stability pool,
    ///      surplus buffer) for that case, which this template deliberately leaves out.
    /// @param owner Vault to liquidate.
    /// @param repayAmount Stable units the caller burns. The remaining debt must be zero or at least `minDebt`.
    function liquidate(address owner, uint256 repayAmount) external nonReentrant {
        if (repayAmount == 0) revert ZeroAmount();
        Vault storage vault = _vaults[owner];
        uint256 debt = vault.debt;
        if (repayAmount > debt) revert ExceedsDebt(debt);

        uint256 priceE18 = _usablePrice();
        if (!_isLiquidatable(vault.collateral, debt, priceE18)) revert NotLiquidatable();

        _checkMinDebt(debt - repayAmount);
        uint256 seized =
            Math.mulDiv(repayAmount * (BPS + liquidationBonusBps), VALUE_SCALE, priceE18 * BPS, Math.Rounding.Floor);
        if (seized > vault.collateral) seized = vault.collateral;

        vault.debt = debt - repayAmount;
        vault.collateral -= seized;
        totalDebt -= repayAmount;
        totalCollateral -= seized;

        _pullAndBurn(msg.sender, repayAmount);
        _sendHbar(msg.sender, seized);

        emit Liquidated(owner, msg.sender, repayAmount, seized, priceE18);
        _emitVaultUpdated(owner);
    }

    // ----------------------------------------------------------------------------------------------------------
    // Admin
    // ----------------------------------------------------------------------------------------------------------

    function setDebtCeiling(uint256 debtCeiling_) external onlyOwner {
        debtCeiling = debtCeiling_;
        emit DebtCeilingUpdated(debtCeiling_);
    }

    function setMintingPaused(bool paused) external onlyOwner {
        mintingPaused = paused;
        emit MintingPausedUpdated(paused);
    }

    /// @notice Recovers HBAR held above the vaults' collateral (e.g. the unused token-creation fee).
    /// @dev Collateral is tracked in `totalCollateral`, never inferred from the balance, so this cannot touch it.
    function sweepExcessHbar(address payable to) external onlyOwner nonReentrant {
        uint256 excess = address(this).balance - totalCollateral;
        if (excess == 0) revert ZeroAmount();
        _sendHbar(to, excess);
        emit ExcessHbarSwept(to, excess);
    }

    // ----------------------------------------------------------------------------------------------------------
    // Views
    // ----------------------------------------------------------------------------------------------------------

    function vaultOf(address owner) external view returns (uint256 collateral, uint256 debt) {
        Vault storage vault = _vaults[owner];
        return (vault.collateral, vault.debt);
    }

    function vaultCount() external view returns (uint256) {
        return _vaultOwners.length;
    }

    function getVault(address owner) external view returns (VaultView memory) {
        (uint256 priceE18, bool usable) = _viewPrice();
        return _vaultView(owner, priceE18, usable);
    }

    /// @notice Paginated vault list for liquidation dashboards and keepers.
    function getVaults(uint256 offset, uint256 limit) external view returns (VaultView[] memory views) {
        uint256 count = _vaultOwners.length;
        if (offset >= count) return new VaultView[](0);
        uint256 end = offset + Math.min(limit, count - offset); // no overflow for limit = type(uint256).max
        (uint256 priceE18, bool usable) = _viewPrice();

        views = new VaultView[](end - offset);
        for (uint256 i = offset; i < end; ++i) {
            views[i - offset] = _vaultView(_vaultOwners[i], priceE18, usable);
        }
    }

    /// @notice Tinybars needed to back `debt` at `ratioBps`, rounded up.
    function requiredCollateral(uint256 debt, uint256 priceE18, uint256 ratioBps) public pure returns (uint256) {
        if (debt == 0) return 0;
        return Math.mulDiv(debt * ratioBps, VALUE_SCALE, priceE18 * BPS, Math.Rounding.Ceil);
    }

    // ----------------------------------------------------------------------------------------------------------
    // Internal: vault logic
    // ----------------------------------------------------------------------------------------------------------

    function _deposit(address owner, uint256 amount) private {
        if (amount == 0) revert ZeroAmount();
        if (!_isVaultOwner[owner]) {
            _isVaultOwner[owner] = true;
            _vaultOwners.push(owner);
        }
        _vaults[owner].collateral += amount;
        totalCollateral += amount;
        emit Deposited(owner, amount);
    }

    function _mint(address owner, uint256 amount) private {
        if (amount == 0) revert ZeroAmount();
        if (stablecoin == address(0)) revert StablecoinNotCreated();
        if (mintingPaused) revert MintingPaused();
        if (totalDebt + amount > debtCeiling) {
            revert DebtCeilingExceeded(debtCeiling > totalDebt ? debtCeiling - totalDebt : 0);
        }

        Vault storage vault = _vaults[owner];
        uint256 newDebt = vault.debt + amount;
        _checkMinDebt(newDebt);
        _checkCollateralised(vault.collateral, newDebt, _usablePrice());

        vault.debt = newDebt;
        totalDebt += amount;

        _mintTo(owner, amount);
        emit Minted(owner, amount);
    }

    function _repay(address owner, uint256 amount) private {
        if (amount == 0) revert ZeroAmount();
        Vault storage vault = _vaults[owner];
        uint256 debt = vault.debt;
        if (amount > debt) revert ExceedsDebt(debt);
        _checkMinDebt(debt - amount);

        vault.debt = debt - amount;
        totalDebt -= amount;

        _pullAndBurn(owner, amount);
        emit Repaid(owner, amount);
    }

    function _withdraw(address owner, uint256 amount) private {
        if (amount == 0) revert ZeroAmount();
        Vault storage vault = _vaults[owner];
        uint256 collateral = vault.collateral;
        if (amount > collateral) revert InsufficientCollateral(collateral);

        uint256 remaining = collateral - amount;
        // Debt-free vaults skip the oracle entirely, so users can always exit when they owe nothing.
        if (vault.debt > 0) _checkCollateralised(remaining, vault.debt, _usablePrice());

        vault.collateral = remaining;
        totalCollateral -= amount;

        _sendHbar(owner, amount);
        emit Withdrawn(owner, amount);
    }

    function _checkMinDebt(uint256 debt) private view {
        if (debt != 0 && debt < minDebt) revert DebtBelowMinimum(minDebt);
    }

    function _checkCollateralised(uint256 collateral, uint256 debt, uint256 priceE18) private view {
        uint256 required = requiredCollateral(debt, priceE18, minCollateralRatioBps);
        if (collateral < required) revert Undercollateralised(required);
    }

    function _isLiquidatable(uint256 collateral, uint256 debt, uint256 priceE18) private view returns (bool) {
        return debt > 0 && collateral < requiredCollateral(debt, priceE18, liquidationRatioBps);
    }

    function _emitVaultUpdated(address owner) private {
        Vault storage vault = _vaults[owner];
        emit VaultUpdated(owner, vault.collateral, vault.debt);
    }

    // ----------------------------------------------------------------------------------------------------------
    // Internal: oracle
    // ----------------------------------------------------------------------------------------------------------

    /// @dev Reverts unless the oracle returns a price this engine accepts (Ok, PrimaryOnly or SecondaryOnly).
    function _usablePrice() private view returns (uint256 priceE18) {
        IPriceOracle.Status status;
        (priceE18, status,) = oracle.latestPrice();
        if (status >= IPriceOracle.Status.Frozen || priceE18 == 0) revert OracleUnusable(status);
    }

    function _viewPrice() private view returns (uint256 priceE18, bool usable) {
        IPriceOracle.Status status;
        (priceE18, status,) = oracle.latestPrice();
        usable = status < IPriceOracle.Status.Frozen && priceE18 != 0;
    }

    function _vaultView(address owner, uint256 priceE18, bool usable) private view returns (VaultView memory v) {
        Vault storage vault = _vaults[owner];
        v.owner = owner;
        v.collateral = vault.collateral;
        v.debt = vault.debt;
        v.collateralRatioBps = v.debt == 0 ? type(uint256).max : 0;

        if (!usable) {
            v.maxWithdrawable = v.debt == 0 ? v.collateral : 0;
            return v;
        }

        v.collateralValue = Math.mulDiv(v.collateral, priceE18, VALUE_SCALE);
        if (v.debt > 0) v.collateralRatioBps = Math.mulDiv(v.collateral, priceE18, v.debt * RATIO_SCALE);

        uint256 maxDebt = Math.mulDiv(v.collateral, priceE18, minCollateralRatioBps * RATIO_SCALE);
        v.maxMintable = maxDebt > v.debt ? maxDebt - v.debt : 0;

        uint256 required = requiredCollateral(v.debt, priceE18, minCollateralRatioBps);
        v.maxWithdrawable = v.collateral > required ? v.collateral - required : 0;
        v.liquidatable = _isLiquidatable(v.collateral, v.debt, priceE18);
    }

    // ----------------------------------------------------------------------------------------------------------
    // Internal: HTS and HBAR transfers
    // ----------------------------------------------------------------------------------------------------------

    /// @dev Mints into the treasury (this contract), then moves the tokens to `to`.
    function _mintTo(address to, uint256 amount) private {
        int64 amount64 = _toInt64(amount);
        (int64 responseCode,,) = IHederaTokenService(HTS).mintToken(stablecoin, amount64, new bytes[](0));
        if (responseCode != HTS_SUCCESS) revert HtsCallFailed(IHederaTokenService.mintToken.selector, responseCode);

        responseCode = IHederaTokenService(HTS).transferToken(stablecoin, address(this), to, amount64);
        if (responseCode == HTS_TOKEN_NOT_ASSOCIATED_TO_ACCOUNT) revert NotAssociated(to);
        if (responseCode != HTS_SUCCESS) {
            revert HtsCallFailed(IHederaTokenService.transferToken.selector, responseCode);
        }
    }

    /// @dev Pulls `amount` from `from` into the treasury using the HIP-376 allowance, then burns it there.
    function _pullAndBurn(address from, uint256 amount) private {
        int64 amount64 = _toInt64(amount);
        int64 responseCode = IHederaTokenService(HTS).transferFrom(stablecoin, from, address(this), amount);
        if (responseCode != HTS_SUCCESS) {
            revert HtsCallFailed(IHederaTokenService.transferFrom.selector, responseCode);
        }

        (responseCode,) = IHederaTokenService(HTS).burnToken(stablecoin, amount64, new int64[](0));
        if (responseCode != HTS_SUCCESS) revert HtsCallFailed(IHederaTokenService.burnToken.selector, responseCode);
    }

    function _sendHbar(address to, uint256 amount) private {
        if (amount == 0) return;
        (bool success,) = payable(to).call{ value: amount }("");
        if (!success) revert HbarTransferFailed();
    }

    function _toInt64(uint256 amount) private pure returns (int64) {
        if (amount > uint256(uint64(type(int64).max))) revert AmountTooLarge();
        // forge-lint: disable-next-line(unsafe-typecast)
        return int64(uint64(amount));
    }
}
