import { describe, expect, it } from "@jest/globals";
import {
  BridgeLineaError,
  USDC_ETHEREUM,
  USDC_LINEA,
  cotizarBridgeLinea,
} from "../src/adapters/bridgeLinea.js";

const USDC = 10n ** 6n;

/** Una respuesta de LI.FI con la forma real: 25 USDC, bridge Across, gas de Ethereum. */
function respuestaLifi(cambios: { estimate?: Record<string, unknown>; tool?: unknown } = {}) {
  return {
    tool: "across",
    estimate: {
      fromAmount: "25000000",
      toAmount: "24914356",
      executionDuration: 2,
      gasCosts: [{ type: "SEND", estimate: "459000", amountUSD: "0.0985" }],
      feeCosts: [{ name: "Relayer fee", amountUSD: "0.0025", included: true }],
      ...cambios.estimate,
    },
    ...(cambios.tool !== undefined ? { tool: cambios.tool } : {}),
  };
}

function fetchSimulado(cuerpo: unknown, estado = 200) {
  const llamadas: string[] = [];
  const fetchImpl = (async (url: string) => {
    llamadas.push(url);
    return new Response(typeof cuerpo === "string" ? cuerpo : JSON.stringify(cuerpo), { status: estado });
  }) as unknown as typeof fetch;
  return { fetchImpl, llamadas };
}

describe("cotizarBridgeLinea", () => {
  it("suma las comisiones del bridge y el gas de Ethereum", async () => {
    const { fetchImpl } = fetchSimulado(respuestaLifi());
    const cotizacion = await cotizarBridgeLinea(25n * USDC, fetchImpl);

    expect(cotizacion).toEqual({
      herramienta: "across",
      monto: 25_000_000n,
      recibe: 24_914_356n,
      // 25.000000 - 24.914356 = 0.085644 USDC descontados por el bridge.
      comisiones: 85_644n,
      // 0.0985 USD de gas.
      gas: 98_500n,
      costoTotal: 184_144n,
      segundos: 2,
    });
  });

  it("conserva el valor: costo total = comisiones + gas", async () => {
    const { fetchImpl } = fetchSimulado(respuestaLifi());
    const c = await cotizarBridgeLinea(25n * USDC, fetchImpl);
    expect(c.costoTotal).toBe(c.comisiones + c.gas);
    expect(c.monto - c.recibe).toBe(c.comisiones);
  });

  it("pide la cotizacion de USDC de Ethereum a Linea con una direccion neutra", async () => {
    const { fetchImpl, llamadas } = fetchSimulado(respuestaLifi());
    await cotizarBridgeLinea(25n * USDC, fetchImpl);

    const url = new URL(llamadas[0]!);
    expect(url.origin + url.pathname).toBe("https://li.quest/v1/quote");
    expect(url.searchParams.get("fromChain")).toBe("1");
    expect(url.searchParams.get("toChain")).toBe("59144");
    expect(url.searchParams.get("fromToken")).toBe(USDC_ETHEREUM);
    expect(url.searchParams.get("toToken")).toBe(USDC_LINEA);
    expect(url.searchParams.get("fromAmount")).toBe("25000000");
    // No se le manda a un tercero la direccion de un socio.
    expect(url.searchParams.get("fromAddress")).toBe("0x0000000000000000000000000000000000000001");
  });

  it("redondea el gas hacia arriba: nunca subestima el costo", async () => {
    const { fetchImpl } = fetchSimulado(
      respuestaLifi({ estimate: { gasCosts: [{ amountUSD: "0.09851234" }, { amountUSD: "0.0000001" }] } }),
    );
    // 98512.34 sube a 98513, y 0.1 sube a 1.
    expect((await cotizarBridgeLinea(25n * USDC, fetchImpl)).gas).toBe(98_514n);
  });

  it("acepta un bridge sin gas ni duracion informados", async () => {
    const { fetchImpl } = fetchSimulado(respuestaLifi({ estimate: { gasCosts: [], executionDuration: undefined }, tool: 7 }));
    const c = await cotizarBridgeLinea(25n * USDC, fetchImpl);
    expect(c.gas).toBe(0n);
    expect(c.segundos).toBeNull();
    expect(c.herramienta).toBe("desconocida");
  });

  describe("rechazos", () => {
    it("un monto que no es positivo, sin llamar a la red", async () => {
      const { fetchImpl, llamadas } = fetchSimulado(respuestaLifi());
      await expect(cotizarBridgeLinea(0n, fetchImpl)).rejects.toThrow(RangeError);
      await expect(cotizarBridgeLinea(-1n, fetchImpl)).rejects.toThrow(RangeError);
      expect(llamadas).toHaveLength(0);
    });

    it("una respuesta de error de LI.FI", async () => {
      const { fetchImpl } = fetchSimulado({ message: "No available quotes for the requested transfer" }, 404);
      await expect(cotizarBridgeLinea(25n * USDC, fetchImpl)).rejects.toThrow(
        /LI.FI respondio 404: No available quotes/,
      );
    });

    it("un error sin mensaje o con un cuerpo que no es JSON", async () => {
      await expect(cotizarBridgeLinea(25n * USDC, fetchSimulado({}, 500).fetchImpl)).rejects.toThrow(/respondio 500$/);
      await expect(cotizarBridgeLinea(25n * USDC, fetchSimulado("<html>", 502).fetchImpl)).rejects.toThrow(/502/);
    });

    it("una respuesta sin estimacion", async () => {
      for (const cuerpo of [{}, { estimate: [] }, []]) {
        await expect(cotizarBridgeLinea(25n * USDC, fetchSimulado(cuerpo).fetchImpl)).rejects.toThrow(
          /no devolvio una estimacion/,
        );
      }
    });

    it("montos que no son enteros", async () => {
      await expect(
        cotizarBridgeLinea(25n * USDC, fetchSimulado(respuestaLifi({ estimate: { toAmount: "24.5" } })).fetchImpl),
      ).rejects.toThrow(BridgeLineaError);
      await expect(
        cotizarBridgeLinea(25n * USDC, fetchSimulado(respuestaLifi({ estimate: { fromAmount: 25 } })).fetchImpl),
      ).rejects.toThrow(/fromAmount no es un entero/);
    });

    it("un bridge que entregaria mas de lo que recibe", async () => {
      const { fetchImpl } = fetchSimulado(respuestaLifi({ estimate: { toAmount: "26000000" } }));
      await expect(cotizarBridgeLinea(25n * USDC, fetchImpl)).rejects.toThrow(/entregaria mas de lo que recibe/);
    });

    it("un costo de gas ausente: darlo por cero subestimaria el bridge", async () => {
      await expect(
        cotizarBridgeLinea(25n * USDC, fetchSimulado(respuestaLifi({ estimate: { gasCosts: undefined } })).fetchImpl),
      ).rejects.toThrow(/no informo el costo de gas/);
      await expect(
        cotizarBridgeLinea(25n * USDC, fetchSimulado(respuestaLifi({ estimate: { gasCosts: [{ type: "SEND" }] } })).fetchImpl),
      ).rejects.toThrow(/no trae su monto en USD/);
    });
  });

  it("usa el fetch global si no se le indica otro", () => {
    expect(() => cotizarBridgeLinea(1n)).not.toThrow();
  });
});
