// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {PoolRegistry} from "../../src/PoolRegistry.sol";
import {PoolSplitter} from "../../src/PoolSplitter.sol";
import {ISafe, ISafeProxyFactory} from "../../src/interfaces/ISafe.sol";

/// @notice Genera el fixture que verifica la firma EIP-712 del orquestador.
///
/// @dev El orquestador tiene que calcular, en TypeScript, exactamente el mismo hash que el
///      contrato de Safe calcula en Solidity. Si difieren, los socios firman un hash que el
///      Safe no reconoce y la liquidacion no se puede ejecutar; peor aun, el error solo
///      aparece en el momento de ejecutar, que en una demostracion es el peor momento posible.
///
///      En vez de confiar en que ambas implementaciones coinciden, este test le pregunta el
///      hash al Safe real desplegado en HSKChain y lo guarda en un fixture. La suite de Jest
///      lo lee y comprueba que su implementacion produce el mismo valor.
///
///      Regenerar:
///        HSK_TESTNET_RPC=https://testnet.hsk.xyz \
///        forge test --root contracts --match-contract SafeTxHashFixture
contract SafeTxHashFixtureTest is Test {
    ISafeProxyFactory internal constant SAFE_FACTORY =
        ISafeProxyFactory(0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67);
    address internal constant SAFE_SINGLETON = 0x41675C099F32341bf84BFc5382aF534df5C7461a;

    address internal constant OWNER_A = 0x1111111111111111111111111111111111111111;
    address internal constant OWNER_B = 0x2222222222222222222222222222222222222222;

    address internal constant ENERGY_WALLET = 0x3333333333333333333333333333333333333333;
    address internal constant MAINTENANCE_VAULT = 0x4444444444444444444444444444444444444444;
    address internal constant PARTNER_A = 0x5555555555555555555555555555555555555555;
    address internal constant PARTNER_B = 0x6666666666666666666666666666666666666666;

    function test_GeneraFixtureDeHashDeFirma() public {
        string memory rpc = vm.envOr("HSK_TESTNET_RPC", string(""));
        if (bytes(rpc).length == 0) return;

        vm.createSelectFork(rpc);

        address[] memory owners = new address[](2);
        owners[0] = OWNER_A;
        owners[1] = OWNER_B;

        bytes memory initializer =
            abi.encodeCall(ISafe.setup, (owners, 2, address(0), "", address(0), address(0), 0, payable(address(0))));

        // Salt fijo: el Safe queda en una direccion determinista, asi que el fixture es
        // reproducible por cualquiera que corra este test.
        ISafe safe = ISafe(SAFE_FACTORY.createProxyWithNonce(SAFE_SINGLETON, initializer, 0));

        address[] memory partners = new address[](2);
        partners[0] = PARTNER_A;
        partners[1] = PARTNER_B;
        PoolRegistry registry = new PoolRegistry(address(safe), ENERGY_WALLET, MAINTENANCE_VAULT, 500, partners);
        PoolSplitter splitter = new PoolSplitter(registry);

        PoolSplitter.Payout[] memory payouts = new PoolSplitter.Payout[](4);
        payouts[0] = PoolSplitter.Payout(ENERGY_WALLET, 0.2 ether, PoolRegistry.Role.ENERGY);
        payouts[1] = PoolSplitter.Payout(MAINTENANCE_VAULT, 0.05 ether, PoolRegistry.Role.MAINTENANCE);
        payouts[2] = PoolSplitter.Payout(PARTNER_A, 0.5 ether, PoolRegistry.Role.PARTNER);
        payouts[3] = PoolSplitter.Payout(PARTNER_B, 0.25 ether, PoolRegistry.Role.PARTNER);

        bytes32 telemetryHash = keccak256("telemetria-fixture");
        bytes memory data = abi.encodeCall(PoolSplitter.settle, (1, telemetryHash, payouts));
        uint256 value = 1 ether;

        bytes32 safeTxHash =
            safe.getTransactionHash(address(splitter), value, data, 0, 0, 0, 0, address(0), address(0), 0);

        string memory json = "fixture";
        vm.serializeUint(json, "chainId", block.chainid);
        vm.serializeAddress(json, "safeAddress", address(safe));
        vm.serializeAddress(json, "to", address(splitter));
        vm.serializeUint(json, "value", value);
        vm.serializeBytes(json, "data", data);
        vm.serializeUint(json, "operation", 0);
        vm.serializeUint(json, "safeTxGas", 0);
        vm.serializeUint(json, "baseGas", 0);
        vm.serializeUint(json, "gasPrice", 0);
        vm.serializeAddress(json, "gasToken", address(0));
        vm.serializeAddress(json, "refundReceiver", address(0));
        vm.serializeUint(json, "nonce", 0);
        string memory salida = vm.serializeBytes32(json, "expectedSafeTxHash", safeTxHash);

        vm.writeJson(salida, "../fixtures/safe-tx-hash.json");

        assertTrue(safeTxHash != bytes32(0), "el Safe debe producir un hash");
    }
}
