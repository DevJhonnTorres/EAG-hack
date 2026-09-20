// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {PoolCredit} from "../src/PoolCredit.sol";

/// @notice Despliega el token de credito operativo con el que el agente paga sus insumos.
contract DeployCredit is Script {
    function run() external returns (PoolCredit token) {
        address agente = vm.envAddress("X402_AGENT");
        uint256 supply = vm.envOr("X402_SUPPLY", uint256(1_000_000e6));

        vm.startBroadcast();
        token = new PoolCredit(agente, supply);
        vm.stopBroadcast();

        console.log("PoolCredit :", address(token));
        console.log("Agente     :", agente);
        console.log("Supply     :", supply);
    }
}
