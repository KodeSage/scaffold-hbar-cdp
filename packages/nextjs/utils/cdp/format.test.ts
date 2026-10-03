import {
  formatAge,
  formatHbar,
  formatRatio,
  formatStable,
  formatUsdPrice,
  parseHbar,
  parseStable,
  toInput,
} from "./format";
import { describe, expect, it } from "vitest";

describe("formatting", () => {
  it("formats on-chain units", () => {
    expect(formatHbar(123_456_789_000n)).toBe("1,234.5678");
    expect(formatStable(66_666_666n)).toBe("66.66");
    expect(formatUsdPrice(102_245_790_000_000_000n)).toBe("$0.10224");
    expect(formatRatio(16_666n)).toBe("166.66%");
    expect(formatRatio(null)).toBe("∞");
  });

  it("formats ages", () => {
    expect(formatAge(1_000, 1_030)).toBe("30s ago");
    expect(formatAge(1_000, 1_000 + 600)).toBe("10m ago");
    expect(formatAge(1_000, 1_000 + 7_200)).toBe("2.0h ago");
  });
});

describe("parsing user input", () => {
  it("parses HBAR to tinybars and stable to 6 decimals", () => {
    expect(parseHbar("1.5")).toEqual({ value: 150_000_000n, error: null });
    expect(parseStable("2.25")).toEqual({ value: 2_250_000n, error: null });
    expect(parseHbar("")).toEqual({ value: 0n, error: null });
  });

  it("rejects precision the relay cannot carry and non-numbers", () => {
    expect(parseHbar("1.123456789").error).toMatch(/8 decimals/);
    expect(parseStable("0.0000001").error).toMatch(/6 decimals/);
    expect(parseHbar("abc").error).toBe("Not a number");
    expect(parseHbar(".").error).toBe("Not a number");
  });

  it("round-trips through toInput", () => {
    expect(toInput(150_000_000n, 8)).toBe("1.5");
    expect(toInput(2_000_000n, 6)).toBe("2");
  });
});
