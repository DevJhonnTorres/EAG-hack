import { JsonRpcProvider } from "ethers";

/** Provider de solo lectura: sirve para leer la cadena sin pedirle permiso a nadie. */
export function lectorDeCadena(rpc: string, chainId: number): JsonRpcProvider {
  // Fijar la red evita una llamada extra de deteccion en cada arranque.
  return new JsonRpcProvider(rpc, chainId, { staticNetwork: true });
}
