"use client";

import { useState } from "react";
import { AmountInput } from "./AmountInput";
import type { AccountSnapshot, ProtocolSnapshot } from "~~/hooks/cdp/useCdp";
import { useCdpActions } from "~~/hooks/cdp/useCdpActions";
import {
  formatHbar,
  formatRatio,
  formatStable,
  formatUsdPrice,
  parseHbar,
  parseStable,
  toInput,
} from "~~/utils/cdp/format";
import {
  Preview,
  STABLE_DECIMALS,
  TINYBAR_DECIMALS,
  maxMintable,
  maxWithdrawable,
  previewBorrow,
  previewRepay,
} from "~~/utils/cdp/math";

/** HBAR kept back by "Max" on deposits to pay for gas (Hedera charges at least 80% of the gas limit). */
const GAS_RESERVE_TINYBARS = 2n * 10n ** 8n;

type FormProps = { protocol: ProtocolSnapshot; account: AccountSnapshot; symbol: string };

const PreviewBox = ({ preview, symbol }: { preview: Preview; symbol: string }) => (
  <div className="rounded-box bg-base-200 p-3 text-sm grid grid-cols-2 gap-y-1">
    <span className="text-base-content/70">Collateral after</span>
    <span className="text-right font-mono">{formatHbar(preview.collateral)} HBAR</span>
    <span className="text-base-content/70">Debt after</span>
    <span className="text-right font-mono">
      {formatStable(preview.debt)} {symbol}
    </span>
    <span className="text-base-content/70">Ratio after</span>
    <span className="text-right font-mono">{preview.debt === 0n ? "∞" : formatRatio(preview.collateralRatioBps)}</span>
    <span className="text-base-content/70">Liquidation price</span>
    <span className="text-right font-mono">
      {preview.liquidationPrice === null ? "—" : formatUsdPrice(preview.liquidationPrice)}
    </span>
  </div>
);

const BorrowForm = ({ protocol, account, symbol }: FormProps) => {
  const { borrow, pending } = useCdpActions();
  const [depositInput, setDepositInput] = useState("");
  const [mintInput, setMintInput] = useState("");
  const deposit = parseHbar(depositInput);
  const mint = parseStable(mintInput);
  const { params, price } = protocol;

  const availableDebt = protocol.debtCeiling > protocol.totalDebt ? protocol.debtCeiling - protocol.totalDebt : 0n;
  const preview = previewBorrow(account, deposit.value, mint.value, price.priceE18, params, availableDebt);
  const maxDeposit = account.hbarBalance > GAS_RESERVE_TINYBARS ? account.hbarBalance - GAS_RESERVE_TINYBARS : 0n;

  let blocker = deposit.error ?? mint.error;
  if (!blocker && deposit.value > account.hbarBalance) blocker = "Not enough HBAR in wallet";
  if (!blocker && mint.value > 0n) {
    if (protocol.mintingPaused) blocker = "Minting is paused by the owner";
    else if (!price.usable) blocker = "Oracle has no usable price: minting is disabled";
    else if (account.readiness === "needs-association") blocker = `Associate ${symbol} first (see above)`;
  }
  blocker ??= preview.error;

  const action = mint.value === 0n ? "Deposit" : deposit.value === 0n ? `Mint ${symbol}` : `Deposit & mint`;

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={async event => {
        event.preventDefault();
        if (await borrow(deposit.value, mint.value)) {
          setDepositInput("");
          setMintInput("");
        }
      }}
    >
      <AmountInput
        label="Deposit collateral"
        unit="HBAR"
        value={depositInput}
        onChange={setDepositInput}
        error={deposit.error}
        hint={`Wallet: ${formatHbar(account.hbarBalance, 2)}`}
        onMax={() => setDepositInput(toInput(maxDeposit, TINYBAR_DECIMALS))}
      />
      <AmountInput
        label={`Mint ${symbol}`}
        unit={symbol}
        value={mintInput}
        onChange={setMintInput}
        error={mint.error}
        hint={`Min debt ${formatStable(params.minDebt)}`}
        onMax={
          price.usable
            ? () =>
                setMintInput(
                  toInput(
                    maxMintable(
                      account.collateral + deposit.value,
                      account.debt,
                      price.priceE18,
                      params.minCollateralRatioBps,
                    ),
                    STABLE_DECIMALS,
                  ),
                )
            : undefined
        }
      />
      <PreviewBox preview={preview} symbol={symbol} />
      {blocker && depositInput + mintInput !== "" && <p className="text-sm text-error m-0">{blocker}</p>}
      <button type="submit" className="btn btn-primary" disabled={Boolean(blocker) || pending !== null}>
        {pending === "borrow" ? <span className="loading loading-spinner loading-sm" /> : action}
      </button>
    </form>
  );
};

