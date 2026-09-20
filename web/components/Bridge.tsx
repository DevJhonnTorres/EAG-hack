"use client";

import { useEffect, useMemo, useState } from "react";
import {
  BRIDGE_ASSETS,
  USDC_DECIMALS,
  planBridge,
  simularRuta,
  splitByWeight,
  type BridgeAsset,
  type BridgeQuote,
  type BridgeRejection,
  type MercadoRuta,
  type PasoRuta,
  type Settlement,
  type SettlementPayout,
} from "@hashpool/orchestrator";
import {
  BRIDGE_INICIAL,
  BRIDGE_SIMULADO_INICIAL,
  COMISION_VENTA_BPS_INICIAL,
  TASA_POR_OPERACION_BPS,
  type CamposBridge,
} from "@/lib/defaults";
import { acortarDireccion, formatUnidades, parseUnidades } from "@/lib/format";

const ACTIVOS = Object.keys(BRIDGE_ASSETS) as BridgeAsset[];

const MOTIVO: Record<BridgeRejection, string> = {
  NO_AMOUNT: "amount too small",
  FEES_EXCEED_AMOUNT: "fees exceed the amount",
  BELOW_MINIMUM: "below the minimum withdrawal",
};

/** Live quote for the last leg, Ethereum to Linea. Amounts arrive as integer text (6 decimals). */
interface CotizacionDelBridge {
  readonly herramienta: string;
  readonly comisiones: string;
  readonly gas: string;
  readonly costoTotal: string;
  readonly segundos: number | null;
}

/** Where the price and withdrawal costs in use come from. */
type Origen = "cargando" | "real" | "demo" | "error";

const describirPaso = ({ side, base, quote, symbol }: PasoRuta) =>
  side === "SELL" ? `sell ${base} for ${quote} (${symbol})` : `buy ${base} with ${quote} (${symbol})`;

/** HashKey calls Ethereum "ERC20". Spelled out so it is clear where the USDC goes. */
const nombreDeRed = (red: string) => (red === "ERC20" ? "Ethereum (ERC20)" : red);

/**
 * How much USDC each partner ends up with if their share goes through HashKey Exchange.
 *
 * It is a quote: nothing is sent. The route, deposit and withdrawal networks, prices and
 * withdrawal costs are read from the exchange (public data, no credentials), so if the
 * exchange changes a pair or a network, this card follows.
 *
 * Testnet payouts are only cents, far below the exchange's minimum withdrawal, so by
 * default the card previews a demo mainnet-scale payout and can "run" the swap
 * step by step. That part is a mock: real orders are placed with `npm run hashkey` from a
 * local machine, because this page is public and must never hold a key.
 */
