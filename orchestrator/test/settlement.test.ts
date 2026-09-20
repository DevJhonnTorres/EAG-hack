import { describe, expect, it } from "@jest/globals";
import fc from "fast-check";
import { SettlementBuilder, UnpublishableSettlementError, assertPublishable } from "../src/domain/settlement.js";
import { sum } from "../src/domain/money.js";
import {
  DAY,
  ENERGY_WALLET,
  MAINTENANCE_VAULT,
  PARTNER_A,
  PARTNER_B,
  WEEK,
  telemetry,
  twoPartnerPool,
} from "./fixtures.js";

const builder = new SettlementBuilder();

const ambosEncendidos = (epochId = 1) =>
  telemetry(epochId, [
    { rigId: "rig-a", uptimeSeconds: WEEK },
    { rigId: "rig-b", uptimeSeconds: WEEK },
  ]);

/** Bruto de referencia: 1 unidad del token nativo minada en la semana. */
const GROSS = 10n ** 18n;

describe("SettlementBuilder", () => {
  describe("reparto normal", () => {
    it("conserva el bruto exactamente: lo que entra es lo que sale", () => {
      const config = twoPartnerPool();
      const settlement = builder.build({ config, telemetry: ambosEncendidos(), gross: GROSS });

      expect(sum(settlement.payouts.map((p) => p.amount))).toBe(GROSS);
    });

    it("reserva para mantenimiento exactamente lo que el contrato exige como piso", () => {
      const config = twoPartnerPool();
      const settlement = builder.build({ config, telemetry: ambosEncendidos(), gross: GROSS });

      // Replica literal de PoolRegistry.requiredMaintenance: si difiriera aunque
      // fuera en un wei, la cadena rechazaria la liquidacion.
      expect(settlement.maintenance).toBe((GROSS * 5n) / 100n);
    });

    it("reparte entre los socios en proporcion 2:1 cuando ambos corrieron el periodo entero", () => {
      const config = twoPartnerPool();
      const settlement = builder.build({ config, telemetry: ambosEncendidos(), gross: GROSS });

      const a = settlement.partnerPayouts.find((p) => p.to === PARTNER_A)!;
      const b = settlement.partnerPayouts.find((p) => p.to === PARTNER_B)!;

      // Con reparto exacto de enteros, la diferencia con el 2:1 ideal es de a lo
      // sumo un wei por el sobrante.
      const diferencia = a.amount - b.amount * 2n;
      expect(diferencia >= -1n && diferencia <= 1n).toBe(true);
    });

    it("produce las lineas en el formato que consume el contrato", () => {
      const config = twoPartnerPool();
      const settlement = builder.build({ config, telemetry: ambosEncendidos(), gross: GROSS });

      const roles = settlement.payouts.map((p) => p.role);
      expect(roles.filter((r) => r === "ENERGY")).toHaveLength(1);
      expect(roles.filter((r) => r === "MAINTENANCE")).toHaveLength(1);
      expect(roles.filter((r) => r === "PARTNER")).toHaveLength(2);

      expect(settlement.payouts[0]!.to).toBe(ENERGY_WALLET);
      expect(settlement.payouts[1]!.to).toBe(MAINTENANCE_VAULT);

      const direcciones = settlement.payouts.map((p) => p.to.toLowerCase());
      expect(new Set(direcciones).size).toBe(direcciones.length);
    });

    it("no arrastra deuda cuando el periodo cubre la factura", () => {
      const config = twoPartnerPool();
      const settlement = builder.build({ config, telemetry: ambosEncendidos(), gross: GROSS });

      expect(settlement.energyDebtCarried).toBe(0n);
      expect(settlement.energyPaid > 0n).toBe(true);
    });
  });

  describe("el socio que tuvo el equipo apagado dos dias", () => {
    it("cobra menos, pero tampoco paga la luz de esos dos dias", () => {
      const config = twoPartnerPool();

      const completo = builder.build({ config, telemetry: ambosEncendidos(1), gross: GROSS });
      const conCaida = builder.build({
        config,
        telemetry: telemetry(2, [
          { rigId: "rig-a", uptimeSeconds: WEEK },
          { rigId: "rig-b", uptimeSeconds: WEEK - 2 * DAY },
        ]),
        gross: GROSS,
      });

      const bCompleto = completo.partnerPayouts.find((p) => p.to === PARTNER_B)!.amount;
      const bConCaida = conCaida.partnerPayouts.find((p) => p.to === PARTNER_B)!.amount;
      expect(bConCaida < bCompleto).toBe(true);

      // Y la factura total del pool baja, porque hubo menos consumo.
      expect(conCaida.energyPaid < completo.energyPaid).toBe(true);
    });

    it("el socio que si estuvo encendido absorbe la porcion liberada", () => {
      const config = twoPartnerPool();

      const completo = builder.build({ config, telemetry: ambosEncendidos(1), gross: GROSS });
      const conCaida = builder.build({
        config,
        telemetry: telemetry(2, [
          { rigId: "rig-a", uptimeSeconds: WEEK },
          { rigId: "rig-b", uptimeSeconds: WEEK - 2 * DAY },
        ]),
        gross: GROSS,
      });

      const aCompleto = completo.partnerPayouts.find((p) => p.to === PARTNER_A)!.amount;
      const aConCaida = conCaida.partnerPayouts.find((p) => p.to === PARTNER_A)!.amount;
      expect(aConCaida > aCompleto).toBe(true);
    });

    it("un socio con el equipo apagado todo el periodo cobra cero y no rompe el reparto", () => {
      const config = twoPartnerPool();
      const settlement = builder.build({
        config,
        telemetry: telemetry(1, [
          { rigId: "rig-a", uptimeSeconds: WEEK },
          { rigId: "rig-b", uptimeSeconds: 0 },
        ]),
        gross: GROSS,
      });

      expect(settlement.partnerPayouts.find((p) => p.to === PARTNER_B)!.amount).toBe(0n);
      expect(sum(settlement.payouts.map((p) => p.amount))).toBe(GROSS);
    });
  });

  describe("periodo en perdida", () => {
    /** Tarifa absurda que hace que la luz cueste mas que lo minado. */
    const tarifaCara = { tariffWeiPerKwh: 10n ** 18n };

    it("paga lo que puede de la luz y arrastra el resto como deuda", () => {
      const config = twoPartnerPool(tarifaCara);
      const settlement = builder.build({ config, telemetry: ambosEncendidos(), gross: GROSS });

      expect(settlement.energyDebtCarried > 0n).toBe(true);
      expect(settlement.energyPaid).toBe(GROSS - settlement.maintenance);
    });

    it("los socios cobran cero, pero la liquidacion sigue cuadrando", () => {
      const config = twoPartnerPool(tarifaCara);
      const settlement = builder.build({ config, telemetry: ambosEncendidos(), gross: GROSS });

      for (const payout of settlement.partnerPayouts) {
        expect(payout.amount).toBe(0n);
      }
      expect(sum(settlement.payouts.map((p) => p.amount))).toBe(GROSS);
    });

    it("respeta el piso de mantenimiento incluso en perdida, porque el contrato lo exige", () => {
      const config = twoPartnerPool(tarifaCara);
      const settlement = builder.build({ config, telemetry: ambosEncendidos(), gross: GROSS });

      expect(settlement.maintenance).toBe((GROSS * 5n) / 100n);
      expect(() => assertPublishable(settlement, config)).not.toThrow();
    });

    it("cobra la deuda arrastrada en el periodo siguiente", () => {
      const config = twoPartnerPool();
      const deuda = 10n ** 17n;

      const sinDeuda = builder.build({ config, telemetry: ambosEncendidos(), gross: GROSS });
      const conDeuda = builder.build({
        config,
        telemetry: ambosEncendidos(),
        gross: GROSS,
        carriedEnergyDebt: deuda,
      });

      expect(conDeuda.energyPaid).toBe(sinDeuda.energyPaid + deuda);
      const aSinDeuda = sinDeuda.partnerPayouts.find((p) => p.to === PARTNER_A)!.amount;
      const aConDeuda = conDeuda.partnerPayouts.find((p) => p.to === PARTNER_A)!.amount;
      expect(aConDeuda < aSinDeuda).toBe(true);
    });

    it("rechaza un bruto negativo", () => {
      const config = twoPartnerPool();
      expect(() => builder.build({ config, telemetry: ambosEncendidos(), gross: -1n })).toThrow();
    });
  });

  describe("assertPublishable", () => {
    it("acepta una liquidacion normal", () => {
      const config = twoPartnerPool();
      const settlement = builder.build({ config, telemetry: ambosEncendidos(), gross: GROSS });
      expect(() => assertPublishable(settlement, config)).not.toThrow();
    });

    it("rechaza un periodo sin ganancias, que la cadena revertiria", () => {
      const config = twoPartnerPool();
      const settlement = builder.build({ config, telemetry: ambosEncendidos(), gross: 0n });
      expect(() => assertPublishable(settlement, config)).toThrow(UnpublishableSettlementError);
    });

    it("rechaza un reparto con menos de tres lineas", () => {
      const config = twoPartnerPool();
      const settlement = builder.build({ config, telemetry: ambosEncendidos(), gross: GROSS });
      const recortado = { ...settlement, payouts: settlement.payouts.slice(0, 2) };
      expect(() => assertPublishable(recortado, config)).toThrow(UnpublishableSettlementError);
    });

    it("rechaza un reparto con una direccion repetida", () => {
      const config = twoPartnerPool();
      const settlement = builder.build({ config, telemetry: ambosEncendidos(), gross: GROSS });
      const duplicado = {
        ...settlement,
        payouts: [...settlement.payouts, { to: PARTNER_A, amount: 0n, role: "PARTNER" as const }],
      };
      expect(() => assertPublishable(duplicado, config)).toThrow(UnpublishableSettlementError);
    });

    it("rechaza una reserva de mantenimiento por debajo del piso del contrato", () => {
      const config = twoPartnerPool();
      const settlement = builder.build({ config, telemetry: ambosEncendidos(), gross: GROSS });
      const insuficiente = { ...settlement, maintenance: settlement.maintenance - 1n };
      expect(() => assertPublishable(insuficiente, config)).toThrow(UnpublishableSettlementError);
    });
  });

  describe("propiedades", () => {
    /**
     * La invariante que el contrato verifica on-chain, comprobada aca contra
     * cientos de escenarios aleatorios: brutos, tarifas, reservas y patrones de
     * encendido arbitrarios.
     */
    it("conserva el valor para cualquier escenario", () => {
      fc.assert(
        fc.property(
          fc.bigInt({ min: 0n, max: 10n ** 24n }),
          fc.bigInt({ min: 0n, max: 10n ** 20n }),
          fc.integer({ min: 0, max: 5_000 }),
          fc.integer({ min: 0, max: WEEK }),
          fc.integer({ min: 0, max: WEEK }),
          fc.bigInt({ min: 0n, max: 10n ** 20n }),
          (gross, tariffWeiPerKwh, maintenanceBps, uptimeA, uptimeB, carriedEnergyDebt) => {
            const config = twoPartnerPool({ tariffWeiPerKwh, maintenanceBps });
            const settlement = builder.build({
              config,
              telemetry: telemetry(1, [
                { rigId: "rig-a", uptimeSeconds: uptimeA },
                { rigId: "rig-b", uptimeSeconds: uptimeB },
              ]),
              gross,
              carriedEnergyDebt,
            });

            expect(sum(settlement.payouts.map((p) => p.amount))).toBe(gross);
          },
        ),
        { numRuns: 500 },
      );
    });

    it("nunca produce una linea negativa ni una reserva por debajo del piso", () => {
      fc.assert(
        fc.property(
          fc.bigInt({ min: 0n, max: 10n ** 24n }),
          fc.bigInt({ min: 0n, max: 10n ** 20n }),
          fc.integer({ min: 0, max: 5_000 }),
          fc.integer({ min: 0, max: WEEK }),
          (gross, tariffWeiPerKwh, maintenanceBps, uptimeA) => {
            const config = twoPartnerPool({ tariffWeiPerKwh, maintenanceBps });
            const settlement = builder.build({
              config,
              telemetry: telemetry(1, [
                { rigId: "rig-a", uptimeSeconds: uptimeA },
                { rigId: "rig-b", uptimeSeconds: WEEK },
              ]),
              gross,
            });

            for (const payout of settlement.payouts) {
              expect(payout.amount >= 0n).toBe(true);
            }
            expect(settlement.maintenance).toBe((gross * BigInt(maintenanceBps)) / 10_000n);
          },
        ),
        { numRuns: 500 },
      );
    });
  });
});
