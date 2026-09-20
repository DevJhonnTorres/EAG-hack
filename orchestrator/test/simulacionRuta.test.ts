import { describe, expect, it } from "@jest/globals";
import fc from "fast-check";
import { HashKeyPublicoError, tasaDeRuta, type PasoRuta } from "../src/adapters/hashkeyMercado.js";
import { simularRuta } from "../src/adapters/simulacionRuta.js";

const E18 = 10n ** 18n;

const RUTA_BTC: PasoRuta[] = [
  { symbol: "BTCUSDT", side: "SELL", base: "BTC", quote: "USDT" },
  { symbol: "USDTUSDC", side: "SELL", base: "USDT", quote: "USDC" },
];

const RUTA_HSK: PasoRuta[] = [
  { symbol: "HSKUSD", side: "SELL", base: "HSK", quote: "USD" },
  { symbol: "USDTUSD", side: "BUY", base: "USDT", quote: "USD" },
  { symbol: "USDTUSDC", side: "SELL", base: "USDT", quote: "USDC" },
];

describe("simularRuta", () => {
  it("vender BTC por USDT y luego USDT por USDC, con los precios dados", () => {
    // 0.5 BTC a 80.000 = 40.000 USDT; a 0.9995 = 39.980 USDC.
    const fills = simularRuta(RUTA_BTC, { BTCUSDT: "80000", USDTUSDC: "0.9995" }, E18 / 2n);

    expect(fills).toHaveLength(2);
    expect(fills[0]).toMatchObject({ spendAsset: "BTC", spend: E18 / 2n, receiveAsset: "USDT", receive: 40_000n * E18 });
    expect(fills[1]).toMatchObject({ spendAsset: "USDT", spend: 40_000n * E18, receiveAsset: "USDC", receive: 39_980n * E18 });
  });

  it("comprar entrega la moneda cotizada y recibe la base: divide por el precio", () => {
    // 1000 HSK a 0.1 = 100 USD. Con USDT a 0.5 USD, 100 USD compran 200 USDT.
    const fills = simularRuta(RUTA_HSK, { HSKUSD: "0.1", USDTUSD: "0.5", USDTUSDC: "1" }, 1_000n * E18);

    expect(fills[0]).toMatchObject({ spendAsset: "HSK", receiveAsset: "USD", receive: 100n * E18 });
    expect(fills[1]).toMatchObject({ spendAsset: "USD", spend: 100n * E18, receiveAsset: "USDT", receive: 200n * E18 });
    expect(fills[2]).toMatchObject({ spendAsset: "USDT", receiveAsset: "USDC", receive: 200n * E18 });
  });

  it("cada operacion gasta exactamente lo que dio la anterior", () => {
    const fills = simularRuta(RUTA_HSK, { HSKUSD: "0.09826", USDTUSD: "0.9985", USDTUSDC: "0.9994" }, 12_345n * E18);
    for (let i = 1; i < fills.length; i += 1) {
      expect(fills[i]!.spend).toBe(fills[i - 1]!.receive);
      expect(fills[i]!.spendAsset).toBe(fills[i - 1]!.receiveAsset);
    }
  });

  it("termina en USDC, que es el destino de la ruta", () => {
    const fills = simularRuta(RUTA_BTC, { BTCUSDT: "1", USDTUSDC: "1" }, E18);
    expect(fills.at(-1)?.receiveAsset).toBe("USDC");
  });

  it("coincide con la tasa compuesta que usa la cotizacion, a menos de un redondeo", () => {
    const precios = { HSKUSD: "0.09826", USDTUSD: "0.9985", USDTUSDC: "0.9994" };
    const monto = 10_000n * E18;
    const simulado = simularRuta(RUTA_HSK, precios, monto).at(-1)!.receive;
    const cotizado = (monto * tasaDeRuta(RUTA_HSK, precios)) / E18;
    const diferencia = simulado > cotizado ? simulado - cotizado : cotizado - simulado;
    // Ambos redondean hacia abajo en cada paso, en distinto orden: difieren en unos pocos wei.
    expect(diferencia < 1_000_000n).toBe(true);
  });

  it("un monto cero da operaciones en cero", () => {
    const fills = simularRuta(RUTA_BTC, { BTCUSDT: "80000", USDTUSDC: "1" }, 0n);
    expect(fills.map((f) => f.receive)).toEqual([0n, 0n]);
  });

  it("una ruta vacia no hace nada", () => {
    expect(simularRuta([], {}, E18)).toEqual([]);
  });

  it("rechaza un monto negativo, un precio ausente y un precio en cero", () => {
    expect(() => simularRuta(RUTA_BTC, { BTCUSDT: "1", USDTUSDC: "1" }, -1n)).toThrow(RangeError);
    expect(() => simularRuta(RUTA_BTC, { BTCUSDT: "1" }, E18)).toThrow(/missing price for USDTUSDC/);
    expect(() => simularRuta(RUTA_BTC, { BTCUSDT: "0", USDTUSDC: "1" }, E18)).toThrow(HashKeyPublicoError);
  });

  it("vender nunca entrega mas de lo que vale a ese precio", () => {
    const montoArb = fc.bigInt({ min: 0n, max: 10n ** 24n });
    fc.assert(
      fc.property(montoArb, (monto) => {
        const [venta] = simularRuta([RUTA_BTC[0]!], { BTCUSDT: "81238.79" }, monto);
        // receive <= monto * 81238.79 (exacto, sin redondeo).
        expect(venta!.receive * 100n <= monto * 8_123_879n).toBe(true);
      }),
      { numRuns: 500 },
    );
  });
});
