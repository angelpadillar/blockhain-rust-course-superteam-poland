import * as anchor from "@anchor-lang/core";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type { GiftCampaign } from "../target/types/gift_campaign";

const RPC_URL = process.env.ANCHOR_PROVIDER_URL ?? "http://127.0.0.1:8899";
const WALLET_PATH = process.env.ANCHOR_WALLET;
const LIVE_DEMO = process.env.LIVE_DEMO === "1";
const PROOF_FILE = process.env.PROOF_FILE;
const FEE_BPS = 500;
const BUDGET_BASE_UNITS = new anchor.BN(10_000_000); // 10 demo tokens, 6 decimals.
const TOKEN_PROGRAM_ID = new anchor.web3.PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
);
const ASSOCIATED_TOKEN_PROGRAM_ID = new anchor.web3.PublicKey(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
);

function sha256(value: Buffer | string): number[] {
  return [...createHash("sha256").update(value).digest()];
}

function tokenCli(args: string[]): unknown {
  const output = execFileSync(
    "spl-token",
    ["--url", RPC_URL, "--output", "json", ...args],
    { encoding: "utf8" },
  );
  return JSON.parse(output);
}

function findAddress(value: unknown): string {
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    if (typeof record.address === "string") return record.address;
    for (const child of Object.values(record)) {
      try {
        return findAddress(child);
      } catch {
        // Keep walking until an address field is found.
      }
    }
  }
  throw new Error(`Could not find an address in SPL Token output: ${value}`);
}

function associatedTokenAddress(
  owner: anchor.web3.PublicKey,
  mint: anchor.web3.PublicKey,
): anchor.web3.PublicKey {
  return anchor.web3.PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )[0];
}

async function airdrop(
  connection: anchor.web3.Connection,
  recipient: anchor.web3.PublicKey,
): Promise<void> {
  const signature = await connection.requestAirdrop(
    recipient,
    2 * anchor.web3.LAMPORTS_PER_SOL,
  );
  const latest = await connection.getLatestBlockhash();
  await connection.confirmTransaction({ signature, ...latest }, "confirmed");
}

async function pause(message: string): Promise<void> {
  if (!LIVE_DEMO) return;
  const readline = createInterface({ input: stdin, output: stdout });
  await readline.question(`${message}\nPress Enter to continue... `);
  readline.close();
}

function printTransaction(label: string, signature: string): void {
  console.log(`\n${label}`);
  console.log(`  signature: ${signature}`);
  if (RPC_URL.includes("devnet")) {
    console.log(
      `  explorer: https://explorer.solana.com/tx/${signature}?cluster=devnet`,
    );
  } else {
    console.log("  inspect in Surfpool Studio: http://127.0.0.1:18488");
  }
}

