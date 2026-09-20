import { describe, expect, it } from "@jest/globals";
import { readFileSync } from "node:fs";
import { HDNodeWallet, Wallet, getAddress, recoverAddress } from "ethers";
import {
  DuplicateSignerError,
  InsufficientSignaturesError,
  SAFE_TX_TYPES,
  buildSafeTransaction,
  computeSafeTxHash,
  encodeSignatures,
  safeDomain,
  type SafeTransaction,
} from "../src/adapters/safe.js";

/**
 * Fixture generado por el contrato de Safe realmente desplegado en HSKChain
 * testnet (ver contracts/test/fork/SafeTxHashFixture.t.sol). Se regenera con
 * `npm run fixtures:safe`.
 */
const fixture = JSON.parse(readFileSync(new URL("../../fixtures/safe-tx-hash.json", import.meta.url), "utf8"));

const transaccionDelFixture: SafeTransaction = buildSafeTransaction({
  to: fixture.to,
  value: BigInt(fixture.value),
  data: fixture.data,
  nonce: BigInt(fixture.nonce),
});

describe("computeSafeTxHash", () => {
  /**
   * La comprobacion que justifica todo este modulo: si el hash de TypeScript no
   * coincide con el que produce el Safe en Solidity, los socios firmarian algo
   * que el contrato no reconoce y el fallo recien aparecerian al ejecutar.
   */
  it("reproduce exactamente el hash que calcula el Safe real desplegado en HSKChain", () => {
    const hash = computeSafeTxHash(fixture.chainId, fixture.safeAddress, transaccionDelFixture);
    expect(hash).toBe(fixture.expectedSafeTxHash);
  });

  it("el fixture proviene de la cadena esperada", () => {
    expect(fixture.chainId).toBe(133);
    expect(fixture.expectedSafeTxHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  /** El chainId es parte del dominio: protege contra replay entre cadenas. */
  it("cambia si cambia la cadena", () => {
    const enHsk = computeSafeTxHash(133, fixture.safeAddress, transaccionDelFixture);
    const enSepolia = computeSafeTxHash(11_155_111, fixture.safeAddress, transaccionDelFixture);
    expect(enHsk).not.toBe(enSepolia);
  });

  it("cambia si cambia el Safe", () => {
    const otro = "0x00000000000000000000000000000000000000ff";
    expect(computeSafeTxHash(133, otro, transaccionDelFixture)).not.toBe(fixture.expectedSafeTxHash);
  });

  /** El nonce es lo que impide reejecutar una liquidacion ya aprobada. */
  it("cambia si cambia el nonce", () => {
    const siguiente = { ...transaccionDelFixture, nonce: 1n };
    expect(computeSafeTxHash(133, fixture.safeAddress, siguiente)).not.toBe(fixture.expectedSafeTxHash);
  });

  it("cambia si cambia un solo byte de la calldata", () => {
    const alterada = { ...transaccionDelFixture, data: `${fixture.data.slice(0, -1)}0` };
    expect(computeSafeTxHash(133, fixture.safeAddress, alterada)).not.toBe(fixture.expectedSafeTxHash);
  });

  it("cambia si cambia el monto", () => {
    const alterada = { ...transaccionDelFixture, value: transaccionDelFixture.value + 1n };
    expect(computeSafeTxHash(133, fixture.safeAddress, alterada)).not.toBe(fixture.expectedSafeTxHash);
  });
});

describe("buildSafeTransaction", () => {
  it("usa valores por defecto que hacen revertir la transaccion entera si la llamada falla", () => {
    const tx = buildSafeTransaction({ to: fixture.to, value: 1n, data: "0x", nonce: 0n });
    expect(tx.safeTxGas).toBe(0n);
    expect(tx.gasPrice).toBe(0n);
    expect(tx.operation).toBe(0);
  });

  it("normaliza la direccion destino a formato checksum", () => {
    const tx = buildSafeTransaction({ to: fixture.to.toLowerCase(), value: 1n, data: "0x", nonce: 0n });
    expect(tx.to).toBe(getAddress(fixture.to));
  });
});

describe("encodeSignatures", () => {
  const firmantes = [
    new Wallet("0x0000000000000000000000000000000000000000000000000000000000000001"),
    new Wallet("0x0000000000000000000000000000000000000000000000000000000000000002"),
    new Wallet("0x0000000000000000000000000000000000000000000000000000000000000003"),
  ];

  const firmar = async (wallet: Wallet | HDNodeWallet) => ({
    signer: wallet.address,
    signature: await wallet.signTypedData(
      safeDomain(fixture.chainId, fixture.safeAddress),
      SAFE_TX_TYPES as never,
      transaccionDelFixture,
    ),
  });

  it("produce firmas que recuperan al dueno correcto sobre el hash del Safe", async () => {
    const firma = await firmar(firmantes[0]!);
    const recuperado = recoverAddress(fixture.expectedSafeTxHash, firma.signature);
    expect(recuperado).toBe(firmantes[0]!.address);
  });

  /**
   * Safe valida que las direcciones recuperadas vengan en orden ascendente: es
   * como detecta que un mismo dueno no firmo dos veces. Mandarlas desordenadas
   * hace fallar la validacion aunque todas las firmas sean validas.
   */
  it("ordena las firmas por direccion, sin importar en que orden se recolectaron", async () => {
    const firmas = await Promise.all(firmantes.map(firmar));
    const desordenadas = [...firmas].reverse();

    const esperado = encodeSignatures(firmas, 3);
    expect(encodeSignatures(desordenadas, 3)).toBe(esperado);

    // Y el orden resultante es efectivamente el ascendente por direccion.
    const ordenadas = [...firmantes].sort((a, b) =>
      a.address.toLowerCase() < b.address.toLowerCase() ? -1 : 1,
    );
    let offset = 2;
    for (const wallet of ordenadas) {
      const firma = `0x${esperado.slice(offset, offset + 130)}`;
      expect(recoverAddress(fixture.expectedSafeTxHash, firma)).toBe(wallet.address);
      offset += 130;
    }
  });

  it("produce 65 bytes por firma", async () => {
    const firmas = await Promise.all(firmantes.slice(0, 2).map(firmar));
    const codificadas = encodeSignatures(firmas, 2);
    expect((codificadas.length - 2) / 2).toBe(2 * 65);
  });

  it("rechaza un conjunto que no alcanza el umbral del Safe", async () => {
    const firmas = await Promise.all(firmantes.slice(0, 1).map(firmar));
    expect(() => encodeSignatures(firmas, 2)).toThrow(InsufficientSignaturesError);
  });

  it("rechaza que un mismo dueno firme dos veces", async () => {
    const firma = await firmar(firmantes[0]!);
    expect(() => encodeSignatures([firma, firma], 2)).toThrow(DuplicateSignerError);
  });
});
