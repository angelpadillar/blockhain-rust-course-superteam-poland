use {
    super::accounts,
    crate::{
        error::{require, GiftCampaignError, Result},
        events::DeliveryConfirmed,
        state::{campaign_status, Campaign, Config},
        util::{
            check_address, check_distinct, check_signer, check_token_account, emit, fee_for,
            i64_le, now, parse, require_hash, token_amount, token_transfer, u64_le,
            TOKEN_PROGRAM_ID,
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
}

/// Legacy (pre-quote) settlement. Accounts: `config`, `campaign` (mut PDA),
/// `vault` (mut token PDA), `sender_token`, `treasury_token` (mut token
/// accounts), `delivery_oracle` (signer), `token_program`.
pub fn process(accounts: &mut [AccountView], args: &[u8]) -> Result {
    accounts!(
        accounts,
        [
            config,
            campaign_account,
            vault,
            sender_token,
            treasury_token,
            delivery_oracle,
            token_program
        ]
    );
    let args: &Args = parse(args)?;
    let config = Config::load(config)?;
    let campaign = Campaign::load_escrow(campaign_account)?;
    load_vault(vault, campaign_account, campaign, config, sender_token)?;
    check_token_account(treasury_token, &config.allowed_mint, &config.treasury)?;
    check_distinct(vault, treasury_token)?;
    check_distinct(sender_token, treasury_token)?;
    check_signer(delivery_oracle)?;
    check_address(token_program, &TOKEN_PROGRAM_ID)?;

    require(
        !campaign.has_mandate() && campaign.kind.quote_version == [0; 4],
        GiftCampaignError::LegacyPathForbidden,
    )?;
    require(
        delivery_oracle.address() == &config.delivery_oracle,
        GiftCampaignError::UnauthorizedDeliveryOracle,
    )?;
    require(
        campaign.status == campaign_status::APPROVED,
        GiftCampaignError::InvalidCampaignState,
    )?;
    require_hash(&args.pod_hash)?;
    require(
        now()? <= i64_le(&campaign.expires_at),
        GiftCampaignError::CampaignExpired,
    )?;

    let fee = fee_for(u64_le(&campaign.budget), &config.fee_bps)?;
    let bump = [campaign.bump];
    let seeds = [
        Seed::from(CAMPAIGN_SEED),
        Seed::from(campaign.sender.as_ref()),
        Seed::from(&campaign.nonce),
        Seed::from(&bump),
    ];
    let signer = [Signer::from(&seeds)];

    if fee > 0 {
        token_transfer(vault, treasury_token, campaign_account, fee, &signer)?;
    }
    let refund = token_amount(vault);
    if refund > 0 {
        token_transfer(vault, sender_token, campaign_account, refund, &signer)?;
    }

    campaign.pod_hash = args.pod_hash;
    campaign.spent = campaign.budget;
    campaign.status = campaign_status::SETTLED;
    emit(&DeliveryConfirmed {
        discriminator: DeliveryConfirmed::DISCRIMINATOR,
        campaign: *campaign_account.address(),
        sender: campaign.sender,
        nonce: campaign.nonce,
        pod_hash: args.pod_hash,
        fee: fee.to_le_bytes(),
        refund: refund.to_le_bytes(),
    });
    Ok(())
}