const RepayForm = ({ protocol, account, symbol }: FormProps) => {
  const { repayAndWithdraw, approve, pending } = useCdpActions();
  const [repayInput, setRepayInput] = useState("");
  const [withdrawInput, setWithdrawInput] = useState("");
  const repay = parseStable(repayInput);
  const withdraw = parseHbar(withdrawInput);
  const { params, price } = protocol;

  const preview = previewRepay(account, repay.value, withdraw.value, price.usable ? price.priceE18 : 0n, params);
  const maxRepay = account.debt < account.stableBalance ? account.debt : account.stableBalance;
  const needsApproval = repay.value > 0n && account.allowance < repay.value;

  let blocker = repay.error ?? withdraw.error;
  if (!blocker && repay.value > account.stableBalance) blocker = `Not enough ${symbol} in wallet`;
  blocker ??= preview.error;

  const withdrawableAfterRepay = () => {
    const debtAfter = repay.value <= account.debt ? account.debt - repay.value : account.debt;
    return maxWithdrawable(account.collateral, debtAfter, price.priceE18, params.minCollateralRatioBps);
  };

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={async event => {
        event.preventDefault();
        if (needsApproval) {
          await approve(protocol.stablecoin, protocol.engine, repay.value);
          return;
        }
        if (await repayAndWithdraw(repay.value, withdraw.value)) {
          setRepayInput("");
          setWithdrawInput("");
        }
      }}
    >
      <AmountInput
        label={`Repay ${symbol}`}
        unit={symbol}
        value={repayInput}
        onChange={setRepayInput}
        error={repay.error}
        hint={`Debt: ${formatStable(account.debt)}`}
        onMax={() => setRepayInput(toInput(maxRepay, STABLE_DECIMALS))}
      />
      <AmountInput
        label="Withdraw collateral"
        unit="HBAR"
        value={withdrawInput}
        onChange={setWithdrawInput}
        error={withdraw.error}
        hint={`Locked: ${formatHbar(account.collateral, 2)}`}
        onMax={
          price.usable || repay.value === account.debt
            ? () => setWithdrawInput(toInput(withdrawableAfterRepay(), TINYBAR_DECIMALS))
            : undefined
        }
      />
      <PreviewBox preview={preview} symbol={symbol} />
      {needsApproval && !blocker && (
        <p className="text-sm text-base-content/70 m-0">
          Step 1 of 2: allow the engine to burn {formatStable(repay.value)} {symbol} from your wallet (HTS allowance).
        </p>
      )}
      {blocker && repayInput + withdrawInput !== "" && <p className="text-sm text-error m-0">{blocker}</p>}
      <button type="submit" className="btn btn-primary" disabled={Boolean(blocker) || pending !== null}>
        {pending === "approve" || pending === "repay" ? (
          <span className="loading loading-spinner loading-sm" />
        ) : needsApproval ? (
          `Approve ${symbol}`
        ) : repay.value > 0n && withdraw.value > 0n ? (
          "Repay & withdraw"
        ) : repay.value > 0n ? (
          "Repay"
        ) : (
          "Withdraw"
        )}
      </button>
    </form>
  );
};

/** Borrow / repay tabs for the connected account. */
export const VaultActions = (props: FormProps) => {
  const [tab, setTab] = useState<"borrow" | "repay">("borrow");
  return (
    <section className="card bg-base-100 border border-base-300 shadow-sm">
      <div className="card-body gap-4">
        <div role="tablist" className="tabs tabs-box">
          <button
            type="button"
            role="tab"
            className={`tab ${tab === "borrow" ? "tab-active" : ""}`}
            onClick={() => setTab("borrow")}
          >
            Deposit & mint
          </button>
          <button
            type="button"
            role="tab"
            className={`tab ${tab === "repay" ? "tab-active" : ""}`}
            onClick={() => setTab("repay")}
          >
            Repay & withdraw
          </button>
        </div>
        {tab === "borrow" ? <BorrowForm {...props} /> : <RepayForm {...props} />}
      </div>
    </section>
  );
};
