import { parseHcsMessage } from "./mirrorNode";
import { describe, expect, it } from "vitest";

const message = (body: unknown, sequence = 7) => ({
  sequence_number: sequence,
  consensus_timestamp: "1790986286.092034178",
  message: Buffer.from(typeof body === "string" ? body : JSON.stringify(body)).toString("base64"),
});

describe("parseHcsMessage", () => {
  it("decodes a relayed engine event", () => {
    const tx = "0x1cd4299c499fd60d21168afe4510b1ad9096ee6ca12d2f92d6e134adadf6e5cc";
    expect(
      parseHcsMessage(
        message({ v: 1, type: "Minted", args: { owner: "0xabc", amount: "1000000" }, tx, ts: "1790986286.092034178" }),
      ),
    ).toEqual({
      sequenceNumber: 7,
      timestamp: 1790986286,
      type: "Minted",
      args: { owner: "0xabc", amount: "1000000" },
      transactionHash: tx,
    });
  });

  it("decodes an oracle status change, which has no transaction", () => {
    const entry = parseHcsMessage(
      message({ v: 1, type: "OracleStatus", args: { status: "Frozen", previous: "Ok", priceE18: "0" } }),
    );
    expect(entry?.type).toBe("OracleStatus");
    expect(entry?.transactionHash).toBeUndefined();
  });

  it("keeps UTF-8 strings intact", () => {
    const entry = parseHcsMessage(
      message({ v: 1, type: "StablecoinCreated", args: { name: "Dólar €", symbol: "SCD" } }),
    );
    expect(entry?.args.name).toBe("Dólar €");
  });

  it("ignores messages the relayer did not write", () => {
    expect(parseHcsMessage(message("hello"))).toBeNull();
    expect(parseHcsMessage(message({ v: 2, type: "Minted" }))).toBeNull();
    expect(parseHcsMessage(message({ v: 1 }))).toBeNull();
  });
});
