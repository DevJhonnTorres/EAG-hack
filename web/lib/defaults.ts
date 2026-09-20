import type { PoolConfig, RigSpec } from "@hashpool/orchestrator";

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
  // 0.00015 HSK por kWh.
  //
  // Calibrado contra el saldo real del baul, no contra un numero redondo: el
  // equipo del pool consume unos 153 kWh por semana, asi que la luz sale ~23%
  // de un bruto de 0.1 HSK. Con una tarifa pensada para un bruto diez veces
  // mayor, la factura se comeria todo y los socios cobrarian cero: seria un
  // reparto correcto (un periodo en perdida) pero una demostracion enganosa.
  tariffWeiPerKwh: 150_000_000_000_000n,
  maintenanceBps: 500,
  energyWallet: "0xcd23dAd3cDb7eb7046829f033c92107fC60F316b",
  maintenanceVault: "0x8cFA796c87e83963052263A06329F1Ef52DE5653",
};

/**
 * Bruto inicial simulado: 0.1 HSK, que es lo que el baul tiene en la cadena.
 * Asi el reparto que se previsualiza es uno que el baul puede pagar de verdad.
 */
export const BRUTO_INICIAL = 10n ** 17n;

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
  /** Gnosis Safe 2-de-2 que custodia las ganancias. */
  baul: "0x4C9F30792C7f0e93d73334Db13a94565153A0709",
  /** Segundo Safe, con los mismos duenos, que acumula el fondo de mantenimiento. */
  vaultMantenimiento: "0x8cFA796c87e83963052263A06329F1Ef52DE5653",
  registry: "0xEB75bfBb8961F193BC7acd742f85e50bA97aD40f",
  splitter: "0x333FAd08F22752896C55C052352AcE6C6Ab620B7",
  /** Token ERC-3009 con el que el agente paga sus insumos de datos via x402. */
  credito: "0x891a0838Af855147b5E911576E2224c8a23280e4",
} as const;
