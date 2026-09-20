import {
  Contract,
  Signature,
  TypedDataEncoder,
  getAddress,
  hexlify,
  randomBytes,
  recoverAddress,
  type ContractRunner,
  type Signer,
} from "ethers";

/**
 * Cliente x402: pagar por llamada, sin cuenta ni tarjeta.
 *
 * El motor de calculo necesita insumos que no son gratis (la tarifa electrica
 * vigente, el precio del coin que se mina). Con x402 el proveedor responde
 * `402 Payment Required` describiendo cuanto cobra y a donde, el cliente firma
 * una autorizacion de pago y reintenta la llamada con esa firma adjunta.
 *
 * Lo que esto habilita en este proyecto: el orquestador paga sus propios
 * insumos con la reserva del fondo de mantenimiento, sin que ningun humano
 * apruebe cada consulta. El hardware genera ingresos, el fondo reserva una
 * porcion, y el agente se financia solo. Maquina a maquina.
 *
 * Se implementa el esquema `exact` sobre EVM, que paga con una autorizacion
 * ERC-3009 firmada fuera de la cadena: quien cobra la presenta y paga el gas,
 * asi que el agente no necesita gas ni estar en linea.
 *
 * Nota sobre el alcance: x402 preve un "facilitator" que verifica y liquida por
 * cuenta del vendedor. En HSKChain no hay ninguno publico, asi que el servidor
 * de este proyecto verifica y liquida por su cuenta. El formato del protocolo
 * (los tres headers y los objetos que transportan) es el del estandar.
 */

export const X402_VERSION = 2;

export const HEADER_PAYMENT_REQUIRED = "PAYMENT-REQUIRED";
export const HEADER_PAYMENT_SIGNATURE = "PAYMENT-SIGNATURE";
export const HEADER_PAYMENT_RESPONSE = "PAYMENT-RESPONSE";

/** Una forma de pago que el vendedor acepta. */
export interface PaymentRequirement {
  readonly scheme: "exact";
  /** Red en formato CAIP-2, por ejemplo "eip155:133". */
  readonly network: string;
  /** Monto exacto a pagar, en la unidad minima del token. */
  readonly maxAmountRequired: string;
  readonly resource: string;
  readonly description: string;
  readonly mimeType: string;
  /** Quien cobra. */
  readonly payTo: string;
  /** Contrato del token con el que se paga. */
  readonly asset: string;
  readonly maxTimeoutSeconds: number;
  /** Nombre y version del dominio EIP-712 del token. */
  readonly extra: { readonly name: string; readonly version: string };
}

export interface PaymentRequired {
  readonly x402Version: number;
  readonly accepts: readonly PaymentRequirement[];
  readonly error?: string;
}

export interface Erc3009Authorization {
  readonly from: string;
  readonly to: string;
  readonly value: string;
  readonly validAfter: string;
  readonly validBefore: string;
  readonly nonce: string;
}

export interface PaymentPayload {
  readonly x402Version: number;
  readonly scheme: "exact";
  readonly network: string;
  readonly payload: {
    readonly signature: string;
    readonly authorization: Erc3009Authorization;
  };
}

export interface SettlementResponse {
  readonly success: boolean;
  readonly transaction?: string;
  readonly network?: string;
  readonly errorReason?: string;
}

export class X402Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = "X402Error";
  }
}

export class NoAcceptablePaymentError extends X402Error {
  constructor(network: string, asset: string) {
    super(`el vendedor no acepta pagos en ${asset} sobre ${network}`);
    this.name = "NoAcceptablePaymentError";
  }
}

// --------------------------------------------------------------------
// Codificacion de los headers
// --------------------------------------------------------------------

function toBase64(valor: unknown): string {
  return Buffer.from(JSON.stringify(valor), "utf8").toString("base64");
}

function fromBase64<T>(texto: string): T {
  try {
    return JSON.parse(Buffer.from(texto, "base64").toString("utf8")) as T;
  } catch (causa) {
    throw new X402Error(`no se pudo decodificar el header: ${String(causa)}`);
  }
}

