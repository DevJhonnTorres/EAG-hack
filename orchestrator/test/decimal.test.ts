import { describe, expect, it } from "@jest/globals";
import fc from "fast-check";
import {
  compareDecimal,
  decimalToFixed,
  factorBps,
  floorToStep,
  formatDecimal,
  mulDecimal,
  parseDecimal,
} from "../src/domain/decimal.js";

describe("parseDecimal y formatDecimal", () => {
  it("leen enteros y decimales", () => {
    expect(parseDecimal("12")).toEqual({ units: 12n, scale: 0 });
    expect(parseDecimal("0.00301")).toEqual({ units: 301n, scale: 5 });
  });

  it("rechazan lo que no es un decimal positivo", () => {
    for (const malo of ["", ".", "-1", "1e3", "1.", ".5", "abc", "1,5", "1.2.3"]) {
      expect(() => parseDecimal(malo)).toThrow(RangeError);
    }
  });

  it("dan formato sin ceros a la derecha", () => {
    expect(formatDecimal({ units: 500n, scale: 3 })).toBe("0.5");
    expect(formatDecimal({ units: 200n, scale: 2 })).toBe("2");
    expect(formatDecimal({ units: 5n, scale: 4 })).toBe("0.0005");
    expect(formatDecimal({ units: 0n, scale: 4 })).toBe("0");
    expect(formatDecimal({ units: 7n, scale: 0 })).toBe("7");
  });

  it("ida y vuelta conserva el valor", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 10n ** 20n }), fc.integer({ min: 0, max: 12 }), (units, scale) => {
        const texto = formatDecimal({ units, scale });
        expect(compareDecimal(texto, formatDecimal({ units, scale }))).toBe(0);
        const vuelta = parseDecimal(texto);
        // Mismo valor aunque la escala se haya normalizado.
        expect(vuelta.units * 10n ** BigInt(scale) === units * 10n ** BigInt(vuelta.scale)).toBe(true);
      }),
      { numRuns: 500 },
    );
  });
});

describe("compareDecimal", () => {
  it("compara valores con distinta escala", () => {
    expect(compareDecimal("1.5", "1.50")).toBe(0);
    expect(compareDecimal("0.0003", "0.0004")).toBe(-1);
    expect(compareDecimal("10", "9.99999")).toBe(1);
  });
});

describe("mulDecimal", () => {
  it("multiplica sin perder decimales", () => {
    // 81238.79 * 0.003 = 243.71637, y 81238.79 * 0.00001 = 0.8123879.
    expect(mulDecimal("0.00301", "81238.79")).toBe("244.5287579");
    expect(mulDecimal("2", "0.5")).toBe("1");
    expect(mulDecimal("0", "123.45")).toBe("0");
  });
});

describe("floorToStep", () => {
  it("baja al multiplo del paso", () => {
    expect(floorToStep("0.001239", "0.00001")).toBe("0.00123");
    expect(floorToStep("81229.529", "0.01")).toBe("81229.52");
    expect(floorToStep("1234.5678", "0.01")).toBe("1234.56");
  });

  it("no toca lo que ya es multiplo", () => {
    expect(floorToStep("0.00123", "0.00001")).toBe("0.00123");
    expect(floorToStep("50", "0.01")).toBe("50");
  });

  it("puede dejar el valor en cero si es menor que un paso", () => {
    expect(floorToStep("0.000009", "0.00001")).toBe("0");
  });

  it("rechaza un paso en cero", () => {
    expect(() => floorToStep("1", "0")).toThrow(RangeError);
  });

  it("nunca sube el valor y siempre deja un multiplo del paso", () => {
    const valorArb = fc.bigInt({ min: 0n, max: 10n ** 15n }).map((n) => formatDecimal({ units: n, scale: 8 }));
    const pasoArb = fc.integer({ min: 1, max: 100_000 }).map((n) => formatDecimal({ units: BigInt(n), scale: 8 }));
    fc.assert(
      fc.property(valorArb, pasoArb, (valor, paso) => {
        const abajo = floorToStep(valor, paso);
        expect(compareDecimal(abajo, valor) <= 0).toBe(true);
        expect(compareDecimal(floorToStep(abajo, paso), abajo)).toBe(0);
        // La diferencia es menor que un paso.
        const resto = parseDecimal(valor).units * 1n - parseDecimal(abajo).units * 10n ** BigInt(8 - parseDecimal(abajo).scale);
        expect(resto < parseDecimal(paso).units * 10n ** BigInt(8 - parseDecimal(paso).scale)).toBe(true);
      }),
      { numRuns: 500 },
    );
  });
});

describe("factorBps", () => {
  it("arma el factor de un margen en basis points", () => {
    expect(factorBps(0)).toBe("1");
    expect(factorBps(50)).toBe("1.005");
    expect(factorBps(-50)).toBe("0.995");
    expect(factorBps(-9_999)).toBe("0.0001");
  });

  it("rechaza margenes imposibles", () => {
    expect(() => factorBps(-10_000)).toThrow(RangeError);
    expect(() => factorBps(1.5)).toThrow(RangeError);
  });
});

describe("decimalToFixed", () => {
  it("escala a punto fijo redondeando hacia abajo", () => {
    expect(decimalToFixed("0.9994", 18)).toBe(999_400_000_000_000_000n);
    expect(decimalToFixed("81238.79", 18)).toBe(81_238_790_000_000_000_000_000n);
    expect(decimalToFixed("0.123456789", 4)).toBe(1234n);
    expect(decimalToFixed("2", 0)).toBe(2n);
  });
});
