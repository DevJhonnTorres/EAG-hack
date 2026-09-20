import { describe, expect, it } from "@jest/globals";
import {
  HashKeyCuenta,
  HashKeyError,
  OrdenRechazadaError,
  decimalPositivo,
  firmar,
  planificarOrden,
  type LimitesOrden,
  type OrdenPlan,
} from "../src/adapters/hashkeyCuenta.js";
import type { PasoRuta, ReglasSimbolo } from "../src/adapters/hashkeyMercado.js";

const SECRETO = "secreto-de-prueba-que-no-debe-aparecer-en-ningun-mensaje";
const CLAVE = "clave-de-prueba";

const BTCUSDT: ReglasSimbolo = {
  symbol: "BTCUSDT",
  baseAsset: "BTC",
  quoteAsset: "USDT",
  status: "TRADING",
  retailAllowed: false,
  tickSize: "0.01",
  stepSize: "0.00001",
  minQty: "0.0003",
  minNotional: "10",
};

const USDTUSD: ReglasSimbolo = {
  symbol: "USDTUSD",
  baseAsset: "USDT",
  quoteAsset: "USD",
  status: "TRADING",
  retailAllowed: false,
  tickSize: "0.0001",
  stepSize: "0.00001",
  minQty: "10",
  minNotional: "10",
};

const LIBRO_BTC = { bid: "81229.52", ask: "81229.53" };

/** Las operaciones de la ruta a USDC, tal como las descubre `descubrirRuta` con los pares reales. */
const PERMITIDOS: PasoRuta[] = [
  { symbol: "BTCUSDT", side: "SELL", base: "BTC", quote: "USDT" },
  { symbol: "USDTUSDC", side: "SELL", base: "USDT", quote: "USDC" },
  { symbol: "HSKUSD", side: "SELL", base: "HSK", quote: "USD" },
  { symbol: "USDTUSD", side: "BUY", base: "USDT", quote: "USD" },
];

const planificar = (
  entrada: Parameters<typeof planificarOrden>[0],
  reglas: Parameters<typeof planificarOrden>[1],
  libro: Parameters<typeof planificarOrden>[2],
  limites: Parameters<typeof planificarOrden>[3],
  permitidos: readonly PasoRuta[] = PERMITIDOS,
) => planificarOrden(entrada, reglas, libro, limites, permitidos);
const LIMITES: LimitesOrden = { maxOrderUsd: "100", maxSlippageBps: 50 };

describe("firmar", () => {
  it("reproduce el ejemplo de la documentacion oficial de HashKey", () => {
    const secreto = "lH3ELTNiFxCQTmi9pPcWWikhsjO04Yoqw3euoHUuOLC3GYBW64ZqzQsiOEHXQS76";
    const total =
      "symbol=ETHBTC&side=BUY&type=LIMIT&timeInForce=GTC&quantity=1&price=0.1&recvWindow=5000&timestamp=1538323200000";
    expect(firmar(secreto, total)).toBe("5f2750ad7589d1d40757a55342e621a44037dad23b5128cc70e18ec1d1c3f4c6");
  });

  it("cambia por completo si cambia un solo caracter", () => {
    expect(firmar("a", "x=1")).not.toBe(firmar("a", "x=2"));
    expect(firmar("a", "x=1")).not.toBe(firmar("b", "x=1"));
  });
});

