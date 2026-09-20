import { BRIDGE_ASSETS, RATE_SCALE, type BridgeAsset } from "../domain/bridge.js";
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
  /** Moneda base del par: la que se compra o se vende. */
  readonly base: string;
  /** Moneda cotizada: contra la que se opera. */
  readonly quote: string;
}

/** Activos que esta aplicacion sabe convertir. Cual es la ruta de cada uno la dice el exchange. */
export const ACTIVOS_DE_RUTA = Object.keys(BRIDGE_ASSETS) as BridgeAsset[];

/** Moneda en la que termina la ruta. */
export const DESTINO_RUTA = "USDC";

/**
 * Monedas por las que se acepta pasar en el camino. Sin este limite, la busqueda
 * podria encontrar un camino mas corto por un activo volatil, y una orden pasaria
 * a cambiar de exposicion en vez de solo convertir a USDC.
 */
const INTERMEDIOS: ReadonlySet<string> = new Set(["USD", "USDT", DESTINO_RUTA]);

/**
 * Encuentra el camino mas corto de `origen` a USDC con los pares que el exchange
 * tiene operando hoy.
 *
 * Es una busqueda en anchura sobre las monedas, asi que devuelve la ruta con menos
 * operaciones. Cada par se recorre en el sentido que lleva al siguiente: si la
 * moneda actual es la base se vende, si es la cotizada se compra. Los pares se
 * revisan en orden alfabetico, para que el resultado sea el mismo en cada lectura.
 *
 * Devuelve `null` si no hay camino: es informacion util, no un error. Significa
 * que el exchange no ofrece hoy como convertir ese activo.
 */
export function descubrirRuta(origen: string, reglas: Readonly<Record<string, ReglasSimbolo>>): PasoRuta[] | null {
  const pares = Object.values(reglas)
    .filter((regla) => regla.status === "TRADING")
    .sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0));

  const visitadas = new Set<string>([origen]);
  let frontera: { moneda: string; pasos: PasoRuta[] }[] = [{ moneda: origen, pasos: [] }];

  while (frontera.length > 0) {
    const siguiente: { moneda: string; pasos: PasoRuta[] }[] = [];

    for (const { moneda, pasos } of frontera) {
      for (const par of pares) {
        let lado: Lado;
        let vecina: string;
        if (par.baseAsset === moneda) {
          lado = "SELL";
          vecina = par.quoteAsset;
        } else if (par.quoteAsset === moneda) {
          lado = "BUY";
          vecina = par.baseAsset;
        } else {
          continue;
        }

        if (visitadas.has(vecina) || !INTERMEDIOS.has(vecina)) continue;

        const camino = [...pasos, { symbol: par.symbol, side: lado, base: par.baseAsset, quote: par.quoteAsset }];
        if (vecina === DESTINO_RUTA) return camino;

        visitadas.add(vecina);
        siguiente.push({ moneda: vecina, pasos: camino });
      }
    }
    frontera = siguiente;
  }
  return null;
}

/** La ruta de cada activo que el exchange permite convertir hoy. */
export function rutasDeActivos(
  reglas: Readonly<Record<string, ReglasSimbolo>>,
): Partial<Record<BridgeAsset, readonly PasoRuta[]>> {
  const rutas: Partial<Record<BridgeAsset, readonly PasoRuta[]>> = {};
  for (const activo of ACTIVOS_DE_RUTA) {
    const pasos = descubrirRuta(activo, reglas);
    if (pasos) rutas[activo] = pasos;
  }
  return rutas;
}

/** Todas las operaciones de todas las rutas: lo unico que el modulo de ordenes acepta. */
export function pasosPermitidos(reglas: Readonly<Record<string, ReglasSimbolo>>): PasoRuta[] {
  return Object.values(rutasDeActivos(reglas)).flat();
}

