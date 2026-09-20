// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {PoolRegistry} from "../../src/PoolRegistry.sol";
import {PoolSplitter} from "../../src/PoolSplitter.sol";
import {ISafe, ISafeProxyFactory} from "../../src/interfaces/ISafe.sol";

/// @notice Prueba de integracion contra un Gnosis Safe real, sobre un fork de HSKChain testnet.
///
/// @dev Los tests unitarios simulan al Safe con `vm.prank`. Esta suite no simula nada: usa los
///      contratos de Safe efectivamente desplegados en la cadena de la hackathon, despliega un
///      Safe nuevo desde su factory oficial, firma la liquidacion con claves reales y la ejecuta
///      via `execTransaction`. Es lo que demuestra que el flujo completo funciona en la cadena
///      donde se va a hacer la demostracion, y no solo en el entorno de pruebas.
///
///      Se omite sola si no hay RPC configurado, para que la suite corra igual sin red.
contract SafeIntegrationForkTest is Test {
    /// @dev Direcciones canonicas de Safe v1.4.1, verificadas como presentes en HSKChain testnet.
    ISafeProxyFactory internal constant SAFE_FACTORY =
        ISafeProxyFactory(0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67);
    address internal constant SAFE_SINGLETON = 0x41675C099F32341bf84BFc5382aF534df5C7461a;

    uint256 internal constant HSK_TESTNET_CHAIN_ID = 133;

    ISafe internal safe;
    PoolRegistry internal registry;
    PoolSplitter internal splitter;

    uint256 internal ownerAKey = 0xA11CE;
    uint256 internal ownerBKey = 0xB0B;
    address internal ownerA;
    address internal ownerB;

    address internal energyWallet = makeAddr("energyWallet");
    address internal maintenanceVault = makeAddr("maintenanceVault");
    address internal partnerA = makeAddr("partnerA");
    address internal partnerB = makeAddr("partnerB");

    bool internal forked;

    function setUp() public {
        string memory rpc = vm.envOr("HSK_TESTNET_RPC", string(""));
        if (bytes(rpc).length == 0) return;

        vm.createSelectFork(rpc);
        forked = true;

        assertEq(block.chainid, HSK_TESTNET_CHAIN_ID, "el fork debe apuntar a HSKChain testnet");
        assertGt(SAFE_SINGLETON.code.length, 0, "Safe singleton presente en la cadena");
        assertGt(address(SAFE_FACTORY).code.length, 0, "Safe factory presente en la cadena");

        ownerA = vm.addr(ownerAKey);
        ownerB = vm.addr(ownerBKey);

        safe = _deploySafe();

        address[] memory partners = new address[](2);
        partners[0] = partnerA;
        partners[1] = partnerB;

        registry = new PoolRegistry(address(safe), energyWallet, maintenanceVault, 500, partners);
        splitter = new PoolSplitter(registry);

        vm.deal(address(safe), 100 ether);
    }

    /// @dev Despliega un Safe 2-de-2 desde la factory oficial de la cadena.
    function _deploySafe() internal returns (ISafe) {
        address[] memory owners = new address[](2);
        // Safe exige los duenos en orden ascendente.
        (owners[0], owners[1]) = ownerA < ownerB ? (ownerA, ownerB) : (ownerB, ownerA);

        bytes memory initializer = abi.encodeCall(
            ISafe.setup, (owners, 2, address(0), "", address(0), address(0), 0, payable(address(0)))
        );

        return ISafe(SAFE_FACTORY.createProxyWithNonce(SAFE_SINGLETON, initializer, uint256(block.timestamp)));
    }

    /// @dev Firma la transaccion del Safe con ambos duenos.
    ///      Safe exige las firmas concatenadas en orden ascendente de direccion.
    function _sign(address to, uint256 value, bytes memory data) internal view returns (bytes memory) {
        bytes32 txHash =
            safe.getTransactionHash(to, value, data, 0, 0, 0, 0, address(0), address(0), safe.nonce());

        (uint8 v1, bytes32 r1, bytes32 s1) = vm.sign(ownerAKey, txHash);
        (uint8 v2, bytes32 r2, bytes32 s2) = vm.sign(ownerBKey, txHash);

        return
            ownerA < ownerB
                ? abi.encodePacked(r1, s1, v1, r2, s2, v2)
                : abi.encodePacked(r2, s2, v2, r1, s1, v1);
    }

    function _execThroughSafe(address to, uint256 value, bytes memory data) internal returns (bool) {
        return safe.execTransaction(
            to, value, data, 0, 0, 0, 0, address(0), payable(address(0)), _sign(to, value, data)
        );
    }

    function _payouts() internal view returns (PoolSplitter.Payout[] memory payouts) {
        payouts = new PoolSplitter.Payout[](4);
        payouts[0] = PoolSplitter.Payout(energyWallet, 0.2 ether, PoolRegistry.Role.ENERGY);
        payouts[1] = PoolSplitter.Payout(maintenanceVault, 0.05 ether, PoolRegistry.Role.MAINTENANCE);
        payouts[2] = PoolSplitter.Payout(partnerA, 0.5 ether, PoolRegistry.Role.PARTNER);
        payouts[3] = PoolSplitter.Payout(partnerB, 0.25 ether, PoolRegistry.Role.PARTNER);
    }

    /// @notice El flujo completo tal como ocurrira en la demostracion: dos socios firman con su
    ///         multisig y los fondos salen del Safe repartidos en una sola transaccion.
    function test_Fork_LiquidacionCompletaFirmadaPorElMultisig() public {
        if (!forked) return;

        bytes memory data =
            abi.encodeCall(PoolSplitter.settle, (1, keccak256("telemetria-semana-1"), _payouts()));

        uint256 safeBalanceBefore = address(safe).balance;
        bool success = _execThroughSafe(address(splitter), 1 ether, data);

        assertTrue(success, "la transaccion del Safe debe ejecutarse");
        assertEq(address(safe).balance, safeBalanceBefore - 1 ether, "el Safe entrego el bruto");
        assertEq(energyWallet.balance, 0.2 ether, "luz pagada");
        assertEq(maintenanceVault.balance, 0.05 ether, "mantenimiento reservado");
        assertEq(partnerA.balance, 0.5 ether, "socio A cobro");
        assertEq(partnerB.balance, 0.25 ether, "socio B cobro");
        assertEq(address(splitter).balance, 0, "el splitter no retiene nada");

        (bytes32 telemetryHash,,) = splitter.settlements(1);
        assertEq(telemetryHash, keccak256("telemetria-semana-1"), "telemetria anclada en la cadena");
    }

    /// @notice Sin las firmas suficientes no hay liquidacion: es la garantia de que un solo
    ///         socio no puede mover los fondos del pool por su cuenta.
    function test_Fork_UnSoloSocioNoPuedeLiquidar() public {
        if (!forked) return;

        bytes memory data =
            abi.encodeCall(PoolSplitter.settle, (1, keccak256("telemetria-semana-1"), _payouts()));

        bytes32 txHash = safe.getTransactionHash(
            address(splitter), 1 ether, data, 0, 0, 0, 0, address(0), address(0), safe.nonce()
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerAKey, txHash);
        bytes memory soloUnaFirma = abi.encodePacked(r, s, v);

        vm.expectRevert();
        safe.execTransaction(
            address(splitter), 1 ether, data, 0, 0, 0, 0, address(0), payable(address(0)), soloUnaFirma
        );
    }

    /// @notice Aunque el middleware este comprometido y proponga un reparto hacia una direccion
    ///         ajena, y aunque consiga las firmas, la cadena lo rechaza.
    function test_Fork_ElContratoRechazaUnDestinatarioNoAutorizado() public {
        if (!forked) return;

        address atacante = makeAddr("atacante");
        PoolSplitter.Payout[] memory payouts = _payouts();
        payouts[2].to = atacante;

        bytes memory data = abi.encodeCall(PoolSplitter.settle, (1, keccak256("telemetria"), payouts));
        bytes memory signatures = _sign(address(splitter), 1 ether, data);

        // Con safeTxGas y gasPrice en cero, Safe propaga el fallo de la llamada interna como
        // un revert (GS013) en vez de devolver false. Eso es justamente lo que se quiere: la
        // transaccion entera se deshace y el Safe no queda con el nonce consumido en vano.
        vm.expectRevert(bytes("GS013"));
        safe.execTransaction(
            address(splitter), 1 ether, data, 0, 0, 0, 0, address(0), payable(address(0)), signatures
        );

        assertEq(atacante.balance, 0, "el atacante no recibe nada");
        assertEq(splitter.lastSettledEpoch(), 0, "no quedo ninguna liquidacion registrada");
    }

    /// @notice El mismo periodo no se puede liquidar dos veces, ni siquiera con firmas validas.
    function test_Fork_NoSePuedeLiquidarDosVecesElMismoPeriodo() public {
        if (!forked) return;

        bytes memory data = abi.encodeCall(PoolSplitter.settle, (1, keccak256("telemetria"), _payouts()));

        assertTrue(_execThroughSafe(address(splitter), 1 ether, data), "primera liquidacion");

        // El reintento lleva firmas validas y frescas, pero el contrato ya no acepta ese periodo.
        bytes memory signatures = _sign(address(splitter), 1 ether, data);
        vm.expectRevert(bytes("GS013"));
        safe.execTransaction(
            address(splitter), 1 ether, data, 0, 0, 0, 0, address(0), payable(address(0)), signatures
        );

        assertEq(partnerA.balance, 0.5 ether, "el socio cobro una sola vez");
    }
}
