use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::{
    constants::{BASIS_POINTS_DENOMINATOR, CAMPAIGN_SEED, CONFIG_SEED, VAULT_SEED},
    errors::GiftCampaignError,
    events::DeliveryConfirmed,
    state::{Campaign, CampaignStatus, Config},
};

#[derive(Accounts)]
pub struct ConfirmDelivery<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        seeds = [CAMPAIGN_SEED, campaign.sender.as_ref(), &campaign.nonce.to_le_bytes()],
        bump = campaign.bump
    )]
    pub campaign: Box<Account<'info, Campaign>>,
    #[account(
        mut,
        seeds = [VAULT_SEED, campaign.key().as_ref()],
        bump = campaign.vault_bump,
        token::mint = config.allowed_mint,
        token::authority = campaign
    )]
    pub vault: Account<'info, TokenAccount>,
    #[account(
        mut,
        token::mint = config.allowed_mint,
        token::authority = campaign.sender
    )]
    pub sender_token: Account<'info, TokenAccount>,
    #[account(
        mut,
        token::mint = config.allowed_mint,
        token::authority = config.treasury
    )]
    pub treasury_token: Account<'info, TokenAccount>,
    pub delivery_oracle: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

pub fn handle_confirm_delivery(ctx: Context<ConfirmDelivery>, pod_hash: [u8; 32]) -> Result<()> {
    require_keys_eq!(
        ctx.accounts.delivery_oracle.key(),
        ctx.accounts.config.delivery_oracle,
        GiftCampaignError::UnauthorizedDeliveryOracle
    );
    require!(
        ctx.accounts.campaign.status == CampaignStatus::Approved,
        GiftCampaignError::InvalidCampaignState
    );
    require!(pod_hash != [0; 32], GiftCampaignError::ZeroHash);
    require!(
        Clock::get()?.unix_timestamp <= ctx.accounts.campaign.expires_at,
        GiftCampaignError::CampaignExpired
    );

    let fee = ctx
        .accounts
        .campaign
        .budget
        .checked_mul(u64::from(ctx.accounts.config.fee_bps))
        .ok_or(GiftCampaignError::ArithmeticOverflow)?
        .checked_div(BASIS_POINTS_DENOMINATOR)
        .ok_or(GiftCampaignError::ArithmeticOverflow)?;

    let sender = ctx.accounts.campaign.sender;
    let nonce_bytes = ctx.accounts.campaign.nonce.to_le_bytes();
    let campaign_bump = [ctx.accounts.campaign.bump];
    let signer_seeds: &[&[u8]] = &[
        CAMPAIGN_SEED,
        sender.as_ref(),
        nonce_bytes.as_ref(),
        campaign_bump.as_ref(),
    ];
    let signer = &[signer_seeds];

    if fee > 0 {
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.treasury_token.to_account_info(),
                    authority: ctx.accounts.campaign.to_account_info(),
                },
                signer,
            ),
            fee,
        )?;
    }

    ctx.accounts.vault.reload()?;
    let refund = ctx.accounts.vault.amount;
    if refund > 0 {
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.sender_token.to_account_info(),
                    authority: ctx.accounts.campaign.to_account_info(),
                },
                signer,
            ),
            refund,
        )?;
    }

    let campaign = &mut ctx.accounts.campaign;
    campaign.pod_hash = pod_hash;
    campaign.spent = campaign.budget;
    campaign.status = CampaignStatus::Delivered;
    campaign.status = CampaignStatus::Settled;

    emit!(DeliveryConfirmed {
        campaign: campaign.key(),
        sender: campaign.sender,
        nonce: campaign.nonce,
        pod_hash,
        fee,
        refund,
    });

    Ok(())
}
