import type { PoolConfig, Wei } from "./types.js";
import { applyBps } from "./money.js";

/**
 * Decide cuanto se aparta para el fondo de repuestos y mantenimiento.
 *
 * Se calcula sobre el bruto y no sobre la ganancia neta, deliberadamente: un
 * riser PCIe que se quema cuesta lo mismo en un mes bueno que en un mes malo.
 * Un fondo proporcional a la ganancia se vacia justo cuando mas falta hace.
 */
export interface MaintenancePolicy {
  reserve(config: PoolConfig, gross: Wei): Wei;
}

export class FixedBpsMaintenancePolicy implements MaintenancePolicy {
  /**
   * Redondea hacia abajo, exactamente igual que `PoolRegistry.requiredMaintenance`.
   * Replicar el redondeo del contrato no es un detalle: el contrato exige que la
   * reserva alcance ese piso, y una diferencia de un wei por redondear distinto
   * haria revertir la liquidacion entera.
   */
  reserve(config: PoolConfig, gross: Wei): Wei {
    return applyBps(gross, config.maintenanceBps);
  }
}
