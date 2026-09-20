"use client";

import { useMemo, useState } from "react";
import {
  SettlementBuilder,
  assertPublishable,
  hashTelemetry,
  type EpochTelemetry,
  type GpuSpec,
  type PoolConfig,
  type RigSpec,
  type Settlement,
} from "@hashpool/orchestrator";
import {
  BRUTO_INICIAL,
  CADENAS,
  CONFIG_INICIAL,
  CONTRATOS,
  GPU_CATALOG,
  SEGUNDOS_POR_DIA,
  SEGUNDOS_POR_PERIODO,
} from "@/lib/defaults";
import { acortarDireccion, formatUnidades, formatearDuracion, parseUnidades, porcentaje } from "@/lib/format";
import { buildSafeTransaction } from "@/lib/calldata";
import { Historial } from "@/components/Historial";
import { FirmaMultisig } from "@/components/FirmaMultisig";
import { Bridge } from "@/components/Bridge";

const builder = new SettlementBuilder();
const CADENA = CADENAS[133];

/** Estado simulado de un equipo durante el periodo. */
interface EstadoEquipo {
  /** Segundos encendido dentro del periodo. */
  readonly uptimeSeconds: number;
  /** Rendimiento real respecto del nominal, en porcentaje. */
  readonly rendimiento: number;
}

