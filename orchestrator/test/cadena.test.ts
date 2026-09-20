import { describe, expect, it } from "@jest/globals";
import {
  CadenaIncorrectaError,
  RECHAZADA_POR_LA_PERSONA,
  SOLICITUD_PENDIENTE,
  asegurarCadena,
  codigoRpc,
  mensajeDeWallet,
  type DatosCadena,
  type ProveedorRpc,
} from "../src/adapters/cadena.js";

const HSK: DatosCadena = {
  chainId: 133,
  nombre: "HSKChain Testnet",
  moneda: "HSK",
  rpc: "https://testnet.hsk.xyz",
  explorer: "https://testnet-explorer.hskchain.net",
};

/** No dormir de verdad: los tests no tienen por que tardar lo que tarda una wallet. */
const sinEsperas = { esperar: async () => {}, intentos: 3 };

/**
 * Wallet simulada. `comportamiento` decide que hace ante cada solicitud, que es
 * justamente donde las wallets reales difieren entre si.
 */
function walletFalsa(opciones: {
  chainInicial: number;
  alCambiar?: (llamada: number) => "ok" | Error;
  alAgregar?: () => "ok" | "registra-sin-cambiar" | Error;
}) {
  let chainId = opciones.chainInicial;
  const llamadas: string[] = [];
  let cambios = 0;

  const proveedor: ProveedorRpc = {
    async send(metodo, params) {
      llamadas.push(metodo);
      if (metodo === "eth_chainId") return `0x${chainId.toString(16)}`;

      if (metodo === "wallet_switchEthereumChain") {
        cambios += 1;
        const resultado = opciones.alCambiar?.(cambios) ?? "ok";
        if (resultado instanceof Error) throw resultado;
        chainId = Number(BigInt((params[0] as { chainId: string }).chainId));
        return null;
      }

      if (metodo === "wallet_addEthereumChain") {
        const resultado = opciones.alAgregar?.() ?? "ok";
        if (resultado instanceof Error) throw resultado;
        // "ok" modela las wallets que agregan y cambian de una;
        // "registra-sin-cambiar", las que agregan y se quedan donde estaban.
        if (resultado === "ok") chainId = Number(BigInt((params[0] as { chainId: string }).chainId));
        return null;
      }

      throw new Error(`metodo inesperado: ${metodo}`);
    },
  };

  return { proveedor, llamadas, chainIdFinal: () => chainId };
}

/** Error tal como lo envuelve ethers v6: el codigo real queda anidado. */
function errorDeEthers(codigo: number) {
  return Object.assign(new Error("could not coalesce error"), {
    code: "UNKNOWN_ERROR",
    error: { code: codigo, message: "Unrecognized chain ID" },
  });
}

describe("codigoRpc", () => {
  /**
   * El primer bug que llego a produccion: leer solo la raiz devuelve
   * "UNKNOWN_ERROR" y se pierde el 4902, que es el caso a tratar.
   */
  it("encuentra el codigo aunque ethers lo deje anidado", () => {
    expect(codigoRpc(errorDeEthers(4902))).toBe(4902);
  });

  it("lo encuentra tambien en la raiz", () => {
    expect(codigoRpc({ code: 4001 })).toBe(4001);
  });

  it("lo encuentra bajo info.error, como lo deja otro envoltorio de ethers", () => {
    expect(codigoRpc({ info: { error: { code: 4902 } } })).toBe(4902);
  });

  it("devuelve indefinido cuando no hay codigo", () => {
    expect(codigoRpc(new Error("cualquier cosa"))).toBeUndefined();
    expect(codigoRpc(null)).toBeUndefined();
  });
});

describe("mensajeDeWallet", () => {
  /** El error exacto que devolvio MetaMask al pulsar "Conectar" dos veces. */
  it("explica que hay una solicitud abierta en la wallet", () => {
    const error = Object.assign(
      new Error("could not coalesce error (error={ \"code\": -32002 ... })"),
      { code: "UNKNOWN_ERROR", error: { code: SOLICITUD_PENDIENTE, message: "already pending" } },
    );
    const mensaje = mensajeDeWallet(error);
    expect(mensaje).toMatch(/open request/);
    expect(mensaje).not.toMatch(/coalesce/);
  });

  /** Lo que devuelve un Safe cuando la llamada interna revierte, p. ej. un periodo ya usado. */
  it("explica el GS013 del Safe en vez de mostrar el codigo opaco", () => {
    const error = new Error('execution reverted: "GS013" (action="estimateGas", data="0x08c379a0...")');
    const mensaje = mensajeDeWallet(error);
    expect(mensaje).toMatch(/period is higher than the last settled one/);
    expect(mensaje).toMatch(/GS013/);
  });

  it("no confunde otros codigos del Safe con GS013", () => {
    expect(mensajeDeWallet(new Error('execution reverted: "GS026"'))).toBe('execution reverted: "GS026"');
  });

  it("avisa cuando la persona rechazo la solicitud", () => {
    expect(mensajeDeWallet(errorDeEthers(RECHAZADA_POR_LA_PERSONA))).toMatch(/You rejected/);
  });

  it("conserva el mensaje original para cualquier otro fallo", () => {
    expect(mensajeDeWallet(new Error("fondos insuficientes"))).toBe("fondos insuficientes");
    expect(mensajeDeWallet("texto suelto")).toBe("texto suelto");
    expect(mensajeDeWallet(errorDeEthers(4902))).toBe("could not coalesce error");
  });
});

