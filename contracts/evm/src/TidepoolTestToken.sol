// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title Tidepool test ERC-20 (testnet only, no value)
/// @notice Minimal ERC-20 with owner/minters and a public, rate-limited faucet.
contract TidepoolTestToken {
    string public name;
    string public symbol;
    uint8 public immutable decimals;
    uint256 public totalSupply;
    uint256 public immutable dripAmount;
    uint256 public constant DRIP_COOLDOWN = 1 hours;
    address public owner;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => bool) public isMinter;
    mapping(address => uint256) public lastDrip;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event MinterSet(address indexed account, bool enabled);
    event OwnerSet(address indexed owner);

    constructor(string memory _name, string memory _symbol, uint8 _decimals, uint256 _dripAmount) {
        name = _name; symbol = _symbol; decimals = _decimals; dripAmount = _dripAmount;
        owner = msg.sender; isMinter[msg.sender] = true;
        emit OwnerSet(msg.sender); emit MinterSet(msg.sender, true);
    }

    function transfer(address to, uint256 v) external returns (bool) { _move(msg.sender, to, v); return true; }
    function approve(address s, uint256 v) external returns (bool) { allowance[msg.sender][s] = v; emit Approval(msg.sender, s, v); return true; }
    function transferFrom(address f, address to, uint256 v) external returns (bool) {
        uint256 a = allowance[f][msg.sender];
        if (a != type(uint256).max) { require(a >= v, "allowance"); allowance[f][msg.sender] = a - v; }
        _move(f, to, v); return true;
    }

    function mint(address to, uint256 v) external { require(isMinter[msg.sender], "not minter"); _mint(to, v); }
    /// @notice Anyone can drip `dripAmount` to themselves once per hour.
    function faucet() external {
        require(block.timestamp >= lastDrip[msg.sender] + DRIP_COOLDOWN, "cooldown");
        lastDrip[msg.sender] = block.timestamp; _mint(msg.sender, dripAmount);
    }
    function setMinter(address a, bool on) external { require(msg.sender == owner, "not owner"); isMinter[a] = on; emit MinterSet(a, on); }
    function setOwner(address a) external { require(msg.sender == owner, "not owner"); owner = a; emit OwnerSet(a); }

    function _mint(address to, uint256 v) internal { totalSupply += v; balanceOf[to] += v; emit Transfer(address(0), to, v); }
    function _move(address f, address to, uint256 v) internal {
        require(balanceOf[f] >= v, "balance"); balanceOf[f] -= v; balanceOf[to] += v; emit Transfer(f, to, v);
    }
}
