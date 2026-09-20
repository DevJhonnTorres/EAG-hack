// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Porcion minima de la interfaz de Gnosis Safe que este protocolo necesita.
/// @dev Se declara a mano en vez de traer el paquete completo de Safe: solo se usan tres
///      funciones y evitar la dependencia mantiene el arbol de compilacion chico y auditable.
interface ISafeProxyFactory {
    function createProxyWithNonce(address singleton, bytes memory initializer, uint256 saltNonce)
        external
        returns (address proxy);
}

interface ISafe {
    function setup(
        address[] calldata owners,
        uint256 threshold,
        address to,
        bytes calldata data,
        address fallbackHandler,
        address paymentToken,
        uint256 payment,
        address payable paymentReceiver
    ) external;

    function getTransactionHash(
        address to,
        uint256 value,
        bytes calldata data,
        uint8 operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address refundReceiver,
        uint256 nonce
    ) external view returns (bytes32);

    function execTransaction(
        address to,
        uint256 value,
        bytes calldata data,
        uint8 operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address payable refundReceiver,
        bytes memory signatures
    ) external payable returns (bool success);

    function nonce() external view returns (uint256);

    function getThreshold() external view returns (uint256);

    function isOwner(address owner) external view returns (bool);
}
