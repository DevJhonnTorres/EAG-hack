#!/usr/bin/env node
/**
 * Liquida un periodo del pool desde tu maquina, firmando con la clave del dueno del Safe.
 *
 *   npm run liquidar              # revisa todo y simula, sin enviar nada
 *   npm run liquidar -- --enviar  # ademas firma y envia la transaccion
 *
 * Hace exactamente lo que la web: arma el mismo reparto (ajustado al saldo del baul), el
 * mismo `settle()` y la misma transaccion del Safe, la firma con EIP-712 y llama a
 * `execTransaction`. Sirve cuando la wallet dueña no esta disponible en el navegador.
 *
 * La clave se lee de SAFE_OWNER_KEY en tu `.env` (que git ignora). Nunca se imprime, y el
 * script comprueba que corresponde a un dueno del Safe antes de firmar nada.
 *
 * Solo opera en HSKChain testnet (chain ID 133). Se niega a correr en cualquier otra cadena.
 */
import { fileURLToPath } from "node:url";
import { Contract, JsonRpcProvider, Wallet, formatEther } from "ethers";

const RAIZ = new URL("../", import.meta.url);

try {
  process.loadEnvFile(fileURLToPath(new URL(".env", RAIZ)));
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

// Se importa lo mismo que usa la web: un solo lugar donde viven las direcciones y el calculo.
const { CONTRATOS, CADENAS, CONFIG_INICIAL, BRUTO_INICIAL, SEGUNDOS_POR_PERIODO, tarifaParaElBruto } = await import(
  new URL("web/lib/defaults.ts", RAIZ).href
);
const { encodeSettle, POOL_SPLITTER_ABI } = await import(new URL("web/lib/calldata.ts", RAIZ).href);
const { SAFE_ABI } = await import(new URL("web/lib/safeAbi.ts", RAIZ).href);
const {
  SAFE_TX_TYPES,
  SettlementBuilder,
  assertPublishable,
  buildSafeTransaction,
  computeSafeTxHash,
  encodeSignatures,
  hashTelemetry,
  isEpochSettleable,
  nextSettleableEpoch,
  safeDomain,
} = await import(new URL("orchestrator/dist/index.js", RAIZ).href);

const CHAIN_ID = 133;
const ENVIAR = process.argv.includes("--enviar");

function fail(mensaje) {
  console.error(`\nError: ${mensaje}`);
  process.exit(1);
}

const hsk = (wei) => `${formatEther(wei)} HSK`;
const corta = (dir) => `${dir.slice(0, 6)}...${dir.slice(-4)}`;

// ------------------------------------------------------------------ cadena
const rpc = process.env.HSK_RPC ?? CADENAS[CHAIN_ID].rpc;
const provider = new JsonRpcProvider(rpc, CHAIN_ID, { staticNetwork: true });

const chainIdReal = Number(BigInt(await provider.send("eth_chainId", [])));
if (chainIdReal !== CHAIN_ID) fail(`el RPC responde la cadena ${chainIdReal} y este script solo opera en la ${CHAIN_ID} (testnet)`);

const safe = new Contract(CONTRATOS.baul, SAFE_ABI, provider);
const splitter = new Contract(CONTRATOS.splitter, POOL_SPLITTER_ABI, provider);

const [umbral, duenos, nonce, saldoBaul, ultimoPeriodo] = await Promise.all([
  safe.getThreshold(),
  safe.getOwners(),
  safe.nonce(),
  provider.getBalance(CONTRATOS.baul),
  splitter.lastSettledEpoch(),
]);

const periodoArg = process.argv.indexOf("--periodo");
const periodo = periodoArg >= 0 ? Number(process.argv[periodoArg + 1]) : nextSettleableEpoch(ultimoPeriodo);

console.log(`\nPool en HSKChain testnet`);
console.log(`  Baul (Safe):        ${CONTRATOS.baul}`);
console.log(`  Duenos:             ${duenos.join(", ")}   (firmas necesarias: ${umbral})`);
console.log(`  Saldo del baul:     ${hsk(saldoBaul)}`);
console.log(`  Ultimo periodo:     #${ultimoPeriodo}   ->  se liquidara el #${periodo}`);

if (!isEpochSettleable(periodo, ultimoPeriodo)) {
  fail(`el periodo #${periodo} no se puede liquidar: el contrato exige uno mayor que #${ultimoPeriodo}`);
}
if (saldoBaul === 0n) fail("el baul no tiene saldo: depositale HSK de testnet antes de liquidar");

// --------------------------------------------------------------- el reparto
// Es lo que hace el boton "Match the vault balance" de la web: el bruto es el saldo del baul
// y la tarifa se recalcula para que la luz no se coma el periodo entero.
const telemetria = {
  epochId: periodo,
  startedAt: 1_700_000_000,
  endedAt: 1_700_000_000 + SEGUNDOS_POR_PERIODO,
  rigs: CONFIG_INICIAL.rigs.map((rig) => ({
    rigId: rig.id,
    uptimeSeconds: SEGUNDOS_POR_PERIODO,
    averageHashrateMilliHs: rig.gpus.reduce((acc, gpu) => acc + gpu.hashrateMilliHs, 0),
  })),
};

const constructor = new SettlementBuilder();
const base = constructor.build({ config: CONFIG_INICIAL, telemetry: telemetria, gross: BRUTO_INICIAL, carriedEnergyDebt: 0n });
const consumo = base.contributions.reduce((acc, c) => acc + c.wallWattSeconds, 0n);
const config = { ...CONFIG_INICIAL, tariffWeiPerKwh: tarifaParaElBruto(saldoBaul, consumo) };
const reparto = constructor.build({ config, telemetry: telemetria, gross: saldoBaul, carriedEnergyDebt: 0n });
assertPublishable(reparto, config);

console.log(`\nReparto del periodo #${periodo}  (bruto ${hsk(reparto.gross)})`);
for (const pago of reparto.payouts) console.log(`  ${pago.role.padEnd(12)} ${corta(pago.to)}   ${hsk(pago.amount)}`);

// ------------------------------------------------------------ la transaccion
const tx = buildSafeTransaction({
  to: CONTRATOS.splitter,
  value: reparto.gross,
  data: encodeSettle(reparto, hashTelemetry(telemetria)),
  nonce,
});
const hashLocal = computeSafeTxHash(CHAIN_ID, CONTRATOS.baul, tx);
const hashContrato = await safe.getTransactionHash(
  tx.to, tx.value, tx.data, tx.operation, tx.safeTxGas, tx.baseGas, tx.gasPrice, tx.gasToken, tx.refundReceiver, tx.nonce,
);
if (hashLocal.toLowerCase() !== String(hashContrato).toLowerCase()) {
  fail("el hash calculado NO coincide con el del contrato: no se firma algo que el Safe rechazaria");
}
console.log(`\nHash a firmar (coincide con el contrato): ${hashLocal}`);

// ------------------------------------------------------------- la clave
const clave = process.env.SAFE_OWNER_KEY?.trim();
if (!clave) {
  console.log(
    "\nFalta la clave para firmar. Agrega esta linea a tu .env (edita el archivo tu mismo, no la pegues en el chat):\n\n  SAFE_OWNER_KEY=0x<clave privada de la cuenta duena>\n\ny vuelve a correr `npm run liquidar`.",
  );
  process.exit(2);
}
if (!/^0x[0-9a-fA-F]{64}$/.test(clave)) fail("SAFE_OWNER_KEY no tiene formato de clave privada (0x seguido de 64 caracteres hexadecimales)");

const firmante = new Wallet(clave, provider);
if (!duenos.some((dueno) => dueno.toLowerCase() === firmante.address.toLowerCase())) {
  fail(`la clave corresponde a ${firmante.address}, que no es dueña del baul (la dueña es ${duenos.join(", ")})`);
}
if (umbral !== 1n) fail(`el Safe pide ${umbral} firmas y este script firma con una sola cuenta`);

const firma = await firmante.signTypedData(safeDomain(CHAIN_ID, CONTRATOS.baul), SAFE_TX_TYPES, tx);
const firmas = encodeSignatures([{ signer: firmante.address, signature: firma }], Number(umbral));

// --------------------------------------------------------- simular y estimar
const ejecutar = safe.connect(firmante).getFunction("execTransaction");
const args = [tx.to, tx.value, tx.data, tx.operation, tx.safeTxGas, tx.baseGas, tx.gasPrice, tx.gasToken, tx.refundReceiver, firmas];

try {
  const exito = await ejecutar.staticCall(...args);
  if (!exito) fail("el Safe respondio false en la simulacion");
} catch (error) {
  fail(`la simulacion fallo, no se envia nada: ${error.shortMessage ?? error.message}`);
}

const gas = await ejecutar.estimateGas(...args);
const { gasPrice } = await provider.getFeeData();
const costo = gas * (gasPrice ?? 0n);
const saldoFirmante = await provider.getBalance(firmante.address);
console.log(`\nSimulacion correcta con ${firmante.address}`);
console.log(`  Gas estimado: ${gas}   costo aprox.: ${hsk(costo)}   saldo de la cuenta: ${hsk(saldoFirmante)}`);
if (saldoFirmante < costo * 12n / 10n) fail(`la cuenta no tiene HSK suficiente para el gas (necesita unos ${hsk((costo * 12n) / 10n)})`);

if (!ENVIAR) {
  console.log("\nTodo listo. Para firmar y enviar de verdad:  npm run liquidar -- --enviar");
  process.exit(0);
}

// ------------------------------------------------------------------- enviar
console.log("\nEnviando la transaccion...");
const enviada = await ejecutar(...args);
console.log(`  hash: ${enviada.hash}`);
const recibo = await enviada.wait();
if (recibo?.status !== 1) fail(`la transaccion quedo en la cadena pero fallo (estado ${recibo?.status})`);

const [nonceDespues, periodoDespues, saldoDespues] = await Promise.all([
  safe.nonce(),
  splitter.lastSettledEpoch(),
  provider.getBalance(CONTRATOS.baul),
]);
console.log(`\nLiquidacion ejecutada en el bloque ${recibo.blockNumber}`);
console.log(`  Ultimo periodo liquidado: #${periodoDespues}   nonce del Safe: ${nonceDespues}   saldo del baul: ${hsk(saldoDespues)}`);
console.log(`  ${CADENAS[CHAIN_ID].explorer}/tx/${enviada.hash}`);
