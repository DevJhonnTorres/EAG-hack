/**
 * Llevar la wallet a la cadena correcta.
 *
 * Vive aca, y no en la interfaz, porque es logica pura sobre EIP-1193 y ya
 * costo dos errores en produccion: el codigo del fallo viene anidado y no en la
 * raiz, y agregar una cadena no siempre cambia a ella. Ninguno de los dos se
 * veia sin una wallet real delante. Con un provider simulado, ambos casos son
 * un test.
 *
 * Firmar en la cadena equivocada produce una firma valida que el Safe rechaza,
 * porque el chainId es parte del dominio EIP-712. Sin este paso, el error
 * aparecerian recien al ejecutar, sin ninguna pista de la causa.
 */

/** Lo minimo que se necesita de un provider para esto. */
export interface ProveedorRpc {
  send(metodo: string, params: unknown[]): Promise<unknown>;
}

export interface DatosCadena {
  readonly chainId: number;
  readonly nombre: string;
  readonly moneda: string;
  readonly rpc: string;
  readonly explorer: string;
}

export class CadenaIncorrectaError extends Error {
  constructor(
    readonly actual: number,
    readonly esperada: number,
  ) {
    super(`the wallet is on chain ${actual} and the pool lives on chain ${esperada}`);
    this.name = "CadenaIncorrectaError";
  }
}

/** 4001: la persona rechazo la solicitud en la wallet. */
export const RECHAZADA_POR_LA_PERSONA = 4001;

/**
 * Extrae el codigo de error JSON-RPC de la wallet.
 *
 * ethers envuelve los errores del provider, asi que el codigo original queda
 * anidado y no en la raiz. Leer solo `causa.code` devuelve "UNKNOWN_ERROR" y
 * hace perder el 4902, que es justamente el caso que hay que tratar.
 */
export function codigoRpc(causa: unknown): number | undefined {
  const candidatos = [
    causa,
    (causa as {error?: unknown} | null)?.error,
    (causa as {info?: {error?: unknown}} | null)?.info?.error,
    (causa as {data?: {originalError?: unknown}} | null)?.data?.originalError,
    (causa as {cause?: unknown} | null)?.cause,
  ];
  for (const candidato of candidatos) {
    const codigo = (candidato as {code?: unknown} | null)?.code;
    if (typeof codigo === "number") return codigo;
  }
  return undefined;
}

/** -32002: la wallet ya tiene una solicitud abierta de este sitio y espera respuesta. */
export const SOLICITUD_PENDIENTE = -32002;

/**
 * Texto para mostrar cuando la wallet falla.
 *
 * El mensaje crudo de ethers ("could not coalesce error ...") no le dice nada a
 * quien esta usando la pagina. Los dos casos que si tienen accion clara se
 * traducen; cualquier otro conserva el mensaje original, que es lo que ayuda a
 * diagnosticar.
 */
export function mensajeDeWallet(causa: unknown): string {
  const codigo = codigoRpc(causa);
  if (codigo === SOLICITUD_PENDIENTE) {
    return "The wallet already has an open request from this page. Open the extension, approve or reject that request, and try again.";
  }
  if (codigo === RECHAZADA_POR_LA_PERSONA) return "You rejected the request in the wallet.";
  const original = causa instanceof Error ? causa.message : String(causa);
  // GS013: el Safe intento ejecutar la llamada interna y esta fallo. Con gas de
  // seguridad en cero, el Safe revierte todo en vez de marcarla como fallida.
  if (original.includes("GS013")) {
    return "The Safe could not run the settlement (GS013): the call to the splitter would revert on-chain. Check that the period is higher than the last settled one, that the recipients are registered, and that the vault holds enough funds.";
  }
  return original;
}

export interface AsegurarCadenaOpciones {
  /** Cuantas veces se reconsulta la cadena antes de darla por fallida. */
  readonly intentos?: number;
  /** Espera entre reconsultas, inyectable para que los tests no duerman. */
  readonly esperar?: (ms: number) => Promise<void>;
}

/**
 * Pregunta la cadena a la wallet sin intermediarios.
 *
 * `getNetwork()` de ethers sirve una version cacheada, que justo despues de un
 * cambio de red todavia devuelve la anterior. Preguntar por `eth_chainId` da el
 * valor vigente y evita concluir que el cambio fallo cuando en realidad funciono.
 */
export async function chainIdActual(proveedor: ProveedorRpc): Promise<number> {
  const hex = (await proveedor.send("eth_chainId", [])) as string;
  return Number(BigInt(hex));
}

export async function asegurarCadena(
  proveedor: ProveedorRpc,
  cadena: DatosCadena,
  opciones: AsegurarCadenaOpciones = {},
): Promise<void> {
  if ((await chainIdActual(proveedor)) === cadena.chainId) return;

  const chainIdHex = `0x${cadena.chainId.toString(16)}`;

  try {
    await proveedor.send("wallet_switchEthereumChain", [{chainId: chainIdHex}]);
  } catch (causa) {
    // Si la persona dijo que no, se respeta y no se le insiste con otro dialogo.
    if (codigoRpc(causa) === RECHAZADA_POR_LA_PERSONA) throw causa;

    // Para cualquier otro fallo se intenta agregar la cadena. El caso tipico es
    // 4902 ("cadena desconocida"), pero no se condiciona a ese codigo: distintas
    // wallets lo reportan de formas distintas, y agregar una cadena que la wallet
    // ya conoce no hace dano.
    await proveedor.send("wallet_addEthereumChain", [
      {
        chainId: chainIdHex,
        chainName: cadena.nombre,
        nativeCurrency: {name: cadena.moneda, symbol: cadena.moneda, decimals: 18},
        rpcUrls: [cadena.rpc],
        blockExplorerUrls: [cadena.explorer],
      },
    ]);

    // Agregar una cadena no siempre cambia a ella: varias wallets la registran y
    // se quedan donde estaban. Por eso se vuelve a pedir el cambio.
    try {
      await proveedor.send("wallet_switchEthereumChain", [{chainId: chainIdHex}]);
    } catch (segunda) {
      if (codigoRpc(segunda) === RECHAZADA_POR_LA_PERSONA) throw segunda;
      // Otros fallos se ignoran: puede que la wallet ya haya cambiado al agregar,
      // y quien decide es la comprobacion de abajo.
    }
  }

  // La wallet puede tardar un instante en reflejar el cambio, asi que se le da
  // margen en vez de declarar el fallo en el primer intento.
  const intentos = opciones.intentos ?? 12;
  const esperar = opciones.esperar ?? ((ms: number) => new Promise<void>((listo) => setTimeout(listo, ms)));

  for (let intento = 0; intento < intentos; intento += 1) {
    if ((await chainIdActual(proveedor)) === cadena.chainId) return;
    await esperar(300);
  }

  throw new CadenaIncorrectaError(await chainIdActual(proveedor), cadena.chainId);
}
