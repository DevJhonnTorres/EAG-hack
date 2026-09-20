import type { BridgeAsset, PoolConfig, RigSpec } from "@hashpool/orchestrator";

/** Catalogo de GPUs para el selector de la interfaz. */
export const GPU_CATALOG = [
  { model: "RTX 3070", hashrateMilliHs: 60_000_000_000, tdpWatts: 220 },
  { model: "RTX 3080", hashrateMilliHs: 98_000_000_000, tdpWatts: 320 },
  { model: "RTX 3060 Ti", hashrateMilliHs: 60_000_000_000, tdpWatts: 200 },
  { model: "RX 6700 XT", hashrateMilliHs: 47_000_000_000, tdpWatts: 230 },
] as const;

export const SEGUNDOS_POR_DIA = 24 * 60 * 60;
export const DIAS_POR_PERIODO = 7;
export const SEGUNDOS_POR_PERIODO = DIAS_POR_PERIODO * SEGUNDOS_POR_DIA;

/**
 * Escenario inicial: el caso concreto que motiva el proyecto. Un socio aporta
 * dos placas y el otro una. Todo esto es editable desde la interfaz.
 */
export const RIGS_INICIALES: RigSpec[] = [
  {
    id: "rig-a",
    partner: "0x92302923eBE05EC3984A49755346Cf02327e7CA5",
    gpus: [GPU_CATALOG[0], GPU_CATALOG[0]],
    baseloadWatts: 80,
    psuEfficiencyBps: 9_000,
  },
  {
    id: "rig-b",
    partner: "0x937B8Ead58E73d1A22022d9731536589793207a6",
    gpus: [GPU_CATALOG[0]],
    baseloadWatts: 80,
    psuEfficiencyBps: 9_000,
  },
];

export const CONFIG_INICIAL: PoolConfig = {
  rigs: RIGS_INICIALES,
  // 0.00003 HSK por kWh.
  //
  // Calibrado contra el saldo real del baul, no contra un numero redondo: el
  // equipo del pool consume unos 153 kWh por semana, asi que la luz sale ~23%
  // de un bruto de 0.02 HSK. Con una tarifa pensada para un bruto mayor, la
  // factura se comeria el periodo entero y los socios cobrarian cero: seria un
  // reparto correcto (un periodo en perdida) pero una demostracion enganosa.
  //
  // Es un valor de demostracion y se edita desde la pantalla. Si cambia el
  // saldo del baul, conviene ajustarlo para que el reparto siga siendo legible.
  tariffWeiPerKwh: 30_000_000_000_000n,
  maintenanceBps: 500,
  energyWallet: "0xcd23dAd3cDb7eb7046829f033c92107fC60F316b",
  maintenanceVault: "0x854404820b29eACF86697550ECade5de93F28501",
};

/**
 * Bruto inicial simulado: 0.02 HSK, por debajo de lo que el baul tiene en la
 * cadena. Asi el reparto que se previsualiza es uno que el baul puede pagar de
 * verdad, y el boton de ejecutar no aparece deshabilitado por falta de fondos.
 */
export const BRUTO_INICIAL = 2n * 10n ** 16n;

/**
 * Parametros de demostracion del bridge a USDC en Linea.
 *
 * Son valores de ejemplo, no cotizaciones: ningun exchange se consulta. Se dejan
 * como texto porque se editan desde la pantalla y se convierten a enteros recien
 * al calcular. La comision de retiro es chica a proposito: el reparto de la demo
 * es de centavos, y con la comision real de un retiro (del orden de 1 USDC) el
 * bridge saldria inviable y la demostracion no mostraria nada.
 */
export const BRIDGE_INICIAL: Record<
  BridgeAsset,
  { precio: string; comisionRetiro: string; retiroMinimo: string }
> = {
  ETC: { precio: "20", comisionRetiro: "0.01", retiroMinimo: "0.05" },
  BTC: { precio: "100000", comisionRetiro: "0.01", retiroMinimo: "0.05" },
};

/** Comision de venta en el exchange: 0,20%. */
export const COMISION_VENTA_BPS_INICIAL = 20;

export const CADENAS = {
  133: {
    nombre: "HSKChain Testnet",
    moneda: "HSK",
    explorer: "https://testnet-explorer.hskchain.net",
    rpc: "https://testnet.hsk.xyz",
  },
  177: {
    nombre: "HSKChain",
    moneda: "HSK",
    explorer: "https://hsk.blockscout.com",
    rpc: "https://mainnet.hsk.xyz",
  },
  11155111: {
    nombre: "Sepolia",
    moneda: "ETH",
    explorer: "https://sepolia.etherscan.io",
    rpc: "",
  },
} as const;

export type ChainId = keyof typeof CADENAS;

/**
 * Contratos del pool desplegados y verificados en HSKChain testnet.
 * Desplegados con `forge script script/DeployPool.s.sol:DeployPool`.
 */
export const CONTRATOS = {
  /**
   * Gnosis Safe que custodia las ganancias, con umbral de una firma.
   *
   * El protocolo soporta cualquier umbral; este pool se configuro a 1 de 1 para
   * que la demostracion pueda ejecutarse desde una sola wallet. Un pool real
   * entre socios usaria 2 de 2, que es lo que impide que uno mueva los fondos
   * por su cuenta, y el codigo es exactamente el mismo.
   */
  baul: "0xb6b534Fe7c8B5ef35b4FB33Ca95288df16823fde",
  /** Segundo Safe, con el mismo dueno, que acumula el fondo de mantenimiento. */
  vaultMantenimiento: "0x854404820b29eACF86697550ECade5de93F28501",
  registry: "0x2BC8E7B9Db2d46479C35a31112BbD6b8e535B390",
  splitter: "0xB8c0C32385577620fFecfd59DD6Dd2863226F1F1",
  /** Token ERC-3009 con el que el agente paga sus insumos de datos via x402. */
  credito: "0x891a0838Af855147b5E911576E2224c8a23280e4",
} as const;
