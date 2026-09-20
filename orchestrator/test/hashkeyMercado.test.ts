import { describe, expect, it } from "@jest/globals";
import {
  HashKeyPublico,
  HashKeyPublicoError,
  leerMercadoRuta,
  ordenPermitida,
  parsearExchangeInfo,
  simbolosDeRuta,
  tasaDeRuta,
} from "../src/adapters/hashkeyMercado.js";

const filtros = (tick: string, step: string, minQty: string, minNotional: string) => [
  { filterType: "PRICE_FILTER", tickSize: tick },
  { filterType: "LOT_SIZE", stepSize: step, minQty },
  { filterType: "MIN_NOTIONAL", minNotional },
];

/** Una respuesta de exchangeInfo con la forma real, recortada. */
function exchangeInfo(overrides: { erc20Withdraw?: boolean } = {}) {
  return {
    symbols: [
      {
        symbol: "BTCUSDT",
        status: "TRADING",
        baseAsset: "BTC",
        quoteAsset: "USDT",
        retailAllowed: false,
        filters: filtros("0.01", "0.00001", "0.0003", "10"),
      },
      {
        symbol: "USDTUSDC",
        status: "TRADING",
        baseAsset: "USDT",
        quoteAsset: "USDC",
        retailAllowed: true,
        filters: filtros("0.0001", "0.00001", "10", "10"),
      },
      // Sin filtro de notional: debe omitirse en vez de inventar una regla.
      {
        symbol: "ROTO",
        status: "TRADING",
        baseAsset: "X",
        quoteAsset: "Y",
        filters: [{ filterType: "PRICE_FILTER", tickSize: "0.1" }],
      },
    ],
    coins: [
      {
        coinId: "USDC",
        chainTypes: [
          { chainType: "ERC20", allowWithdraw: overrides.erc20Withdraw ?? true, minWithdrawQuantity: "25", withdrawFee: "1" },
          { chainType: "Base", allowWithdraw: false, minWithdrawQuantity: "25", withdrawFee: "1" },
        ],
      },
      { coinId: "BTC", chainTypes: [] },
    ],
  };
}

/** fetch simulado: responde segun el path y registra las llamadas. */
function fetchSimulado(rutas: Record<string, { estado?: number; cuerpo: unknown }>) {
  const llamadas: string[] = [];
  const fetchImpl = (async (url: string) => {
    llamadas.push(url);
    const ruta = Object.keys(rutas).find((clave) => url.includes(clave));
    if (!ruta) return new Response("{}", { status: 404 });
    const { estado = 200, cuerpo } = rutas[ruta]!;
    return new Response(JSON.stringify(cuerpo), { status: estado });
  }) as unknown as typeof fetch;
  return { fetchImpl, llamadas };
}

describe("ordenPermitida", () => {
  it("permite solo las operaciones de la ruta, en su sentido", () => {
    expect(ordenPermitida("BTCUSDT", "SELL")).toBe(true);
    expect(ordenPermitida("USDTUSDC", "SELL")).toBe(true);
    expect(ordenPermitida("HSKUSD", "SELL")).toBe(true);
    expect(ordenPermitida("USDTUSD", "BUY")).toBe(true);
  });

  it("rechaza comprar lo que se va a vender, operar otros pares y el sentido contrario", () => {
    expect(ordenPermitida("BTCUSDT", "BUY")).toBe(false);
    expect(ordenPermitida("HSKUSD", "BUY")).toBe(false);
    expect(ordenPermitida("USDTUSD", "SELL")).toBe(false);
    expect(ordenPermitida("ETHUSD", "SELL")).toBe(false);
    expect(ordenPermitida("", "SELL")).toBe(false);
  });
});

describe("simbolosDeRuta", () => {
  it("lista los pares de cada activo en orden", () => {
    expect(simbolosDeRuta("BTC")).toEqual(["BTCUSDT", "USDTUSDC"]);
    expect(simbolosDeRuta("HSK")).toEqual(["HSKUSD", "USDTUSD", "USDTUSDC"]);
  });
});

