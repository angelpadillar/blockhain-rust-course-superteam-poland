//! LiteSVM harness: `will_escrow.so` deployed through the upgradeable loader
//! with a real upgrade authority, a 6-decimal USDC-like mint, and token
//! accounts for every party. Build the program first:
//! `cargo build-sbf --manifest-path programs/will_escrow/Cargo.toml`.
// litesvm returns a large error type by value.
#![allow(dead_code, clippy::result_large_err)]

use {
    litesvm::{types::TransactionResult, LiteSVM},
    solana_account::Account,
    solana_instruction::{AccountMeta, Instruction},
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::versioned::VersionedTransaction,
    will_escrow::{
        state::{Config, Job, CONFIG_SEED, JOB_SEED, VAULT_SEED},
        util::bytes_of,
        Address, ID,
    },
};

pub const TOKEN_PROGRAM: Address =
    Address::from_str_const("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
pub const SYSTEM_PROGRAM: Address = Address::new_from_array([0; 32]);
pub const LOADER_V3: Address =
    Address::from_str_const("BPFLoaderUpgradeab1e11111111111111111111111");
pub const USDC: u64 = 1_000_000;
pub const START: i64 = 1_800_000_000;
pub const FEE_BPS: u16 = 500;
pub const DISPUTE_WINDOW: u32 = 86_400;
pub const JOB_TIMEOUT: u32 = 7 * 86_400;
pub const DISPUTE_TIMEOUT: u32 = 14 * 86_400;

pub struct Harness {
    pub svm: LiteSVM,
    pub upgrade_authority: Keypair,
    pub admin: Keypair,
    pub operator: Keypair,
    pub treasury: Keypair,
    pub customer: Keypair,
    pub stranger: Keypair,
    pub altitude: Keypair,
    pub mint_authority: Keypair,
    pub mint: Address,
    pub other_mint: Address,
    pub customer_token: Address,
    pub operator_token: Address,
    pub treasury_token: Address,
    pub funding: Address,
    pub stranger_token: Address,
    pub other_mint_funding: Address,
}

fn program_bytes() -> Vec<u8> {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../target/deploy/will_escrow.so"
    );
    std::fs::read(path).expect("build will_escrow.so first")
}

pub fn pda(seeds: &[&[u8]]) -> (Address, u8) {
    Address::find_program_address(seeds, &ID)
}

pub fn config_address() -> Address {
    pda(&[CONFIG_SEED]).0
}

pub fn job_address(customer: &Address, job_id: u64) -> Address {
    pda(&[JOB_SEED, customer.as_ref(), &job_id.to_le_bytes()]).0
}

pub fn vault_address(job: &Address) -> Address {
    pda(&[VAULT_SEED, job.as_ref()]).0
}

/// Instruction data: the 1-byte discriminator followed by the args struct.
pub fn data<T>(discriminator: u8, args: &T) -> Vec<u8> {
    let mut data = vec![discriminator];
    data.extend_from_slice(bytes_of(args));
    data
}

pub fn meta(address: Address, writable: bool, signer: bool) -> AccountMeta {
    AccountMeta {
        pubkey: address,
        is_writable: writable,
        is_signer: signer,
    }
}

/// The custom program error code a failed transaction returned, if any.
pub fn custom_error(result: &TransactionResult) -> Option<u32> {
    let text = format!("{:?}", result.as_ref().err()?.err);
    let start = text.find("Custom(")? + "Custom(".len();
    text[start..].split(')').next()?.parse().ok()
}

impl Harness {
    pub fn new() -> Self {
        let mut svm = LiteSVM::new();
        svm.add_program(ID, &program_bytes()).unwrap();
        let upgrade_authority = Keypair::new();
        let programdata = Address::find_program_address(&[ID.as_ref()], &LOADER_V3).0;
        let mut account = svm.get_account(&programdata).unwrap();
        account.data[12] = 1;
        account.data[13..45].copy_from_slice(upgrade_authority.pubkey().as_ref());
        svm.set_account(programdata, account).unwrap();

        let mut h = Self {
            svm,
            upgrade_authority,
            admin: Keypair::new(),
            operator: Keypair::new(),
            treasury: Keypair::new(),
            customer: Keypair::new(),
            stranger: Keypair::new(),
            altitude: Keypair::new(),
            mint_authority: Keypair::new(),
            mint: Address::default(),
            other_mint: Address::default(),
            customer_token: Address::default(),
            operator_token: Address::default(),
            treasury_token: Address::default(),
            funding: Address::default(),
            stranger_token: Address::default(),
            other_mint_funding: Address::default(),
        };
        for wallet in [
            &h.upgrade_authority,
            &h.admin,
            &h.operator,
            &h.treasury,
            &h.customer,
            &h.stranger,
            &h.mint_authority,
        ] {
            h.svm.airdrop(&wallet.pubkey(), 100_000_000_000).unwrap();
        }
        h.set_time(START);
        h.mint = h.create_mint();
        h.other_mint = h.create_mint();
        h.customer_token = h.create_token_account(h.mint, h.customer.pubkey());
        h.operator_token = h.create_token_account(h.mint, h.operator.pubkey());
        h.treasury_token = h.create_token_account(h.mint, h.treasury.pubkey());
        h.funding = h.create_token_account(h.mint, h.altitude.pubkey());
        h.stranger_token = h.create_token_account(h.mint, h.stranger.pubkey());
        h.other_mint_funding = h.create_token_account(h.other_mint, h.altitude.pubkey());
        h.mint_to(h.customer_token, 1_000 * USDC);
        h.mint_to(h.operator_token, 1_000 * USDC);
        h
    }

