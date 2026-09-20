/**
 * Aritmetica decimal exacta para precios y cantidades de un exchange.
 *
 * Un exchange rechaza una orden cuya cantidad no es multiplo de su paso, y
 * `0.1 + 0.2 !== 0.3` en punto flotante: redondear con `number` produce
 * cantidades que a veces pasan y a veces no. Aca todo se hace sobre enteros
 * con escala, y los valores viajan como texto decimal.
 */

/** Un decimal exacto: `units / 10^scale`. */
export interface Decimal {
  readonly units: bigint;
  readonly scale: number;
}

export function parseDecimal(text: string): Decimal {
  const limpio = text.trim();
  if (!/^\d+(\.\d+)?$/.test(limpio)) throw new RangeError(`decimal invalido: "${text}"`);
  const [entera = "0", fraccion = ""] = limpio.split(".");
  return { units: BigInt(entera + fraccion), scale: fraccion.length };
}

/** Texto decimal sin ceros a la derecha: `0.500` queda `0.5` y `2.0` queda `2`. */
export function formatDecimal({ units, scale }: Decimal): string {
  if (scale === 0) return units.toString();
  const digitos = units.toString().padStart(scale + 1, "0");
  const entera = digitos.slice(0, -scale);
  const fraccion = digitos.slice(-scale).replace(/0+$/, "");
  return fraccion.length > 0 ? `${entera}.${fraccion}` : entera;
}

/** Lleva dos decimales a la misma escala para poder compararlos o restarlos. */
function alinear(a: Decimal, b: Decimal): { a: bigint; b: bigint; scale: number } {
  const scale = Math.max(a.scale, b.scale);
  return {
    a: a.units * 10n ** BigInt(scale - a.scale),
    b: b.units * 10n ** BigInt(scale - b.scale),
    scale,
  };
}

export function compareDecimal(a: string, b: string): -1 | 0 | 1 {
  const par = alinear(parseDecimal(a), parseDecimal(b));
  return par.a < par.b ? -1 : par.a > par.b ? 1 : 0;
}

/** Producto exacto: no pierde ningun decimal. */
export function mulDecimal(a: string, b: string): string {
  const x = parseDecimal(a);
  const y = parseDecimal(b);
  return formatDecimal({ units: x.units * y.units, scale: x.scale + y.scale });
}

/** Redondea hacia abajo al multiplo de `paso` mas cercano. */
export function floorToStep(valor: string, paso: string): string {
  const par = alinear(parseDecimal(valor), parseDecimal(paso));
  if (par.b === 0n) throw new RangeError("el paso no puede ser cero");
  return formatDecimal({ units: (par.a / par.b) * par.b, scale: par.scale });
}

/** Factor `(10000 + bps) / 10000` como decimal exacto. Sirve para aplicar un margen a un precio. */
export function factorBps(bps: number): string {
  if (!Number.isInteger(bps) || bps <= -10_000) throw new RangeError(`bps invalido: ${bps}`);
  return formatDecimal({ units: BigInt(10_000 + bps), scale: 4 });
}

/** Pasa un decimal a entero de punto fijo con `decimales` decimales, redondeando hacia abajo. */
export function decimalToFixed(texto: string, decimales: number): bigint {
  const { units, scale } = parseDecimal(texto);
  return scale <= decimales
    ? units * 10n ** BigInt(decimales - scale)
    : units / 10n ** BigInt(scale - decimales);
}

/**
 * Igual que `decimalToFixed`, pero redondeando hacia arriba.
 *
 * Sirve para costos: una estimacion de lo que cuesta algo nunca debe quedar por
 * debajo de lo real, asi que se redondea siempre en contra de quien la lee.
 */
export function decimalToFixedUp(texto: string, decimales: number): bigint {
  const { units, scale } = parseDecimal(texto);
  if (scale <= decimales) return units * 10n ** BigInt(decimales - scale);
  const divisor = 10n ** BigInt(scale - decimales);
  return (units + divisor - 1n) / divisor;
}