describe("parsearExchangeInfo", () => {
  it("lee las reglas de cada par", () => {
    const info = parsearExchangeInfo(exchangeInfo());
    expect(info.reglas["BTCUSDT"]).toEqual({
      symbol: "BTCUSDT",
      baseAsset: "BTC",
      quoteAsset: "USDT",
      status: "TRADING",
      retailAllowed: false,
      tickSize: "0.01",
      stepSize: "0.00001",
      minQty: "0.0003",
      minNotional: "10",
    });
    expect(info.reglas["USDTUSDC"]?.retailAllowed).toBe(true);
  });

  it("omite un par al que le falta una regla, sin inventarla", () => {
    expect(parsearExchangeInfo(exchangeInfo()).reglas["ROTO"]).toBeUndefined();
  });

  it("lee como sacar USDC por ERC20", () => {
    expect(parsearExchangeInfo(exchangeInfo()).retiroUsdc).toEqual({ chain: "ERC20", comision: "1", minimo: "25" });
  });

  it("no ofrece retiro si la red esta deshabilitada", () => {
    expect(parsearExchangeInfo(exchangeInfo({ erc20Withdraw: false })).retiroUsdc).toBeNull();
    expect(parsearExchangeInfo({ symbols: [], coins: [] }).retiroUsdc).toBeNull();
  });

  it("rechaza una respuesta que no es un objeto", () => {
    expect(() => parsearExchangeInfo([])).toThrow(HashKeyPublicoError);
    expect(() => parsearExchangeInfo(null)).toThrow(HashKeyPublicoError);
  });

  it("tolera un cuerpo vacio", () => {
    expect(parsearExchangeInfo({})).toEqual({ reglas: {}, retiroUsdc: null });
  });
});

describe("HashKeyPublico", () => {
  it("lee el ultimo precio de cada par", async () => {
    const { fetchImpl, llamadas } = fetchSimulado({
      "symbol=BTCUSDT": { cuerpo: [{ s: "BTCUSDT", p: "81238.79" }] },
      "symbol=USDTUSDC": { cuerpo: [{ s: "USDTUSDC", p: "0.9994" }] },
    });
    const precios = await new HashKeyPublico("production", fetchImpl).precios(["BTCUSDT", "USDTUSDC"]);
    expect(precios).toEqual({ BTCUSDT: "81238.79", USDTUSDC: "0.9994" });
    expect(llamadas[0]).toBe("https://api-pro.hashkey.com/quote/v1/ticker/price?symbol=BTCUSDT");
  });

  it("apunta al sandbox cuando se le pide", async () => {
    const { fetchImpl, llamadas } = fetchSimulado({ "ticker/price": { cuerpo: [{ s: "BTCUSDT", p: "1" }] } });
    await new HashKeyPublico("sandbox", fetchImpl).precios(["BTCUSDT"]);
    expect(llamadas[0]?.startsWith("https://api-pro.sim.hashkeydev.com/")).toBe(true);
  });

  it("falla con un mensaje claro si el exchange rechaza el par", async () => {
    const { fetchImpl } = fetchSimulado({
      "ticker/price": { estado: 400, cuerpo: { code: -100011, msg: "Not supported symbols" } },
    });
    await expect(new HashKeyPublico("production", fetchImpl).precios(["BTCUSDC"])).rejects.toThrow(
      /400.*Not supported symbols/,
    );
  });

  it("falla si no llega el precio", async () => {
    const { fetchImpl } = fetchSimulado({ "ticker/price": { cuerpo: [] } });
    await expect(new HashKeyPublico("production", fetchImpl).precios(["BTCUSDT"])).rejects.toThrow(
      /no llego el precio/,
    );
  });

  it("lee el mejor precio de compra y de venta del libro", async () => {
    const { fetchImpl } = fetchSimulado({
      "quote/v1/depth": {
        cuerpo: { b: [["81229.52", "0.00059"], ["81197.5", "0.13"]], a: [["81229.53", "0.004"]] },
      },
    });
    expect(await new HashKeyPublico("production", fetchImpl).mejorPrecio("BTCUSDT")).toEqual({
      bid: "81229.52",
      ask: "81229.53",
    });
  });

  it("falla si el libro esta vacio", async () => {
    const { fetchImpl } = fetchSimulado({ "quote/v1/depth": { cuerpo: { b: [], a: [] } } });
    await expect(new HashKeyPublico("production", fetchImpl).mejorPrecio("BTCUSDT")).rejects.toThrow(/vacio/);
  });

  it("falla con un cuerpo que no es JSON", async () => {
    const fetchImpl = (async () => new Response("<html>", { status: 502 })) as unknown as typeof fetch;
    await expect(new HashKeyPublico("production", fetchImpl).infoMercado()).rejects.toThrow(/502/);
  });
});

