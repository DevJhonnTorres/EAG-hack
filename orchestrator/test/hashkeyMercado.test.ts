import { describe, expect, it } from "@jest/globals";
import {
  HashKeyPublico,
  HashKeyPublicoError,
  comisionDeRutaBps,
  descubrirRuta,
  elegirRetiroUsdc,
  leerMercadoRuta,
  ordenPermitida,
  parsearExchangeInfo,
  pasosPermitidos,
  redesDeDeposito,
  redesDeRetiroUsdc,
  rutasDeActivos,
  tasaDeRuta,
  type PasoRuta,
} from "../src/adapters/hashkeyMercado.js";

const filtros = (tick: string, step: string, minQty: string, minNotional: string) => [
  { filterType: "PRICE_FILTER", tickSize: tick },
  { filterType: "LOT_SIZE", stepSize: step, minQty },
  { filterType: "MIN_NOTIONAL", minNotional },
];

const par = (symbol: string, base: string, quote: string, extra: Record<string, unknown> = {}) => ({
  symbol,
  status: "TRADING",
  baseAsset: base,
  quoteAsset: quote,
  retailAllowed: false,
  filters: filtros("0.01", "0.00001", "0.0003", "10"),
  ...extra,
});

const red = (chainType: string, extra: Record<string, unknown> = {}) => ({
  chainType,
  allowDeposit: true,
  allowWithdraw: true,
  minWithdrawQuantity: "25",
  withdrawFee: "1",
  ...extra,
});

/** Una respuesta de exchangeInfo con la forma real, recortada a lo que importa. */
function exchangeInfo(opciones: { erc20Withdraw?: boolean; linea?: boolean; detenidos?: string[] } = {}) {
  const detenidos = new Set(opciones.detenidos ?? []);
  const pares = [
    par("BTCUSDT", "BTC", "USDT"),
    par("BTCUSD", "BTC", "USD"),
    par("BTCHKD", "BTC", "HKD"),
    par("BTCFDUSD", "BTC", "FDUSD"),
    par("FDUSDUSD", "FDUSD", "USD"),
    par("ETHUSD", "ETH", "USD"),
    par("HSKUSD", "HSK", "USD"),
    par("USDTUSD", "USDT", "USD"),
    par("USDTUSDC", "USDT", "USDC", { retailAllowed: true }),
  ].map((p) => (detenidos.has(p.symbol) ? { ...p, status: "HALT" } : p));

  return {
    symbols: pares,
    coins: [
      {
        coinId: "USDC",
        chainTypes: [
          red("ERC20", { allowWithdraw: opciones.erc20Withdraw ?? true }),
          red("Base", { allowDeposit: false, allowWithdraw: false }),
          red("XDC", { minWithdrawQuantity: "1", withdrawFee: "0" }),
          ...(opciones.linea ? [red("Linea", { minWithdrawQuantity: "10", withdrawFee: "0.5" })] : []),
        ],
      },
      { coinId: "BTC", chainTypes: [red("Bitcoin", { minWithdrawQuantity: "0.005", withdrawFee: "0.00003" })] },
      { coinId: "HSK", chainTypes: [red("HashKey Chain"), red("ERC20")] },
    ],
  };
}

const reglasDe = (opciones?: Parameters<typeof exchangeInfo>[0]) => parsearExchangeInfo(exchangeInfo(opciones)).reglas;

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

const resumen = (pasos: readonly PasoRuta[] | null | undefined) => pasos?.map((p) => `${p.side} ${p.symbol}`);

