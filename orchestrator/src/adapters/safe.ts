import { TypedDataEncoder, getAddress, Signature } from "ethers";

/**
 * Construccion y firma de la transaccion del Safe.
 *
 * Existe porque la interfaz oficial de Safe no cubre todas las cadenas, y en
 * particular puede no cubrir la de esta hackathon. En vez de depender de un
 * servicio externo, el protocolo arma la transaccion, calcula su hash EIP-712 y
 * recolecta las firmas por su cuenta. El resultado es el mismo que produce la
 * aplicacion de Safe, y funciona en cualquier cadena donde sus contratos esten
 * desplegados.
 *
 * El hash que se calcula aca tiene que coincidir al bit con el que el contrato
 * de Safe calcula en Solidity. Si difirieran, los socios firmarian un hash que
 * el Safe no reconoce y el fallo recien aparecerian al ejecutar. La suite lo
 * comprueba contra un fixture generado por el Safe real desplegado en HSKChain.
 */

export interface SafeTransaction {
  readonly to: string;
  readonly value: bigint;
  readonly data: string;
  /** 0 = CALL, 1 = DELEGATECALL. El protocolo solo usa CALL. */
  readonly operation: 0 | 1;
  readonly safeTxGas: bigint;
  readonly baseGas: bigint;
  readonly gasPrice: bigint;
  readonly gasToken: string;
  readonly refundReceiver: string;
  readonly nonce: bigint;
}

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * Tipo EIP-712 de Safe. El orden de los campos es parte del hash: alterarlo
 * produce un hash valido en apariencia que el contrato rechaza.
 */
export const SAFE_TX_TYPES = {
  SafeTx: [
    {name: "to", type: "address"},
    {name: "value", type: "uint256"},
    {name: "data", type: "bytes"},
    {name: "operation", type: "uint8"},
    {name: "safeTxGas", type: "uint256"},
    {name: "baseGas", type: "uint256"},
    {name: "gasPrice", type: "uint256"},
    {name: "gasToken", type: "address"},
    {name: "refundReceiver", type: "address"},
    {name: "nonce", type: "uint256"},
  ],
} as const;

/**
 * Arma una transaccion del Safe con los valores por defecto del protocolo.
 *
 * `safeTxGas` y `gasPrice` quedan en cero a proposito: con esa configuracion,
 * si la llamada interna falla, Safe revierte la transaccion entera en vez de
 * consumir el nonce y dejar constancia de una liquidacion a medias.
 */
export function buildSafeTransaction(
  params: Pick<SafeTransaction, "to" | "value" | "data" | "nonce"> & Partial<SafeTransaction>,
): SafeTransaction {
  return {
    to: getAddress(params.to),
    value: params.value,
    data: params.data,
    operation: params.operation ?? 0,
    safeTxGas: params.safeTxGas ?? 0n,
    baseGas: params.baseGas ?? 0n,
    gasPrice: params.gasPrice ?? 0n,
    gasToken: params.gasToken ?? ZERO_ADDRESS,
    refundReceiver: params.refundReceiver ?? ZERO_ADDRESS,
    nonce: params.nonce,
  };
}

/** Dominio EIP-712 de un Safe. Desde la version 1.3.0 incluye el chainId. */
export function safeDomain(chainId: number | bigint, safeAddress: string) {
  return {chainId: BigInt(chainId), verifyingContract: getAddress(safeAddress)};
}

/**
 * Calcula el hash que los duenos del Safe tienen que firmar.
 * Equivale a `getTransactionHash` del contrato.
 */
export function computeSafeTxHash(
  chainId: number | bigint,
  safeAddress: string,
  transaction: SafeTransaction,
): string {
  return TypedDataEncoder.hash(safeDomain(chainId, safeAddress), SAFE_TX_TYPES as never, transaction);
}

/** Una firma recolectada de un dueno del Safe. */
export interface OwnerSignature {
  readonly signer: string;
  /** Firma de 65 bytes en formato hexadecimal. */
  readonly signature: string;
}

export class DuplicateSignerError extends Error {
  constructor(signer: string) {
    super(`el dueno ${signer} firmo dos veces`);
    this.name = "DuplicateSignerError";
  }
}

export class InsufficientSignaturesError extends Error {
  constructor(recolectadas: number, umbral: number) {
    super(`el Safe exige ${umbral} firmas y se recolectaron ${recolectadas}`);
    this.name = "InsufficientSignaturesError";
  }
}

/**
 * Concatena las firmas en el formato que espera `execTransaction`.
 *
 * Safe recorre las firmas comprobando que las direcciones que recupera vayan en
 * orden ascendente: es asi como detecta que un mismo dueno no firmo dos veces.
 * Mandarlas en cualquier otro orden hace fallar la validacion aunque todas sean
 * validas, que es un error facil de cometer y dificil de diagnosticar.
 */
export function encodeSignatures(signatures: readonly OwnerSignature[], threshold: number): string {
  if (signatures.length < threshold) {
    throw new InsufficientSignaturesError(signatures.length, threshold);
  }

  const vistos = new Set<string>();
  for (const {signer} of signatures) {
    const clave = getAddress(signer).toLowerCase();
    if (vistos.has(clave)) throw new DuplicateSignerError(signer);
    vistos.add(clave);
  }

  const ordenadas = [...signatures].sort((a, b) =>
    getAddress(a.signer).toLowerCase() < getAddress(b.signer).toLowerCase() ? -1 : 1,
  );

  return `0x${ordenadas
    .map(({signature}) => {
      // Se normaliza a traves de ethers para aceptar tanto firmas compactas
      // (EIP-2098) como las de 65 bytes, y emitir siempre el formato r||s||v.
      const parsed = Signature.from(signature);
      return parsed.r.slice(2) + parsed.s.slice(2) + parsed.v.toString(16).padStart(2, "0");
    })
    .join("")}`;
}
