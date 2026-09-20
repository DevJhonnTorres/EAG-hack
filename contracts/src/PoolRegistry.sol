// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title PoolRegistry
/// @notice Fuente de verdad on-chain de QUIEN puede cobrar de un micro-pool de mineria.
///
/// @dev Este contrato existe para acotar el radio de dano de un middleware comprometido.
///      El calculo del reparto ocurre fuera de la cadena (es barato y flexible), pero el
///      orquestador solo puede mover fondos entre direcciones que el multisig ya aprobo.
///      Aunque un atacante tome control total del servidor que calcula, no puede desviar
///      un solo wei a una direccion propia: solo puede proponer un reparto distinto entre
///      los destinatarios legitimos, y ese reparto todavia tiene que pasar por las firmas
///      del Safe y por las invariantes del PoolSplitter.
///
///      El Safe es inmutable. No hay funcion para transferir la titularidad, asi que no
///      existe el vector de "secuestrar el pool cambiando el owner".
contract PoolRegistry {
    /// @notice Rol de una direccion dentro del pool. NONE significa que no puede cobrar.
    enum Role {
        NONE,
        PARTNER, // socio que aporta hardware
        ENERGY, // wallet administrativa que paga la factura de luz
        MAINTENANCE // vault del fondo de repuestos y mantenimiento
    }

    /// @notice Tope de seguridad del fondo de mantenimiento: 50%.
    /// @dev Evita que una configuracion erronea (o maliciosa) desvie la totalidad de las
    ///      ganancias al fondo, dejando a los socios sin nada de forma "valida".
    uint16 public constant MAX_MAINTENANCE_BPS = 5_000;

    uint16 internal constant BPS_DENOMINATOR = 10_000;

    /// @notice Tope de socios. Mantiene acotado el costo en gas de las validaciones O(n^2)
    ///         que hace el PoolSplitter al revisar duplicados.
    uint256 public constant MAX_PARTNERS = 16;

    /// @notice El Gnosis Safe que custodia los fondos y es la unica autoridad sobre este registro.
    address public immutable safe;

    /// @notice Porcion del bruto que debe reservarse al fondo de mantenimiento, en basis points.
    uint16 public maintenanceBps;

    /// @notice Wallet administrativa que recibe el costo de la energia del periodo.
    address public energyWallet;

    /// @notice Vault que acumula el fondo de mantenimiento.
    address public maintenanceVault;

    /// @dev Lista de socios activos. El orden no tiene significado.
    address[] internal _partners;

    /// @dev Indice de cada socio dentro de `_partners`, desplazado en +1 para que 0 signifique
    ///      "no presente". Permite altas y bajas en O(1).
    mapping(address account => uint256 indexPlusOne) internal _partnerIndex;

    /// @notice Rol vigente de cada direccion.
    mapping(address account => Role role) public roleOf;

    event MaintenanceBpsUpdated(uint16 previousBps, uint16 newBps);
    event EnergyWalletUpdated(address indexed previousWallet, address indexed newWallet);
    event MaintenanceVaultUpdated(address indexed previousVault, address indexed newVault);
    event PartnerAdded(address indexed partner);
    event PartnerRemoved(address indexed partner);

    error NotSafe(address caller);
    error ZeroAddress();
    error MaintenanceBpsTooHigh(uint16 requestedBps, uint16 maxBps);
    error AddressAlreadyAssigned(address account, Role existingRole);
    error PartnerNotFound(address account);
    error TooManyPartners(uint256 maxPartners);
    error NoPartners();

    modifier onlySafe() {
        if (msg.sender != safe) revert NotSafe(msg.sender);
        _;
    }

    /// @param safe_ Direccion del Gnosis Safe que custodia el pool. Inmutable.
    /// @param energyWallet_ Wallet que paga la luz.
    /// @param maintenanceVault_ Vault del fondo de mantenimiento.
    /// @param maintenanceBps_ Reserva de mantenimiento en basis points.
    /// @param partners_ Socios iniciales del pool.
    constructor(
        address safe_,
        address energyWallet_,
        address maintenanceVault_,
        uint16 maintenanceBps_,
        address[] memory partners_
    ) {
        if (safe_ == address(0)) revert ZeroAddress();
        safe = safe_;

        _setEnergyWallet(energyWallet_);
        _setMaintenanceVault(maintenanceVault_);
        _setMaintenanceBps(maintenanceBps_);

        uint256 length = partners_.length;
        if (length == 0) revert NoPartners();
        for (uint256 i = 0; i < length; ++i) {
            _addPartner(partners_[i]);
        }
    }

    // --------------------------------------------------------------------
    // Administracion (solo el Safe)
    // --------------------------------------------------------------------

    /// @notice Cambia la reserva del fondo de mantenimiento.
    function setMaintenanceBps(uint16 newBps) external onlySafe {
        _setMaintenanceBps(newBps);
    }

    /// @notice Cambia la wallet que recibe el costo de la energia.
    function setEnergyWallet(address newWallet) external onlySafe {
        address previous = energyWallet;
        if (previous != address(0)) roleOf[previous] = Role.NONE;
        _setEnergyWallet(newWallet);
    }

    /// @notice Cambia el vault del fondo de mantenimiento.
    function setMaintenanceVault(address newVault) external onlySafe {
        address previous = maintenanceVault;
        if (previous != address(0)) roleOf[previous] = Role.NONE;
        _setMaintenanceVault(newVault);
    }

    /// @notice Da de alta un socio.
    function addPartner(address partner) external onlySafe {
        _addPartner(partner);
    }

    /// @notice Da de baja un socio.
    /// @dev El pool no puede quedarse sin socios: dejaria liquidaciones imposibles de armar.
    function removePartner(address partner) external onlySafe {
        uint256 indexPlusOne = _partnerIndex[partner];
        if (indexPlusOne == 0) revert PartnerNotFound(partner);
        if (_partners.length == 1) revert NoPartners();

        uint256 index = indexPlusOne - 1;
        uint256 lastIndex = _partners.length - 1;
        if (index != lastIndex) {
            address moved = _partners[lastIndex];
            _partners[index] = moved;
            _partnerIndex[moved] = index + 1;
        }
        _partners.pop();

        delete _partnerIndex[partner];
        roleOf[partner] = Role.NONE;

        emit PartnerRemoved(partner);
    }

    // --------------------------------------------------------------------
    // Lectura
    // --------------------------------------------------------------------

    /// @notice Socios activos del pool.
    function partners() external view returns (address[] memory) {
        return _partners;
    }

    /// @notice Cantidad de socios activos.
    function partnerCount() external view returns (uint256) {
        return _partners.length;
    }

    /// @notice True si la direccion es un socio activo.
    function isPartner(address account) external view returns (bool) {
        return _partnerIndex[account] != 0;
    }

    /// @notice Piso que el fondo de mantenimiento debe recibir para un bruto dado.
    /// @dev Redondea hacia abajo. El PoolSplitter exige `>=` a este valor, de modo que el
    ///      polvo del redondeo puede sumarse al fondo sin invalidar la liquidacion.
    function requiredMaintenance(uint256 grossAmount) external view returns (uint256) {
        return (grossAmount * maintenanceBps) / BPS_DENOMINATOR;
    }

    // --------------------------------------------------------------------
    // Interno
    // --------------------------------------------------------------------

    function _setMaintenanceBps(uint16 newBps) internal {
        if (newBps > MAX_MAINTENANCE_BPS) revert MaintenanceBpsTooHigh(newBps, MAX_MAINTENANCE_BPS);
        emit MaintenanceBpsUpdated(maintenanceBps, newBps);
        maintenanceBps = newBps;
    }

    function _setEnergyWallet(address newWallet) internal {
        _requireUnassigned(newWallet);
        emit EnergyWalletUpdated(energyWallet, newWallet);
        energyWallet = newWallet;
        roleOf[newWallet] = Role.ENERGY;
    }

    function _setMaintenanceVault(address newVault) internal {
        _requireUnassigned(newVault);
        emit MaintenanceVaultUpdated(maintenanceVault, newVault);
        maintenanceVault = newVault;
        roleOf[newVault] = Role.MAINTENANCE;
    }

    function _addPartner(address partner) internal {
        _requireUnassigned(partner);
        if (_partners.length >= MAX_PARTNERS) revert TooManyPartners(MAX_PARTNERS);

        _partners.push(partner);
        _partnerIndex[partner] = _partners.length;
        roleOf[partner] = Role.PARTNER;

        emit PartnerAdded(partner);
    }

    /// @dev Una direccion no puede acumular dos roles. Si la wallet de la luz fuera tambien
    ///      un socio, la regla de "exactamente un pago de energia" del PoolSplitter se volveria
    ///      ambigua y abriria la puerta a cobrar dos veces bajo una liquidacion formalmente valida.
    function _requireUnassigned(address account) internal view {
        if (account == address(0)) revert ZeroAddress();
        Role existing = roleOf[account];
        if (existing != Role.NONE) revert AddressAlreadyAssigned(account, existing);
    }
}
