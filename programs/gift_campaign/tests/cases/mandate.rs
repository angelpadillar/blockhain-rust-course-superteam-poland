use super::*;
use gift_campaign::{
    constants::MANDATE_SEED,
    errors::GiftCampaignError,
    mandate::{quote_terms_hash, validate_mandate_quote},
    state::{Config, Mandate, MandateStatus},
};

fn mandate_address(campaign: Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[MANDATE_SEED, campaign.as_ref()], &gift_campaign::ID).0
}

fn terms(executor: Pubkey) -> gift_campaign::instruction::AuthorizeMandate {
    gift_campaign::instruction::AuthorizeMandate {
        executor,
        merchant_hash: MERCHANT_HASH,
        spec_hash: SPEC_HASH,
        recipient_hash: [133; 32],
        charge_currency: *b"EUR",
        charge_currency_exponent: 2,
        max_charge_amount_minor: CHARGE_TOTAL_MINOR,
        max_escrow_debit: SETTLEMENT_AMOUNT + SETTLEMENT_AMOUNT * u64::from(FEE_BPS) / 10_000,
        expires_at: 4_000,
    }
}

fn signer_copy(key: &Keypair) -> Keypair {
    Keypair::try_from(key.to_bytes().as_slice()).unwrap()
}

/// Asserts the exact custom error code, which both the Anchor program and the
/// Pinocchio port return (the port does not log Anchor's error names).
fn rejected(result: TransactionResult, expected: GiftCampaignError) {
    let error = result.expect_err("instruction unexpectedly succeeded");
    let code = u32::from(expected);
    assert_eq!(
        format!("{:?}", error.err),
        format!("InstructionError(0, Custom({code}))"),
        "expected {expected:?}, logs: {:?}",
        error.meta.logs
    );
}