describe("planificarOrden", () => {
  it("vende redondeando la cantidad al paso y fijando un precio limite protegido", () => {
    const plan = planificar({ symbol: "BTCUSDT", side: "SELL", quantity: "0.001239" }, BTCUSDT, LIBRO_BTC, LIMITES);
    expect(plan).toEqual({
      symbol: "BTCUSDT",
      side: "SELL",
      type: "LIMIT",
      timeInForce: "IOC",
      // 0.001239 baja al paso de 0.00001.
      quantity: "0.00123",
      // 81229.52 * 0.995 = 80823.3724, bajado al tick de 0.01.
      price: "80823.37",
      notional: "99.4127451",
    });
  });

  it("al comprar, el precio limite queda por encima del mejor vendedor", () => {
    const plan = planificar(
      { symbol: "USDTUSD", side: "BUY", quantity: "25" },
      USDTUSD,
      { bid: "0.9998", ask: "1.0002" },
      LIMITES,
    );
    // 1.0002 * 1.005 = 1.005201, bajado al tick de 0.0001.
    expect(plan.price).toBe("1.0052");
    expect(plan.notional).toBe("25.13");
  });

  it("nunca deja el precio de una venta por debajo del margen permitido", () => {
    const plan = planificar(
      { symbol: "BTCUSDT", side: "SELL", quantity: "0.002" },
      BTCUSDT,
      LIBRO_BTC,
      { maxOrderUsd: "1000", maxSlippageBps: 0 },
    );
    // Sin margen, se vende al mejor comprador y no menos.
    expect(plan.price).toBe("81229.52");
  });

  describe("rechazos", () => {
    const orden = (o: Partial<{ symbol: string; side: "BUY" | "SELL"; quantity: string }> = {}) => ({
      symbol: "BTCUSDT",
      side: "SELL" as const,
      quantity: "0.001",
      ...o,
    });

    it("una operacion que no es de la ruta", () => {
      expect(() => planificar(orden({ side: "BUY" }), BTCUSDT, LIBRO_BTC, LIMITES)).toThrow(OrdenRechazadaError);
      expect(() => planificar(orden({ symbol: "ETHUSD" }), BTCUSDT, LIBRO_BTC, LIMITES)).toThrow(
        /no forma parte de la ruta/,
      );
    });

    it("sin ninguna ruta permitida no se acepta nada", () => {
      expect(() => planificar(orden(), BTCUSDT, LIBRO_BTC, LIMITES, [])).toThrow(/no forma parte de la ruta/);
    });

    it("un par sin reglas o que no esta operando", () => {
      expect(() => planificar(orden(), undefined, LIBRO_BTC, LIMITES)).toThrow(/no informo las reglas/);
      expect(() => planificar(orden(), { ...BTCUSDT, status: "HALT" }, LIBRO_BTC, LIMITES)).toThrow(
        /no esta operando/,
      );
    });

    it("una cantidad bajo el minimo, incluso si solo lo esta despues de redondear", () => {
      expect(() => planificar(orden({ quantity: "0.0001" }), BTCUSDT, LIBRO_BTC, LIMITES)).toThrow(
        /bajo el minimo/,
      );
      expect(() => planificar(orden({ quantity: "0.000299999" }), BTCUSDT, LIBRO_BTC, LIMITES)).toThrow(
        /bajo el minimo/,
      );
    });

    it("un valor bajo el minimo del par", () => {
      // 0.0003 BTC son unos 24 USDT, asi que un minimo de 50 lo deja fuera.
      expect(() =>
        planificar(orden({ quantity: "0.0003" }), { ...BTCUSDT, minNotional: "50" }, LIBRO_BTC, LIMITES),
      ).toThrow(/bajo el minimo de BTCUSDT/);
    });

    it("una orden que supera el tope", () => {
      expect(() => planificar(orden({ quantity: "0.002" }), BTCUSDT, LIBRO_BTC, LIMITES)).toThrow(
        /supera el tope/,
      );
    });

    it("mide el tope con el precio de referencia, no solo con el limite", () => {
      // Con el limite, 0.00123 BTC valen 99.41; con el precio de referencia, 99.91.
      // Un tope de 99.5 debe rechazarla aunque el valor al limite lo cumpla.
      const orden123 = orden({ quantity: "0.00123" });
      expect(() =>
        planificar(orden123, BTCUSDT, LIBRO_BTC, { maxOrderUsd: "99.5", maxSlippageBps: 50 }),
      ).toThrow(/supera el tope/);
      expect(planificar(orden123, BTCUSDT, LIBRO_BTC, { maxOrderUsd: "100", maxSlippageBps: 50 }).quantity).toBe(
        "0.00123",
      );
    });

    it("limites invalidos", () => {
      for (const maxSlippageBps of [-1, 501, 1.5]) {
        expect(() => planificar(orden(), BTCUSDT, LIBRO_BTC, { maxOrderUsd: "100", maxSlippageBps })).toThrow(
          RangeError,
        );
      }
      expect(() => planificar(orden(), BTCUSDT, LIBRO_BTC, { maxOrderUsd: "0", maxSlippageBps: 50 })).toThrow(
        RangeError,
      );
    });

    it("un precio limite que redondea a cero", () => {
      expect(() =>
        planificar(orden(), BTCUSDT, { bid: "0.001", ask: "0.002" }, { maxOrderUsd: "100", maxSlippageBps: 50 }),
      ).toThrow(/precio limite invalido/);
    });
  });
});

