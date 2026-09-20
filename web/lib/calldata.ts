import { Interface } from "ethers";
import type { Settlement } from "@hashpool/orchestrator";

/**
 * Traduce el reparto calculado a la llamada exacta que el Safe va a firmar.
 *
 * Es el punto donde el calculo deja de ser una propuesta y se convierte en algo
 * verificable: lo que se muestra aca es, byte por byte, lo que termina en la
 * cadena. Nadie firma un resumen bonito de otra cosa.
 */

/** Orden del enum `PoolRegistry.Role` en Solidity. */
export const ROLE_ENUM = { NONE: 0, PARTNER: 1, ENERGY: 2, MAINTENANCE: 3 } as const;

export const POOL_SPLITTER_ABI = [
  "function settle(uint256 epochId, bytes32 telemetryHash, (address to, uint256 amount, uint8 role)[] payouts) payable",
  "function lastSettledEpoch() view returns (uint256)",
  "function settlements(uint256) view returns (bytes32 telemetryHash, uint256 gross, uint64 settledAt)",
] as const;

const splitterInterface = new Interface(POOL_SPLITTER_ABI);

export function encodeSettle(settlement: Settlement, telemetryHash: string): string {
  const payouts = settlement.payouts.map((payout) => [payout.to, payout.amount, ROLE_ENUM[payout.role]]);
  return splitterInterface.encodeFunctionData("settle", [settlement.epochId, telemetryHash, payouts]);
}

/** Datos de la transaccion tal como los recibe `execTransaction` del Safe. */
export interface SafeTransactionPreview {
  readonly to: string;
  readonly value: bigint;
  readonly data: string;
  readonly operation: 0;
}

export function buildSafeTransaction(
  splitterAddress: string,
  settlement: Settlement,
  telemetryHash: string,
): SafeTransactionPreview {
  return {
    to: splitterAddress,
    // El bruto viaja como valor de la misma transaccion que lo reparte: el Safe
    // entrega y el contrato distribuye de forma atomica.
    value: settlement.gross,
    data: encodeSettle(settlement, telemetryHash),
    operation: 0,
  };
}
