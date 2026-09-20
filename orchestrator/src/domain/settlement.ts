import type {
  EpochTelemetry,
  PartnerContribution,
  PoolConfig,
  Settlement,
  SettlementPayout,
  Wei,
} from "./types.js";
import { assertNonNegative, min, splitByWeight, sum } from "./money.js";
import { HashrateWeightedContributionCalculator, type ContributionCalculator } from "./contribution.js";
import { TariffEnergyCostCalculator, type EnergyCostCalculator } from "./energy.js";
import { FixedBpsMaintenancePolicy, type MaintenancePolicy } from "./maintenance.js";

export interface SettlementInput {
  readonly config: PoolConfig;
  readonly telemetry: EpochTelemetry;
  /** Bruto minado en el periodo, tal como llego al Safe. */
  readonly gross: Wei;
  /** Energia que periodos anteriores no alcanzaron a cubrir. */
  readonly carriedEnergyDebt?: Wei;
}

export class UnpublishableSettlementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnpublishableSettlementError";
  }
}

/**
 * Arma el reparto de un periodo componiendo las politicas del dominio.
 *
 * No calcula nada por si mismo: delega en las piezas inyectadas y se ocupa solo
 * del orden en que se sirven los compromisos. Cambiar como se mide el aporte o
 * como se cobra la luz no requiere tocar esta clase.
 */
export class SettlementBuilder {
  readonly #contributions: ContributionCalculator;
  readonly #energy: EnergyCostCalculator;
  readonly #maintenance: MaintenancePolicy;

  constructor(
    contributions: ContributionCalculator = new HashrateWeightedContributionCalculator(),
    energy: EnergyCostCalculator = new TariffEnergyCostCalculator(),
    maintenance: MaintenancePolicy = new FixedBpsMaintenancePolicy(),
  ) {
    this.#contributions = contributions;
    this.#energy = energy;
    this.#maintenance = maintenance;
  }

  /**
   * Orden de prelacion cuando el periodo no alcanza para todo:
   *
   *   1. **Fondo de mantenimiento.** Va primero porque el contrato lo exige como
   *      piso: una liquidacion que no lo respete es rechazada por la cadena, asi
   *      que no es una prioridad economica sino una precondicion tecnica.
   *   2. **Energia.** Si la factura no se paga, cortan la luz y el pool deja de
   *      existir. Lo que el periodo no cubra no se perdona: queda como deuda y
   *      se cobra del siguiente.
   *   3. **Socios.** Cobran lo que sobra. Son los duenos del negocio, y el dueno
   *      es el ultimo en cobrar.
   *
   * Con este orden la conservacion se cumple por construccion:
   * `mantenimiento + energia_pagada + suma(socios) === bruto`, sin excepciones.
   */
  build(input: SettlementInput): Settlement {
    const { config, telemetry, gross } = input;
    const carriedEnergyDebt = input.carriedEnergyDebt ?? 0n;

    assertNonNegative("gross", gross);
    assertNonNegative("carriedEnergyDebt", carriedEnergyDebt);

    const contributions = this.#contributions.calculate(config, telemetry);

    const maintenance = this.#maintenance.reserve(config, gross);
    const available = gross - maintenance;

    const energyDue = this.#energy.cost(config, contributions) + carriedEnergyDebt;
    const energyPaid = min(energyDue, available);
    const energyDebtCarried = energyDue - energyPaid;

    const partnersPool = available - energyPaid;
    const shares = splitByWeight(
      partnersPool,
      contributions.map((contribution) => contribution.weight),
    );

    const partnerPayouts: SettlementPayout[] = contributions.map((contribution, index) => ({
      to: contribution.partner,
      amount: shares[index] ?? 0n,
      role: "PARTNER" as const,
    }));

    const payouts: SettlementPayout[] = [
      { to: config.energyWallet, amount: energyPaid, role: "ENERGY" },
      { to: config.maintenanceVault, amount: maintenance, role: "MAINTENANCE" },
      ...partnerPayouts,
    ];

    const settlement: Settlement = {
      epochId: telemetry.epochId,
      gross,
      maintenance,
      energyPaid,
      energyDebtCarried,
      partnerPayouts,
      payouts,
      contributions,
    };

    // Red de seguridad ante un calculador inyectado que se comporte mal. Es
    // barato y convierte un reparto incorrecto en un fallo ruidoso aca, en vez
    // de un revert opaco de la cadena varios pasos despues.
    this.#assertConserved(settlement);

    return settlement;
  }

  #assertConserved(settlement: Settlement): void {
    const total = sum(settlement.payouts.map((payout) => payout.amount));
    if (total !== settlement.gross) {
      throw new UnpublishableSettlementError(
        `el reparto no conserva el valor: las lineas suman ${total} y el bruto es ${settlement.gross}`,
      );
    }
  }
}

/**
 * Comprueba las precondiciones que `PoolSplitter.settle` exige, antes de gastar
 * gas y antes de pedirle a los socios que firmen algo que la cadena va a
 * rechazar.
 */
export function assertPublishable(settlement: Settlement, config: PoolConfig): void {
  if (settlement.gross <= 0n) {
    throw new UnpublishableSettlementError(
      `el periodo ${settlement.epochId} no tiene ganancias que repartir`,
    );
  }
  if (settlement.payouts.length < 3) {
    throw new UnpublishableSettlementError(
      `el reparto necesita al menos energia, mantenimiento y un socio (tiene ${settlement.payouts.length} lineas)`,
    );
  }
  if (settlement.payouts.length > 18) {
    throw new UnpublishableSettlementError(
      `el reparto excede el maximo de 18 lineas por liquidacion (tiene ${settlement.payouts.length})`,
    );
  }

  const seen = new Set<string>();
  for (const payout of settlement.payouts) {
    const key = payout.to.toLowerCase();
    if (seen.has(key)) {
      throw new UnpublishableSettlementError(`la direccion ${payout.to} aparece dos veces en el reparto`);
    }
    seen.add(key);
  }

  const floor = (settlement.gross * BigInt(config.maintenanceBps)) / 10_000n;
  if (settlement.maintenance < floor) {
    throw new UnpublishableSettlementError(
      `la reserva de mantenimiento (${settlement.maintenance}) no alcanza el piso exigido por el contrato (${floor})`,
    );
  }
}
