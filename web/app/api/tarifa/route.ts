import { JsonRpcProvider, Wallet } from "ethers";
import {
  HEADER_PAYMENT_REQUIRED,
  HEADER_PAYMENT_RESPONSE,
  HEADER_PAYMENT_SIGNATURE,
  X402_VERSION,
  autorizacionYaUsada,
  decodePaymentPayload,
  encodePaymentRequired,
  encodeSettlementResponse,
  liquidarPago,
  saldoDe,
  verificarPago,
  type PaymentRequirement,
  type SettlementResponse,
} from "@hashpool/orchestrator";
import { CADENAS, CONTRATOS } from "@/lib/defaults";

/**
 * Oraculo de tarifa electrica, cobrado por llamada con x402.
 *
 * Este endpoint es el **vendedor**: publica su precio con un `402 Payment
 * Required` y entrega el dato cuando llega un pago valido. Del otro lado, el
 * orquestador del pool es el **comprador**, y paga con la reserva del fondo de
 * mantenimiento sin que ningun humano apruebe cada consulta.
 *
 * Ese es el bucle que cierra el proyecto: el hardware genera ingresos, el fondo
 * reserva una porcion, y el agente se financia sus propios insumos de datos.
 *
 * Sobre el alcance: x402 preve un "facilitator" que verifica y liquida por
 * cuenta del vendedor. En HSKChain no hay ninguno publico, asi que este
 * servidor hace las dos cosas. La liquidacion on-chain requiere una clave con
 * gas en `X402_SETTLER_KEY`; sin ella el pago se verifica igual y la respuesta
 * lo dice explicitamente, en vez de aparentar un cobro que no ocurrio.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CADENA = CADENAS[133];
const RED = `eip155:133`;

/** Precio por consulta: 0.001 HPC (el token tiene 6 decimales). */
const PRECIO = "1000";

/**
 * Quien cobra el dato. En produccion seria la direccion del proveedor del
 * oraculo; aca se usa la wallet administrativa de la energia, que es la que ya
 * representa el lado electrico del pool.
 */
const COBRA = "0xcd23dAd3cDb7eb7046829f033c92107fC60F316b";

function requisito(resource: string): PaymentRequirement {
  return {
    scheme: "exact",
    network: RED,
    maxAmountRequired: PRECIO,
    resource,
    description: "Tarifa electrica vigente, en wei por kWh",
    mimeType: "application/json",
    payTo: COBRA,
    asset: CONTRATOS.credito,
    maxTimeoutSeconds: 300,
    extra: { name: "HashPool Credit", version: "1" },
  };
}

/** El dato que se vende. Una implementacion real lo tomaria de la distribuidora. */
function tarifa() {
  return {
    tariffWeiPerKwh: "150000000000000",
    currency: CADENA.moneda,
    network: RED,
    asOf: new Date().toISOString(),
    source: "simulado",
  };
}

function respuesta402(resource: string): Response {
  return new Response(
    JSON.stringify({
      x402Version: X402_VERSION,
      error: "payment required",
      accepts: [requisito(resource)],
    }),
    {
      status: 402,
      headers: {
        "content-type": "application/json",
        [HEADER_PAYMENT_REQUIRED]: encodePaymentRequired({
          x402Version: X402_VERSION,
          accepts: [requisito(resource)],
        }),
      },
    },
  );
}

export async function GET(request: Request): Promise<Response> {
  const resource = new URL(request.url).toString();
  const header = request.headers.get(HEADER_PAYMENT_SIGNATURE);

  if (!header) return respuesta402(resource);

  const req = requisito(resource);

  let pago;
  try {
    pago = decodePaymentPayload(header);
  } catch {
    return respuesta402(resource);
  }

  const verificacion = verificarPago(pago, req);
  if (!verificacion.valido) {
    return new Response(
      JSON.stringify({ x402Version: X402_VERSION, error: verificacion.motivo, accepts: [req] }),
      {
        status: 402,
        headers: {
          "content-type": "application/json",
          [HEADER_PAYMENT_REQUIRED]: encodePaymentRequired({ x402Version: X402_VERSION, accepts: [req] }),
          [HEADER_PAYMENT_RESPONSE]: encodeSettlementResponse({
            success: false,
            network: RED,
            ...(verificacion.motivo ? { errorReason: verificacion.motivo } : {}),
          }),
        },
      },
    );
  }

  const lector = new JsonRpcProvider(CADENA.rpc, 133, { staticNetwork: true });

  // Anti-replay: la firma es valida para siempre, asi que sin este chequeo la misma
  // autorizacion serviria para pedir el dato una y otra vez sin volver a pagar.
  try {
    const usada = await autorizacionYaUsada(
      lector,
      req.asset,
      pago.payload.authorization.from,
      pago.payload.authorization.nonce,
    );
    if (usada) {
      return new Response(
        JSON.stringify({ x402Version: X402_VERSION, error: "authorization already used", accepts: [req] }),
        {
          status: 402,
          headers: {
            "content-type": "application/json",
            [HEADER_PAYMENT_REQUIRED]: encodePaymentRequired({ x402Version: X402_VERSION, accepts: [req] }),
          },
        },
      );
    }
  } catch {
    // Si el nodo no responde, se sigue adelante: la cadena volvera a rechazar la
    // autorizacion repetida al liquidar. Es preferible a negar el servicio por una
    // consulta de lectura caida.
  }

  // Sin este chequeo, cualquiera podria firmar autorizaciones validas desde cuentas
  // vacias: pasarian la verificacion, el servidor intentaria cobrarlas, y cada intento
  // fallido le costaria gas. Una lectura es mucho mas barata que ese riesgo.
  try {
    const saldo = await saldoDe(lector, req.asset, pago.payload.authorization.from);
    if (saldo < BigInt(pago.payload.authorization.value)) {
      return new Response(
        JSON.stringify({ x402Version: X402_VERSION, error: "insufficient payer balance", accepts: [req] }),
        {
          status: 402,
          headers: {
            "content-type": "application/json",
            [HEADER_PAYMENT_REQUIRED]: encodePaymentRequired({ x402Version: X402_VERSION, accepts: [req] }),
            [HEADER_PAYMENT_RESPONSE]: encodeSettlementResponse({
              success: false,
              network: RED,
              errorReason: "el pagador no tiene saldo para cubrir este pago",
            }),
          },
        },
      );
    }
  } catch {
    // Nodo caido: se sigue adelante. La cadena rechazara el cobro de todas formas.
  }

  const claveLiquidador = process.env["X402_SETTLER_KEY"];
  let liquidacion: SettlementResponse;

  if (claveLiquidador) {
    liquidacion = await liquidarPago(new Wallet(claveLiquidador, lector), req.asset, pago);
  } else {
    liquidacion = {
      success: false,
      network: RED,
      errorReason: "pago verificado; no hay clave de liquidacion configurada en este despliegue",
    };
  }

  return new Response(JSON.stringify({ ...tarifa(), paidBy: verificacion.pagador }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      [HEADER_PAYMENT_RESPONSE]: encodeSettlementResponse(liquidacion),
    },
  });
}
