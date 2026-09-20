// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {PoolRegistry} from "../src/PoolRegistry.sol";
import {PoolSplitter} from "../src/PoolSplitter.sol";
import {AcceptingRecipient, GasBurner, RejectingRecipient} from "./Helpers.sol";

contract PoolSplitterTest is Test {
    PoolRegistry internal registry;
    PoolSplitter internal splitter;

    address internal safe = makeAddr("safe");
    address internal energyWallet = makeAddr("energyWallet");
    address internal maintenanceVault = makeAddr("maintenanceVault");
    address internal partnerA = makeAddr("partnerA");
    address internal partnerB = makeAddr("partnerB");
    address internal intruder = makeAddr("intruder");

    uint16 internal constant MAINTENANCE_BPS = 500; // 5%
    uint256 internal constant GROSS = 1 ether;
    bytes32 internal constant TELEMETRY = keccak256("telemetria-epoch-1");

    function setUp() public {
        address[] memory partners = new address[](2);
        partners[0] = partnerA;
        partners[1] = partnerB;

        registry = new PoolRegistry(safe, energyWallet, maintenanceVault, MAINTENANCE_BPS, partners);
        splitter = new PoolSplitter(registry);

        vm.deal(safe, 100 ether);
    }

    // --------------------------------------------------------------------
    // Construccion de repartos de prueba
    // --------------------------------------------------------------------

    /// @dev Reparto valido de referencia: 20% luz, 5% mantenimiento (el piso exacto),
    ///      y el resto 2:1 entre los socios.
    function _validPayouts() internal view returns (PoolSplitter.Payout[] memory payouts) {
        payouts = new PoolSplitter.Payout[](4);
        payouts[0] = PoolSplitter.Payout(energyWallet, 0.20 ether, PoolRegistry.Role.ENERGY);
        payouts[1] = PoolSplitter.Payout(maintenanceVault, 0.05 ether, PoolRegistry.Role.MAINTENANCE);
        payouts[2] = PoolSplitter.Payout(partnerA, 0.50 ether, PoolRegistry.Role.PARTNER);
        payouts[3] = PoolSplitter.Payout(partnerB, 0.25 ether, PoolRegistry.Role.PARTNER);
    }

    function _settle(uint256 epochId, PoolSplitter.Payout[] memory payouts, uint256 value) internal {
        vm.prank(safe);
        splitter.settle{value: value}(epochId, TELEMETRY, payouts);
    }

    // --------------------------------------------------------------------
    // Camino feliz
    // --------------------------------------------------------------------

    function test_Settle_PagaExactamenteACadaDestinatario() public {
        _settle(1, _validPayouts(), GROSS);

        assertEq(energyWallet.balance, 0.20 ether, "luz");
        assertEq(maintenanceVault.balance, 0.05 ether, "mantenimiento");
        assertEq(partnerA.balance, 0.50 ether, "socio A");
        assertEq(partnerB.balance, 0.25 ether, "socio B");
    }

    /// @notice El Splitter es un conducto, no una boveda: termina cada liquidacion en cero.
    function test_Settle_NoRetieneFondos() public {
        _settle(1, _validPayouts(), GROSS);
        assertEq(address(splitter).balance, 0, "el splitter no debe retener saldo");
    }

    function test_Settle_RegistraLaLiquidacionParaAuditoria() public {
        _settle(7, _validPayouts(), GROSS);

        (bytes32 telemetryHash, uint256 gross, uint64 settledAt) = splitter.settlements(7);
        assertEq(telemetryHash, TELEMETRY, "hash de telemetria anclado");
        assertEq(gross, GROSS, "bruto registrado");
        assertEq(settledAt, uint64(block.timestamp), "marca temporal");
        assertEq(splitter.lastSettledEpoch(), 7, "ultimo periodo");
    }

    function test_Settle_EmiteEventoDeLiquidacion() public {
        vm.expectEmit(true, true, false, true, address(splitter));
        emit PoolSplitter.SettlementExecuted(1, GROSS, TELEMETRY, 4);
        _settle(1, _validPayouts(), GROSS);
    }

    function test_Settle_PermiteSaltarPeriodos() public {
        _settle(1, _validPayouts(), GROSS);
        _settle(5, _validPayouts(), GROSS);
        assertEq(splitter.lastSettledEpoch(), 5);
    }

    /// @notice El caso que motiva todo el proyecto: un socio tuvo el equipo apagado el periodo
    ///         entero, no aporto hashrate y por lo tanto cobra cero. Es un reparto legitimo.
    function test_Settle_SocioApagadoCobraCero() public {
        PoolSplitter.Payout[] memory payouts = new PoolSplitter.Payout[](4);
        payouts[0] = PoolSplitter.Payout(energyWallet, 0.20 ether, PoolRegistry.Role.ENERGY);
        payouts[1] = PoolSplitter.Payout(maintenanceVault, 0.05 ether, PoolRegistry.Role.MAINTENANCE);
        payouts[2] = PoolSplitter.Payout(partnerA, 0.75 ether, PoolRegistry.Role.PARTNER);
        payouts[3] = PoolSplitter.Payout(partnerB, 0, PoolRegistry.Role.PARTNER);

        _settle(1, payouts, GROSS);

        assertEq(partnerA.balance, 0.75 ether, "socio activo se lleva el resto");
        assertEq(partnerB.balance, 0, "socio apagado no cobra");
        assertEq(address(splitter).balance, 0, "las cuentas cierran igual");
    }

    function test_Settle_MantenimientoPuedeSuperarElPiso() public {
        PoolSplitter.Payout[] memory payouts = _validPayouts();
        payouts[1].amount = 0.10 ether; // por encima del 5% exigido
        payouts[2].amount = 0.45 ether;

        _settle(1, payouts, GROSS);
        assertEq(maintenanceVault.balance, 0.10 ether);
    }

    // --------------------------------------------------------------------
    // Control de acceso
    // --------------------------------------------------------------------

    function test_RevertWhen_ElQueLiquidaNoEsElSafe() public {
        PoolSplitter.Payout[] memory payouts = _validPayouts();
        vm.deal(intruder, 10 ether);

        vm.prank(intruder);
        vm.expectRevert(abi.encodeWithSelector(PoolSplitter.NotSafe.selector, intruder));
        splitter.settle{value: GROSS}(1, TELEMETRY, payouts);
    }

    function test_SafeDelSplitterCoincideConElDelRegistro() public view {
        assertEq(splitter.safe(), registry.safe(), "separacion de poderes intacta");
    }

    // --------------------------------------------------------------------
    // Anti doble pago
    // --------------------------------------------------------------------

    function test_RevertWhen_SeRepiteElMismoPeriodo() public {
        _settle(1, _validPayouts(), GROSS);

        PoolSplitter.Payout[] memory payouts = _validPayouts();
        vm.prank(safe);
        vm.expectRevert(abi.encodeWithSelector(PoolSplitter.EpochNotIncreasing.selector, 1, 1));
        splitter.settle{value: GROSS}(1, TELEMETRY, payouts);
    }

    function test_RevertWhen_ElPeriodoRetrocede() public {
        _settle(5, _validPayouts(), GROSS);

        PoolSplitter.Payout[] memory payouts = _validPayouts();
        vm.prank(safe);
        vm.expectRevert(abi.encodeWithSelector(PoolSplitter.EpochNotIncreasing.selector, 4, 5));
        splitter.settle{value: GROSS}(4, TELEMETRY, payouts);
    }

    // --------------------------------------------------------------------
    // Invariantes de las cuentas
    // --------------------------------------------------------------------

    function test_RevertWhen_LasLineasSumanDeMas() public {
        PoolSplitter.Payout[] memory payouts = _validPayouts();
        payouts[2].amount = 0.60 ether; // suma 1.1 ether

        vm.prank(safe);
        vm.expectRevert(abi.encodeWithSelector(PoolSplitter.PayoutSumMismatch.selector, 1.1 ether, GROSS));
        splitter.settle{value: GROSS}(1, TELEMETRY, payouts);
    }

    function test_RevertWhen_LasLineasSumanDeMenos() public {
        PoolSplitter.Payout[] memory payouts = _validPayouts();
        payouts[2].amount = 0.50 ether - 1 wei; // falta exactamente un wei

        vm.prank(safe);
        vm.expectRevert(
            abi.encodeWithSelector(PoolSplitter.PayoutSumMismatch.selector, GROSS - 1 wei, GROSS)
        );
        splitter.settle{value: GROSS}(1, TELEMETRY, payouts);
    }

    function test_RevertWhen_ElMantenimientoNoAlcanzaElPiso() public {
        PoolSplitter.Payout[] memory payouts = _validPayouts();
        payouts[1].amount = 0.04 ether; // el piso es 0.05
        payouts[2].amount = 0.51 ether;

        vm.prank(safe);
        vm.expectRevert(
            abi.encodeWithSelector(PoolSplitter.MaintenanceBelowFloor.selector, 0.04 ether, 0.05 ether)
        );
        splitter.settle{value: GROSS}(1, TELEMETRY, payouts);
    }

    function test_RevertWhen_NoHayHashDeTelemetria() public {
        PoolSplitter.Payout[] memory payouts = _validPayouts();

        vm.prank(safe);
        vm.expectRevert(PoolSplitter.MissingTelemetryHash.selector);
        splitter.settle{value: GROSS}(1, bytes32(0), payouts);
    }

    function test_RevertWhen_NoSeEnviaValor() public {
        PoolSplitter.Payout[] memory payouts = _validPayouts();

        vm.prank(safe);
        vm.expectRevert(PoolSplitter.NoValueSent.selector);
        splitter.settle{value: 0}(1, TELEMETRY, payouts);
    }

    // --------------------------------------------------------------------
    // Allowlist de destinatarios
    // --------------------------------------------------------------------

    /// @notice La defensa central: aunque el middleware este comprometido, no puede inventar
    ///         una wallet de destino.
    function test_RevertWhen_ElDestinatarioNoEstaEnElRegistro() public {
        PoolSplitter.Payout[] memory payouts = _validPayouts();
        payouts[2].to = intruder;

        vm.prank(safe);
        vm.expectRevert(
            abi.encodeWithSelector(
                PoolSplitter.UnauthorizedRecipient.selector,
                intruder,
                PoolRegistry.Role.PARTNER,
                PoolRegistry.Role.NONE
            )
        );
        splitter.settle{value: GROSS}(1, TELEMETRY, payouts);
    }

    function test_RevertWhen_ElRolDeclaradoNoCoincideConElRegistrado() public {
        PoolSplitter.Payout[] memory payouts = _validPayouts();
        payouts[2].role = PoolRegistry.Role.MAINTENANCE; // partnerA se disfraza de vault

        vm.prank(safe);
        vm.expectRevert(
            abi.encodeWithSelector(
                PoolSplitter.UnauthorizedRecipient.selector,
                partnerA,
                PoolRegistry.Role.MAINTENANCE,
                PoolRegistry.Role.PARTNER
            )
        );
        splitter.settle{value: GROSS}(1, TELEMETRY, payouts);
    }

    function test_RevertWhen_UnDestinatarioSeRepite() public {
        PoolSplitter.Payout[] memory payouts = _validPayouts();
        payouts[3].to = partnerA; // partnerA cobrando dos veces

        vm.prank(safe);
        vm.expectRevert(abi.encodeWithSelector(PoolSplitter.DuplicateRecipient.selector, partnerA));
        splitter.settle{value: GROSS}(1, TELEMETRY, payouts);
    }

    // --------------------------------------------------------------------
    // Forma del reparto
    // --------------------------------------------------------------------

    function test_RevertWhen_FaltaElPagoDeEnergia() public {
        PoolSplitter.Payout[] memory payouts = new PoolSplitter.Payout[](3);
        payouts[0] = PoolSplitter.Payout(maintenanceVault, 0.05 ether, PoolRegistry.Role.MAINTENANCE);
        payouts[1] = PoolSplitter.Payout(partnerA, 0.60 ether, PoolRegistry.Role.PARTNER);
        payouts[2] = PoolSplitter.Payout(partnerB, 0.35 ether, PoolRegistry.Role.PARTNER);

        vm.prank(safe);
        vm.expectRevert(abi.encodeWithSelector(PoolSplitter.ExpectedExactlyOneEnergyPayout.selector, 0));
        splitter.settle{value: GROSS}(1, TELEMETRY, payouts);
    }

    function test_RevertWhen_FaltaElPagoDeMantenimiento() public {
        PoolSplitter.Payout[] memory payouts = new PoolSplitter.Payout[](3);
        payouts[0] = PoolSplitter.Payout(energyWallet, 0.20 ether, PoolRegistry.Role.ENERGY);
        payouts[1] = PoolSplitter.Payout(partnerA, 0.50 ether, PoolRegistry.Role.PARTNER);
        payouts[2] = PoolSplitter.Payout(partnerB, 0.30 ether, PoolRegistry.Role.PARTNER);

        vm.prank(safe);
        vm.expectRevert(abi.encodeWithSelector(PoolSplitter.ExpectedExactlyOneMaintenancePayout.selector, 0));
        splitter.settle{value: GROSS}(1, TELEMETRY, payouts);
    }

    /// @notice `NoPartnerPayouts` es defensa en profundidad: es inalcanzable mientras esten
    ///         activas las demas validaciones. Con un minimo de 3 lineas, exactamente una de
    ///         energia, exactamente una de mantenimiento y sin duplicados, la tercera linea
    ///         solo puede ser de un socio. Este test documenta ese razonamiento comprobando
    ///         que el intento de evadirlo choca antes contra el filtro de duplicados.
    function test_IntentarLiquidarSinSociosChocaContraElFiltroDeDuplicados() public {
        address[] memory partners = new address[](1);
        partners[0] = partnerA;
        PoolRegistry soloRegistry =
            new PoolRegistry(safe, energyWallet, maintenanceVault, MAINTENANCE_BPS, partners);
        PoolSplitter soloSplitter = new PoolSplitter(soloRegistry);

        PoolSplitter.Payout[] memory payouts = new PoolSplitter.Payout[](3);
        payouts[0] = PoolSplitter.Payout(energyWallet, 0.40 ether, PoolRegistry.Role.ENERGY);
        payouts[1] = PoolSplitter.Payout(maintenanceVault, 0.60 ether, PoolRegistry.Role.MAINTENANCE);
        payouts[2] = PoolSplitter.Payout(energyWallet, 0, PoolRegistry.Role.ENERGY);

        vm.prank(safe);
        vm.expectRevert(abi.encodeWithSelector(PoolSplitter.DuplicateRecipient.selector, energyWallet));
        soloSplitter.settle{value: GROSS}(1, TELEMETRY, payouts);
    }

    function test_RevertWhen_HayMenosDeTresLineas() public {
        PoolSplitter.Payout[] memory payouts = new PoolSplitter.Payout[](2);
        payouts[0] = PoolSplitter.Payout(energyWallet, 0.50 ether, PoolRegistry.Role.ENERGY);
        payouts[1] = PoolSplitter.Payout(maintenanceVault, 0.50 ether, PoolRegistry.Role.MAINTENANCE);

        vm.prank(safe);
        vm.expectRevert(abi.encodeWithSelector(PoolSplitter.TooFewPayouts.selector, 2));
        splitter.settle{value: GROSS}(1, TELEMETRY, payouts);
    }

    function test_RevertWhen_HayDemasiadasLineas() public {
        PoolSplitter.Payout[] memory payouts = new PoolSplitter.Payout[](19);

        vm.prank(safe);
        vm.expectRevert(abi.encodeWithSelector(PoolSplitter.TooManyPayouts.selector, 19, 18));
        splitter.settle{value: GROSS}(1, TELEMETRY, payouts);
    }

    // --------------------------------------------------------------------
    // Pagos fallidos: nadie bloquea a nadie
    // --------------------------------------------------------------------

    /// @notice Un socio con una wallet que rechaza fondos no puede impedir que los demas cobren.
    function test_PagoFallidoQuedaAcreditadoYNoBloqueaAlResto() public {
        RejectingRecipient hostil = new RejectingRecipient();

        address[] memory partners = new address[](2);
        partners[0] = address(hostil);
        partners[1] = partnerB;
        PoolRegistry reg = new PoolRegistry(safe, energyWallet, maintenanceVault, MAINTENANCE_BPS, partners);
        PoolSplitter spl = new PoolSplitter(reg);

        PoolSplitter.Payout[] memory payouts = new PoolSplitter.Payout[](4);
        payouts[0] = PoolSplitter.Payout(energyWallet, 0.20 ether, PoolRegistry.Role.ENERGY);
        payouts[1] = PoolSplitter.Payout(maintenanceVault, 0.05 ether, PoolRegistry.Role.MAINTENANCE);
        payouts[2] = PoolSplitter.Payout(address(hostil), 0.50 ether, PoolRegistry.Role.PARTNER);
        payouts[3] = PoolSplitter.Payout(partnerB, 0.25 ether, PoolRegistry.Role.PARTNER);

        vm.prank(safe);
        spl.settle{value: GROSS}(1, TELEMETRY, payouts);

        assertEq(partnerB.balance, 0.25 ether, "el socio sano cobra igual");
        assertEq(energyWallet.balance, 0.20 ether, "la luz se paga igual");
        assertEq(spl.credits(address(hostil)), 0.50 ether, "el pago fallido queda acreditado");
        assertEq(spl.totalCredited(), 0.50 ether);
        assertEq(address(spl).balance, 0.50 ether, "el contrato retiene solo lo acreditado");
    }

    /// @notice Un destinatario que quema gas tampoco puede tumbar la liquidacion: el
    ///         presupuesto de gas por pago lo contiene.
    function test_DestinatarioQueQuemaGasNoTumbaLaLiquidacion() public {
        GasBurner burner = new GasBurner();

        address[] memory partners = new address[](2);
        partners[0] = address(burner);
        partners[1] = partnerB;
        PoolRegistry reg = new PoolRegistry(safe, energyWallet, maintenanceVault, MAINTENANCE_BPS, partners);
        PoolSplitter spl = new PoolSplitter(reg);

        PoolSplitter.Payout[] memory payouts = new PoolSplitter.Payout[](4);
        payouts[0] = PoolSplitter.Payout(energyWallet, 0.20 ether, PoolRegistry.Role.ENERGY);
        payouts[1] = PoolSplitter.Payout(maintenanceVault, 0.05 ether, PoolRegistry.Role.MAINTENANCE);
        payouts[2] = PoolSplitter.Payout(address(burner), 0.50 ether, PoolRegistry.Role.PARTNER);
        payouts[3] = PoolSplitter.Payout(partnerB, 0.25 ether, PoolRegistry.Role.PARTNER);

        vm.prank(safe);
        spl.settle{value: GROSS}(1, TELEMETRY, payouts);

        assertEq(partnerB.balance, 0.25 ether, "el resto del pool cobra");
        assertEq(spl.credits(address(burner)), 0.50 ether, "el hostil queda acreditado");
    }

    function test_RetiroDeUnPagoAcreditado() public {
        AcceptingRecipient wallet = new AcceptingRecipient();

        address[] memory partners = new address[](2);
        partners[0] = partnerA;
        partners[1] = partnerB;
        PoolRegistry reg = new PoolRegistry(safe, energyWallet, maintenanceVault, MAINTENANCE_BPS, partners);
        PoolSplitter spl = new PoolSplitter(reg);

        // Se acredita a partnerA forzando el fallo con una wallet que rechaza, y luego se
        // comprueba el retiro desde una cuenta que si acepta fondos.
        vm.etch(partnerA, address(new RejectingRecipient()).code);

        PoolSplitter.Payout[] memory payouts = new PoolSplitter.Payout[](4);
        payouts[0] = PoolSplitter.Payout(energyWallet, 0.20 ether, PoolRegistry.Role.ENERGY);
        payouts[1] = PoolSplitter.Payout(maintenanceVault, 0.05 ether, PoolRegistry.Role.MAINTENANCE);
        payouts[2] = PoolSplitter.Payout(partnerA, 0.50 ether, PoolRegistry.Role.PARTNER);
        payouts[3] = PoolSplitter.Payout(partnerB, 0.25 ether, PoolRegistry.Role.PARTNER);

        vm.prank(safe);
        spl.settle{value: GROSS}(1, TELEMETRY, payouts);
        assertEq(spl.credits(partnerA), 0.50 ether);

        // El socio corrige su wallet y retira.
        vm.etch(partnerA, address(wallet).code);
        vm.prank(partnerA);
        spl.withdraw();

        assertEq(partnerA.balance, 0.50 ether, "retiro completo");
        assertEq(spl.credits(partnerA), 0, "credito consumido");
        assertEq(spl.totalCredited(), 0);
        assertEq(address(spl).balance, 0, "el contrato vuelve a cero");
    }

    function test_RevertWhen_SeRetiraSinCreditoPendiente() public {
        vm.prank(partnerA);
        vm.expectRevert(abi.encodeWithSelector(PoolSplitter.NothingToWithdraw.selector, partnerA));
        splitter.withdraw();
    }

    // --------------------------------------------------------------------
    // Saneamiento
    // --------------------------------------------------------------------

    function test_RevertWhen_SeDepositaDirectamente() public {
        vm.deal(intruder, 1 ether);
        vm.prank(intruder);
        (bool success, bytes memory data) = address(splitter).call{value: 1 ether}("");
        assertFalse(success, "el deposito suelto debe rechazarse");
        assertEq(bytes4(data), PoolSplitter.DirectDepositNotAllowed.selector);
    }

    function test_SweepDevuelveAlSafeElSaldoForzado() public {
        // Modela ETH forzado al contrato (selfdestruct o recompensa de bloque).
        vm.deal(address(splitter), 3 ether);
        uint256 safeBalanceBefore = safe.balance;

        vm.prank(safe);
        splitter.sweepUnaccounted();

        assertEq(safe.balance, safeBalanceBefore + 3 ether, "vuelve al Safe");
        assertEq(address(splitter).balance, 0);
    }

    /// @notice El barrido nunca puede tocar el dinero que un socio tiene pendiente de retiro.
    function test_SweepNoTocaLosCreditosPendientes() public {
        RejectingRecipient hostil = new RejectingRecipient();
        address[] memory partners = new address[](2);
        partners[0] = address(hostil);
        partners[1] = partnerB;
        PoolRegistry reg = new PoolRegistry(safe, energyWallet, maintenanceVault, MAINTENANCE_BPS, partners);
        PoolSplitter spl = new PoolSplitter(reg);

        PoolSplitter.Payout[] memory payouts = new PoolSplitter.Payout[](4);
        payouts[0] = PoolSplitter.Payout(energyWallet, 0.20 ether, PoolRegistry.Role.ENERGY);
        payouts[1] = PoolSplitter.Payout(maintenanceVault, 0.05 ether, PoolRegistry.Role.MAINTENANCE);
        payouts[2] = PoolSplitter.Payout(address(hostil), 0.50 ether, PoolRegistry.Role.PARTNER);
        payouts[3] = PoolSplitter.Payout(partnerB, 0.25 ether, PoolRegistry.Role.PARTNER);

        vm.prank(safe);
        spl.settle{value: GROSS}(1, TELEMETRY, payouts);

        // Llega saldo forzado ademas del credito pendiente.
        vm.deal(address(spl), 0.50 ether + 2 ether);

        vm.prank(safe);
        spl.sweepUnaccounted();

        assertEq(address(spl).balance, 0.50 ether, "el credito del socio sigue intacto");
        assertEq(spl.credits(address(hostil)), 0.50 ether);
    }

    function test_RevertWhen_SweepSinSaldoLibre() public {
        vm.prank(safe);
        vm.expectRevert(PoolSplitter.NothingToSweep.selector);
        splitter.sweepUnaccounted();
    }

    function test_RevertWhen_SweepLoLlamaAlguienQueNoEsElSafe() public {
        vm.deal(address(splitter), 1 ether);
        vm.prank(intruder);
        vm.expectRevert(abi.encodeWithSelector(PoolSplitter.NotSafe.selector, intruder));
        splitter.sweepUnaccounted();
    }

    // --------------------------------------------------------------------
    // Fuzzing: conservacion del valor
    // --------------------------------------------------------------------

    /// @notice La invariante economica del protocolo, probada contra miles de repartos
    ///         aleatorios: lo que entra es exactamente lo que sale. Ni un wei se crea ni se
    ///         pierde, sin importar como se distribuya.
    function testFuzz_ConservacionDelValor(uint96 energyAmount, uint96 partnerAAmount, uint96 partnerBAmount)
        public
    {
        // El mantenimiento se fija en el piso exacto y el resto se reparte libremente.
        uint256 energy = bound(energyAmount, 0, 10 ether);
        uint256 toA = bound(partnerAAmount, 0, 10 ether);
        uint256 toB = bound(partnerBAmount, 0, 10 ether);

        // Se despeja el bruto tal que mantenimiento == 5% del bruto y las lineas cierran:
        //   gross = energy + toA + toB + gross * bps / 10000
        // => gross = (energy + toA + toB) * 10000 / (10000 - bps)
        uint256 rest = energy + toA + toB;
        vm.assume(rest > 0);
        uint256 gross = (rest * 10_000) / (10_000 - MAINTENANCE_BPS);
        uint256 maintenance = gross - rest;
        vm.assume(maintenance >= (gross * MAINTENANCE_BPS) / 10_000);

        PoolSplitter.Payout[] memory payouts = new PoolSplitter.Payout[](4);
        payouts[0] = PoolSplitter.Payout(energyWallet, energy, PoolRegistry.Role.ENERGY);
        payouts[1] = PoolSplitter.Payout(maintenanceVault, maintenance, PoolRegistry.Role.MAINTENANCE);
        payouts[2] = PoolSplitter.Payout(partnerA, toA, PoolRegistry.Role.PARTNER);
        payouts[3] = PoolSplitter.Payout(partnerB, toB, PoolRegistry.Role.PARTNER);

        vm.deal(safe, gross);
        vm.prank(safe);
        splitter.settle{value: gross}(1, TELEMETRY, payouts);

        assertEq(
            energyWallet.balance + maintenanceVault.balance + partnerA.balance + partnerB.balance,
            gross,
            "la suma de lo recibido debe igualar exactamente el bruto"
        );
        assertEq(address(splitter).balance, 0, "el splitter no retiene nada");
    }

    /// @notice Cualquier reparto cuya suma no sea exactamente el bruto es rechazado.
    function testFuzz_RechazaTodaSumaQueNoCuadre(uint96 delta) public {
        vm.assume(delta > 0);
        PoolSplitter.Payout[] memory payouts = _validPayouts();
        payouts[2].amount = uint256(0.50 ether) + uint256(delta);

        uint256 expectedSum = GROSS + uint256(delta);

        vm.prank(safe);
        vm.expectRevert(abi.encodeWithSelector(PoolSplitter.PayoutSumMismatch.selector, expectedSum, GROSS));
        splitter.settle{value: GROSS}(1, TELEMETRY, payouts);
    }
}
