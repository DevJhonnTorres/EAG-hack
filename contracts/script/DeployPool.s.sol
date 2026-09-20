// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {PoolRegistry} from "../src/PoolRegistry.sol";
import {PoolSplitter} from "../src/PoolSplitter.sol";
import {ISafe} from "../src/interfaces/ISafe.sol";
import {SafeDeployer} from "./DeploySafe.s.sol";

/// @notice Despliega el micro-pool completo en una sola transaccion por contrato.
///
/// @dev Crea, en orden: el baul de tesoreria, el vault del fondo de mantenimiento, el registro
///      de destinatarios y el splitter.
///
///      Sobre el vault de mantenimiento: por defecto se despliega como un **segundo Safe con
///      los mismos duenos**. La alternativa obvia seria apuntarlo al baul principal, pero
///      entonces la reserva de mantenimiento quedaria mezclada con las ganancias sin repartir
///      y nadie podria distinguirlas, que es exactamente el problema de cuentas turbias que
///      el proyecto viene a resolver. Un Safe aparte mantiene el fondo separado y auditable,
///      bajo el control de los mismos socios, y sin que nadie tenga que custodiar una clave
///      privada nueva.
///
///      Ambos comportamientos son configurables: si SAFE_ADDRESS o MAINTENANCE_VAULT vienen
///      definidos, se usan esos en vez de desplegar.
contract DeployPool is Script {
    struct Despliegue {
        address safe;
        address maintenanceVault;
        PoolRegistry registry;
        PoolSplitter splitter;
    }

    function run() external returns (Despliegue memory despliegue) {
        address[] memory owners = vm.envAddress("SAFE_OWNERS", ",");
        uint256 threshold = vm.envOr("SAFE_THRESHOLD", uint256(owners.length));
        uint256 saltNonce = vm.envOr("SAFE_SALT_NONCE", uint256(0));

        address energyWallet = vm.envAddress("ENERGY_WALLET");
        address[] memory partners = vm.envAddress("PARTNERS", ",");
        uint16 maintenanceBps = uint16(vm.envOr("MAINTENANCE_BPS", uint256(500)));

        address safeExistente = vm.envOr("SAFE_ADDRESS", address(0));
        address vaultExistente = vm.envOr("MAINTENANCE_VAULT", address(0));

        vm.startBroadcast();

        despliegue.safe = safeExistente != address(0)
            ? safeExistente
            : address(SafeDeployer.deploy(owners, threshold, saltNonce));

        // Salt distinto: mismos duenos y mismo umbral, pero otra direccion.
        despliegue.maintenanceVault = vaultExistente != address(0)
            ? vaultExistente
            : address(SafeDeployer.deploy(owners, threshold, saltNonce + 1));

        despliegue.registry = new PoolRegistry(
            despliegue.safe, energyWallet, despliegue.maintenanceVault, maintenanceBps, partners
        );
        despliegue.splitter = new PoolSplitter(despliegue.registry);

        vm.stopBroadcast();

        _verificar(despliegue, energyWallet, partners, maintenanceBps);
        _reportar(despliegue, energyWallet, partners, maintenanceBps, threshold, owners);
    }

    /// @dev Comprobaciones de cordura sobre el despliegue ya hecho. Un pool mal cableado
    ///      funciona en apariencia hasta la primera liquidacion, que es el peor momento para
    ///      descubrirlo.
    function _verificar(
        Despliegue memory despliegue,
        address energyWallet,
        address[] memory partners,
        uint16 maintenanceBps
    ) internal view {
        require(
            despliegue.splitter.safe() == despliegue.safe, "DeployPool: el splitter no quedo bajo el baul"
        );
        require(
            address(despliegue.splitter.registry()) == address(despliegue.registry),
            "DeployPool: registro mal cableado"
        );
        require(despliegue.registry.maintenanceBps() == maintenanceBps, "DeployPool: reserva mal configurada");
        require(
            despliegue.registry.roleOf(energyWallet) == PoolRegistry.Role.ENERGY,
            "DeployPool: wallet de luz sin rol"
        );
        require(
            despliegue.registry.roleOf(despliegue.maintenanceVault) == PoolRegistry.Role.MAINTENANCE,
            "DeployPool: vault sin rol"
        );
        for (uint256 i = 0; i < partners.length; ++i) {
            require(despliegue.registry.isPartner(partners[i]), "DeployPool: socio no registrado");
        }
        require(despliegue.registry.partnerCount() == partners.length, "DeployPool: cantidad de socios");
    }

    function _reportar(
        Despliegue memory despliegue,
        address energyWallet,
        address[] memory partners,
        uint16 maintenanceBps,
        uint256 threshold,
        address[] memory owners
    ) internal pure {
        console.log("");
        console.log("=== Micro-pool desplegado ===");
        console.log("Baul de tesoreria  :", despliegue.safe);
        console.log("Vault mantenimiento:", despliegue.maintenanceVault);
        console.log("PoolRegistry       :", address(despliegue.registry));
        console.log("PoolSplitter       :", address(despliegue.splitter));
        console.log("Wallet de la luz   :", energyWallet);
        console.log("Reserva (bps)      :", maintenanceBps);
        console.log("Firmas necesarias  : %s de %s", threshold, owners.length);
        for (uint256 i = 0; i < partners.length; ++i) {
            console.log("Socio              :", partners[i]);
        }
    }
}
