"use client";

import { useEffect, useMemo, useState } from "react";
import {
  BRIDGE_ASSETS,
  USDC_DECIMALS,
  planBridge,
  type BridgeAsset,
  type BridgeQuote,
  type BridgeRejection,
  type MercadoRuta,
  type PasoRuta,
  type Settlement,
} from "@hashpool/orchestrator";
import {
  BRIDGE_INICIAL,
  COMISION_VENTA_BPS_INICIAL,
  TASA_POR_OPERACION_BPS,
  type CamposBridge,
} from "@/lib/defaults";
import { acortarDireccion, formatUnidades, parseUnidades } from "@/lib/format";

const ACTIVOS = Object.keys(BRIDGE_ASSETS) as BridgeAsset[];

const MOTIVO: Record<BridgeRejection, string> = {
  NO_AMOUNT: "monto demasiado chico",
  FEES_EXCEED_AMOUNT: "las comisiones superan el monto",
  BELOW_MINIMUM: "bajo el retiro minimo",
};

/** Cotizacion en vivo del ultimo tramo, de Ethereum a Linea. Los montos vienen como texto entero (6 decimales). */
interface CotizacionDelBridge {
  readonly herramienta: string;
  readonly comisiones: string;
  readonly gas: string;
  readonly costoTotal: string;
  readonly segundos: number | null;
}

/** De donde salen el precio y los costos de retiro que se estan usando. */
type Origen = "cargando" | "real" | "demo" | "error";

const describirPaso = ({ side, base, quote, symbol }: PasoRuta) =>
  side === "SELL" ? `vender ${base} por ${quote} (${symbol})` : `comprar ${base} con ${quote} (${symbol})`;

/** HashKey llama ERC20 a Ethereum. Se aclara para que se entienda a donde va el USDC. */
const nombreDeRed = (red: string) => (red === "ERC20" ? "Ethereum (ERC20)" : red);

/**
 * Cuanto USDC le queda a cada socio si pasa lo minado por HashKey Exchange.
 *
 * Es una cotizacion: no envia nada. La ruta, las redes de deposito y de retiro,
 * los precios y los costos de retiro se leen del exchange (datos publicos, sin
 * credenciales): si el exchange cambia un par o una red, esta tarjeta lo refleja.
 *
 * Las ordenes reales se hacen con `npm run hashkey` desde una maquina local: esta
 * pagina esta publicada y no puede tener acceso a ninguna clave.
 */
