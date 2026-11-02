use borsh::{BorshDeserialize, BorshSerialize};

use crate::Reason;

const NS_PER_DAY: u64 = 86_400_000_000_000;

pub const fn day_of(now_ns: u64) -> u64 {
    now_ns / NS_PER_DAY
}

#[derive(Clone, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub enum Token {
    Native,
    Ft(String),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub enum MandateStatus {
    Active,
    Revoked,
    Closed,
}

#[derive(Clone, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub struct Mandate {
    pub id: u64,
    pub owner: String,
    pub agent: String,
    pub payees: Vec<String>,
    pub token: Token,
    pub max_total: u128,
    pub max_per_payment: u128,
    pub purpose_hash: [u8; 32],
    pub expires_at: u64,
    pub max_requests: u32,
    pub max_checks_per_day: u32,
    pub park_ttl: u64,
    pub status: MandateStatus,
    pub balance: u128,
    pub reserved: u128,
    pub spent: u128,
    pub checker_budget: u128,
    pub storage_balance: u128,
    pub requests_stored: u32,
    pub checks_day: u64,
    pub checks_today: u32,
}

impl Mandate {
    pub fn checks_on(&self, day: u64) -> u32 {
        if self.checks_day == day {
            self.checks_today
        } else {
            0
        }
    }

    pub fn is_expired(&self, now_ns: u64) -> bool {
        now_ns >= self.expires_at
    }

    pub fn withdrawable(&self) -> u128 {
        self.balance.saturating_sub(self.reserved)
    }

    /// Holds budget for an accepted request. Runs synchronously with the rules,
    /// so a second request sees the reduced budget.
    pub fn reserve(
        &mut self,
        amount: u128,
        day: u64,
        check_cost: u128,
        storage_cost: u128,
    ) -> Result<(), Reason> {
        let reserved = self.reserved.checked_add(amount).ok_or(Reason::Overflow)?;
        let committed = reserved.checked_add(self.spent).ok_or(Reason::Overflow)?;
        if committed > self.max_total {
            return Err(Reason::OverTotal);
        }
        if reserved > self.balance {
            return Err(Reason::InsufficientBalance);
        }
        let budget = self
            .checker_budget
            .checked_sub(check_cost)
            .ok_or(Reason::CheckerBudgetExhausted)?;
        let storage = self
            .storage_balance
            .checked_sub(storage_cost)
            .ok_or(Reason::RequestLimit)?;
        let requests = self
            .requests_stored
            .checked_add(1)
            .ok_or(Reason::Overflow)?;
        let checks = self.checks_on(day).checked_add(1).ok_or(Reason::Overflow)?;

        self.reserved = reserved;
        self.checker_budget = budget;
        self.storage_balance = storage;
        self.requests_stored = requests;
        self.checks_day = day;
        self.checks_today = checks;
        Ok(())
    }

    pub fn release(&mut self, amount: u128) -> Result<(), Reason> {
        self.reserved = self.reserved.checked_sub(amount).ok_or(Reason::Overflow)?;
        Ok(())
    }

    pub fn settle_paid(&mut self, amount: u128) -> Result<(), Reason> {
        let reserved = self.reserved.checked_sub(amount).ok_or(Reason::Overflow)?;
        let balance = self.balance.checked_sub(amount).ok_or(Reason::Overflow)?;
        let spent = self.spent.checked_add(amount).ok_or(Reason::Overflow)?;
        self.reserved = reserved;
        self.balance = balance;
        self.spent = spent;
        Ok(())
    }

    pub fn fund(&mut self, amount: u128) -> Result<(), Reason> {
        self.balance = self.balance.checked_add(amount).ok_or(Reason::Overflow)?;
        Ok(())
    }

    pub fn withdraw(&mut self, amount: u128) -> Result<(), Reason> {
        if amount == 0 || amount > self.withdrawable() {
            return Err(Reason::OverWithdrawable);
        }
        self.balance = self.balance.checked_sub(amount).ok_or(Reason::Overflow)?;
        Ok(())
    }

    pub fn invariants_hold(&self) -> bool {
        self.reserved <= self.balance
            && self
                .reserved
                .checked_add(self.spent)
                .is_some_and(|committed| committed <= self.max_total)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub enum PaymentStatus {
    Checking,
    Parked,
    Paying,
    Paid,
    Blocked,
    Rejected,
    Failed,
}

impl PaymentStatus {
    pub const fn as_str(self) -> &'static str {
        match self {
            PaymentStatus::Checking => "Checking",
            PaymentStatus::Parked => "Parked",
            PaymentStatus::Paying => "Paying",
            PaymentStatus::Paid => "Paid",
            PaymentStatus::Blocked => "Blocked",
            PaymentStatus::Rejected => "Rejected",
            PaymentStatus::Failed => "Failed",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub struct PaymentRequest {
    pub id: u64,
    pub mandate_id: u64,
    pub payee: String,
    pub amount: u128,
    pub invoice_hash: [u8; 32],
    pub blob_ref: String,
    pub memo: String,
    pub status: PaymentStatus,
    pub reason: Reason,
    pub created_at: u64,
    pub updated_at: u64,
    pub day: u64,
}