describe("descubrirRuta", () => {
  it("encuentra el camino mas corto de BTC a USDC", () => {
    expect(resumen(descubrirRuta("BTC", reglasDe()))).toEqual(["SELL BTCUSDT", "SELL USDTUSDC"]);
  });

  it("para HSK compra USDT con USD, porque HSK solo cotiza contra USD", () => {
    expect(resumen(descubrirRuta("HSK", reglasDe()))).toEqual(["SELL HSKUSD", "BUY USDTUSD", "SELL USDTUSDC"]);
  });

  it("describe cada paso con su moneda base y cotizada", () => {
    expect(descubrirRuta("BTC", reglasDe())?.[0]).toEqual({ symbol: "BTCUSDT", side: "SELL", base: "BTC", quote: "USDT" });
  });

  it("cambia de camino si un par deja de operar", () => {
    // Sin BTC/USDT, el camino corto desaparece y se pasa por USD.
    expect(resumen(descubrirRuta("BTC", reglasDe({ detenidos: ["BTCUSDT"] })))).toEqual([
      "SELL BTCUSD",
      "BUY USDTUSD",
      "SELL USDTUSDC",
    ]);
  });

  it("devuelve null si el exchange ya no ofrece como llegar a USDC", () => {
    expect(descubrirRuta("BTC", reglasDe({ detenidos: ["USDTUSDC"] }))).toBeNull();
  });

  it("no pasa por activos volatiles ni por monedas fuera de la lista", () => {
    // Solo queda BTC -> FDUSD -> USD -> USDT -> USDC. FDUSD no esta entre las monedas
    // aceptadas, asi que no hay ruta, aunque el exchange tenga pares que la formarian.
    const reglas = parsearExchangeInfo({
      symbols: [
        par("BTCFDUSD", "BTC", "FDUSD"),
        par("FDUSDUSD", "FDUSD", "USD"),
        par("USDTUSD", "USDT", "USD"),
        par("USDTUSDC", "USDT", "USDC"),
      ],
    }).reglas;
    expect(descubrirRuta("BTC", reglas)).toBeNull();
  });

  it("es determinista y no depende del orden en que llegan los pares", () => {
    const info = exchangeInfo();
    const invertida = { ...info, symbols: [...info.symbols].reverse() };
    expect(descubrirRuta("HSK", parsearExchangeInfo(invertida).reglas)).toEqual(descubrirRuta("HSK", reglasDe()));
  });

  it("un activo que el exchange no lista no tiene ruta", () => {
    expect(descubrirRuta("ETC", reglasDe())).toBeNull();
  });
});

describe("rutasDeActivos y pasosPermitidos", () => {
  it("da la ruta de cada activo que se sabe convertir", () => {
    const rutas = rutasDeActivos(reglasDe());
    expect(resumen(rutas.BTC)).toEqual(["SELL BTCUSDT", "SELL USDTUSDC"]);
    expect(resumen(rutas.HSK)).toEqual(["SELL HSKUSD", "BUY USDTUSD", "SELL USDTUSDC"]);
  });

  it("omite el activo que no tiene camino", () => {
    const rutas = rutasDeActivos(reglasDe({ detenidos: ["HSKUSD"] }));
    expect(rutas.HSK).toBeUndefined();
    expect(rutas.BTC).toBeDefined();
  });

  it("reune las operaciones de todas las rutas", () => {
    const permitidos = pasosPermitidos(reglasDe());
    expect(new Set(permitidos.map((p) => `${p.side} ${p.symbol}`))).toEqual(
      new Set(["SELL BTCUSDT", "SELL USDTUSDC", "SELL HSKUSD", "BUY USDTUSD"]),
    );
  });
});

