/**
 * Tipos del dominio.
 *
 * Regla que atraviesa todo el paquete: **cualquier magnitud que termine
 * influyendo en un monto se representa como entero**. Los `number` que
 * aparecen aca son unidades fisicas discretas (milihashes, vatios, segundos),
 * nunca fracciones de dinero. El reparto se calcula integramente con `bigint`.
 *
 * El motivo es concreto: `0.1 + 0.2 !== 0.3` en punto flotante. Un pool que
 * reparte con floats acumula centesimas fantasma que no cuadran contra la
 * cadena, y el contrato rechaza la liquidacion entera por una diferencia de
 * un wei.
 */

/** Direccion EVM en formato checksum. */
export type Address = string;

/** Monto en la unidad minima del token nativo. */
export type Wei = bigint;

/** Basis points: 10_000 = 100%. */
export type Bps = number;

/** Una GPU dentro de un equipo. */
export interface GpuSpec {
  /** Modelo, solo informativo para la interfaz. */
  readonly model: string;
  /** Hashrate nominal en milihashes por segundo (entero). */
  readonly hashrateMilliHs: number;
  /** Consumo nominal de la tarjeta en vatios (entero). */
  readonly tdpWatts: number;
}

/** Un equipo de mineria aportado por un socio. */
export interface RigSpec {
  readonly id: string;
  /** Socio que aporta el equipo. Debe existir en el PoolRegistry. */
  readonly partner: Address;
  readonly gpus: readonly GpuSpec[];
  /** Consumo de placa base, CPU, ventiladores y demas, en vatios. */
  readonly baseloadWatts: number;
  /**
   * Eficiencia de la fuente en basis points (9000 = 90%).
   * El medidor de la empresa de luz cobra lo que entra a la fuente, no lo que
   * sale de ella, asi que el consumo real siempre es mayor al nominal.
   */
  readonly psuEfficiencyBps: Bps;
}

/** Lectura de telemetria de un equipo durante un periodo. */
export interface RigTelemetry {
  readonly rigId: string;
  /** Segundos que el equipo estuvo efectivamente minando durante el periodo. */
  readonly uptimeSeconds: number;
  /**
   * Hashrate promedio real medido mientras estuvo encendido, en milihashes/s.
   * Puede diferir del nominal por overclock, undervolt, throttling termico o
   * shares rechazados.
   */
  readonly averageHashrateMilliHs: number;
}

/** Telemetria completa de un periodo. */
export interface EpochTelemetry {
  readonly epochId: number;
  /** Inicio del periodo, en segundos Unix. */
  readonly startedAt: number;
  /** Fin del periodo, en segundos Unix. */
  readonly endedAt: number;
  readonly rigs: readonly RigTelemetry[];
}

/** Configuracion economica del pool. */
export interface PoolConfig {
  readonly rigs: readonly RigSpec[];
  /** Tarifa electrica en wei por kilovatio-hora. */
  readonly tariffWeiPerKwh: Wei;
  /** Reserva del fondo de mantenimiento en basis points. */
  readonly maintenanceBps: Bps;
  readonly energyWallet: Address;
  readonly maintenanceVault: Address;
}

/** Aporte de un socio durante un periodo. */
export interface PartnerContribution {
  readonly partner: Address;
  /**
   * Peso del aporte: hashrate efectivo integrado sobre el tiempo encendido,
   * en milihashes. Es la magnitud que decide el reparto.
   */
  readonly weight: bigint;
  /** Consumo atribuible al socio, en vatios-segundo en la toma de corriente. */
  readonly wallWattSeconds: bigint;
}

/** Una linea del reparto, en el mismo formato que consume el contrato. */
export interface SettlementPayout {
  readonly to: Address;
  readonly amount: Wei;
  readonly role: "PARTNER" | "ENERGY" | "MAINTENANCE";
}

/** Resultado completo del calculo de un periodo. */
export interface Settlement {
  readonly epochId: number;
  /** Bruto minado en el periodo. */
  readonly gross: Wei;
  /** Reserva del fondo de mantenimiento. */
  readonly maintenance: Wei;
  /** Costo de energia efectivamente pagado este periodo. */
  readonly energyPaid: Wei;
  /** Costo de energia que el periodo no alcanzo a cubrir y se arrastra. */
  readonly energyDebtCarried: Wei;
  /** Reparto entre los socios. */
  readonly partnerPayouts: readonly SettlementPayout[];
  /** Lineas en el formato exacto que recibe `PoolSplitter.settle`. */
  readonly payouts: readonly SettlementPayout[];
  /** Aportes que justifican el reparto, para mostrar en la interfaz. */
  readonly contributions: readonly PartnerContribution[];
}
