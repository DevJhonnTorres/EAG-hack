import { RATE_SCALE, type BridgeAsset } from "../domain/bridge.js";
import { decimalToFixed, formatDecimal } from "../domain/decimal.js";

/**
 * Datos publicos de HashKey Exchange: reglas de los pares, precios y libro.
 *
 * No necesita credenciales y no mueve nada. Vive separado de la parte con firma
 * (`hashkeyCuenta`) por dos motivos: la interfaz web puede usar este modulo sin
 * arrastrar `node:crypto`, y queda claro que nada de aca puede tocar una cuenta.
 */

export type HashKeyEnv = "production" | "sandbox";

export const HASHKEY_URLS: Record<HashKeyEnv, string> = {
  production: "https://api-pro.hashkey.com",
  sandbox: "https://api-pro.sim.hashkeydev.com",
};

export type Lado = "BUY" | "SELL";

/** Una operacion de la ruta hacia USDC. */
export interface PasoRuta {
  readonly symbol: string;
  readonly side: Lado;
}

/**
 * Como se llega a USDC desde cada activo, en HashKey Exchange.
 *
 * HashKey no lista ningun par de BTC contra USDC, asi que se pasa por USDT. El
 * HSK cotiza solo contra USD, y de ahi se compra USDT antes de pasar a USDC.
 */
export const PASOS_RUTA: Record<BridgeAsset, readonly PasoRuta[]> = {
  BTC: [
    { symbol: "BTCUSDT", side: "SELL" },
    { symbol: "USDTUSDC", side: "SELL" },
  ],
  HSK: [
    { symbol: "HSKUSD", side: "SELL" },
    { symbol: "USDTUSD", side: "BUY" },
    { symbol: "USDTUSDC", side: "SELL" },
  ],
};

const PERMITIDAS: ReadonlySet<string> = new Set(
  Object.values(PASOS_RUTA).flatMap((pasos) => pasos.map((paso) => `${paso.symbol}:${paso.side}`)),
);

/**
 * Lista blanca de operaciones: solo las que forman parte de la ruta a USDC.
 *
 * Es el freno mas importante del modulo de ordenes. Aunque alguien lograra pasar
 * parametros arbitrarios, no se puede comprar BTC ni operar otro par: solo vender
 * lo que se va a convertir, en el sentido que la ruta indica.
 */
export function ordenPermitida(symbol: string, side: Lado): boolean {
  return PERMITIDAS.has(`${symbol}:${side}`);
}

export function simbolosDeRuta(asset: BridgeAsset): string[] {
  return PASOS_RUTA[asset].map((paso) => paso.symbol);
}

/** Reglas de un par: el exchange rechaza toda orden que no las cumpla. */
export interface ReglasSimbolo {
  readonly symbol: string;
  readonly baseAsset: string;
  readonly quoteAsset: string;
  readonly status: string;
  /** Si una cuenta retail puede operar el par. Una cuenta que no lo es puede recibir rechazos. */
  readonly retailAllowed: boolean;
  readonly tickSize: string;
  readonly stepSize: string;
  readonly minQty: string;
  readonly minNotional: string;
}

/** Como sacar USDC del exchange. */
export interface RetiroUsdc {
  readonly chain: string;
  readonly comision: string;
  readonly minimo: string;
}

export interface InfoMercado {
  readonly reglas: Readonly<Record<string, ReglasSimbolo>>;
  /** `null` si el exchange no permite hoy retirar USDC por esa red. */
  readonly retiroUsdc: RetiroUsdc | null;
}

export class HashKeyPublicoError extends Error {
  constructor(mensaje: string) {
    super(mensaje);
    this.name = "HashKeyPublicoError";
  }
}

type Json = Record<string, unknown>;

const esObjeto = (valor: unknown): valor is Json => typeof valor === "object" && valor !== null && !Array.isArray(valor);
const texto = (valor: unknown): string | undefined => (typeof valor === "string" ? valor : undefined);

