import { USDC_DECIMALS } from "../domain/bridge.js";
import { decimalToFixedUp } from "../domain/decimal.js";

/**
 * Cuanto cuesta pasar USDC de Ethereum a Linea, cotizado en vivo.
 *
 * HashKey Exchange no retira USDC a Linea: lo entrega en Ethereum, y de ahi hay que
 * pasarlo con un bridge. Ese costo no lo informa el exchange, asi que se lee de
 * LI.FI, un agregador de bridges con API publica y sin clave. La cotizacion ya
 * incluye las comisiones del bridge y el gas de la transaccion en Ethereum.
 *
 * Es solo una lectura: no firma ni envia nada.
 */

export const USDC_ETHEREUM = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
export const USDC_LINEA = "0x176211869cA2b568f2A7D4EE941E073a821EE1ff";

const CADENA_ETHEREUM = 1;
const CADENA_LINEA = 59_144;
const URL_COTIZACION = "https://li.quest/v1/quote";

/**
 * Una cotizacion no necesita la direccion de nadie. Se usa una neutra para no
 * mandarle a un tercero la de un socio del pool.
 */
const DIRECCION_DE_COTIZACION = "0x0000000000000000000000000000000000000001";

export class BridgeLineaError extends Error {
  constructor(mensaje: string) {
    super(mensaje);
    this.name = "BridgeLineaError";
  }
}

export interface CotizacionBridge {
  /** Bridge que LI.FI eligio para la ruta, por ejemplo "across". */
  readonly herramienta: string;
  /** USDC que entran al bridge, en la unidad minima (6 decimales). */
  readonly monto: bigint;
  /** USDC que llegan a Linea. */
  readonly recibe: bigint;
  /** Lo que el bridge descuenta del monto: `monto - recibe`. */
  readonly comisiones: bigint;
  /** Gas de la transaccion en Ethereum, expresado en USDC y redondeado hacia arriba. */
  readonly gas: bigint;
  /** `comisiones + gas`: lo que cuesta llevar ese monto a Linea. */
  readonly costoTotal: bigint;
  /** Tiempo estimado hasta que llega, si LI.FI lo informa. */
  readonly segundos: number | null;
}

type Json = Record<string, unknown>;
const esObjeto = (valor: unknown): valor is Json => typeof valor === "object" && valor !== null && !Array.isArray(valor);

function entero(nombre: string, valor: unknown): bigint {
  if (typeof valor !== "string" || !/^\d+$/.test(valor)) {
    throw new BridgeLineaError(`${nombre} no es un entero: ${JSON.stringify(valor)}`);
  }
  return BigInt(valor);
}

/**
 * Cotiza el bridge de USDC de Ethereum a Linea para un monto.
 *
 * El costo tiene una parte fija (el gas) y otra proporcional al monto, asi que
 * conviene cotizar con un monto parecido al que se va a mover. El gas cambia con
 * la red: por eso se lee en vivo en vez de dejarlo escrito.
 *
 * Todo redondeo es hacia arriba en el gas: nunca se subestima lo que cuesta.
 */
export async function cotizarBridgeLinea(monto: bigint, fetchImpl: typeof fetch = fetch): Promise<CotizacionBridge> {
  if (monto <= 0n) throw new RangeError(`el monto debe ser positivo: ${monto}`);

  const params = new URLSearchParams({
    fromChain: String(CADENA_ETHEREUM),
    toChain: String(CADENA_LINEA),
    fromToken: USDC_ETHEREUM,
    toToken: USDC_LINEA,
    fromAmount: monto.toString(),
    fromAddress: DIRECCION_DE_COTIZACION,
  });

  const respuesta = await fetchImpl(`${URL_COTIZACION}?${params.toString()}`);
  const cuerpo: unknown = await respuesta.json().catch(() => undefined);

  if (!respuesta.ok) {
    const detalle = esObjeto(cuerpo) && typeof cuerpo["message"] === "string" ? `: ${cuerpo["message"]}` : "";
    throw new BridgeLineaError(`LI.FI respondio ${respuesta.status}${detalle}`);
  }

  const estimacion = esObjeto(cuerpo) ? cuerpo["estimate"] : undefined;
  if (!esObjeto(estimacion)) throw new BridgeLineaError("LI.FI no devolvio una estimacion");

  const entra = entero("fromAmount", estimacion["fromAmount"]);
  const recibe = entero("toAmount", estimacion["toAmount"]);
  if (recibe > entra) throw new BridgeLineaError(`el bridge entregaria mas de lo que recibe: ${recibe} > ${entra}`);

  const costosDeGas = estimacion["gasCosts"];
  if (!Array.isArray(costosDeGas)) throw new BridgeLineaError("LI.FI no informo el costo de gas");

  let gas = 0n;
  for (const costo of costosDeGas) {
    const usd = esObjeto(costo) ? costo["amountUSD"] : undefined;
    // Un costo de gas sin monto se rechaza: darlo por cero subestimaria el bridge.
    if (typeof usd !== "string") throw new BridgeLineaError("un costo de gas no trae su monto en USD");
    gas += decimalToFixedUp(usd, USDC_DECIMALS);
  }

  const comisiones = entra - recibe;
  const duracion = estimacion["executionDuration"];

  return {
    herramienta: esObjeto(cuerpo) && typeof cuerpo["tool"] === "string" ? cuerpo["tool"] : "desconocida",
    monto: entra,
    recibe,
    comisiones,
    gas,
    costoTotal: comisiones + gas,
    segundos: typeof duracion === "number" ? duracion : null,
  };
}
