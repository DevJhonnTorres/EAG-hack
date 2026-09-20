import { HashKeyPublico, leerMercadoRuta } from "@hashpool/orchestrator";

/**
 * Precios y costos de retiro de HashKey Exchange, para cotizar el bridge.
 *
 * Solo lee datos PUBLICOS del exchange: no usa credenciales y no puede operar
 * una cuenta. Es lo unico de HashKey que vive en la web, que esta desplegada de
 * forma publica. Las ordenes se hacen con `npm run hashkey`, desde una maquina
 * local, con la clave en un `.env` que nunca sale de ahi.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    const mercado = await leerMercadoRuta(new HashKeyPublico("production"));
    return Response.json(mercado, {
      // Un precio de hace medio minuto sirve para cotizar, y evita golpear al
      // exchange con una lectura por cada visita.
      headers: { "cache-control": "public, s-maxage=30, stale-while-revalidate=60" },
    });
  } catch (causa) {
    const mensaje = causa instanceof Error ? causa.message : String(causa);
    return Response.json({ error: mensaje }, { status: 502 });
  }
}
