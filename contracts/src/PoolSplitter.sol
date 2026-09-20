// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {PoolRegistry} from "./PoolRegistry.sol";

/// @title PoolSplitter
/// @notice Ejecuta y audita la liquidacion periodica de un micro-pool de mineria.
///
/// @dev Reparto de responsabilidades del protocolo:
///
///        - El middleware CALCULA. Lee la telemetria de cada equipo y propone un reparto.
///          Es codigo off-chain: barato de cambiar y facil de testear, pero no confiable.
///        - El Safe APRUEBA. Los socios firman la liquidacion con su multisig. Es la
///          autoridad humana y la unica custodia de los fondos.
///        - Este contrato VERIFICA. No confia en el numero que le llega: exige que las
///          cuentas cierren al wei antes de mover un solo token.
///
///      El contrato no es una boveda. Recibe el valor en la misma transaccion que lo
///      distribuye y termina con saldo cero, salvo por los pagos que hayan fallado y
///      queden acreditados para retiro. Los fondos viven en el Safe, no aca.
contract PoolSplitter {
    /// @notice Una linea del reparto de un periodo.
    struct Payout {
        address to;
        uint256 amount;
        PoolRegistry.Role role;
    }

    /// @notice Registro inmutable de una liquidacion ya ejecutada.
    struct Settlement {
        bytes32 telemetryHash;
        uint256 gross;
        uint64 settledAt;
    }

    /// @notice Tope de lineas por liquidacion: MAX_PARTNERS socios + energia + mantenimiento.
    uint256 public constant MAX_PAYOUTS = 18;

    /// @notice Gas concedido a cada pago.
    /// @dev Acotarlo impide que un destinatario hostil queme todo el gas de la transaccion y
    ///      bloquee la liquidacion del resto. Si un pago no entra en este presupuesto no se
    ///      pierde: queda acreditado y su dueno lo retira con `withdraw()` sin limite de gas.
    ///      120k alcanza de sobra para una EOA o para que otro Safe reciba fondos.
    uint256 public constant PAYOUT_GAS_LIMIT = 120_000;

    /// @notice El Safe que custodia los fondos y la unica direccion que puede liquidar.
    address public immutable safe;

    /// @notice Registro de destinatarios autorizados.
    PoolRegistry public immutable registry;

    /// @notice Ultimo periodo liquidado. Los periodos avanzan de forma estrictamente creciente.
    uint256 public lastSettledEpoch;

    /// @notice Total acreditado y aun no retirado por pagos que fallaron.
    uint256 public totalCredited;

    /// @notice Historial de liquidaciones, indexado por periodo.
    mapping(uint256 epochId => Settlement settlement) public settlements;

    /// @notice Saldo pendiente de retiro de cada destinatario cuyo pago fallo.
    mapping(address account => uint256 amount) public credits;

    uint256 private _reentrancyGuard = 1;

    event SettlementExecuted(
        uint256 indexed epochId, uint256 gross, bytes32 indexed telemetryHash, uint256 payoutCount
    );
    event PayoutSent(uint256 indexed epochId, address indexed to, PoolRegistry.Role indexed role, uint256 amount);
    event PayoutCredited(uint256 indexed epochId, address indexed to, uint256 amount);
    event Withdrawn(address indexed account, uint256 amount);
    event UnaccountedSwept(address indexed to, uint256 amount);

    error NotSafe(address caller);
    error Reentrancy();
    error EpochNotIncreasing(uint256 requestedEpoch, uint256 lastSettledEpoch);
    error MissingTelemetryHash();
    error NoValueSent();
    error TooManyPayouts(uint256 provided, uint256 maxPayouts);
    error TooFewPayouts(uint256 provided);
    error UnauthorizedRecipient(address to, PoolRegistry.Role claimedRole, PoolRegistry.Role registeredRole);
    error DuplicateRecipient(address to);
    error PayoutSumMismatch(uint256 payoutSum, uint256 valueSent);
    error ExpectedExactlyOneEnergyPayout(uint256 count);
    error ExpectedExactlyOneMaintenancePayout(uint256 count);
    error NoPartnerPayouts();
    error MaintenanceBelowFloor(uint256 provided, uint256 required);
    error NothingToWithdraw(address account);
    error WithdrawFailed(address account, uint256 amount);
    error DirectDepositNotAllowed();
    error NothingToSweep();
    error SweepFailed(uint256 amount);

    modifier onlySafe() {
        if (msg.sender != safe) revert NotSafe(msg.sender);
        _;
    }

    modifier nonReentrant() {
        if (_reentrancyGuard != 1) revert Reentrancy();
        _reentrancyGuard = 2;
        _;
        _reentrancyGuard = 1;
    }

    constructor(PoolRegistry registry_) {
        registry = registry_;
        // El Splitter hereda la autoridad del registro en vez de recibirla por parametro.
        // Asi es imposible desplegarlo apuntando a un Safe distinto del que gobierna la
        // lista de destinatarios, que seria una separacion de poderes rota en silencio.
        safe = registry_.safe();
    }

    // --------------------------------------------------------------------
    // Liquidacion
    // --------------------------------------------------------------------

    /// @notice Liquida un periodo: valida el reparto propuesto y lo distribuye en el acto.
    ///
    /// @dev El valor a repartir llega como `msg.value` en esta misma llamada. El Safe envia
    ///      y distribuye en una sola transaccion atomica: o cierran todas las cuentas, o no
    ///      se mueve nada.
    ///
    ///      Invariantes que se exigen antes de transferir:
    ///        1. El periodo es estrictamente mayor al ultimo liquidado (anti doble pago).
    ///        2. Viene el hash de la telemetria que sustenta el calculo (anclaje de auditoria).
    ///        3. Cada destinatario esta en el registro y con el rol que la linea declara.
    ///        4. Ningun destinatario aparece dos veces.
    ///        5. Hay exactamente un pago de energia y exactamente uno de mantenimiento.
    ///        6. Hay al menos un pago a socio.
    ///        7. El mantenimiento alcanza el piso configurado en el registro.
    ///        8. La suma de las lineas es exactamente `msg.value`: ni un wei se crea ni se pierde.
    ///
    /// @param epochId Identificador del periodo liquidado.
    /// @param telemetryHash Hash de la telemetria cruda del periodo. Ancla el calculo para que
    ///        cualquier socio pueda recalcular el reparto desde los datos y verificar que
    ///        corresponden a esta liquidacion.
    /// @param payouts Lineas del reparto.
    function settle(uint256 epochId, bytes32 telemetryHash, Payout[] calldata payouts)
        external
        payable
        onlySafe
        nonReentrant
    {
        uint256 gross = msg.value;

        if (epochId <= lastSettledEpoch) revert EpochNotIncreasing(epochId, lastSettledEpoch);
        if (telemetryHash == bytes32(0)) revert MissingTelemetryHash();
        if (gross == 0) revert NoValueSent();

        uint256 count = payouts.length;
        if (count > MAX_PAYOUTS) revert TooManyPayouts(count, MAX_PAYOUTS);
        // Un reparto valido necesita como minimo energia, mantenimiento y un socio.
        if (count < 3) revert TooFewPayouts(count);

        uint256 payoutSum;
        uint256 energyCount;
        uint256 maintenanceCount;
        uint256 partnerCount;
        uint256 maintenanceAmount;

        for (uint256 i = 0; i < count; ++i) {
            Payout calldata payout = payouts[i];

            PoolRegistry.Role registeredRole = registry.roleOf(payout.to);
            if (registeredRole == PoolRegistry.Role.NONE || registeredRole != payout.role) {
                revert UnauthorizedRecipient(payout.to, payout.role, registeredRole);
            }

            // O(n^2) a proposito: `count` esta acotado por MAX_PAYOUTS, y un mapping temporal
            // costaria mas gas ademas de ensuciar el storage.
            for (uint256 j = 0; j < i; ++j) {
                if (payouts[j].to == payout.to) revert DuplicateRecipient(payout.to);
            }

            if (payout.role == PoolRegistry.Role.ENERGY) {
                ++energyCount;
            } else if (payout.role == PoolRegistry.Role.MAINTENANCE) {
                ++maintenanceCount;
                maintenanceAmount = payout.amount;
            } else {
                ++partnerCount;
            }

            payoutSum += payout.amount;
        }

        if (energyCount != 1) revert ExpectedExactlyOneEnergyPayout(energyCount);
        if (maintenanceCount != 1) revert ExpectedExactlyOneMaintenancePayout(maintenanceCount);
        if (partnerCount == 0) revert NoPartnerPayouts();

        uint256 requiredMaintenance = registry.requiredMaintenance(gross);
        if (maintenanceAmount < requiredMaintenance) {
            revert MaintenanceBelowFloor(maintenanceAmount, requiredMaintenance);
        }

        // La invariante central del protocolo. Si esto no cierra, no hay liquidacion.
        if (payoutSum != gross) revert PayoutSumMismatch(payoutSum, gross);

        // Efectos antes de interacciones.
        lastSettledEpoch = epochId;
        settlements[epochId] =
            Settlement({telemetryHash: telemetryHash, gross: gross, settledAt: uint64(block.timestamp)});

        emit SettlementExecuted(epochId, gross, telemetryHash, count);

        for (uint256 i = 0; i < count; ++i) {
            _payOut(epochId, payouts[i]);
        }
    }

    /// @dev Intenta pagar. Si el destinatario rechaza los fondos o se queda sin gas, el monto
    ///      queda acreditado en vez de revertir: un solo socio con una wallet problematica no
    ///      puede bloquear el cobro de todos los demas.
    function _payOut(uint256 epochId, Payout calldata payout) internal {
        uint256 amount = payout.amount;
        // Un socio que tuvo su equipo apagado todo el periodo cobra cero. Es un reparto
        // valido y no hay nada que transferir.
        if (amount == 0) {
            emit PayoutSent(epochId, payout.to, payout.role, 0);
            return;
        }

        (bool success,) = payout.to.call{value: amount, gas: PAYOUT_GAS_LIMIT}("");
        if (success) {
            emit PayoutSent(epochId, payout.to, payout.role, amount);
        } else {
            credits[payout.to] += amount;
            totalCredited += amount;
            emit PayoutCredited(epochId, payout.to, amount);
        }
    }

    // --------------------------------------------------------------------
    // Retiro de pagos fallidos
    // --------------------------------------------------------------------

    /// @notice Retira el saldo acreditado por pagos que no pudieron entregarse.
    function withdraw() external nonReentrant {
        uint256 amount = credits[msg.sender];
        if (amount == 0) revert NothingToWithdraw(msg.sender);

        credits[msg.sender] = 0;
        totalCredited -= amount;

        (bool success,) = msg.sender.call{value: amount}("");
        if (!success) revert WithdrawFailed(msg.sender, amount);

        emit Withdrawn(msg.sender, amount);
    }

    // --------------------------------------------------------------------
    // Saneamiento
    // --------------------------------------------------------------------

    /// @notice Devuelve al Safe todo saldo que no corresponda a un credito pendiente.
    /// @dev Cubre el unico caso en que puede quedar valor atrapado: ETH forzado al contrato
    ///      por `selfdestruct` o por ser beneficiario de un bloque. Nunca toca los creditos.
    function sweepUnaccounted() external onlySafe nonReentrant {
        uint256 unaccounted = address(this).balance - totalCredited;
        if (unaccounted == 0) revert NothingToSweep();

        (bool success,) = safe.call{value: unaccounted}("");
        if (!success) revert SweepFailed(unaccounted);

        emit UnaccountedSwept(safe, unaccounted);
    }

    /// @dev Los fondos entran por `settle`, acompanados del reparto que los justifica. Un
    ///      deposito suelto no tendria periodo ni telemetria asociada, asi que se rechaza
    ///      en vez de quedar en un limbo contable.
    receive() external payable {
        revert DirectDepositNotAllowed();
    }
}
