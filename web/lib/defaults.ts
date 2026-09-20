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
    partner: "0x1111111111111111111111111111111111111111",
    gpus: [GPU_CATALOG[0], GPU_CATALOG[0]],
    baseloadWatts: 80,
    psuEfficiencyBps: 9_000,
  },
  {
    id: "rig-b",
    partner: "0x2222222222222222222222222222222222222222",
    gpus: [GPU_CATALOG[0]],
    baseloadWatts: 80,
    psuEfficiencyBps: 9_000,
  },
];

export const CONFIG_INICIAL: PoolConfig = {
  rigs: RIGS_INICIALES,
  // 0.0015 HSK por kWh. Calibrado para que, con el hardware y el bruto iniciales,
  // la luz represente alrededor del 20% del periodo: la proporcion realista de un
  // pool chico, y la que hace visible el compromiso que el reparto tiene que resolver.
  tariffWeiPerKwh: 1_500_000_000_000_000n,
  maintenanceBps: 500,
  energyWallet: "0x3333333333333333333333333333333333333333",
  maintenanceVault: "0x4444444444444444444444444444444444444444",
};

/** Bruto inicial simulado: 1 HSK minado en la semana. */
export const BRUTO_INICIAL = 10n ** 18n;

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
