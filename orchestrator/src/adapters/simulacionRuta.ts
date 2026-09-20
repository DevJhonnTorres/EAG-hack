import { RATE_SCALE } from "../domain/bridge.js";
import { decimalToFixed } from "../domain/decimal.js";
import { HashKeyPublicoError, type PasoRuta } from "./hashkeyMercado.js";

/**
 * Ejecucion simulada de una ruta hacia USDC, para mostrar en una demostracion.
 *
 * Recorre la ruta paso a paso con los precios reales del exchange y devuelve lo que
 * habria pasado en cada operacion. NO envia nada ni habla con el exchange: es solo
 * aritmetica sobre precios ya leidos, y sirve para que una demo muestre el flujo
 * sin mover dinero.
 *
 * Los montos van en punto fijo de 18 decimales, sea cual sea el activo, para poder
 * encadenar operaciones sin cambiar de escala. Las comisiones no se descuentan en
 * cada paso: se muestran aparte, con la misma cifra que usa la cotizacion.
 */

export interface RouteFill {
  readonly step: PasoRuta;
  /** Precio del par en la operacion, como texto decimal. */
  readonly price: string;
  readonly spendAsset: string;
  /** Lo que se entrega, en punto fijo de 18 decimales. */
  readonly spend: bigint;
  readonly receiveAsset: string;
  /** Lo que se recibe, en punto fijo de 18 decimales. Redondeado hacia abajo. */
  readonly receive: bigint;
}

/**
 * Recorre `pasos` gastando `amountIn` (punto fijo de 18 decimales) del activo de origen.
 *
 * Vender entrega la moneda base y recibe `monto * precio` de la cotizada. Comprar
 * entrega la cotizada y recibe `monto / precio` de la base. Todo redondeo es hacia
 * abajo: la simulacion no promete mas de lo que el exchange entregaria.
 */
export function simularRuta(
  pasos: readonly PasoRuta[],
  precios: Readonly<Record<string, string>>,
  amountIn: bigint,
): RouteFill[] {
  if (amountIn < 0n) throw new RangeError(`amountIn cannot be negative: ${amountIn}`);

  const fills: RouteFill[] = [];
  let actual = amountIn;

  for (const paso of pasos) {
    const precio = precios[paso.symbol];
    if (precio === undefined) throw new HashKeyPublicoError(`missing price for ${paso.symbol}`);
    const fijo = decimalToFixed(precio, 18);
    if (fijo <= 0n) throw new HashKeyPublicoError(`invalid price for ${paso.symbol}: ${precio}`);

    const vende = paso.side === "SELL";
    const recibe = vende ? (actual * fijo) / RATE_SCALE : (actual * RATE_SCALE) / fijo;

    fills.push({
      step: paso,
      price: precio,
      spendAsset: vende ? paso.base : paso.quote,
      spend: actual,
      receiveAsset: vende ? paso.quote : paso.base,
      receive: recibe,
    });
    actual = recibe;
  }
  return fills;
}
