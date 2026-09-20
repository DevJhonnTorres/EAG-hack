import { USDC_DECIMALS, cotizarBridgeLinea, decimalToFixedUp } from "@hashpool/orchestrator";

/**
 * Costo de pasar USDC de Ethereum a Linea, cotizado en vivo con LI.FI.
 *
 * Solo lee: no usa credenciales ni firma nada. HashKey Exchange entrega el USDC en
 * Ethereum, y este es el costo del ultimo tramo hasta Linea, que el exchange no
 * informa.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Topes de lo que se acepta cotizar: esta ruta es publica y consulta a un tercero. */
const MONTO_MINIMO = 1n;
const MONTO_MAXIMO = 100_000n;

export async function GET(request: Request): Promise<Response> {
  const texto = new URL(request.url).searchParams.get("monto") ?? "";

  let monto: bigint;
  try {
    // Se redondea hacia arriba a USDC enteros: asi las lecturas se repiten y se
    // pueden cachear, en vez de consultar al tercero por cada centavo distinto.
    const unidad = 10n ** BigInt(USDC_DECIMALS);
    const exacto = decimalToFixedUp(texto, USDC_DECIMALS);
    monto = ((exacto + unidad - 1n) / unidad) * unidad;
  } catch {
    return Response.json({ error: "monto invalido: se espera un decimal positivo, por ejemplo 25" }, { status: 400 });
  }

  const enteros = monto / 10n ** BigInt(USDC_DECIMALS);
  if (enteros < MONTO_MINIMO || enteros > MONTO_MAXIMO) {
    return Response.json({ error: `el monto debe estar entre ${MONTO_MINIMO} y ${MONTO_MAXIMO} USDC` }, { status: 400 });
  }

  try {
    const c = await cotizarBridgeLinea(monto);
    return Response.json(
      {
        herramienta: c.herramienta,
        monto: c.monto.toString(),
        recibe: c.recibe.toString(),
        comisiones: c.comisiones.toString(),
        gas: c.gas.toString(),
        costoTotal: c.costoTotal.toString(),
        segundos: c.segundos,
        leidoEn: Date.now(),
      },
      // El gas de Ethereum cambia con la red, pero no de un minuto a otro.
      { headers: { "cache-control": "public, s-maxage=60, stale-while-revalidate=120" } },
    );
  } catch (causa) {
    return Response.json({ error: causa instanceof Error ? causa.message : String(causa) }, { status: 502 });
  }
}
