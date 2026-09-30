//! Host-test helpers: accounts in the runtime's serialized layout.

use pinocchio::{
    account::{RuntimeAccount, NOT_BORROWED},
    AccountView, Address,
};

/// An owned runtime account (88-byte header followed by data), 8-byte
/// aligned like the loader's input buffer.
pub struct TestAccount {
    buffer: Vec<u64>,
}

impl TestAccount {
    pub fn new(address: Address, owner: Address, data: &[u8]) -> Self {
        let header = size_of::<RuntimeAccount>();
        let mut buffer = vec![0u64; (header + data.len()).div_ceil(8)];
        let bytes = buffer.as_mut_ptr() as *mut u8;
        // SAFETY: the buffer holds the header and the data.
        unsafe {
            let account = &mut *(bytes as *mut RuntimeAccount);
            account.borrow_state = NOT_BORROWED;
            account.is_writable = 1;
            account.padding = (data.len() as u32).to_le_bytes();
            account.address = address;
            account.owner = owner;
            account.lamports = 1;
            account.data_len = data.len() as u64;
            core::ptr::copy_nonoverlapping(data.as_ptr(), bytes.add(header), data.len());
        }
        Self { buffer }
    }

    pub fn view(&mut self) -> AccountView {
        // SAFETY: the buffer is a runtime account that outlives the view's use.
        unsafe { AccountView::new_unchecked(self.buffer.as_mut_ptr() as *mut RuntimeAccount) }
    }
}
