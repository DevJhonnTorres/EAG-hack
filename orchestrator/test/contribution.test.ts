import { describe, expect, it } from "@jest/globals";
import {
  HashrateWeightedContributionCalculator,
  InvalidTelemetryError,
  UnknownRigError,
} from "../src/domain/contribution.js";
import { DAY, PARTNER_A, PARTNER_B, WEEK, telemetry, twoPartnerPool } from "./fixtures.js";

const calculator = new HashrateWeightedContributionCalculator();

describe("HashrateWeightedContributionCalculator", () => {
  it("pondera el aporte 2:1 cuando ambos equipos corren el periodo completo", () => {
    const config = twoPartnerPool();
    const contributions = calculator.calculate(
      config,
      telemetry(1, [
        { rigId: "rig-a", uptimeSeconds: WEEK },
        { rigId: "rig-b", uptimeSeconds: WEEK },
      ]),
    );

    expect(contributions).toHaveLength(2);
    const [a, b] = contributions;
    expect(a!.partner).toBe(PARTNER_A);
    expect(b!.partner).toBe(PARTNER_B);
    expect(a!.weight).toBe(b!.weight * 2n);
  });

  it("devuelve los socios ordenados por direccion, para que el reparto sea reproducible", () => {
    const config = twoPartnerPool();
    const contributions = calculator.calculate(
      config,
      telemetry(1, [
        { rigId: "rig-b", uptimeSeconds: WEEK },
        { rigId: "rig-a", uptimeSeconds: WEEK },
      ]),
    );
    expect(contributions.map((c) => c.partner)).toEqual([PARTNER_A, PARTNER_B]);
  });

  /**
   * El caso que motiva el proyecto: el equipo de un socio estuvo apagado dos
   * dias de los siete.
   */
  it("descuenta el aporte del socio cuyo equipo estuvo apagado dos dias", () => {
    const config = twoPartnerPool();
    const completo = calculator.calculate(
      config,
      telemetry(1, [
        { rigId: "rig-a", uptimeSeconds: WEEK },
        { rigId: "rig-b", uptimeSeconds: WEEK },
      ]),
    );
    const conCaida = calculator.calculate(
      config,
      telemetry(2, [
        { rigId: "rig-a", uptimeSeconds: WEEK },
        { rigId: "rig-b", uptimeSeconds: WEEK - 2 * DAY },
      ]),
    );

    const bCompleto = completo.find((c) => c.partner === PARTNER_B)!;
    const bConCaida = conCaida.find((c) => c.partner === PARTNER_B)!;

    expect(bConCaida.weight).toBe((bCompleto.weight * 5n) / 7n);
    // Y, lo que importa tanto como lo anterior: tampoco se le cobra esa luz.
    expect(bConCaida.wallWattSeconds).toBe((bCompleto.wallWattSeconds * 5n) / 7n);

    // El socio que si estuvo encendido no se ve afectado en ninguna de las dos.
    const aCompleto = completo.find((c) => c.partner === PARTNER_A)!;
    const aConCaida = conCaida.find((c) => c.partner === PARTNER_A)!;
    expect(aConCaida.weight).toBe(aCompleto.weight);
    expect(aConCaida.wallWattSeconds).toBe(aCompleto.wallWattSeconds);
  });

  it("trata un equipo que dejo de reportar como apagado todo el periodo", () => {
    const config = twoPartnerPool();
    const contributions = calculator.calculate(config, telemetry(1, [{ rigId: "rig-a", uptimeSeconds: WEEK }]));

    const b = contributions.find((c) => c.partner === PARTNER_B)!;
    expect(b.weight).toBe(0n);
    expect(b.wallWattSeconds).toBe(0n);
  });

  it("refleja el rendimiento real y no el nominal", () => {
    const config = twoPartnerPool();
    const contributions = calculator.calculate(
      config,
      telemetry(1, [
        // rig-a hace throttling termico y rinde la mitad de lo nominal.
        { rigId: "rig-a", uptimeSeconds: WEEK, averageHashrateMilliHs: 60_000_000_000 },
        { rigId: "rig-b", uptimeSeconds: WEEK },
      ]),
    );
    const [a, b] = contributions;
    expect(a!.weight).toBe(b!.weight);
  });

  it("cobra la energia en la toma y no en la placa, aplicando la eficiencia de la fuente", () => {
    const config = twoPartnerPool();
    const contributions = calculator.calculate(config, telemetry(1, [{ rigId: "rig-b", uptimeSeconds: 3_600 }]));

    // Una placa de 220 W mas 80 W de baseload = 300 W nominales durante 1 hora.
    // Con la fuente al 90%, el medidor ve 300 * 10000 / 9000 = 333 W.
    const b = contributions.find((c) => c.partner === PARTNER_B)!;
    expect(b.wallWattSeconds).toBe((300n * 3_600n * 10_000n) / 9_000n);
  });

  describe("validacion de la telemetria", () => {
    it("rechaza un equipo que no esta declarado en la configuracion", () => {
      const config = twoPartnerPool();
      expect(() => calculator.calculate(config, telemetry(1, [{ rigId: "rig-fantasma", uptimeSeconds: 10 }]))).toThrow(
        UnknownRigError,
      );
    });

    it("rechaza un equipo que reporta dos veces el mismo periodo", () => {
      const config = twoPartnerPool();
      expect(() =>
        calculator.calculate(
          config,
          telemetry(1, [
            { rigId: "rig-a", uptimeSeconds: WEEK },
            { rigId: "rig-a", uptimeSeconds: WEEK },
          ]),
        ),
      ).toThrow(InvalidTelemetryError);
    });

    it("rechaza un uptime mayor que la duracion del periodo", () => {
      const config = twoPartnerPool();
      expect(() => calculator.calculate(config, telemetry(1, [{ rigId: "rig-a", uptimeSeconds: WEEK + 1 }]))).toThrow(
        InvalidTelemetryError,
      );
    });

    it("rechaza uptime y hashrate negativos", () => {
      const config = twoPartnerPool();
      expect(() => calculator.calculate(config, telemetry(1, [{ rigId: "rig-a", uptimeSeconds: -1 }]))).toThrow(
        InvalidTelemetryError,
      );
      expect(() =>
        calculator.calculate(config, telemetry(1, [{ rigId: "rig-a", uptimeSeconds: 10, averageHashrateMilliHs: -5 }])),
      ).toThrow(InvalidTelemetryError);
    });

    it("rechaza un periodo que termina antes de empezar", () => {
      const config = twoPartnerPool();
      expect(() =>
        calculator.calculate(config, {
          epochId: 1,
          startedAt: 1_000,
          endedAt: 500,
          rigs: [],
        }),
      ).toThrow(InvalidTelemetryError);
    });
  });
});
