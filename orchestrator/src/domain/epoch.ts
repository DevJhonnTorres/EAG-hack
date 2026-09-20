/**
 * Periodos liquidables.
 *
 * `PoolSplitter.settle` exige que el periodo sea estrictamente mayor al ultimo
 * liquidado (proteccion contra el doble pago). Una liquidacion con un periodo que ya
 * se uso revierte con `EpochNotIncreasing`, y a traves de un Safe eso se ve como un
 * `GS013` opaco: la transaccion "no se ejecuta" sin decir por que. Conocer el ultimo
 * periodo antes de firmar evita firmar algo que va a revertir.
 */

/** El menor periodo que el contrato aceptaria despues de `lastSettled`. */
export function nextSettleableEpoch(lastSettled: bigint): number {
  if (lastSettled < 0n) throw new RangeError(`lastSettled cannot be negative: ${lastSettled}`);
  const siguiente = lastSettled + 1n;
  if (siguiente > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError(`epoch out of range: ${siguiente}`);
  return Number(siguiente);
}

/** Si el contrato aceptaria liquidar `epochId`, dado el ultimo periodo ya liquidado. */
export function isEpochSettleable(epochId: number, lastSettled: bigint): boolean {
  return Number.isInteger(epochId) && epochId >= 0 && BigInt(epochId) > lastSettled;
}