export default function Page() {
  const [config, setConfig] = useState<PoolConfig>(CONFIG_INICIAL);
  const [gross, setGross] = useState<bigint>(BRUTO_INICIAL);
  const [epochId, setEpochId] = useState(1);
  const [deudaArrastrada, setDeudaArrastrada] = useState<bigint>(0n);
  const [estados, setEstados] = useState<Record<string, EstadoEquipo>>({
    "rig-a": { uptimeSeconds: SEGUNDOS_POR_PERIODO, rendimiento: 100 },
    "rig-b": { uptimeSeconds: SEGUNDOS_POR_PERIODO, rendimiento: 100 },
  });
  const [splitterAddress, setSplitterAddress] = useState<string>(CONTRATOS.splitter);

  const telemetria: EpochTelemetry = useMemo(
    () => ({
      epochId,
      startedAt: 1_700_000_000,
      endedAt: 1_700_000_000 + SEGUNDOS_POR_PERIODO,
      rigs: config.rigs.map((rig) => {
        const estado = estados[rig.id] ?? { uptimeSeconds: 0, rendimiento: 100 };
        const nominal = rig.gpus.reduce((acc, gpu) => acc + gpu.hashrateMilliHs, 0);
        return {
          rigId: rig.id,
          uptimeSeconds: Math.min(estado.uptimeSeconds, SEGUNDOS_POR_PERIODO),
          averageHashrateMilliHs: Math.round((nominal * estado.rendimiento) / 100),
        };
      }),
    }),
    [config.rigs, epochId, estados],
  );

  const resultado = useMemo(() => {
    try {
      const settlement = builder.build({ config, telemetry: telemetria, gross, carriedEnergyDebt: deudaArrastrada });
      let publicable: string | null = null;
      try {
        assertPublishable(settlement, config);
      } catch (error) {
        publicable = error instanceof Error ? error.message : String(error);
      }
      return { settlement, error: null as string | null, publicable };
    } catch (error) {
      return {
        settlement: null,
        error: error instanceof Error ? error.message : String(error),
        publicable: null,
      };
    }
  }, [config, telemetria, gross, deudaArrastrada]);

  const telemetryHash = useMemo(() => hashTelemetry(telemetria), [telemetria]);

  const actualizarEquipo = (id: string, cambios: Partial<EstadoEquipo>) =>
    setEstados((previo) => ({
      ...previo,
      [id]: { ...(previo[id] ?? { uptimeSeconds: 0, rendimiento: 100 }), ...cambios },
    }));

  const actualizarRig = (index: number, cambios: Partial<RigSpec>) =>
    setConfig((previo) => ({
      ...previo,
      rigs: previo.rigs.map((rig, i) => (i === index ? { ...rig, ...cambios } : rig)),
    }));

  const agregarEquipo = () => {
    const id = `rig-${String.fromCharCode(97 + config.rigs.length)}`;
    setConfig((previo) => ({
      ...previo,
      rigs: [
        ...previo.rigs,
        {
          id,
          partner: "0x0000000000000000000000000000000000000000",
          gpus: [GPU_CATALOG[0]],
          baseloadWatts: 80,
          psuEfficiencyBps: 9_000,
        },
      ],
    }));
    actualizarEquipo(id, { uptimeSeconds: SEGUNDOS_POR_PERIODO, rendimiento: 100 });
  };

  const quitarEquipo = (index: number) =>
    setConfig((previo) => ({ ...previo, rigs: previo.rigs.filter((_, i) => i !== index) }));

  return (
    <div className="contenedor">
      <header className="principal">
        <h1>HashPool</h1>
        <p>
          Micro-pools de infraestructura. El reparto de lo minado se calcula por el trabajo que cada equipo
          realmente hizo, lo aprueban los socios con su multisig, y la cadena verifica que las cuentas
          cierren antes de mover un solo wei.
        </p>
        <div className="barra-cadena">
          <span className="chip">
            Cadena <strong>{CADENA.nombre}</strong>
          </span>
          <span className="chip">
            Moneda <strong>{CADENA.moneda}</strong>
          </span>
          <span className="chip">
            Explorer{" "}
            <a href={CADENA.explorer} target="_blank" rel="noreferrer">
              Blockscout
            </a>
          </span>
          <span className="chip">
            Periodo <strong>#{epochId}</strong>
          </span>
          <span className="chip">
            Baul{" "}
            <a href={`${CADENA.explorer}/address/${CONTRATOS.baul}`} target="_blank" rel="noreferrer">
              {acortarDireccion(CONTRATOS.baul)}
            </a>
          </span>
          <span className="chip">
            Splitter{" "}
            <a href={`${CADENA.explorer}/address/${CONTRATOS.splitter}`} target="_blank" rel="noreferrer">
              {acortarDireccion(CONTRATOS.splitter)}
            </a>
          </span>
        </div>
      </header>

      <div className="grilla">
        <div>
          <ConfiguracionEconomica config={config} setConfig={setConfig} />
          <Equipos
            config={config}
            actualizarRig={actualizarRig}
            quitarEquipo={quitarEquipo}
            agregarEquipo={agregarEquipo}
          />
        </div>

        <div>
          <Telemetria
            config={config}
            estados={estados}
            actualizarEquipo={actualizarEquipo}
            gross={gross}
            setGross={setGross}
            epochId={epochId}
            setEpochId={setEpochId}
            deudaArrastrada={deudaArrastrada}
            setDeudaArrastrada={setDeudaArrastrada}
          />
          <Reparto resultado={resultado} config={config} />
          <Bridge settlement={resultado.settlement} />
          <TransaccionAFirmar
            settlement={resultado.settlement}
            telemetryHash={telemetryHash}
            splitterAddress={splitterAddress}
            setSplitterAddress={setSplitterAddress}
          />
          <FirmaMultisig
            cadena={{ chainId: 133, nombre: CADENA.nombre, moneda: CADENA.moneda, rpc: CADENA.rpc, explorer: CADENA.explorer }}
            safeAddress={CONTRATOS.baul}
            splitterAddress={splitterAddress}
            settlement={resultado.settlement}
            telemetryHash={telemetryHash}
          />
          <Historial
            explorerUrl={CADENA.explorer}
            splitterAddress={splitterAddress}
            moneda={CADENA.moneda}
          />
        </div>
      </div>

      <footer className="pie">
        Los datos de hardware y telemetria de esta pantalla son simulados y se editan desde aca. El calculo
        del reparto, el hash de auditoria y la transaccion que se firma son los reales: la interfaz ejecuta
        exactamente el mismo motor que cubren los tests y que aprueba el contrato.
      </footer>
    </div>
  );
}

