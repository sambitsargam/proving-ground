//! Runs the real checker logic from JavaScript in mock mode. OutLayer runs the
//! WASI build instead. Only the transport differs: the host supplies the invoice
//! blob and the model's reply.
//!
//! Byte strings cross the boundary as a `u64` of `(ptr << 32) | len`.

use provingground_checker::{run, Config, Transport};

const NO_VALUE: u64 = u64::MAX;

#[link(wasm_import_module = "host")]
extern "C" {
    fn host_get(ptr: *const u8, len: usize) -> u64;
    fn host_model(ptr: *const u8, len: usize) -> u64;
}

fn pack(bytes: Vec<u8>) -> u64 {
    let leaked = Box::leak(bytes.into_boxed_slice());
    ((leaked.as_ptr() as u64) << 32) | leaked.len() as u64
}

fn unpack(value: u64) -> Result<Vec<u8>, String> {
    if value == NO_VALUE {
        return Err("host returned nothing".to_string());
    }
    let (ptr, len) = ((value >> 32) as usize, (value & 0xffff_ffff) as usize);
    // SAFETY: the host wrote `len` bytes at a pointer it got from `alloc`.
    Ok(unsafe { std::slice::from_raw_parts(ptr as *const u8, len) }.to_vec())
}

struct Host;

impl Transport for Host {
    fn get(&self, url: &str, _max_len: usize) -> Result<Vec<u8>, String> {
        // SAFETY: the pointer and length describe `url`, which outlives the call.
        unpack(unsafe { host_get(url.as_ptr(), url.len()) })
    }

    fn post_model(
        &self,
        _url: &str,
        _bearer: &str,
        body: &[u8],
        _max_len: usize,
    ) -> Result<Vec<u8>, String> {
        // SAFETY: the pointer and length describe `body`, which outlives the call.
        unpack(unsafe { host_model(body.as_ptr(), body.len()) })
    }
}

/// # Safety
/// The returned memory is only for the host to write into and pass back.
#[no_mangle]
pub unsafe extern "C" fn alloc(len: usize) -> *mut u8 {
    Box::leak(vec![0u8; len].into_boxed_slice()).as_mut_ptr()
}

/// Returns the checker's output, or `NO_VALUE` when the run ends with no verdict.
///
/// # Safety
/// `input` and the 32-byte `secret_key` must be memory written by the host.
#[no_mangle]
pub unsafe extern "C" fn check(input: *const u8, input_len: usize, secret_key: *const u8) -> u64 {
    let input = std::slice::from_raw_parts(input, input_len);
    let mut key = [0u8; 32];
    key.copy_from_slice(std::slice::from_raw_parts(secret_key, 32));
    let config = Config {
        secret_key: key,
        api_key: String::new(),
        blob_base_url: "mock:".to_string(),
        model_endpoint: "mock:".to_string(),
    };
    match run(input, &config, &Host) {
        Ok(output) => pack(output.into_bytes()),
        Err(_) => NO_VALUE,
    }
}
