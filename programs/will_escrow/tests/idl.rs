//! The committed IDL must match what Codama derives from the source.
//! Regenerate with `UPDATE_IDL=1 cargo test -p will_escrow --features idl --test idl`.

use std::path::Path;

fn generated() -> serde_json::Value {
    let json = codama::Codama::load(env!("CARGO_MANIFEST_DIR"))
        .expect("codama parses the crate")
        .get_json_idl()
        .expect("codama renders the IDL");
    serde_json::from_str(&json).unwrap()
}

#[test]
fn idl_is_current() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("idl/will_escrow.json");
    let mut rendered = serde_json::to_string_pretty(&generated()).unwrap();
    rendered.push('\n');
    if std::env::var_os("UPDATE_IDL").is_some() {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, &rendered).unwrap();
    }
    let committed = std::fs::read_to_string(&path).unwrap_or_default();
    assert_eq!(committed, rendered, "stale IDL: rerun with UPDATE_IDL=1");
}

#[test]
fn idl_names_the_program_and_its_id() {
    let idl = generated();
    assert_eq!(idl["program"]["name"], "willEscrow");
    assert_eq!(idl["program"]["publicKey"], will_escrow::ID.to_string());
}
