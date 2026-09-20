"use client";

import { useEffect, useMemo, useState } from "react";
import { Contract } from "ethers";
import {
  SettlementBuilder,
  assertPublishable,
  hashTelemetry,
  nextSettleableEpoch,
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
  tarifaParaElBruto,
} from "@/lib/defaults";
import { acortarDireccion, formatUnidades, formatearDuracion, parseUnidades, porcentaje } from "@/lib/format";
import { POOL_SPLITTER_ABI, buildSafeTransaction } from "@/lib/calldata";
import { lectorDeCadena } from "@/lib/lector";
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
  const [saldoBaul, setSaldoBaul] = useState<bigint | null>(null);

  // Se lee el saldo del baul para poder ajustar la simulacion a fondos reales, y el
  // ultimo periodo liquidado para no proponer uno que el contrato ya uso. No hace
  // falta wallet: son lecturas publicas de la cadena.
  useEffect(() => {
    let vigente = true;
    const lector = lectorDeCadena(CADENA.rpc, 133);

    lector
      .getBalance(CONTRATOS.baul)
      .then((saldo) => {
        if (vigente) setSaldoBaul(saldo);
      })
      .catch(() => {
        // Sin saldo a la vista la pantalla sigue siendo usable con los valores
        // por defecto; no vale la pena molestar con un error por esto.
      });

    // El splitter rechaza un periodo que no sea mayor al ultimo liquidado. Si la
    // pantalla arrancara en uno ya usado, la liquidacion revertiria al ejecutarla.
    (new Contract(CONTRATOS.splitter, POOL_SPLITTER_ABI, lector).getFunction("lastSettledEpoch")() as Promise<bigint>)
      .then((ultimo) => {
        if (vigente) setEpochId((actual) => Math.max(actual, nextSettleableEpoch(ultimo)));
      })
      .catch(() => {
        // Sin el dato se conserva el periodo por defecto; FirmaMultisig vuelve a
        // comprobarlo antes de dejar firmar.
      });

    return () => {
      vigente = false;
    };
  }, []);

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

  /**
   * Lleva la simulacion a los fondos que el baul tiene de verdad.
   *
   * Los montos de testnet son arbitrarios, asi que una tarifa fija termina
   * comiendose el periodo entero o volviendose invisible segun cuanto haya en
   * el baul. Esto ajusta ambas cosas de una y evita tener que recalibrar a mano.
   */
  const ajustarAlSaldoDelBaul = () => {
    if (saldoBaul === null || saldoBaul === 0n) return;
    const consumo = (resultado.settlement?.contributions ?? []).reduce(
      (acc, contribucion) => acc + contribucion.wallWattSeconds,
      0n,
    );
    setGross(saldoBaul);
    setConfig((previo) => ({ ...previo, tariffWeiPerKwh: tarifaParaElBruto(saldoBaul, consumo) }));
  };

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
          Infrastructure micro-pools. Mining rewards are split by the work each rig actually did, approved by the partners with their multisig, and the chain checks that the books balance before a single wei moves.
        </p>
        <div className="barra-cadena">
          <span className="chip">
            Chain <strong>{CADENA.nombre}</strong>
          </span>
          <span className="chip">
            Currency <strong>{CADENA.moneda}</strong>
          </span>
          <span className="chip">
            Explorer{" "}
            <a href={CADENA.explorer} target="_blank" rel="noreferrer">
              Blockscout
            </a>
          </span>
          <span className="chip">
            Period <strong>#{epochId}</strong>
          </span>
          <span className="chip">
            Treasury{" "}
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
            saldoBaul={saldoBaul}
            ajustarAlSaldoDelBaul={ajustarAlSaldoDelBaul}
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
        The hardware and telemetry data on this screen are demo data, editable here. The payout calculation, the audit hash and the transaction that gets signed are real: the interface runs exactly the same engine that the tests cover and the contract enforces.
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
      <h2>Economic settings</h2>
      <p className="subtitulo">
        The parameters that define the business. Changing them recalculates the payout instantly.
      </p>

      <div className="campos">
        <div>
          <label htmlFor="tarifa">Electricity rate ({CADENA.moneda} per kWh)</label>
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
          <label htmlFor="mantenimiento">Maintenance fund ({config.maintenanceBps / 100}%)</label>
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
          <label htmlFor="energia">Admin wallet that pays the power bill</label>
          <input
            id="energia"
            className="mono"
            type="text"
            value={config.energyWallet}
            onChange={(evento) => setConfig((previo) => ({ ...previo, energyWallet: evento.target.value }))}
          />
        </div>

        <div className="campo-ancho">
          <label htmlFor="vault">Maintenance fund vault</label>
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
        The fund cap is 50%: the contract rejects any setting above it, so a misconfigured reserve can never leave the partners with nothing in a &quot;valid&quot; way.
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
      <h2>Pool rigs</h2>
      <p className="subtitulo">What each partner contributes. It determines their weight and their power use.</p>

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
                  Remove
                </button>
              )}
            </div>

            <div className="campos">
              <div className="campo-ancho">
                <label htmlFor={`socio-${rig.id}`}>Partner wallet</label>
                <input
                  id={`socio-${rig.id}`}
                  className="mono"
                  type="text"
                  value={rig.partner}
                  onChange={(evento) => actualizarRig(rigIndex, { partner: evento.target.value })}
                />
              </div>

              <div>
                <label htmlFor={`baseload-${rig.id}`}>Motherboard &amp; peripherals (W)</label>
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
                <label htmlFor={`psu-${rig.id}`}>PSU efficiency (%)</label>
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

            <label>GPUs</label>
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
              Add GPU
            </button>
          </div>
        );
      })}

      <button className="primario" onClick={agregarEquipo}>
        Add rig
      </button>
    </section>
  );
}

