# HashPool

**Micro-pools de infraestructura: reparto de ganancias de minería auditable, verificado on-chain.**

🔗 **[Demo en vivo](https://hashpool-jhonns-projects-665cb796.vercel.app)** · [Contratos en Blockscout](https://testnet-explorer.hskchain.net/address/0x333FAd08F22752896C55C052352AcE6C6Ab620B7)

Dos personas ponen hardware para minar juntas. A fin de mes alguien arma un Excel,
y empieza la discusión: quién gastó más luz, cuánto aportó cada uno, qué pasa si el
equipo de uno estuvo apagado dos días. HashPool convierte esa conversación en
aritmética verificable.

## Cómo funciona

El protocolo separa tres responsabilidades que normalmente se mezclan:

| Capa | Rol | Por qué |
|---|---|---|
| **Middleware** (TypeScript) | **Calcula** el reparto | Barato de cambiar y fácil de testear, pero no es confiable |
| **Gnosis Safe** | **Aprueba** con firmas | La autoridad humana y la única custodia de los fondos |
| **PoolSplitter** (Solidity) | **Verifica** antes de pagar | No confía en el número que recibe: exige que las cuentas cierren al wei |

El contrato **no es una bóveda**. Recibe el valor en la misma transacción que lo
distribuye y termina con saldo cero. Los fondos viven en el Safe.

### Lo que el contrato exige antes de mover un wei

1. Las líneas del reparto suman **exactamente** el bruto enviado.
2. El período avanza de forma estrictamente creciente (no hay doble pago).
3. Cada destinatario está en el `PoolRegistry` y con el rol que declara.
4. Ningún destinatario aparece dos veces.
5. Hay exactamente un pago de energía y uno de mantenimiento.
6. El fondo de mantenimiento alcanza su piso configurado.
7. Viene el hash de la telemetría que sustenta el cálculo.

Si algo de eso falla, la liquidación se revierte entera.

### El radio de daño de un middleware comprometido

Un atacante con control total del servidor que calcula **no puede desviar un wei a
una dirección propia**. El `PoolRegistry` es una allowlist gobernada solo por el Safe,
que es inmutable. Lo máximo que puede hacer es proponer otro reparto entre los
destinatarios legítimos — y eso todavía tiene que pasar por las firmas de los socios.

### El caso que motiva el proyecto

El reparto pondera **hashrate efectivo integrado sobre el tiempo encendido**, no el
hardware declarado. Un socio con el equipo apagado dos días aporta menos, y tampoco
paga la luz que no consumió:

| Escenario | Socio A (2 GPUs) | Socio B (1 GPU) | Factura de luz |
|---|---|---|---|
| Ambos al 100% | 66,66% | 33,33% | 22,96% |
| rig-b apagado 2 días | **73,68%** | **26,31%** | **20,56%** |

### Auditoría

Cada liquidación ancla on-chain el hash de la telemetría cruda del período.
Cualquier socio toma ese JSON, recalcula el reparto y verifica que le pagaron lo que
le correspondía — sin confiar en el servidor que hizo la cuenta ni en la palabra de
quien ejecutó.

## Estructura

```
contracts/      Foundry: PoolRegistry, PoolSplitter, tests y despliegue
orchestrator/   Motor de cálculo (SOLID, bigint) y firma EIP-712 del Safe
web/            Interfaz de configuración y previsualización (Next.js)
fixtures/       Fixture de firma generado por el Safe real de HSKChain
```

## Garantías de calidad

- **70 tests de contratos**: unitarios de cada revert, fuzzing de la conservación del
  valor, y 5 invariantes con estado sobre 16.384 llamadas encadenadas.
  100% de líneas y funciones cubiertas.
- **66 tests del motor**: casos de negocio, validación de telemetría y propiedades con
  `fast-check`. 98,5% de sentencias.
- **Integración sin simulacros**: una suite despliega un Safe 2-de-2 real desde la
  factory oficial de HSKChain, firma con claves reales y ejecuta `execTransaction`
  sobre un fork de la cadena.
- **Verificación cruzada**: el hash EIP-712 que calcula el TypeScript se compara contra
  el que produce el contrato Safe desplegado en HSKChain. Si divergieran, los socios
  firmarían algo que el contrato no reconoce.
- **Sin punto flotante en la ruta del dinero.** Todo el reparto es `bigint`. El sobrante
  de la división entera se asigna por resto mayor, de forma determinista.

## Puesta en marcha

```bash
npm install                 # instala todo, incluido Foundry con versión fijada
cp .env.example .env        # completar wallets y RPC

npm test                    # contratos + motor de cálculo
npm run coverage:sol        # cobertura de los contratos
npm run dev --workspace web # interfaz en http://localhost:3000
```

Foundry se instala **desde npm**, no con `foundryup`: así la versión del compilador
queda fijada en `package.json` y todo el equipo y el CI compilan idéntico.

### Tests contra la cadena real

```bash
HSK_TESTNET_RPC=https://testnet.hsk.xyz npm run test:fork
```

Sin esa variable, las suites de fork se omiten solas.

### Despliegue

El pool completo se crea con un comando. `DeployPool` despliega, en orden: el baúl
de tesorería, el vault del fondo de mantenimiento, el registro y el splitter.

```bash
cp .env.example .env        # ya trae las direcciones del pool
npm run foundry

cd contracts
forge script script/DeployPool.s.sol:DeployPool \
  --rpc-url "$HSK_TESTNET_RPC" \
  --broadcast --verify --verifier blockscout \
  --interactive               # pide la clave sin dejarla en el historial
```

Usá `--interactive` (o `--ledger`, o `--account` con una keystore cifrada) en vez de
`--private-key`: así la clave no queda en el historial del shell ni en un archivo.

**Simular antes de gastar**, contra el estado real de la cadena:

```bash
forge script script/DeployPool.s.sol:DeployPool \
  --rpc-url "$HSK_TESTNET_RPC" --sender <tu-wallet>
```

#### Direcciones previsibles de antemano

La factory de Safe usa CREATE2, así que la dirección del baúl depende solo de sus
dueños, el umbral y el salt — **no de quién ejecuta el despliegue**. Con los dueños y
el salt de `.env.example`:

| Contrato | Dirección |
|---|---|
| Baúl de tesorería | `0x4C9F30792C7f0e93d73334Db13a94565153A0709` |
| Vault de mantenimiento | `0x8cFA796c87e83963052263A06329F1Ef52DE5653` |

Cualquiera puede recalcularlas y verificar que el baúl es el que dice ser.

#### Costo

| Concepto | Gas |
|---|---|
| Baúl de tesorería | 240.927 |
| Vault de mantenimiento | 235.875 |
| `PoolRegistry` | 884.119 |
| `PoolSplitter` | 854.226 |
| **Total** | **2.215.147** |

A ~2 gwei son unos **0,0065 HSK** incluyendo el margen del script.

## Desplegado en HSKChain Testnet

Contratos verificados en Blockscout — el código es auditable por cualquiera.

| Componente | Dirección |
|---|---|
| **Baúl de tesorería** (Safe 2-de-2) | [`0x4C9F30792C7f0e93d73334Db13a94565153A0709`](https://testnet-explorer.hskchain.net/address/0x4C9F30792C7f0e93d73334Db13a94565153A0709) |
| **Vault de mantenimiento** (Safe 2-de-2) | [`0x8cFA796c87e83963052263A06329F1Ef52DE5653`](https://testnet-explorer.hskchain.net/address/0x8cFA796c87e83963052263A06329F1Ef52DE5653) |
| **PoolRegistry** ✓ verificado | [`0xEB75bfBb8961F193BC7acd742f85e50bA97aD40f`](https://testnet-explorer.hskchain.net/address/0xEB75bfBb8961F193BC7acd742f85e50bA97aD40f) |
| **PoolSplitter** ✓ verificado | [`0x333FAd08F22752896C55C052352AcE6C6Ab620B7`](https://testnet-explorer.hskchain.net/address/0x333FAd08F22752896C55C052352AcE6C6Ab620B7) |
| **PoolCredit** (ERC-3009, x402) ✓ verificado | [`0x891a0838Af855147b5E911576E2224c8a23280e4`](https://testnet-explorer.hskchain.net/address/0x891a0838Af855147b5E911576E2224c8a23280e4) |

Destinatarios del reparto:

| Rol | Dirección |
|---|---|
| Wallet de la luz | `0xcd23dAd3cDb7eb7046829f033c92107fC60F316b` |
| Socio A | `0x92302923eBE05EC3984A49755346Cf02327e7CA5` |
| Socio B | `0x937B8Ead58E73d1A22022d9731536589793207a6` |

Los dos socios son los dueños del baúl, con umbral de **2 firmas**: ninguno puede
mover los fondos por su cuenta.

## El agente que se paga solo (x402)

El motor necesita insumos que no son gratis: la tarifa eléctrica vigente, el precio
del coin. Con **x402** el proveedor responde `402 Payment Required` describiendo su
precio, el agente firma una autorización de pago y reintenta la llamada.

Eso cierra el bucle del proyecto: el hardware genera ingresos → el fondo de
mantenimiento reserva una porción → **el agente se financia sus propios datos**.
Máquina a máquina, sin que ningún humano apruebe cada consulta.

Se implementa el esquema `exact` sobre EVM, que paga con una autorización
**ERC-3009** firmada fuera de la cadena: quien cobra la presenta y paga el gas, así
que el agente no necesita gas ni estar en línea.

```
GET /api/tarifa                       → 402 + PAYMENT-REQUIRED
GET /api/tarifa + PAYMENT-SIGNATURE   → 200 + el dato + PAYMENT-RESPONSE
```

Probado de punta a punta contra HSKChain: el saldo del oráculo pasó de 0 a 1000
unidades con la transacción [`0x4265a470…97df5`](https://testnet-explorer.hskchain.net/tx/0x4265a4702124b7da2cf719f251dc0f3d374040e86352127085b34739e9b97df5).

**Alcance honesto:** x402 prevé un *facilitator* que verifica y liquida por cuenta
del vendedor. En HSKChain no hay ninguno público, así que este servidor hace las dos
cosas. El formato del protocolo —los tres headers y los objetos que transportan— es
el del estándar. La liquidación on-chain requiere `X402_SETTLER_KEY`; sin esa
variable el pago se verifica igual y la respuesta lo dice explícitamente, en vez de
aparentar un cobro que no ocurrió.

## Bridge a USDC en Linea (HashKey Exchange)

Lo minado (HSK o BTC) se pasa a USDC a traves de HashKey Exchange. Hay dos partes,
separadas a proposito.

### Cotizar (en la web, con datos reales)

La tarjeta "Bridge a USDC en Linea" lee del exchange los precios de cada par y el
costo de retirar USDC (datos publicos, sin credenciales) y cotiza cuanto le queda a
cada socio. Precio, comisiones y costo del bridge se pueden editar.

La ruta real, segun lo que HashKey lista hoy:

```
BTC -> BTC/USDT -> USDT/USDC -> retiro de USDC por Ethereum -> bridge Ethereum a Linea
HSK -> HSK/USD  -> USDT/USD (compra) -> USDT/USDC -> retiro por Ethereum -> bridge a Linea
```

- **ETC no se puede**: HashKey Exchange no lo lista. BTC no tiene par contra USDC, asi
  que pasa por USDT.
- **HashKey no retira USDC a Linea**: sale por ERC20 (minimo 25 USDC, comision 1) y
  el ultimo tramo, de Ethereum a Linea, es un bridge aparte. Su costo no se consulta.
- La logica esta en `orchestrator/src/domain/bridge.ts` y `adapters/hashkeyMercado.ts`,
  en `bigint` como el resto del reparto: todo redondeo es hacia abajo y la cotizacion
  conserva el valor (`bruto = comision de venta + comision de retiro + neto`).

### Operar (script local, con tu clave)

```bash
cp .env.example .env         # completar HASHKEY_API_KEY, HASHKEY_API_SECRET y el tope

npm run hashkey -- mercado                     # precios, reglas y costos (sin clave)
npm run hashkey -- saldo                       # tus saldos
npm run hashkey -- probar  BTCUSDT SELL 0.001  # valida contra el exchange, no envia nada
npm run hashkey -- ordenar BTCUSDT SELL 0.001  # orden real: pide escribir CONFIRMAR
```

Por defecto corre contra el **sandbox**. Para operar con dinero real, `HASHKEY_ENV=production`.

Es un script local y no un endpoint de la web porque la web esta desplegada de forma
publica: un endpoint que operara con tu clave permitiria a cualquiera mover tu dinero.
`orchestrator/src/adapters/hashkeyCuenta.ts`, que firma y opera, no se exporta desde el
paquete y la web no puede importarlo.

Salvaguardas:

- Solo se aceptan las operaciones de la ruta (vender BTC, vender HSK, comprar USDT con
  USD, vender USDT por USDC). No se puede comprar BTC ni operar otro par.
- Las ordenes son `LIMIT IOC` a un precio protegido: nunca peor que el mejor precio del
  libro menos `HASHKEY_MAX_SLIPPAGE_BPS`. Se ejecutan al instante o se cancelan.
- `HASHKEY_MAX_ORDER_USD` es obligatorio y se mide con el mayor entre el precio limite y
  el de referencia.
- `ordenar` valida primero con `orderTest`, pide `CONFIRMAR` escrito y se niega a correr
  sin una terminal interactiva.
- No hay retiros: sacar fondos se hace desde la web de HashKey, a una direccion en whitelist.
- Crea la clave sin permiso de retiro.

**Cuentas retail:** `exchangeInfo` marca `retailAllowed: false` en los cuatro pares de la
ruta. Con una cuenta retail el exchange puede rechazar las ordenes; `probar` lo
comprueba sin arriesgar nada.

## Cadenas

| Red | Chain ID | RPC | Explorer |
|---|---|---|---|
| HSKChain Testnet | 133 | `https://testnet.hsk.xyz` | [Blockscout](https://testnet-explorer.hskchain.net) |
| HSKChain | 177 | `https://mainnet.hsk.xyz` | [Blockscout](https://hsk.blockscout.com) |

Safe v1.3.0 y v1.4.1 están desplegados en HSKChain testnet, junto con el deployer
CREATE2 y Multicall3.

> El documento de la hackathon indica `https://testnet.hsk.xyz` como RPC de mainnet.
> Es un error: ese endpoint responde chain ID 133 (testnet). El de mainnet, que
> responde 177, es `https://mainnet.hsk.xyz`.

## Alcance de la demostración

Los datos de hardware y telemetría son **simulados** y se editan desde la interfaz.
El cálculo del reparto, el hash de auditoría, la firma del multisig y los contratos
son **reales** y están verificados contra la cadena.
