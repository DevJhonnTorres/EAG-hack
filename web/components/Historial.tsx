"use client";

import { useCallback, useEffect, useState } from "react";
import { cuadra, fetchHistorial, type LiquidacionHistorica } from "@hashpool/orchestrator";
import { acortarDireccion, formatUnidades } from "@/lib/format";

const ETIQUETA_ROL: Record<string, string> = {
  ENERGY: "Power",
  MAINTENANCE: "Maintenance",
  PARTNER: "Partner",
  NONE: "Unknown",
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
        <h2 style={{ margin: 0 }}>On-chain history</h2>
        <button onClick={() => void cargar()} disabled={cargando}>
          {cargando ? "Reading..." : "Refresh"}
        </button>
      </div>
      <p className="subtitulo">
        Read from the contract's events via Blockscout. There is no server of our own storing this: if this screen disappeared, the same numbers would still be on-chain.
      </p>

      {error && (
        <div className="aviso error" style={{ marginBottom: 0 }}>
          Could not read the history: {error}
        </div>
      )}

      {!error && liquidaciones !== null && liquidaciones.length === 0 && (
        <div className="aviso alerta" style={{ marginBottom: 0 }}>
          No settlements have been executed in this pool yet. As soon as the partners sign the first one, it will show up here, read straight from the chain.
        </div>
      )}

      {!error && liquidaciones === null && !cargando && (
        <p className="subtitulo" style={{ margin: 0 }}>
          No data.
        </p>
      )}

      {liquidaciones?.map((liquidacion) => {
        const cierra = cuadra(liquidacion);
        return (
          <div className="equipo" key={`${liquidacion.epochId}-${liquidacion.txHash}`}>
            <div className="equipo-encabezado">
              <strong>Period #{liquidacion.epochId}</strong>
              <span className="chip">
                {formatUnidades(liquidacion.gross)} {moneda}
              </span>
              {liquidacion.txHash && (
                <a href={`${explorerUrl}/tx/${liquidacion.txHash}`} target="_blank" rel="noreferrer">
                  view tx
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
                      {pago.acreditado && " (credited, not withdrawn)"}
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
                ? "Verified against the chain: the payouts add up exactly to the gross."
                : "The events read do not add up to the gross. A page of logs may still be missing."}
            </div>

            {liquidacion.telemetryHash && (
              <>
                <label style={{ marginTop: 12 }}>Anchored telemetry</label>
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
