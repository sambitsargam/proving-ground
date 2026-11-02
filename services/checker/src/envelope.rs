use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};
use hkdf::Hkdf;
use serde::Deserialize;
use sha2::Sha256;
use x25519_dalek::{PublicKey, StaticSecret};

const KDF_INFO: &[u8] = b"provingground/checker/blob/v1";

/// An invoice and purpose sealed to the checker's public key. Agents can seal
/// with the public key, but only the checker can open what was sealed.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Envelope {
    v: u8,
    epk: String,
    nonce: String,
    ct: String,
}

/// What a sealed blob contains. Both texts are checked against on-chain hashes.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Sealed {
    pub invoice: String,
    pub purpose: String,
    pub purpose_salt: String,
}

fn cipher(shared: &[u8; 32], epk: &[u8; 32], recipient: &[u8; 32]) -> Option<ChaCha20Poly1305> {
    let mut salt = [0u8; 64];
    salt[..32].copy_from_slice(epk);
    salt[32..].copy_from_slice(recipient);
    let mut key = [0u8; 32];
    Hkdf::<Sha256>::new(Some(&salt), shared).expand(KDF_INFO, &mut key).ok()?;
    Some(ChaCha20Poly1305::new(Key::from_slice(&key)))
}

pub fn open(blob: &[u8], secret_key: &[u8; 32]) -> Option<Sealed> {
    let envelope: Envelope = serde_json::from_slice(blob).ok()?;
    if envelope.v != 1 {
        return None;
    }
    let epk: [u8; 32] = decode_hex(&envelope.epk)?.try_into().ok()?;
    let nonce: [u8; 12] = decode_hex(&envelope.nonce)?.try_into().ok()?;
    let ciphertext = decode_hex(&envelope.ct)?;

    let secret = StaticSecret::from(*secret_key);
    let shared = secret.diffie_hellman(&PublicKey::from(epk));
    if !shared.was_contributory() {
        return None;
    }
    let recipient = PublicKey::from(&secret);
    let plaintext = cipher(shared.as_bytes(), &epk, recipient.as_bytes())?
        .decrypt(Nonce::from_slice(&nonce), ciphertext.as_slice())
        .ok()?;
    serde_json::from_slice(&plaintext).ok()
}

/// Seals with caller-supplied randomness. The guard SDK is what agents use;
/// this exists so the opening side can be tested without it.
pub fn seal(
    plaintext: &[u8],
    recipient: &[u8; 32],
    ephemeral: &[u8; 32],
    nonce: &[u8; 12],
) -> Vec<u8> {
    let ephemeral = StaticSecret::from(*ephemeral);
    let epk = PublicKey::from(&ephemeral);
    let shared = ephemeral.diffie_hellman(&PublicKey::from(*recipient));
    let ciphertext = cipher(shared.as_bytes(), epk.as_bytes(), recipient)
        .and_then(|cipher| cipher.encrypt(Nonce::from_slice(nonce), plaintext).ok())
        .unwrap_or_default();
    serde_json::json!({
        "v": 1,
        "epk": encode_hex(epk.as_bytes()),
        "nonce": encode_hex(nonce),
        "ct": encode_hex(&ciphertext),
    })
    .to_string()
    .into_bytes()
}

pub fn public_key(secret_key: &[u8; 32]) -> [u8; 32] {
    *PublicKey::from(&StaticSecret::from(*secret_key)).as_bytes()
}

pub fn decode_hex(text: &str) -> Option<Vec<u8>> {
    if !text.len().is_multiple_of(2) {
        return None;
    }
    text.as_bytes()
        .chunks(2)
        .map(|pair| {
            let high = (pair[0] as char).to_digit(16)?;
            let low = (pair[1] as char).to_digit(16)?;
            Some((high * 16 + low) as u8)
        })
        .collect()
}

pub fn encode_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
