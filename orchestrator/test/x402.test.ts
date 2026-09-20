import { describe, expect, it, jest } from "@jest/globals";
import { readFileSync } from "node:fs";
import { Wallet, recoverAddress } from "ethers";
import {
  HEADER_PAYMENT_REQUIRED,
  HEADER_PAYMENT_RESPONSE,
  HEADER_PAYMENT_SIGNATURE,
  NoAcceptablePaymentError,
  PrecioExcesivoError,
  X402Client,
  X402Error,
  X402_VERSION,
  authorizationDigest,
  chainIdDeRed,
  construirPago,
  decodePaymentPayload,
  decodePaymentRequired,
  encodePaymentRequired,
  encodeSettlementResponse,
  type PaymentRequired,
  verificarPago,
  type PaymentRequirement,
} from "../src/adapters/x402.js";

/** Fixture generado por el contrato PoolCredit. Se regenera con `npm run fixtures:x402`. */
const fixture = JSON.parse(readFileSync(new URL("../../fixtures/erc3009-digest.json", import.meta.url), "utf8"));

const RED = `eip155:${fixture.chainId}`;
const RECURSO = "https://hashpool.example/api/tarifa";

const requisito: PaymentRequirement = {
  scheme: "exact",
  network: RED,
  maxAmountRequired: String(fixture.value),
  resource: RECURSO,
  description: "Tarifa electrica vigente",
  mimeType: "application/json",
  payTo: fixture.to,
  asset: fixture.asset,
  maxTimeoutSeconds: 300,
  extra: { name: fixture.name, version: fixture.version },
};

const requeridos: PaymentRequired = { x402Version: X402_VERSION, accepts: [requisito] };

const wallet = new Wallet("0x0000000000000000000000000000000000000000000000000000000000000abc");

function respuesta402() {
  return new Response(JSON.stringify({ error: "payment required" }), {
    status: 402,
    headers: { [HEADER_PAYMENT_REQUIRED]: encodePaymentRequired(requeridos) },
  });
}

function respuestaOk(liquidacion = true) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (liquidacion) {
    headers[HEADER_PAYMENT_RESPONSE] = encodeSettlementResponse({
      success: true,
      transaction: "0xdeadbeef",
      network: RED,
    });
  }
  return new Response(JSON.stringify({ tariffWeiPerKwh: "150000000000000" }), { status: 200, headers });
}

function cliente(fetchImpl: typeof fetch, maxAmount = 10_000n) {
  return new X402Client({
    signer: wallet,
    network: RED,
    asset: fixture.asset,
    maxAmount,
    fetchImpl,
  });
}

describe("digest de la autorizacion", () => {
  /**
   * La comprobacion que hace que el pago funcione: el digest que firma el cliente
   * tiene que ser el mismo que el token valida en Solidity. Si divergieran, el
   * agente firmaria autorizaciones que el token rechaza, y el fallo aparecerian
   * recien al liquidar, cuando el oraculo ya entrego el dato.
   */
  it("coincide con el que calcula el contrato PoolCredit", () => {
    const calculado = authorizationDigest(requisito, {
      from: fixture.from,
      to: fixture.to,
      value: String(fixture.value),
      validAfter: String(fixture.validAfter),
      validBefore: String(fixture.validBefore),
      nonce: fixture.nonce,
    });
    expect(calculado).toBe(fixture.expectedDigest);
  });

  it("la firma del cliente recupera al pagador sobre ese digest", async () => {
    const pago = await construirPago(wallet, requisito, {
      ahora: () => 1_700_000_100_000,
      nonce: () => fixture.nonce,
    });
    const digest = authorizationDigest(requisito, pago.payload.authorization);
    expect(recoverAddress(digest, pago.payload.signature)).toBe(wallet.address);
  });
});

describe("construirPago", () => {
  it("autoriza exactamente el monto pedido, ni un centavo mas", async () => {
    const pago = await construirPago(wallet, requisito);
    expect(pago.payload.authorization.value).toBe(String(fixture.value));
    expect(pago.payload.authorization.to.toLowerCase()).toBe(String(fixture.to).toLowerCase());
  });

  /**
   * El contrato exige `block.timestamp > validAfter` de forma estricta. Un validAfter
   * igual al momento actual haria fallar el primer intento de cobro.
   */
  it("deja la autorizacion valida desde ya mismo", async () => {
    const ahora = 1_700_000_000_000;
    const pago = await construirPago(wallet, requisito, { ahora: () => ahora });
    expect(Number(pago.payload.authorization.validAfter)).toBeLessThan(ahora / 1000);
  });

  it("respeta la ventana de validez que pide el vendedor", async () => {
    const ahora = 1_700_000_000_000;
    const pago = await construirPago(wallet, requisito, { ahora: () => ahora });
    expect(Number(pago.payload.authorization.validBefore)).toBe(ahora / 1000 + 300);
  });

  /** Nonces no secuenciales: el agente puede tener varias llamadas en vuelo. */
  it("usa un nonce distinto en cada pago", async () => {
    const uno = await construirPago(wallet, requisito);
    const dos = await construirPago(wallet, requisito);
    expect(uno.payload.authorization.nonce).not.toBe(dos.payload.authorization.nonce);
  });
});

