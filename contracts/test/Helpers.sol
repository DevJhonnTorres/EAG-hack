// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @dev Wallet que rechaza cualquier pago entrante. Modela al socio cuya direccion es un
///      contrato sin `receive`, un caso que no debe poder bloquear al resto del pool.
contract RejectingRecipient {
    error Nope();

    receive() external payable {
        revert Nope();
    }
}

/// @dev Wallet hostil que quema todo el gas disponible al recibir. Sirve para comprobar que
///      el presupuesto de gas por pago evita el bloqueo de la liquidacion completa.
contract GasBurner {
    uint256 public slot;

    receive() external payable {
        while (true) {
            slot += 1;
        }
    }
}

/// @dev Wallet que acepta fondos normalmente. Contraparte sana de las anteriores.
contract AcceptingRecipient {
    receive() external payable {}
}
