import { describe, expect, it } from "@jest/globals";
import fc from "fast-check";
import { isEpochSettleable, nextSettleableEpoch } from "../src/domain/epoch.js";

describe("nextSettleableEpoch", () => {
  it("es el siguiente al ultimo liquidado", () => {
    expect(nextSettleableEpoch(0n)).toBe(1);
    // Caso real: el pool ya liquido el periodo 1, asi que el siguiente es el 2.
    expect(nextSettleableEpoch(1n)).toBe(2);
    expect(nextSettleableEpoch(41n)).toBe(42);
  });

  it("rechaza un ultimo periodo negativo o fuera del rango de un numero seguro", () => {
    expect(() => nextSettleableEpoch(-1n)).toThrow(RangeError);
    expect(() => nextSettleableEpoch(BigInt(Number.MAX_SAFE_INTEGER))).toThrow(RangeError);
  });

  it("el periodo que devuelve siempre es liquidable", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 1_000_000_000n }), (ultimo) => {
        expect(isEpochSettleable(nextSettleableEpoch(ultimo), ultimo)).toBe(true);
      }),
      { numRuns: 500 },
    );
  });
});

describe("isEpochSettleable", () => {
  it("acepta solo un periodo estrictamente mayor al ultimo liquidado", () => {
    expect(isEpochSettleable(2, 1n)).toBe(true);
    // El caso que hacia fallar la demo: proponer el periodo que ya se uso.
    expect(isEpochSettleable(1, 1n)).toBe(false);
    expect(isEpochSettleable(0, 1n)).toBe(false);
  });

  it("con nada liquidado todavia, acepta desde el 1", () => {
    expect(isEpochSettleable(1, 0n)).toBe(true);
    expect(isEpochSettleable(0, 0n)).toBe(false);
  });

  it("rechaza periodos que no son enteros no negativos", () => {
    expect(isEpochSettleable(1.5, 0n)).toBe(false);
    expect(isEpochSettleable(-1, 0n)).toBe(false);
    expect(isEpochSettleable(Number.NaN, 0n)).toBe(false);
  });
});
