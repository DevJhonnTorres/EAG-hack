import type { EpochTelemetry, PartnerContribution, PoolConfig, RigSpec, RigTelemetry } from "./types.js";
import { BPS_DENOMINATOR } from "./money.js";

/**
 * Calcula cuanto aporto cada socio durante un periodo.
 *
 * El criterio es **hashrate efectivo integrado sobre el tiempo encendido**, no
 * el hardware nominal declarado. Esa distincion es el corazon del proyecto:
 * repartir por "vos pusiste dos placas y yo una" funciona en un Excel el primer
 * mes y se rompe el segundo, cuando el equipo de alguien estuvo apagado dos
 * dias, o hizo throttling por calor, o estuvo rechazando shares. Lo que se
 * reparte es el trabajo que cada equipo realmente hizo.
 *
 * El mismo principio aplica al consumo: la luz se cobra por las horas que cada
 * equipo estuvo efectivamente prendido. Un socio con el equipo apagado no
 * aporta hashrate, pero tampoco paga esa energia.
 */
export interface ContributionCalculator {
  calculate(config: PoolConfig, telemetry: EpochTelemetry): PartnerContribution[];
}

export class UnknownRigError extends Error {
  constructor(rigId: string) {
    super(
      `la telemetria reporta el equipo "${rigId}", que no esta declarado en la configuracion del pool`,
    );
    this.name = "UnknownRigError";
  }
}

export class InvalidTelemetryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidTelemetryError";
  }
}

export class HashrateWeightedContributionCalculator implements ContributionCalculator {
  calculate(config: PoolConfig, telemetry: EpochTelemetry): PartnerContribution[] {
    const epochSeconds = telemetry.endedAt - telemetry.startedAt;
    if (epochSeconds <= 0) {
      throw new InvalidTelemetryError(
        `el periodo ${telemetry.epochId} termina antes de empezar (${telemetry.startedAt} -> ${telemetry.endedAt})`,
      );
    }

    const bySpecId = new Map(config.rigs.map((rig) => [rig.id, rig]));
    const readings = new Map<string, RigTelemetry>();

    for (const reading of telemetry.rigs) {
      const spec = bySpecId.get(reading.rigId);
      // Un equipo que reporta sin estar declarado significa configuracion
      // desincronizada. Fallar es preferible a repartir sobre datos que nadie
      // aprobo: la direccion de ese socio podria no estar ni en el registro.
      if (!spec) throw new UnknownRigError(reading.rigId);
      if (readings.has(reading.rigId)) {
        throw new InvalidTelemetryError(`el equipo "${reading.rigId}" reporta dos veces en el mismo periodo`);
      }
      this.#validateReading(reading, epochSeconds);
      readings.set(reading.rigId, reading);
    }

    const accumulator = new Map<string, { weight: bigint; wallWattSeconds: bigint }>();

    for (const rig of config.rigs) {
      // Un equipo sin lectura se trata como apagado todo el periodo. Es el caso
      // real de un rig que se cayo y dejo de reportar: no aporta y no consume.
      const reading = readings.get(rig.id);
      const uptimeSeconds = BigInt(reading?.uptimeSeconds ?? 0);
      const hashrate = BigInt(reading?.averageHashrateMilliHs ?? 0);

      const entry = accumulator.get(rig.partner) ?? { weight: 0n, wallWattSeconds: 0n };
      entry.weight += hashrate * uptimeSeconds;
      entry.wallWattSeconds += this.#wallWattSeconds(rig, uptimeSeconds);
      accumulator.set(rig.partner, entry);
    }

    // Orden estable por direccion: hace que el reparto sea reproducible bit a
    // bit, incluido el desempate del sobrante en `splitByWeight`.
    return [...accumulator.entries()]
      .map(([partner, entry]) => ({ partner, weight: entry.weight, wallWattSeconds: entry.wallWattSeconds }))
      .sort((a, b) => (a.partner.toLowerCase() < b.partner.toLowerCase() ? -1 : 1));
  }

  /**
   * Consumo medido en la toma de corriente, en vatios-segundo.
   *
   * La empresa de luz cobra lo que entra a la fuente, no lo que la fuente
   * entrega a las placas. Con una PSU al 90%, cada 100 W de consumo nominal son
   * 111 W en el medidor. Ignorar la eficiencia subestima la factura de forma
   * sistematica y el pool termina con un deficit que nadie sabe explicar.
   */
  #wallWattSeconds(rig: RigSpec, uptimeSeconds: bigint): bigint {
    const gpuWatts = rig.gpus.reduce((acc, gpu) => acc + BigInt(gpu.tdpWatts), 0n);
    const deviceWattSeconds = (gpuWatts + BigInt(rig.baseloadWatts)) * uptimeSeconds;
    return (deviceWattSeconds * BPS_DENOMINATOR) / BigInt(rig.psuEfficiencyBps);
  }

  #validateReading(reading: RigTelemetry, epochSeconds: number): void {
    if (!Number.isInteger(reading.uptimeSeconds) || reading.uptimeSeconds < 0) {
      throw new InvalidTelemetryError(
        `uptime invalido para "${reading.rigId}": ${reading.uptimeSeconds}`,
      );
    }
    if (reading.uptimeSeconds > epochSeconds) {
      throw new InvalidTelemetryError(
        `el equipo "${reading.rigId}" reporta ${reading.uptimeSeconds}s encendido en un periodo de ${epochSeconds}s`,
      );
    }
    if (!Number.isInteger(reading.averageHashrateMilliHs) || reading.averageHashrateMilliHs < 0) {
      throw new InvalidTelemetryError(
        `hashrate invalido para "${reading.rigId}": ${reading.averageHashrateMilliHs}`,
      );
    }
  }
}
