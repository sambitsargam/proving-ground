//! OutLayer entry point: input on stdin, verdict on stdout, secrets in the
//! environment. A failed run exits non-zero and prints nothing to stdout, which
//! OutLayer reports as `null` and the contract parks as `CHECKER_UNAVAILABLE`.

#[cfg(target_os = "wasi")]
mod wasi {
    use std::io::Read;
    use std::time::Duration;

    use provingground_checker::{envelope, run, Config, Transport, MAX_INPUT_LEN, MODEL_ENDPOINT};
    use wasi_http_client::{Client, Response};

    const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
    const READ_CHUNK: u64 = 16 * 1024;

    struct WasiHttp;

    fn read_limited(response: Response, max_len: usize) -> Result<Vec<u8>, String> {
        let status = response.status();
        if !(200..300).contains(&status) {
            return Err(format!("http {status}"));
        }
        let mut body = Vec::new();
        while body.len() <= max_len {
            match response.chunk(READ_CHUNK).map_err(|_| "read failed")? {
                Some(mut chunk) => body.append(&mut chunk),
                None => break,
            }
        }
        Ok(body)
    }

    impl Transport for WasiHttp {
        fn get(&self, url: &str, max_len: usize) -> Result<Vec<u8>, String> {
            let response = Client::new()
                .get(url)
                .connect_timeout(CONNECT_TIMEOUT)
                .send()
                .map_err(|_| "request failed")?;
            read_limited(response, max_len)
        }

        fn post_model(
            &self,
            url: &str,
            bearer: &str,
            body: &[u8],
            max_len: usize,
        ) -> Result<Vec<u8>, String> {
            let response = Client::new()
                .post(url)
                .header("Authorization", format!("Bearer {bearer}"))
                .header("Content-Type", "application/json")
                .header("x-no-aliasing", "true")
                .body(body)
                .connect_timeout(CONNECT_TIMEOUT)
                .send()
                .map_err(|_| "request failed")?;
            read_limited(response, max_len)
        }
    }

    fn model_endpoint() -> String {
        #[cfg(feature = "local-model")]
        if let Ok(url) = std::env::var("MODEL_ENDPOINT") {
            return url;
        }
        MODEL_ENDPOINT.to_string()
    }

    fn config() -> Result<Config, String> {
        let var = |name: &str| std::env::var(name).map_err(|_| format!("{name} is not set"));
        let secret_key = envelope::decode_hex(&var("CHECKER_SECRET_KEY")?)
            .and_then(|bytes| <[u8; 32]>::try_from(bytes).ok())
            .ok_or("CHECKER_SECRET_KEY is not 32 bytes of hex")?;
        Ok(Config {
            secret_key,
            api_key: var("NEAR_AI_API_KEY")?,
            blob_base_url: var("BLOB_BASE_URL")?,
            model_endpoint: model_endpoint(),
        })
    }

    pub fn execute() -> Result<String, String> {
        let mut input = Vec::new();
        std::io::stdin()
            .take(MAX_INPUT_LEN as u64 + 1)
            .read_to_end(&mut input)
            .map_err(|_| "could not read input")?;
        run(&input, &config()?, &WasiHttp)
    }
}

#[cfg(not(target_os = "wasi"))]
mod wasi {
    pub fn execute() -> Result<String, String> {
        Err("build for wasm32-wasip2".into())
    }
}

fn main() -> std::process::ExitCode {
    match wasi::execute() {
        Ok(output) => {
            println!("{output}");
            std::process::ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("{error}");
            std::process::ExitCode::FAILURE
        }
    }
}