/**
 * Lista blanca de operaciones: solo las que forman parte de una ruta a USDC.
 *
 * Es el freno mas importante del modulo de ordenes. Aunque alguien lograra pasar
 * parametros arbitrarios, no se puede comprar BTC ni operar otro par: solo vender
 * lo que se va a convertir, en el sentido que la ruta indica.
 */
export function ordenPermitida(symbol: string, side: Lado, permitidos: readonly PasoRuta[]): boolean {
  return permitidos.some((paso) => paso.symbol === symbol && paso.side === side);
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

/** Una red por la que el exchange recibe o entrega una moneda. */
export interface RedMoneda {
  readonly chainType: string;
  readonly allowDeposit: boolean;
  readonly allowWithdraw: boolean;
  readonly minWithdrawQuantity: string;
  readonly withdrawFee: string;
}

/** Como sacar USDC del exchange. */
export interface RetiroUsdc {
  readonly chain: string;
  readonly comision: string;
  readonly minimo: string;
  /** `true` si el exchange retira directo a Linea. Si no, el USDC sale por otra red y hay que pasarlo. */
  readonly esLinea: boolean;
}

export interface InfoMercado {
  readonly reglas: Readonly<Record<string, ReglasSimbolo>>;
  /** Redes de cada moneda, tal como las informa el exchange. */
  readonly monedas: Readonly<Record<string, readonly RedMoneda[]>>;
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

/**
 * Red por la que se saca el USDC cuando el exchange no retira directo a Linea.
 * HashKey la llama ERC20 (Ethereum), y de Ethereum se llega a Linea con su bridge.
 */
const RED_PUENTE = "ERC20";

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

  const monedas: Record<string, RedMoneda[]> = {};
  const listaMonedas = Array.isArray(cuerpo["coins"]) ? cuerpo["coins"] : [];

  for (const moneda of listaMonedas) {
    if (!esObjeto(moneda)) continue;
    const coinId = texto(moneda["coinId"]);
    if (!coinId || !Array.isArray(moneda["chainTypes"])) continue;

    const redes: RedMoneda[] = [];
    for (const red of moneda["chainTypes"]) {
      if (!esObjeto(red)) continue;
      const chainType = texto(red["chainType"]);
      const minWithdrawQuantity = texto(red["minWithdrawQuantity"]);
      const withdrawFee = texto(red["withdrawFee"]);
      if (!chainType) continue;
      redes.push({
        chainType,
        allowDeposit: red["allowDeposit"] === true,
        // Sin minimo o sin comision no se puede cotizar un retiro: se da por no disponible.
        allowWithdraw: red["allowWithdraw"] === true && minWithdrawQuantity !== undefined && withdrawFee !== undefined,
        minWithdrawQuantity: minWithdrawQuantity ?? "",
        withdrawFee: withdrawFee ?? "",
      });
    }
    monedas[coinId] = redes;
  }

  return { reglas, monedas };
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

/** Redes por las que el exchange recibe hoy un activo. */
export function redesDeDeposito(activo: string, monedas: Readonly<Record<string, readonly RedMoneda[]>>): string[] {
  return (monedas[activo] ?? []).filter((red) => red.allowDeposit).map((red) => red.chainType);
}

/** Redes por las que el exchange entrega hoy USDC. */
export function redesDeRetiroUsdc(monedas: Readonly<Record<string, readonly RedMoneda[]>>): string[] {
  return (monedas[DESTINO_RUTA] ?? []).filter((red) => red.allowWithdraw).map((red) => red.chainType);
}

/**
 * Como sacar el USDC hacia Linea, segun lo que el exchange permite hoy.
 *
 * Si retira directo a Linea, se usa esa red. Si no, se usa Ethereum (ERC20), desde
 * donde se llega a Linea con su bridge. Otras redes, como XDC, pueden tener menor
 * comision pero no llevan a Linea, asi que no se eligen.
 *
 * `null` significa que el exchange no ofrece hoy ninguna salida de USDC que lleve
 * a Linea.
 */
export function elegirRetiroUsdc(monedas: Readonly<Record<string, readonly RedMoneda[]>>): RetiroUsdc | null {
  const habilitadas = (monedas[DESTINO_RUTA] ?? []).filter((red) => red.allowWithdraw);
  const linea = habilitadas.find((red) => /linea/i.test(red.chainType));
  const elegida = linea ?? habilitadas.find((red) => red.chainType === RED_PUENTE);
  if (!elegida) return null;
  return {
    chain: elegida.chainType,
    comision: elegida.withdrawFee,
    minimo: elegida.minWithdrawQuantity,
    esLinea: elegida === linea,
  };
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
export function tasaDeRuta(pasos: readonly PasoRuta[], precios: Readonly<Record<string, string>>): bigint {
  let tasa = RATE_SCALE;
  for (const { symbol, side } of pasos) {
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

/**
 * Comision total de recorrer una ruta, en basis points.
 *
 * Suma la tasa de cada paso. Es una cota ligeramente alta: cada comision se cobra
 * sobre un monto ya reducido por las anteriores, pero la diferencia es del orden
 * de una centesima de punto basico, y una estimacion de costo debe errar por
 * exceso. Se redondea hacia arriba al basis point.
 *
 * `tasas` son las tasas de cada par como fraccion decimal: `0.002` es 0,20%.
 */
export function comisionDeRutaBps(pasos: readonly PasoRuta[], tasas: Readonly<Record<string, string>>): number {
  let total = 0n;
  for (const { symbol } of pasos) {
    const tasa = tasas[symbol];
    if (tasa === undefined) throw new HashKeyPublicoError(`falta la comision de ${symbol}`);
    total += decimalToFixed(tasa, 18);
  }
  return Number((total * 10_000n + RATE_SCALE - 1n) / RATE_SCALE);
}

/** Lo que el exchange informa hoy sobre como convertir un activo a USDC. */
export interface RutaActivo {
  readonly pasos: readonly PasoRuta[];
  /** Redes por las que el exchange recibe el activo. */
  readonly redesDeposito: readonly string[];
  /** USDC por 1 unidad del activo, como texto decimal. */
  readonly precioUsdc: string;
}

/** Todo lo que la interfaz necesita para cotizar con datos reales. Sale integramente del exchange. */
export interface MercadoRuta {
  /** Solo los activos para los que el exchange ofrece hoy un camino a USDC. */
  readonly rutas: Readonly<Partial<Record<BridgeAsset, RutaActivo>>>;
  readonly precios: Readonly<Record<string, string>>;
  /** `null` si el exchange no ofrece hoy una salida de USDC que lleve a Linea. */
  readonly retiroUsdc: RetiroUsdc | null;
  /** Todas las redes por las que el exchange entrega USDC hoy. */
  readonly redesRetiroUsdc: readonly string[];
  readonly leidoEn: number;
}

export async function leerMercadoRuta(publico: HashKeyPublico, ahora: () => number = Date.now): Promise<MercadoRuta> {
  const info = await publico.infoMercado();
  const pasosPorActivo = rutasDeActivos(info.reglas);

  const simbolos = [...new Set(Object.values(pasosPorActivo).flatMap((pasos) => pasos.map((paso) => paso.symbol)))];
  const precios = simbolos.length > 0 ? await publico.precios(simbolos) : {};

  const rutas: Partial<Record<BridgeAsset, RutaActivo>> = {};
  for (const activo of ACTIVOS_DE_RUTA) {
    const pasos = pasosPorActivo[activo];
    if (!pasos) continue;
    rutas[activo] = {
      pasos,
      redesDeposito: redesDeDeposito(activo, info.monedas),
      precioUsdc: formatDecimal({ units: tasaDeRuta(pasos, precios), scale: 18 }),
    };
  }

  return {
    rutas,
    precios,
    retiroUsdc: elegirRetiroUsdc(info.monedas),
    redesRetiroUsdc: redesDeRetiroUsdc(info.monedas),
    leidoEn: ahora(),
  };
}