async function main(): Promise<void> {
  if (!WALLET_PATH) {
    throw new Error(
      "ANCHOR_WALLET is missing. Run `./scripts/start-surfpool.sh` and export the two variables it prints.",
    );
  }

  const walletPath = resolve(WALLET_PATH);
  if (!existsSync(walletPath)) {
    throw new Error(`Wallet does not exist: ${walletPath}`);
  }

  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.giftCampaign as anchor.Program<GiftCampaign>;
  const payer = provider.wallet.publicKey;
  const treasury = anchor.web3.Keypair.generate();
  const researchOracle = anchor.web3.Keypair.generate();
  const deliveryOracle = anchor.web3.Keypair.generate();

  for (const wallet of [treasury, researchOracle, deliveryOracle]) {
    await airdrop(provider.connection, wallet.publicKey);
  }

  const [config] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    program.programId,
  );
  if (await provider.connection.getAccountInfo(config)) {
    throw new Error(
      "The Config PDA already exists. Restart Surfpool with a fresh in-memory Surfnet before replaying the full demo.",
    );
  }

  const mintResult = tokenCli([
    "create-token",
    "--fee-payer",
    walletPath,
    "--mint-authority",
    payer.toBase58(),
    "--decimals",
    "6",
  ]);
  const mint = new anchor.web3.PublicKey(findAddress(mintResult));

  tokenCli([
    "create-account",
    "--fee-payer",
    walletPath,
    "--owner",
    payer.toBase58(),
    mint.toBase58(),
  ]);
  const senderToken = associatedTokenAddress(payer, mint);

  tokenCli([
    "create-account",
    "--fee-payer",
    walletPath,
    "--owner",
    treasury.publicKey.toBase58(),
    mint.toBase58(),
  ]);
  const treasuryToken = associatedTokenAddress(treasury.publicKey, mint);

  tokenCli([
    "mint",
    "--fee-payer",
    walletPath,
    "--mint-authority",
    walletPath,
    mint.toBase58(),
    "100",
    senderToken.toBase58(),
  ]);

  console.log("\nBUENA GIFT ESCROW — SURFPOOL DEMO");
  console.log(`program: ${program.programId.toBase58()}`);
  console.log(`sender:  ${payer.toBase58()}`);
  console.log(`mint:    ${mint.toBase58()}`);

  const initializeSignature = await program.methods
    .initialize(FEE_BPS)
    .accountsPartial({
      config,
      authority: payer,
      treasury: treasury.publicKey,
      researchOracle: researchOracle.publicKey,
      deliveryOracle: deliveryOracle.publicKey,
      allowedMint: mint,
      systemProgram: anchor.web3.SystemProgram.programId,
    })
    .rpc();
  printTransaction("1. Config initialized", initializeSignature);

  const nonce = new anchor.BN(Date.now());
  const nonceBytes = nonce.toArrayLike(Buffer, "le", 8);
  const [campaign] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("campaign"), payer.toBuffer(), nonceBytes],
    program.programId,
  );
  const [vault] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), campaign.toBuffer()],
    program.programId,
  );
  const expiresAt = new anchor.BN(Math.floor(Date.now() / 1000) + 60 * 60);

  const createSignature = await program.methods
    .createCampaign(nonce, BUDGET_BASE_UNITS, expiresAt)
    .accountsPartial({
      config,
      campaign,
      vault,
      sender: payer,
      senderToken,
      mint,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: anchor.web3.SystemProgram.programId,
    })
    .rpc();
  printTransaction("2. Campaign funded with 10 demo tokens", createSignature);
  console.log(`  campaign PDA: ${campaign.toBase58()}`);
  console.log(`  vault PDA:    ${vault.toBase58()}`);

  const briefPath = resolve("scripts/brief.example.json");
  const brief = readFileSync(briefPath);
  const researchHash = sha256(brief);
  const researchSignature = await program.methods
    .submitResearch(researchHash)
    .accountsPartial({
      config,
      campaign,
      researchOracle: researchOracle.publicKey,
    })
    .signers([researchOracle])
    .rpc();
  printTransaction("3. Consented demo brief hash submitted", researchSignature);
  console.log(`  research hash: ${Buffer.from(researchHash).toString("hex")}`);

  const briefJson = JSON.parse(brief.toString("utf8")) as {
    selectedSku: string;
  };
  const giftHash = sha256(briefJson.selectedSku);
  console.log("\nHUMAN GATE");
  console.log(`  proposed gift: ${briefJson.selectedSku}`);
  await pause("Approve this gift with the sender wallet?");
  const approveSignature = await program.methods
    .approveGift(giftHash)
    .accountsPartial({ campaign, sender: payer })
    .rpc();
  printTransaction("4. Gift approved by the human sender", approveSignature);
  console.log(`  gift hash: ${Buffer.from(giftHash).toString("hex")}`);

  await pause("Wait for the pastry/courier and capture proof of delivery.");
  const proof =
    PROOF_FILE && existsSync(PROOF_FILE)
      ? readFileSync(PROOF_FILE)
      : Buffer.from(`simulated-demo-proof:${campaign.toBase58()}`);
  const podHash = sha256(proof);
  const deliverySignature = await program.methods
    .confirmDelivery(podHash)
    .accountsPartial({
      config,
      campaign,
      vault,
      senderToken,
      treasuryToken,
      deliveryOracle: deliveryOracle.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([deliveryOracle])
    .rpc();
  printTransaction("5. Delivery confirmed; escrow settled", deliverySignature);
  console.log(`  proof hash: ${Buffer.from(podHash).toString("hex")}`);
  if (!PROOF_FILE) {
    console.log(
      "  proof source: simulated (set PROOF_FILE for the live photo)",
    );
  }

  const state = await program.account.campaign.fetch(campaign);
  console.log("\nFINAL ON-CHAIN STATE");
  console.log(JSON.stringify(state, null, 2));
  console.log(
    "\nNo recipient name, address, tastes, or photo was put on-chain.",
  );
}

main().catch((error: unknown) => {
  console.error("\nDemo failed:", error);
  process.exitCode = 1;
});
