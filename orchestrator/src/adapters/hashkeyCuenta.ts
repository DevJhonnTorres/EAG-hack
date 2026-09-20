import { createHmac } from "node:crypto";
import { compareDecimal, factorBps, floorToStep, mulDecimal, parseDecimal } from "../domain/decimal.js";
import {
  HASHKEY_URLS,
  ordenPermitida,
  type HashKeyEnv,
  type Lado,
  type MejorPrecio,
  type ReglasSimbolo,
} from "./hashkeyMercado.js";

/**
 * Operar una cuenta de HashKey Exchange: saldos y ordenes.
 *
 * Este modulo NO se exporta desde el indice del paquete a proposito. Usa
 * `node:crypto` y maneja una clave que puede mover dinero real, asi que solo lo
 * importa el script local (`tools/hashkey.mjs`). La interfaz web, que esta
 * desplegada publicamente, no puede alcanzarlo: cualquiera que abriera la pagina
 * podria disparar ordenes si el endpoint viviera ahi.
 *
 * No implementa retiros. Sacar fondos del exchange se hace a mano, a una
 * direccion en la whitelist de la cuenta.
 */

/** HMAC-SHA256 en hexadecimal, como exige el exchange. */
export function firmar(secreto: string, totalParams: string): string {
  return createHmac("sha256", secreto).update(totalParams).digest("hex");
}

export class HashKeyError extends Error {
  constructor(
    readonly estado: number,
    readonly codigo: string | undefined,
    mensaje: string,
  ) {
    super(mensaje);
    this.name = "HashKeyError";
  }
}

export class OrdenRechazadaError extends Error {
  constructor(motivo: string) {
    super(motivo);
    this.name = "OrdenRechazadaError";
  }
}

// --------------------------------------------------------------------
// Planificacion de una orden: todo lo que se decide antes de tocar la red
// --------------------------------------------------------------------

export interface EntradaOrden {
  readonly symbol: string;
  readonly side: Lado;
  /** Cantidad del activo base, como texto decimal. */
  readonly quantity: string;
}

export interface LimitesOrden {
  /** Tope del valor de una orden, en la moneda cotizada (USD, USDT o USDC). */
  readonly maxOrderUsd: string;
  /** Margen maximo de precio respecto del mejor precio del libro, en basis points. */
  readonly maxSlippageBps: number;
}

/** Una orden lista para enviarse. Todo campo esta ya redondeado a las reglas del par. */
export interface OrdenPlan {
  readonly symbol: string;
  readonly side: Lado;
  readonly type: "LIMIT";
  readonly timeInForce: "IOC";
  readonly quantity: string;
  readonly price: string;
  /** `quantity * price`: lo que el exchange cuenta como valor de la orden. */
  readonly notional: string;
}

const SLIPPAGE_MAXIMO_BPS = 500;

/**
 * Decide si una orden se puede enviar y con que parametros.
 *
 * Es pura: no llama a la red. Recibe las reglas del par y el mejor precio del
 * libro ya leidos, y devuelve la orden exacta o la rechaza con un motivo.
 *
 * La orden es LIMIT con `IOC` (se ejecuta al instante o se cancela) a un precio
 * protegido: nunca peor que el mejor precio del libro menos el margen de
 * `maxSlippageBps`. Una orden de mercado en un libro fino puede ejecutarse a un
 * precio muy alejado del que se vio; esta no.
 */
