import { Interface, type LogDescription } from "ethers";

/**
 * Lectura del historial de liquidaciones desde Blockscout.
 *
 * El historial no se guarda en ningun servidor propio: se reconstruye desde los
 * eventos que el contrato emitio en la cadena, leidos por la API publica del
 * explorer. Eso es lo que hace al proyecto auditable de verdad. Si esta
 * interfaz desapareciera manana, cualquier socio podria abrir Blockscout y ver
 * exactamente los mismos numeros; y si esta interfaz mintiera, contrastarlos
 * contra el explorer la delataria.
 *
 * Al ser una API publica y de solo lectura, no hace falta backend ni clave.
 */

const EVENTOS_ABI = [
  "event SettlementExecuted(uint256 indexed epochId, uint256 gross, bytes32 indexed telemetryHash, uint256 payoutCount)",
  "event PayoutSent(uint256 indexed epochId, address indexed to, uint8 indexed role, uint256 amount)",
  "event PayoutCredited(uint256 indexed epochId, address indexed to, uint256 amount)",
] as const;

const iface = new Interface(EVENTOS_ABI);

/** Nombres de los roles, en el orden del enum de Solidity. */
const ROLES = ["NONE", "PARTNER", "ENERGY", "MAINTENANCE"] as const;
export type RoleName = (typeof ROLES)[number];

export interface PagoHistorico {
  readonly to: string;
  readonly amount: bigint;
  readonly role: RoleName;
  /** True si el pago no pudo entregarse y quedo acreditado para retiro. */
  readonly acreditado: boolean;
}

export interface LiquidacionHistorica {
  readonly epochId: number;
  readonly gross: bigint;
  readonly telemetryHash: string;
  readonly txHash: string;
  readonly blockNumber: number;
  readonly timestamp: string | null;
  readonly pagos: PagoHistorico[];
}

interface BlockscoutLog {
  readonly topics: (string | null)[];
  readonly data: string;
  readonly transaction_hash?: string;
  readonly tx_hash?: string;
  readonly block_number?: number;
  readonly block_timestamp?: string;
}

export class BlockscoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlockscoutError";
  }
}

function parseLog(log: BlockscoutLog): LogDescription | null {
  try {
    // Blockscout puede devolver topics nulos de relleno; el parser espera solo los presentes.
    const topics = log.topics.filter((topic): topic is string => typeof topic === "string");
    return iface.parseLog({ topics, data: log.data });
  } catch {
    // Un evento que este ABI no conoce no es un error: se ignora.
    return null;
  }
}

/**
 * Trae las liquidaciones que el splitter registro en la cadena, de la mas
 * reciente a la mas antigua.
 */
export async function fetchHistorial(
  explorerUrl: string,
  splitterAddress: string,
  signal?: AbortSignal,
): Promise<LiquidacionHistorica[]> {
  const url = `${explorerUrl}/api/v2/addresses/${splitterAddress}/logs`;

  let response: Response;
  try {
    response = await fetch(url, signal ? { signal } : {});
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw new BlockscoutError(`could not reach the explorer: ${String(error)}`);
  }

  if (!response.ok) {
    throw new BlockscoutError(`the explorer responded ${response.status}`);
  }

  const cuerpo = (await response.json()) as { items?: BlockscoutLog[] };
  const logs = cuerpo.items ?? [];

  const porEpoch = new Map<number, LiquidacionHistorica & { pagos: PagoHistorico[] }>();

  for (const log of logs) {
    const parsed = parseLog(log);
    if (!parsed) continue;

    const epochId = Number(parsed.args["epochId"] as bigint);

    if (parsed.name === "SettlementExecuted") {
      const existente = porEpoch.get(epochId);
      porEpoch.set(epochId, {
        epochId,
        gross: parsed.args["gross"] as bigint,
        telemetryHash: parsed.args["telemetryHash"] as string,
        txHash: log.transaction_hash ?? log.tx_hash ?? "",
        blockNumber: log.block_number ?? 0,
        timestamp: log.block_timestamp ?? null,
        pagos: existente?.pagos ?? [],
      });
      continue;
    }

    // Los pagos pueden llegar antes que su liquidacion, porque el explorer
    // devuelve los logs del mas reciente al mas antiguo.
    const contenedor =
      porEpoch.get(epochId) ??
      ({
        epochId,
        gross: 0n,
        telemetryHash: "",
        txHash: log.transaction_hash ?? log.tx_hash ?? "",
        blockNumber: log.block_number ?? 0,
        timestamp: log.block_timestamp ?? null,
        pagos: [],
      } as LiquidacionHistorica & { pagos: PagoHistorico[] });

    if (parsed.name === "PayoutSent") {
      contenedor.pagos.push({
        to: parsed.args["to"] as string,
        amount: parsed.args["amount"] as bigint,
        role: ROLES[Number(parsed.args["role"] as bigint)] ?? "NONE",
        acreditado: false,
      });
    } else if (parsed.name === "PayoutCredited") {
      contenedor.pagos.push({
        to: parsed.args["to"] as string,
        amount: parsed.args["amount"] as bigint,
        role: "PARTNER",
        acreditado: true,
      });
    }

    porEpoch.set(epochId, contenedor);
  }

  return [...porEpoch.values()].sort((a, b) => b.epochId - a.epochId);
}

/** Comprueba, contra la cadena, que una liquidacion historica cierre sus cuentas. */
export function cuadra(liquidacion: LiquidacionHistorica): boolean {
  if (liquidacion.gross === 0n) return false;
  const suma = liquidacion.pagos.reduce((acc, pago) => acc + pago.amount, 0n);
  return suma === liquidacion.gross;
}
