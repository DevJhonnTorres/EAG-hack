// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {PoolRegistry} from "../src/PoolRegistry.sol";

contract PoolRegistryTest is Test {
    PoolRegistry internal registry;

    address internal safe = makeAddr("safe");
    address internal energyWallet = makeAddr("energyWallet");
    address internal maintenanceVault = makeAddr("maintenanceVault");
    address internal partnerA = makeAddr("partnerA");
    address internal partnerB = makeAddr("partnerB");
    address internal intruder = makeAddr("intruder");

    function setUp() public {
        address[] memory partners = new address[](2);
        partners[0] = partnerA;
        partners[1] = partnerB;
        registry = new PoolRegistry(safe, energyWallet, maintenanceVault, 500, partners);
    }

    function _deploy(address[] memory partners) internal returns (PoolRegistry) {
        return new PoolRegistry(safe, energyWallet, maintenanceVault, 500, partners);
    }

    // --------------------------------------------------------------------
    // Construccion
    // --------------------------------------------------------------------

    function test_ConstruyeConRolesCorrectos() public view {
        assertEq(uint8(registry.roleOf(energyWallet)), uint8(PoolRegistry.Role.ENERGY));
        assertEq(uint8(registry.roleOf(maintenanceVault)), uint8(PoolRegistry.Role.MAINTENANCE));
        assertEq(uint8(registry.roleOf(partnerA)), uint8(PoolRegistry.Role.PARTNER));
        assertEq(uint8(registry.roleOf(partnerB)), uint8(PoolRegistry.Role.PARTNER));
        assertEq(uint8(registry.roleOf(intruder)), uint8(PoolRegistry.Role.NONE));
        assertEq(registry.partnerCount(), 2);
        assertEq(registry.safe(), safe);
    }

    function test_RevertWhen_ElSafeEsLaDireccionCero() public {
        address[] memory partners = new address[](1);
        partners[0] = partnerA;
        vm.expectRevert(PoolRegistry.ZeroAddress.selector);
        new PoolRegistry(address(0), energyWallet, maintenanceVault, 500, partners);
    }

    function test_RevertWhen_SeConstruyeSinSocios() public {
        address[] memory partners = new address[](0);
        vm.expectRevert(PoolRegistry.NoPartners.selector);
        _deploy(partners);
    }

    function test_RevertWhen_LaReservaDeMantenimientoSuperaElTope() public {
        address[] memory partners = new address[](1);
        partners[0] = partnerA;
        vm.expectRevert(abi.encodeWithSelector(PoolRegistry.MaintenanceBpsTooHigh.selector, 5001, 5000));
        new PoolRegistry(safe, energyWallet, maintenanceVault, 5001, partners);
    }

    /// @notice Una direccion no puede tener dos roles. Si la wallet de la luz fuera tambien
    ///         socia, la regla de "exactamente un pago de energia" del Splitter se volveria
    ///         ambigua y permitiria cobrar dos veces con un reparto formalmente valido.
    function test_RevertWhen_UnaDireccionIntentaTenerDosRoles() public {
        address[] memory partners = new address[](1);
        partners[0] = energyWallet; // la wallet de la luz tambien como socia

        vm.expectRevert(
            abi.encodeWithSelector(
                PoolRegistry.AddressAlreadyAssigned.selector, energyWallet, PoolRegistry.Role.ENERGY
            )
        );
        _deploy(partners);
    }

    function test_RevertWhen_ElMismoSocioSeRepiteEnLaConstruccion() public {
        address[] memory partners = new address[](2);
        partners[0] = partnerA;
        partners[1] = partnerA;

        vm.expectRevert(
            abi.encodeWithSelector(
                PoolRegistry.AddressAlreadyAssigned.selector, partnerA, PoolRegistry.Role.PARTNER
            )
        );
        _deploy(partners);
    }

    function test_RevertWhen_SeSuperaElTopeDeSocios() public {
        address[] memory partners = new address[](17);
        for (uint256 i = 0; i < 17; ++i) {
            // casting to 'uint160' is safe because 1000 + i <= 1016, muy por debajo del rango
            // forge-lint: disable-next-line(unsafe-typecast)
            partners[i] = address(uint160(1000 + i));
        }
        vm.expectRevert(abi.encodeWithSelector(PoolRegistry.TooManyPartners.selector, 16));
        _deploy(partners);
    }

    // --------------------------------------------------------------------
    // Control de acceso: solo el Safe gobierna
    // --------------------------------------------------------------------

    function test_RevertWhen_UnExtranoIntentaAgregarUnSocio() public {
        vm.prank(intruder);
        vm.expectRevert(abi.encodeWithSelector(PoolRegistry.NotSafe.selector, intruder));
        registry.addPartner(intruder);
    }

    function test_RevertWhen_UnExtranoIntentaCambiarLaWalletDeLuz() public {
        vm.prank(intruder);
        vm.expectRevert(abi.encodeWithSelector(PoolRegistry.NotSafe.selector, intruder));
        registry.setEnergyWallet(intruder);
    }

    function test_RevertWhen_UnExtranoIntentaCambiarLaReserva() public {
        vm.prank(intruder);
        vm.expectRevert(abi.encodeWithSelector(PoolRegistry.NotSafe.selector, intruder));
        registry.setMaintenanceBps(0);
    }

    function test_RevertWhen_UnExtranoIntentaSacarUnSocio() public {
        vm.prank(intruder);
        vm.expectRevert(abi.encodeWithSelector(PoolRegistry.NotSafe.selector, intruder));
        registry.removePartner(partnerA);
    }

    // --------------------------------------------------------------------
    // Altas y bajas de socios
    // --------------------------------------------------------------------

    function test_AgregarSocio() public {
        address partnerC = makeAddr("partnerC");

        vm.expectEmit(true, false, false, false, address(registry));
        emit PoolRegistry.PartnerAdded(partnerC);

        vm.prank(safe);
        registry.addPartner(partnerC);

        assertTrue(registry.isPartner(partnerC));
        assertEq(registry.partnerCount(), 3);
        assertEq(uint8(registry.roleOf(partnerC)), uint8(PoolRegistry.Role.PARTNER));
    }

    function test_QuitarSocioLimpiaSuRol() public {
        vm.prank(safe);
        registry.removePartner(partnerA);

        assertFalse(registry.isPartner(partnerA));
        assertEq(uint8(registry.roleOf(partnerA)), uint8(PoolRegistry.Role.NONE));
        assertEq(registry.partnerCount(), 1);

        address[] memory remaining = registry.partners();
        assertEq(remaining.length, 1);
        assertEq(remaining[0], partnerB);
    }

    /// @dev La baja usa swap-and-pop, asi que conviene verificar que el indice del socio
    ///      desplazado quede consistente y siga siendo removible.
    function test_QuitarSocioDelMedioMantieneLosIndicesConsistentes() public {
        address partnerC = makeAddr("partnerC");
        vm.prank(safe);
        registry.addPartner(partnerC);

        vm.prank(safe);
        registry.removePartner(partnerA); // partnerC pasa a ocupar el hueco

        assertTrue(registry.isPartner(partnerC));
        assertTrue(registry.isPartner(partnerB));

        vm.prank(safe);
        registry.removePartner(partnerC);

        assertFalse(registry.isPartner(partnerC));
        assertEq(registry.partnerCount(), 1);
        assertEq(registry.partners()[0], partnerB);
    }

    /// @notice El pool no puede quedarse sin socios: dejaria imposible armar una liquidacion
    ///         valida y los fondos quedarian sin destinatario legitimo.
    function test_RevertWhen_SeQuitaAlUltimoSocio() public {
        vm.prank(safe);
        registry.removePartner(partnerA);

        vm.prank(safe);
        vm.expectRevert(PoolRegistry.NoPartners.selector);
        registry.removePartner(partnerB);
    }

    function test_RevertWhen_SeQuitaUnSocioInexistente() public {
        vm.prank(safe);
        vm.expectRevert(abi.encodeWithSelector(PoolRegistry.PartnerNotFound.selector, intruder));
        registry.removePartner(intruder);
    }

    function test_SocioDadoDeBajaPuedeVolverAEntrar() public {
        vm.prank(safe);
        registry.removePartner(partnerA);

        vm.prank(safe);
        registry.addPartner(partnerA);

        assertTrue(registry.isPartner(partnerA));
        assertEq(registry.partnerCount(), 2);
    }

    // --------------------------------------------------------------------
    // Rotacion de wallets administrativas
    // --------------------------------------------------------------------

    /// @notice Al rotar la wallet de la luz, la anterior debe perder su rol; de lo contrario
    ///         seguiria siendo un destinatario valido para siempre.
    function test_RotarLaWalletDeLuzRevocaLaAnterior() public {
        address nuevaWallet = makeAddr("nuevaWalletDeLuz");

        vm.prank(safe);
        registry.setEnergyWallet(nuevaWallet);

        assertEq(registry.energyWallet(), nuevaWallet);
        assertEq(uint8(registry.roleOf(nuevaWallet)), uint8(PoolRegistry.Role.ENERGY));
        assertEq(uint8(registry.roleOf(energyWallet)), uint8(PoolRegistry.Role.NONE));
    }

    function test_RotarElVaultDeMantenimientoRevocaElAnterior() public {
        address nuevoVault = makeAddr("nuevoVault");

        vm.prank(safe);
        registry.setMaintenanceVault(nuevoVault);

        assertEq(registry.maintenanceVault(), nuevoVault);
        assertEq(uint8(registry.roleOf(nuevoVault)), uint8(PoolRegistry.Role.MAINTENANCE));
        assertEq(uint8(registry.roleOf(maintenanceVault)), uint8(PoolRegistry.Role.NONE));
    }

    function test_RevertWhen_LaNuevaWalletDeLuzYaEsSocia() public {
        vm.prank(safe);
        vm.expectRevert(
            abi.encodeWithSelector(
                PoolRegistry.AddressAlreadyAssigned.selector, partnerA, PoolRegistry.Role.PARTNER
            )
        );
        registry.setEnergyWallet(partnerA);
    }

    // --------------------------------------------------------------------
    // Reserva de mantenimiento
    // --------------------------------------------------------------------

    function test_CambiarLaReservaDeMantenimiento() public {
        vm.prank(safe);
        registry.setMaintenanceBps(1_000);
        assertEq(registry.maintenanceBps(), 1_000);
    }

    function test_LaReservaPuedeSerCero() public {
        vm.prank(safe);
        registry.setMaintenanceBps(0);
        assertEq(registry.requiredMaintenance(1 ether), 0);
    }

    function test_RevertWhen_SeSubeLaReservaPorEncimaDelTope() public {
        vm.prank(safe);
        vm.expectRevert(abi.encodeWithSelector(PoolRegistry.MaintenanceBpsTooHigh.selector, 6000, 5000));
        registry.setMaintenanceBps(6_000);
    }

    function test_PisoDeMantenimientoCalculado() public view {
        assertEq(registry.requiredMaintenance(1 ether), 0.05 ether);
        assertEq(registry.requiredMaintenance(0), 0);
    }

    /// @notice El piso redondea hacia abajo a proposito: el Splitter exige `>=`, asi que el
    ///         polvo del redondeo puede sumarse al fondo sin invalidar la liquidacion.
    function testFuzz_ElPisoDeMantenimientoNuncaSuperaElBruto(uint128 gross, uint16 bpsSeed) public {
        uint16 bps = uint16(bound(bpsSeed, 0, registry.MAX_MAINTENANCE_BPS()));
        vm.prank(safe);
        registry.setMaintenanceBps(bps);

        uint256 required = registry.requiredMaintenance(gross);
        assertLe(required, gross, "el piso nunca puede exceder el bruto");
        assertLe(required, uint256(gross) / 2, "con el tope al 50%, nunca mas de la mitad");
    }
}