describe("ordenPermitida", () => {
  const permitidos = pasosPermitidos(reglasDe());

  it("permite solo las operaciones de la ruta, en su sentido", () => {
    expect(ordenPermitida("BTCUSDT", "SELL", permitidos)).toBe(true);
    expect(ordenPermitida("USDTUSDC", "SELL", permitidos)).toBe(true);
    expect(ordenPermitida("HSKUSD", "SELL", permitidos)).toBe(true);
    expect(ordenPermitida("USDTUSD", "BUY", permitidos)).toBe(true);
  });

  it("rechaza comprar lo que se va a vender, operar otros pares y el sentido contrario", () => {
    expect(ordenPermitida("BTCUSDT", "BUY", permitidos)).toBe(false);
    expect(ordenPermitida("HSKUSD", "BUY", permitidos)).toBe(false);
    expect(ordenPermitida("USDTUSD", "SELL", permitidos)).toBe(false);
    expect(ordenPermitida("ETHUSD", "SELL", permitidos)).toBe(false);
    expect(ordenPermitida("", "SELL", permitidos)).toBe(false);
  });

  it("no permite nada si no hay ruta", () => {
    expect(ordenPermitida("BTCUSDT", "SELL", [])).toBe(false);
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

  it("lee las redes de cada moneda", () => {
    const info = parsearExchangeInfo(exchangeInfo());
    expect(info.monedas["BTC"]).toEqual([
      { chainType: "Bitcoin", allowDeposit: true, allowWithdraw: true, minWithdrawQuantity: "0.005", withdrawFee: "0.00003" },
    ]);
    expect(info.monedas["USDC"]?.map((r) => r.chainType)).toEqual(["ERC20", "Base", "XDC"]);
  });

  it("omite un par al que le falta una regla, sin inventarla", () => {
    const info = parsearExchangeInfo({
      symbols: [par("ROTO", "X", "Y", { filters: [{ filterType: "PRICE_FILTER", tickSize: "0.1" }] })],
    });
    expect(info.reglas["ROTO"]).toBeUndefined();
  });

  it("una red sin minimo o sin comision no cuenta como retiro disponible", () => {
    const info = parsearExchangeInfo({
      coins: [{ coinId: "USDC", chainTypes: [{ chainType: "ERC20", allowWithdraw: true, withdrawFee: "1" }] }],
    });
    expect(info.monedas["USDC"]?.[0]?.allowWithdraw).toBe(false);
  });

  it("rechaza una respuesta que no es un objeto", () => {
    expect(() => parsearExchangeInfo([])).toThrow(HashKeyPublicoError);
    expect(() => parsearExchangeInfo(null)).toThrow(HashKeyPublicoError);
  });

  it("tolera un cuerpo vacio", () => {
    expect(parsearExchangeInfo({})).toEqual({ reglas: {}, monedas: {} });
  });

  it("omite lo que no tiene la forma esperada", () => {
    const info = parsearExchangeInfo({
      symbols: [
        null,
        "no soy un objeto",
        // Sin la lista de filtros: no hay reglas que leer.
        { symbol: "SINFILTROS", baseAsset: "A", quoteAsset: "B", status: "TRADING" },
        // Sin estado: el par se conserva, pero no figura como operando.
        { symbol: "SINESTADO", baseAsset: "A", quoteAsset: "B", filters: filtros("0.1", "0.1", "1", "1") },
      ],
      coins: [null, { coinId: "SINREDES" }, { coinId: "CONREDES", chainTypes: [null, {}, red("ERC20")] }],
    });
    expect(Object.keys(info.reglas)).toEqual(["SINESTADO"]);
    expect(info.reglas["SINESTADO"]?.status).toBe("DESCONOCIDO");
    expect(info.reglas["SINESTADO"]?.retailAllowed).toBe(false);
    expect(Object.keys(info.monedas)).toEqual(["CONREDES"]);
    expect(info.monedas["CONREDES"]).toHaveLength(1);
  });
});

describe("redes de depositos y retiros", () => {
  const { monedas } = parsearExchangeInfo(exchangeInfo());

  it("lista las redes por las que el exchange recibe un activo", () => {
    expect(redesDeDeposito("BTC", monedas)).toEqual(["Bitcoin"]);
    expect(redesDeDeposito("HSK", monedas)).toEqual(["HashKey Chain", "ERC20"]);
    expect(redesDeDeposito("ETC", monedas)).toEqual([]);
  });

  it("no lista las redes de deposito deshabilitadas", () => {
    expect(redesDeDeposito("USDC", monedas)).toEqual(["ERC20", "XDC"]);
  });

  it("lista las redes por las que entrega USDC", () => {
    expect(redesDeRetiroUsdc(monedas)).toEqual(["ERC20", "XDC"]);
    expect(redesDeRetiroUsdc({})).toEqual([]);
  });
});

describe("elegirRetiroUsdc", () => {
  it("sin Linea, saca el USDC por Ethereum y avisa que hay que pasarlo", () => {
    const { monedas } = parsearExchangeInfo(exchangeInfo());
    expect(elegirRetiroUsdc(monedas)).toEqual({ chain: "ERC20", comision: "1", minimo: "25", esLinea: false });
  });

  it("si el exchange retira directo a Linea, usa esa red", () => {
    const { monedas } = parsearExchangeInfo(exchangeInfo({ linea: true }));
    expect(elegirRetiroUsdc(monedas)).toEqual({ chain: "Linea", comision: "0.5", minimo: "10", esLinea: true });
  });

  it("no elige una red barata que no lleva a Linea", () => {
    // XDC no cobra comision, pero de XDC no se llega a Linea.
    const { monedas } = parsearExchangeInfo(exchangeInfo({ erc20Withdraw: false }));
    expect(elegirRetiroUsdc(monedas)).toBeNull();
  });

  it("no hay retiro si USDC no aparece", () => {
    expect(elegirRetiroUsdc({})).toBeNull();
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
});

describe("tasaDeRuta", () => {
  const pasos = (activo: "BTC" | "HSK") => rutasDeActivos(reglasDe())[activo]!;

  it("compone la venta de BTC a USDT y de USDT a USDC", () => {
    const tasa = tasaDeRuta(pasos("BTC"), { BTCUSDT: "81238.79", USDTUSDC: "0.9994" });
    // 81238.79 * 0.9994 = 81190.046726
    expect(tasa).toBe(81_190_046_726_000_000_000_000n);
  });

  it("para HSK compra USDT con USD: divide por el precio de USDT/USD", () => {
    // Con USDT a exactamente 1 USD, el paso de compra no cambia nada.
    const tasa = tasaDeRuta(pasos("HSK"), { HSKUSD: "0.09826", USDTUSD: "1", USDTUSDC: "0.9994" });
    // 0.09826 * 0.9994 = 0.098201044
    expect(tasa).toBe(98_201_044_000_000_000n);
  });

  it("un USDT mas caro que 1 USD deja menos USDT por cada USD", () => {
    const barato = tasaDeRuta(pasos("HSK"), { HSKUSD: "0.1", USDTUSD: "0.99", USDTUSDC: "1" });
    const caro = tasaDeRuta(pasos("HSK"), { HSKUSD: "0.1", USDTUSD: "1.01", USDTUSDC: "1" });
    expect(barato > caro).toBe(true);
  });

  it("falla si falta un precio o es cero", () => {
    expect(() => tasaDeRuta(pasos("BTC"), { BTCUSDT: "81238.79" })).toThrow(/falta el precio de USDTUSDC/);
    expect(() => tasaDeRuta(pasos("BTC"), { BTCUSDT: "0", USDTUSDC: "1" })).toThrow(/precio invalido/);
  });
});

describe("leerMercadoRuta", () => {
  const precios = {
    "symbol=BTCUSDT": { cuerpo: [{ s: "BTCUSDT", p: "81238.79" }] },
    "symbol=USDTUSDC": { cuerpo: [{ s: "USDTUSDC", p: "0.9994" }] },
    "symbol=HSKUSD": { cuerpo: [{ s: "HSKUSD", p: "0.09826" }] },
    "symbol=USDTUSD": { cuerpo: [{ s: "USDTUSD", p: "1" }] },
  };

  it("arma rutas, redes y costos solo con lo que informa el exchange", async () => {
    const { fetchImpl } = fetchSimulado({ ...precios, exchangeInfo: { cuerpo: exchangeInfo() } });
    const mercado = await leerMercadoRuta(new HashKeyPublico("production", fetchImpl), () => 1_700_000_000_000);

    expect(resumen(mercado.rutas.BTC?.pasos)).toEqual(["SELL BTCUSDT", "SELL USDTUSDC"]);
    expect(mercado.rutas.BTC?.redesDeposito).toEqual(["Bitcoin"]);
    expect(mercado.rutas.BTC?.precioUsdc).toBe("81190.046726");
    expect(resumen(mercado.rutas.HSK?.pasos)).toEqual(["SELL HSKUSD", "BUY USDTUSD", "SELL USDTUSDC"]);
    expect(mercado.rutas.HSK?.redesDeposito).toEqual(["HashKey Chain", "ERC20"]);
    expect(mercado.rutas.HSK?.precioUsdc).toBe("0.098201044");
    expect(mercado.retiroUsdc).toEqual({ chain: "ERC20", comision: "1", minimo: "25", esLinea: false });
    expect(mercado.redesRetiroUsdc).toEqual(["ERC20", "XDC"]);
    expect(mercado.leidoEn).toBe(1_700_000_000_000);
  });

  it("si el exchange retira a Linea, lo refleja", async () => {
    const { fetchImpl } = fetchSimulado({ ...precios, exchangeInfo: { cuerpo: exchangeInfo({ linea: true }) } });
    const mercado = await leerMercadoRuta(new HashKeyPublico("production", fetchImpl));
    expect(mercado.retiroUsdc).toMatchObject({ chain: "Linea", esLinea: true });
  });

  it("solo pide el precio de los pares que forman parte de alguna ruta", async () => {
    const { fetchImpl, llamadas } = fetchSimulado({ ...precios, exchangeInfo: { cuerpo: exchangeInfo() } });
    await leerMercadoRuta(new HashKeyPublico("production", fetchImpl));
    const pedidos = llamadas.filter((url) => url.includes("ticker/price")).map((url) => url.split("symbol=")[1]);
    expect(new Set(pedidos)).toEqual(new Set(["BTCUSDT", "USDTUSDC", "HSKUSD", "USDTUSD"]));
  });

  it("sin ninguna ruta, no consulta precios y lo dice con un mapa vacio", async () => {
    const { fetchImpl, llamadas } = fetchSimulado({ exchangeInfo: { cuerpo: {} } });
    const mercado = await leerMercadoRuta(new HashKeyPublico("production", fetchImpl));
    expect(mercado.rutas).toEqual({});
    expect(mercado.retiroUsdc).toBeNull();
    expect(llamadas.some((url) => url.includes("ticker/price"))).toBe(false);
  });

  it("marca la hora de lectura con el reloj real por defecto", async () => {
    const { fetchImpl } = fetchSimulado({ exchangeInfo: { cuerpo: {} } });
    const antes = Date.now();
    const mercado = await leerMercadoRuta(new HashKeyPublico("production", fetchImpl));
    expect(mercado.leidoEn).toBeGreaterThanOrEqual(antes);
  });
});

describe("comisionDeRutaBps", () => {
  const pasos = (activo: "BTC" | "HSK") => rutasDeActivos(reglasDe())[activo]!;

  it("suma la tasa de cada operacion de la ruta", () => {
    // Dos operaciones al 0,29% son 58 bps; tres son 87.
    expect(comisionDeRutaBps(pasos("BTC"), { BTCUSDT: "0.0029", USDTUSDC: "0.0029" })).toBe(58);
    expect(comisionDeRutaBps(pasos("HSK"), { HSKUSD: "0.0029", USDTUSD: "0.0029", USDTUSDC: "0.0029" })).toBe(87);
  });

  it("suma tasas distintas por par", () => {
    expect(comisionDeRutaBps(pasos("BTC"), { BTCUSDT: "0.001", USDTUSDC: "0.0005" })).toBe(15);
  });

  it("redondea hacia arriba al basis point: una estimacion de costo no se queda corta", () => {
    expect(comisionDeRutaBps(pasos("BTC"), { BTCUSDT: "0.00291", USDTUSDC: "0" })).toBe(30);
  });

  it("una ruta sin comision cuesta cero", () => {
    expect(comisionDeRutaBps(pasos("BTC"), { BTCUSDT: "0", USDTUSDC: "0" })).toBe(0);
  });

  it("falla si falta la tasa de un par", () => {
    expect(() => comisionDeRutaBps(pasos("BTC"), { BTCUSDT: "0.0029" })).toThrow(/falta la comision de USDTUSDC/);
  });
});
