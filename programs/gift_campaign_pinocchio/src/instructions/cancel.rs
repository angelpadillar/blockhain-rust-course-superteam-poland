use {
    super::accounts,
    crate::{
        error::{require, GiftCampaignError, Result},
        events::CampaignCancelled,
        state::{campaign_status, Campaign, Config},
        util::{
            check_address, check_signer, emit, i64_le, now, token_amount, token_transfer,
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

/// Accounts: `config`, `campaign` (mut PDA), `vault` (mut token PDA),
/// `sender_token` (mut), `canceller` (signer), `token_program`.
pub fn process(accounts: &mut [AccountView], _args: &[u8]) -> Result {
    accounts!(
        accounts,
        [
            config,
            campaign_account,
            vault,
            sender_token,
            canceller,
            token_program
        ]
    );
    let config = Config::load(config)?;
    let campaign = Campaign::load_escrow(campaign_account)?;
    load_vault(vault, campaign_account, campaign, config, sender_token)?;
    check_signer(canceller)?;
    check_address(token_program, &TOKEN_PROGRAM_ID)?;

    // Funded ..= PaymentAuthenticated may be cancelled; only the sender, and
    // only before a payment attempt, or the delivery oracle after expiry.
    require(
        campaign.status <= campaign_status::PAYMENT_AUTHENTICATED,
        GiftCampaignError::InvalidCampaignState,
    )?;
    let is_sender = canceller.address() == &campaign.sender;
    let is_expired_oracle =
        canceller.address() == &config.delivery_oracle && now()? > i64_le(&campaign.expires_at);
    require(
        (is_sender && campaign.status <= campaign_status::APPROVED) || is_expired_oracle,
        GiftCampaignError::UnauthorizedCancellation,
    )?;

    let refund = token_amount(vault);
    if refund > 0 {
        let bump = [campaign.bump];
        let seeds = [
            Seed::from(CAMPAIGN_SEED),
            Seed::from(campaign.sender.as_ref()),
            Seed::from(&campaign.nonce),
            Seed::from(&bump),
        ];
        token_transfer(
            vault,
            sender_token,
            campaign_account,
            refund,
            &[Signer::from(&seeds)],
        )?;
    }

    campaign.status = campaign_status::CANCELLED;
    emit(&CampaignCancelled {
        discriminator: CampaignCancelled::DISCRIMINATOR,
        campaign: *campaign_account.address(),
        sender: campaign.sender,
        nonce: campaign.nonce,
        refund: refund.to_le_bytes(),
    });
    Ok(())
}
