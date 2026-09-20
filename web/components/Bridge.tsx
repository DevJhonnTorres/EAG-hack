"use client";

import { useEffect, useMemo, useState } from "react";
import {
  BRIDGE_ASSETS,
  BRIDGE_DESTINO,
  PASOS_RUTA,
  USDC_DECIMALS,
  planBridge,
  type BridgeAsset,
  type BridgeQuote,
  type BridgeRejection,
  type MercadoRuta,
  type Settlement,
} from "@hashpool/orchestrator";
import { BRIDGE_INICIAL, COMISION_VENTA_BPS_INICIAL, type CamposBridge } from "@/lib/defaults";
import { acortarDireccion, formatUnidades, parseUnidades } from "@/lib/format";

const ACTIVOS = Object.keys(BRIDGE_ASSETS) as BridgeAsset[];

const MOTIVO: Record<BridgeRejection, string> = {
  NO_AMOUNT: "monto demasiado chico",
  FEES_EXCEED_AMOUNT: "las comisiones superan el monto",
  BELOW_MINIMUM: "bajo el retiro minimo",
};

/** De donde salen el precio y los costos de retiro que se estan usando. */
type Origen = "cargando" | "real" | "demo" | "error";

/**
 * Cuanto USDC le queda a cada socio si pasa lo minado por HashKey Exchange.
 *
 * Es una cotizacion: no envia nada. Los precios y los costos de retiro de USDC
 * se leen del exchange (datos publicos, sin credenciales). Las ordenes reales se
 * hacen con `npm run hashkey` desde una maquina local: esta pagina esta publicada
 * y no puede tener acceso a ninguna clave. Lo que se hace con el USDC despues
 * queda fuera de la aplicacion.
 */
export function Bridge({ settlement }: { settlement: Settlement | null }) {
  const [activo, setActivo] = useState<BridgeAsset>("HSK");
  const [campos, setCampos] = useState<Record<BridgeAsset, CamposBridge>>(BRIDGE_INICIAL);
  const [comisionVentaBps, setComisionVentaBps] = useState(COMISION_VENTA_BPS_INICIAL);
  const [origen, setOrigen] = useState<Origen>("cargando");
  const [leidoEn, setLeidoEn] = useState<number | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    (async () => {
      try {
        const respuesta = await fetch("/api/hashkey/mercado", { signal: controller.signal });
        if (!respuesta.ok) throw new Error(`HashKey respondio ${respuesta.status}`);
        const mercado = (await respuesta.json()) as MercadoRuta;

        setCampos((previo) => {
          const siguiente = { ...previo };
          for (const asset of ACTIVOS) {
            siguiente[asset] = {
              ...previo[asset],
              precio: mercado.precioUsdc[asset],
              ...(mercado.retiroUsdc
                ? { comisionRetiro: mercado.retiroUsdc.comision, retiroMinimo: mercado.retiroUsdc.minimo }
                : {}),
            };
          }
          return siguiente;
        });
        setLeidoEn(mercado.leidoEn);
        setOrigen("real");
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
    setOrigen("demo");
  };

  const resultado = useMemo(() => {
    if (!settlement) return { cotizaciones: null, error: null as string | null };
    try {
      const cotizaciones = planBridge(settlement.partnerPayouts, {
        asset: activo,
        rateE18: parseUnidades(actual.precio, 18),
        tradeFeeBps: comisionVentaBps,
        // Sacar el USDC hasta Linea cuesta el retiro del exchange mas el bridge desde Ethereum.
        withdrawalFee:
          parseUnidades(actual.comisionRetiro, USDC_DECIMALS) + parseUnidades(actual.costoBridge, USDC_DECIMALS),
        minWithdrawal: parseUnidades(actual.retiroMinimo, USDC_DECIMALS),
      });
      return { cotizaciones, error: null as string | null };
    } catch (causa) {
      return { cotizaciones: null, error: causa instanceof Error ? causa.message : String(causa) };
    }
  }, [settlement, activo, actual, comisionVentaBps]);

  const decimalesActivo = BRIDGE_ASSETS[activo].decimals;
  const usdc = (monto: bigint) => formatUnidades(monto, USDC_DECIMALS, USDC_DECIMALS);
  const pasos = PASOS_RUTA[activo]
    .map((paso) => `${paso.side === "SELL" ? "vender" : "comprar"} ${paso.symbol}`)
    .join(" → ");

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

      {origen === "cargando" && <div className="aviso alerta">Leyendo precios de HashKey Exchange...</div>}
      {origen === "real" && (
        <div className="aviso ok">
          Precios y costos de retiro leidos de HashKey Exchange
          {leidoEn ? ` a las ${new Date(leidoEn).toLocaleTimeString()}` : ""}. Es el ultimo precio de cada par:
          no incluye el margen entre compra y venta.{" "}
          <button onClick={usarDemo}>Usar valores de demostracion</button>
        </div>
      )}
      {origen === "error" && (
        <div className="aviso alerta">
          No se pudo leer HashKey Exchange: se muestran valores de demostracion, que no son cotizaciones.
        </div>
      )}
      {origen === "demo" && (
        <div className="aviso alerta">
          Valores de demostracion: no son cotizaciones. El retiro minimo real de USDC es mayor que cualquier
          monto de esta demo.
        </div>
      )}

      <div className="campos">
        <div>
          <label htmlFor="bridge-activo">Activo a convertir</label>
          <select id="bridge-activo" value={activo} onChange={(evento) => setActivo(evento.target.value as BridgeAsset)}>
            {ACTIVOS.map((opcion) => (
              <option key={opcion} value={opcion}>
                {opcion} ({BRIDGE_ASSETS[opcion].red})
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
            Comision de venta de la ruta ({(comisionVentaBps / 100).toFixed(2)}%, supuesto)
          </label>
          <input
            id="bridge-venta"
            type="range"
            min={0}
            max={500}
            step={5}
            value={comisionVentaBps}
            onChange={(evento) => setComisionVentaBps(Number(evento.target.value))}
          />
        </div>

        <div>
          <label htmlFor="bridge-retiro">Comision de retiro de USDC (exchange)</label>
          <input
            id="bridge-retiro"
            className="mono"
            type="text"
            value={actual.comisionRetiro}
            onChange={(evento) => cambiar({ comisionRetiro: evento.target.value })}
          />
        </div>

        <div>
          <label htmlFor="bridge-minimo">Retiro minimo de USDC (exchange)</label>
          <input
            id="bridge-minimo"
            className="mono"
            type="text"
            value={actual.retiroMinimo}
            onChange={(evento) => cambiar({ retiroMinimo: evento.target.value })}
          />
        </div>

        <div>
          <label htmlFor="bridge-costo">Costo del bridge Ethereum a Linea (USDC)</label>
          <input
            id="bridge-costo"
            className="mono"
            type="text"
            value={actual.costoBridge}
            onChange={(evento) => cambiar({ costoBridge: evento.target.value })}
          />
        </div>
      </div>

      <p className="subtitulo">
        Ruta: wallet del socio &rarr; deposito de {activo} en el exchange ({BRIDGE_ASSETS[activo].red}) &rarr;{" "}
        {pasos} &rarr; retiro de USDC por Ethereum &rarr; bridge a {BRIDGE_DESTINO}. HashKey no retira USDC
        directo a Linea, y el costo de ese ultimo tramo no se consulta: ponlo segun el bridge que uses.
      </p>

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
