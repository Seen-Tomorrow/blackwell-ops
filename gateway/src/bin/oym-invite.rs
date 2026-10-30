//! Owner-side invite administration.
//!
//! Invites are created only from the local machine that owns the gateway data
//! directory. The plaintext token is printed once; only its hash is stored.

use oym_gateway::invites;
use std::path::PathBuf;

fn usage() -> ! {
    eprintln!(
        "oym-invite <create|list|revoke> --data-dir <dir> [options]\n\
         \n\
         create: --owner NAME [--ttl-hours 72] [--json]\n\
         list\n\
         revoke: --id inv_..."
    );
    std::process::exit(2);
}

fn value(args: &mut impl Iterator<Item = String>, flag: &str) -> String {
    args.next().unwrap_or_else(|| {
        eprintln!("{flag} requires a value");
        std::process::exit(2);
    })
}

fn main() {
    let mut args = std::env::args().skip(1);
    let command = args.next().unwrap_or_else(|| usage());
    let mut data_dir: Option<PathBuf> = None;
    let mut owner: Option<String> = None;
    let mut ttl_hours = invites::DEFAULT_TTL_HOURS;
    let mut id: Option<String> = None;
    let mut json = false;

    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--data-dir" => data_dir = Some(PathBuf::from(value(&mut args, "--data-dir"))),
            "--owner" => owner = Some(value(&mut args, "--owner")),
            "--ttl-hours" => {
                ttl_hours = value(&mut args, "--ttl-hours").parse().unwrap_or_else(|_| {
                    eprintln!("--ttl-hours must be a number");
                    std::process::exit(2);
                })
            }
            "--id" => id = Some(value(&mut args, "--id")),
            "--json" => json = true,
            other => {
                eprintln!("unknown argument: {other}");
                usage();
            }
        }
    }

    let Some(data_dir) = data_dir else {
        eprintln!("--data-dir is required");
        usage();
    };

    match command.as_str() {
        "create" => match invites::create(&data_dir, owner, ttl_hours) {
            Ok((token, record)) => {
                if json {
                    println!(
                        "{}",
                        serde_json::json!({
                            "token": token,
                            "id": record.id,
                            "owner": record.owner,
                            "createdAt": record.created_at,
                            "expiresAt": record.expires_at,
                        })
                    );
                } else {
                    println!("invite token: {token}");
                    println!("id: {}", record.id);
                    println!("owner: {}", record.owner.unwrap_or_default());
                    println!("expires: {} (unix)", record.expires_at);
                    println!();
                    println!("Send this token only inside the helper package. It is single-use.");
                }
            }
            Err(error) => {
                eprintln!("create invite: {error}");
                std::process::exit(1);
            }
        },
        "list" => {
            let invites = invites::list(&data_dir);
            if invites.is_empty() {
                println!("no invites");
                return;
            }
            for record in invites {
                let state = if record.revoked {
                    "revoked"
                } else if record.used_at.is_some() {
                    "used"
                } else {
                    "unused"
                };
                println!(
                    "{}  {}  owner={}  expires={}  {}",
                    record.id,
                    state,
                    record.owner.as_deref().unwrap_or("-"),
                    record.expires_at,
                    record.used_at.map(|used| format!("usedAt={used}")).unwrap_or_default()
                );
            }
        }
        "revoke" => {
            let Some(id) = id else {
                eprintln!("revoke requires --id");
                usage();
            };
            match invites::revoke(&data_dir, &id) {
                Ok(true) => println!("revoked {id}"),
                Ok(false) => {
                    eprintln!("invite not found: {id}");
                    std::process::exit(1);
                }
                Err(error) => {
                    eprintln!("revoke invite: {error}");
                    std::process::exit(1);
                }
            }
        }
        other => {
            eprintln!("unknown command: {other}");
            usage();
        }
    }
}
