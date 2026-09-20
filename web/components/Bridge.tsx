"use client";

import { useMemo, useState } from "react";
import {
  BRIDGE_ASSETS,
  BRIDGE_DESTINO,
  USDC_DECIMALS,
  planBridge,
  type BridgeAsset,
  type BridgeQuote,
  type BridgeRejection,
  type Settlement,
} from "@hashpool/orchestrator";
import { BRIDGE_INICIAL, COMISION_VENTA_BPS_INICIAL } from "@/lib/defaults";
import { acortarDireccion, formatUnidades, parseUnidades } from "@/lib/format";

const ACTIVOS = Object.keys(BRIDGE_ASSETS) as BridgeAsset[];

const MOTIVO: Record<BridgeRejection, string> = {
  NO_AMOUNT: "monto demasiado chico",
  FEES_EXCEED_AMOUNT: "las comisiones superan el monto",
  BELOW_MINIMUM: "bajo el retiro minimo",
};

/**
 * Cuanto USDC le llega a Linea a cada socio si pasa lo minado por el exchange.
 *
 * Es una cotizacion: no envia nada ni consulta ningun exchange. Lo que se hace
 * despues con el USDC ya en Linea queda fuera de la aplicacion.
 */
export function Bridge({ settlement }: { settlement: Settlement | null }) {
  const [activo, setActivo] = useState<BridgeAsset>("ETC");
  const [campos, setCampos] = useState(BRIDGE_INICIAL);
  const [comisionVentaBps, setComisionVentaBps] = useState(COMISION_VENTA_BPS_INICIAL);

  const actual = campos[activo];
  const cambiar = (cambios: Partial<typeof actual>) =>
    setCampos((previo) => ({ ...previo, [activo]: { ...previo[activo], ...cambios } }));

  const resultado = useMemo(() => {
    if (!settlement) return { cotizaciones: null, error: null as string | null };
    try {
      const cotizaciones = planBridge(settlement.partnerPayouts, {
        asset: activo,
        rateE18: parseUnidades(actual.precio, 18),
        tradeFeeBps: comisionVentaBps,
        withdrawalFee: parseUnidades(actual.comisionRetiro, USDC_DECIMALS),
        minWithdrawal: parseUnidades(actual.retiroMinimo, USDC_DECIMALS),
      });
      return { cotizaciones, error: null as string | null };
    } catch (causa) {
      return { cotizaciones: null, error: causa instanceof Error ? causa.message : String(causa) };
    }
  }, [settlement, activo, actual, comisionVentaBps]);

  const decimalesActivo = BRIDGE_ASSETS[activo].decimals;
  const usdc = (monto: bigint) => formatUnidades(monto, USDC_DECIMALS, USDC_DECIMALS);

  return (
    <section className="tarjeta">
      <h2>Bridge a USDC en Linea</h2>
      <p className="subtitulo">
        Cuanto USDC le llega a Linea a cada socio si pasa su parte por el exchange. El precio y las comisiones
        son de demostracion y se editan aca: no se consulta ningun exchange.
      </p>

      <div className="campos">
        <div>
          <label htmlFor="bridge-activo">Coin minado</label>
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
          <label htmlFor="bridge-venta">Comision de venta ({(comisionVentaBps / 100).toFixed(2)}%)</label>
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
          <label htmlFor="bridge-retiro">Comision de retiro (USDC)</label>
          <input
            id="bridge-retiro"
            className="mono"
            type="text"
            value={actual.comisionRetiro}
            onChange={(evento) => cambiar({ comisionRetiro: evento.target.value })}
          />
        </div>

        <div className="campo-ancho">
          <label htmlFor="bridge-minimo">Retiro minimo del exchange (USDC)</label>
          <input
            id="bridge-minimo"
            className="mono"
            type="text"
            value={actual.retiroMinimo}
            onChange={(evento) => cambiar({ retiroMinimo: evento.target.value })}
          />
        </div>
      </div>

      <p className="subtitulo">
        Ruta: wallet del socio &rarr; deposito de {activo} en el exchange ({BRIDGE_ASSETS[activo].red}) &rarr;
        venta {activo}/USDC &rarr; retiro de USDC a {BRIDGE_DESTINO}.
      </p>

      {resultado.error && <div className="aviso error">No se pudo cotizar el bridge: {resultado.error}</div>}
      {!settlement && !resultado.error && (
        <div className="aviso alerta">Falta un reparto valido para poder cotizar el bridge.</div>
      )}

      {resultado.cotizaciones && (
        <table>
          <thead>
            <tr>
              <th>Socio</th>
              <th>Entra ({activo})</th>
              <th>USDC bruto</th>
              <th>Comisiones</th>
              <th style={{ textAlign: "right" }}>Llega a Linea</th>
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
