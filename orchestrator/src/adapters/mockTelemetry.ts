import type { EpochTelemetry, RigTelemetry } from "../domain/types.js";

/**
 * Proveedor de telemetria.
 *
 * La implementacion real leeria la API del software de mineria (HiveOS,
 * NiceHash, lolMiner). Esta interfaz existe para que el resto del sistema no
 * sepa ni le importe de donde vienen los datos: el motor de calculo y los
 * contratos son identicos con datos simulados o reales.
 */
export interface TelemetryProvider {
  fetch(epochId: number): Promise<EpochTelemetry>;
}

export interface MockTelemetryOptions {
  readonly epochSeconds?: number;
  readonly startedAt?: number;
}

/**
 * Telemetria simulada, reproducible y controlable desde la interfaz.
 *
 * Que los datos de hardware sean simulados no debilita la demostracion: lo que
 * se esta probando es que el reparto sea correcto y que la cadena lo verifique.
 * Esa parte es real de punta a punta.
 */
export class MockTelemetryProvider implements TelemetryProvider {
  readonly #readings: readonly RigTelemetry[];
  readonly #epochSeconds: number;
  readonly #startedAt: number;

  constructor(readings: readonly RigTelemetry[], options: MockTelemetryOptions = {}) {
    this.#readings = readings;
    this.#epochSeconds = options.epochSeconds ?? 7 * 24 * 60 * 60;
    this.#startedAt = options.startedAt ?? 0;
  }

  async fetch(epochId: number): Promise<EpochTelemetry> {
    return {
      epochId,
      startedAt: this.#startedAt,
      endedAt: this.#startedAt + this.#epochSeconds,
      rigs: this.#readings,
    };
  }
}
