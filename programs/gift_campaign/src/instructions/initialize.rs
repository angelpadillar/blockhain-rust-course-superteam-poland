use anchor_lang::prelude::*;
use anchor_spl::token::Mint;

use crate::{
    constants::{CONFIG_SEED, MAX_FEE_BPS},
    errors::GiftCampaignError,
    state::Config,
};

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + Config::INIT_SPACE,
        seeds = [CONFIG_SEED],
        bump
    )]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub treasury: SystemAccount<'info>,
    pub research_oracle: SystemAccount<'info>,
    pub delivery_oracle: SystemAccount<'info>,
    pub allowed_mint: Account<'info, Mint>,
    pub system_program: Program<'info, System>,
}

pub fn handle_initialize(ctx: Context<Initialize>, fee_bps: u16) -> Result<()> {
    require!(fee_bps <= MAX_FEE_BPS, GiftCampaignError::FeeTooHigh);

    let config = &mut ctx.accounts.config;
    config.authority = ctx.accounts.authority.key();
    config.treasury = ctx.accounts.treasury.key();
    config.research_oracle = ctx.accounts.research_oracle.key();
    config.delivery_oracle = ctx.accounts.delivery_oracle.key();
    config.allowed_mint = ctx.accounts.allowed_mint.key();
    config.fee_bps = fee_bps;
    config.bump = ctx.bumps.config;

    Ok(())
}