    /// Sends one instruction; the first signer pays the fee.
    pub fn send(&mut self, instruction: Instruction, signers: &[&Keypair]) -> TransactionResult {
        let message = Message::new_with_blockhash(
            &[instruction],
            Some(&signers[0].pubkey()),
            &self.svm.latest_blockhash(),
        );
        let transaction =
            VersionedTransaction::try_new(VersionedMessage::Legacy(message), signers).unwrap();
        let result = self.svm.send_transaction(transaction);
        self.svm.expire_blockhash();
        result
    }

    pub fn set_time(&mut self, unix_timestamp: i64) {
        let mut clock = self.svm.get_sysvar::<solana_clock::Clock>();
        clock.unix_timestamp = unix_timestamp;
        self.svm.set_sysvar(&clock);
    }

    pub fn now(&self) -> i64 {
        self.svm.get_sysvar::<solana_clock::Clock>().unix_timestamp
    }

    pub fn account(&self, address: &Address) -> Option<Account> {
        self.svm
            .get_account(address)
            .filter(|account| account.lamports > 0)
    }

    pub fn config(&self) -> Config {
        let data = self.account(&config_address()).expect("config exists").data;
        // SAFETY: Config is alignment 1 and the account holds at least its size.
        unsafe { (*(data.as_ptr() as *const Config)).clone() }
    }

    pub fn job(&self, address: &Address) -> Job {
        let data = self.account(address).expect("job exists").data;
        // SAFETY: Job is alignment 1 and the account holds at least its size.
        unsafe { (*(data.as_ptr() as *const Job)).clone() }
    }

    pub fn token_balance(&self, token_account: &Address) -> u64 {
        let data = self
            .account(token_account)
            .expect("token account exists")
            .data;
        u64::from_le_bytes(data[64..72].try_into().unwrap())
    }

    fn create_mint(&mut self) -> Address {
        let mint = Keypair::new();
        let lamports = self.svm.minimum_balance_for_rent_exemption(82);
        let payer = Keypair::try_from(self.mint_authority.to_bytes().as_slice()).unwrap();
        let create = solana_system_interface::instruction::create_account(
            &payer.pubkey(),
            &mint.pubkey(),
            lamports,
            82,
            &TOKEN_PROGRAM,
        );
        let init = spl_token_interface::instruction::initialize_mint2(
            &TOKEN_PROGRAM,
            &mint.pubkey(),
            &payer.pubkey(),
            None,
            6,
        )
        .unwrap();
        self.send_many(&[create, init], &[&payer, &mint]).unwrap();
        mint.pubkey()
    }

    pub fn create_token_account(&mut self, mint: Address, owner: Address) -> Address {
        let token = Keypair::new();
        let lamports = self.svm.minimum_balance_for_rent_exemption(165);
        let payer = Keypair::try_from(self.mint_authority.to_bytes().as_slice()).unwrap();
        let create = solana_system_interface::instruction::create_account(
            &payer.pubkey(),
            &token.pubkey(),
            lamports,
            165,
            &TOKEN_PROGRAM,
        );
        let init = spl_token_interface::instruction::initialize_account3(
            &TOKEN_PROGRAM,
            &token.pubkey(),
            &mint,
            &owner,
        )
        .unwrap();
        self.send_many(&[create, init], &[&payer, &token]).unwrap();
        token.pubkey()
    }

    pub fn mint_to(&mut self, token_account: Address, amount: u64) {
        let payer = Keypair::try_from(self.mint_authority.to_bytes().as_slice()).unwrap();
        let mint = spl_token_interface::instruction::mint_to(
            &TOKEN_PROGRAM,
            &self.mint,
            &token_account,
            &payer.pubkey(),
            &[],
            amount,
        )
        .unwrap();
        self.send_many(&[mint], &[&payer]).unwrap();
    }

    pub fn send_many(
        &mut self,
        instructions: &[Instruction],
        signers: &[&Keypair],
    ) -> TransactionResult {
        let message = Message::new_with_blockhash(
            instructions,
            Some(&signers[0].pubkey()),
            &self.svm.latest_blockhash(),
        );
        let transaction =
            VersionedTransaction::try_new(VersionedMessage::Legacy(message), signers).unwrap();
        let result = self.svm.send_transaction(transaction);
        self.svm.expire_blockhash();
        result
    }
}

pub fn copy(keypair: &Keypair) -> Keypair {
    Keypair::try_from(keypair.to_bytes().as_slice()).unwrap()
}
