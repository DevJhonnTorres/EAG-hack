// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {PoolRegistry} from "../src/PoolRegistry.sol";
import {PoolSplitter} from "../src/PoolSplitter.sol";
import {AcceptingRecipient, RejectingRecipient} from "./Helpers.sol";

/// @dev Conduce al PoolSplitter como lo haria el Safe a lo largo de muchos periodos, con
///      montos y repartos aleatorios, y lleva su propia contabilidad paralela para poder
///      contrastarla contra el estado real del contrato.
contract SettlementHandler is Test {
    PoolSplitter public immutable splitter;
    PoolRegistry public immutable registry;

    address public immutable energyWallet;
    address public immutable maintenanceVault;
    address public immutable partnerA;
    address public immutable partnerB;

    /// @dev Total bruto que se ha hecho entrar al contrato en toda la campana.
    uint256 public totalSettledIn;
    /// @dev Cantidad de liquidaciones aceptadas.
    uint256 public settlementCount;
    /// @dev Ultimo periodo usado, para respetar el avance estrictamente creciente.
    uint256 public epochCursor;

    constructor(
        PoolSplitter splitter_,
        PoolRegistry registry_,
        address energyWallet_,
        address maintenanceVault_,
        address partnerA_,
        address partnerB_
    ) {
        splitter = splitter_;
        registry = registry_;
        energyWallet = energyWallet_;
        maintenanceVault = maintenanceVault_;
        partnerA = partnerA_;
        partnerB = partnerB_;
    }

    /// @notice Liquida un periodo con un reparto aleatorio pero aritmeticamente valido.
    function settle(uint96 energySeed, uint96 partnerASeed, uint96 partnerBSeed, uint8 epochJump) external {
        uint256 energy = bound(energySeed, 0, 50 ether);
        uint256 toA = bound(partnerASeed, 0, 50 ether);
        uint256 toB = bound(partnerBSeed, 0, 50 ether);

        uint256 rest = energy + toA + toB;
        if (rest == 0) return;

        uint16 bps = registry.maintenanceBps();
        uint256 gross = (rest * 10_000) / (10_000 - bps);
        uint256 maintenance = gross - rest;
        if (maintenance < (gross * bps) / 10_000) return;

        epochCursor += uint256(bound(epochJump, 1, 5));

        PoolSplitter.Payout[] memory payouts = new PoolSplitter.Payout[](4);
        payouts[0] = PoolSplitter.Payout(energyWallet, energy, PoolRegistry.Role.ENERGY);
        payouts[1] = PoolSplitter.Payout(maintenanceVault, maintenance, PoolRegistry.Role.MAINTENANCE);
        payouts[2] = PoolSplitter.Payout(partnerA, toA, PoolRegistry.Role.PARTNER);
        payouts[3] = PoolSplitter.Payout(partnerB, toB, PoolRegistry.Role.PARTNER);

        vm.deal(address(this), gross);
        splitter.settle{value: gross}(epochCursor, keccak256(abi.encode(epochCursor)), payouts);

        totalSettledIn += gross;
        settlementCount += 1;
    }

    /// @notice Un socio con pagos acreditados intenta retirar.
    function withdrawAsPartner(bool useA) external {
        address who = useA ? partnerA : partnerB;
        if (splitter.credits(who) == 0) return;
        vm.prank(who);
        splitter.withdraw();
    }

    /// @notice El Safe intenta barrer saldo no contabilizado.
    function sweep() external {
        if (address(splitter).balance <= splitter.totalCredited()) return;
        splitter.sweepUnaccounted();
    }

    receive() external payable {}
}

/// @notice Fuzzing con estado: encadena liquidaciones, retiros y barridos aleatorios y
///         verifica en cada paso que la contabilidad del protocolo siga cerrando.
contract PoolSplitterInvariantTest is Test {
    PoolRegistry internal registry;
    PoolSplitter internal splitter;
    SettlementHandler internal handler;

    address internal energyWallet;
    address internal maintenanceVault;
    address internal partnerA;
    address internal partnerB;

    function setUp() public {
        energyWallet = address(new AcceptingRecipient());
        maintenanceVault = address(new AcceptingRecipient());
        // Un socio acepta fondos y el otro los rechaza, para que el camino de credito
        // pendiente se ejercite de verdad durante la campana.
        partnerA = address(new AcceptingRecipient());
        partnerB = address(new RejectingRecipient());

        // El handler ocupa el lugar del Safe: es la autoridad que firma las liquidaciones.
        address predictedHandler = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 2);

        address[] memory partners = new address[](2);
        partners[0] = partnerA;
        partners[1] = partnerB;

        registry = new PoolRegistry(predictedHandler, energyWallet, maintenanceVault, 500, partners);
        splitter = new PoolSplitter(registry);
        handler =
            new SettlementHandler(splitter, registry, energyWallet, maintenanceVault, partnerA, partnerB);

        assertEq(address(handler), predictedHandler, "el handler debe ser el Safe del registro");

        targetContract(address(handler));
    }

    /// @notice La invariante economica central: todo el valor que entro al protocolo esta,
    ///         en todo momento, o bien en manos de sus destinatarios o bien retenido como
    ///         credito pendiente de retiro. Nunca se evapora ni se multiplica.
    function invariant_ElValorSeConserva() public view {
        uint256 enManosDeDestinatarios =
            energyWallet.balance + maintenanceVault.balance + partnerA.balance + partnerB.balance;

        assertEq(
            enManosDeDestinatarios + address(splitter).balance,
            handler.totalSettledIn(),
            "lo repartido mas lo retenido debe igualar todo lo que entro"
        );
    }

    /// @notice El Splitter es un conducto: solo puede retener lo que quedo acreditado por un
    ///         pago fallido, ni un wei mas.
    function invariant_ElSaldoRetenidoEsExactamenteLoAcreditado() public view {
        assertEq(
            address(splitter).balance,
            splitter.totalCredited(),
            "el contrato no debe retener valor sin acreditar"
        );
    }

    /// @notice La suma de los creditos individuales coincide con el total acreditado.
    function invariant_LosCreditosIndividualesCuadranConElTotal() public view {
        uint256 suma = splitter.credits(energyWallet) + splitter.credits(maintenanceVault)
            + splitter.credits(partnerA) + splitter.credits(partnerB);

        assertEq(suma, splitter.totalCredited(), "los creditos deben sumar el total");
    }

    /// @notice Los periodos nunca retroceden: es lo que hace imposible pagar dos veces el
    ///         mismo periodo.
    function invariant_LosPeriodosNuncaRetroceden() public view {
        assertLe(splitter.lastSettledEpoch(), handler.epochCursor(), "el periodo no puede adelantarse");
        if (handler.settlementCount() > 0) {
            assertGt(splitter.lastSettledEpoch(), 0, "tras liquidar, el periodo debe haber avanzado");
        }
    }

    /// @notice Cada periodo liquidado dejo su hash de telemetria anclado, que es lo que
    ///         permite a cualquier socio recalcular y auditar el reparto.
    function invariant_CadaLiquidacionDejaRastroAuditable() public view {
        uint256 epoch = splitter.lastSettledEpoch();
        if (epoch == 0) return;

        (bytes32 telemetryHash, uint256 gross,) = splitter.settlements(epoch);
        assertTrue(telemetryHash != bytes32(0), "toda liquidacion queda anclada a su telemetria");
        assertGt(gross, 0, "toda liquidacion registra su bruto");
    }
}
