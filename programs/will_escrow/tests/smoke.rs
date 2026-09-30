//! The deployed binary's entrypoint parses input and dispatches.
//! Needs `cargo build-sbf --manifest-path programs/will_escrow/Cargo.toml`.

use {
    litesvm::LiteSVM,
    solana_instruction::Instruction,
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::versioned::VersionedTransaction,
};

fn program() -> Vec<u8> {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../target/deploy/will_escrow.so"
    );
    std::fs::read(path).expect("build will_escrow.so first")
}

#[test]
fn entrypoint_rejects_empty_and_unknown_instructions() {
    let mut svm = LiteSVM::new();
    svm.add_program(will_escrow::ID, &program()).unwrap();
    let payer = Keypair::new();
    svm.airdrop(&payer.pubkey(), 1_000_000_000).unwrap();
    for data in [vec![], vec![200u8, 1, 2, 3]] {
        let instruction = Instruction::new_with_bytes(will_escrow::ID, &data, vec![]);
        let message = Message::new_with_blockhash(
            &[instruction],
            Some(&payer.pubkey()),
            &svm.latest_blockhash(),
        );
        let transaction =
            VersionedTransaction::try_new(VersionedMessage::Legacy(message), &[&payer]).unwrap();
        let error = svm.send_transaction(transaction).unwrap_err();
        assert_eq!(
            format!("{:?}", error.err),
            "InstructionError(0, InvalidInstructionData)"
        );
        svm.expire_blockhash();
    }
}