describe("asegurarCadena", () => {
  it("no molesta a la wallet si ya esta en la cadena correcta", async () => {
    const { proveedor, llamadas } = walletFalsa({ chainInicial: 133 });
    await asegurarCadena(proveedor, HSK, sinEsperas);
    expect(llamadas).toEqual(["eth_chainId"]);
  });

  it("cambia de cadena cuando la wallet ya la conoce", async () => {
    const { proveedor, chainIdFinal } = walletFalsa({ chainInicial: 1 });
    await asegurarCadena(proveedor, HSK, sinEsperas);
    expect(chainIdFinal()).toBe(133);
  });

  /** El bug original: el 4902 llegaba envuelto y nunca se agregaba la cadena. */
  it("agrega la cadena cuando la wallet no la conoce, con el error envuelto por ethers", async () => {
    const { proveedor, llamadas, chainIdFinal } = walletFalsa({
      chainInicial: 1,
      alCambiar: (n) => (n === 1 ? errorDeEthers(4902) : "ok"),
    });

    await asegurarCadena(proveedor, HSK, sinEsperas);

    expect(llamadas).toContain("wallet_addEthereumChain");
    expect(chainIdFinal()).toBe(133);
  });

  /** El segundo bug: la wallet agrega la cadena pero se queda donde estaba. */
  it("vuelve a pedir el cambio si agregar la cadena no cambio a ella", async () => {
    const { proveedor, llamadas, chainIdFinal } = walletFalsa({
      chainInicial: 1,
      alCambiar: (n) => (n === 1 ? errorDeEthers(4902) : "ok"),
      alAgregar: () => "registra-sin-cambiar",
    });

    await asegurarCadena(proveedor, HSK, sinEsperas);

    // Dos solicitudes de cambio: la que fallo y la de despues de agregar.
    expect(llamadas.filter((l) => l === "wallet_switchEthereumChain")).toHaveLength(2);
    expect(chainIdFinal()).toBe(133);
  });

  it("acepta una wallet que cambia sola al agregar la cadena", async () => {
    const { proveedor, chainIdFinal } = walletFalsa({
      chainInicial: 1,
      alCambiar: (n) => (n === 1 ? errorDeEthers(4902) : "ok"),
      alAgregar: () => "ok",
    });
    await asegurarCadena(proveedor, HSK, sinEsperas);
    expect(chainIdFinal()).toBe(133);
  });

  /** Si la persona dice que no, no se le insiste con un segundo dialogo. */
  it("respeta el rechazo de la persona y no intenta agregar la cadena", async () => {
    const { proveedor, llamadas } = walletFalsa({
      chainInicial: 1,
      alCambiar: () => errorDeEthers(RECHAZADA_POR_LA_PERSONA),
    });

    await expect(asegurarCadena(proveedor, HSK, sinEsperas)).rejects.toThrow();
    expect(llamadas).not.toContain("wallet_addEthereumChain");
  });

  it("falla con un mensaje claro si la wallet nunca cambia", async () => {
    const { proveedor } = walletFalsa({
      chainInicial: 1,
      alCambiar: () => errorDeEthers(4902),
      alAgregar: () => "registra-sin-cambiar",
    });

    await expect(asegurarCadena(proveedor, HSK, sinEsperas)).rejects.toThrow(CadenaIncorrectaError);
  });

  /**
   * Algunas wallets tardan un instante en reflejar el cambio. Declarar el fallo
   * en la primera consulta produciria un error donde no hay problema.
   */
  it("le da margen a la wallet que tarda en reflejar el cambio", async () => {
    let chainId = 1;
    let consultas = 0;
    const proveedor: ProveedorRpc = {
      async send(metodo) {
        if (metodo === "eth_chainId") {
          consultas += 1;
          // Recien en la tercera consulta la wallet reporta la cadena nueva.
          if (consultas >= 3) chainId = 133;
          return `0x${chainId.toString(16)}`;
        }
        return null;
      },
    };

    await expect(asegurarCadena(proveedor, HSK, sinEsperas)).resolves.toBeUndefined();
  });

  it("pasa a la wallet los datos correctos de la cadena al agregarla", async () => {
    let agregada: Record<string, unknown> | undefined;
    const proveedor: ProveedorRpc = {
      async send(metodo, params) {
        if (metodo === "eth_chainId") return agregada ? "0x85" : "0x1";
        if (metodo === "wallet_switchEthereumChain" && !agregada) throw errorDeEthers(4902);
        if (metodo === "wallet_addEthereumChain") agregada = params[0] as Record<string, unknown>;
        return null;
      },
    };

    await asegurarCadena(proveedor, HSK, sinEsperas);

    expect(agregada).toMatchObject({
      chainId: "0x85",
      chainName: "HSKChain Testnet",
      rpcUrls: ["https://testnet.hsk.xyz"],
      blockExplorerUrls: ["https://testnet-explorer.hskchain.net"],
      nativeCurrency: { name: "HSK", symbol: "HSK", decimals: 18 },
    });
  });
});
