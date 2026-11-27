use std::{
    fs,
    io::ErrorKind,
    sync::{Arc, Barrier},
};

use super::load_or_initialize;
use tempfile::tempdir;

const KEY_FILE: &str = "desktop-vault.key.dpapi";

#[test]
fn persists_a_protected_key_across_restart() {
    let data = tempdir().unwrap();
    let first = load_or_initialize(data.path()).unwrap();
    let protected = fs::read(data.path().join(KEY_FILE)).unwrap();
    assert!(
        !protected
            .windows(first.len())
            .any(|window| window == first.as_slice())
    );
    fs::write(data.path().join("credentials.sqlite"), b"vault").unwrap();
    let restarted = load_or_initialize(data.path()).unwrap();
    assert_eq!(first.as_slice(), restarted.as_slice());
    assert_eq!(protected, fs::read(data.path().join(KEY_FILE)).unwrap());
}

#[test]
fn missing_or_corrupt_key_never_replaces_an_existing_vault() {
    let data = tempdir().unwrap();
    let vault = data.path().join("credentials.sqlite");
    let key = data.path().join(KEY_FILE);
    fs::write(&vault, b"vault").unwrap();
    assert_eq!(
        load_or_initialize(data.path()).err().unwrap().kind(),
        ErrorKind::NotFound
    );
    assert!(!key.exists());
    fs::write(&key, b"not a DPAPI blob").unwrap();
    assert!(load_or_initialize(data.path()).is_err());
    assert_eq!(fs::read(vault).unwrap(), b"vault");
    assert_eq!(fs::read(key).unwrap(), b"not a DPAPI blob");
}

#[test]
fn concurrent_initializations_converge_without_leaving_temporary_files() {
    let data = tempdir().unwrap();
    let barrier = Arc::new(Barrier::new(2));
    let path = data.path().to_path_buf();
    let peer = {
        let barrier = Arc::clone(&barrier);
        std::thread::spawn(move || {
            barrier.wait();
            load_or_initialize(&path).unwrap()
        })
    };
    barrier.wait();
    let key = load_or_initialize(data.path()).unwrap();
    assert_eq!(key.as_slice(), peer.join().unwrap().as_slice());
    assert_eq!(fs::read_dir(data.path()).unwrap().count(), 1);
}