/** Interpreta el texto de un campo sin lanzar mientras la persona escribe. */
function parseUnidadesSegura(texto: string): bigint | null {
  try {
    return parseUnidades(texto);
  } catch {
    return null;
  }
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
  saldoBaul,
  ajustarAlSaldoDelBaul,
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
  saldoBaul: bigint | null;
  ajustarAlSaldoDelBaul: () => void;
}) {
  const [brutoTexto, setBrutoTexto] = useState(formatUnidades(gross));
  const [deudaTexto, setDeudaTexto] = useState(formatUnidades(deudaArrastrada));

  // Si el bruto cambio desde fuera (el boton de ajuste), el campo lo refleja.
  useEffect(() => {
    setBrutoTexto((texto) => (parseUnidadesSegura(texto) === gross ? texto : formatUnidades(gross)));
  }, [gross]);

  return (
    <section className="tarjeta">
      <h2>Period telemetry</h2>
      <p className="subtitulo">
        Demo data, editable here. In production it would come from the mining software's API.
      </p>

      <div className="campos tres">
        <div>
          <label htmlFor="epoch">Period</label>
          <input
            id="epoch"
            type="number"
            min={1}
            value={epochId}
            onChange={(evento) => setEpochId(Math.max(1, Number(evento.target.value) || 1))}
          />
        </div>
        <div>
          <label htmlFor="bruto">Gross mined ({CADENA.moneda})</label>
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
          <label htmlFor="deuda">Carried power debt</label>
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
                <strong>{rig.id}</strong> powered on
              </span>
              <span className="valor">
                {formatearDuracion(estado.uptimeSeconds)} of 7d ({((dias / 7) * 100).toFixed(0)}%)
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
              <span>performance vs. nominal</span>
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

      {saldoBaul !== null && saldoBaul > 0n && (
        <button onClick={ajustarAlSaldoDelBaul} style={{ marginBottom: 14 }}>
          Match the vault balance ({formatUnidades(saldoBaul)} {CADENA.moneda})
        </button>
      )}

      <p className="subtitulo" style={{ margin: 0 }}>
        Turning a rig off is the case that breaks any spreadsheet: that partner contributes less, but also doesn't pay for the power they didn't use.
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
        <h2>Period payout</h2>
        <div className="aviso error">Could not calculate the payout: {resultado.error}</div>
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
      <h2>Period payout</h2>
      <p className="subtitulo">How the gross is split, in the order the obligations are served.</p>

      <div className="cascada">
        <span style={{ width: anchoDe(settlement.energyPaid), background: "var(--energia)" }} />
        <span style={{ width: anchoDe(settlement.maintenance), background: "var(--mantenimiento)" }} />
        <span style={{ width: anchoDe(sociosTotal), background: "var(--acento)" }} />
      </div>

      <div className="resumen-fila">
        <span className="etiqueta">Gross mined</span>
        <span className="monto">
          {formatUnidades(settlement.gross)} {CADENA.moneda}
        </span>
      </div>
      <div className="resumen-fila">
        <span className="etiqueta">
          <span className="punto energia" />
          Power paid
        </span>
        <span className="monto">
          {formatUnidades(settlement.energyPaid)} ({porcentaje(settlement.energyPaid, settlement.gross)}%)
        </span>
      </div>
      <div className="resumen-fila">
        <span className="etiqueta">
          <span className="punto mantenimiento" />
          Maintenance fund
        </span>
        <span className="monto">
          {formatUnidades(settlement.maintenance)} ({porcentaje(settlement.maintenance, settlement.gross)}%)
        </span>
      </div>
      <div className="resumen-fila">
        <span className="etiqueta">
          <span className="punto socio" />
          For the partners
        </span>
        <span className="monto">
          {formatUnidades(sociosTotal)} ({porcentaje(sociosTotal, settlement.gross)}%)
        </span>
      </div>

      {settlement.energyDebtCarried > 0n && (
        <div className="aviso alerta" style={{ marginTop: 14 }}>
          The period did not cover the power bill. There remain{" "}
          <strong>
            {formatUnidades(settlement.energyDebtCarried)} {CADENA.moneda}
          </strong>{" "}
          of debt, collected from the next period. Partners get paid after the power bill, not before.
        </div>
      )}

      <table style={{ marginTop: 16 }}>
        <thead>
          <tr>
            <th>Partner</th>
            <th>Contribution</th>
            <th style={{ textAlign: "right" }}>Owed</th>
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
            The books balance to the wei: the {settlement.payouts.length} lines add up exactly to the gross. It is the invariant the contract checks again on-chain before paying.
          </>
        ) : (
          <>
            The payout does not conserve value ({suma.toString()} vs {settlement.gross.toString()}). The chain would reject this settlement.
          </>
        )}
      </div>

      {resultado.publicable && (
        <div className="aviso alerta" style={{ marginTop: 12, marginBottom: 0 }}>
          Cannot be published yet: {resultado.publicable}
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
      <h2>Transaction to sign</h2>
      <p className="subtitulo">
        What the partners approve with the multisig. It is not a summary of the payout: these are the exact bytes executed on-chain.
      </p>

      <div style={{ marginBottom: 14 }}>
        <label htmlFor="splitter">PoolSplitter address</label>
        <input
          id="splitter"
          className="mono"
          type="text"
          value={splitterAddress}
          onChange={(evento) => setSplitterAddress(evento.target.value)}
        />
      </div>

      <label>Telemetry hash (anchored on-chain)</label>
      <div className="codigo" style={{ marginBottom: 14 }}>
        {telemetryHash}
      </div>
      <p className="subtitulo">
        With this hash any partner takes the period's raw JSON, recomputes the payout and checks they were paid what they were owed. Nobody has to trust the server that did the math.
      </p>

      {transaccion ? (
        <>
          <label>settle() calldata</label>
          <div className="codigo">{transaccion.data}</div>
        </>
      ) : (
        <div className="aviso alerta" style={{ marginBottom: 0 }}>
          Enter a valid PoolSplitter address to generate the transaction.
        </div>
      )}
    </section>
  );
}
