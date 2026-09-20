import { keccak256, toUtf8Bytes } from "ethers";
import type { EpochTelemetry } from "./types.js";

/**
 * Ancla criptografica de la auditoria.
 *
 * El contrato guarda este hash junto a cada liquidacion. Cualquier socio puede
 * tomar el JSON crudo de telemetria del periodo, recalcular el hash y comprobar
 * que coincide con el que quedo en la cadena; y desde esos mismos datos puede
 * recalcular el reparto y verificar que le pagaron lo que le correspondia.
 *
 * Nadie tiene que confiar en el servidor que hizo la cuenta, ni en la palabra
 * del socio que la ejecuto.
 *
 * La serializacion es canonica (claves ordenadas, equipos ordenados por id)
 * para que los mismos datos produzcan siempre el mismo hash, sin importar en
 * que orden los devolvio la API de telemetria.
 */
export function canonicalizeTelemetry(telemetry: EpochTelemetry): string {
  const rigs = [...telemetry.rigs]
    .sort((a, b) => (a.rigId < b.rigId ? -1 : a.rigId > b.rigId ? 1 : 0))
    .map((rig) => ({
      averageHashrateMilliHs: rig.averageHashrateMilliHs,
      rigId: rig.rigId,
      uptimeSeconds: rig.uptimeSeconds,
    }));

  return JSON.stringify({
    endedAt: telemetry.endedAt,
    epochId: telemetry.epochId,
    rigs,
    startedAt: telemetry.startedAt,
  });
}

export function hashTelemetry(telemetry: EpochTelemetry): string {
  return keccak256(toUtf8Bytes(canonicalizeTelemetry(telemetry)));
}