function filtro(filtros: unknown, tipo: string): Json | undefined {
  if (!Array.isArray(filtros)) return undefined;
  return filtros.find((f): f is Json => esObjeto(f) && f["filterType"] === tipo);
}

/** La red por la que se saca el USDC. HashKey lo permite por ERC20 (Ethereum). */
const RED_RETIRO_USDC = "ERC20";

/**
 * Lee la respuesta de `exchangeInfo`.
 *
 * Es defensivo: un par al que le falta una regla se omite en vez de inventar un
 * valor por defecto, porque una regla supuesta puede hacer que una orden pase el
 * chequeo local y el exchange la rechace, o peor, que no se respete un minimo.
 */
export function parsearExchangeInfo(cuerpo: unknown): InfoMercado {
  if (!esObjeto(cuerpo)) throw new HashKeyPublicoError("exchangeInfo no devolvio un objeto");

  const reglas: Record<string, ReglasSimbolo> = {};
  const simbolos = Array.isArray(cuerpo["symbols"]) ? cuerpo["symbols"] : [];

  for (const crudo of simbolos) {
    if (!esObjeto(crudo)) continue;
    const symbol = texto(crudo["symbol"]);
    const baseAsset = texto(crudo["baseAsset"]);
    const quoteAsset = texto(crudo["quoteAsset"]);
    const price = filtro(crudo["filters"], "PRICE_FILTER");
    const lot = filtro(crudo["filters"], "LOT_SIZE");
    const notional = filtro(crudo["filters"], "MIN_NOTIONAL");

    const tickSize = texto(price?.["tickSize"]);
    const stepSize = texto(lot?.["stepSize"]);
    const minQty = texto(lot?.["minQty"]);
    const minNotional = texto(notional?.["minNotional"]);

    if (!symbol || !baseAsset || !quoteAsset || !tickSize || !stepSize || !minQty || !minNotional) continue;

    reglas[symbol] = {
      symbol,
      baseAsset,
      quoteAsset,
      status: texto(crudo["status"]) ?? "DESCONOCIDO",
      retailAllowed: crudo["retailAllowed"] === true,
      tickSize,
      stepSize,
      minQty,
      minNotional,
    };
  }

  let retiroUsdc: RetiroUsdc | null = null;
  const monedas = Array.isArray(cuerpo["coins"]) ? cuerpo["coins"] : [];
  const usdc = monedas.find((m): m is Json => esObjeto(m) && m["coinId"] === "USDC");
  const redes = usdc && Array.isArray(usdc["chainTypes"]) ? usdc["chainTypes"] : [];
  const red = redes.find((r): r is Json => esObjeto(r) && r["chainType"] === RED_RETIRO_USDC);
  if (red && red["allowWithdraw"] === true) {
    const comision = texto(red["withdrawFee"]);
    const minimo = texto(red["minWithdrawQuantity"]);
    if (comision !== undefined && minimo !== undefined) {
      retiroUsdc = { chain: RED_RETIRO_USDC, comision, minimo };
    }
  }

  return { reglas, retiroUsdc };
}

/** Mejor oferta de compra y de venta del libro. */
export interface MejorPrecio {
  readonly bid: string;
  readonly ask: string;
}

export class HashKeyPublico {
  readonly #base: string;
  readonly #fetch: typeof fetch;

  constructor(env: HashKeyEnv = "production", fetchImpl?: typeof fetch) {
    this.#base = HASHKEY_URLS[env];
    this.#fetch = fetchImpl ?? fetch;
  }