describe("decimalPositivo", () => {
  it("acepta un decimal positivo", () => {
    expect(decimalPositivo("TOPE", " 25.5 ")).toBe("25.5");
  });

  it("rechaza lo que falta, lo invalido y el cero", () => {
    expect(() => decimalPositivo("TOPE", undefined)).toThrow(/falta TOPE/);
    expect(() => decimalPositivo("TOPE", "  ")).toThrow(/falta TOPE/);
    expect(() => decimalPositivo("TOPE", "abc")).toThrow(/decimal positivo/);
    expect(() => decimalPositivo("TOPE", "-5")).toThrow(/decimal positivo/);
    expect(() => decimalPositivo("TOPE", "0")).toThrow(/mayor que cero/);
  });
});

// --------------------------------------------------------------------
// Cliente con firma, contra un fetch simulado
// --------------------------------------------------------------------

interface Llamada {
  readonly url: string;
  readonly metodo: string | undefined;
  readonly cabeceras: Record<string, string>;
}

function clienteSimulado(respuesta: { estado?: number; cuerpo: string }) {
  const llamadas: Llamada[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    llamadas.push({ url, metodo: init?.method, cabeceras: (init?.headers ?? {}) as Record<string, string> });
    return new Response(respuesta.cuerpo, { status: respuesta.estado ?? 200 });
  }) as unknown as typeof fetch;

  const cuenta = new HashKeyCuenta({
    env: "production",
    apiKey: CLAVE,
    apiSecret: SECRETO,
    fetchImpl,
    ahora: () => 1_700_000_000_000,
  });
  return { cuenta, llamadas };
}

const PLAN: OrdenPlan = {
  symbol: "BTCUSDT",
  side: "SELL",
  type: "LIMIT",
  timeInForce: "IOC",
  quantity: "0.00123",
  price: "80823.37",
  notional: "99.4127451",
};

/** Separa la query firmada en lo que se firmo y la firma. */
function partirFirma(url: string): { ruta: string; firmado: string; firma: string } {
  const [ruta = "", query = ""] = url.split("?");
  const corte = query.lastIndexOf("&signature=");
  return { ruta, firmado: query.slice(0, corte), firma: query.slice(corte + "&signature=".length) };
}

