import { describe, expect, it } from "@jest/globals";
import fc from "fast-check";
import { applyBps, NegativeAmountError, splitByWeight, sum } from "../src/domain/money.js";

describe("applyBps", () => {
  it("aplica la tasa redondeando hacia abajo", () => {
    expect(applyBps(1_000n, 500)).toBe(50n);
    expect(applyBps(1n, 500)).toBe(0n);
    expect(applyBps(199n, 500)).toBe(9n);
  });

  it("acepta los extremos del rango", () => {
    expect(applyBps(1_000n, 0)).toBe(0n);
    expect(applyBps(1_000n, 10_000)).toBe(1_000n);
  });

  it("rechaza tasas fuera de rango", () => {
    expect(() => applyBps(1_000n, -1)).toThrow(RangeError);
    expect(() => applyBps(1_000n, 10_001)).toThrow(RangeError);
    expect(() => applyBps(1_000n, 1.5)).toThrow(RangeError);
  });

  it("rechaza montos negativos", () => {
    expect(() => applyBps(-1n, 500)).toThrow(NegativeAmountError);
  });
});

describe("splitByWeight", () => {
  it("reparte en proporcion a los pesos", () => {
    // Dos placas contra una: el reparto clasico 2:1 del pool.
    expect(splitByWeight(300n, [2n, 1n])).toEqual([200n, 100n]);
  });

  it("no pierde ni inventa unidades cuando la division no es exacta", () => {
    // 10 wei entre 3 socios iguales: 3 cada uno y un wei de sobra.
    const shares = splitByWeight(10n, [1n, 1n, 1n]);
    expect(sum(shares)).toBe(10n);
    expect(shares).toEqual([4n, 3n, 3n]);
  });

  it("asigna el sobrante a quien quedo mas cerca de merecerlo", () => {
    // Pesos 1:1:7 sobre 10 unidades. Las partes exactas son 1, 1 y 7 con
    // restos 0, 0 y 0... se elige un caso con restos distintos:
    const shares = splitByWeight(10n, [3n, 3n, 1n]);
    expect(sum(shares)).toBe(10n);
    // 30/7 = 4.28 -> 4, 4 y 1.42 -> 1. Sobra 1, y el resto mayor es del tercero.
    expect(shares).toEqual([4n, 4n, 2n]);
  });

  it("reparte en partes iguales cuando nadie aporto peso", () => {
    const shares = splitByWeight(7n, [0n, 0n, 0n]);
    expect(sum(shares)).toBe(7n);
    expect(shares).toEqual([3n, 2n, 2n]);
  });

  it("devuelve ceros cuando no hay nada que repartir", () => {
    expect(splitByWeight(0n, [5n, 3n])).toEqual([0n, 0n]);
  });

  it("no puede repartir un total positivo sin participantes", () => {
    expect(() => splitByWeight(100n, [])).toThrow(RangeError);
    expect(splitByWeight(0n, [])).toEqual([]);
  });

  it("rechaza totales y pesos negativos", () => {
    expect(() => splitByWeight(-1n, [1n])).toThrow(NegativeAmountError);
    expect(() => splitByWeight(10n, [1n, -1n])).toThrow(NegativeAmountError);
  });

  it("es determinista: los mismos datos producen el mismo reparto", () => {
    const first = splitByWeight(1_000_003n, [7n, 11n, 13n, 17n]);
    const second = splitByWeight(1_000_003n, [7n, 11n, 13n, 17n]);
    expect(first).toEqual(second);
  });

  describe("propiedades", () => {
    const weiArb = fc.bigInt({ min: 0n, max: 10n ** 24n });
    const weightsArb = fc.array(fc.bigInt({ min: 0n, max: 10n ** 18n }), { minLength: 1, maxLength: 16 });

    it("conserva el total exactamente, para cualquier reparto", () => {
      fc.assert(
        fc.property(weiArb, weightsArb, (total, weights) => {
          expect(sum(splitByWeight(total, weights))).toBe(total);
        }),
        { numRuns: 2_000 },
      );
    });

    it("nunca asigna una parte negativa", () => {
      fc.assert(
        fc.property(weiArb, weightsArb, (total, weights) => {
          for (const share of splitByWeight(total, weights)) {
            expect(share >= 0n).toBe(true);
          }
        }),
        { numRuns: 1_000 },
      );
    });

    it("el sobrante repartido nunca supera una unidad por participante", () => {
      fc.assert(
        fc.property(weiArb, weightsArb, (total, weights) => {
          const totalWeight = sum(weights);
          if (totalWeight === 0n) return;
          const shares = splitByWeight(total, weights);
          shares.forEach((share, index) => {
            const exact = (total * (weights[index] ?? 0n)) / totalWeight;
            expect(share - exact).toBeLessThanOrEqual(1n);
            expect(share - exact).toBeGreaterThanOrEqual(0n);
          });
        }),
        { numRuns: 1_000 },
      );
    });

    it("quien aporta mas nunca recibe menos", () => {
      fc.assert(
        fc.property(weiArb, weightsArb, (total, weights) => {
          const shares = splitByWeight(total, weights);
          for (let i = 0; i < weights.length; i += 1) {
            for (let j = 0; j < weights.length; j += 1) {
              if ((weights[i] ?? 0n) > (weights[j] ?? 0n)) {
                expect(shares[i]! >= shares[j]!).toBe(true);
              }
            }
          }
        }),
        { numRuns: 1_000 },
      );
    });
  });
});
