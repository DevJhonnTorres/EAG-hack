// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {ISafe, ISafeProxyFactory} from "../src/interfaces/ISafe.sol";

/// @notice Despliega el baul de tesoreria del pool: un Gnosis Safe desde la factory oficial.
///
/// @dev No se programa una boveda a medida. Safe v1.4.1 ya esta desplegado en HSKChain y es
///      el estandar que audita la industria; reimplementar la custodia seria escribir el
///      codigo mas delicado del sistema desde cero, sin auditoria y en una semana.
///
///      La factory usa CREATE2, asi que la direccion del Safe depende solo de sus duenos, el
///      umbral y el salt. Con el mismo salt y los mismos duenos, cualquiera puede recalcular
///      la direccion y verificar que el baul es el que dice ser.
library SafeDeployer {
    ISafeProxyFactory internal constant FACTORY =
        ISafeProxyFactory(0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67);
    address internal constant SINGLETON = 0x41675C099F32341bf84BFc5382aF534df5C7461a;

    /// @dev Safe exige los duenos en orden ascendente y sin repetidos.
    function sortOwners(address[] memory owners) internal pure returns (address[] memory) {
        for (uint256 i = 1; i < owners.length; ++i) {
            address actual = owners[i];
            uint256 j = i;
            while (j > 0 && owners[j - 1] > actual) {
                owners[j] = owners[j - 1];
                --j;
            }
            owners[j] = actual;
        }
        for (uint256 i = 1; i < owners.length; ++i) {
            require(owners[i] != owners[i - 1], "SafeDeployer: dueno repetido");
        }
        return owners;
    }

    function deploy(address[] memory owners, uint256 threshold, uint256 saltNonce) internal returns (ISafe) {
        require(owners.length > 0, "SafeDeployer: sin duenos");
        require(threshold > 0 && threshold <= owners.length, "SafeDeployer: umbral invalido");
        require(SINGLETON.code.length > 0, "SafeDeployer: Safe no desplegado en esta cadena");

        bytes memory initializer = abi.encodeCall(
            ISafe.setup,
            (sortOwners(owners), threshold, address(0), "", address(0), address(0), 0, payable(address(0)))
        );

        return ISafe(FACTORY.createProxyWithNonce(SINGLETON, initializer, saltNonce));
    }
}

/// @notice Crea el baul de tesoreria.
///
/// @dev Ejemplo:
///        forge script script/DeploySafe.s.sol:DeploySafe --root contracts \
///          --rpc-url hsk_testnet --broadcast
contract DeploySafe is Script {
    function run() external returns (address safe) {
        address[] memory owners = vm.envAddress("SAFE_OWNERS", ",");
        uint256 threshold = vm.envOr("SAFE_THRESHOLD", uint256(owners.length));
        uint256 saltNonce = vm.envOr("SAFE_SALT_NONCE", uint256(0));

        vm.startBroadcast();
        safe = address(SafeDeployer.deploy(owners, threshold, saltNonce));
        vm.stopBroadcast();

        console.log("Baul de tesoreria  :", safe);
        console.log("Umbral de firmas   : %s de %s", threshold, owners.length);
        for (uint256 i = 0; i < owners.length; ++i) {
            console.log("  dueno            :", owners[i]);
        }
    }
}