describe("X402Client", () => {
  it("no paga cuando el recurso es gratis", async () => {
    const fetchImpl = jest.fn(async () => respuestaOk(false)) as unknown as typeof fetch;
    const { response, pago } = await cliente(fetchImpl).fetchWithPayment(RECURSO);

    expect(response.status).toBe(200);
    expect(pago).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  /** El ciclo completo del protocolo: 402, firma, reintento con el pago adjunto. */
  it("paga y reintenta cuando el recurso cuesta", async () => {
    const llamadas: RequestInit[] = [];
    const fetchImpl = jest.fn(async (_url: unknown, init?: RequestInit) => {
      llamadas.push(init ?? {});
      return llamadas.length === 1 ? respuesta402() : respuestaOk();
    }) as unknown as typeof fetch;

    const { response, pago, liquidacion } = await cliente(fetchImpl).fetchWithPayment(RECURSO);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(response.status).toBe(200);
    expect(pago?.scheme).toBe("exact");
    expect(liquidacion?.success).toBe(true);
    expect(liquidacion?.transaction).toBe("0xdeadbeef");

    // El segundo intento lleva el pago firmado en el header del estandar.
    const headers = llamadas[1]!.headers as Record<string, string>;
    const enviado = decodePaymentPayload(headers[HEADER_PAYMENT_SIGNATURE]!);
    expect(enviado.payload.authorization.value).toBe(String(fixture.value));
    expect(recoverAddress(authorizationDigest(requisito, enviado.payload.authorization), enviado.payload.signature)).toBe(
      wallet.address,
    );
  });

  it("reintenta una sola vez: un segundo 402 es un rechazo, no un reintento", async () => {
    const fetchImpl = jest.fn(async () => respuesta402()) as unknown as typeof fetch;
    const { response } = await cliente(fetchImpl).fetchWithPayment(RECURSO);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(response.status).toBe(402);
  });

  /** El tope de gasto es lo que impide que un vendedor comprometido vacie al agente. */
  it("rechaza un precio por encima del tope por llamada", async () => {
    const fetchImpl = jest.fn(async () => respuesta402()) as unknown as typeof fetch;
    await expect(cliente(fetchImpl, 999n).fetchWithPayment(RECURSO)).rejects.toThrow(PrecioExcesivoError);
    // No se firmo nada ni se reintento.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rechaza pagar en una red que no es la suya", async () => {
    const otraRed: PaymentRequired = {
      x402Version: X402_VERSION,
      accepts: [{ ...requisito, network: "eip155:1" }],
    };
    const fetchImpl = jest.fn(
      async () =>
        new Response("{}", { status: 402, headers: { [HEADER_PAYMENT_REQUIRED]: encodePaymentRequired(otraRed) } }),
    ) as unknown as typeof fetch;

    await expect(cliente(fetchImpl).fetchWithPayment(RECURSO)).rejects.toThrow(NoAcceptablePaymentError);
  });

  it("rechaza pagar con un token que no es el suyo", async () => {
    const otroToken: PaymentRequired = {
      x402Version: X402_VERSION,
      accepts: [{ ...requisito, asset: "0x00000000000000000000000000000000000000ff" }],
    };
    const fetchImpl = jest.fn(
      async () =>
        new Response("{}", {
          status: 402,
          headers: { [HEADER_PAYMENT_REQUIRED]: encodePaymentRequired(otroToken) },
        }),
    ) as unknown as typeof fetch;

    await expect(cliente(fetchImpl).fetchWithPayment(RECURSO)).rejects.toThrow(NoAcceptablePaymentError);
  });

  it("falla claro si el vendedor cobra pero no dice como pagarle", async () => {
    const fetchImpl = jest.fn(async () => new Response("{}", { status: 402 })) as unknown as typeof fetch;
    await expect(cliente(fetchImpl).fetchWithPayment(RECURSO)).rejects.toThrow(X402Error);
  });
});

describe("codificacion de los headers", () => {
  it("los headers viajan como JSON en base64, ida y vuelta", () => {
    expect(decodePaymentRequired(encodePaymentRequired(requeridos))).toEqual(requeridos);
  });

  it("un header corrupto da un error entendible", () => {
    expect(() => decodePaymentRequired("no-es-base64-valido!!")).toThrow(X402Error);
  });
});

describe("chainIdDeRed", () => {
  it("entiende el formato CAIP-2", () => {
    expect(chainIdDeRed("eip155:133")).toBe(133);
  });

  it("rechaza redes que no son EVM", () => {
    expect(() => chainIdDeRed("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1")).toThrow(X402Error);
  });
});

describe("verificarPago (lado del vendedor)", () => {
  const AHORA_MS = 1_700_000_100_000;
  const ahora = () => AHORA_MS;

  const pagoValido = async () =>
    construirPago(wallet, requisito, { ahora, nonce: () => fixture.nonce });

  it("acepta un pago que satisface el requisito", async () => {
    const resultado = verificarPago(await pagoValido(), requisito, { ahora });
    expect(resultado.valido).toBe(true);
    expect(resultado.pagador).toBe(wallet.address);
  });

  /**
   * El ataque mas obvio contra un vendedor que solo valide la firma: firmar
   * correctamente un pago dirigido a uno mismo.
   */
  it("rechaza un pago correctamente firmado pero dirigido a otra cuenta", async () => {
    const pago = await pagoValido();
    const desviado = {
      ...pago,
      payload: {
        ...pago.payload,
        authorization: { ...pago.payload.authorization, to: wallet.address },
      },
    };
    const resultado = verificarPago(desviado, requisito, { ahora });
    expect(resultado.valido).toBe(false);
    expect(resultado.motivo).toMatch(/should go to/);
  });

  /** El otro ataque obvio: firmar bien, pero por un wei. */
  it("rechaza un pago por menos del precio publicado", async () => {
    const pago = await construirPago(wallet, { ...requisito, maxAmountRequired: "1" }, { ahora });
    const resultado = verificarPago(pago, requisito, { ahora });
    expect(resultado.valido).toBe(false);
    expect(resultado.motivo).toMatch(/the price is/);
  });

  it("acepta un pago por encima del precio", async () => {
    const pago = await construirPago(wallet, { ...requisito, maxAmountRequired: "99999" }, { ahora });
    expect(verificarPago(pago, requisito, { ahora }).valido).toBe(true);
  });

  it("rechaza una firma que no corresponde a la autorizacion", async () => {
    const pago = await pagoValido();
    const adulterado = {
      ...pago,
      payload: {
        ...pago.payload,
        authorization: { ...pago.payload.authorization, value: "999999" },
      },
    };
    const resultado = verificarPago(adulterado, requisito, { ahora });
    expect(resultado.valido).toBe(false);
    expect(resultado.motivo).toMatch(/recovers to/);
  });

  /**
   * El contrato compara de forma estricta. Si el vendedor fuera mas laxo,
   * entregaria el recurso por una autorizacion que despues revierte al cobrar.
   */
  it("rechaza una autorizacion vencida con el mismo criterio que el contrato", async () => {
    const pago = await pagoValido();
    const despues = () => (Number(pago.payload.authorization.validBefore) + 1) * 1000;
    const resultado = verificarPago(pago, requisito, { ahora: despues });
    expect(resultado.valido).toBe(false);
    expect(resultado.motivo).toMatch(/expired/);
  });

  it("rechaza una autorizacion que todavia no empezo a valer", async () => {
    const pago = await pagoValido();
    const antes = () => (Number(pago.payload.authorization.validAfter) - 10) * 1000;
    const resultado = verificarPago(pago, requisito, { ahora: antes });
    expect(resultado.valido).toBe(false);
    expect(resultado.motivo).toMatch(/not valid yet/);
  });

  it("rechaza un pago en otra red aunque la firma sea valida", async () => {
    const pago = await pagoValido();
    const resultado = verificarPago({ ...pago, network: "eip155:1" }, requisito, { ahora });
    expect(resultado.valido).toBe(false);
    expect(resultado.motivo).toMatch(/network /);
  });

  it("rechaza una firma con formato invalido sin lanzar excepcion", async () => {
    const pago = await pagoValido();
    const resultado = verificarPago(
      { ...pago, payload: { ...pago.payload, signature: "0x1234" } },
      requisito,
      { ahora },
    );
    expect(resultado.valido).toBe(false);
  });

  it("rechaza una direccion malformada sin lanzar excepcion", async () => {
    const pago = await pagoValido();
    const resultado = verificarPago(
      {
        ...pago,
        payload: { ...pago.payload, authorization: { ...pago.payload.authorization, to: "no-es-una-direccion" } },
      },
      requisito,
      { ahora },
    );
    expect(resultado.valido).toBe(false);
  });
});
