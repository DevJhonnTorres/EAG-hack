import { describe, expect, it, jest, beforeEach, afterEach } from "@jest/globals";
import { readFileSync } from "node:fs";
import { Interface, id as keccakId } from "ethers";
import { BlockscoutError, cuadra, fetchHistorial } from "../src/adapters/blockscout.js";

const SPLITTER = "0x333FAd08F22752896C55C052352AcE6C6Ab620B7";
const EXPLORER = "https://testnet-explorer.hskchain.net";

const ENERGY = "0xcd23dAd3cDb7eb7046829f033c92107fC60F316b";
const MAINTENANCE = "0x8cFA796c87e83963052263A06329F1Ef52DE5653";
const PARTNER_A = "0x92302923eBE05EC3984A49755346Cf02327e7CA5";
const PARTNER_B = "0x937B8Ead58E73d1A22022d9731536589793207a6";

/**
 * ABI del contrato realmente compilado. Se usa para generar los logs de prueba,
 * de modo que si alguien cambia un evento en Solidity y no actualiza el lector,
 * estos tests fallan en vez de dejar un historial que se lee vacio en silencio.
 */
const artefacto = JSON.parse(
  readFileSync(new URL("../../contracts/out/PoolSplitter.sol/PoolSplitter.json", import.meta.url), "utf8"),
);
const contrato = new Interface(artefacto.abi);

function log(nombre: string, args: unknown[], extra: Record<string, unknown> = {}) {
  const { topics, data } = contrato.encodeEventLog(nombre, args);
  return {
    topics,
    data,
    transaction_hash: "0xabc",
    block_number: 100,
    block_timestamp: "2026-09-20T05:00:00Z",
    ...extra,
  };
}

function mockFetch(items: unknown[], ok = true, status = 200) {
  return jest.fn(async () => ({
    ok,
    status,
    json: async () => ({ items }),
  })) as unknown as typeof fetch;
}

const fetchOriginal = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = fetchOriginal;
});