describe("tasaDeRuta", () => {
  it("compone la venta de BTC a USDT y de USDT a USDC", () => {
    const tasa = tasaDeRuta("BTC", { BTCUSDT: "81238.79", USDTUSDC: "0.9994" });
    // 81238.79 * 0.9994 = 81190.046726
    expect(tasa).toBe(81_190_046_726_000_000_000_000n);
  });

  it("para HSK compra USDT con USD: divide por el precio de USDT/USD", () => {
    // Con USDT a exactamente 1 USD, el paso de compra no cambia nada.
    const tasa = tasaDeRuta("HSK", { HSKUSD: "0.09826", USDTUSD: "1", USDTUSDC: "0.9994" });
    // 0.09826 * 0.9994 = 0.098201044
    expect(tasa).toBe(98_201_044_000_000_000n);
  });

  it("un USDT mas caro que 1 USD deja menos USDT por cada USD", () => {
    const barato = tasaDeRuta("HSK", { HSKUSD: "0.1", USDTUSD: "0.99", USDTUSDC: "1" });
    const caro = tasaDeRuta("HSK", { HSKUSD: "0.1", USDTUSD: "1.01", USDTUSDC: "1" });
    expect(barato > caro).toBe(true);
  });

  it("falla si falta un precio o es cero", () => {
    expect(() => tasaDeRuta("BTC", { BTCUSDT: "81238.79" })).toThrow(/falta el precio de USDTUSDC/);
    expect(() => tasaDeRuta("BTC", { BTCUSDT: "0", USDTUSDC: "1" })).toThrow(/precio invalido/);
  });
});

describe("leerMercadoRuta", () => {
  it("junta precios reales y costo de retiro en una sola lectura", async () => {
    const { fetchImpl } = fetchSimulado({
      "symbol=BTCUSDT": { cuerpo: [{ s: "BTCUSDT", p: "81238.79" }] },
      "symbol=USDTUSDC": { cuerpo: [{ s: "USDTUSDC", p: "0.9994" }] },
      "symbol=HSKUSD": { cuerpo: [{ s: "HSKUSD", p: "0.09826" }] },
      "symbol=USDTUSD": { cuerpo: [{ s: "USDTUSD", p: "1" }] },
      "exchangeInfo": { cuerpo: exchangeInfo() },
    });
    const mercado = await leerMercadoRuta(new HashKeyPublico("production", fetchImpl), () => 1_700_000_000_000);
    expect(mercado.precioUsdc).toEqual({ BTC: "81190.046726", HSK: "0.098201044" });
    expect(mercado.retiroUsdc).toEqual({ chain: "ERC20", comision: "1", minimo: "25" });
    expect(mercado.leidoEn).toBe(1_700_000_000_000);
  });
});

