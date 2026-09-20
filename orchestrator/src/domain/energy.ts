import type { PartnerContribution, PoolConfig, Wei } from "./types.js";
import { sum } from "./money.js";

/** Vatios-segundo que contiene un kilovatio-hora. */
export const WATT_SECONDS_PER_KWH = 3_600_000n;

/**
 * Traduce consumo electrico a dinero.
 *
 * Separado del resto del calculo a proposito: la tarifa es el parametro que mas
 * cambia (sube la luz, cambia el plan, se agrega un horario nocturno) y es el
 * que mas probablemente haya que sustituir por un oraculo real. Aislarlo detras
 * de una interfaz permite cambiarlo sin tocar la logica del reparto.
 */
export interface EnergyCostCalculator {
  /** Costo total de la energia del periodo. */
  cost(config: PoolConfig, contributions: readonly PartnerContribution[]): Wei;
}

export class TariffEnergyCostCalculator implements EnergyCostCalculator {
  cost(config: PoolConfig, contributions: readonly PartnerContribution[]): Wei {
    const wallWattSeconds = sum(contributions.map((contribution) => contribution.wallWattSeconds));
    // Division entera al final y una sola vez: multiplicar primero evita perder
    // precision en consumos chicos.
    return (wallWattSeconds * config.tariffWeiPerKwh) / WATT_SECONDS_PER_KWH;
  }
}