impl Fixture {
    fn authorize_mandate(
        &mut self,
        campaign: Pubkey,
        signer: &Keypair,
        terms: gift_campaign::instruction::AuthorizeMandate,
    ) -> TransactionResult {
        let instruction = Instruction::new_with_bytes(
            gift_campaign::ID,
            &terms.data(),
            gift_campaign::accounts::AuthorizeMandate {
                campaign,
                mandate: mandate_address(campaign),
                sender: signer.pubkey(),
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        );
        send(&mut self.svm, signer, &[instruction], &[])
    }

    fn revoke_mandate(&mut self, campaign: Pubkey, signer: &Keypair) -> TransactionResult {
        let instruction = Instruction::new_with_bytes(
            gift_campaign::ID,
            &gift_campaign::instruction::RevokeMandate {}.data(),
            gift_campaign::accounts::RevokeMandate {
                campaign,
                mandate: mandate_address(campaign),
                sender: signer.pubkey(),
            }
            .to_account_metas(None),
        );
        send(&mut self.svm, signer, &[instruction], &[])
    }

    fn approve_mandate(
        &mut self,
        campaign: Pubkey,
        signer: &Keypair,
        hash: [u8; 32],
    ) -> TransactionResult {
        self.approve_mandate_account(campaign, mandate_address(campaign), signer, hash)
    }

    fn approve_mandate_account(
        &mut self,
        campaign: Pubkey,
        mandate: Pubkey,
        signer: &Keypair,
        hash: [u8; 32],
    ) -> TransactionResult {
        let instruction = Instruction::new_with_bytes(
            gift_campaign::ID,
            &gift_campaign::instruction::ApproveQuoteWithMandate {
                quote_version: 1,
                terms_hash: hash,
            }
            .data(),
            gift_campaign::accounts::ApproveQuoteWithMandate {
                config: self.config,
                campaign,
                mandate,
                executor: signer.pubkey(),
            }
            .to_account_metas(None),
        );
        send(&mut self.svm, signer, &[instruction], &[])
    }

    fn attempt_mandate(
        &mut self,
        campaign: Pubkey,
        signer: &Keypair,
        hash: [u8; 32],
        attempt_hash: [u8; 32],
    ) -> TransactionResult {
        let instruction = Instruction::new_with_bytes(
            gift_campaign::ID,
            &gift_campaign::instruction::RecordPaymentAttemptWithMandate {
                terms_hash: hash,
                payment_attempt_hash: attempt_hash,
            }
            .data(),
            gift_campaign::accounts::RecordPaymentAttemptWithMandate {
                config: self.config,
                campaign,
                mandate: mandate_address(campaign),
                executor: signer.pubkey(),
            }
            .to_account_metas(None),
        );
        send(&mut self.svm, signer, &[instruction], &[])
    }

    fn mandate(&self, campaign: Pubkey) -> Mandate {
        let account = self.svm.get_account(&mandate_address(campaign)).unwrap();
        Mandate::try_deserialize(&mut account.data.as_slice()).unwrap()
    }

    fn config_state(&self) -> Config {
        let account = self.svm.get_account(&self.config).unwrap();
        Config::try_deserialize(&mut account.data.as_slice()).unwrap()
    }

    fn terms_hash(&self, campaign: Pubkey) -> [u8; 32] {
        quote_terms_hash(
            campaign,
            mandate_address(campaign),
            &self.campaign(campaign),
            &self.mandate(campaign),
            &self.config_state(),
        )
    }

    fn clock_at(&mut self, now: i64) {
        let mut clock = self.svm.get_sysvar::<Clock>();
        clock.unix_timestamp = now;
        self.svm.set_sysvar(&clock);
        self.svm.expire_blockhash();
    }
}

#[test]
fn mandate_is_consumed_once_and_purchased_funds_settle_after_expiry() {
    let mut f = Fixture::new();
    let sender = signer_copy(&f.sender);
    // A separate delegate is permitted; configured fulfillment oracle still authenticates receipts.
    let executor = signer_copy(&f.attacker);
    let (campaign, vault) = f.create_campaign(30, FUTURE_EXPIRY);
    f.submit_exact_quote(campaign, QUOTE_TOTAL_MINOR).unwrap();
    f.authorize_mandate(campaign, &sender, terms(executor.pubkey()))
        .unwrap();
    rejected(
        f.approve_exact_quote(campaign),
        GiftCampaignError::MandateRequired,
    );
    rejected(
        f.approve(campaign, GIFT_HASH),
        GiftCampaignError::MandateRequired,
    );
    let hash = f.terms_hash(campaign);
    rejected(
        f.approve_mandate(campaign, &executor, [0; 32]),
        GiftCampaignError::ZeroHash,
    );
    rejected(
        f.approve_mandate(campaign, &executor, [1; 32]),
        GiftCampaignError::TermsMismatch,
    );
    f.approve_mandate(campaign, &executor, hash).unwrap();
    rejected(
        f.record_payment_attempt(campaign),
        GiftCampaignError::MandateRequired,
    );
    rejected(
        f.confirm_delivery(campaign, vault),
        GiftCampaignError::LegacyPathForbidden,
    );
    rejected(
        f.attempt_mandate(campaign, &executor, [1; 32], PAYMENT_ATTEMPT_HASH),
        GiftCampaignError::TermsMismatch,
    );
    rejected(
        f.attempt_mandate(campaign, &executor, hash, [0; 32]),
        GiftCampaignError::ZeroHash,
    );
    f.attempt_mandate(campaign, &executor, hash, PAYMENT_ATTEMPT_HASH)
        .unwrap();
    assert_eq!(f.mandate(campaign).status, MandateStatus::Consumed);
    assert_eq!(
        f.campaign(campaign).status,
        CampaignStatus::PaymentAttempted
    );
    f.svm.expire_blockhash(); // A new signature must still fail; not merely transaction deduplication.
    rejected(
        f.attempt_mandate(campaign, &executor, hash, [201; 32]),
        GiftCampaignError::InvalidCampaignState,
    );
    rejected(
        f.revoke_mandate(campaign, &sender),
        GiftCampaignError::InactiveMandate,
    );
    assert!(f
        .authorize_mandate(campaign, &sender, terms(executor.pubkey()))
        .is_err());
    rejected(
        f.cancel_with(campaign, vault, &sender),
        GiftCampaignError::UnauthorizedCancellation,
    );
    f.record_payment_auth(campaign, CHARGE_TOTAL_MINOR).unwrap();
    f.record_purchase(campaign).unwrap();
    f.clock_at(FUTURE_EXPIRY + 1);
    f.settle_fulfillment(campaign, vault).unwrap();
    assert_eq!(f.campaign(campaign).status, CampaignStatus::Settled);
    assert_eq!(f.mandate(campaign).status, MandateStatus::Consumed);
    assert_eq!(token_balance(&f.svm, vault), 0);
    assert_eq!(
        token_balance(&f.svm, f.operator_token.pubkey()),
        SETTLEMENT_AMOUNT
    );
    let fee = SETTLEMENT_AMOUNT * u64::from(FEE_BPS) / 10_000;
    assert_eq!(
        token_balance(&f.svm, f.sender_token.pubkey()),
        INITIAL_TOKENS - SETTLEMENT_AMOUNT - fee
    );
}

#[test]
fn mandate_authorization_rejects_non_owner_and_invalid_terms() {
    let mut f = Fixture::new();
    let owner = signer_copy(&f.sender);
    let other = signer_copy(&f.attacker);
    let (campaign, _) = f.create_campaign(31, FUTURE_EXPIRY);
    rejected(
        f.authorize_mandate(campaign, &other, terms(other.pubkey())),
        GiftCampaignError::UnauthorizedSender,
    );
    for index in 0..11 {
        let mut args = terms(other.pubkey());
        let expected = match index {
            0 => {
                args.merchant_hash = [0; 32];
                GiftCampaignError::ZeroHash
            }
            1 => {
                args.spec_hash = [0; 32];
                GiftCampaignError::ZeroHash
            }
            2 => {
                args.recipient_hash = [0; 32];
                GiftCampaignError::ZeroHash
            }
            3 => {
                args.executor = Pubkey::default();
                GiftCampaignError::UnauthorizedExecutor
            }
            4 => {
                args.charge_currency = *b"eur";
                GiftCampaignError::UnsupportedCurrency
            }
            5 => {
                args.charge_currency_exponent = 5;
                GiftCampaignError::UnsupportedCurrency
            }
            6 => {
                args.max_charge_amount_minor = 0;
                GiftCampaignError::InvalidBudget
            }
            7 => {
                args.max_escrow_debit = 0;
                GiftCampaignError::InvalidBudget
            }
            8 => {
                args.max_escrow_debit = BUDGET + 1;
                GiftCampaignError::InvalidBudget
            }
            9 => {
                args.expires_at = 0;
                GiftCampaignError::InvalidExpiry
            }
            _ => {
                args.expires_at = FUTURE_EXPIRY + 1;
                GiftCampaignError::InvalidExpiry
            }
        };
        rejected(f.authorize_mandate(campaign, &owner, args), expected);
        assert_eq!(f.campaign(campaign).mandate, Pubkey::default());
        assert!(f.svm.get_account(&mandate_address(campaign)).is_none());
    }
    f.authorize_mandate(campaign, &owner, terms(other.pubkey()))
        .unwrap();
}

#[test]
fn quote_must_match_owner_terms_and_both_caps_including_fee() {
    for index in 0..6 {
        let mut f = Fixture::new();
        let owner = signer_copy(&f.sender);
        let executor = signer_copy(&f.delivery_oracle);
        let (campaign, _) = f.create_campaign(32, FUTURE_EXPIRY);
        let mut args = terms(executor.pubkey());
        let expected = match index {
            0 => {
                args.merchant_hash = [202; 32];
                GiftCampaignError::MandateMismatch
            }
            1 => {
                args.spec_hash = [203; 32];
                GiftCampaignError::MandateMismatch
            }
            2 => {
                args.charge_currency = *b"PLN";
                GiftCampaignError::MandateMismatch
            }
            3 => {
                args.charge_currency_exponent = 3;
                GiftCampaignError::MandateMismatch
            }
            4 => {
                args.max_charge_amount_minor -= 1;
                GiftCampaignError::MandateLimitExceeded
            }
            _ => {
                args.max_escrow_debit -= 1;
                GiftCampaignError::MandateLimitExceeded
            }
        };
        f.authorize_mandate(campaign, &owner, args).unwrap();
        f.submit_exact_quote(campaign, QUOTE_TOTAL_MINOR).unwrap();
        let hash = f.terms_hash(campaign);
        rejected(f.approve_mandate(campaign, &executor, hash), expected);
        assert_eq!(f.campaign(campaign).status, CampaignStatus::Quoted);
        assert_eq!(f.mandate(campaign).status, MandateStatus::Active);
    }
}

#[test]
fn executor_and_campaign_binding_are_enforced_at_approval_and_attempt() {
    let mut f = Fixture::new();
    let owner = signer_copy(&f.sender);
    let executor = signer_copy(&f.attacker);
    let other = signer_copy(&f.delivery_oracle);
    let (a, _) = f.create_campaign(33, FUTURE_EXPIRY);
    let (b, _) = f.create_campaign(34, FUTURE_EXPIRY);
    for campaign in [a, b] {
        f.authorize_mandate(campaign, &owner, terms(executor.pubkey()))
            .unwrap();
        f.submit_exact_quote(campaign, QUOTE_TOTAL_MINOR).unwrap();
    }
    let hash_a = f.terms_hash(a);
    let hash_b = f.terms_hash(b);
    assert_ne!(hash_a, hash_b);
    rejected(
        f.approve_mandate(a, &other, hash_a),
        GiftCampaignError::UnauthorizedExecutor,
    );
    assert!(f
        .approve_mandate_account(b, mandate_address(a), &executor, hash_a)
        .is_err());
    rejected(
        f.approve_mandate(b, &executor, hash_a),
        GiftCampaignError::TermsMismatch,
    );
    f.approve_mandate(a, &executor, hash_a).unwrap();
    rejected(
        f.attempt_mandate(a, &other, hash_a, PAYMENT_ATTEMPT_HASH),
        GiftCampaignError::UnauthorizedExecutor,
    );
    f.attempt_mandate(a, &executor, hash_a, PAYMENT_ATTEMPT_HASH)
        .unwrap();
    assert_eq!(f.mandate(b).status, MandateStatus::Active);
}

#[test]
fn only_owner_can_revoke_and_revocation_blocks_approval_or_consumption() {
    let mut f = Fixture::new();
    let owner = signer_copy(&f.sender);
    let executor = signer_copy(&f.attacker);
    for (nonce, approve_first) in [(35, false), (36, true)] {
        let (campaign, vault) = f.create_campaign(nonce, FUTURE_EXPIRY);
        f.authorize_mandate(campaign, &owner, terms(executor.pubkey()))
            .unwrap();
        f.submit_exact_quote(campaign, QUOTE_TOTAL_MINOR).unwrap();
        let hash = f.terms_hash(campaign);
        rejected(
            f.revoke_mandate(campaign, &executor),
            GiftCampaignError::UnauthorizedSender,
        );
        if approve_first {
            f.approve_mandate(campaign, &executor, hash).unwrap();
        }
        f.revoke_mandate(campaign, &owner).unwrap();
        if approve_first {
            rejected(
                f.attempt_mandate(campaign, &executor, hash, PAYMENT_ATTEMPT_HASH),
                GiftCampaignError::InactiveMandate,
            );
        } else {
            rejected(
                f.approve_mandate(campaign, &executor, hash),
                GiftCampaignError::InactiveMandate,
            );
        }
        assert_eq!(f.mandate(campaign).status, MandateStatus::Revoked);
        f.cancel_with(campaign, vault, &owner).unwrap();
        assert!(f
            .authorize_mandate(campaign, &owner, terms(executor.pubkey()))
            .is_err());
    }
}

#[test]
fn expiry_is_checked_again_before_consuming_authorization() {
    for approve_first in [false, true] {
        let mut f = Fixture::new();
        let owner = signer_copy(&f.sender);
        let executor = signer_copy(&f.attacker);
        let (campaign, _) = f.create_campaign(37, FUTURE_EXPIRY);
        f.authorize_mandate(campaign, &owner, terms(executor.pubkey()))
            .unwrap();
        f.submit_exact_quote(campaign, QUOTE_TOTAL_MINOR).unwrap();
        let hash = f.terms_hash(campaign);
        if approve_first {
            f.approve_mandate(campaign, &executor, hash).unwrap();
        }
        f.clock_at(4_000); // Exact expiry is already expired, not one final usable second.
        if approve_first {
            rejected(
                f.attempt_mandate(campaign, &executor, hash, PAYMENT_ATTEMPT_HASH),
                GiftCampaignError::MandateExpired,
            );
        } else {
            rejected(
                f.approve_mandate(campaign, &executor, hash),
                GiftCampaignError::MandateExpired,
            );
        }
        assert_eq!(f.mandate(campaign).status, MandateStatus::Active);
        assert_eq!(f.campaign(campaign).payment_attempt_hash, [0; 32]);
    }
}

#[test]
fn modern_quote_cannot_use_legacy_settlement_or_late_mandate_attachment() {
    let mut f = Fixture::new();
    let owner = signer_copy(&f.sender);
    let (campaign, vault) = f.create_campaign(38, FUTURE_EXPIRY);
    f.submit_exact_quote(campaign, QUOTE_TOTAL_MINOR).unwrap();
    f.approve_exact_quote(campaign).unwrap();
    rejected(
        f.confirm_delivery(campaign, vault),
        GiftCampaignError::LegacyPathForbidden,
    );
    rejected(
        f.authorize_mandate(campaign, &owner, terms(owner.pubkey())),
        GiftCampaignError::InvalidCampaignState,
    );
    assert_eq!(token_balance(&f.svm, vault), BUDGET);
    assert_eq!(f.campaign(campaign).status, CampaignStatus::Approved);
}

#[test]
fn exact_commitment_covers_quote_fields_recipient_and_fee_without_arithmetic_wrap() {
    let mut f = Fixture::new();
    let owner = signer_copy(&f.sender);
    let executor = signer_copy(&f.attacker);
    let (address, _) = f.create_campaign(39, FUTURE_EXPIRY);
    f.authorize_mandate(address, &owner, terms(executor.pubkey()))
        .unwrap();
    f.submit_exact_quote(address, QUOTE_TOTAL_MINOR).unwrap();
    let hash = f.terms_hash(address);
    let mutators: &[fn(&mut Campaign)] = &[
        |c| c.quote_version += 1,
        |c| c.job_kind += 1,
        |c| c.adapter += 1,
        |c| c.spec_hash[0] ^= 1,
        |c| c.quote_hash[0] ^= 1,
        |c| c.merchant_hash[0] ^= 1,
        |c| c.currency = *b"USD",
        |c| c.currency_exponent += 1,
        |c| c.charge_currency = *b"USD",
        |c| c.charge_currency_exponent += 1,
        |c| c.item_subtotal_minor += 1,
        |c| c.small_order_fee_minor += 1,
        |c| c.service_fee_minor += 1,
        |c| c.delivery_fee_minor += 1,
        |c| c.tip_minor += 1,
        |c| c.other_fees_minor += 1,
        |c| c.landed_total_minor += 1,
        |c| c.max_total_minor += 1,
        |c| c.settlement_amount += 1,
        |c| c.quoted_charge_amount_minor += 1,
        |c| c.settlement_units_per_charge_unit_micros += 1,
        |c| c.quote_captured_at += 1,
        |c| c.quote_expires_at += 1,
        |c| c.expires_at += 1,
    ];
    for mutate in mutators {
        let mut campaign = f.campaign(address);
        mutate(&mut campaign);
        assert_ne!(
            hash,
            quote_terms_hash(
                address,
                mandate_address(address),
                &campaign,
                &f.mandate(address),
                &f.config_state()
            )
        );
    }
    let mut mandate = f.mandate(address);
    mandate.recipient_hash[0] ^= 1;
    assert_ne!(
        hash,
        quote_terms_hash(
            address,
            mandate_address(address),
            &f.campaign(address),
            &mandate,
            &f.config_state()
        )
    );
    let mut config = f.config_state();
    config.fee_bps += 1;
    assert_ne!(
        hash,
        quote_terms_hash(
            address,
            mandate_address(address),
            &f.campaign(address),
            &f.mandate(address),
            &config
        )
    );
    let mut campaign = f.campaign(address);
    campaign.settlement_units_per_charge_unit_micros = 1;
    // Rate metadata alone is not a spend permission: both independently capped
    // amounts remain unchanged. We do not claim FX arithmetic validation.
    validate_mandate_quote(
        address,
        mandate_address(address),
        &campaign,
        &f.mandate(address),
        &f.config_state(),
        executor.pubkey(),
        0,
    )
    .unwrap();
    campaign.settlement_amount = u64::MAX;
    let error = validate_mandate_quote(
        address,
        mandate_address(address),
        &campaign,
        &f.mandate(address),
        &f.config_state(),
        executor.pubkey(),
        0,
    )
    .unwrap_err();
    assert!(format!("{error:?}").contains("ArithmeticOverflow"));
}

#[test]
fn canonical_terms_hash_matches_independently_encoded_sha256_vector() {
    // Expected digest independently encoded with Python struct.pack('<...')
    // and hashlib.sha256; no helper from the implementation generated it.
    fn zero_account<T: AccountDeserialize>() -> T {
        T::try_deserialize_unchecked(&mut vec![0u8; 4096].as_slice()).unwrap()
    }
    let mut config: Config = zero_account();
    config.allowed_mint = Pubkey::new_from_array([3; 32]);
    config.fee_bps = 500;
    let mut mandate: Mandate = zero_account();
    mandate.campaign = Pubkey::new_from_array([4; 32]);
    mandate.sender = Pubkey::new_from_array([5; 32]);
    mandate.executor = Pubkey::new_from_array([6; 32]);
    mandate.merchant_hash = [7; 32];
    mandate.spec_hash = [8; 32];
    mandate.recipient_hash = [9; 32];
    mandate.charge_currency = *b"EUR";
    mandate.charge_currency_exponent = 2;
    mandate.max_charge_amount_minor = 10_000;
    mandate.max_escrow_debit = 20_000;
    mandate.expires_at = 4_000;
    let mut campaign: Campaign = zero_account();
    campaign.quote_version = 12;
    campaign.job_kind = 1;
    campaign.adapter = 2;
    campaign.spec_hash = [8; 32];
    campaign.quote_hash = [10; 32];
    campaign.merchant_hash = [7; 32];
    campaign.currency = *b"PLN";
    campaign.currency_exponent = 2;
    campaign.charge_currency = *b"EUR";
    campaign.charge_currency_exponent = 2;
    campaign.item_subtotal_minor = 101;
    campaign.small_order_fee_minor = 102;
    campaign.service_fee_minor = 103;
    campaign.delivery_fee_minor = 104;
    campaign.tip_minor = 105;
    campaign.other_fees_minor = 106;
    campaign.landed_total_minor = 107;
    campaign.max_total_minor = 108;
    campaign.settlement_amount = 109;
    campaign.quoted_charge_amount_minor = 110;
    campaign.settlement_units_per_charge_unit_micros = 111;
    campaign.quote_captured_at = 2_000;
    campaign.quote_expires_at = 3_000;
    campaign.expires_at = 5_000;
    assert_eq!(
        quote_terms_hash(
            Pubkey::new_from_array([1; 32]),
            Pubkey::new_from_array([2; 32]),
            &campaign,
            &mandate,
            &config
        ),
        [
            230, 54, 125, 47, 201, 243, 106, 216, 133, 2, 42, 66, 225, 69, 106, 247, 214, 126, 112,
            94, 67, 91, 158, 15, 164, 173, 164, 200, 177, 57, 95, 137
        ]
    );
}
