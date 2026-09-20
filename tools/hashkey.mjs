#!/usr/bin/env node
/**
 * Operar HashKey Exchange desde tu maquina: ver el mercado, saldos y ordenes.
 *
 *   npm run hashkey -- mercado
 *   npm run hashkey -- saldo
 *   npm run hashkey -- comisiones                  # lo que TU cuenta paga por operacion
 *   npm run hashkey -- bridge 25                   # costo de pasar 25 USDC de Ethereum a Linea
 *   npm run hashkey -- probar  BTCUSDT SELL 0.001
 *   npm run hashkey -- ordenar BTCUSDT SELL 0.001
 *
 * Es un script LOCAL a proposito. La interfaz web esta desplegada de forma
 * publica, y un endpoint que operara con tu clave permitiria a cualquiera que
 * abriera la pagina mover tu dinero. Aca la clave solo existe en tu `.env`.
 *
 * Salvaguardas:
 *   - `probar` valida la orden contra el exchange sin enviarla al motor.
 *   - `ordenar` prueba primero, exige un tope por orden y pide que escribas
 *     CONFIRMAR a mano. Se niega a correr sin una terminal interactiva.
 *   - Solo se aceptan las operaciones de la ruta hacia USDC.
 *   - No hay retiros: sacar fondos del exchange se hace desde la web de
 *     HashKey, a una direccion en tu whitelist.
 *
 * La logica vive en `orchestrator/src/adapters/hashkey*.ts`, con tests. Este
 * archivo solo lee argumentos, pide confirmacion e imprime.
 */
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const RAIZ = new URL("../", import.meta.url);