describe("fetchHistorial", () => {
  /**
   * La comprobacion que justifica generar los logs desde el artefacto compilado:
   * el lector y el contrato tienen que hablar del mismo evento. Si divergieran,
   * el historial se leeria vacio sin ningun error visible.
   */
  it("el lector decodifica los eventos que el contrato compilado realmente emite", async () => {
    globalThis.fetch = mockFetch([
      log("SettlementExecuted", [1, 10n ** 18n, keccakId("telemetria"), 4]),
      log("PayoutSent", [1, ENERGY, 2, 2n * 10n ** 17n]),
      log("PayoutSent", [1, MAINTENANCE, 3, 5n * 10n ** 16n]),
      log("PayoutSent", [1, PARTNER_A, 1, 5n * 10n ** 17n]),
      log("PayoutSent", [1, PARTNER_B, 1, 25n * 10n ** 16n]),
    ]);

    const historial = await fetchHistorial(EXPLORER, SPLITTER);

    expect(historial).toHaveLength(1);
    const liquidacion = historial[0]!;
    expect(liquidacion.epochId).toBe(1);
    expect(liquidacion.gross).toBe(10n ** 18n);
    expect(liquidacion.telemetryHash).toBe(keccakId("telemetria"));
    expect(liquidacion.pagos).toHaveLength(4);
  });

  it("traduce el numero del rol al nombre correcto", async () => {
    globalThis.fetch = mockFetch([
      log("SettlementExecuted", [1, 10n ** 18n, keccakId("t"), 3]),
      log("PayoutSent", [1, ENERGY, 2, 1n]),
      log("PayoutSent", [1, MAINTENANCE, 3, 1n]),
      log("PayoutSent", [1, PARTNER_A, 1, 1n]),
    ]);

    const roles = (await fetchHistorial(EXPLORER, SPLITTER))[0]!.pagos.map((p) => p.role);
    expect(roles).toContain("ENERGY");
    expect(roles).toContain("MAINTENANCE");
    expect(roles).toContain("PARTNER");
  });

  /**
   * Blockscout devuelve los logs del mas reciente al mas antiguo, asi que los
   * pagos de un periodo llegan antes que el evento que lo abre.
   */
  it("arma la liquidacion aunque los pagos lleguen antes que su encabezado", async () => {
    globalThis.fetch = mockFetch([
      log("PayoutSent", [7, PARTNER_A, 1, 5n * 10n ** 17n]),
      log("PayoutSent", [7, ENERGY, 2, 5n * 10n ** 17n]),
      log("SettlementExecuted", [7, 10n ** 18n, keccakId("t"), 2]),
    ]);

    const liquidacion = (await fetchHistorial(EXPLORER, SPLITTER))[0]!;
    expect(liquidacion.epochId).toBe(7);
    expect(liquidacion.gross).toBe(10n ** 18n);
    expect(liquidacion.pagos).toHaveLength(2);
  });

  it("marca los pagos que quedaron acreditados por no poder entregarse", async () => {
    globalThis.fetch = mockFetch([
      log("SettlementExecuted", [1, 10n ** 18n, keccakId("t"), 2]),
      log("PayoutSent", [1, ENERGY, 2, 5n * 10n ** 17n]),
      log("PayoutCredited", [1, PARTNER_B, 5n * 10n ** 17n]),
    ]);

    const pagos = (await fetchHistorial(EXPLORER, SPLITTER))[0]!.pagos;
    const acreditado = pagos.find((p) => p.acreditado);
    expect(acreditado?.to).toBe(PARTNER_B);
    expect(acreditado?.amount).toBe(5n * 10n ** 17n);
  });

  it("devuelve las liquidaciones de la mas reciente a la mas antigua", async () => {
    globalThis.fetch = mockFetch([
      log("SettlementExecuted", [3, 10n ** 18n, keccakId("c"), 1]),
      log("SettlementExecuted", [1, 10n ** 18n, keccakId("a"), 1]),
      log("SettlementExecuted", [2, 10n ** 18n, keccakId("b"), 1]),
    ]);

    expect((await fetchHistorial(EXPLORER, SPLITTER)).map((l) => l.epochId)).toEqual([3, 2, 1]);
  });

  it("ignora eventos ajenos en vez de romperse", async () => {
    globalThis.fetch = mockFetch([
      { topics: [keccakId("OtroEvento(uint256)")], data: "0x", transaction_hash: "0x1" },
      log("SettlementExecuted", [1, 10n ** 18n, keccakId("t"), 1]),
    ]);

    expect(await fetchHistorial(EXPLORER, SPLITTER)).toHaveLength(1);
  });

  it("devuelve vacio cuando el pool todavia no liquido nada", async () => {
    globalThis.fetch = mockFetch([]);
    expect(await fetchHistorial(EXPLORER, SPLITTER)).toEqual([]);
  });

  it("informa el error cuando el explorer responde mal", async () => {
    globalThis.fetch = mockFetch([], false, 503);
    await expect(fetchHistorial(EXPLORER, SPLITTER)).rejects.toThrow(BlockscoutError);
  });

  it("informa el error cuando no hay red", async () => {
    globalThis.fetch = jest.fn(async () => {
      throw new Error("ENOTFOUND");
    }) as unknown as typeof fetch;
    await expect(fetchHistorial(EXPLORER, SPLITTER)).rejects.toThrow(BlockscoutError);
  });
});

describe("cuadra", () => {
  const base = {
    epochId: 1,
    telemetryHash: keccakId("t"),
    txHash: "0xabc",
    blockNumber: 1,
    timestamp: null,
  };

  it("confirma la conservacion cuando los pagos suman el bruto", () => {
    expect(
      cuadra({
        ...base,
        gross: 100n,
        pagos: [
          { to: ENERGY, amount: 20n, role: "ENERGY", acreditado: false },
          { to: MAINTENANCE, amount: 5n, role: "MAINTENANCE", acreditado: false },
          { to: PARTNER_A, amount: 75n, role: "PARTNER", acreditado: false },
        ],
      }),
    ).toBe(true);
  });

  /** Un wei de diferencia tiene que delatar el problema, no pasar desapercibido. */
  it("detecta una diferencia de un solo wei", () => {
    expect(
      cuadra({
        ...base,
        gross: 100n,
        pagos: [{ to: ENERGY, amount: 99n, role: "ENERGY", acreditado: false }],
      }),
    ).toBe(false);
  });

  it("no da por buena una liquidacion sin bruto", () => {
    expect(cuadra({ ...base, gross: 0n, pagos: [] })).toBe(false);
  });
});