  async #obtener(ruta: string): Promise<unknown> {
    const respuesta = await this.#fetch(`${this.#base}${ruta}`);
    const cuerpo: unknown = await respuesta.json().catch(() => undefined);
    if (!respuesta.ok) {
      const detalle = esObjeto(cuerpo) ? `${String(cuerpo["code"] ?? "")} ${String(cuerpo["msg"] ?? "")}`.trim() : "";
      throw new HashKeyPublicoError(`${ruta.split("?")[0]} respondio ${respuesta.status}${detalle ? `: ${detalle}` : ""}`);
    }
    return cuerpo;
  }

  async infoMercado(): Promise<InfoMercado> {
    return parsearExchangeInfo(await this.#obtener("/api/v1/exchangeInfo"));
  }

  /** Ultimo precio de cada par, como texto decimal exacto. */
  async precios(symbols: readonly string[]): Promise<Record<string, string>> {
    const pares = await Promise.all(
      symbols.map(async (symbol) => {
        const cuerpo = await this.#obtener(`/quote/v1/ticker/price?symbol=${encodeURIComponent(symbol)}`);
        const fila = Array.isArray(cuerpo) ? cuerpo[0] : undefined;
        const precio = esObjeto(fila) ? texto(fila["p"]) : undefined;
        if (precio === undefined) throw new HashKeyPublicoError(`no llego el precio de ${symbol}`);
        return [symbol, precio] as const;
      }),
    );
    return Object.fromEntries(pares);
  }

  async mejorPrecio(symbol: string): Promise<MejorPrecio> {
    const cuerpo = await this.#obtener(`/quote/v1/depth?symbol=${encodeURIComponent(symbol)}&limit=5`);
    const nivel = (lado: unknown): string | undefined => {
      const primero = Array.isArray(lado) ? lado[0] : undefined;
      return Array.isArray(primero) ? texto(primero[0]) : undefined;
    };
    const bid = esObjeto(cuerpo) ? nivel(cuerpo["b"]) : undefined;
    const ask = esObjeto(cuerpo) ? nivel(cuerpo["a"]) : undefined;
    if (bid === undefined || ask === undefined) throw new HashKeyPublicoError(`el libro de ${symbol} esta vacio`);
    return { bid, ask };
  }
}

/**
 * USDC por cada unidad del activo, componiendo el precio de cada paso de la ruta.
 *
 * Es una estimacion con el ultimo precio de cada par: no incluye el margen entre
 * compra y venta, ni las comisiones. Esas se aplican aparte, con la comision de
 * venta editable de la cotizacion.
 *
 * Devuelve punto fijo de 18 decimales, listo para `BridgeTerms.rateE18`.
 */
export function tasaDeRuta(asset: BridgeAsset, precios: Readonly<Record<string, string>>): bigint {
  let tasa = RATE_SCALE;
  for (const { symbol, side } of PASOS_RUTA[asset]) {
    const precio = precios[symbol];
    if (precio === undefined) throw new HashKeyPublicoError(`falta el precio de ${symbol}`);
    const fijo = decimalToFixed(precio, 18);
    if (fijo <= 0n) throw new HashKeyPublicoError(`precio invalido para ${symbol}: ${precio}`);
    // Vender: se recibe `precio` de la moneda cotizada por cada base. Comprar: se
    // reciben `1 / precio` bases por cada moneda cotizada que se entrega.
    tasa = side === "SELL" ? (tasa * fijo) / RATE_SCALE : (tasa * RATE_SCALE) / fijo;
  }
  return tasa;
}

/** Todo lo que la interfaz necesita para cotizar con datos reales. */
export interface MercadoRuta {
  /** USDC por 1 unidad de cada activo, como texto decimal. */
  readonly precioUsdc: Readonly<Record<BridgeAsset, string>>;
  readonly precios: Readonly<Record<string, string>>;
  readonly retiroUsdc: RetiroUsdc | null;
  readonly leidoEn: number;
}

export async function leerMercadoRuta(publico: HashKeyPublico, ahora: () => number = Date.now): Promise<MercadoRuta> {
  const simbolos = [...new Set(Object.values(PASOS_RUTA).flatMap((pasos) => pasos.map((p) => p.symbol)))];
  const [precios, info] = await Promise.all([publico.precios(simbolos), publico.infoMercado()]);

  const precioUsdc = (asset: BridgeAsset): string => formatDecimal({ units: tasaDeRuta(asset, precios), scale: 18 });

  return {
    precioUsdc: { BTC: precioUsdc("BTC"), HSK: precioUsdc("HSK") },
    precios,
    retiroUsdc: info.retiroUsdc,
    leidoEn: ahora(),
  };
}
