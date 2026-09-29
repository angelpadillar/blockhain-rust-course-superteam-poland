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

/// Every `definedTypeLinkNode` must name a type the IDL defines, or the
/// generated client will not compile.
#[test]
fn idl_type_links_resolve() {
    fn links(value: &serde_json::Value, out: &mut Vec<String>) {
        match value {
            serde_json::Value::Object(map) => {
                if map.get("kind").and_then(|k| k.as_str()) == Some("definedTypeLinkNode") {
                    out.push(map["name"].as_str().unwrap().to_string());
                }
                map.values().for_each(|v| links(v, out));
            }
            serde_json::Value::Array(items) => items.iter().for_each(|v| links(v, out)),
            _ => {}
        }
    }
    let idl = generated();
    let defined: Vec<&str> = idl["program"]["definedTypes"]
        .as_array()
        .map(|types| types.iter().map(|t| t["name"].as_str().unwrap()).collect())
        .unwrap_or_default();
    let mut used = Vec::new();
    links(&idl, &mut used);
    let missing: Vec<&String> = used
        .iter()
        .filter(|name| !defined.contains(&name.as_str()))
        .collect();
    assert!(missing.is_empty(), "undefined types: {missing:?}");
}
