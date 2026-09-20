// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {PoolCredit} from "../src/PoolCredit.sol";

/// @notice Genera el fixture que verifica la firma ERC-3009 del cliente x402.
///
/// @dev El cliente construye en TypeScript el mismo digest EIP-712 que el token valida en
///      Solidity. Si divergieran, el agente firmaria autorizaciones que el token rechaza y el
///      pago fallaria recien al liquidar, cuando ya se consumio una llamada al oraculo.
///
///      En vez de confiar en que ambas implementaciones coinciden, este test le pide el digest
///      al contrato y lo guarda. La suite de Jest comprueba contra ese valor.
///
///      Regenerar: npm run fixtures:x402
contract Erc3009FixtureTest is Test {
    function test_GeneraFixtureDeDigest() public {
        // chainId fijo para que el fixture sea reproducible en cualquier maquina.
        vm.chainId(133);

        address pagador = 0x92302923eBE05EC3984A49755346Cf02327e7CA5;
        address oraculo = 0xcd23dAd3cDb7eb7046829f033c92107fC60F316b;

        PoolCredit token = new PoolCredit(pagador, 1_000_000e6);

        uint256 value = 1_000;
        uint256 validAfter = 1_700_000_000;
        uint256 validBefore = 1_700_000_300;
        bytes32 nonce = keccak256("llamada-tarifa-fixture");

        bytes32 structHash = keccak256(
            abi.encode(
                token.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(),
                pagador,
                oraculo,
                value,
                validAfter,
                validBefore,
                nonce
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), structHash));

        string memory json = "erc3009";
        vm.serializeUint(json, "chainId", block.chainid);
        vm.serializeAddress(json, "asset", address(token));
        vm.serializeString(json, "name", token.name());
        vm.serializeString(json, "version", "1");
        vm.serializeAddress(json, "from", pagador);
        vm.serializeAddress(json, "to", oraculo);
        vm.serializeUint(json, "value", value);
        vm.serializeUint(json, "validAfter", validAfter);
        vm.serializeUint(json, "validBefore", validBefore);
        vm.serializeBytes32(json, "nonce", nonce);
        string memory salida = vm.serializeBytes32(json, "expectedDigest", digest);

        vm.writeJson(salida, "../fixtures/erc3009-digest.json");

        assertTrue(digest != bytes32(0), "el digest no puede ser cero");
    }
}
