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
  // 0.000006 HSK por kWh: calibrado para que la luz pese ~23% del bruto inicial.
  //
  // En un pool real este numero lo pone la distribuidora. Aca es un valor de
  // demostracion, porque los montos de testnet son arbitrarios: con una tarifa
  // pensada para un bruto mayor, la factura se comeria el periodo entero y los
  // socios cobrarian cero. Seria un reparto correcto, porque es un periodo en
  // perdida, pero una demostracion enganosa.
  //
  // El boton "ajustar al saldo del baul" recalcula esto contra los fondos que
  // el baul tiene en la cadena, para no tener que tocarlo a mano cada vez.
  tariffWeiPerKwh: 6_000_000_000_000n,
  maintenanceBps: 500,
  energyWallet: "0xcd23dAd3cDb7eb7046829f033c92107fC60F316b",
  maintenanceVault: "0xB761E312fc8176f1faeEE750a985B0c43Ffa75d6",
};

/**
 * Bruto inicial simulado: 0.02 HSK, por debajo de lo que el baul tiene en la
 * cadena. Asi el reparto que se previsualiza es uno que el baul puede pagar de
 * verdad, y el boton de ejecutar no aparece deshabilitado por falta de fondos.
 */
export const BRUTO_INICIAL = 4n * 10n ** 15n;

/** Campos editables del bridge de un activo. Son texto: se convierten a enteros al calcular. */
export interface CamposBridge {
  /** USDC por 1 unidad del activo. */
  precio: string;
  /** Comision de retiro de USDC del exchange. */
  comisionRetiro: string;
  /** Retiro minimo de USDC del exchange. */
  retiroMinimo: string;
  /** Costo de pasar el USDC de Ethereum a Linea. Depende del bridge que se use: no se consulta. */
  costoBridge: string;
}

/**
 * Valores de demostracion del bridge, para cuando no hay datos reales.
 *
 * No son cotizaciones. El reparto de la demo es de centavos, asi que los costos
 * de retiro son simbolicos: con los reales (retiro minimo de 25 USDC) ninguna
 * linea de la demo seria viable, y la tarjeta no mostraria nada. Con datos de
 * HashKey Exchange, la tarjeta usa los costos reales y lo dice.
 */
export const BRIDGE_INICIAL: Record<BridgeAsset, CamposBridge> = {
  HSK: { precio: "0.098", comisionRetiro: "0.0001", retiroMinimo: "0.0001", costoBridge: "0" },
  BTC: { precio: "80000", comisionRetiro: "0.0001", retiroMinimo: "0.0001", costoBridge: "0" },
};

/**
 * Comision de venta total de la ruta, en basis points (0,40%).
 *
 * Es un supuesto: la tarifa real depende del nivel de la cuenta y de cuantos
 * pares recorre la ruta (dos para BTC, tres para HSK). Se ajusta a la tarifa propia.
 */
export const COMISION_VENTA_BPS_INICIAL = 40;

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

/** Porcion del bruto que la luz deberia representar en la demostracion. */
export const LUZ_OBJETIVO_BPS = 2_296n;

/**
 * Tarifa que hace que la energia pese `LUZ_OBJETIVO_BPS` de un bruto dado.
 *
 * Existe para que la pantalla se adapte a los fondos que el baul tenga en la
 * cadena, en vez de obligar a recalibrar un numero a mano cada vez que cambia
 * el saldo. Un pool real no hace esto: toma la tarifa de la distribuidora.
 */
export function tarifaParaElBruto(gross: bigint, wallWattSeconds: bigint): bigint {
  if (wallWattSeconds === 0n) return 0n;
  // wei/kWh = (bruto * objetivo / 10000) * (vatios-segundo por kWh) / consumo
  return (gross * LUZ_OBJETIVO_BPS * 3_600_000n) / (10_000n * wallWattSeconds);
}

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
  baul: "0x9e77152369d642F327Dc7B3c2F468402EFd107Ac",
  /** Segundo Safe, con el mismo dueno, que acumula el fondo de mantenimiento. */
  vaultMantenimiento: "0xB761E312fc8176f1faeEE750a985B0c43Ffa75d6",
  registry: "0x9444c186EA64BcB22D80D77B532d1c65b33238Eb",
  splitter: "0xC6f7406Bd215b48898C3B9F0eb0C3F91f8f89D6e",
  /** Token ERC-3009 con el que el agente paga sus insumos de datos via x402. */
  credito: "0x891a0838Af855147b5E911576E2224c8a23280e4",
} as const;