try {
  process.loadEnvFile(fileURLToPath(new URL(".env", RAIZ)));
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

const dist = (ruta) => import(new URL(`orchestrator/dist/${ruta}`, RAIZ).href);
const { BridgeLineaError, cotizarBridgeLinea } = await dist("adapters/bridgeLinea.js");
const { USDC_DECIMALS } = await dist("domain/bridge.js");
const { decimalToFixedUp, formatDecimal } = await dist("domain/decimal.js");
const {
  ACTIVOS_DE_RUTA,
  HashKeyPublico,
  HashKeyPublicoError,
  comisionDeRutaBps,
  elegirRetiroUsdc,
  pasosPermitidos,
  redesDeDeposito,
  redesDeRetiroUsdc,
  rutasDeActivos,
} = await dist("adapters/hashkeyMercado.js");
const { HashKeyCuenta, HashKeyError, OrdenRechazadaError, decimalPositivo, planificarOrden } =
  await dist("adapters/hashkeyCuenta.js");

const env = process.env.HASHKEY_ENV ?? "sandbox";
if (env !== "sandbox" && env !== "production") {
  fail(`HASHKEY_ENV debe ser "sandbox" o "production", llego "${env}"`);
}

function fail(mensaje) {
  console.error(`\nError: ${mensaje}`);
  process.exit(1);
}

function cuenta() {
  const apiKey = process.env.HASHKEY_API_KEY;
  const apiSecret = process.env.HASHKEY_API_SECRET;
  if (!apiKey || !apiSecret) {
    fail("faltan HASHKEY_API_KEY y HASHKEY_API_SECRET en tu .env (nunca se pegan en el chat ni se commitean)");
  }
  return new HashKeyCuenta({ env, apiKey, apiSecret });
}

function limites() {
  const maxSlippageBps = Number(process.env.HASHKEY_MAX_SLIPPAGE_BPS ?? "50");
  return { maxOrderUsd: decimalPositivo("HASHKEY_MAX_ORDER_USD", process.env.HASHKEY_MAX_ORDER_USD), maxSlippageBps };
}

function cabecera(titulo) {
  const aviso = env === "production" ? "PRODUCCION (dinero real)" : "sandbox (sin dinero real)";
  console.log(`\n${titulo}  [${aviso}]\n`);
}

// --------------------------------------------------------------------
// Comandos
// --------------------------------------------------------------------

const describirPaso = ({ side, base, quote, symbol }) =>
  side === "SELL" ? `vender ${base} por ${quote} (${symbol})` : `comprar ${base} con ${quote} (${symbol})`;

async function mercado() {
  cabecera("Mercado de HashKey Exchange");
  const publico = new HashKeyPublico(env);
  const { reglas, monedas } = await publico.infoMercado();
  const rutas = rutasDeActivos(reglas);

  // Todo lo que sigue sale de lo que el exchange informa hoy: nada esta escrito a mano.
  for (const activo of Object.keys(rutas)) {
    const pasos = rutas[activo];
    const precios = await publico.precios(pasos.map((paso) => paso.symbol));
    const depositos = redesDeDeposito(activo, monedas);

    console.log(`${activo} -> USDC   (deposito por: ${depositos.length ? depositos.join(" o ") : "ninguna red habilitada"})`);
    for (const paso of pasos) {
      const r = reglas[paso.symbol];
      const detalle = `min ${r.minQty} ${r.baseAsset}, valor min ${r.minNotional} ${r.quoteAsset}, retail: ${r.retailAllowed ? "si" : "NO"}`;
      console.log(`  ${describirPaso(paso).padEnd(38)} ultimo ${precios[paso.symbol]}   (${detalle})`);
    }
  }

  const sinRuta = ACTIVOS_DE_RUTA.filter((activo) => !rutas[activo]);
  for (const activo of sinRuta) console.log(`${activo} -> USDC   el exchange no ofrece hoy un camino.`);

  const retiro = elegirRetiroUsdc(monedas);
  const redes = redesDeRetiroUsdc(monedas);
  console.log(`\nRedes por las que el exchange entrega USDC: ${redes.length ? redes.join(", ") : "ninguna"}`);
  if (!retiro) {
    console.log("No hay hoy una salida de USDC que lleve a Linea (ni directa ni por Ethereum).");
  } else if (retiro.esLinea) {
    console.log(`Retiro directo a Linea: minimo ${retiro.minimo}, comision ${retiro.comision}.`);
  } else {
    console.log(
      `El exchange no retira USDC a Linea. Se usa ${retiro.chain}: minimo ${retiro.minimo}, comision ${retiro.comision}. Despues hay que pasar el USDC a Linea con un bridge.`,
    );
  }

  const permitidos = pasosPermitidos(reglas);
  const sinRetail = [...new Set(permitidos.map((paso) => paso.symbol))].filter((symbol) => !reglas[symbol].retailAllowed);
  if (sinRetail.length > 0) {
    console.log(
      `\nAviso: ${sinRetail.join(", ")} no estan habilitados para cuentas retail. Si tu cuenta no es Professional Investor, el exchange puede rechazar las ordenes. "probar" lo comprueba sin riesgo.`,
    );
  }
}

async function saldo() {
  cabecera("Saldos");
  const saldos = (await cuenta().saldos()).filter((s) => Number(s.total) > 0);
  if (saldos.length === 0) return console.log("Sin saldo.");
  for (const s of saldos) console.log(`  ${s.asset.padEnd(8)} total ${s.total}   libre ${s.free}   bloqueado ${s.locked}`);
}

async function comisiones() {
  cabecera("Comisiones de tu cuenta");
  const publico = new HashKeyPublico(env);
  const { reglas } = await publico.infoMercado();
  const rutas = rutasDeActivos(reglas);
  const symbols = [...new Set(Object.values(rutas).flat().map((paso) => paso.symbol))];

  const r = await cuenta().comisiones(symbols);
  console.log(`Nivel VIP ${r.vipLevel}   (volumen de 30 dias: ${r.tradeVol30Day} USD)\n`);

  const tasas = Object.fromEntries(r.pares.map((par) => [par.symbol, par.taker]));
  for (const [activo, pasos] of Object.entries(rutas)) {
    const bps = comisionDeRutaBps(pasos, tasas);
    const detalle = pasos.map((paso) => `${paso.symbol} ${(Number(tasas[paso.symbol]) * 100).toFixed(2)}%`).join(" + ");
    console.log(`${activo} -> USDC: ${bps} bps (${(bps / 100).toFixed(2)}%)   = ${detalle}`);
  }
  console.log(
    "\nLas ordenes son LIMIT IOC: se ejecutan contra el libro y pagan la tasa de taker. Para que la web use tu tarifa, fija NEXT_PUBLIC_HASHKEY_TAKER_BPS con la tasa por operacion en basis points.",
  );
}

async function bridge([monto = "25"]) {
  console.log(`\nBridge de USDC: Ethereum -> Linea  (cotizacion en vivo de LI.FI)\n`);
  const usdc = (n) => formatDecimal({ units: n, scale: USDC_DECIMALS });
  const c = await cotizarBridgeLinea(decimalToFixedUp(monto, USDC_DECIMALS));

  console.log(`Entran:      ${usdc(c.monto)} USDC   (bridge elegido: ${c.herramienta})`);
  console.log(`Llegan:      ${usdc(c.recibe)} USDC a Linea`);
  console.log(`Comisiones:  ${usdc(c.comisiones)} USDC   (las descuenta el bridge)`);
  console.log(`Gas:         ${usdc(c.gas)} USDC   (lo pagas en ETH, en Ethereum, al enviar)`);
  console.log(`Costo total: ${usdc(c.costoTotal)} USDC${c.segundos !== null ? `   en unos ${c.segundos}s` : ""}`);
  console.log("\nEl gas cambia con la red: vuelve a correrlo antes de mover fondos.");
}

/** Lee reglas y libro, y arma la orden validada localmente. */
async function planear([symbol, side, cantidad]) {
  if (!symbol || !side || !cantidad) fail("uso: <SIMBOLO> <BUY|SELL> <cantidad>");
  if (side !== "BUY" && side !== "SELL") fail(`el lado debe ser BUY o SELL, llego "${side}"`);

  const publico = new HashKeyPublico(env);
  const { reglas } = await publico.infoMercado();
  const libro = await publico.mejorPrecio(symbol);
  // Solo se opera lo que forma parte de una ruta a USDC segun los pares que el exchange tiene hoy.
  const plan = planificarOrden({ symbol, side, quantity: cantidad }, reglas[symbol], libro, limites(), pasosPermitidos(reglas));

  console.log(`Orden:   ${plan.side} ${plan.quantity} ${symbol}  (pediste ${cantidad})`);
  console.log(`Tipo:    LIMIT IOC (se ejecuta al instante o se cancela) a ${plan.price}`);
  console.log(`Valor:   ${plan.notional}   tope por orden: ${limites().maxOrderUsd}`);
  console.log(`Libro:   compra ${libro.bid} / venta ${libro.ask}`);
  return plan;
}

async function probar(args) {
  cabecera("Probar una orden (no se envia al motor)");
  const plan = await planear(args);
  await cuenta().probarOrden(plan);
  console.log("\nEl exchange acepto la orden. Nada se ejecuto ni se movio.");
}

async function ordenar(args) {
  cabecera("Orden real");
  if (!process.stdin.isTTY) fail("las ordenes reales piden confirmacion escrita: corre esto en una terminal, no en un script");

  const plan = await planear(args);
  const c = cuenta();

  await c.probarOrden(plan);
  console.log("\nEl exchange valido la orden.");
  if (env === "production") console.log("ESTA ORDEN SE EJECUTA CON DINERO REAL.");

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const respuesta = await rl.question("\nEscribe CONFIRMAR para enviarla: ");
  rl.close();
  if (respuesta.trim() !== "CONFIRMAR") return console.log("Cancelado. No se envio nada.");

  const clientOrderId = `hp-${Date.now()}`;
  const creada = await c.crearOrden(plan, clientOrderId);
  console.log(`\nEnviada. orderId ${creada.orderId}, estado ${creada.status}`);

  const finales = new Set(["FILLED", "CANCELED", "REJECTED", "EXPIRED"]);
  let estado = creada;
  for (let intento = 0; intento < 10 && !finales.has(estado.status); intento += 1) {
    await new Promise((listo) => setTimeout(listo, 1000));
    estado = await c.consultarOrden(creada.orderId);
  }
  console.log(`Resultado: ${estado.status}, ejecutado ${estado.executedQty} de ${plan.quantity}`);
  if (estado.avgPrice && Number(estado.avgPrice) > 0) console.log(`Precio medio: ${estado.avgPrice}`);
  if (!finales.has(estado.status)) console.log("La orden sigue abierta: revisala en la web del exchange.");
}

const COMANDOS = { mercado, saldo, comisiones, bridge, probar, ordenar };
const [comando, ...resto] = process.argv.slice(2);

if (!comando || !(comando in COMANDOS)) {
  console.log(`Uso: npm run hashkey -- <${Object.keys(COMANDOS).join("|")}> [argumentos]`);
  process.exit(comando ? 1 : 0);
}

try {
  await COMANDOS[comando](resto);
} catch (error) {
  const esperado = [OrdenRechazadaError, HashKeyError, HashKeyPublicoError, BridgeLineaError, RangeError];
  if (esperado.some((tipo) => error instanceof tipo)) {
    fail(error.message);
  }
  throw error;
}
