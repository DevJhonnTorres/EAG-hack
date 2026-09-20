import type { Wei } from "./types.js";

/**
 * Aritmetica exacta del reparto.
 *
 * Toda funcion de este modulo conserva el valor: la suma de lo que devuelve es
 * exactamente lo que recibio. Es la propiedad que el `PoolSplitter` verifica
 * on-chain, asi que romperla aca hace que la liquidacion sea rechazada por la
 * cadena en vez de producir un reparto silenciosamente incorrecto.
 */

export const BPS_DENOMINATOR = 10_000n;

export class NegativeAmountError extends Error {
  constructor(name: string, value: bigint) {
    super(`${name} no puede ser negativo: ${value}`);
    this.name = "NegativeAmountError";
  }
}

export function assertNonNegative(name: string, value: bigint): void {
  if (value < 0n) throw new NegativeAmountError(name, value);
}

/** Aplica una tasa en basis points, redondeando hacia abajo. */
export function applyBps(amount: Wei, bps: number): Wei {
  assertNonNegative("amount", amount);
  if (!Number.isInteger(bps) || bps < 0 || bps > Number(BPS_DENOMINATOR)) {
    throw new RangeError(`bps fuera de rango: ${bps}`);
  }
  return (amount * BigInt(bps)) / BPS_DENOMINATOR;
}

export function sum(values: readonly bigint[]): bigint {
  return values.reduce((acc, value) => acc + value, 0n);
}

export function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

/**
 * Reparte `total` en proporcion a `weights` sin perder ni inventar una sola
 * unidad, mediante el metodo del resto mayor (Hamilton).
 *
 * Una division entera pura deja un sobrante de hasta `n - 1` unidades. Tirarlo
 * romperia la conservacion y la cadena rechazaria la liquidacion; repartirlo
 * siempre al primero seria un sesgo sistematico a favor del mismo socio. El
 * resto mayor lo asigna a quienes quedaron mas cerca de merecer una unidad
 * adicional, que es el criterio mas defendible frente a un socio que pregunta
 * por que recibio un wei menos.
 *
 * Los empates se resuelven por el orden del arreglo, asi que el resultado es
 * determinista: dos ejecuciones sobre los mismos datos producen exactamente el
 * mismo reparto, y cualquiera puede reproducirlo. El llamador es responsable de
 * ordenar los participantes de forma estable (por direccion).
 *
 * Si nadie aporto peso, el total se reparte en partes iguales: es el unico
 * criterio neutral disponible cuando no hay contribucion que ponderar.
 */
export function splitByWeight(total: Wei, weights: readonly bigint[]): Wei[] {
  assertNonNegative("total", total);
  if (weights.length === 0) {
    if (total > 0n) throw new RangeError("no hay participantes para repartir un total positivo");
    return [];
  }
  for (const weight of weights) assertNonNegative("weight", weight);

  const totalWeight = sum(weights);
  const count = BigInt(weights.length);

  const base: bigint[] = [];
  const remainders: bigint[] = [];

  if (totalWeight === 0n) {
    const share = total / count;
    const rest = total % count;
    for (let i = 0; i < weights.length; i += 1) {
      base.push(share);
      // Los primeros `rest` participantes reciben la unidad extra.
      remainders.push(BigInt(i) < rest ? 1n : 0n);
    }
  } else {
    for (const weight of weights) {
      const numerator = total * weight;
      base.push(numerator / totalWeight);
      remainders.push(numerator % totalWeight);
    }
  }

  let leftover = total - sum(base);

  // Se reparte el sobrante de a una unidad, empezando por el resto mas alto.
  const order = remainders
    .map((remainder, index) => ({ remainder, index }))
    .sort((a, b) => (a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1));

  for (const { index } of order) {
    if (leftover === 0n) break;
    base[index] = (base[index] ?? 0n) + 1n;
    leftover -= 1n;
  }

  return base;
}
