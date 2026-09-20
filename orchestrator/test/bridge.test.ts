import { describe, expect, it } from "@jest/globals";
import fc from "fast-check";
import {
  planBridge,
  poolAmountToAsset,
  quoteBridge,
  type BridgeAsset,
  type BridgeTerms,
} from "../src/domain/bridge.js";
import { NegativeAmountError } from "../src/domain/money.js";
import type { SettlementPayout } from "../src/domain/types.js";
import { PARTNER_A, PARTNER_B } from "./fixtures.js";

const ETC = 10n ** 18n;
const BTC = 10n ** 8n;
const USDC = 10n ** 6n;

/** Precio en punto fijo de 18 decimales: `precio(20n)` es 20 USDC por unidad. */
const precio = (usdc: bigint): bigint => usdc * 10n ** 18n;

function terms(overrides: Partial<BridgeTerms> = {}): BridgeTerms {
  return {
    asset: "ETC",
    rateE18: precio(20n),
    tradeFeeBps: 0,
    withdrawalFee: 0n,
    minWithdrawal: 0n,
    ...overrides,
  };
}

describe("quoteBridge", () => {
  it("convierte ETC a USDC al precio dado", () => {
    // 1 ETC a 20 USDC.
    const quote = quoteBridge(PARTNER_A, 1n * ETC, terms());
    expect(quote.grossOut).toBe(20n * USDC);
    expect(quote.netOut).toBe(20n * USDC);
    expect(quote.rejection).toBeNull();
  });

  it("convierte BTC a USDC respetando sus 8 decimales", () => {
    // 1 BTC a 100.000 USDC.
    const quote = quoteBridge(PARTNER_A, 1n * BTC, terms({ asset: "BTC", rateE18: precio(100_000n) }));
    expect(quote.grossOut).toBe(100_000n * USDC);
    // Un satoshi son 0,001 USDC a ese precio.
    expect(quoteBridge(PARTNER_A, 1n, terms({ asset: "BTC", rateE18: precio(100_000n) })).grossOut).toBe(1_000n);
  });

  it("descuenta la comision de venta y la de retiro, en ese orden", () => {
    // 1000 USDC brutos, 0,1% de venta = 1 USDC, retiro fijo de 2 USDC.
    const quote = quoteBridge(
      PARTNER_A,
      50n * ETC,
      terms({ tradeFeeBps: 10, withdrawalFee: 2n * USDC }),
    );
    expect(quote.grossOut).toBe(1_000n * USDC);
    expect(quote.tradeFee).toBe(1n * USDC);
    expect(quote.withdrawalFee).toBe(2n * USDC);
    expect(quote.netOut).toBe(997n * USDC);
  });

  it("redondea hacia abajo: nunca promete mas de lo que entrega el exchange", () => {
    // 1 wei de ETC a 20 USDC es una fraccion de unidad minima de USDC: no llega a nada.
    const polvo = quoteBridge(PARTNER_A, 1n, terms());
    expect(polvo.grossOut).toBe(0n);
    expect(polvo.rejection).toBe("NO_AMOUNT");

    // La comision de venta tambien se redondea hacia abajo.
    const quote = quoteBridge(PARTNER_A, 1n, terms({ asset: "BTC", rateE18: precio(100_000n), tradeFeeBps: 100 }));
    expect(quote.grossOut).toBe(1_000n);
    expect(quote.tradeFee).toBe(10n);
  });

  describe("rechazos", () => {
    it("un monto cero no se puede pasar por el bridge", () => {
      const quote = quoteBridge(PARTNER_A, 0n, terms());
      expect(quote.rejection).toBe("NO_AMOUNT");
      expect(quote.netOut).toBe(0n);
    });

    it("las comisiones se comen todo el monto", () => {
      // 1 USDC bruto y un retiro de 1 USDC: no quedaria nada.
      const quote = quoteBridge(PARTNER_A, ETC / 20n, terms({ withdrawalFee: 1n * USDC }));
      expect(quote.grossOut).toBe(1n * USDC);
      expect(quote.rejection).toBe("FEES_EXCEED_AMOUNT");
      expect(quote.netOut).toBe(0n);
    });

    it("queda menos que el retiro minimo del exchange", () => {
      // 1 USDC bruto, retiro de 0,1 USDC: quedan 0,9 y el minimo es 5.
      const quote = quoteBridge(
        PARTNER_A,
        ETC / 20n,
        terms({ withdrawalFee: USDC / 10n, minWithdrawal: 5n * USDC }),
      );
      expect(quote.rejection).toBe("BELOW_MINIMUM");
      expect(quote.netOut).toBe(0n);
    });

    it("el retiro minimo justo es viable", () => {
      const quote = quoteBridge(PARTNER_A, ETC / 20n, terms({ minWithdrawal: 1n * USDC }));
      expect(quote.rejection).toBeNull();
      expect(quote.netOut).toBe(1n * USDC);
    });
  });

  describe("validacion de los parametros", () => {
    it("rechaza un precio que no es positivo", () => {
      expect(() => quoteBridge(PARTNER_A, ETC, terms({ rateE18: 0n }))).toThrow(RangeError);
      expect(() => quoteBridge(PARTNER_A, ETC, terms({ rateE18: -1n }))).toThrow(RangeError);
    });

    it("rechaza comisiones en basis points fuera de rango, incluso con monto cero", () => {
      expect(() => quoteBridge(PARTNER_A, ETC, terms({ tradeFeeBps: -1 }))).toThrow(RangeError);
      expect(() => quoteBridge(PARTNER_A, ETC, terms({ tradeFeeBps: 10_001 }))).toThrow(RangeError);
      expect(() => quoteBridge(PARTNER_A, 0n, terms({ tradeFeeBps: 10_001 }))).toThrow(RangeError);
    });

    it("rechaza montos y comisiones negativos", () => {
      expect(() => quoteBridge(PARTNER_A, -1n, terms())).toThrow(NegativeAmountError);
      expect(() => quoteBridge(PARTNER_A, ETC, terms({ withdrawalFee: -1n }))).toThrow(NegativeAmountError);
      expect(() => quoteBridge(PARTNER_A, ETC, terms({ minWithdrawal: -1n }))).toThrow(NegativeAmountError);
    });
  });

  it("es determinista: los mismos datos producen la misma cotizacion", () => {
    const parametros = terms({ tradeFeeBps: 20, withdrawalFee: USDC / 100n });
    expect(quoteBridge(PARTNER_A, 123_456_789_012_345_678n, parametros)).toEqual(
      quoteBridge(PARTNER_A, 123_456_789_012_345_678n, parametros),
    );
  });

  describe("propiedades", () => {
    const assetArb = fc.constantFrom<BridgeAsset>("ETC", "BTC");
    const amountArb = fc.bigInt({ min: 0n, max: 10n ** 24n });
    const termsArb = fc.record({
      asset: assetArb,
      rateE18: fc.bigInt({ min: 1n, max: 10n ** 24n }),
      tradeFeeBps: fc.integer({ min: 0, max: 10_000 }),
      withdrawalFee: fc.bigInt({ min: 0n, max: 10n ** 12n }),
      minWithdrawal: fc.bigInt({ min: 0n, max: 10n ** 12n }),
    });

    it("cuando es viable, conserva el valor exactamente", () => {
      fc.assert(
        fc.property(amountArb, termsArb, (amount, parametros) => {
          const quote = quoteBridge(PARTNER_A, amount, parametros);
          if (quote.rejection !== null) return;
          expect(quote.tradeFee + quote.withdrawalFee + quote.netOut).toBe(quote.grossOut);
        }),
        { numRuns: 2_000 },
      );
    });

    it("cuando es viable, deja un neto positivo y por encima del minimo", () => {
      fc.assert(
        fc.property(amountArb, termsArb, (amount, parametros) => {
          const quote = quoteBridge(PARTNER_A, amount, parametros);
          if (quote.rejection !== null) return;
          expect(quote.netOut > 0n).toBe(true);
          expect(quote.netOut >= parametros.minWithdrawal).toBe(true);
        }),
        { numRuns: 2_000 },
      );
    });

    it("cuando se rechaza, no promete ningun USDC", () => {
      fc.assert(
        fc.property(amountArb, termsArb, (amount, parametros) => {
          const quote = quoteBridge(PARTNER_A, amount, parametros);
          if (quote.rejection === null) return;
          expect(quote.netOut).toBe(0n);
        }),
        { numRuns: 1_000 },
      );
    });

    it("nunca entrega mas de lo que vale la venta", () => {
      fc.assert(
        fc.property(amountArb, termsArb, (amount, parametros) => {
          const quote = quoteBridge(PARTNER_A, amount, parametros);
          expect(quote.netOut <= quote.grossOut).toBe(true);
        }),
        { numRuns: 1_000 },
      );
    });

    it("mas activo nunca da menos USDC", () => {
      fc.assert(
        fc.property(amountArb, amountArb, termsArb, (a, b, parametros) => {
          const [menor, mayor] = a <= b ? [a, b] : [b, a];
          const chico = quoteBridge(PARTNER_A, menor, { ...parametros, minWithdrawal: 0n });
          const grande = quoteBridge(PARTNER_A, mayor, { ...parametros, minWithdrawal: 0n });
          expect(grande.grossOut >= chico.grossOut).toBe(true);
          expect(grande.netOut >= chico.netOut).toBe(true);
        }),
        { numRuns: 1_000 },
      );
    });
  });
});

