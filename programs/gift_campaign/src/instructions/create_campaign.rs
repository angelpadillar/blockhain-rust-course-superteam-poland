use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

use crate::{
    constants::{CAMPAIGN_SEED, CONFIG_SEED, VAULT_SEED},
    errors::GiftCampaignError,
    events::CampaignCreated,
    state::{Campaign, CampaignStatus, Config},
};

#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct CreateCampaign<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        init,
        payer = sender,
        space = 8 + Campaign::INIT_SPACE,
        seeds = [CAMPAIGN_SEED, sender.key().as_ref(), &nonce.to_le_bytes()],
        bump
    )]
    pub campaign: Box<Account<'info, Campaign>>,
    #[account(
        init,
        payer = sender,
        seeds = [VAULT_SEED, campaign.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = campaign
    )]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut)]
    pub sender: Signer<'info>,
    #[account(
        mut,
        token::mint = mint,
        token::authority = sender
    )]
    pub sender_token: Account<'info, TokenAccount>,
    #[account(address = config.allowed_mint)]
    pub mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handle_create_campaign(
    ctx: Context<CreateCampaign>,
    nonce: u64,
    budget: u64,
    expires_at: i64,
) -> Result<()> {
    require!(budget > 0, GiftCampaignError::InvalidBudget);
    let now = Clock::get()?.unix_timestamp;
    require!(expires_at > now, GiftCampaignError::InvalidExpiry);

    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            Transfer {
                from: ctx.accounts.sender_token.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.sender.to_account_info(),
            },
        ),
        budget,
    )?;

    let campaign = &mut ctx.accounts.campaign;
    campaign.sender = ctx.accounts.sender.key();
    campaign.nonce = nonce;
    campaign.budget = budget;
    campaign.spent = 0;
    campaign.research_hash = [0; 32];
    campaign.gift_hash = [0; 32];
    campaign.pod_hash = [0; 32];
    campaign.spec_hash = [0; 32];
    campaign.quote_hash = [0; 32];
    campaign.merchant_hash = [0; 32];
    campaign.payment_attempt_hash = [0; 32];
    campaign.payment_auth_hash = [0; 32];
    campaign.purchase_hash = [0; 32];
    campaign.order_id_hash = [0; 32];
    campaign.fulfillment_hash = [0; 32];
    campaign.quote_version = 0;
    campaign.job_kind = 0;
    campaign.adapter = 0;
    campaign.currency = [0; 3];
    campaign.currency_exponent = 0;
    campaign.charge_currency = [0; 3];
    campaign.charge_currency_exponent = 0;
    campaign.item_subtotal_minor = 0;
    campaign.small_order_fee_minor = 0;
    campaign.service_fee_minor = 0;
    campaign.delivery_fee_minor = 0;
    campaign.tip_minor = 0;
    campaign.other_fees_minor = 0;
    campaign.landed_total_minor = 0;
    campaign.max_total_minor = 0;
    campaign.settlement_amount = 0;
    campaign.quoted_charge_amount_minor = 0;
    campaign.settlement_units_per_charge_unit_micros = 0;
    campaign.authenticated_amount_minor = 0;
    campaign.charged_amount_minor = 0;
    campaign.quote_captured_at = 0;
    campaign.quote_expires_at = 0;
    campaign.payment_attempted_at = 0;
    campaign.payment_authenticated_at = 0;
    campaign.purchased_at = 0;
    campaign.created_at = now;
    campaign.expires_at = expires_at;
    campaign.status = CampaignStatus::Funded;
    campaign.vault_bump = ctx.bumps.vault;
    campaign.bump = ctx.bumps.campaign;

    emit!(CampaignCreated {
        campaign: campaign.key(),
        sender: campaign.sender,
        nonce,
        budget,
        expires_at,
    });

    Ok(())
}
