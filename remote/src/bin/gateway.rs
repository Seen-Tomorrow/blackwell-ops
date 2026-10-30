//! Standalone remote gateway for local/Cloudflare smoke testing.
//!
//! ```text
//! cargo run --manifest-path remote/Cargo.toml --bin blackwell-gateway -- \
//!   --bind 127.0.0.1:7443 --data-dir tmp/remote-data
//! ```

use blackwell_remote::protocol::ModelRoute;
use blackwell_remote::{serve, RemoteConfig, RemoteState, RouteBinding, SERVER_VERSION};
use std::net::SocketAddr;
use std::path::PathBuf;

#[tokio::main]
async fn main() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
    let mut bind: SocketAddr = "127.0.0.1:7443".parse().expect("static socket addr");
    let mut public_url = std::env::var("BLACKWELL_REMOTE_PUBLIC_URL")
        .ok()
        .filter(|value| !value.trim().is_empty());
    let mut data_dir = PathBuf::from("tmp/remote-data");
    let mut engine_port: Option<u16> = None;
    let mut model = "BRAIN".to_string();
    let mut label = "local".to_string();
    let mut print_pairing_code = false;
    let mut auto_session = false;

    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--bind" => {
                if let Some(value) = args.next() {
                    bind = value.parse().expect("--bind must be ip:port");
                }
            }
            "--public-url" => public_url = args.next(),
            "--data-dir" => {
                if let Some(value) = args.next() {
                    data_dir = PathBuf::from(value);
                }
            }
            "--engine-port" => {
                engine_port = args.next().and_then(|value| value.parse().ok());
            }
            "--model" => {
                if let Some(value) = args.next() {
                    model = value;
                }
            }
            "--label" => {
                if let Some(value) = args.next() {
                    label = value;
                }
            }
            "--pair-code" => print_pairing_code = true,
            "--auto-session" => auto_session = true,
            other => {
                eprintln!("unknown argument: {other}");
                std::process::exit(2);
            }
        }
    }

    let state = match RemoteState::load(RemoteConfig {
        bind,
        public_url: public_url.clone(),
        data_dir,
        auto_session,
    }) {
        Ok(state) => state,
        Err(error) => {
            eprintln!("gateway state: {error}");
            std::process::exit(1);
        }
    };

    if let Some(port) = engine_port {
        state
            .set_routes(vec![RouteBinding {
                route: ModelRoute {
                    id: "route_1".into(),
                    label,
                    model,
                    context_window: 32768,
                    vision: false,
                },
                engine_port: port,
            }])
            .await;
        println!("model route route_1 -> 127.0.0.1:{port}");
    }

    println!("Blackwell remote gateway {SERVER_VERSION}");
    println!("bind: http://{bind}");
    println!(
        "public: {}",
        public_url.as_deref().unwrap_or("<not configured>")
    );
    println!("health: /healthz (alias /health)");
    if print_pairing_code {
        let pairing = state.create_pairing().await;
        println!("pairing code: {}", pairing.code);
        println!("pairing command: {}", pairing.command);
    }

    if let Err(error) = serve(state).await {
        eprintln!("gateway: {error}");
        std::process::exit(1);
    }
}
