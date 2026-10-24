//! Tidepool testnet token: a plain NEP-141 fungible token. The owner, and minters the owner allows, can `mint`.
//! Testnet only. These tokens have no value and are not bridged from any real asset.
use near_contract_standards::fungible_token::metadata::{FungibleTokenMetadata, FungibleTokenMetadataProvider, FT_METADATA_SPEC};
use near_contract_standards::fungible_token::{FungibleToken, FungibleTokenCore, FungibleTokenResolver};
use near_contract_standards::storage_management::{StorageBalance, StorageBalanceBounds, StorageManagement};
use near_sdk::json_types::U128;
use near_sdk::{env, near, require, AccountId, BorshStorageKey, NearToken, PanicOnDefault, PromiseOrValue};
use near_sdk::borsh::BorshSerialize;
use near_sdk::collections::LookupSet;

/// Minter allowlist, kept outside the state struct so upgrades stay state-compatible.
fn minters() -> LookupSet<AccountId> { LookupSet::new(b"m".to_vec()) }

#[derive(BorshSerialize, BorshStorageKey)]
#[borsh(crate = "near_sdk::borsh")]
enum Key { Ft }

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    token: FungibleToken,
    owner_id: AccountId,
    name: String,
    symbol: String,
    decimals: u8,
}

#[near]
impl Contract {
    #[init]
    pub fn new(owner_id: AccountId, name: String, symbol: String, decimals: u8) -> Self {
        let mut token = FungibleToken::new(Key::Ft);
        token.internal_register_account(&owner_id);
        Self { token, owner_id, name, symbol, decimals }
    }

    /// Mint (owner or allowed minter). Registers storage for `account_id` if needed (paid from contract balance).
    pub fn mint(&mut self, account_id: AccountId, amount: U128) {
        let caller = env::predecessor_account_id();
        require!(caller == self.owner_id || minters().contains(&caller), "owner or minter only");
        if !self.token.accounts.contains_key(&account_id) {
            self.token.internal_register_account(&account_id);
        }
        self.token.internal_deposit(&account_id, amount.0);
        near_contract_standards::fungible_token::events::FtMint { owner_id: &account_id, amount: amount, memo: Some("tidepool testnet mint") }.emit();
    }

    pub fn owner_id(&self) -> AccountId { self.owner_id.clone() }

    fn assert_owner(&self) { require!(env::predecessor_account_id() == self.owner_id, "owner only"); }

    /// Owner-only: hand ownership to another account.
    pub fn set_owner(&mut self, new_owner: AccountId) {
        self.assert_owner();
        if !self.token.accounts.contains_key(&new_owner) { self.token.internal_register_account(&new_owner); }
        env::log_str(&format!("owner changed from {} to {}", self.owner_id, new_owner));
        self.owner_id = new_owner;
    }

    /// Owner-only: allow an account (for example the faucet) to mint.
    pub fn add_minter(&mut self, account_id: AccountId) { self.assert_owner(); minters().insert(&account_id); }
    /// Owner-only: revoke a minter.
    pub fn remove_minter(&mut self, account_id: AccountId) { self.assert_owner(); minters().remove(&account_id); }
    pub fn is_minter(&self, account_id: AccountId) -> bool { minters().contains(&account_id) }
}

#[near]
impl FungibleTokenCore for Contract {
    #[payable]
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) { self.token.ft_transfer(receiver_id, amount, memo) }
    #[payable]
    fn ft_transfer_call(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>, msg: String) -> PromiseOrValue<U128> { self.token.ft_transfer_call(receiver_id, amount, memo, msg) }
    fn ft_total_supply(&self) -> U128 { self.token.ft_total_supply() }
    fn ft_balance_of(&self, account_id: AccountId) -> U128 { self.token.ft_balance_of(account_id) }
}

#[near]
impl FungibleTokenResolver for Contract {
    #[private]
    fn ft_resolve_transfer(&mut self, sender_id: AccountId, receiver_id: AccountId, amount: U128) -> U128 {
        let (used, _burned) = self.token.internal_ft_resolve_transfer(&sender_id, receiver_id, amount);
        used.into()
    }
}

#[near]
impl StorageManagement for Contract {
    #[payable]
    fn storage_deposit(&mut self, account_id: Option<AccountId>, registration_only: Option<bool>) -> StorageBalance { self.token.storage_deposit(account_id, registration_only) }
    #[payable]
    fn storage_withdraw(&mut self, amount: Option<NearToken>) -> StorageBalance { self.token.storage_withdraw(amount) }
    #[payable]
    fn storage_unregister(&mut self, force: Option<bool>) -> bool { self.token.storage_unregister(force) }
    fn storage_balance_bounds(&self) -> StorageBalanceBounds { self.token.storage_balance_bounds() }
    fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> { self.token.storage_balance_of(account_id) }
}

#[near]
impl FungibleTokenMetadataProvider for Contract {
    fn ft_metadata(&self) -> FungibleTokenMetadata {
        FungibleTokenMetadata { spec: FT_METADATA_SPEC.to_string(), name: self.name.clone(), symbol: self.symbol.clone(), icon: None, reference: None, reference_hash: None, decimals: self.decimals }
    }
}
