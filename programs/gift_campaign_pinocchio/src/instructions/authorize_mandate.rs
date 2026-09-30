use {
    super::accounts,
    crate::{
        error::{require, GiftCampaignError, Result},
        events::MandateAuthorized,
        state::{
            campaign_status, mandate_status, Campaign, Mandate, MandateTerms, MANDATE_DISCRIMINATOR,
        },
        util::{
            check_address, check_payer, emit, i64_le, init_pda, is_supported_currency, is_zero,
            now, parse, u64_le, SYSTEM_PROGRAM_ID,
        },
        ID, MANDATE_SEED,
    },
    pinocchio::{AccountView, Address},
};

#[repr(C)]
struct Args {
    executor: Address,
    terms: MandateTerms,
}

/// Accounts: `campaign` (mut, `has_one = sender`), `mandate` (init PDA),
/// `sender` (mut signer), `system_program`.
pub fn process(accounts: &mut [AccountView], args: &[u8]) -> Result {
    accounts!(
        accounts,
        [campaign_account, mandate_account, sender, system_program]
    );
    let args: &Args = parse(args)?;
    let campaign = Campaign::load_mut(campaign_account)?;
    check_address(system_program, &SYSTEM_PROGRAM_ID)?;
    check_payer(sender)?;
    // Anchor runs `init` constraints before other accounts' constraints.
    let bump = init_pda(
        mandate_account,
        sender,
        &ID,
        size_of::<Mandate>(),
        &[MANDATE_SEED, campaign_account.address().as_ref()],
    )?;
    require(
        sender.address() == &campaign.sender,
        GiftCampaignError::UnauthorizedSender,
    )?;

    let terms = &args.terms;
    require(
        !campaign.has_mandate()
            && matches!(
                campaign.status,
                campaign_status::FUNDED | campaign_status::RESEARCHED | campaign_status::QUOTED
            )
            && is_zero(&campaign.payment_attempt_hash),
        GiftCampaignError::InvalidCampaignState,
    )?;
    require(
        !is_zero(&terms.merchant_hash)
            && !is_zero(&terms.spec_hash)
            && !is_zero(&terms.recipient_hash),
        GiftCampaignError::ZeroHash,
    )?;
    require(
        args.executor != Address::default(),
        GiftCampaignError::UnauthorizedExecutor,
    )?;
    require(
        is_supported_currency(&terms.charge_currency, terms.charge_currency_exponent),
        GiftCampaignError::UnsupportedCurrency,
    )?;
    let max_escrow_debit = u64_le(&terms.max_escrow_debit);
    require(
        u64_le(&terms.max_charge_amount_minor) > 0
            && max_escrow_debit > 0
            && max_escrow_debit <= u64_le(&campaign.budget),
        GiftCampaignError::InvalidBudget,
    )?;
    let expires_at = i64_le(&terms.expires_at);
    require(
        expires_at > now()? && expires_at <= i64_le(&campaign.expires_at),
        GiftCampaignError::InvalidExpiry,
    )?;

    // SAFETY: `mandate` was just created, zero-filled, with `size_of::<Mandate>()` bytes.
    let mandate = unsafe { &mut *(mandate_account.data_mut_ptr() as *mut Mandate) };
    mandate.discriminator = MANDATE_DISCRIMINATOR;
    mandate.parties.campaign = *campaign_account.address();
    mandate.parties.sender = campaign.sender;
    mandate.parties.executor = args.executor;
    mandate.terms = *terms;
    mandate.status = mandate_status::ACTIVE;
    mandate.bump = bump;
    campaign.mandate = *mandate_account.address();

    emit(&MandateAuthorized {
        discriminator: MandateAuthorized::DISCRIMINATOR,
        campaign: *campaign_account.address(),
        mandate: *mandate_account.address(),
        sender: campaign.sender,
        executor: args.executor,
        expires_at: terms.expires_at,
    });
    Ok(())
}