describe("respuestas malformadas del exchange", () => {
  it("parsearExchangeInfo omite lo que no tiene la forma esperada", () => {
    const info = parsearExchangeInfo({
      symbols: [
        null,
        "no soy un objeto",
        // Sin la lista de filtros: no hay reglas que leer.
        { symbol: "SINFILTROS", baseAsset: "A", quoteAsset: "B", status: "TRADING" },
        // Sin estado: el par se conserva, pero no figura como operando.
        { symbol: "SINESTADO", baseAsset: "A", quoteAsset: "B", filters: filtros("0.1", "0.1", "1", "1") },
      ],
    });
    expect(Object.keys(info.reglas)).toEqual(["SINESTADO"]);
    expect(info.reglas["SINESTADO"]?.status).toBe("DESCONOCIDO");
    expect(info.reglas["SINESTADO"]?.retailAllowed).toBe(false);
  });

  it("un retiro de USDC sin comision o sin minimo no se ofrece", () => {
    const sinComision = { coins: [{ coinId: "USDC", chainTypes: [{ chainType: "ERC20", allowWithdraw: true, minWithdrawQuantity: "25" }] }] };
    const sinMinimo = { coins: [{ coinId: "USDC", chainTypes: [{ chainType: "ERC20", allowWithdraw: true, withdrawFee: "1" }] }] };
    expect(parsearExchangeInfo(sinComision).retiroUsdc).toBeNull();
    expect(parsearExchangeInfo(sinMinimo).retiroUsdc).toBeNull();
    // Sin lista de redes.
    expect(parsearExchangeInfo({ coins: [{ coinId: "USDC" }] }).retiroUsdc).toBeNull();
  });

  it("un error del exchange sin codigo ni mensaje igual se reporta", async () => {
    const { fetchImpl } = fetchSimulado({ "ticker/price": { estado: 500, cuerpo: {} } });
    await expect(new HashKeyPublico("production", fetchImpl).precios(["BTCUSDT"])).rejects.toThrow(/respondio 500$/);
  });

  it("un error con mensaje pero sin codigo lo incluye", async () => {
    const { fetchImpl } = fetchSimulado({ "ticker/price": { estado: 429, cuerpo: { msg: "demasiadas peticiones" } } });
    await expect(new HashKeyPublico("production", fetchImpl).precios(["BTCUSDT"])).rejects.toThrow(
      /429: demasiadas peticiones/,
    );
  });

  it("un precio que no llega como lista falla", async () => {
    const { fetchImpl } = fetchSimulado({ "ticker/price": { cuerpo: { p: "1" } } });
    await expect(new HashKeyPublico("production", fetchImpl).precios(["BTCUSDT"])).rejects.toThrow(
      /no llego el precio/,
    );
  });

  it("un libro con forma inesperada se trata como vacio", async () => {
    for (const cuerpo of [[], "texto", { b: "x", a: 5 }, { b: [[]], a: [[]] }, { b: [["1", "1"]], a: [] }]) {
      const { fetchImpl } = fetchSimulado({ "quote/v1/depth": { cuerpo } });
      await expect(new HashKeyPublico("production", fetchImpl).mejorPrecio("BTCUSDT")).rejects.toThrow(/vacio/);
    }
  });

  it("usa produccion y el fetch global si no se le indica otra cosa", () => {
    expect(() => new HashKeyPublico()).not.toThrow();
  });

  it("leerMercadoRuta marca la hora de lectura con el reloj real por defecto", async () => {
    const { fetchImpl } = fetchSimulado({
      "symbol=BTCUSDT": { cuerpo: [{ s: "BTCUSDT", p: "1" }] },
      "symbol=USDTUSDC": { cuerpo: [{ s: "USDTUSDC", p: "1" }] },
      "symbol=HSKUSD": { cuerpo: [{ s: "HSKUSD", p: "1" }] },
      "symbol=USDTUSD": { cuerpo: [{ s: "USDTUSD", p: "1" }] },
      "exchangeInfo": { cuerpo: {} },
    });
    const antes = Date.now();
    const mercado = await leerMercadoRuta(new HashKeyPublico("production", fetchImpl));
    expect(mercado.leidoEn).toBeGreaterThanOrEqual(antes);
    expect(mercado.retiroUsdc).toBeNull();
  });
});
