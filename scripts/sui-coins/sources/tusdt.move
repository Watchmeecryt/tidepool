/// Tidepool test USDT (testnet only, no value). 6 decimals.
#[allow(deprecated_usage)]
module tidepool_coins::tusdt {
    use sui::coin;

    public struct TUSDT has drop {}

    fun init(witness: TUSDT, ctx: &mut TxContext) {
        let (treasury, metadata) = coin::create_currency(
            witness, 6, b"tUSDT", b"Tidepool Test USDT",
            b"Tidepool testnet-only USDT. No value.", option::none(), ctx);
        transfer::public_freeze_object(metadata);
        transfer::public_transfer(treasury, ctx.sender());
    }
}
