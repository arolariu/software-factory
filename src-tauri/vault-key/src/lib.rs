#![cfg(windows)]

use std::{
    fs::{self, OpenOptions},
    io::{self, ErrorKind, Read, Write},
    os::windows::fs::{MetadataExt, OpenOptionsExt},
    path::Path,
    ptr::{null, null_mut},
    slice,
};

use windows_sys::Win32::{
    Foundation::LocalFree,
    Security::Cryptography::{
        BCRYPT_USE_SYSTEM_PREFERRED_RNG, BCryptGenRandom, CRYPT_INTEGER_BLOB,
        CRYPTPROTECT_UI_FORBIDDEN, CryptProtectData, CryptUnprotectData,
    },
    Storage::FileSystem::{FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_OPEN_REPARSE_POINT},
};
use zeroize::{Zeroize, Zeroizing};

const KEY_FILE: &str = "desktop-vault.key.dpapi";
const MAX_PROTECTED_SIZE: u64 = 4096;
const PURPOSE: &[u8] = b"software-factory/desktop-vault/v1";

type Key = Zeroizing<[u8; 32]>;

struct DpapiOutput {
    blob: CRYPT_INTEGER_BLOB,
    secret: bool,
}

impl DpapiOutput {
    fn new(secret: bool) -> Self {
        Self {
            blob: CRYPT_INTEGER_BLOB {
                cbData: 0,
                pbData: null_mut(),
            },
            secret,
        }
    }

    fn as_bytes(&self) -> &[u8] {
        if self.blob.pbData.is_null() {
            return &[];
        }
        // DPAPI returns a local allocation of cbData bytes owned by this guard.
        unsafe { slice::from_raw_parts(self.blob.pbData, self.blob.cbData as usize) }
    }
}

impl Drop for DpapiOutput {
    fn drop(&mut self) {
        if !self.blob.pbData.is_null() {
            unsafe {
                if self.secret {
                    slice::from_raw_parts_mut(self.blob.pbData, self.blob.cbData as usize)
                        .zeroize();
                }
                LocalFree(self.blob.pbData.cast());
            }
        }
    }
}

fn input_blob(bytes: &[u8]) -> CRYPT_INTEGER_BLOB {
    CRYPT_INTEGER_BLOB {
        cbData: bytes.len() as u32,
        pbData: bytes.as_ptr().cast_mut(),
    }
}

fn read_key(path: &Path) -> io::Result<Key> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(io::Error::new(
            ErrorKind::InvalidData,
            "Unsafe desktop vault key path.",
        ));
    }
    let mut bytes = Vec::new();
    file.take(MAX_PROTECTED_SIZE + 1).read_to_end(&mut bytes)?;
    if bytes.is_empty() || bytes.len() as u64 > MAX_PROTECTED_SIZE {
        return Err(io::Error::new(
            ErrorKind::InvalidData,
            "Invalid desktop vault key size.",
        ));
    }
    let mut plain = DpapiOutput::new(true);
    // Both input blobs remain live throughout this call; the output owns the local allocation.
    let ok = unsafe {
        CryptUnprotectData(
            &input_blob(&bytes),
            null_mut(),
            &input_blob(PURPOSE),
            null(),
            null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut plain.blob,
        )
    };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    let mut key = Key::new([0; 32]);
    if plain.as_bytes().len() != key.len() {
        return Err(io::Error::new(
            ErrorKind::InvalidData,
            "Invalid plaintext vault key size.",
        ));
    }
    key.copy_from_slice(plain.as_bytes());
    Ok(key)
}

/// Opens the Windows-user-protected key in a private Factory data directory.
/// The caller must own the single-instance lock before opening the credential vault.
pub fn load_or_initialize(data_dir: &Path) -> io::Result<Key> {
    let path = data_dir.join(KEY_FILE);
    match read_key(&path) {
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        result => return result,
    }
    match fs::symlink_metadata(data_dir.join("credentials.sqlite")) {
        Ok(_) => {
            return Err(io::Error::new(
                ErrorKind::NotFound,
                "Desktop vault key is missing for the existing vault.",
            ));
        }
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }

    let mut key = Key::new([0; 32]);
    let status = unsafe {
        BCryptGenRandom(
            null_mut(),
            key.as_mut_ptr(),
            key.len() as u32,
            BCRYPT_USE_SYSTEM_PREFERRED_RNG,
        )
    };
    if status < 0 {
        return Err(io::Error::other(
            "Windows could not generate a desktop vault key.",
        ));
    }
    let mut encrypted = DpapiOutput::new(false);
    let ok = unsafe {
        CryptProtectData(
            &input_blob(key.as_slice()),
            null(),
            &input_blob(PURPOSE),
            null(),
            null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut encrypted.blob,
        )
    };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    let mut staged = tempfile::NamedTempFile::new_in(data_dir)?;
    staged.write_all(encrypted.as_bytes())?;
    staged.as_file().sync_all()?;
    // Publish a complete blob without ever replacing a key chosen by another process.
    match fs::hard_link(staged.path(), &path) {
        Ok(()) => Ok(key),
        Err(error) if error.kind() == ErrorKind::AlreadyExists => read_key(&path),
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod tests;