export const encodePaymentRequired = (valor: PaymentRequired): string => toBase64(valor);
export const decodePaymentRequired = (texto: string): PaymentRequired => fromBase64<PaymentRequired>(texto);
export const encodePaymentPayload = (valor: PaymentPayload): string => toBase64(valor);
export const decodePaymentPayload = (texto: string): PaymentPayload => fromBase64<PaymentPayload>(texto);
export const encodeSettlementResponse = (valor: SettlementResponse): string => toBase64(valor);
export const decodeSettlementResponse = (texto: string): SettlementResponse =>
  fromBase64<SettlementResponse>(texto);

// --------------------------------------------------------------------
// Firma de la autorizacion
// --------------------------------------------------------------------

export const ERC3009_TYPES = {
  TransferWithAuthorization: [
    {name: "from", type: "address"},
    {name: "to", type: "address"},
    {name: "value", type: "uint256"},
    {name: "validAfter", type: "uint256"},
    {name: "validBefore", type: "uint256"},
    {name: "nonce", type: "bytes32"},
  ],
} as const;

export function erc3009Domain(requisito: PaymentRequirement, chainId: number) {
  return {
    name: requisito.extra.name,
    version: requisito.extra.version,
    chainId,
    verifyingContract: getAddress(requisito.asset),
  };
}

/** chainId numerico a partir de una red CAIP-2 como "eip155:133". */
export function chainIdDeRed(network: string): number {
  const [namespace, referencia] = network.split(":");
  if (namespace !== "eip155" || !referencia) {
    throw new X402Error(`solo se soportan redes EVM (eip155), llego "${network}"`);
  }
  const chainId = Number(referencia);
  if (!Number.isInteger(chainId)) throw new X402Error(`chainId invalido en "${network}"`);
  return chainId;
}

/** Hash que el pagador firma. Expuesto para que el vendedor pueda verificarlo igual. */
export function authorizationDigest(
  requisito: PaymentRequirement,
  autorizacion: Erc3009Authorization,
): string {
  return TypedDataEncoder.hash(
    erc3009Domain(requisito, chainIdDeRed(requisito.network)),
    ERC3009_TYPES as never,
    autorizacion,
  );
}

export interface ConstruirPagoOpciones {
  /** Reloj inyectable, para que los tests no dependan de la hora real. */
  readonly ahora?: () => number;
  /** Nonce inyectable, por el mismo motivo. */
  readonly nonce?: () => string;
}

/**
 * Firma la autorizacion de pago que exige un requisito.
 *
 * El nonce es aleatorio y no secuencial: el agente puede tener varias llamadas
 * en vuelo sin coordinar un contador entre ellas.
 */
export async function construirPago(
  signer: Signer,
  requisito: PaymentRequirement,
  opciones: ConstruirPagoOpciones = {},
): Promise<PaymentPayload> {
  const ahora = Math.floor((opciones.ahora?.() ?? Date.now()) / 1000);
  const from = getAddress(await signer.getAddress());

  const autorizacion: Erc3009Authorization = {
    from,
    to: getAddress(requisito.payTo),
    value: requisito.maxAmountRequired,
    // Un segundo antes: el contrato exige `block.timestamp > validAfter` estricto,
    // asi que un valor igual al momento actual haria fallar el primer intento.
    validAfter: String(ahora - 1),
    validBefore: String(ahora + requisito.maxTimeoutSeconds),
    nonce: opciones.nonce?.() ?? hexlify(randomBytes(32)),
  };

  const signature = await signer.signTypedData(
    erc3009Domain(requisito, chainIdDeRed(requisito.network)),
    ERC3009_TYPES as never,
    autorizacion,
  );

  return {
    x402Version: X402_VERSION,
    scheme: "exact",
    network: requisito.network,
    payload: {signature, authorization: autorizacion},
  };
}

// --------------------------------------------------------------------
// Cliente
// --------------------------------------------------------------------

export interface X402ClientOpciones {
  readonly signer: Signer;
  /** Red y token en los que este cliente esta dispuesto a pagar. */
  readonly network: string;
  readonly asset: string;
  /** Tope de gasto por llamada. Protege ante un vendedor que pida de mas. */
  readonly maxAmount: bigint;
  readonly fetchImpl?: typeof fetch;
  readonly construirPagoOpciones?: ConstruirPagoOpciones;
}

