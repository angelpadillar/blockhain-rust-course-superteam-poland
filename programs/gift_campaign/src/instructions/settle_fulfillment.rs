use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::{
    constants::{BASIS_POINTS_DENOMINATOR, CAMPAIGN_SEED, CONFIG_SEED, VAULT_SEED},
    errors::GiftCampaignError,
    events::FulfillmentSettled,
    state::{Campaign, CampaignStatus, Config},
};

#[derive(Accounts)]
pub struct SettleFulfillment<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
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
    pub vault: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        token::mint = config.allowed_mint,
        token::authority = campaign.sender
    )]
    pub sender_token: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        token::mint = config.allowed_mint,
        token::authority = config.treasury
    )]
    pub treasury_token: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        token::mint = config.allowed_mint,
        token::authority = config.delivery_oracle
    )]
    pub operator_token: Box<Account<'info, TokenAccount>>,
    pub fulfillment_oracle: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

pub fn handle_settle_fulfillment(
    ctx: Context<SettleFulfillment>,
    pod_hash: [u8; 32],
    fulfillment_hash: [u8; 32],
) -> Result<()> {
    require_keys_eq!(
        ctx.accounts.fulfillment_oracle.key(),
        ctx.accounts.config.delivery_oracle,
        GiftCampaignError::UnauthorizedFulfillmentOracle
    );
    require!(
        ctx.accounts.campaign.status == CampaignStatus::Purchased,
        GiftCampaignError::InvalidCampaignState
    );
    for hash in [pod_hash, fulfillment_hash] {
        require!(hash != [0; 32], GiftCampaignError::ZeroHash);
    }
    require!(
        Clock::get()?.unix_timestamp <= ctx.accounts.campaign.expires_at,
        GiftCampaignError::CampaignExpired
    );

    let operator_payment = ctx.accounts.campaign.settlement_amount;
    let fee = operator_payment
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

    for (amount, destination) in [
        (
            operator_payment,
            ctx.accounts.operator_token.to_account_info(),
        ),
        (fee, ctx.accounts.treasury_token.to_account_info()),
    ] {
        if amount > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.key(),
                    Transfer {
                        from: ctx.accounts.vault.to_account_info(),
                        to: destination,
                        authority: ctx.accounts.campaign.to_account_info(),
                    },
                    signer,
                ),
                amount,
            )?;
        }
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
    campaign.fulfillment_hash = fulfillment_hash;
    campaign.spent = operator_payment;
    campaign.status = CampaignStatus::Settled;
    emit!(FulfillmentSettled {
        campaign: campaign.key(),
        pod_hash,
        fulfillment_hash,
        operator_payment,
        fee,
        refund,
    });
    Ok(())
}
