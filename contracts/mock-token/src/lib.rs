//! Minimal NEP-141 token for tests. Transfers to unregistered accounts fail, as they
//! do on a real token.

use near_sdk::json_types::U128;
use near_sdk::store::LookupMap;
use near_sdk::{
    env, ext_contract, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise,
    PromiseOrValue,
};

#[ext_contract(ext_receiver)]
#[allow(dead_code)]
trait Receiver {
    fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> U128;
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct MockToken {
    balances: LookupMap<AccountId, u128>,
}

#[near]
impl MockToken {
    #[init]
    pub fn new() -> Self {
        Self { balances: LookupMap::new(b"b") }
    }

    pub fn mint(&mut self, account_id: AccountId, amount: U128) {
        let balance = self.balances.get(&account_id).copied().unwrap_or(0);
        self.balances.insert(account_id, balance + amount.0);
    }

    #[payable]
    pub fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        let _ = memo;
        require!(env::attached_deposit() == NearToken::from_yoctonear(1), "requires 1 yocto");
        self.move_tokens(&env::predecessor_account_id(), &receiver_id, amount.0);
    }

    #[payable]
    pub fn ft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        msg: String,
    ) -> Promise {
        let _ = memo;
        require!(env::attached_deposit() == NearToken::from_yoctonear(1), "requires 1 yocto");
        let sender = env::predecessor_account_id();
        self.move_tokens(&sender, &receiver_id, amount.0);
        ext_receiver::ext(receiver_id.clone())
            .with_static_gas(Gas::from_tgas(30))
            .ft_on_transfer(sender.clone(), amount, msg)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(Gas::from_tgas(10))
                    .resolve_transfer(sender, receiver_id, amount),
            )
    }

    #[private]
    pub fn resolve_transfer(
        &mut self,
        sender: AccountId,
        receiver: AccountId,
        amount: U128,
        #[callback_result] unused: Result<U128, near_sdk::PromiseError>,
    ) -> PromiseOrValue<U128> {
        let unused = unused.map_or(amount.0, |unused| unused.0.min(amount.0));
        if unused > 0 {
            self.move_tokens(&receiver, &sender, unused);
        }
        PromiseOrValue::Value(U128(amount.0 - unused))
    }

    pub fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        U128(self.balances.get(&account_id).copied().unwrap_or(0))
    }
}

impl MockToken {
    fn move_tokens(&mut self, from: &AccountId, to: &AccountId, amount: u128) {
        let from_balance = self.balances.get(from).copied().unwrap_or(0);
        require!(from_balance >= amount, "insufficient balance");
        let to_balance = self.balances.get(to).copied();
        require!(to_balance.is_some() || from == to, "account not registered");
        self.balances.insert(from.clone(), from_balance - amount);
        let to_balance = self.balances.get(to).copied().unwrap_or(0);
        self.balances.insert(to.clone(), to_balance + amount);
    }
}
