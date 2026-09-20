// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {PoolRegistry} from "../../src/PoolRegistry.sol";
import {PoolSplitter} from "../../src/PoolSplitter.sol";
import {ISafe} from "../../src/interfaces/ISafe.sol";
import {SafeDeployer} from "../../script/DeploySafe.s.sol";

/// @notice Ensaya el despliegue real del pool sobre un fork de HSKChain, con las direcciones
///         que se van a usar de verdad.
///
/// @dev El objetivo es que nada se descubra con HSK de por medio. Comprueba que el baul se
///      cree bien, que el cableado quede correcto, que una liquidacion completa se ejecute, y
///      cuanto gas cuesta todo. Un pool mal cableado funciona en apariencia hasta la primera
///      liquidacion, que es el peor momento para enterarse.
contract DeployPoolForkTest is Test {
    // Direcciones reales del pool.
    address internal constant ENERGY_WALLET = 0xcd23dAd3cDb7eb7046829f033c92107fC60F316b;
    address internal constant PARTNER_A = 0x92302923eBE05EC3984A49755346Cf02327e7CA5;
    address internal constant PARTNER_B = 0x937B8Ead58E73d1A22022d9731536589793207a6;

    uint16 internal constant MAINTENANCE_BPS = 500;

    bool internal forked;

    ISafe internal baul;
    ISafe internal vaultMantenimiento;
    PoolRegistry internal registry;
    PoolSplitter internal splitter;

    function setUp() public {
        string memory rpc = vm.envOr("HSK_TESTNET_RPC", string(""));
        if (bytes(rpc).length == 0) return;

        vm.createSelectFork(rpc);
        forked = true;

        // Los duenos del baul son los dos socios: ninguno puede mover los fondos solo.
        address[] memory owners = new address[](2);
        owners[0] = PARTNER_A;
        owners[1] = PARTNER_B;

        // Salt derivado del bloque del fork, no fijo.
        //
        // La factory de Safe usa CREATE2: con los mismos duenos y el mismo salt sale siempre
        // la misma direccion. El baul real del pool ya esta desplegado con estos duenos y
        // salt 0, asi que reusar ese salt hace que CREATE2 revierta por colision. Un salt
        // que depende del bloque mantiene el ensayo independiente de lo que ya exista en la
        // cadena, hoy y despues de cada nuevo despliegue.
        uint256 salt = uint256(keccak256(abi.encodePacked(block.number, "ensayo-baul")));

        baul = SafeDeployer.deploy(owners, 2, salt);

        address[] memory ownersVault = new address[](2);
        ownersVault[0] = PARTNER_A;
        ownersVault[1] = PARTNER_B;
        vaultMantenimiento = SafeDeployer.deploy(ownersVault, 2, salt + 1);

        address[] memory partners = new address[](2);
        partners[0] = PARTNER_A;
        partners[1] = PARTNER_B;

        registry = new PoolRegistry(
            address(baul), ENERGY_WALLET, address(vaultMantenimiento), MAINTENANCE_BPS, partners
        );
        splitter = new PoolSplitter(registry);
    }

    function test_Fork_ElBaulQuedaBienConstituido() public view {
        if (!forked) return;

        assertEq(baul.getThreshold(), 2, "se necesitan las dos firmas");
        assertTrue(baul.isOwner(PARTNER_A), "socio A es dueno del baul");
        assertTrue(baul.isOwner(PARTNER_B), "socio B es dueno del baul");
        assertGt(address(baul).code.length, 0, "el baul tiene codigo desplegado");
    }

    function test_Fork_ElVaultDeMantenimientoEsDistintoDelBaul() public view {
        if (!forked) return;

        // Mismos duenos, distinta direccion: la reserva no se mezcla con las ganancias sin
        // repartir, y sigue estando bajo el control de los dos socios.
        assertTrue(address(vaultMantenimiento) != address(baul), "el vault debe ser otra direccion");
        assertEq(vaultMantenimiento.getThreshold(), 2, "el vault tambien exige las dos firmas");
        assertTrue(vaultMantenimiento.isOwner(PARTNER_A), "socio A controla el fondo");
        assertTrue(vaultMantenimiento.isOwner(PARTNER_B), "socio B controla el fondo");
    }

    function test_Fork_ElCableadoQuedaCorrecto() public view {
        if (!forked) return;

        assertEq(splitter.safe(), address(baul), "el splitter obedece al baul");
        assertEq(address(splitter.registry()), address(registry), "registro cableado");
        assertEq(registry.maintenanceBps(), MAINTENANCE_BPS, "reserva al 5%");
        assertEq(uint8(registry.roleOf(ENERGY_WALLET)), uint8(PoolRegistry.Role.ENERGY), "rol de la luz");
        assertEq(
            uint8(registry.roleOf(address(vaultMantenimiento))),
            uint8(PoolRegistry.Role.MAINTENANCE),
            "rol del vault"
        );
        assertTrue(registry.isPartner(PARTNER_A), "socio A registrado");
        assertTrue(registry.isPartner(PARTNER_B), "socio B registrado");
        assertEq(registry.partnerCount(), 2, "dos socios");
    }

    /// @notice Una liquidacion real contra las direcciones reales, para que el dia de la
    ///         demostracion no haya ninguna sorpresa.
    function test_Fork_LiquidacionSobreLasDireccionesReales() public {
        if (!forked) return;

        vm.deal(address(baul), 10 ether);

        // Reparto 2:1 con ambos equipos al 100%, luz al 20% y reserva al 5%.
        PoolSplitter.Payout[] memory payouts = new PoolSplitter.Payout[](4);
        payouts[0] = PoolSplitter.Payout(ENERGY_WALLET, 0.2 ether, PoolRegistry.Role.ENERGY);
        payouts[1] =
            PoolSplitter.Payout(address(vaultMantenimiento), 0.05 ether, PoolRegistry.Role.MAINTENANCE);
        payouts[2] = PoolSplitter.Payout(PARTNER_A, 0.5 ether, PoolRegistry.Role.PARTNER);
        payouts[3] = PoolSplitter.Payout(PARTNER_B, 0.25 ether, PoolRegistry.Role.PARTNER);

        uint256 luzAntes = ENERGY_WALLET.balance;
        uint256 aAntes = PARTNER_A.balance;
        uint256 bAntes = PARTNER_B.balance;

        vm.prank(address(baul));
        splitter.settle{value: 1 ether}(1, keccak256("telemetria-semana-1"), payouts);

        assertEq(ENERGY_WALLET.balance - luzAntes, 0.2 ether, "la luz cobra");
        assertEq(address(vaultMantenimiento).balance, 0.05 ether, "el fondo reserva");
        assertEq(PARTNER_A.balance - aAntes, 0.5 ether, "socio A cobra");
        assertEq(PARTNER_B.balance - bAntes, 0.25 ether, "socio B cobra");
        assertEq(address(splitter).balance, 0, "el splitter no retiene nada");
    }

    /// @notice Mide el costo real del despliegue en la cadena, para saber de antemano cuanto
    ///         HSK hace falta en la wallet que despliega.
    function test_Fork_CostoDelDespliegue() public {
        if (!forked) return;

        address[] memory owners = new address[](2);
        owners[0] = PARTNER_A;
        owners[1] = PARTNER_B;

        address[] memory partners = new address[](2);
        partners[0] = PARTNER_A;
        partners[1] = PARTNER_B;

        uint256 salt = uint256(keccak256(abi.encodePacked(block.number, "ensayo-costo")));

        uint256 gasInicial = gasleft();
        ISafe nuevoBaul = SafeDeployer.deploy(owners, 2, salt);
        uint256 gasBaul = gasInicial - gasleft();

        gasInicial = gasleft();
        ISafe nuevoVault = SafeDeployer.deploy(owners, 2, salt + 1);
        uint256 gasVault = gasInicial - gasleft();

        gasInicial = gasleft();
        PoolRegistry nuevoRegistry = new PoolRegistry(
            address(nuevoBaul), ENERGY_WALLET, address(nuevoVault), MAINTENANCE_BPS, partners
        );
        uint256 gasRegistry = gasInicial - gasleft();

        gasInicial = gasleft();
        new PoolSplitter(nuevoRegistry);
        uint256 gasSplitter = gasInicial - gasleft();

        uint256 total = gasBaul + gasVault + gasRegistry + gasSplitter;

        console.log("gas baul      :", gasBaul);
        console.log("gas vault     :", gasVault);
        console.log("gas registry  :", gasRegistry);
        console.log("gas splitter  :", gasSplitter);
        console.log("gas total     :", total);
        // A 2 gwei, el costo en wei del despliegue completo.
        console.log("costo a 2 gwei (wei):", total * 2 gwei);

        assertLt(total, 5_000_000, "el despliegue completo debe entrar comodo en un bloque");
    }
}
