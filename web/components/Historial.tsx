"use client";

import { useCallback, useEffect, useState } from "react";
import { cuadra, fetchHistorial, type LiquidacionHistorica } from "@hashpool/orchestrator";
import { acortarDireccion, formatUnidades } from "@/lib/format";

const ETIQUETA_ROL: Record<string, string> = {
  ENERGY: "Luz",
  MAINTENANCE: "Mantenimiento",
  PARTNER: "Socio",
  NONE: "Desconocido",
};

const CLASE_PUNTO: Record<string, string> = {
  ENERGY: "energia",
  MAINTENANCE: "mantenimiento",
  PARTNER: "socio",
  NONE: "socio",
};

export function Historial({
  explorerUrl,
  splitterAddress,
  moneda,
}: {
  explorerUrl: string;
  splitterAddress: string;
  moneda: string;
}) {
  const [liquidaciones, setLiquidaciones] = useState<LiquidacionHistorica[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cargando, setCargando] = useState(false);

  const cargar = useCallback(
    async (signal?: AbortSignal) => {
      setCargando(true);
      setError(null);
      try {
        setLiquidaciones(await fetchHistorial(explorerUrl, splitterAddress, signal));
      } catch (causa) {
        if (causa instanceof Error && causa.name === "AbortError") return;
        setError(causa instanceof Error ? causa.message : String(causa));
      } finally {
        setCargando(false);
      }
    },
    [explorerUrl, splitterAddress],
  );

  useEffect(() => {
    const controller = new AbortController();
    void cargar(controller.signal);
    return () => controller.abort();
  }, [cargar]);

  return (
    <section className="tarjeta">
      <div className="equipo-encabezado" style={{ marginBottom: 4 }}>
        <h2 style={{ margin: 0 }}>Historial on-chain</h2>
        <button onClick={() => void cargar()} disabled={cargando}>
          {cargando ? "Leyendo..." : "Actualizar"}
        </button>
      </div>
      <p className="subtitulo">
        Leido de los eventos del contrato via Blockscout. No hay servidor propio guardando esto: si esta
        pantalla desapareciera, los mismos numeros siguen en la cadena.
      </p>

      {error && (
        <div className="aviso error" style={{ marginBottom: 0 }}>
          No se pudo leer el historial: {error}
        </div>
      )}

      {!error && liquidaciones !== null && liquidaciones.length === 0 && (
        <div className="aviso alerta" style={{ marginBottom: 0 }}>
          Todavia no hay liquidaciones ejecutadas en este pool. En cuanto los socios firmen la primera, va a
          aparecer aca leida directamente de la cadena.
        </div>
      )}

      {!error && liquidaciones === null && !cargando && (
        <p className="subtitulo" style={{ margin: 0 }}>
          Sin datos.
        </p>
      )}

      {liquidaciones?.map((liquidacion) => {
        const cierra = cuadra(liquidacion);
        return (
          <div className="equipo" key={`${liquidacion.epochId}-${liquidacion.txHash}`}>
            <div className="equipo-encabezado">
              <strong>Periodo #{liquidacion.epochId}</strong>
              <span className="chip">
                {formatUnidades(liquidacion.gross)} {moneda}
              </span>
              {liquidacion.txHash && (
                <a href={`${explorerUrl}/tx/${liquidacion.txHash}`} target="_blank" rel="noreferrer">
                  ver tx
                </a>
              )}
            </div>

            <table>
              <tbody>
                {liquidacion.pagos.map((pago, i) => (
                  <tr key={`${pago.to}-${i}`}>
                    <td>
                      <span className={`punto ${CLASE_PUNTO[pago.role] ?? "socio"}`} />
                      {ETIQUETA_ROL[pago.role] ?? pago.role}
                      {pago.acreditado && " (acreditado, sin retirar)"}
                    </td>
                    <td className="mono" title={pago.to}>
                      <a href={`${explorerUrl}/address/${pago.to}`} target="_blank" rel="noreferrer">
                        {acortarDireccion(pago.to)}
                      </a>
                    </td>
                    <td style={{ textAlign: "right" }} className="mono">
                      {formatUnidades(pago.amount)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div className={`aviso ${cierra ? "ok" : "alerta"}`} style={{ margin: "12px 0 0" }}>
              {cierra
                ? "Verificado contra la cadena: los pagos suman exactamente el bruto."
                : "Los eventos leidos no suman el bruto. Puede faltar una pagina de logs por cargar."}
            </div>

            {liquidacion.telemetryHash && (
              <>
                <label style={{ marginTop: 12 }}>Telemetria anclada</label>
                <div className="codigo" style={{ maxHeight: 60 }}>
                  {liquidacion.telemetryHash}
                </div>
              </>
            )}
          </div>
        );
      })}
    </section>
  );
}
