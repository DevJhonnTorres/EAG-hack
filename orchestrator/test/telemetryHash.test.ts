import { describe, expect, it } from "@jest/globals";
import { canonicalizeTelemetry, hashTelemetry } from "../src/domain/telemetryHash.js";
import { WEEK, telemetry } from "./fixtures.js";

describe("hashTelemetry", () => {
  it("produce un hash keccak256 de 32 bytes", () => {
    const hash = hashTelemetry(telemetry(1, [{ rigId: "rig-a", uptimeSeconds: WEEK }]));
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  /**
   * Es lo que hace util al anclaje: la API de telemetria puede devolver los
   * equipos en cualquier orden, y el hash tiene que ser el mismo para que
   * cualquier socio pueda reproducirlo.
   */
  it("no depende del orden en que la telemetria reporte los equipos", () => {
    const enUnOrden = telemetry(1, [
      { rigId: "rig-a", uptimeSeconds: WEEK },
      { rigId: "rig-b", uptimeSeconds: WEEK },
    ]);
    const enElOtro = telemetry(1, [
      { rigId: "rig-b", uptimeSeconds: WEEK },
      { rigId: "rig-a", uptimeSeconds: WEEK },
    ]);

    expect(hashTelemetry(enUnOrden)).toBe(hashTelemetry(enElOtro));
  });

  it("cambia si cambia un solo segundo de uptime", () => {
    const original = telemetry(1, [{ rigId: "rig-a", uptimeSeconds: WEEK }]);
    const alterado = telemetry(1, [{ rigId: "rig-a", uptimeSeconds: WEEK - 1 }]);

    expect(hashTelemetry(original)).not.toBe(hashTelemetry(alterado));
  });

  it("cambia si cambia el periodo", () => {
    const uno = telemetry(1, [{ rigId: "rig-a", uptimeSeconds: WEEK }]);
    const dos = telemetry(2, [{ rigId: "rig-a", uptimeSeconds: WEEK }]);

    expect(hashTelemetry(uno)).not.toBe(hashTelemetry(dos));
  });

  it("serializa con las claves ordenadas, para que el resultado sea reproducible", () => {
    const json = canonicalizeTelemetry(telemetry(1, [{ rigId: "rig-a", uptimeSeconds: 10 }]));
    expect(json).toBe(
      JSON.stringify({
        endedAt: 1_700_000_000 + WEEK,
        epochId: 1,
        rigs: [{ averageHashrateMilliHs: 120_000_000_000, rigId: "rig-a", uptimeSeconds: 10 }],
        startedAt: 1_700_000_000,
      }),
    );
  });
});