export interface RespuestaPagada {
  readonly response: Response;
  /** Presente si hubo que pagar. */
  readonly pago?: PaymentPayload;
  readonly liquidacion?: SettlementResponse;
}

export class PrecioExcesivoError extends X402Error {
  constructor(pedido: bigint, tope: bigint) {
    super(`el vendedor pide ${pedido} y el tope por llamada es ${tope}`);
    this.name = "PrecioExcesivoError";
  }
}

export class X402Client {
  readonly #opciones: X402ClientOpciones;
  readonly #fetch: typeof fetch;

  constructor(opciones: X402ClientOpciones) {
    this.#opciones = opciones;
    this.#fetch = opciones.fetchImpl ?? fetch;
  }

  /**
   * Pide un recurso y, si viene con precio, lo paga y reintenta.
   *
   * Reintenta una sola vez. Un segundo 402 significa que el vendedor rechazo el
   * pago, y repetir el ciclo solo gastaria mas autorizaciones firmadas.
   */
  async fetchWithPayment(url: string, init?: RequestInit): Promise<RespuestaPagada> {
    const primera = await this.#fetch(url, init);
    if (primera.status !== 402) return {response: primera};

    const header = primera.headers.get(HEADER_PAYMENT_REQUIRED);
    if (!header) throw new X402Error("el vendedor respondio 402 sin decir como pagarle");

    const requisito = this.#elegirRequisito(decodePaymentRequired(header));

    const pedido = BigInt(requisito.maxAmountRequired);
    if (pedido > this.#opciones.maxAmount) {
      throw new PrecioExcesivoError(pedido, this.#opciones.maxAmount);
    }

    const pago = await construirPago(
      this.#opciones.signer,
      requisito,
      this.#opciones.construirPagoOpciones ?? {},
    );

    const segunda = await this.#fetch(url, {
      ...init,
      headers: {...(init?.headers ?? {}), [HEADER_PAYMENT_SIGNATURE]: encodePaymentPayload(pago)},
    });

    const respuestaPago = segunda.headers.get(HEADER_PAYMENT_RESPONSE);
    return {
      response: segunda,
      pago,
      ...(respuestaPago ? {liquidacion: decodeSettlementResponse(respuestaPago)} : {}),
    };
  }

  /** Elige la forma de pago que este cliente puede satisfacer. */
  #elegirRequisito(requeridos: PaymentRequired): PaymentRequirement {
    const elegido = requeridos.accepts.find(
      (r) =>
        r.scheme === "exact" &&
        r.network === this.#opciones.network &&
        r.asset.toLowerCase() === this.#opciones.asset.toLowerCase(),
    );
    if (!elegido) throw new NoAcceptablePaymentError(this.#opciones.network, this.#opciones.asset);
    return elegido;
  }
}

// --------------------------------------------------------------------
// Liquidacion del lado del vendedor
// --------------------------------------------------------------------

const ERC3009_ABI = [
  "function transferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,uint8 v,bytes32 r,bytes32 s)",
  "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
] as const;

/**
 * Presenta la autorizacion firmada en la cadena y cobra.
 *
 * Quien liquida paga el gas. Esa asimetria es intencional en ERC-3009: el
 * vendedor quiere cobrar, asi que es razonable que asuma el costo de cobrar.
 */
export async function liquidarPago(
  signer: Signer,
  asset: string,
  pago: PaymentPayload,
): Promise<SettlementResponse> {
  const {authorization, signature} = pago.payload;
  try {
    const {v, r, s} = Signature.from(signature);
    const token = new Contract(getAddress(asset), ERC3009_ABI, signer);

    // `getFunction` da un handle tipado; el acceso por propiedad es opcional en ethers v6.
    const tx = await token.getFunction("transferWithAuthorization")(
      authorization.from,
      authorization.to,
      authorization.value,
      authorization.validAfter,
      authorization.validBefore,
      authorization.nonce,
      v,
      r,
      s,
    );
    await tx.wait();

    return {success: true, transaction: tx.hash, network: pago.network};
  } catch (causa) {
    return {
      success: false,
      network: pago.network,
      errorReason: causa instanceof Error ? causa.message : String(causa),
    };
  }
}

