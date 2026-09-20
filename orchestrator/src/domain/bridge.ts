import { applyBps, assertNonNegative } from "./money.js";
import type { Address, Bps, SettlementPayout } from "./types.js";

/**
 * Bridge de lo minado (HSK o BTC) a USDC en Linea.
 *
 * Cada socio cobra su parte del reparto en el coin minado. Este modulo calcula
 * cuanto USDC le queda si lo pasa por el exchange: envia el activo, lo vende
 * por USDC y retira. Si el exchange no retira USDC directo a Linea, el retiro sale
 * por otra red y el ultimo tramo es un bridge aparte, cuyo costo entra aca como
 * parte de `withdrawalFee`.
 *
 * Aplica la misma regla que el resto del paquete: todo monto es `bigint`. El
 * precio se recibe como punto fijo de 18 decimales y las comisiones como basis
 * points y unidades minimas, asi que la cotizacion es exacta y reproducible.
 *
 * Es una cotizacion, no una orden: no mueve fondos ni habla con ningun exchange.
 * Los precios y comisiones son parametros que pone quien lo usa.
 */

export type BridgeAsset = "HSK" | "BTC";

/**
 * Decimales de la unidad minima de cada activo. Es una propiedad del activo, no
 * del exchange. Las redes por las que se deposita y la ruta hasta USDC no estan
 * aca: las informa el exchange.
 */
export const BRIDGE_ASSETS: Record<BridgeAsset, { readonly decimals: number }> = {
  HSK: { decimals: 18 },
  BTC: { decimals: 8 },
};

export const USDC_DECIMALS = 6;

/** Decimales de los montos de un reparto: los del token nativo de la cadena. */
export const POOL_DECIMALS = 18;

/** Escala del precio: `rateE18` = 1 * 10^18 significa 1 USDC por cada unidad entera del activo. */
export const RATE_SCALE = 10n ** 18n;

export interface BridgeTerms {
  readonly asset: BridgeAsset;
  /** USDC por cada unidad entera del activo (1 HSK, 1 BTC), multiplicados por 10^18. */
  readonly rateE18: bigint;
  /** Comision de la venta en el exchange, en basis points. */
  readonly tradeFeeBps: Bps;
  /** Comision fija de sacar el USDC hasta Linea (retiro + bridge), en la unidad minima de USDC. */
  readonly withdrawalFee: bigint;
  /** Retiro minimo que acepta el exchange, en la unidad minima de USDC. */
  readonly minWithdrawal: bigint;
}

/** Por que un monto no se puede pasar por el bridge. */
export type BridgeRejection =
  /** El monto es cero, o tan chico que al convertirlo no alcanza una unidad de USDC. */
  | "NO_AMOUNT"
  /** Las comisiones se comen todo lo que se obtendria. */
  | "FEES_EXCEED_AMOUNT"
  /** Queda menos que el retiro minimo del exchange. */
  | "BELOW_MINIMUM";

export interface BridgeQuote {
  readonly partner: Address;
  readonly asset: BridgeAsset;
  /** Lo que entra al exchange, en la unidad minima del activo. */
  readonly amountIn: bigint;
  /** Lo que da la venta antes de comisiones, en la unidad minima de USDC. */
  readonly grossOut: bigint;
  readonly tradeFee: bigint;
  readonly withdrawalFee: bigint;
  /** Los USDC que llegan a destino. Es cero si la cotizacion fue rechazada. */
  readonly netOut: bigint;
  /** `null` si el bridge es viable. */
  readonly rejection: BridgeRejection | null;
}

/**
 * Pasa un monto del reparto (18 decimales) a la unidad minima del activo.
 *
 * HSK tiene 18 decimales, asi que el monto no cambia. BTC tiene 8: se divide,
 * redondeando hacia abajo, y lo que no llega a un satoshi queda sin convertir.
 */
export function poolAmountToAsset(amount: bigint, asset: BridgeAsset): bigint {
  assertNonNegative("amount", amount);
  return amount / 10n ** BigInt(POOL_DECIMALS - BRIDGE_ASSETS[asset].decimals);
}

/**
 * Cotiza el bridge de un monto del activo a USDC.
 *
 * Cuando es viable conserva el valor: `grossOut = tradeFee + withdrawalFee + netOut`.
 * Cuando no lo es, `netOut` es cero: no tiene sentido enviar un retiro que el
 * exchange rechazaria, o que dejaria menos de lo que cuesta retirarlo.
 *
 * Todo redondeo es hacia abajo, asi que la cotizacion nunca promete mas de lo
 * que el exchange podria entregar.
 */
export function quoteBridge(partner: Address, amountIn: bigint, terms: BridgeTerms): BridgeQuote {
  assertNonNegative("amountIn", amountIn);
  assertNonNegative("withdrawalFee", terms.withdrawalFee);
  assertNonNegative("minWithdrawal", terms.minWithdrawal);
  if (terms.rateE18 <= 0n) throw new RangeError(`el precio debe ser positivo: ${terms.rateE18}`);

  const unidadActivo = 10n ** BigInt(BRIDGE_ASSETS[terms.asset].decimals);
  const unidadUsdc = 10n ** BigInt(USDC_DECIMALS);
  const grossOut = (amountIn * terms.rateE18 * unidadUsdc) / (unidadActivo * RATE_SCALE);

  // Se calcula siempre, aun con monto cero, para que un `tradeFeeBps` invalido
  // falle igual sin importar el monto que llegue.
  const tradeFee = applyBps(grossOut, terms.tradeFeeBps);
  const restante = grossOut - tradeFee;

  const rechazada = (rejection: BridgeRejection): BridgeQuote => ({
    partner,
    asset: terms.asset,
    amountIn,
    grossOut,
    tradeFee,
    withdrawalFee: terms.withdrawalFee,
    netOut: 0n,
    rejection,
  });

  if (grossOut === 0n) return rechazada("NO_AMOUNT");
  if (restante <= terms.withdrawalFee) return rechazada("FEES_EXCEED_AMOUNT");

  const netOut = restante - terms.withdrawalFee;
  if (netOut < terms.minWithdrawal) return rechazada("BELOW_MINIMUM");

  return {
    partner,
    asset: terms.asset,
    amountIn,
    grossOut,
    tradeFee,
    withdrawalFee: terms.withdrawalFee,
    netOut,
    rejection: null,
  };
}

/**
 * Cotiza el bridge de cada linea de un reparto, en el mismo orden en que vienen.
 *
 * Los montos del reparto tienen 18 decimales; se convierten a la unidad minima
 * del activo elegido antes de cotizar.
 */
export function planBridge(payouts: readonly SettlementPayout[], terms: BridgeTerms): BridgeQuote[] {
  return payouts.map((payout) => quoteBridge(payout.to, poolAmountToAsset(payout.amount, terms.asset), terms));
}