export function planificarOrden(
  entrada: EntradaOrden,
  reglas: ReglasSimbolo | undefined,
  libro: MejorPrecio,
  limites: LimitesOrden,
): OrdenPlan {
  const { symbol, side } = entrada;

  if (!ordenPermitida(symbol, side)) {
    throw new OrdenRechazadaError(`${side} ${symbol} no forma parte de la ruta a USDC`);
  }
  if (!reglas) throw new OrdenRechazadaError(`el exchange no informo las reglas de ${symbol}`);
  if (reglas.status !== "TRADING") throw new OrdenRechazadaError(`${symbol} no esta operando (${reglas.status})`);

  if (!Number.isInteger(limites.maxSlippageBps) || limites.maxSlippageBps < 0 || limites.maxSlippageBps > SLIPPAGE_MAXIMO_BPS) {
    throw new RangeError(`el margen de precio debe estar entre 0 y ${SLIPPAGE_MAXIMO_BPS} bps`);
  }
  if (compareDecimal(limites.maxOrderUsd, "0") <= 0) throw new RangeError("el tope por orden debe ser positivo");

  const quantity = floorToStep(entrada.quantity, reglas.stepSize);
  if (compareDecimal(quantity, reglas.minQty) < 0) {
    throw new OrdenRechazadaError(
      `cantidad ${quantity} bajo el minimo de ${symbol} (${reglas.minQty}); el paso es ${reglas.stepSize}`,
    );
  }

  // Al vender se acepta a lo sumo un margen por debajo del mejor comprador; al
  // comprar, a lo sumo un margen por encima del mejor vendedor.
  const referencia = side === "SELL" ? libro.bid : libro.ask;
  const margen = factorBps(side === "SELL" ? -limites.maxSlippageBps : limites.maxSlippageBps);
  const price = floorToStep(mulDecimal(referencia, margen), reglas.tickSize);
  if (compareDecimal(price, "0") <= 0) throw new OrdenRechazadaError(`precio limite invalido para ${symbol}`);

  const notional = mulDecimal(quantity, price);
  if (compareDecimal(notional, reglas.minNotional) < 0) {
    throw new OrdenRechazadaError(`valor ${notional} bajo el minimo de ${symbol} (${reglas.minNotional})`);
  }

  // El tope se mide con el mayor de los dos valores: el del precio limite y el del
  // precio de referencia, para que el margen no permita colar una orden mas grande.
  const valorDeReferencia = mulDecimal(quantity, referencia);
  const mayor = compareDecimal(valorDeReferencia, notional) > 0 ? valorDeReferencia : notional;
  if (compareDecimal(mayor, limites.maxOrderUsd) > 0) {
    throw new OrdenRechazadaError(`valor ${mayor} supera el tope por orden de ${limites.maxOrderUsd}`);
  }

  return { symbol, side, type: "LIMIT", timeInForce: "IOC", quantity, price, notional };
}

// --------------------------------------------------------------------
// Cliente con firma
// --------------------------------------------------------------------

export interface Saldo {
  readonly asset: string;
  readonly total: string;
  readonly free: string;
  readonly locked: string;
}

export interface RespuestaOrden {
  readonly orderId: string;
  readonly clientOrderId: string;
  readonly status: string;
  readonly executedQty: string;
}

export interface EstadoOrden extends RespuestaOrden {
  readonly cumulativeQuoteQty: string;
  readonly avgPrice: string;
}

export interface OpcionesCuenta {
  readonly env: HashKeyEnv;
  readonly apiKey: string;
  readonly apiSecret: string;
  readonly fetchImpl?: typeof fetch;
  /** Reloj inyectable, para que los tests fijen el `timestamp` que se firma. */
  readonly ahora?: () => number;
}

type Json = Record<string, unknown>;

const esObjeto = (valor: unknown): valor is Json => typeof valor === "object" && valor !== null && !Array.isArray(valor);
const texto = (valor: unknown): string | undefined =>
  typeof valor === "string" ? valor : typeof valor === "number" ? String(valor) : undefined;

/**
 * Los ids de orden son enteros de 64 bits y JSON.parse los redondea si pasan de
 * 2^53. Se pasan a texto antes de parsear para no cambiar el id que se consulta.
 */
function idsComoTexto(cuerpo: string): string {
  return cuerpo.replace(/"(orderId|accountId)"\s*:\s*(\d+)/g, '"$1":"$2"');
}

export class HashKeyCuenta {
  readonly #base: string;
  readonly #apiKey: string;
  readonly #apiSecret: string;
  readonly #fetch: typeof fetch;
  readonly #ahora: () => number;

  constructor(opciones: OpcionesCuenta) {
    if (!opciones.apiKey || !opciones.apiSecret) throw new HashKeyError(0, undefined, "faltan las credenciales de HashKey");
    this.#base = HASHKEY_URLS[opciones.env];
    this.#apiKey = opciones.apiKey;
    this.#apiSecret = opciones.apiSecret;
    this.#fetch = opciones.fetchImpl ?? fetch;
    this.#ahora = opciones.ahora ?? Date.now;
  }