function ConfiguracionEconomica({
  config,
  setConfig,
}: {
  config: PoolConfig;
  setConfig: (actualizar: (previo: PoolConfig) => PoolConfig) => void;
}) {
  const [tarifaTexto, setTarifaTexto] = useState(formatUnidades(config.tariffWeiPerKwh, 18, 12));

  return (
    <section className="tarjeta">
      <h2>Configuracion economica</h2>
      <p className="subtitulo">
        Los parametros que definen el negocio. Cambiarlos recalcula el reparto al instante.
      </p>

      <div className="campos">
        <div>
          <label htmlFor="tarifa">Tarifa electrica ({CADENA.moneda} por kWh)</label>
          <input
            id="tarifa"
            className="mono"
            type="text"
            value={tarifaTexto}
            onChange={(evento) => {
              const texto = evento.target.value;
              setTarifaTexto(texto);
              try {
                const wei = parseUnidades(texto);
                setConfig((previo) => ({ ...previo, tariffWeiPerKwh: wei }));
              } catch {
                // Se ignora mientras la persona escribe un valor incompleto.
              }
            }}
          />
        </div>

        <div>
          <label htmlFor="mantenimiento">Fondo de mantenimiento ({config.maintenanceBps / 100}%)</label>
          <input
            id="mantenimiento"
            type="range"
            min={0}
            max={5000}
            step={50}
            value={config.maintenanceBps}
            onChange={(evento) =>
              setConfig((previo) => ({ ...previo, maintenanceBps: Number(evento.target.value) }))
            }
          />
        </div>

        <div className="campo-ancho">
          <label htmlFor="energia">Wallet administrativa que paga la luz</label>
          <input
            id="energia"
            className="mono"
            type="text"
            value={config.energyWallet}
            onChange={(evento) => setConfig((previo) => ({ ...previo, energyWallet: evento.target.value }))}
          />
        </div>

        <div className="campo-ancho">
          <label htmlFor="vault">Vault del fondo de mantenimiento</label>
          <input
            id="vault"
            className="mono"
            type="text"
            value={config.maintenanceVault}
            onChange={(evento) =>
              setConfig((previo) => ({ ...previo, maintenanceVault: evento.target.value }))
            }
          />
        </div>
      </div>

      <p className="subtitulo" style={{ margin: 0 }}>
        El tope del fondo es 50%: el contrato rechaza cualquier configuracion por encima, para que una
        reserva mal puesta no pueda dejar a los socios sin nada de forma &quot;valida&quot;.
      </p>
    </section>
  );
}

