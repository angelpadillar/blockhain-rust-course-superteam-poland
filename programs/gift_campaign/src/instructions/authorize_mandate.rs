use crate::{
    constants::MANDATE_SEED,
    errors::GiftCampaignError,
    events::MandateAuthorized,
    state::{Campaign, CampaignStatus, Mandate, MandateStatus},
};
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct AuthorizeMandate<'info> {
    #[account(mut, has_one = sender @ GiftCampaignError::UnauthorizedSender)]
    pub campaign: Box<Account<'info, Campaign>>,
    #[account(init, payer = sender, space = 8 + Mandate::INIT_SPACE,
        seeds = [MANDATE_SEED, campaign.key().as_ref()], bump)]
    pub mandate: Box<Account<'info, Mandate>>,
    #[account(mut)]
    pub sender: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[allow(clippy::too_many_arguments)]
pub fn handle_authorize_mandate(
    ctx: Context<AuthorizeMandate>,
    executor: Pubkey,
    merchant_hash: [u8; 32],
    spec_hash: [u8; 32],
    recipient_hash: [u8; 32],
    charge_currency: [u8; 3],
    charge_currency_exponent: u8,
    max_charge_amount_minor: u64,
    max_escrow_debit: u64,
    expires_at: i64,
) -> Result<()> {
    let campaign = &mut ctx.accounts.campaign;
    require!(
        campaign.mandate == Pubkey::default()
            && matches!(
                campaign.status,
                CampaignStatus::Funded | CampaignStatus::Researched | CampaignStatus::Quoted
            )
            && campaign.payment_attempt_hash == [0; 32],
        GiftCampaignError::InvalidCampaignState
    );
    require!(
        merchant_hash != [0; 32] && spec_hash != [0; 32] && recipient_hash != [0; 32],
        GiftCampaignError::ZeroHash
    );
    require!(
        executor != Pubkey::default(),
        GiftCampaignError::UnauthorizedExecutor
    );
    require!(
        charge_currency.iter().all(u8::is_ascii_uppercase) && charge_currency_exponent <= 4,
        GiftCampaignError::UnsupportedCurrency
    );
    require!(
        max_charge_amount_minor > 0 && max_escrow_debit > 0 && max_escrow_debit <= campaign.budget,
        GiftCampaignError::InvalidBudget
    );
    require!(
        expires_at > Clock::get()?.unix_timestamp && expires_at <= campaign.expires_at,
        GiftCampaignError::InvalidExpiry
    );
    let mandate = &mut ctx.accounts.mandate;
    mandate.set_inner(Mandate {
        campaign: campaign.key(),
        sender: campaign.sender,
        executor,
        merchant_hash,
        spec_hash,
        recipient_hash,
        charge_currency,
        charge_currency_exponent,
        max_charge_amount_minor,
        max_escrow_debit,
        expires_at,
        status: MandateStatus::Active,
        approved_terms_hash: [0; 32],
        consumed_at: 0,
        bump: ctx.bumps.mandate,
    });
    campaign.mandate = mandate.key();
    emit!(MandateAuthorized {
        campaign: campaign.key(),
        mandate: mandate.key(),
        sender: campaign.sender,
        executor,
        expires_at
    });
    Ok(())
}
