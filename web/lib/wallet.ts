import { BrowserProvider, JsonRpcProvider, type Eip1193Provider } from "ethers";

/**
 * Conexion con la wallet del navegador.
 *
 * Se habla EIP-1193 directamente, sin libreria de conexion. Para un pool de dos
 * socios que firman desde MetaMask no hace falta mas, y evita arrastrar un
 * arbol de dependencias que habria que auditar en el camino del dinero.
 */

declare global {
  interface Window {
    ethereum?: Eip1193Provider & {
      on?: (evento: string, manejador: (...args: never[]) => void) => void;
      removeListener?: (evento: string, manejador: (...args: never[]) => void) => void;
    };
  }
}

export class SinWalletError extends Error {
  constructor() {
    super("no se detecto ninguna wallet en el navegador");
    this.name = "SinWalletError";
  }
}

export class CadenaIncorrectaError extends Error {
  constructor(actual: number, esperada: number) {
    super(`la wallet esta en la cadena ${actual} y el pool vive en la ${esperada}`);
    this.name = "CadenaIncorrectaError";
  }
}

export interface DatosCadena {
  readonly chainId: number;
  readonly nombre: string;
  readonly moneda: string;
  readonly rpc: string;
  readonly explorer: string;
}

/** Provider de solo lectura: sirve para leer la cadena sin pedirle permiso a nadie. */
export function lectorDeCadena(rpc: string, chainId: number): JsonRpcProvider {
  // Fijar la red evita una llamada extra de deteccion en cada arranque.
  return new JsonRpcProvider(rpc, chainId, { staticNetwork: true });
}

export function haySoporteDeWallet(): boolean {
  return typeof window !== "undefined" && window.ethereum !== undefined;
}

export async function conectar(cadena: DatosCadena): Promise<{ provider: BrowserProvider; cuenta: string }> {
  if (!haySoporteDeWallet()) throw new SinWalletError();

  const provider = new BrowserProvider(window.ethereum!, "any");
  const cuentas = (await provider.send("eth_requestAccounts", [])) as string[];
  const cuenta = cuentas[0];
  if (!cuenta) throw new Error("la wallet no devolvio ninguna cuenta");

  await asegurarCadena(provider, cadena);
  return { provider, cuenta };
}

/**
 * Lleva la wallet a la cadena del pool, agregandola si no la conoce.
 *
 * Firmar en la cadena equivocada produce una firma valida que el Safe rechaza,
 * porque el chainId es parte del dominio EIP-712. Sin este paso, el error
 * aparecerian recien al ejecutar, sin ninguna pista de la causa.
 */
/**
 * Extrae el codigo de error JSON-RPC de la wallet.
 *
 * ethers envuelve los errores del provider, asi que el codigo original queda
 * anidado y no en la raiz. Leer solo `causa.code` devuelve "UNKNOWN_ERROR" y
 * hace perder el 4902, que es justamente el caso que hay que tratar.
 */
function codigoRpc(causa: unknown): number | undefined {
  const candidatos = [
    causa,
    (causa as { error?: unknown } | null)?.error,
    (causa as { info?: { error?: unknown } } | null)?.info?.error,
    (causa as { data?: { originalError?: unknown } } | null)?.data?.originalError,
  ];
  for (const candidato of candidatos) {
    const codigo = (candidato as { code?: unknown } | null)?.code;
    if (typeof codigo === "number") return codigo;
  }
  return undefined;
}

/** 4001: la persona rechazo la solicitud en la wallet. */
const RECHAZADA_POR_LA_PERSONA = 4001;

export async function asegurarCadena(provider: BrowserProvider, cadena: DatosCadena): Promise<void> {
  const red = await provider.getNetwork();
  if (Number(red.chainId) === cadena.chainId) return;

  const chainIdHex = `0x${cadena.chainId.toString(16)}`;
  try {
    await provider.send("wallet_switchEthereumChain", [{ chainId: chainIdHex }]);
  } catch (causa) {
    // Si la persona dijo que no, se respeta y no se le insiste con otro dialogo.
    if (codigoRpc(causa) === RECHAZADA_POR_LA_PERSONA) throw causa;

    // Para cualquier otro fallo se intenta agregar la cadena. El caso tipico es
    // 4902 ("cadena desconocida"), pero no se condiciona a ese codigo: distintas
    // wallets lo reportan de formas distintas, y agregar una cadena que la wallet
    // ya conoce no hace dano.
    await provider.send("wallet_addEthereumChain", [
      {
        chainId: chainIdHex,
        chainName: cadena.nombre,
        nativeCurrency: { name: cadena.moneda, symbol: cadena.moneda, decimals: 18 },
        rpcUrls: [cadena.rpc],
        blockExplorerUrls: [cadena.explorer],
      },
    ]);
  }

  const despues = await provider.getNetwork();
  if (Number(despues.chainId) !== cadena.chainId) {
    throw new CadenaIncorrectaError(Number(despues.chainId), cadena.chainId);
  }
}
