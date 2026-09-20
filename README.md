# HashPool

**Micro-pools de infraestructura: reparto de ganancias de minería auditable, verificado on-chain.**

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

```bash
npm run foundry
forge script script/Deploy.s.sol:Deploy --root contracts \
  --rpc-url hsk_testnet --broadcast --verify --verifier blockscout
```

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