function Equipos({
  config,
  actualizarRig,
  quitarEquipo,
  agregarEquipo,
}: {
  config: PoolConfig;
  actualizarRig: (index: number, cambios: Partial<RigSpec>) => void;
  quitarEquipo: (index: number) => void;
  agregarEquipo: () => void;
}) {
  const cambiarGpu = (rigIndex: number, gpuIndex: number, modelo: string) => {
    const rig = config.rigs[rigIndex];
    if (!rig) return;
    const nueva = GPU_CATALOG.find((gpu) => gpu.model === modelo);
    if (!nueva) return;
    const gpus: GpuSpec[] = rig.gpus.map((gpu, i) => (i === gpuIndex ? nueva : gpu));
    actualizarRig(rigIndex, { gpus });
  };

  return (
    <section className="tarjeta">
      <h2>Equipos del pool</h2>
      <p className="subtitulo">Que aporta cada socio. Es lo que determina su peso y su consumo.</p>

      {config.rigs.map((rig, rigIndex) => {
        const vatios = rig.gpus.reduce((acc, gpu) => acc + gpu.tdpWatts, 0) + rig.baseloadWatts;
        const hashrate = rig.gpus.reduce((acc, gpu) => acc + gpu.hashrateMilliHs, 0) / 1e9;

        return (
          <div className="equipo" key={rig.id}>
            <div className="equipo-encabezado">
              <strong>{rig.id}</strong>
              <span className="chip">
                {hashrate.toFixed(0)} MH/s &middot; {vatios} W
              </span>
              {config.rigs.length > 1 && (
                <button className="peligro" onClick={() => quitarEquipo(rigIndex)}>
                  Quitar
                </button>
              )}
            </div>

            <div className="campos">
              <div className="campo-ancho">
                <label htmlFor={`socio-${rig.id}`}>Wallet del socio</label>
                <input
                  id={`socio-${rig.id}`}
                  className="mono"
                  type="text"
                  value={rig.partner}
                  onChange={(evento) => actualizarRig(rigIndex, { partner: evento.target.value })}
                />
              </div>

              <div>
                <label htmlFor={`baseload-${rig.id}`}>Placa base y perifericos (W)</label>
                <input
                  id={`baseload-${rig.id}`}
                  type="number"
                  min={0}
                  value={rig.baseloadWatts}
                  onChange={(evento) =>
                    actualizarRig(rigIndex, { baseloadWatts: Number(evento.target.value) || 0 })
                  }
                />
              </div>

              <div>
                <label htmlFor={`psu-${rig.id}`}>Eficiencia de la fuente (%)</label>
                <input
                  id={`psu-${rig.id}`}
                  type="number"
                  min={50}
                  max={100}
                  value={rig.psuEfficiencyBps / 100}
                  onChange={(evento) =>
                    actualizarRig(rigIndex, {
                      psuEfficiencyBps: Math.max(1, Number(evento.target.value) || 90) * 100,
                    })
                  }
                />
              </div>
            </div>

            <label>Tarjetas</label>
            {rig.gpus.map((gpu, gpuIndex) => (
              <div className="gpu-fila" key={`${rig.id}-${gpuIndex}`}>
                <select value={gpu.model} onChange={(evento) => cambiarGpu(rigIndex, gpuIndex, evento.target.value)}>
                  {GPU_CATALOG.map((opcion) => (
                    <option key={opcion.model} value={opcion.model}>
                      {opcion.model} &mdash; {(opcion.hashrateMilliHs / 1e9).toFixed(0)} MH/s, {opcion.tdpWatts} W
                    </option>
                  ))}
                </select>
                {rig.gpus.length > 1 && (
                  <button
                    className="peligro"
                    onClick={() => actualizarRig(rigIndex, { gpus: rig.gpus.filter((_, i) => i !== gpuIndex) })}
                  >
                    &minus;
                  </button>
                )}
              </div>
            ))}
            <button onClick={() => actualizarRig(rigIndex, { gpus: [...rig.gpus, rig.gpus[0] ?? GPU_CATALOG[0]] })}>
              Agregar tarjeta
            </button>
          </div>
        );
      })}

      <button className="primario" onClick={agregarEquipo}>
        Agregar equipo
      </button>
    </section>
  );
}

function Telemetria({
  config,
  estados,
  actualizarEquipo,
  gross,
  setGross,
  epochId,
  setEpochId,
  deudaArrastrada,
  setDeudaArrastrada,
}: {
  config: PoolConfig;
  estados: Record<string, EstadoEquipo>;
  actualizarEquipo: (id: string, cambios: Partial<EstadoEquipo>) => void;
  gross: bigint;
  setGross: (valor: bigint) => void;
  epochId: number;
  setEpochId: (valor: number) => void;
  deudaArrastrada: bigint;
  setDeudaArrastrada: (valor: bigint) => void;
}) {
  const [brutoTexto, setBrutoTexto] = useState(formatUnidades(gross));
  const [deudaTexto, setDeudaTexto] = useState(formatUnidades(deudaArrastrada));

  return (
    <section className="tarjeta">
      <h2>Telemetria del periodo</h2>
      <p className="subtitulo">
        Datos simulados, editables desde aca. En produccion los aportaria la API del software de mineria.
      </p>

      <div className="campos tres">
        <div>
          <label htmlFor="epoch">Periodo</label>
          <input
            id="epoch"
            type="number"
            min={1}
            value={epochId}
            onChange={(evento) => setEpochId(Math.max(1, Number(evento.target.value) || 1))}
          />
        </div>
        <div>
          <label htmlFor="bruto">Bruto minado ({CADENA.moneda})</label>
          <input
            id="bruto"
            className="mono"
            type="text"
            value={brutoTexto}
            onChange={(evento) => {
              setBrutoTexto(evento.target.value);
              try {
                setGross(parseUnidades(evento.target.value));
              } catch {
                /* valor incompleto mientras se escribe */
              }
            }}
          />
        </div>
        <div>
          <label htmlFor="deuda">Deuda de luz arrastrada</label>
          <input
            id="deuda"
            className="mono"
            type="text"
            value={deudaTexto}
            onChange={(evento) => {
              setDeudaTexto(evento.target.value);
              try {
                setDeudaArrastrada(parseUnidades(evento.target.value));
              } catch {
                /* valor incompleto mientras se escribe */
              }
            }}
          />
        </div>
      </div>

      {config.rigs.map((rig) => {
        const estado = estados[rig.id] ?? { uptimeSeconds: 0, rendimiento: 100 };
        const dias = estado.uptimeSeconds / SEGUNDOS_POR_DIA;

        return (
          <div className="slider-fila" key={rig.id}>
            <div className="slider-encabezado">
              <span>
                <strong>{rig.id}</strong> encendido
              </span>
              <span className="valor">
                {formatearDuracion(estado.uptimeSeconds)} de 7d ({((dias / 7) * 100).toFixed(0)}%)
              </span>
            </div>
            <input
              type="range"
              min={0}
              max={SEGUNDOS_POR_PERIODO}
              step={3600}
              value={estado.uptimeSeconds}
              onChange={(evento) => actualizarEquipo(rig.id, { uptimeSeconds: Number(evento.target.value) })}
            />

            <div className="slider-encabezado" style={{ marginTop: 6 }}>
              <span>rendimiento respecto del nominal</span>
              <span className="valor">{estado.rendimiento}%</span>
            </div>
            <input
              type="range"
              min={0}
              max={120}
              step={5}
              value={estado.rendimiento}
              onChange={(evento) => actualizarEquipo(rig.id, { rendimiento: Number(evento.target.value) })}
            />
          </div>
        );
      })}

      <p className="subtitulo" style={{ margin: 0 }}>
        Bajar el encendido de un equipo es el caso que rompe cualquier planilla: ese socio aporta menos, pero
        tampoco paga la luz que no consumio.
      </p>
    </section>
  );
}