  /**
   * Envia una peticion firmada. Todos los parametros viajan en la query, y la firma
   * se calcula sobre esa misma cadena, tal como la documenta el exchange.
   */
  async #firmada(metodo: "GET" | "POST", ruta: string, params: Readonly<Record<string, string>>): Promise<unknown> {
    const todos = { ...params, recvWindow: "5000", timestamp: String(this.#ahora()) };
    const query = Object.entries(todos)
      .map(([clave, valor]) => `${clave}=${encodeURIComponent(valor)}`)
      .join("&");
    const firma = firmar(this.#apiSecret, query);

    const respuesta = await this.#fetch(`${this.#base}${ruta}?${query}&signature=${firma}`, {
      method: metodo,
      headers: {
        "X-HK-APIKEY": this.#apiKey,
        ...(metodo === "POST" ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      },
    });

    const crudo = await respuesta.text();
    let cuerpo: unknown;
    try {
      cuerpo = crudo.trim() === "" ? {} : JSON.parse(idsComoTexto(crudo));
    } catch {
      cuerpo = undefined;
    }

    const codigo = esObjeto(cuerpo) ? texto(cuerpo["code"]) : undefined;
    const fallo = !respuesta.ok || (codigo !== undefined && codigo !== "0" && codigo !== "200");
    if (fallo) {
      const mensaje = esObjeto(cuerpo) ? (texto(cuerpo["msg"]) ?? "sin detalle") : "respuesta no valida";
      // Ni la clave ni el secreto ni la firma entran en el mensaje.
      throw new HashKeyError(respuesta.status, codigo, `${ruta} respondio ${respuesta.status}: ${mensaje}`);
    }
    return cuerpo;
  }

  async saldos(): Promise<Saldo[]> {
    const cuerpo = await this.#firmada("GET", "/api/v1/account", {});
    const balances = esObjeto(cuerpo) && Array.isArray(cuerpo["balances"]) ? cuerpo["balances"] : [];
    return balances.filter(esObjeto).map((b) => ({
      asset: texto(b["asset"]) ?? "?",
      total: texto(b["total"]) ?? "0",
      free: texto(b["free"]) ?? "0",
      locked: texto(b["locked"]) ?? "0",
    }));
  }

  /**
   * Valida una orden contra el exchange sin enviarla al motor de ejecucion.
   * Detecta parametros invalidos y permisos faltantes con la cuenta real, sin
   * arriesgar fondos.
   */
  async probarOrden(plan: OrdenPlan): Promise<void> {
    await this.#firmada("POST", "/api/v1/spot/orderTest", {
      symbol: plan.symbol,
      side: plan.side,
      type: plan.type,
      timeInForce: plan.timeInForce,
      quantity: plan.quantity,
      price: plan.price,
    });
  }

  /** Envia la orden de verdad. */
  async crearOrden(plan: OrdenPlan, clientOrderId: string): Promise<RespuestaOrden> {
    const cuerpo = await this.#firmada("POST", "/api/v1.1/spot/order", {
      symbol: plan.symbol,
      side: plan.side,
      type: plan.type,
      timeInForce: plan.timeInForce,
      quantity: plan.quantity,
      price: plan.price,
      newClientOrderId: clientOrderId,
    });
    return this.#leerOrden(cuerpo, clientOrderId);
  }

  async consultarOrden(orderId: string): Promise<EstadoOrden> {
    if (!/^\d+$/.test(orderId)) throw new RangeError(`orderId invalido: "${orderId}"`);
    const cuerpo = await this.#firmada("GET", "/api/v1/spot/order", { orderId });
    const base = this.#leerOrden(cuerpo, "");
    const datos = esObjeto(cuerpo) ? cuerpo : {};
    return {
      ...base,
      cumulativeQuoteQty: texto(datos["cumulativeQuoteQty"]) ?? "0",
      avgPrice: texto(datos["avgPrice"]) ?? "0",
    };
  }

  #leerOrden(cuerpo: unknown, clientOrderIdPorDefecto: string): RespuestaOrden {
    const datos = esObjeto(cuerpo) ? cuerpo : {};
    const orderId = texto(datos["orderId"]);
    if (orderId === undefined) throw new HashKeyError(0, undefined, "el exchange no devolvio un orderId");
    return {
      orderId,
      clientOrderId: texto(datos["clientOrderId"]) ?? clientOrderIdPorDefecto,
      status: texto(datos["status"]) ?? "DESCONOCIDO",
      executedQty: texto(datos["executedQty"]) ?? "0",
    };
  }
}

/** Un decimal positivo valido, o un `RangeError`. Sirve para leer limites de variables de entorno. */
export function decimalPositivo(nombre: string, valor: string | undefined): string {
  if (valor === undefined || valor.trim() === "") throw new RangeError(`falta ${nombre}`);
  try {
    parseDecimal(valor);
  } catch {
    throw new RangeError(`${nombre} debe ser un decimal positivo, llego "${valor}"`);
  }
  if (compareDecimal(valor, "0") <= 0) throw new RangeError(`${nombre} debe ser mayor que cero`);
  return valor.trim();
}
