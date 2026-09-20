// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {PoolCredit} from "../src/PoolCredit.sol";

contract PoolCreditTest is Test {
    PoolCredit internal token;

    uint256 internal pagadorKey = 0xA6E17E;
    address internal pagador;
    address internal oraculo = makeAddr("oraculo");
    address internal relayer = makeAddr("relayer");
    address internal intruso = makeAddr("intruso");

    uint256 internal constant SUPPLY = 1_000_000e6;

    function setUp() public {
        pagador = vm.addr(pagadorKey);
        token = new PoolCredit(pagador, SUPPLY);
        vm.warp(1_700_000_000);
    }

    // --------------------------------------------------------------------
    // Constantes del estandar
    // --------------------------------------------------------------------

    /// @notice Los typehash estan escritos como literales por eficiencia de gas. Si alguien
    ///         edita la firma del tipo y no el literal, las autorizaciones dejarian de validar
    ///         sin ningun error de compilacion. Este test lo impide.
    function test_LosTypehashCoincidenConElEstandar() public view {
        assertEq(
            token.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(),
            keccak256(
                "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
            )
        );
        assertEq(
            token.CANCEL_AUTHORIZATION_TYPEHASH(),
            keccak256("CancelAuthorization(address authorizer,bytes32 nonce)")
        );
    }

    /// @notice El dominio incluye el chainId, que es lo que impide reutilizar una firma de otra
    ///         cadena. Se recalcula en cada llamada, asi que tambien cubre una bifurcacion.
    function test_ElDominioSigueALaCadena() public {
        bytes32 antes = token.DOMAIN_SEPARATOR();
        vm.chainId(999);
        assertTrue(token.DOMAIN_SEPARATOR() != antes, "el dominio debe cambiar con la cadena");
    }

    // --------------------------------------------------------------------
    // Autorizaciones firmadas
    // --------------------------------------------------------------------

    function _firmar(address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce)
        internal
        view
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        bytes32 structHash = keccak256(
            abi.encode(
                token.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(),
                pagador,
                to,
                value,
                validAfter,
                validBefore,
                nonce
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), structHash));
        return vm.sign(pagadorKey, digest);
    }

    /// @notice El caso que hace util al token: el agente firma fuera de la cadena y otro
    ///         presenta la autorizacion pagando el gas. El agente no necesita gas ni estar
    ///         en linea.
    function test_UnTerceroPuedeCobrarLaAutorizacionYPagaElGas() public {
        bytes32 nonce = keccak256("llamada-tarifa-1");
        (uint8 v, bytes32 r, bytes32 s) = _firmar(oraculo, 1_000, 0, block.timestamp + 300, nonce);

        vm.prank(relayer);
        token.transferWithAuthorization(pagador, oraculo, 1_000, 0, block.timestamp + 300, nonce, v, r, s);

        assertEq(token.balanceOf(oraculo), 1_000, "el oraculo cobro");
        assertEq(token.balanceOf(pagador), SUPPLY - 1_000, "al agente se le debito");
        assertTrue(token.authorizationState(pagador, nonce), "la autorizacion quedo consumida");
    }

    /// @notice Sin esto, quien cobra podria presentar la misma autorizacion una y otra vez.
    function test_RevertWhen_SeCobraDosVecesLaMismaAutorizacion() public {
        bytes32 nonce = keccak256("llamada-tarifa-1");
        uint256 hasta = block.timestamp + 300;
        (uint8 v, bytes32 r, bytes32 s) = _firmar(oraculo, 1_000, 0, hasta, nonce);

        token.transferWithAuthorization(pagador, oraculo, 1_000, 0, hasta, nonce, v, r, s);

        vm.expectRevert(abi.encodeWithSelector(PoolCredit.AuthorizationAlreadyUsed.selector, pagador, nonce));
        token.transferWithAuthorization(pagador, oraculo, 1_000, 0, hasta, nonce, v, r, s);
    }

    /// @notice Los nonces no son secuenciales a proposito: el agente puede firmar varias
    ///         llamadas en paralelo sin coordinarlas entre si.
    function test_AutorizacionesEnParaleloConNoncesDistintos() public {
        uint256 hasta = block.timestamp + 300;
        for (uint256 i = 0; i < 3; ++i) {
            bytes32 nonce = keccak256(abi.encodePacked("llamada", i));
            (uint8 v, bytes32 r, bytes32 s) = _firmar(oraculo, 100, 0, hasta, nonce);
            token.transferWithAuthorization(pagador, oraculo, 100, 0, hasta, nonce, v, r, s);
        }
        assertEq(token.balanceOf(oraculo), 300);
    }

    function test_RevertWhen_LaAutorizacionVencio() public {
        bytes32 nonce = keccak256("vencida");
        uint256 hasta = block.timestamp + 60;
        (uint8 v, bytes32 r, bytes32 s) = _firmar(oraculo, 1_000, 0, hasta, nonce);

        vm.warp(hasta + 1);
        vm.expectRevert(
            abi.encodeWithSelector(PoolCredit.AuthorizationExpired.selector, hasta, block.timestamp)
        );
        token.transferWithAuthorization(pagador, oraculo, 1_000, 0, hasta, nonce, v, r, s);
    }

    function test_RevertWhen_LaAutorizacionNoEmpezoAValer() public {
        bytes32 nonce = keccak256("futura");
        uint256 desde = block.timestamp + 100;
        (uint8 v, bytes32 r, bytes32 s) = _firmar(oraculo, 1_000, desde, desde + 300, nonce);

        vm.expectRevert(
            abi.encodeWithSelector(PoolCredit.AuthorizationNotYetValid.selector, desde, block.timestamp)
        );
        token.transferWithAuthorization(pagador, oraculo, 1_000, desde, desde + 300, nonce, v, r, s);
    }

    /// @notice Cambiar cualquier campo invalida la firma: quien cobra no puede inflar el monto
    ///         ni redirigir el pago a otra direccion.
    function test_RevertWhen_SeAlteraElMontoAutorizado() public {
        bytes32 nonce = keccak256("alterada");
        uint256 hasta = block.timestamp + 300;
        (uint8 v, bytes32 r, bytes32 s) = _firmar(oraculo, 1_000, 0, hasta, nonce);

        vm.expectRevert();
        token.transferWithAuthorization(pagador, oraculo, 9_999, 0, hasta, nonce, v, r, s);
    }

    function test_RevertWhen_SeRedirigeElDestinatario() public {
        bytes32 nonce = keccak256("redirigida");
        uint256 hasta = block.timestamp + 300;
        (uint8 v, bytes32 r, bytes32 s) = _firmar(oraculo, 1_000, 0, hasta, nonce);

        vm.expectRevert();
        token.transferWithAuthorization(pagador, intruso, 1_000, 0, hasta, nonce, v, r, s);
    }

    function test_RevertWhen_LaFirmaEsBasura() public {
        bytes32 nonce = keccak256("basura");
        vm.expectRevert();
        token.transferWithAuthorization(
            pagador,
            oraculo,
            1_000,
            0,
            block.timestamp + 300,
            nonce,
            27,
            bytes32(uint256(1)),
            bytes32(uint256(2))
        );
    }

    /// @dev Se firma la cancelacion en un helper aparte para no acumular demasiadas variables
    ///      locales en el test: con las dos firmas juntas, el compilador se queda sin stack.
    function _cancelar(bytes32 nonce) internal {
        bytes32 cancelHash = keccak256(abi.encode(token.CANCEL_AUTHORIZATION_TYPEHASH(), pagador, nonce));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), cancelHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pagadorKey, digest);
        token.cancelAuthorization(pagador, nonce, v, r, s);
    }

    function test_CancelarUnaAutorizacionImpideQueSeCobre() public {
        bytes32 nonce = keccak256("a-cancelar");
        uint256 hasta = block.timestamp + 300;
        (uint8 v, bytes32 r, bytes32 s) = _firmar(oraculo, 1_000, 0, hasta, nonce);

        _cancelar(nonce);

        vm.expectRevert(abi.encodeWithSelector(PoolCredit.AuthorizationAlreadyUsed.selector, pagador, nonce));
        token.transferWithAuthorization(pagador, oraculo, 1_000, 0, hasta, nonce, v, r, s);
    }

    function test_RevertWhen_NoAlcanzaElSaldoAutorizado() public {
        bytes32 nonce = keccak256("sin-fondos");
        uint256 hasta = block.timestamp + 300;
        (uint8 v, bytes32 r, bytes32 s) = _firmar(oraculo, SUPPLY + 1, 0, hasta, nonce);

        vm.expectRevert();
        token.transferWithAuthorization(pagador, oraculo, SUPPLY + 1, 0, hasta, nonce, v, r, s);
    }

    // --------------------------------------------------------------------
    // ERC-20
    // --------------------------------------------------------------------

    function test_TransferenciaSimple() public {
        vm.prank(pagador);
        token.transfer(oraculo, 500);
        assertEq(token.balanceOf(oraculo), 500);
    }

    function test_RevertWhen_SeTransfiereSinSaldo() public {
        vm.prank(intruso);
        vm.expectRevert(abi.encodeWithSelector(PoolCredit.InsufficientBalance.selector, intruso, 0, 1));
        token.transfer(oraculo, 1);
    }

    function test_TransferFromConsumeElPermiso() public {
        vm.prank(pagador);
        token.approve(relayer, 1_000);

        vm.prank(relayer);
        token.transferFrom(pagador, oraculo, 400);

        assertEq(token.allowance(pagador, relayer), 600);
        assertEq(token.balanceOf(oraculo), 400);
    }

    function test_RevertWhen_SeExcedeElPermiso() public {
        vm.prank(pagador);
        token.approve(relayer, 100);

        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(PoolCredit.InsufficientAllowance.selector, pagador, relayer, 100, 101)
        );
        token.transferFrom(pagador, oraculo, 101);
    }

    /// @notice El total nunca cambia por transferir: es la misma invariante de conservacion que
    ///         exige el splitter, aplicada al token.
    function testFuzz_LasTransferenciasConservanElTotal(uint256 monto) public {
        monto = bound(monto, 0, SUPPLY);
        vm.prank(pagador);
        token.transfer(oraculo, monto);

        assertEq(token.balanceOf(pagador) + token.balanceOf(oraculo), SUPPLY);
        assertEq(token.totalSupply(), SUPPLY);
    }
}
