import { STABLE_DECIMALS, TINYBAR_DECIMALS } from "./math";
import { formatUnits, parseUnits } from "viem";

const trim = (value: string, maxFractionDigits: number) => {
  const [whole, fraction = ""] = value.split(".");
  const cut = fraction.slice(0, maxFractionDigits).replace(/0+$/, "");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return cut ? `${grouped}.${cut}` : grouped;
};

export const formatHbar = (tinybars: bigint, digits = 4) => trim(formatUnits(tinybars, TINYBAR_DECIMALS), digits);
export const formatStable = (units: bigint, digits = 2) => trim(formatUnits(units, STABLE_DECIMALS), digits);
export const formatUsdPrice = (priceE18: bigint, digits = 5) => `$${trim(formatUnits(priceE18, 18), digits)}`;

/** "166.66%" for a ratio in bps; "∞" for null (no debt). */
export const formatRatio = (bps: bigint | null) => (bps === null ? "∞" : `${trim(formatUnits(bps, 2), 2)}%`);

export const formatAge = (unixSeconds: bigint | number, nowSeconds = Math.floor(Date.now() / 1000)) => {
  const seconds = Math.max(0, nowSeconds - Number(unixSeconds));
  if (seconds < 90) return `${seconds}s ago`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m ago`;
  return `${(seconds / 3600).toFixed(1)}h ago`;
};

export type ParsedAmount = { value: bigint; error: string | null };

/**
 * Parses a user-entered decimal amount with at most `decimals` fraction digits.
 * HBAR inputs use 8 decimals (tinybars): the JSON-RPC relay cannot represent smaller amounts.
 */
export function parseAmount(input: string, decimals: number): ParsedAmount {
  const text = input.trim();
  if (text === "") return { value: 0n, error: null };
  if (!/^\d*\.?\d*$/.test(text) || text === ".") return { value: 0n, error: "Not a number" };
  const fraction = text.split(".")[1] ?? "";
  if (fraction.length > decimals) return { value: 0n, error: `At most ${decimals} decimals` };
  return { value: parseUnits(text, decimals), error: null };
}

export const parseHbar = (input: string) => parseAmount(input, TINYBAR_DECIMALS);
export const parseStable = (input: string) => parseAmount(input, STABLE_DECIMALS);

/** Inverse of parse*: renders a base-unit amount as a plain input string (no grouping). */
export const toInput = (amount: bigint, decimals: number) => {
  const text = formatUnits(amount, decimals);
  return text.includes(".") ? text.replace(/\.?0+$/, "") : text;
};