export function Bridge({ settlement }: { settlement: Settlement | null }) {
  const [activo, setActivo] = useState<BridgeAsset>("HSK");
  const [campos, setCampos] = useState<Record<BridgeAsset, CamposBridge>>(BRIDGE_INICIAL);
  const [comisionEditada, setComisionEditada] = useState<number | null>(null);
  const [tramo, setTramo] = useState<CotizacionDelBridge | null>(null);
  const [tramoFallo, setTramoFallo] = useState(false);
  const [origen, setOrigen] = useState<Origen>("cargando");
  const [mercado, setMercado] = useState<MercadoRuta | null>(null);
  const [simulado, setSimulado] = useState(true);
  const [totalesSimulados, setTotalesSimulados] = useState<Record<BridgeAsset, string>>(BRIDGE_SIMULADO_INICIAL);

  useEffect(() => {
    const controller = new AbortController();

    (async () => {
      try {
        const respuesta = await fetch("/api/hashkey/mercado", { signal: controller.signal });
        if (!respuesta.ok) throw new Error(`HashKey responded ${respuesta.status}`);
        const datos = (await respuesta.json()) as MercadoRuta;

        setCampos((previo) => {
          const siguiente = { ...previo };
          for (const asset of ACTIVOS) {
            const precio = datos.rutas[asset]?.precioUsdc;
            siguiente[asset] = {
              ...previo[asset],
              ...(precio ? { precio } : {}),
              ...(datos.retiroUsdc
                ? { comisionRetiro: datos.retiroUsdc.comision, retiroMinimo: datos.retiroUsdc.minimo }
                : {}),
            };
          }
          return siguiente;
        });
        setMercado(datos);
        setOrigen("real");

        // HashKey does not withdraw to Linea: the last leg, from Ethereum, is quoted live.
        if (datos.retiroUsdc && !datos.retiroUsdc.esLinea) {
          try {
            const bridge = await fetch(`/api/bridge/linea?monto=${encodeURIComponent(datos.retiroUsdc.minimo)}`, {
              signal: controller.signal,
            });
            if (!bridge.ok) throw new Error(`bridge responded ${bridge.status}`);
            const cotizacion = (await bridge.json()) as CotizacionDelBridge;
            const costo = formatUnidades(BigInt(cotizacion.costoTotal), USDC_DECIMALS, USDC_DECIMALS);
            setCampos((previo) => {
              const siguiente = { ...previo };
              for (const asset of ACTIVOS) siguiente[asset] = { ...previo[asset], costoBridge: costo };
              return siguiente;
            });
            setTramo(cotizacion);
          } catch (causa) {
            if (causa instanceof Error && causa.name === "AbortError") return;
            setTramoFallo(true);
          }
        }

        // If the chosen asset has no route today, switch to one that does.
        setActivo((elegido) => (datos.rutas[elegido] ? elegido : (ACTIVOS.find((a) => datos.rutas[a]) ?? elegido)));
      } catch (causa) {
        if (causa instanceof Error && causa.name === "AbortError") return;
        setOrigen("error");
      }
    })();

    return () => controller.abort();
  }, []);

  const actual = campos[activo];
  const cambiar = (cambios: Partial<CamposBridge>) =>
    setCampos((previo) => ({ ...previo, [activo]: { ...previo[activo], ...cambios } }));

  const usarDemo = () => {
    setCampos(BRIDGE_INICIAL);
    setMercado(null);
    setTramo(null);
    setTramoFallo(false);
    setOrigen("demo");
  };

  const ruta = mercado?.rutas[activo];
  const retiro = mercado?.retiroUsdc ?? null;

  // The route's fee is the per-trade rate times the number of trades it goes through.
  const comisionSugerida = ruta ? ruta.pasos.length * TASA_POR_OPERACION_BPS : COMISION_VENTA_BPS_INICIAL;
  const comisionVentaBps = comisionEditada ?? comisionSugerida;
  // If the exchange withdraws straight to Linea there is no last leg to cost.
  const hayBridgeAparte = !(retiro?.esLinea ?? false);

  // The payouts being quoted: the real ones, or the same split scaled to a mainnet-sized total.
  const { pagos, totalSimuladoInvalido } = useMemo(() => {
    const reales: readonly SettlementPayout[] = settlement?.partnerPayouts ?? [];
    if (!simulado || reales.length === 0) return { pagos: reales, totalSimuladoInvalido: false };
    try {
      const total = parseUnidades(totalesSimulados[activo], 18);
      // The split of the real payout is kept: only its size changes, without losing a unit.
      const partes = splitByWeight(total, reales.map((pago) => pago.amount));
      return { pagos: reales.map((pago, i) => ({ ...pago, amount: partes[i] ?? 0n })), totalSimuladoInvalido: false };
    } catch {
      return { pagos: reales, totalSimuladoInvalido: true };
    }
  }, [settlement, simulado, totalesSimulados, activo]);

  const resultado = useMemo(() => {
    if (!settlement) return { cotizaciones: null, error: null as string | null };
    try {
      const costoBridge = hayBridgeAparte ? parseUnidades(actual.costoBridge, USDC_DECIMALS) : 0n;
      const cotizaciones = planBridge(pagos, {
        asset: activo,
        rateE18: parseUnidades(actual.precio, 18),
        tradeFeeBps: comisionVentaBps,
        withdrawalFee: parseUnidades(actual.comisionRetiro, USDC_DECIMALS) + costoBridge,
        minWithdrawal: parseUnidades(actual.retiroMinimo, USDC_DECIMALS),
      });
      return { cotizaciones, error: null as string | null };
    } catch (causa) {
      return { cotizaciones: null, error: causa instanceof Error ? causa.message : String(causa) };
    }
  }, [settlement, pagos, activo, actual, comisionVentaBps, hayBridgeAparte]);

  const decimalesActivo = BRIDGE_ASSETS[activo].decimals;
  const usdc = (monto: bigint) => formatUnidades(monto, USDC_DECIMALS, USDC_DECIMALS);

  const viables = (resultado.cotizaciones ?? []).filter((cotizacion) => cotizacion.rejection === null);
  const todasInviables =
    resultado.cotizaciones !== null && resultado.cotizaciones.length > 0 && viables.length === 0;

  return (
    <section className="tarjeta">
      <h2>Bridge to USDC on Linea</h2>
      <p className="subtitulo">
        How much USDC each partner ends up with if their share goes through HashKey Exchange. This card only
        quotes: it sends nothing. Real orders are placed with <code>npm run hashkey</code> from your machine.
      </p>

      {origen === "cargando" && <div className="aviso alerta">Reading HashKey Exchange...</div>}
      {origen === "real" && mercado && (
        <div className="aviso ok">
          Route, networks, prices and withdrawal costs read from HashKey Exchange at{" "}
          {new Date(mercado.leidoEn).toLocaleTimeString()}. It is the last price of each pair: it does not include
          the bid/ask spread. <button onClick={usarDemo}>Use demo values</button>
        </div>
      )}
      {origen === "error" && (
        <div className="aviso alerta">
          Could not read HashKey Exchange: demo values are shown, which are not quotes, and the route is unknown.
        </div>
      )}
      {origen === "demo" && (
        <div className="aviso alerta">
          Demo values: not quotes, and the route is unknown. The real minimum USDC withdrawal is larger than any
          amount in this demo.
        </div>
      )}

      <div className="campos">
        <div>
          <label htmlFor="bridge-activo">Asset to convert</label>
          <select
            id="bridge-activo"
            value={activo}
            onChange={(evento) => {
              setActivo(evento.target.value as BridgeAsset);
              setComisionEditada(null);
            }}
          >
            {ACTIVOS.map((opcion) => (
              <option key={opcion} value={opcion} disabled={mercado !== null && !mercado.rutas[opcion]}>
                {opcion}
                {mercado !== null && !mercado.rutas[opcion] ? " (no route on HashKey)" : ""}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="bridge-precio">Price (USDC per 1 {activo})</label>
          <input
            id="bridge-precio"
            className="mono"
            type="text"
            value={actual.precio}
            onChange={(evento) => cambiar({ precio: evento.target.value })}
          />
        </div>

        <div>
          <label htmlFor="bridge-venta">
            Route sell fee ({(comisionVentaBps / 100).toFixed(2)}%
            {comisionEditada === null && ruta
              ? `: ${ruta.pasos.length} trades x ${(TASA_POR_OPERACION_BPS / 100).toFixed(2)}%, HashKey base rate`
              : comisionEditada !== null
                ? ", edited"
                : ", assumed"}
            )
          </label>
          <input
            id="bridge-venta"
            type="range"
            min={0}
            max={500}
            step={5}
            value={comisionVentaBps}
            onChange={(evento) => setComisionEditada(Number(evento.target.value))}
          />
        </div>

        <div>
          <label htmlFor="bridge-retiro">
            USDC withdrawal fee{retiro ? ` via ${nombreDeRed(retiro.chain)}` : ""}
          </label>
          <input
            id="bridge-retiro"
            className="mono"
            type="text"
            value={actual.comisionRetiro}
            onChange={(evento) => cambiar({ comisionRetiro: evento.target.value })}
          />
        </div>

        <div>
          <label htmlFor="bridge-minimo">Minimum USDC withdrawal</label>
          <input
            id="bridge-minimo"
            className="mono"
            type="text"
            value={actual.retiroMinimo}
            onChange={(evento) => cambiar({ retiroMinimo: evento.target.value })}
          />
        </div>

        {hayBridgeAparte && (
          <div>
            <label htmlFor="bridge-costo">
              Ethereum to Linea bridge cost (USDC{tramo ? `, quoted with ${tramo.herramienta}` : ""})
            </label>
            <input
              id="bridge-costo"
              className="mono"
              type="text"
              value={actual.costoBridge}
              onChange={(evento) => cambiar({ costoBridge: evento.target.value })}
            />
            {tramo && (
              <p className="subtitulo" style={{ margin: "4px 0 0" }}>
                Bridge fees {formatUnidades(BigInt(tramo.comisiones), USDC_DECIMALS, USDC_DECIMALS)} + Ethereum gas{" "}
                {formatUnidades(BigInt(tramo.gas), USDC_DECIMALS, USDC_DECIMALS)}
                {tramo.segundos !== null ? `, about ${tramo.segundos}s` : ""}. Gas changes with the network.
              </p>
            )}
            {tramoFallo && (
              <p className="subtitulo" style={{ margin: "4px 0 0" }}>
                Could not quote the bridge: enter it by hand.
              </p>
            )}
          </div>
        )}
      </div>

      <div className="aviso alerta" style={{ marginTop: 4 }}>
        <label style={{ display: "flex", gap: 8, alignItems: "center", margin: 0 }}>
          <input
            type="checkbox"
            checked={simulado}
            onChange={(evento) => setSimulado(evento.target.checked)}
            style={{ width: "auto" }}
          />
          <span>
            <strong>Demo mainnet-scale amounts.</strong> Testnet payouts are only cents, far below
            HashKey&apos;s minimum withdrawal, so this previews the partners&apos; real split scaled to a larger total.
            Prices, fees and the route stay live; nothing is sent.
          </span>
        </label>
        {simulado && (
          <div style={{ marginTop: 10 }}>
            <label htmlFor="bridge-total-simulado">Demo total payout to the partners ({activo})</label>
            <input
              id="bridge-total-simulado"
              className="mono"
              type="text"
              value={totalesSimulados[activo]}
              onChange={(evento) => setTotalesSimulados((previo) => ({ ...previo, [activo]: evento.target.value }))}
            />
            {totalSimuladoInvalido && (
              <p className="subtitulo" style={{ margin: "4px 0 0" }}>
                Enter a valid amount: the real testnet payouts are used until then.
              </p>
            )}
          </div>
        )}
      </div>

      <Ruta activo={activo} mercado={mercado} pasos={ruta?.pasos} depositos={ruta?.redesDeposito} />

      {resultado.error && <div className="aviso error">Could not quote the bridge: {resultado.error}</div>}
      {!settlement && !resultado.error && (
        <div className="aviso alerta">A valid payout is needed to quote the bridge.</div>
      )}
      {todasInviables && !simulado && origen === "real" && (
        <div className="aviso alerta">
          With the exchange&apos;s real costs, none of this payout can be converted to USDC: these are testnet
          amounts, far below the minimum withdrawal. Turn on the demo amounts above to preview a mainnet-scale
          conversion.
        </div>
      )}

      {resultado.cotizaciones && (
        <table>
          <thead>
            <tr>
              <th>Partner</th>
              <th>In ({activo})</th>
              <th>Gross USDC</th>
              <th>Fees</th>
              <th style={{ textAlign: "right" }}>Left in USDC</th>
            </tr>
          </thead>
          <tbody>
            {resultado.cotizaciones.map((cotizacion) => (
              <Fila key={cotizacion.partner} cotizacion={cotizacion} decimalesActivo={decimalesActivo} usdc={usdc} />
            ))}
          </tbody>
        </table>
      )}

      {ruta && mercado && viables.length > 0 && (
        <SwapSimulado
          activo={activo}
          pasos={ruta.pasos}
          precios={mercado.precios}
          viables={viables}
          decimalesActivo={decimalesActivo}
          comisionVentaBps={comisionVentaBps}
          comisionRetiro={parseUnidades(actual.comisionRetiro, USDC_DECIMALS)}
          costoBridge={hayBridgeAparte ? parseUnidades(actual.costoBridge, USDC_DECIMALS) : 0n}
          usdc={usdc}
        />
      )}
    </section>
  );
}

/** The whole route, as the exchange offers it today. With no data, nothing is claimed. */
function Ruta({
  activo,
  mercado,
  pasos,
  depositos,
}: {
  activo: BridgeAsset;
  mercado: MercadoRuta | null;
  pasos: readonly PasoRuta[] | undefined;
  depositos: readonly string[] | undefined;
}) {
  if (!mercado) {
    return <p className="subtitulo">The route is read from HashKey Exchange. Without a connection to it, it is not shown.</p>;
  }
  if (!pasos) {
    return <p className="subtitulo">HashKey Exchange offers no path from {activo} to USDC today.</p>;
  }

  const retiro = mercado.retiroUsdc;
  const deposito = depositos && depositos.length > 0 ? depositos.map(nombreDeRed).join(" or ") : "no enabled network";

  return (
    <p className="subtitulo">
      Route: deposit {activo} at the exchange (via {deposito}) &rarr; {pasos.map(describirPaso).join(" → ")}{" "}
      &rarr;{" "}
      {retiro
        ? retiro.esLinea
          ? `withdraw USDC straight to ${retiro.chain}.`
          : `withdraw USDC via ${nombreDeRed(retiro.chain)}. HashKey does not withdraw USDC to Linea: it then has to be moved with a bridge, outside the exchange.`
        : "HashKey offers no USDC exit that leads to Linea today."}{" "}
      Networks it withdraws USDC on:{" "}
      {mercado.redesRetiroUsdc.length > 0 ? mercado.redesRetiroUsdc.map(nombreDeRed).join(", ") : "none"}.
    </p>
  );
}

const PASO_MS = 700;

/**
 * A mock of running the swap: it walks the route step by step with the live prices and ends
 * with what each partner would receive on Linea. No order is sent and no funds move.
 */
function SwapSimulado({
  activo,
  pasos,
  precios,
  viables,
  decimalesActivo,
  comisionVentaBps,
  comisionRetiro,
  costoBridge,
  usdc,
}: {
  activo: BridgeAsset;
  pasos: readonly PasoRuta[];
  precios: Readonly<Record<string, string>>;
  viables: readonly BridgeQuote[];
  decimalesActivo: number;
  comisionVentaBps: number;
  comisionRetiro: bigint;
  costoBridge: bigint;
  usdc: (monto: bigint) => string;
}) {
  // How many steps have "run": 0 = not started, pasos.length + 1 = finished and summarised.
  const [avance, setAvance] = useState<number | null>(null);

  const totalEntra = viables.reduce((acc, cotizacion) => acc + cotizacion.amountIn, 0n);
  const fills = useMemo(() => {
    try {
      // The walk through the route chains steps in 18-decimal fixed point, whatever the asset.
      return simularRuta(pasos, precios, totalEntra * 10n ** BigInt(18 - decimalesActivo));
    } catch {
      return null;
    }
  }, [pasos, precios, totalEntra, decimalesActivo]);

  // Any change to what is being quoted invalidates a run that was already shown.
  const huella = `${activo}|${viables.map((cotizacion) => cotizacion.netOut).join(",")}`;
  useEffect(() => setAvance(null), [huella]);

  useEffect(() => {
    if (avance === null || fills === null || avance > fills.length) return;
    const temporizador = setTimeout(() => setAvance(avance + 1), PASO_MS);
    return () => clearTimeout(temporizador);
  }, [avance, fills]);

  if (fills === null) return null;

  const terminado = avance !== null && avance > fills.length;
  const brutoTotal = viables.reduce((acc, cotizacion) => acc + cotizacion.grossOut, 0n);
  const comisionesTotal = viables.reduce((acc, cotizacion) => acc + cotizacion.tradeFee, 0n);
  const netoTotal = viables.reduce((acc, cotizacion) => acc + cotizacion.netOut, 0n);
  const n = BigInt(viables.length);

  const monto = (valor: bigint) => formatUnidades(valor, 18, 6);

  return (
    <div style={{ marginTop: 18 }}>
      <div className="equipo-encabezado" style={{ marginBottom: 8 }}>
        <strong>Swap to USDC</strong>
        <span className="chip">demo</span>
        {avance === null ? (
          <button className="primario" onClick={() => setAvance(0)}>
            Run demo swap
          </button>
        ) : (
          <button onClick={() => setAvance(0)} disabled={!terminado}>
            Run again
          </button>
        )}
      </div>

      {avance !== null && (
        <>
          {fills.slice(0, Math.min(avance, fills.length)).map((fill) => (
            <div className="resumen-fila" key={fill.step.symbol}>
              <span className="etiqueta">
                &#10003; {describirPaso(fill.step)} at {fill.price}
              </span>
              <span className="monto">
                {monto(fill.spend)} {fill.spendAsset} &rarr; {monto(fill.receive)} {fill.receiveAsset}
              </span>
            </div>
          ))}
          {!terminado && <p className="subtitulo">Running...</p>}
        </>
      )}

      {terminado && (
        <>
          <div className="resumen-fila">
            <span className="etiqueta">Gross USDC after the trades</span>
            <span className="monto">{usdc(brutoTotal)} USDC</span>
          </div>
          <div className="resumen-fila">
            <span className="etiqueta">Trading fees ({(comisionVentaBps / 100).toFixed(2)}%)</span>
            <span className="monto">&minus;{usdc(comisionesTotal)} USDC</span>
          </div>
          <div className="resumen-fila">
            <span className="etiqueta">USDC withdrawal fee ({viables.length} x {usdc(comisionRetiro)})</span>
            <span className="monto">&minus;{usdc(comisionRetiro * n)} USDC</span>
          </div>
          {costoBridge > 0n && (
            <div className="resumen-fila">
              <span className="etiqueta">Bridge to Linea ({viables.length} x {usdc(costoBridge)})</span>
              <span className="monto">&minus;{usdc(costoBridge * n)} USDC</span>
            </div>
          )}
          <div className="resumen-fila">
            <span className="etiqueta">
              <strong>Lands on Linea</strong>
            </span>
            <span className="monto">
              <strong>{usdc(netoTotal)} USDC</strong>
            </span>
          </div>

          <table style={{ marginTop: 12 }}>
            <tbody>
              {viables.map((cotizacion) => (
                <tr key={cotizacion.partner}>
                  <td className="mono" title={cotizacion.partner}>
                    {acortarDireccion(cotizacion.partner)}
                  </td>
                  <td style={{ textAlign: "right" }} className="mono">
                    {usdc(cotizacion.netOut)} USDC
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="aviso alerta" style={{ marginTop: 12, marginBottom: 0 }}>
            DEMO: no order was sent and no funds moved. Real orders are placed with{" "}
            <code>npm run hashkey</code>, and the USDC still has to be bridged from Ethereum to Linea.
          </div>
        </>
      )}
    </div>
  );
}

function Fila({
  cotizacion,
  decimalesActivo,
  usdc,
}: {
  cotizacion: BridgeQuote;
  decimalesActivo: number;
  usdc: (monto: bigint) => string;
}) {
  const viable = cotizacion.rejection === null;

  return (
    <tr>
      <td className="mono" title={cotizacion.partner}>
        {acortarDireccion(cotizacion.partner)}
      </td>
      <td className="mono">{formatUnidades(cotizacion.amountIn, decimalesActivo, 8)}</td>
      <td className="mono">{usdc(cotizacion.grossOut)}</td>
      <td className="mono">{viable ? usdc(cotizacion.tradeFee + cotizacion.withdrawalFee) : "-"}</td>
      <td style={{ textAlign: "right" }} className="mono">
        {cotizacion.rejection === null ? usdc(cotizacion.netOut) : `not viable: ${MOTIVO[cotizacion.rejection]}`}
      </td>
    </tr>
  );
}
