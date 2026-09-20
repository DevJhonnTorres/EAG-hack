import type { PoolConfig, RigSpec } from "../src/domain/types.js";

/** Direcciones de prueba, en minuscula y ordenadas para que el orden sea previsible. */
export const PARTNER_A = "0xaa00000000000000000000000000000000000001";
export const PARTNER_B = "0xbb00000000000000000000000000000000000002";
export const ENERGY_WALLET = "0xee00000000000000000000000000000000000003";
export const MAINTENANCE_VAULT = "0xff00000000000000000000000000000000000004";

export const DAY = 24 * 60 * 60;
export const WEEK = 7 * DAY;

/**
 * Una RTX 3070 tipica: ~60 MH/s y 220 W de consumo.
 * El hashrate se expresa en milihashes por segundo para trabajar con enteros.
 */
export const RTX_3070 = {
  model: "RTX 3070",
  hashrateMilliHs: 60_000_000_000,
  tdpWatts: 220,
} as const;

export function rig(id: string, partner: string, gpuCount: number): RigSpec {
  return {
    id,
    partner,
    gpus: Array.from({ length: gpuCount }, () => RTX_3070),
    baseloadWatts: 80,
    psuEfficiencyBps: 9_000,
  };
}

/**
 * El escenario del proyecto: un socio aporta dos placas y el otro una.
 * Con ambos equipos encendidos todo el periodo, el reparto deberia acercarse
 * a 2:1.
 */
export function twoPartnerPool(overrides: Partial<PoolConfig> = {}): PoolConfig {
  return {
    rigs: [rig("rig-a", PARTNER_A, 2), rig("rig-b", PARTNER_B, 1)],
    // 300 gwei por kWh: valor arbitrario de testnet, suficientemente chico para
    // que el pool sea rentable en los casos normales.
    tariffWeiPerKwh: 300_000_000_000n,
    maintenanceBps: 500,
    energyWallet: ENERGY_WALLET,
    maintenanceVault: MAINTENANCE_VAULT,
    ...overrides,
  };
}

export function telemetry(
  epochId: number,
  readings: ReadonlyArray<{ rigId: string; uptimeSeconds: number; averageHashrateMilliHs?: number }>,
  epochSeconds: number = WEEK,
) {
  return {
    epochId,
    startedAt: 1_700_000_000,
    endedAt: 1_700_000_000 + epochSeconds,
    rigs: readings.map((reading) => ({
      rigId: reading.rigId,
      uptimeSeconds: reading.uptimeSeconds,
      averageHashrateMilliHs:
        reading.averageHashrateMilliHs ??
        // Por defecto, cada equipo rinde el nominal de sus placas.
        RTX_3070.hashrateMilliHs * (reading.rigId === "rig-a" ? 2 : 1),
    })),
  };
}