export function Bridge({ settlement }: { settlement: Settlement | null }) {
  const [activo, setActivo] = useState<BridgeAsset>("HSK");
  const [campos, setCampos] = useState<Record<BridgeAsset, CamposBridge>>(BRIDGE_INICIAL);
  const [comisionEditada, setComisionEditada] = useState<number | null>(null);
  const [tramo, setTramo] = useState<CotizacionDelBridge | null>(null);
  const [tramoFallo, setTramoFallo] = useState(false);
  const [origen, setOrigen] = useState<Origen>("cargando");
  const [mercado, setMercado] = useState<MercadoRuta | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    (async () => {
      try {
        const respuesta = await fetch("/api/hashkey/mercado", { signal: controller.signal });
        if (!respuesta.ok) throw new Error(`HashKey respondio ${respuesta.status}`);
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

        // HashKey no retira a Linea: se cotiza en vivo el ultimo tramo, desde Ethereum.
        if (datos.retiroUsdc && !datos.retiroUsdc.esLinea) {
          try {
            const bridge = await fetch(`/api/bridge/linea?monto=${encodeURIComponent(datos.retiroUsdc.minimo)}`, {
              signal: controller.signal,
            });
            if (!bridge.ok) throw new Error(`bridge respondio ${bridge.status}`);
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

        // Si el activo elegido no tiene ruta hoy, se pasa a uno que si la tenga.
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

  // La comision de la ruta es la tasa por operacion, por cuantas operaciones recorre.
  const comisionSugerida = ruta ? ruta.pasos.length * TASA_POR_OPERACION_BPS : COMISION_VENTA_BPS_INICIAL;
  const comisionVentaBps = comisionEditada ?? comisionSugerida;
  // Si el exchange retira directo a Linea no hay un ultimo tramo que costear.
  const hayBridgeAparte = !(retiro?.esLinea ?? false);

  const resultado = useMemo(() => {
    if (!settlement) return { cotizaciones: null, error: null as string | null };
    try {
      const costoBridge = hayBridgeAparte ? parseUnidades(actual.costoBridge, USDC_DECIMALS) : 0n;
      const cotizaciones = planBridge(settlement.partnerPayouts, {
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
  }, [settlement, activo, actual, comisionVentaBps, hayBridgeAparte]);

  const decimalesActivo = BRIDGE_ASSETS[activo].decimals;
  const usdc = (monto: bigint) => formatUnidades(monto, USDC_DECIMALS, USDC_DECIMALS);

  const todasInviables =
    resultado.cotizaciones !== null &&
    resultado.cotizaciones.length > 0 &&
    resultado.cotizaciones.every((cotizacion) => cotizacion.rejection !== null);

  return (
    <section className="tarjeta">
      <h2>Bridge a USDC en Linea</h2>
      <p className="subtitulo">
        Cuanto USDC le queda a cada socio si pasa su parte por HashKey Exchange. Esta tarjeta solo cotiza: no
        envia nada. Las ordenes se hacen con <code>npm run hashkey</code> desde tu maquina.
      </p>

      {origen === "cargando" && <div className="aviso alerta">Leyendo HashKey Exchange...</div>}
      {origen === "real" && mercado && (
        <div className="aviso ok">
          Ruta, redes, precios y costos de retiro leidos de HashKey Exchange a las{" "}
          {new Date(mercado.leidoEn).toLocaleTimeString()}. Es el ultimo precio de cada par: no incluye el
          margen entre compra y venta. <button onClick={usarDemo}>Usar valores de demostracion</button>
        </div>
      )}
      {origen === "error" && (
        <div className="aviso alerta">
          No se pudo leer HashKey Exchange: se muestran valores de demostracion, que no son cotizaciones, y no
          se conoce la ruta.
        </div>
      )}
      {origen === "demo" && (
        <div className="aviso alerta">
          Valores de demostracion: no son cotizaciones y no se conoce la ruta. El retiro minimo real de USDC es
          mayor que cualquier monto de esta demo.
        </div>
      )}

      <div className="campos">
        <div>
          <label htmlFor="bridge-activo">Activo a convertir</label>
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
                {mercado !== null && !mercado.rutas[opcion] ? " (sin ruta en HashKey)" : ""}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="bridge-precio">Precio (USDC por 1 {activo})</label>
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
            Comision de venta de la ruta ({(comisionVentaBps / 100).toFixed(2)}%
            {comisionEditada === null && ruta
              ? `: ${ruta.pasos.length} operaciones x ${(TASA_POR_OPERACION_BPS / 100).toFixed(2)}%, tarifa base de HashKey`
              : comisionEditada !== null
                ? ", editada"
                : ", supuesto"}
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
            Comision de retiro de USDC{retiro ? ` por ${nombreDeRed(retiro.chain)}` : ""}
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
          <label htmlFor="bridge-minimo">Retiro minimo de USDC</label>
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
              Costo del bridge de Ethereum a Linea (USDC{tramo ? `, cotizado con ${tramo.herramienta}` : ""})
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
                Comisiones del bridge {formatUnidades(BigInt(tramo.comisiones), USDC_DECIMALS, USDC_DECIMALS)} + gas de
                Ethereum {formatUnidades(BigInt(tramo.gas), USDC_DECIMALS, USDC_DECIMALS)}
                {tramo.segundos !== null ? `, unos ${tramo.segundos}s` : ""}. El gas cambia con la red.
              </p>
            )}
            {tramoFallo && (
              <p className="subtitulo" style={{ margin: "4px 0 0" }}>
                No se pudo cotizar el bridge: ponlo a mano.
              </p>
            )}
          </div>
        )}
      </div>

      <Ruta activo={activo} mercado={mercado} pasos={ruta?.pasos} depositos={ruta?.redesDeposito} />

      {resultado.error && <div className="aviso error">No se pudo cotizar el bridge: {resultado.error}</div>}
      {!settlement && !resultado.error && (
        <div className="aviso alerta">Falta un reparto valido para poder cotizar el bridge.</div>
      )}
      {todasInviables && origen === "real" && (
        <div className="aviso alerta">
          Con los costos reales del exchange, ningun pago de este reparto se puede pasar a USDC: son montos de
          testnet, muy por debajo del retiro minimo.
        </div>
      )}

      {resultado.cotizaciones && (
        <table>
          <thead>
            <tr>
              <th>Socio</th>
              <th>Entra ({activo})</th>
              <th>USDC bruto</th>
              <th>Comisiones</th>
              <th style={{ textAlign: "right" }}>Queda en USDC</th>
            </tr>
          </thead>
          <tbody>
            {resultado.cotizaciones.map((cotizacion) => (
              <Fila key={cotizacion.partner} cotizacion={cotizacion} decimalesActivo={decimalesActivo} usdc={usdc} />
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

/** La ruta completa, tal como el exchange la ofrece hoy. Sin datos, no se afirma nada. */
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
    return <p className="subtitulo">La ruta se lee de HashKey Exchange. Sin conexion con el exchange no se muestra.</p>;
  }
  if (!pasos) {
    return <p className="subtitulo">HashKey Exchange no ofrece hoy un camino de {activo} a USDC.</p>;
  }

  const retiro = mercado.retiroUsdc;
  const deposito = depositos && depositos.length > 0 ? depositos.map(nombreDeRed).join(" o ") : "ninguna red habilitada";

  return (
    <p className="subtitulo">
      Ruta: depositar {activo} en el exchange (por {deposito}) &rarr; {pasos.map(describirPaso).join(" → ")}{" "}
      &rarr;{" "}
      {retiro
        ? retiro.esLinea
          ? `retirar USDC directo a ${retiro.chain}.`
          : `retirar USDC por ${nombreDeRed(retiro.chain)}. HashKey no retira USDC a Linea: despues hay que pasarlo con un bridge, fuera del exchange.`
        : "HashKey no ofrece hoy una salida de USDC que lleve a Linea."}{" "}
      Redes por las que entrega USDC:{" "}
      {mercado.redesRetiroUsdc.length > 0 ? mercado.redesRetiroUsdc.map(nombreDeRed).join(", ") : "ninguna"}.
    </p>
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
        {cotizacion.rejection === null ? usdc(cotizacion.netOut) : `no viable: ${MOTIVO[cotizacion.rejection]}`}
      </td>
    </tr>
  );
}
