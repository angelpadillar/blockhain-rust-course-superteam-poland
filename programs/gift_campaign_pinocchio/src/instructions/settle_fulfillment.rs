use {
    super::accounts,
    crate::{
        error::{require, GiftCampaignError, Result},
        events::FulfillmentSettled,
        state::{campaign_status, Campaign, Config},
        util::{
            check_address, check_distinct, check_signer, emit, fee_for, parse, require_hash,
            token_amount, token_transfer, u64_le, TOKEN_PROGRAM_ID,
        },
        vault::load_vault,
        CAMPAIGN_SEED,
    },
    pinocchio::{
        cpi::{Seed, Signer},
        AccountView,
    },
};

#[repr(C)]
struct Args {
    pod_hash: [u8; 32],
    fulfillment_hash: [u8; 32],
}

/// Accounts: `config`, `campaign` (mut PDA), `vault` (mut token PDA),
/// `sender_token`, `treasury_token`, `operator_token` (mut token accounts
/// owned by the sender, treasury and delivery oracle), `fulfillment_oracle`
/// (signer), `token_program`.
pub fn process(accounts: &mut [AccountView], args: &[u8]) -> Result {
    accounts!(
        accounts,
        [
            config,
            campaign_account,
            vault,
            sender_token,
            treasury_token,
            operator_token,
            fulfillment_oracle,
            token_program
        ]
    );
    let args: &Args = parse(args)?;
    let config = Config::load(config)?;
    let campaign = Campaign::load_escrow(campaign_account)?;
    load_vault(vault, campaign_account, campaign, config, sender_token)?;
    crate::util::check_token_account(treasury_token, &config.allowed_mint, &config.treasury)?;
    crate::util::check_token_account(
        operator_token,
        &config.allowed_mint,
        &config.delivery_oracle,
    )?;
    check_distinct(vault, treasury_token)?;
    check_distinct(vault, operator_token)?;
    check_distinct(sender_token, treasury_token)?;
    check_distinct(sender_token, operator_token)?;
    check_distinct(treasury_token, operator_token)?;
    check_signer(fulfillment_oracle)?;
    check_address(token_program, &TOKEN_PROGRAM_ID)?;

    require(
        fulfillment_oracle.address() == &config.delivery_oracle,
        GiftCampaignError::UnauthorizedFulfillmentOracle,
    )?;
    require(
        campaign.status == campaign_status::PURCHASED,
        GiftCampaignError::InvalidCampaignState,
    )?;
    require_hash(&args.pod_hash)?;
    require_hash(&args.fulfillment_hash)?;
    // Expiry bounds NEW payment attempts. A purchase already recorded by the
    // fulfillment oracle must remain settleable after delayed physical delivery;
    // otherwise Purchased cannot be settled or cancelled and escrow is stranded.

    let operator_payment = u64_le(&campaign.amounts.settlement_amount);
    let fee = fee_for(operator_payment, &config.fee_bps)?;
    let bump = [campaign.bump];
    let seeds = [
        Seed::from(CAMPAIGN_SEED),
        Seed::from(campaign.sender.as_ref()),
        Seed::from(&campaign.nonce),
        Seed::from(&bump),
    ];
    let signer = [Signer::from(&seeds)];

    for (amount, destination) in [
        (operator_payment, &*operator_token),
        (fee, &*treasury_token),
    ] {
        if amount > 0 {
            token_transfer(vault, destination, campaign_account, amount, &signer)?;
        }
    }
    let refund = token_amount(vault);
    if refund > 0 {
        token_transfer(vault, sender_token, campaign_account, refund, &signer)?;
    }

    campaign.pod_hash = args.pod_hash;
    campaign.fulfillment_hash = args.fulfillment_hash;
    campaign.spent = campaign.amounts.settlement_amount;
    campaign.status = campaign_status::SETTLED;
    emit(&FulfillmentSettled {
        discriminator: FulfillmentSettled::DISCRIMINATOR,
        campaign: *campaign_account.address(),
        pod_hash: args.pod_hash,
        fulfillment_hash: args.fulfillment_hash,
        operator_payment: campaign.amounts.settlement_amount,
        fee: fee.to_le_bytes(),
        refund: refund.to_le_bytes(),
    });
    Ok(())
}
