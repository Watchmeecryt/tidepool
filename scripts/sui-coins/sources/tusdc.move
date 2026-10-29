/// Tidepool test USDC (testnet only, no value). 6 decimals.
#[allow(deprecated_usage)]
module tidepool_coins::tusdc {
    use sui::coin;

    public struct TUSDC has drop {}

    fun init(witness: TUSDC, ctx: &mut TxContext) {
        let (treasury, metadata) = coin::create_currency(
            witness, 6, b"tUSDC", b"Tidepool Test USDC",
            b"Tidepool testnet-only USDC. No value.", option::none(), ctx);
        transfer::public_freeze_object(metadata);
        transfer::public_transfer(treasury, ctx.sender());
    }
}
