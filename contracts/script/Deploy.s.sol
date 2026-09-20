// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {PoolRegistry} from "../src/PoolRegistry.sol";
import {PoolSplitter} from "../src/PoolSplitter.sol";

/// @notice Despliega el registro y el splitter de un micro-pool.
///
/// @dev Toda la configuracion llega por variables de entorno para que el mismo script sirva
///      en HSKChain, en Sepolia y en una cadena local sin editar una sola linea.
///
///      Ejemplo:
///        forge script script/Deploy.s.sol:Deploy \
///          --rpc-url hsk_testnet --broadcast --verify --verifier blockscout
contract Deploy is Script {
    function run() external returns (PoolRegistry registry, PoolSplitter splitter) {
        address safe = vm.envAddress("SAFE_ADDRESS");
        address energyWallet = vm.envAddress("ENERGY_WALLET");
        address maintenanceVault = vm.envAddress("MAINTENANCE_VAULT");
        uint16 maintenanceBps = uint16(vm.envUint("MAINTENANCE_BPS"));
        address[] memory partners = vm.envAddress("PARTNERS", ",");

        require(partners.length > 0, "Deploy: PARTNERS vacio");

        vm.startBroadcast();

        registry = new PoolRegistry(safe, energyWallet, maintenanceVault, maintenanceBps, partners);
        splitter = new PoolSplitter(registry);

        vm.stopBroadcast();

        console.log("Cadena             :", block.chainid);
        console.log("Safe (custodia)    :", safe);
        console.log("PoolRegistry       :", address(registry));
        console.log("PoolSplitter       :", address(splitter));
        console.log("Wallet de energia  :", energyWallet);
        console.log("Vault mantenimiento:", maintenanceVault);
        console.log("Reserva (bps)      :", maintenanceBps);
        console.log("Socios             :", partners.length);

        // Comprobacion de cordura: si el splitter no heredara el Safe del registro, la
        // separacion de poderes estaria rota desde el minuto cero y nadie lo notaria.
        require(splitter.safe() == safe, "Deploy: el splitter no quedo bajo el Safe esperado");
    }
}