describe("poolAmountToAsset", () => {
  it("deja igual un monto de ETC: ambos tienen 18 decimales", () => {
    expect(poolAmountToAsset(123_456_789n, "ETC")).toBe(123_456_789n);
  });

  it("baja a 8 decimales un monto de BTC, redondeando hacia abajo", () => {
    // 0,0096 unidades = 9,6e15 wei = 960.000 satoshis.
    expect(poolAmountToAsset(9_600_000_000_000_000n, "BTC")).toBe(960_000n);
    // Menos de un satoshi (1e10 wei) no se convierte.
    expect(poolAmountToAsset(9_999_999_999n, "BTC")).toBe(0n);
  });

  it("rechaza montos negativos", () => {
    expect(() => poolAmountToAsset(-1n, "BTC")).toThrow(NegativeAmountError);
  });
});

describe("planBridge", () => {
  const payouts: SettlementPayout[] = [
    { to: PARTNER_A, amount: 9_600_000_000_000_000n, role: "PARTNER" },
    { to: PARTNER_B, amount: 4_800_000_000_000_000n, role: "PARTNER" },
  ];

  it("cotiza cada linea en el orden en que viene", () => {
    const quotes = planBridge(payouts, terms());
    expect(quotes.map((q) => q.partner)).toEqual([PARTNER_A, PARTNER_B]);
    // 0,0096 ETC a 20 USDC = 0,192 USDC; la mitad para el segundo.
    expect(quotes.map((q) => q.netOut)).toEqual([192_000n, 96_000n]);
  });

  it("convierte los montos a la unidad del activo antes de cotizar", () => {
    const quotes = planBridge(payouts, terms({ asset: "BTC", rateE18: precio(100_000n) }));
    // 0,0096 BTC = 960.000 satoshis a 100.000 USDC por BTC = 960 USDC.
    expect(quotes[0]?.amountIn).toBe(960_000n);
    expect(quotes[0]?.netOut).toBe(960n * USDC);
    expect(quotes[1]?.netOut).toBe(480n * USDC);
  });

  it("una linea inviable no arrastra a las demas", () => {
    const mixto: SettlementPayout[] = [
      { to: PARTNER_A, amount: 9_600_000_000_000_000n, role: "PARTNER" },
      { to: PARTNER_B, amount: 0n, role: "PARTNER" },
    ];
    const quotes = planBridge(mixto, terms());
    expect(quotes[0]?.rejection).toBeNull();
    expect(quotes[1]?.rejection).toBe("NO_AMOUNT");
  });

  it("devuelve una lista vacia si no hay lineas", () => {
    expect(planBridge([], terms())).toEqual([]);
  });
});
