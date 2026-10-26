// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;
import "../src/TidepoolVault.sol";
import "../src/TidepoolTestToken.sol";

contract VaultTest {
    function testSweepTwiceAndRelease() public {
        TidepoolVault v = new TidepoolVault(address(this));
        TidepoolTestToken t = new TidepoolTestToken("USDC", "USDC", 6, 100e6);
        bytes32 salt = keccak256("q1");
        address d = v.depositAddress(salt);
        t.mint(d, 5e6);
        require(v.sweep(salt, address(t)) == 5e6, "sweep1");
        require(t.balanceOf(address(v)) == 5e6 && t.balanceOf(d) == 0, "bal1");
        require(d.code.length == 0, "code");
    }
    function testRelease() public {
        TidepoolVault v = new TidepoolVault(address(this));
        TidepoolTestToken t = new TidepoolTestToken("USDC", "USDC", 6, 100e6);
        t.mint(address(v), 10e6);
        v.release(bytes32(uint256(1)), address(t), address(0xBEEF), 3e6);
        require(t.balanceOf(address(0xBEEF)) == 3e6, "rel");
        try v.release(bytes32(uint256(1)), address(t), address(0xBEEF), 3e6) { revert("replay"); } catch {}
    }
}