describe("HashKeyCuenta", () => {
  it("exige credenciales", () => {
    expect(() => new HashKeyCuenta({ env: "sandbox", apiKey: "", apiSecret: SECRETO })).toThrow(HashKeyError);
    expect(() => new HashKeyCuenta({ env: "sandbox", apiKey: CLAVE, apiSecret: "" })).toThrow(HashKeyError);
  });

  it("consulta saldos con la clave en la cabecera y la firma sobre la query exacta", async () => {
    const { cuenta, llamadas } = clienteSimulado({
      cuerpo: JSON.stringify({ balances: [{ asset: "BTC", total: "0.5", free: "0.4", locked: "0.1" }] }),
    });

    expect(await cuenta.saldos()).toEqual([{ asset: "BTC", total: "0.5", free: "0.4", locked: "0.1" }]);

    const llamada = llamadas[0]!;
    expect(llamada.metodo).toBe("GET");
    expect(llamada.cabeceras["X-HK-APIKEY"]).toBe(CLAVE);

    const { ruta, firmado, firma } = partirFirma(llamada.url);
    expect(ruta).toBe("https://api-pro.hashkey.com/api/v1/account");
    expect(firmado).toBe("recvWindow=5000&timestamp=1700000000000");
    // La firma es la que el exchange recalcularia con el secreto.
    expect(firma).toBe(firmar(SECRETO, firmado));
  });

  it("prueba una orden en el endpoint que no la envia al motor", async () => {
    const { cuenta, llamadas } = clienteSimulado({ cuerpo: "{}" });
    await expect(cuenta.probarOrden(PLAN)).resolves.toBeUndefined();

    const llamada = llamadas[0]!;
    expect(llamada.metodo).toBe("POST");
    expect(llamada.cabeceras["Content-Type"]).toBe("application/x-www-form-urlencoded");
    const { ruta, firmado, firma } = partirFirma(llamada.url);
    expect(ruta).toBe("https://api-pro.hashkey.com/api/v1/spot/orderTest");
    expect(firmado).toBe(
      "symbol=BTCUSDT&side=SELL&type=LIMIT&timeInForce=IOC&quantity=0.00123&price=80823.37&recvWindow=5000&timestamp=1700000000000",
    );
    expect(firma).toBe(firmar(SECRETO, firmado));
  });

  it("crea la orden con su id de cliente y conserva un orderId de 64 bits sin redondearlo", async () => {
    const { cuenta, llamadas } = clienteSimulado({
      cuerpo: '{"orderId":1234567890123456789,"clientOrderId":"hp-1","status":"FILLED","executedQty":"0.00123"}',
    });

    const orden = await cuenta.crearOrden(PLAN, "hp-1");
    // JSON.parse habria devuelto 1234567890123456800.
    expect(orden).toEqual({ orderId: "1234567890123456789", clientOrderId: "hp-1", status: "FILLED", executedQty: "0.00123" });

    const { ruta, firmado } = partirFirma(llamadas[0]!.url);
    expect(ruta).toBe("https://api-pro.hashkey.com/api/v1.1/spot/order");
    expect(firmado).toContain("newClientOrderId=hp-1");
  });

  it("consulta una orden y lee lo ejecutado", async () => {
    const { cuenta, llamadas } = clienteSimulado({
      cuerpo: JSON.stringify({
        orderId: "42",
        status: "FILLED",
        executedQty: "0.00123",
        cumulativeQuoteQty: "99.4",
        avgPrice: "80813.01",
      }),
    });
    expect(await cuenta.consultarOrden("42")).toEqual({
      orderId: "42",
      clientOrderId: "",
      status: "FILLED",
      executedQty: "0.00123",
      cumulativeQuoteQty: "99.4",
      avgPrice: "80813.01",
    });
    expect(partirFirma(llamadas[0]!.url).firmado).toContain("orderId=42");
  });

  it("rechaza un orderId que no es numerico, sin llamar a la red", async () => {
    const { cuenta, llamadas } = clienteSimulado({ cuerpo: "{}" });
    await expect(cuenta.consultarOrden("42&otra=1")).rejects.toThrow(RangeError);
    expect(llamadas).toHaveLength(0);
  });

  it("falla si la creacion no devuelve un orderId", async () => {
    const { cuenta } = clienteSimulado({ cuerpo: "{}" });
    await expect(cuenta.crearOrden(PLAN, "hp-2")).rejects.toThrow(/no devolvio un orderId/);
  });

  describe("errores", () => {
    it("traduce un rechazo del exchange sin filtrar credenciales ni la firma", async () => {
      const { cuenta } = clienteSimulado({ estado: 400, cuerpo: '{"code":"-1002","msg":"Unauthorized operation"}' });
      const error = await cuenta.saldos().catch((e: unknown) => e);

      expect(error).toBeInstanceOf(HashKeyError);
      const fallo = error as HashKeyError;
      expect(fallo.estado).toBe(400);
      expect(fallo.codigo).toBe("-1002");
      expect(fallo.message).toContain("Unauthorized operation");
      for (const secreto of [SECRETO, CLAVE, "signature"]) expect(fallo.message).not.toContain(secreto);
    });

    it("trata como error un 200 con un codigo de fallo", async () => {
      const { cuenta } = clienteSimulado({ cuerpo: '{"code":"-1130","msg":"Invalid parameter"}' });
      await expect(cuenta.probarOrden(PLAN)).rejects.toMatchObject({ codigo: "-1130" });
    });

    it("acepta un codigo 0 como exito", async () => {
      const { cuenta } = clienteSimulado({ cuerpo: '{"code":0}' });
      await expect(cuenta.probarOrden(PLAN)).resolves.toBeUndefined();
    });

    it("maneja una respuesta que no es JSON", async () => {
      const { cuenta } = clienteSimulado({ estado: 502, cuerpo: "<html>Bad Gateway</html>" });
      await expect(cuenta.saldos()).rejects.toThrow(/502.*respuesta no valida/);
    });
  });
});

