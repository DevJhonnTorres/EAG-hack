"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { BrowserProvider, Contract, getAddress, recoverAddress } from "ethers";
import {
  SAFE_TX_TYPES,
  buildSafeTransaction,
  computeSafeTxHash,
  encodeSignatures,
  mensajeDeWallet,
  safeDomain,
  type OwnerSignature,
  type SafeTransaction,
  type Settlement,
} from "@hashpool/orchestrator";
import { SAFE_ABI } from "@/lib/safeAbi";
import { asegurarCadena, conectar, haySoporteDeWallet, type DatosCadena } from "@/lib/wallet";
import { lectorDeCadena } from "@/lib/lector";
import { encodeSettle } from "@/lib/calldata";
import { acortarDireccion, formatUnidades } from "@/lib/format";

interface EstadoSafe {
  readonly nonce: bigint;
  readonly threshold: number;
  readonly owners: string[];
  readonly balance: bigint;
  /** Hash que devuelve el propio contrato, para contrastar contra el calculado. */
  readonly hashSegunContrato: string;
}

export function FirmaMultisig({
  cadena,
  safeAddress,
  splitterAddress,
  settlement,
  telemetryHash,
}: {
  cadena: DatosCadena;
  safeAddress: string;
  splitterAddress: string;
  settlement: Settlement | null;
  telemetryHash: string;
}) {
  const [estado, setEstado] = useState<EstadoSafe | null>(null);
  const [errorLectura, setErrorLectura] = useState<string | null>(null);
  const [cuenta, setCuenta] = useState<string | null>(null);
  const [provider, setProvider] = useState<BrowserProvider | null>(null);
  const [firmas, setFirmas] = useState<OwnerSignature[]>([]);
  const [pegada, setPegada] = useState("");
  const [aviso, setAviso] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);

  /** La transaccion del Safe que corresponde a este reparto. */
  const transaccion: SafeTransaction | null = useMemo(() => {
    if (!settlement || !estado) return null;
    try {
      return buildSafeTransaction({
        to: splitterAddress,
        value: settlement.gross,
        data: encodeSettle(settlement, telemetryHash),
        nonce: estado.nonce,
      });
    } catch {
      return null;
    }
  }, [settlement, estado, splitterAddress, telemetryHash]);

  const hashCalculado = useMemo(() => {
    if (!transaccion) return null;
    try {
      return computeSafeTxHash(cadena.chainId, safeAddress, transaccion);
    } catch {
      return null;
    }
  }, [transaccion, cadena.chainId, safeAddress]);

  // Lectura del estado del Safe. No necesita wallet: cualquiera puede auditarlo.
  const leerSafe = useCallback(async () => {
    setErrorLectura(null);
    try {
      const lector = lectorDeCadena(cadena.rpc, cadena.chainId);
      const safe = new Contract(safeAddress, SAFE_ABI, lector);

      const [nonce, threshold, owners, balance] = await Promise.all([
        safe.nonce() as Promise<bigint>,
        safe.getThreshold() as Promise<bigint>,
        safe.getOwners() as Promise<string[]>,
        lector.getBalance(safeAddress),
      ]);

      let hashSegunContrato = "";
      if (settlement) {
        const data = encodeSettle(settlement, telemetryHash);
        hashSegunContrato = (await safe.getTransactionHash(
          splitterAddress,
          settlement.gross,
          data,
          0,
          0,
          0,
          0,
          "0x0000000000000000000000000000000000000000",
          "0x0000000000000000000000000000000000000000",
          nonce,
        )) as string;
      }

      setEstado({ nonce, threshold: Number(threshold), owners, balance, hashSegunContrato });
    } catch (causa) {
      setErrorLectura(causa instanceof Error ? causa.message : String(causa));
    }
  }, [cadena.rpc, cadena.chainId, safeAddress, settlement, splitterAddress, telemetryHash]);

  useEffect(() => {
    void leerSafe();
  }, [leerSafe]);

  // Un cambio en el reparto invalida las firmas ya recolectadas: firman otro hash.
  useEffect(() => {
    setFirmas([]);
    setTxHash(null);
  }, [hashCalculado]);

  const esDueno = cuenta && estado?.owners.some((o) => o.toLowerCase() === cuenta.toLowerCase());

  const conectarWallet = async () => {
    setError(null);
    setOcupado(true);
    try {
      const { provider: p, cuenta: c } = await conectar(cadena);
      setProvider(p);
      setCuenta(getAddress(c));
    } catch (causa) {
      setError(mensajeDeWallet(causa));
    } finally {
      setOcupado(false);
    }
  };

  const firmar = async () => {
    if (!provider || !transaccion || !hashCalculado) return;
    setError(null);
    setAviso(null);
    setOcupado(true);
    try {
      const signer = await provider.getSigner();
      const firma = await signer.signTypedData(
        safeDomain(cadena.chainId, safeAddress),
        SAFE_TX_TYPES as never,
        transaccion,
      );
      agregarFirma({ signer: await signer.getAddress(), signature: firma });
    } catch (causa) {
      setError(mensajeDeWallet(causa));
    } finally {
      setOcupado(false);
    }
  };

  /**
   * Agrega una firma tras comprobar que recupera a un dueno del Safe sobre este
   * hash exacto. Una firma de otra transaccion, o de alguien ajeno, se rechaza
   * aca y no al ejecutar, que es cuando cuesta gas y hay un jurado mirando.
   */
  const agregarFirma = (firma: OwnerSignature) => {
    if (!hashCalculado || !estado) return;
    let recuperado: string;
    try {
      recuperado = recoverAddress(hashCalculado, firma.signature);
    } catch {
      setError("la firma no tiene un formato valido");
      return;
    }

    if (!estado.owners.some((o) => o.toLowerCase() === recuperado.toLowerCase())) {
      setError(`la firma recupera a ${acortarDireccion(recuperado)}, que no es dueno de este baul`);
      return;
    }
    if (firmas.some((f) => f.signer.toLowerCase() === recuperado.toLowerCase())) {
      setAviso(`${acortarDireccion(recuperado)} ya habia firmado`);
      return;
    }

    setFirmas((previas) => [...previas, { signer: recuperado, signature: firma.signature }]);
    setAviso(`firma de ${acortarDireccion(recuperado)} aceptada`);
  };

  const ejecutar = async () => {
    if (!provider || !transaccion || !estado || !settlement) return;
    setError(null);
    setOcupado(true);
    try {
      const signatures = encodeSignatures(firmas, estado.threshold);
      const signer = await provider.getSigner();
      const safe = new Contract(safeAddress, SAFE_ABI, signer);

      const tx = await safe.execTransaction(
        transaccion.to,
        transaccion.value,
        transaccion.data,
        transaccion.operation,
        transaccion.safeTxGas,
        transaccion.baseGas,
        transaccion.gasPrice,
        transaccion.gasToken,
        transaccion.refundReceiver,
        signatures,
      );
      setTxHash(tx.hash);
      await tx.wait();
      setAviso("liquidacion ejecutada");
      setFirmas([]);
      await leerSafe();
    } catch (causa) {
      setError(mensajeDeWallet(causa));
    } finally {
      setOcupado(false);
    }
  };

  const fondosSuficientes = estado && settlement ? estado.balance >= settlement.gross : false;
  const hashesCoinciden =
    !estado?.hashSegunContrato || !hashCalculado
      ? null
      : estado.hashSegunContrato.toLowerCase() === hashCalculado.toLowerCase();

  return (
    <section className="tarjeta">
      <div className="equipo-encabezado" style={{ marginBottom: 4 }}>
        <h2 style={{ margin: 0 }}>Firma del multisig</h2>
        {cuenta ? (
          <span className="chip">
            {acortarDireccion(cuenta)} {esDueno ? "· dueno" : "· no es dueno"}
          </span>
        ) : (
          <button className="primario" onClick={() => void conectarWallet()} disabled={ocupado}>
            Conectar wallet
          </button>
        )}
      </div>
      <p className="subtitulo">
        Los socios aprueban el reparto firmando con su propia wallet. Ninguno puede liquidar solo.
      </p>

      {errorLectura && (
        <div className="aviso error">No se pudo leer el baul en la cadena: {errorLectura}</div>
      )}

      {estado && (
        <>
          <div className="resumen-fila">
            <span className="etiqueta">Saldo del baul</span>
            <span className="monto">
              {formatUnidades(estado.balance)} {cadena.moneda}
            </span>
          </div>
          <div className="resumen-fila">
            <span className="etiqueta">Firmas necesarias</span>
            <span className="monto">
              {firmas.length} de {estado.threshold}
            </span>
          </div>
          <div className="resumen-fila">
            <span className="etiqueta">Nonce del baul</span>
            <span className="monto">{estado.nonce.toString()}</span>
          </div>
        </>
      )}

      {/*
        La interfaz calcula el hash EIP-712 por su cuenta y lo contrasta contra el que
        devuelve el propio contrato. Si difirieran, los socios estarian firmando algo que
        el Safe no reconoce, y el fallo solo aparecerian al ejecutar.
      */}
      {hashesCoinciden !== null && (
        <div className={`aviso ${hashesCoinciden ? "ok" : "error"}`} style={{ marginTop: 14 }}>
          {hashesCoinciden
            ? "El hash a firmar coincide con el que devuelve el contrato del baul."
            : "El hash calculado NO coincide con el del contrato. No firmes: el Safe lo rechazaria."}
        </div>
      )}

      {estado && settlement && !fondosSuficientes && (
        <div className="aviso alerta">
          El baul tiene {formatUnidades(estado.balance)} {cadena.moneda} y el reparto necesita{" "}
          {formatUnidades(settlement.gross)}. Transferile fondos antes de liquidar.
        </div>
      )}

      {hashCalculado && (
        <>
          <label style={{ marginTop: 12 }}>Hash a firmar</label>
          <div className="codigo" style={{ maxHeight: 60 }}>
            {hashCalculado}
          </div>
        </>
      )}

      {cuenta && (
        <div style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
          <button onClick={() => void firmar()} disabled={ocupado || !esDueno || !hashesCoinciden}>
            Firmar con esta wallet
          </button>
          {estado && firmas.length >= estado.threshold && (
            <button className="primario" onClick={() => void ejecutar()} disabled={ocupado || !fondosSuficientes}>
              Ejecutar liquidacion
            </button>
          )}
        </div>
      )}

      {!haySoporteDeWallet() && (
        <div className="aviso alerta" style={{ marginTop: 14 }}>
          No se detecto una wallet en este navegador. Instala MetaMask para firmar.
        </div>
      )}

      {firmas.length > 0 && (
        <table style={{ marginTop: 16 }}>
          <thead>
            <tr>
              <th>Firmante</th>
              <th style={{ textAlign: "right" }}>Firma</th>
            </tr>
          </thead>
          <tbody>
            {firmas.map((firma) => (
              <tr key={firma.signer}>
                <td className="mono">{acortarDireccion(firma.signer)}</td>
                <td style={{ textAlign: "right" }}>
                  <button onClick={() => void navigator.clipboard?.writeText(firma.signature)}>
                    copiar
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/*
        Los socios suelen estar en dispositivos distintos. Cada uno firma en el suyo y pasa
        su firma; no hace falta un servidor intermediario para juntarlas.
      */}
      <label style={{ marginTop: 16 }}>Pegar la firma del otro socio</label>
      <div style={{ display: "flex", gap: 8 }}>
        <input
          className="mono"
          type="text"
          placeholder="0x..."
          value={pegada}
          onChange={(evento) => setPegada(evento.target.value)}
        />
        <button
          onClick={() => {
            agregarFirma({ signer: "", signature: pegada.trim() });
            setPegada("");
          }}
          disabled={pegada.trim().length === 0}
        >
          Agregar
        </button>
      </div>

      {aviso && (
        <div className="aviso ok" style={{ marginTop: 14, marginBottom: 0 }}>
          {aviso}
        </div>
      )}
      {error && (
        <div className="aviso error" style={{ marginTop: 14, marginBottom: 0 }}>
          {error}
          {/*
            Si la wallet se resiste a cambiar de red, hay una salida manual: se
            puede reintentar el cambio, o agregar la cadena a mano con estos datos.
            Quedarse sin recurso frente a una wallet testaruda no es una opcion.
          */}
          {error.includes("cadena") && (
            <div style={{ marginTop: 10 }}>
              <button onClick={() => void asegurarCadena(cadena).then(() => setError(null), (c) => setError(String(c)))}>
                Reintentar el cambio a {cadena.nombre}
              </button>
              <div className="codigo" style={{ marginTop: 10, maxHeight: 120 }}>
                Red: {cadena.nombre}
                <br />
                RPC: {cadena.rpc}
                <br />
                Chain ID: {cadena.chainId}
                <br />
                Moneda: {cadena.moneda}
                <br />
                Explorer: {cadena.explorer}
              </div>
            </div>
          )}
        </div>
      )}
      {txHash && (
        <div className="aviso ok" style={{ marginTop: 14, marginBottom: 0 }}>
          Transaccion enviada:{" "}
          <a href={`${cadena.explorer}/tx/${txHash}`} target="_blank" rel="noreferrer">
            verla en Blockscout
          </a>
        </div>
      )}
    </section>
  );
}
