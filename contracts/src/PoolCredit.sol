// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title PoolCredit
/// @notice Token de credito operativo del pool, con autorizaciones firmadas (ERC-3009).
///
/// @dev Existe para que el orquestador pueda pagar por su cuenta los datos que necesita.
///
///      El motor de calculo necesita insumos que no son gratis: la tarifa electrica vigente y
///      el precio del coin que se mina. Con x402, el proveedor de esos datos responde `402
///      Payment Required` y el orquestador paga por llamada. Para que ese pago no requiera que
///      un humano apruebe una transaccion cada vez, el esquema `exact` de x402 sobre EVM usa
///      ERC-3009: el pagador **firma** una autorizacion fuera de la cadena y el cobrador la
///      presenta y la liquida. El pagador nunca necesita gas ni estar despierto.
///
///      Ese es el bucle que cierra el proyecto: el hardware genera ingresos, el fondo de
///      mantenimiento reserva una porcion, y el agente paga sus propios insumos de datos con
///      esa reserva. Maquina a maquina, sin tarjeta de credito de por medio.
contract PoolCredit {
    string public constant name = "HashPool Credit";
    string public constant symbol = "HPC";
    uint8 public constant decimals = 6;

    /// @dev keccak256("TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)")
    bytes32 public constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH =
        0x7c7c6cdb67a18743f49ec6fa9b35f50d52ed05cbed4cc592e13b44501c1a2267;

    /// @dev keccak256("CancelAuthorization(address authorizer,bytes32 nonce)")
    bytes32 public constant CANCEL_AUTHORIZATION_TYPEHASH =
        0x158b0a9edf7a828aad02f63cd515c68ef2f50ba807396f6d12842833a1597429;

    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    uint256 public totalSupply;

    mapping(address account => uint256 balance) public balanceOf;
    mapping(address owner => mapping(address spender => uint256 allowance)) public allowance;

    /// @notice Estado de cada autorizacion firmada: true si ya fue usada o cancelada.
    mapping(address authorizer => mapping(bytes32 nonce => bool used)) public authorizationState;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce);
    event AuthorizationCanceled(address indexed authorizer, bytes32 indexed nonce);

    error InsufficientBalance(address from, uint256 balance, uint256 needed);
    error InsufficientAllowance(address owner, address spender, uint256 allowance, uint256 needed);
    error ZeroAddress();
    error AuthorizationNotYetValid(uint256 validAfter, uint256 currentTime);
    error AuthorizationExpired(uint256 validBefore, uint256 currentTime);
    error AuthorizationAlreadyUsed(address authorizer, bytes32 nonce);
    error InvalidSignature(address expected, address recovered);

    constructor(address initialHolder, uint256 initialSupply) {
        if (initialHolder == address(0)) revert ZeroAddress();
        totalSupply = initialSupply;
        balanceOf[initialHolder] = initialSupply;
        emit Transfer(address(0), initialHolder, initialSupply);
    }

    // --------------------------------------------------------------------
    // ERC-20
    // --------------------------------------------------------------------

    function transfer(address to, uint256 value) external returns (bool) {
        _transfer(msg.sender, to, value);
        return true;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 permitido = allowance[from][msg.sender];
        if (permitido != type(uint256).max) {
            if (permitido < value) revert InsufficientAllowance(from, msg.sender, permitido, value);
            allowance[from][msg.sender] = permitido - value;
        }
        _transfer(from, to, value);
        return true;
    }

    // --------------------------------------------------------------------
    // ERC-3009
    // --------------------------------------------------------------------

    /// @notice Dominio EIP-712 del token.
    /// @dev Se calcula en cada llamada en vez de cachearse: asi el token sigue siendo correcto
    ///      si la cadena se bifurca y cambia el chainId, que es justo cuando una firma de otra
    ///      cadena podria reutilizarse.
    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return keccak256(
            abi.encode(DOMAIN_TYPEHASH, keccak256(bytes(name)), keccak256("1"), block.chainid, address(this))
        );
    }

    /// @notice Ejecuta una transferencia que el pagador autorizo con su firma.
    ///
    /// @dev Cualquiera puede presentarla: quien la envia paga el gas, no el pagador. Eso es lo
    ///      que permite que un agente automatico pague sin tener gas ni estar en linea.
    ///
    ///      El `nonce` lo elige el pagador y no es secuencial, asi que puede firmar varias
    ///      autorizaciones en paralelo sin coordinarlas. Se marca como usado antes de mover
    ///      fondos, de modo que la misma autorizacion no pueda cobrarse dos veces.
    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        // Una ventana de validez es precisamente lo que ERC-3009 define en terminos del
        // reloj del bloque. El margen que un validador puede manipular es de segundos, y las
        // ventanas de x402 son de minutos, asi que no hay nada que explotar aca.
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp <= validAfter) revert AuthorizationNotYetValid(validAfter, block.timestamp);
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp >= validBefore) revert AuthorizationExpired(validBefore, block.timestamp);
        if (authorizationState[from][nonce]) revert AuthorizationAlreadyUsed(from, nonce);

        bytes32 structHash = keccak256(
            abi.encode(TRANSFER_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce)
        );
        _requireValidSignature(from, structHash, v, r, s);

        authorizationState[from][nonce] = true;
        emit AuthorizationUsed(from, nonce);

        _transfer(from, to, value);
    }

    /// @notice Anula una autorizacion que todavia no se cobro.
    function cancelAuthorization(address authorizer, bytes32 nonce, uint8 v, bytes32 r, bytes32 s) external {
        if (authorizationState[authorizer][nonce]) revert AuthorizationAlreadyUsed(authorizer, nonce);

        bytes32 structHash = keccak256(abi.encode(CANCEL_AUTHORIZATION_TYPEHASH, authorizer, nonce));
        _requireValidSignature(authorizer, structHash, v, r, s);

        authorizationState[authorizer][nonce] = true;
        emit AuthorizationCanceled(authorizer, nonce);
    }

    // --------------------------------------------------------------------
    // Interno
    // --------------------------------------------------------------------

    function _transfer(address from, address to, uint256 value) internal {
        if (to == address(0)) revert ZeroAddress();
        uint256 saldo = balanceOf[from];
        if (saldo < value) revert InsufficientBalance(from, saldo, value);

        unchecked {
            balanceOf[from] = saldo - value;
            balanceOf[to] += value;
        }
        emit Transfer(from, to, value);
    }

    function _requireValidSignature(address expected, bytes32 structHash, uint8 v, bytes32 r, bytes32 s)
        internal
        view
    {
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), structHash));
        address recovered = ecrecover(digest, v, r, s);
        // ecrecover devuelve la direccion cero ante una firma malformada; compararla contra el
        // firmante esperado cubre ese caso sin necesidad de un chequeo aparte.
        if (recovered != expected) revert InvalidSignature(expected, recovered);
    }
}
