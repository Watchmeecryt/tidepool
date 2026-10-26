// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
}

/// @dev Deployed with CREATE2 by the vault at a per-quote deposit address. In its constructor it
/// forwards the whole balance of the token the vault is sweeping (and any native ETH) to the vault and
/// self-destructs in the same transaction, so the same address can be swept again later.
contract TidepoolDepositForwarder {
    constructor() {
        address token = TidepoolVault(payable(msg.sender)).sweepingToken();
        uint256 bal = IERC20(token).balanceOf(address(this));
        if (bal > 0) require(IERC20(token).transfer(msg.sender, bal), "transfer");
        selfdestruct(payable(msg.sender));
    }
}

/// @title Tidepool testnet bridge vault (trusted relayer, testnet only)
/// @notice Holds bridged test tokens. Users deposit by sending ERC-20s to a per-quote deposit address
/// (`depositAddress(salt)`); the Tidepool relayer sweeps it into the vault and credits the matching
/// NEP-141 inside the NEAR Intents verifier. Withdrawals from NEAR are paid out by `release`.
/// The relayer is fully trusted. This is a testnet convenience, not a trust-minimised bridge.
contract TidepoolVault {
    address public owner;
    mapping(address => bool) public isRelayer;
    mapping(bytes32 => bool) public released;
    address public sweepingToken;

    event Swept(bytes32 indexed salt, address indexed depositAddress, address indexed token, uint256 amount);
    event Released(bytes32 indexed id, address indexed token, address indexed to, uint256 amount);
    event RelayerSet(address indexed relayer, bool enabled);
    event OwnerSet(address indexed owner);

    modifier onlyRelayer() { require(isRelayer[msg.sender], "not relayer"); _; }

    constructor(address relayer) {
        owner = msg.sender; emit OwnerSet(msg.sender);
        isRelayer[relayer] = true; emit RelayerSet(relayer, true);
    }

    /// @notice The deposit address for a quote salt (keccak256 of the 1Click correlationId).
    function depositAddress(bytes32 salt) public view returns (address) {
        bytes32 h = keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, keccak256(type(TidepoolDepositForwarder).creationCode)));
        return address(uint160(uint256(h)));
    }

    /// @notice Moves everything held at `depositAddress(salt)` in `token` into the vault.
    function sweep(bytes32 salt, address token) external onlyRelayer returns (uint256 amount) {
        address d = depositAddress(salt);
        amount = IERC20(token).balanceOf(d);
        require(amount > 0, "empty");
        sweepingToken = token;
        new TidepoolDepositForwarder{salt: salt}();
        sweepingToken = address(0);
        emit Swept(salt, d, token, amount);
    }

    /// @notice Pays out a withdrawal or refund from NEAR. `id` makes each payout idempotent.
    function release(bytes32 id, address token, address to, uint256 amount) external onlyRelayer {
        require(!released[id], "already released");
        released[id] = true;
        require(IERC20(token).transfer(to, amount), "transfer");
        emit Released(id, token, to, amount);
    }

    function setRelayer(address r, bool on) external { require(msg.sender == owner, "not owner"); isRelayer[r] = on; emit RelayerSet(r, on); }
    function setOwner(address a) external { require(msg.sender == owner, "not owner"); owner = a; emit OwnerSet(a); }
    receive() external payable {}
}
