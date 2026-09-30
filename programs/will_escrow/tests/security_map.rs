//! SECURITY.md maps every security check to the tests that prove it. This
//! fails if a check lists no tests or names a test that does not exist, so
//! the document cannot drift from the suite.

use std::{collections::BTreeSet, fs, path::Path};

const CRATE: &str = env!("CARGO_MANIFEST_DIR");

/// Names of every `#[test]` function in `tests/` and `src/`.
fn test_names() -> BTreeSet<String> {
    fn scan(dir: &Path, names: &mut BTreeSet<String>) {
        for entry in fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                scan(&path, names);
            } else if path.extension().is_some_and(|ext| ext == "rs") {
                let source = fs::read_to_string(&path).unwrap();
                let mut after_test = false;
                for line in source.lines().map(str::trim) {
                    if line == "#[test]" {
                        after_test = true;
                    } else if after_test {
                        if let Some(rest) = line.strip_prefix("fn ") {
                            names.insert(rest.split('(').next().unwrap().to_string());
                            after_test = false;
                        }
                    }
                }
            }
        }
    }
    let mut names = BTreeSet::new();
    scan(&Path::new(CRATE).join("tests"), &mut names);
    scan(&Path::new(CRATE).join("src"), &mut names);
    names
}

/// (check, tests) for each row of the table under "## Checks".
fn checks() -> Vec<(String, Vec<String>)> {
    let document =
        fs::read_to_string(Path::new(CRATE).join("SECURITY.md")).expect("SECURITY.md exists");
    let section = document
        .split("## Checks")
        .nth(1)
        .expect("a Checks section");
    let section = section.split("\n## ").next().unwrap();
    section
        .lines()
        .filter(|line| {
            line.starts_with("| ") && !line.starts_with("| Check") && !line.starts_with("| ---")
        })
        .map(|line| {
            let cells: Vec<&str> = line.trim_matches('|').split(" | ").map(str::trim).collect();
            let tests = cells
                .last()
                .unwrap()
                .split('`')
                .skip(1)
                .step_by(2)
                .map(str::to_string)
                .collect();
            (cells[0].to_string(), tests)
        })
        .collect()
}

#[test]
fn every_check_maps_to_existing_tests() {
    let names = test_names();
    let checks = checks();
    assert!(checks.len() >= 15, "only {} checks listed", checks.len());
    for (check, tests) in &checks {
        assert!(!tests.is_empty(), "check without tests: {check}");
        for test in tests {
            assert!(names.contains(test), "{check}: no test named `{test}`");
        }
    }
}
