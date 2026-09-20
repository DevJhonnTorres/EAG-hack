import { BrowserProvider, type Eip1193Provider } from "ethers";
import { asegurarCadena as asegurarCadenaEnProveedor, type DatosCadena } from "@hashpool/orchestrator";

export { CadenaIncorrectaError, type DatosCadena } from "@hashpool/orchestrator";

/**
 * Conexion con la wallet del navegador.
 *
 * Se habla EIP-1193 directamente, sin libreria de conexion. Para un pool de dos
 * socios que firman desde MetaMask no hace falta mas, y evita arrastrar un
 * arbol de dependencias que habria que auditar en el camino del dinero.
 *
 * La logica de llevar la wallet a la cadena correcta vive en el paquete del
 * motor, donde esta cubierta por tests con wallets simuladas: es el punto que
 * ya produjo dos fallos que no se veian sin una wallet real delante.
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
    super("no wallet detected in the browser");
    this.name = "SinWalletError";
  }
}

export function haySoporteDeWallet(): boolean {
  return typeof window !== "undefined" && window.ethereum !== undefined;
}

function nuevoProvider(): BrowserProvider {
  if (!haySoporteDeWallet()) throw new SinWalletError();
  return new BrowserProvider(window.ethereum!, "any");
}

export async function asegurarCadena(cadena: DatosCadena): Promise<void> {
  await asegurarCadenaEnProveedor(nuevoProvider(), cadena);
}

export async function conectar(cadena: DatosCadena): Promise<{ provider: BrowserProvider; cuenta: string }> {
  const provider = nuevoProvider();
  const cuentas = (await provider.send("eth_requestAccounts", [])) as string[];
  const cuenta = cuentas[0];
  if (!cuenta) throw new Error("the wallet returned no accounts");

  await asegurarCadenaEnProveedor(provider, cadena);

  // Se devuelve un provider nuevo: el anterior nacio apuntando a la red vieja y
  // conserva ese dato cacheado, que despues enturbia el envio de transacciones.
  return { provider: nuevoProvider(), cuenta };
}

/**
 * Pide a la wallet que deje elegir otra cuenta para este sitio y devuelve la elegida.
 *
 * MetaMask solo entrega a una pagina las cuentas que la persona le autorizo. Cambiar
 * de cuenta en la extension no basta: la pagina sigue viendo la que conecto antes. Este
 * pedido abre el selector de cuentas de la wallet, donde se autoriza la que se quiere.
 */
export async function elegirOtraCuenta(cadena: DatosCadena): Promise<{ provider: BrowserProvider; cuenta: string }> {
  if (!haySoporteDeWallet()) throw new SinWalletError();
  await window.ethereum!.request({ method: "wallet_requestPermissions", params: [{ eth_accounts: {} }] });
  return conectar(cadena);
}

/**
 * Avisa cuando la persona cambia de cuenta en la wallet. Devuelve la funcion que deja
 * de escuchar. Sin wallet, no hace nada.
 */
export function alCambiarCuenta(manejador: (cuentas: string[]) => void): () => void {
  const wallet = typeof window !== "undefined" ? window.ethereum : undefined;
  if (!wallet?.on) return () => {};
  wallet.on("accountsChanged", manejador);
  return () => wallet.removeListener?.("accountsChanged", manejador);
}