function Reparto({
  resultado,
  config,
}: {
  resultado: { settlement: Settlement | null; error: string | null; publicable: string | null };
  config: PoolConfig;
}) {
  if (resultado.error || !resultado.settlement) {
    return (
      <section className="tarjeta">
        <h2>Reparto del periodo</h2>
        <div className="aviso error">No se pudo calcular el reparto: {resultado.error}</div>
      </section>
    );
  }

  const { settlement } = resultado;
  const suma = settlement.payouts.reduce((acc, payout) => acc + payout.amount, 0n);
  const cuadra = suma === settlement.gross;

  const anchoDe = (monto: bigint) =>
    settlement.gross === 0n ? "0%" : `${(Number((monto * 10_000n) / settlement.gross) / 100).toFixed(3)}%`;

  const sociosTotal = settlement.partnerPayouts.reduce((acc, payout) => acc + payout.amount, 0n);

  return (
    <section className="tarjeta">
      <h2>Reparto del periodo</h2>
      <p className="subtitulo">Como se divide el bruto, en el orden en que se sirven los compromisos.</p>

      <div className="cascada">
        <span style={{ width: anchoDe(settlement.energyPaid), background: "var(--energia)" }} />
        <span style={{ width: anchoDe(settlement.maintenance), background: "var(--mantenimiento)" }} />
        <span style={{ width: anchoDe(sociosTotal), background: "var(--acento)" }} />
      </div>

      <div className="resumen-fila">
        <span className="etiqueta">Bruto minado</span>
        <span className="monto">
          {formatUnidades(settlement.gross)} {CADENA.moneda}
        </span>
      </div>
      <div className="resumen-fila">
        <span className="etiqueta">
          <span className="punto energia" />
          Energia pagada
        </span>
        <span className="monto">
          {formatUnidades(settlement.energyPaid)} ({porcentaje(settlement.energyPaid, settlement.gross)}%)
        </span>
      </div>
      <div className="resumen-fila">
        <span className="etiqueta">
          <span className="punto mantenimiento" />
          Fondo de mantenimiento
        </span>
        <span className="monto">
          {formatUnidades(settlement.maintenance)} ({porcentaje(settlement.maintenance, settlement.gross)}%)
        </span>
      </div>
      <div className="resumen-fila">
        <span className="etiqueta">
          <span className="punto socio" />
          Para los socios
        </span>
        <span className="monto">
          {formatUnidades(sociosTotal)} ({porcentaje(sociosTotal, settlement.gross)}%)
        </span>
      </div>

      {settlement.energyDebtCarried > 0n && (
        <div className="aviso alerta" style={{ marginTop: 14 }}>
          El periodo no alcanzo a cubrir la factura de luz. Quedan{" "}
          <strong>
            {formatUnidades(settlement.energyDebtCarried)} {CADENA.moneda}
          </strong>{" "}
          de deuda que se cobran del periodo siguiente. Los socios cobran despues de la luz, no antes.
        </div>
      )}

      <table style={{ marginTop: 16 }}>
        <thead>
          <tr>
            <th>Socio</th>
            <th>Aporte</th>
            <th style={{ textAlign: "right" }}>Le corresponde</th>
          </tr>
        </thead>
        <tbody>
          {settlement.contributions.map((contribucion) => {
            const pago = settlement.partnerPayouts.find((p) => p.to === contribucion.partner);
            const pesoTotal = settlement.contributions.reduce((acc, c) => acc + c.weight, 0n);
            return (
              <tr key={contribucion.partner}>
                <td className="mono" title={contribucion.partner}>
                  {acortarDireccion(contribucion.partner)}
                </td>
                <td>{porcentaje(contribucion.weight, pesoTotal)}%</td>
                <td style={{ textAlign: "right" }} className="mono">
                  {formatUnidades(pago?.amount ?? 0n)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div className={`aviso ${cuadra ? "ok" : "error"}`} style={{ marginTop: 16, marginBottom: 0 }}>
        {cuadra ? (
          <>
            Las cuentas cierran al wei: las {settlement.payouts.length} lineas suman exactamente el bruto. Es
            la invariante que el contrato vuelve a verificar on-chain antes de pagar.
          </>
        ) : (
          <>
            El reparto no conserva el valor ({suma.toString()} contra {settlement.gross.toString()}). La cadena
            rechazaria esta liquidacion.
          </>
        )}
      </div>

      {resultado.publicable && (
        <div className="aviso alerta" style={{ marginTop: 12, marginBottom: 0 }}>
          No se puede publicar todavia: {resultado.publicable}
        </div>
      )}
    </section>
  );
}

function TransaccionAFirmar({
  settlement,
  telemetryHash,
  splitterAddress,
  setSplitterAddress,
}: {
  settlement: Settlement | null;
  telemetryHash: string;
  splitterAddress: string;
  setSplitterAddress: (valor: string) => void;
}) {
  const transaccion = useMemo(() => {
    if (!settlement) return null;
    try {
      return buildSafeTransaction(splitterAddress, settlement, telemetryHash);
    } catch {
      return null;
    }
  }, [settlement, splitterAddress, telemetryHash]);

  return (
    <section className="tarjeta">
      <h2>Transaccion a firmar</h2>
      <p className="subtitulo">
        Lo que los socios aprueban con el multisig. No es un resumen del reparto: son los bytes exactos que
        se ejecutan en la cadena.
      </p>

      <div style={{ marginBottom: 14 }}>
        <label htmlFor="splitter">Direccion del PoolSplitter</label>
        <input
          id="splitter"
          className="mono"
          type="text"
          value={splitterAddress}
          onChange={(evento) => setSplitterAddress(evento.target.value)}
        />
      </div>

      <label>Hash de la telemetria (queda anclado on-chain)</label>
      <div className="codigo" style={{ marginBottom: 14 }}>
        {telemetryHash}
      </div>
      <p className="subtitulo">
        Con este hash cualquier socio toma el JSON crudo del periodo, recalcula el reparto y comprueba que le
        pagaron lo que le correspondia. Nadie tiene que confiar en el servidor que hizo la cuenta.
      </p>

      {transaccion ? (
        <>
          <label>Calldata de settle()</label>
          <div className="codigo">{transaccion.data}</div>
        </>
      ) : (
        <div className="aviso alerta" style={{ marginBottom: 0 }}>
          Completa una direccion valida del PoolSplitter para generar la transaccion.
        </div>
      )}
    </section>
  );
}
