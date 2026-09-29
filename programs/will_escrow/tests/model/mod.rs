//! A pure-Rust reference model of will_escrow jobs: state machine, token
//! balances and timing, written independently of the program's code. The
//! fuzz test replays random operations on both and compares after each step.

use std::collections::BTreeMap;

/// Signers, in the order the fuzz runner maps them to keypairs.
pub const CUSTOMER: usize = 0;
pub const OPERATOR: usize = 1;
pub const ADMIN: usize = 2;

pub const FUNDED: u8 = 0;
pub const QUOTED: u8 = 1;
pub const APPROVED: u8 = 2;
pub const RELEASED: u8 = 3;
pub const PURCHASED: u8 = 4;
pub const PROVEN: u8 = 5;
pub const DISPUTED: u8 = 6;

/// The default quote (see `quote_args`): 53.98 zł within a 60.00 zł ceiling,
/// valid for 30 minutes.
pub const QUOTE_TTL: i64 = 1_800;

#[derive(Clone, Debug)]
pub enum Op {
    Create {
        id: u64,
        budget: u64,
        mandate_cap: u64,
        mandate_ttl: i64,
    },
    Quote {
        id: u64,
        signer: usize,
        release_cap: u64,
        valid: bool,
    },
    Approve {
        id: u64,
        signer: usize,
    },
    Release {
        id: u64,
        signer: usize,
        amount: u64,
    },
    Record {
        id: u64,
        signer: usize,
        charged: u64,
    },
    Prove {
        id: u64,
        signer: usize,
    },
    Dispute {
        id: u64,
        signer: usize,
    },
    Settle {
        id: u64,
        signer: usize,
    },
    Resolve {
        id: u64,
        signer: usize,
        fee: u64,
    },
    /// The operator returns exactly what is missing plus `extra`; the customer
    /// returns `extra`.
    Cancel {
        id: u64,
        signer: usize,
        extra: u64,
    },
    Refund {
        id: u64,
    },
    Advance {
        seconds: i64,
    },
    Pause {
        on: bool,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Job {
    pub status: u8,
    pub budget: u64,
    pub reserve: u64,
    pub fee_bps: u64,
    pub release_cap: u64,
    pub released: u64,
    pub charged: u64,
    pub quote_expires_at: i64,
    pub expires_at: i64,
    pub window_ends_at: i64,
    pub dispute_expires_at: i64,
    pub mandate_cap: u64,
    pub mandate_expires_at: i64,
    pub vault: u64,
}

#[derive(Clone, Debug)]
pub struct Model {
    pub now: i64,
    pub paused: bool,
    pub fee_bps: u64,
    pub dispute_window: i64,
    pub job_timeout: i64,
    pub dispute_timeout: i64,
    pub customer: u64,
    pub operator: u64,
    pub treasury: u64,
    pub funding: u64,
    pub jobs: BTreeMap<u64, Job>,
}

fn mul(a: u64, b: u64) -> Option<u64> {
    a.checked_mul(b)
}

impl Model {
    /// The customer-facing amount if `id` were cancelled by the operator now.
    pub fn missing(&self, id: u64) -> u64 {
        self.jobs.get(&id).map_or(0, |job| {
            (job.budget + job.reserve).saturating_sub(job.vault)
        })
    }

    fn close(&mut self, id: u64, fee: u64) {
        let job = self.jobs.remove(&id).unwrap();
        self.treasury += fee;
        self.customer += job.vault - fee;
    }

    /// Applies `op`; returns whether the program must accept it.
    pub fn apply(&mut self, op: &Op) -> bool {
        let now = self.now;
        match *op {
            Op::Advance { seconds } => {
                self.now += seconds;
                true
            }
            Op::Pause { on } => {
                self.paused = on;
                true
            }
            Op::Create {
                id,
                budget,
                mandate_cap,
                mandate_ttl,
            } => {
                let expires_at = now + self.job_timeout;
                let mandate_expires_at = now + mandate_ttl;
                let reserve = mul(budget, self.fee_bps)
                    .and_then(|x| x.checked_add(9_999))
                    .map(|x| x / 10_000);
                let total = reserve.and_then(|r| budget.checked_add(r));
                let ok = !self.paused
                    && !self.jobs.contains_key(&id)
                    && budget > 0
                    && (mandate_cap == 0 || mandate_expires_at <= expires_at)
                    && total.is_some_and(|t| t <= self.customer);
                if ok {
                    let (reserve, total) = (reserve.unwrap(), total.unwrap());
                    self.customer -= total;
                    self.jobs.insert(
                        id,
                        Job {
                            status: FUNDED,
                            budget,
                            reserve,
                            fee_bps: self.fee_bps,
                            release_cap: 0,
                            released: 0,
                            charged: 0,
                            quote_expires_at: 0,
                            expires_at,
                            window_ends_at: 0,
                            dispute_expires_at: 0,
                            mandate_cap,
                            mandate_expires_at,
                            vault: total,
                        },
                    );
                }
                ok
            }
            Op::Quote {
                id,
                signer,
                release_cap,
                valid,
            } => {
                let Some(job) = self.jobs.get_mut(&id) else {
                    return false;
                };
                let quote_expires_at = now + QUOTE_TTL;
                let ok = signer == OPERATOR
                    && matches!(job.status, FUNDED | QUOTED)
                    && valid
                    && release_cap > 0
                    && release_cap <= job.budget
                    && quote_expires_at <= job.expires_at;
                if ok {
                    job.release_cap = release_cap;
                    job.quote_expires_at = quote_expires_at;
                    let mandate = job.mandate_cap > 0
                        && release_cap <= job.mandate_cap
                        && now < job.mandate_expires_at;
                    job.status = if mandate { APPROVED } else { QUOTED };
                }
                ok
            }
            Op::Approve { id, signer } => {
                let Some(job) = self.jobs.get_mut(&id) else {
                    return false;
                };
                let ok = signer == CUSTOMER && job.status == QUOTED && now < job.quote_expires_at;
                if ok {
                    job.status = APPROVED;
                }
                ok
            }
            Op::Release { id, signer, amount } => {
                let paused = self.paused;
                let Some(job) = self.jobs.get_mut(&id) else {
                    return false;
                };
                let total = job.released.checked_add(amount);
                let ok = !paused
                    && signer == OPERATOR
                    && matches!(job.status, APPROVED | RELEASED)
                    && amount > 0
                    && total.is_some_and(|t| t <= job.release_cap)
                    && (job.status == RELEASED || now < job.quote_expires_at);
                if ok {
                    job.released += amount;
                    job.vault -= amount;
                    job.status = RELEASED;
                    self.funding += amount;
                }
                ok
            }
            Op::Record {
                id,
                signer,
                charged,
            } => {
                let operator = self.operator;
                let Some(job) = self.jobs.get_mut(&id) else {
                    return false;
                };
                let ok = signer == OPERATOR
                    && job.status == RELEASED
                    && charged > 0
                    && charged <= job.released
                    && job.released - charged <= operator;
                if ok {
                    let excess = job.released - charged;
                    job.vault += excess;
                    job.charged = charged;
                    job.status = PURCHASED;
                    self.operator -= excess;
                }
                ok
            }
            Op::Prove { id, signer } => {
                let window = self.dispute_window;
                let Some(job) = self.jobs.get_mut(&id) else {
                    return false;
                };
                let ok = signer == OPERATOR && job.status == PURCHASED;
                if ok {
                    job.window_ends_at = now + window;
                    job.status = PROVEN;
                }
                ok
            }
            Op::Dispute { id, signer } => {
                let timeout = self.dispute_timeout;
                let Some(job) = self.jobs.get_mut(&id) else {
                    return false;
                };
                let ok = signer == CUSTOMER && job.status == PROVEN && now < job.window_ends_at;
                if ok {
                    job.dispute_expires_at = now + timeout;
                    job.status = DISPUTED;
                }
                ok
            }
            Op::Settle { id, signer } => {
                let Some(job) = self.jobs.get(&id) else {
                    return false;
                };
                let ok = job.status == PROVEN && (signer == CUSTOMER || now >= job.window_ends_at);
                if ok {
                    let fee = job.charged * job.fee_bps / 10_000;
                    self.close(id, fee);
                }
                ok
            }
            Op::Resolve { id, signer, fee } => {
                let Some(job) = self.jobs.get(&id) else {
                    return false;
                };
                let earned = job.charged * job.fee_bps / 10_000;
                let ok = signer == ADMIN && job.status == DISPUTED && fee <= earned;
                if ok {
                    self.close(id, fee);
                }
                ok
            }
            Op::Cancel { id, signer, extra } => {
                let missing = self.missing(id);
                let operator = self.operator;
                let Some(job) = self.jobs.get_mut(&id) else {
                    return false;
                };
                let ok = if signer == CUSTOMER && matches!(job.status, FUNDED | QUOTED) {
                    extra == 0
                } else if signer == OPERATOR {
                    let returned = missing + extra;
                    job.status <= PROVEN && extra == 0 && returned <= operator
                } else {
                    false
                };
                if ok {
                    if signer == OPERATOR {
                        job.vault += missing;
                        self.operator -= missing;
                    }
                    self.close(id, 0);
                }
                ok
            }
            Op::Refund { id } => {
                let Some(job) = self.jobs.get(&id) else {
                    return false;
                };
                let deadline = match job.status {
                    FUNDED..=PURCHASED => Some(job.expires_at),
                    DISPUTED => Some(job.dispute_expires_at),
                    _ => None,
                };
                let ok = deadline.is_some_and(|deadline| now >= deadline);
                if ok {
                    self.close(id, 0);
                }
                ok
            }
        }
    }
}