// --------------------------------------------------------------------
// Verificacion del lado del vendedor
// --------------------------------------------------------------------

export interface ResultadoVerificacion {
  readonly valido: boolean;
  readonly motivo?: string;
  /** Quien pago, si la firma resulto valida. */
  readonly pagador?: string;
}

export interface VerificarPagoOpciones {
  /** Reloj inyectable, para que los tests no dependan de la hora real. */
  readonly ahora?: () => number;
}

/**
 * Comprueba que un pago recibido satisface el requisito publicado.
 *
 * Es deliberadamente estricto. El vendedor esta del lado que recibe dinero de
 * un desconocido, asi que cada campo se contrasta contra lo que se pidio en vez
 * de confiar en lo que llego: si solo se validara la firma, un pagador podria
 * firmar correctamente una autorizacion de un wei, o dirigida a otra cuenta, y
 * el servidor entregaria el recurso igual.
 *
 * No consulta la cadena: eso queda para `liquidarPago`, que es donde el cobro
 * puede fallar por saldo o por autorizacion ya usada. Separarlos permite
 * rechazar lo obviamente invalido sin gastar una llamada RPC.
 */
export function verificarPago(
  pago: PaymentPayload,
  requisito: PaymentRequirement,
  opciones: VerificarPagoOpciones = {},
): ResultadoVerificacion {
  if (pago.scheme !== requisito.scheme) {
    return {valido: false, motivo: `esquema ${pago.scheme}, se esperaba ${requisito.scheme}`};
  }
  if (pago.network !== requisito.network) {
    return {valido: false, motivo: `red ${pago.network}, se esperaba ${requisito.network}`};
  }

  const auth = pago.payload.authorization;

  let destino: string;
  let esperado: string;
  try {
    destino = getAddress(auth.to);
    esperado = getAddress(requisito.payTo);
  } catch {
    return {valido: false, motivo: "la autorizacion trae una direccion malformada"};
  }
  // Sin esto, alguien podria firmar un pago valido dirigido a si mismo.
  if (destino !== esperado) {
    return {valido: false, motivo: `el pago va a ${destino} y deberia ir a ${esperado}`};
  }

  let valor: bigint;
  let pedido: bigint;
  try {
    valor = BigInt(auth.value);
    pedido = BigInt(requisito.maxAmountRequired);
  } catch {
    return {valido: false, motivo: "el monto de la autorizacion no es un entero"};
  }
  if (valor < pedido) {
    return {valido: false, motivo: `autorizo ${valor} y el precio es ${pedido}`};
  }

  const ahora = Math.floor((opciones.ahora?.() ?? Date.now()) / 1000);
  // El contrato compara de forma estricta, asi que el vendedor aplica el mismo
  // criterio: una autorizacion que aca parezca valida y alla revierta seria una
  // llamada entregada y no cobrada.
  if (ahora <= Number(auth.validAfter)) {
    return {valido: false, motivo: "la autorizacion todavia no empezo a valer"};
  }
  if (ahora >= Number(auth.validBefore)) {
    return {valido: false, motivo: "la autorizacion vencio"};
  }

  let recuperado: string;
  try {
    recuperado = recoverAddress(authorizationDigest(requisito, auth), pago.payload.signature);
  } catch {
    return {valido: false, motivo: "la firma no tiene un formato valido"};
  }
  if (recuperado.toLowerCase() !== auth.from.toLowerCase()) {
    return {valido: false, motivo: `la firma recupera a ${recuperado} y dice ser de ${auth.from}`};
  }

  return {valido: true, pagador: recuperado};
}

/** Consulta si la autorizacion ya fue consumida en la cadena. */
export async function autorizacionYaUsada(
  runner: ContractRunner,
  asset: string,
  from: string,
  nonce: string,
): Promise<boolean> {
  const token = new Contract(getAddress(asset), ERC3009_ABI, runner);
  return (await token.getFunction("authorizationState")(from, nonce)) as boolean;
}