describe("respuestas malformadas del exchange (cuenta)", () => {
  it("un cuerpo de saldos sin balances da una lista vacia", async () => {
    for (const cuerpo of ["{}", "[]", '{"balances":"x"}']) {
      const { cuenta } = clienteSimulado({ cuerpo });
      expect(await cuenta.saldos()).toEqual([]);
    }
  });

  it("un saldo con campos ausentes usa valores neutros y descarta lo que no es un objeto", async () => {
    const { cuenta } = clienteSimulado({ cuerpo: JSON.stringify({ balances: [{}, 7, null, { asset: "BTC" }] }) });
    expect(await cuenta.saldos()).toEqual([
      { asset: "?", total: "0", free: "0", locked: "0" },
      { asset: "BTC", total: "0", free: "0", locked: "0" },
    ]);
  });

  it("una respuesta vacia con estado 200 se toma como exito", async () => {
    const { cuenta } = clienteSimulado({ cuerpo: "   " });
    await expect(cuenta.probarOrden(PLAN)).resolves.toBeUndefined();
  });

  it("un rechazo sin mensaje se reporta igual", async () => {
    const { cuenta } = clienteSimulado({ estado: 400, cuerpo: '{"code":"-1000"}' });
    await expect(cuenta.saldos()).rejects.toThrow(/400: sin detalle/);
  });

  it("un rechazo cuyo cuerpo no es un objeto se reporta como respuesta no valida", async () => {
    const { cuenta } = clienteSimulado({ estado: 400, cuerpo: "[1,2]" });
    await expect(cuenta.saldos()).rejects.toThrow(/respuesta no valida/);
  });

  it("consultar una orden con campos ausentes usa valores neutros", async () => {
    const { cuenta } = clienteSimulado({ cuerpo: '{"orderId":9}' });
    expect(await cuenta.consultarOrden("9")).toEqual({
      orderId: "9",
      clientOrderId: "",
      status: "DESCONOCIDO",
      executedQty: "0",
      cumulativeQuoteQty: "0",
      avgPrice: "0",
    });
  });

  it("consultar una orden cuyo cuerpo no es un objeto falla por falta de orderId", async () => {
    const { cuenta } = clienteSimulado({ cuerpo: "[]" });
    await expect(cuenta.consultarOrden("9")).rejects.toThrow(/no devolvio un orderId/);
  });

  it("crear una orden usa el id de cliente enviado si el exchange no lo devuelve", async () => {
    const { cuenta } = clienteSimulado({ cuerpo: '{"orderId":5,"status":"NEW"}' });
    expect(await cuenta.crearOrden(PLAN, "hp-9")).toMatchObject({ orderId: "5", clientOrderId: "hp-9", status: "NEW", executedQty: "0" });
  });

  it("usa el fetch global y el reloj real si no se le indican otros", () => {
    expect(() => new HashKeyCuenta({ env: "sandbox", apiKey: CLAVE, apiSecret: SECRETO })).not.toThrow();
  });
});

describe("HashKeyCuenta.comisiones", () => {
  const respuestaReal = JSON.stringify({
    vipLevel: "0",
    tradeVol30Day: "0",
    data: [
      { symbol: "BTCUSDT", actualTakerRate: "0.0029", actualMakerRate: "0.0021" },
      { symbol: "USDTUSDC", actualTakerRate: "0.0029", actualMakerRate: "0.0029" },
    ],
  });

  it("lee el nivel VIP y la tasa de cada par", async () => {
    const { cuenta } = clienteSimulado({ cuerpo: respuestaReal });
    expect(await cuenta.comisiones(["BTCUSDT", "USDTUSDC"])).toEqual({
      vipLevel: "0",
      tradeVol30Day: "0",
      pares: [
        { symbol: "BTCUSDT", taker: "0.0029", maker: "0.0021" },
        { symbol: "USDTUSDC", taker: "0.0029", maker: "0.0029" },
      ],
    });
  });

  it("firma la lista de pares con la coma sin codificar, como la documenta el exchange", async () => {
    const { cuenta, llamadas } = clienteSimulado({ cuerpo: respuestaReal });
    await cuenta.comisiones(["BTCUSDT", "USDTUSDC"]);

    const { ruta, firmado, firma } = partirFirma(llamadas[0]!.url);
    expect(ruta).toBe("https://api-pro.hashkey.com/api/v1/account/vipInfo");
    expect(firmado).toBe("symbols=BTCUSDT,USDTUSDC&recvWindow=5000&timestamp=1700000000000");
    expect(firma).toBe(firmar(SECRETO, firmado));
  });

  it("descarta las filas incompletas y usa valores neutros si faltan los totales", async () => {
    const { cuenta } = clienteSimulado({
      cuerpo: JSON.stringify({
        data: [null, 3, { symbol: "A" }, { symbol: "B", actualTakerRate: "0.1" }, { symbol: "C", actualTakerRate: "0.1", actualMakerRate: "0.05" }],
      }),
    });
    expect(await cuenta.comisiones(["C"])).toEqual({
      vipLevel: "desconocido",
      tradeVol30Day: "0",
      pares: [{ symbol: "C", taker: "0.1", maker: "0.05" }],
    });
  });

  it("un cuerpo sin la lista da cero pares", async () => {
    for (const cuerpo of ["{}", '{"data":"x"}']) {
      const { cuenta } = clienteSimulado({ cuerpo });
      expect((await cuenta.comisiones(["BTCUSDT"])).pares).toEqual([]);
    }
  });
});
