use clap::{Parser, Subcommand};
use passshare_connect::{parse_op_reference, ConnectClient};
use passshare_core::domain::connect_id::ConnectId;
use passshare_core::domain::field::FieldPurpose;
use passshare_core::domain::item::Item;
use serde_json::{json, Value};

mod encrypted;

#[derive(Parser)]
#[command(name = "op", about = "PassShare 1Password Connect compatible CLI")]
struct Cli {
    /// Use the live PassShare session API for an encrypted password box.
    #[arg(long, global = true)]
    encrypted: bool,
    /// Read as a shared recipient using independently verified trust inputs on stdin.
    #[arg(long, global = true, requires_all = ["encrypted", "secret_stdin"])]
    recipient: bool,
    /// Read session credentials and secret operation input as JSON from a pipe.
    #[arg(long, global = true)]
    secret_stdin: bool,
    /// PassShare origin; separate from OP_CONNECT_HOST.
    #[arg(long, global = true)]
    passshare_host: Option<String>,
    /// Password box ID for encrypted `vault list` (no account-wide discovery).
    #[arg(long, global = true)]
    password_box: Option<String>,
    /// Output a prepared opaque write without sending it; retain for explicit replay.
    #[arg(long, global = true)]
    prepare_only: bool,
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Password box operations (op-compatible command spelling)
    Vault {
        #[command(subcommand)]
        command: VaultCommands,
    },
    /// Item operations
    Item {
        #[command(subcommand)]
        command: ItemCommands,
    },
    /// Read op:// secret reference
    Read { reference: String },
    /// Download an authenticated encrypted attachment to an explicit new file.
    Attachment {
        #[command(subcommand)]
        command: AttachmentCommands,
    },
}

#[derive(Subcommand)]
enum AttachmentCommands {
    Get {
        attachment: String,
        #[arg(long)]
        item: String,
        #[arg(long)]
        vault: String,
        #[arg(long)]
        out: std::path::PathBuf,
        /// Print the authenticated original name as a JSON string after saving.
        #[arg(long)]
        print_name: bool,
    },
}

#[derive(Subcommand)]
enum VaultCommands {
    /// List password boxes
    List,
}

#[derive(Subcommand)]
enum ItemCommands {
    /// Explicitly resend a previously prepared encrypted write, unchanged.
    Retry {
        #[arg(long)]
        vault: String,
    },
    /// List items in a password box
    List {
        #[arg(long)]
        vault: String,
    },
    /// Get item details
    Get {
        item: String,
        #[arg(long)]
        vault: String,
        #[arg(long)]
        fields: Option<String>,
    },
    /// Create an item
    Create {
        #[arg(long)]
        vault: String,
        #[arg(long)]
        category: Option<String>,
        #[arg(long)]
        title: Option<String>,
        #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
        assignments: Vec<String>,
    },
    /// Edit item fields
    Edit {
        item: String,
        #[arg(long)]
        vault: String,
        #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
        assignments: Vec<String>,
    },
    /// Delete an item
    Delete {
        item: String,
        #[arg(long)]
        vault: String,
    },
}

#[tokio::main]
async fn main() -> std::process::ExitCode {
    let encrypted_requested = std::env::args().any(|arg| arg.starts_with("--encrypted"));
    let cli = match Cli::try_parse() {
        Ok(cli) => cli,
        Err(error) => {
            if matches!(
                error.kind(),
                clap::error::ErrorKind::DisplayHelp | clap::error::ErrorKind::DisplayVersion
            ) {
                let _ = error.print();
                return std::process::ExitCode::SUCCESS;
            }
            if encrypted_requested
                || std::env::args()
                    .any(|arg| arg.starts_with("--secret-stdin") || arg.starts_with("--recipient"))
            {
                eprintln!("invalid encrypted command options; use --help (secret input is never an argument)");
            } else {
                let _ = error.print();
            }
            return std::process::ExitCode::FAILURE;
        }
    };
    if encrypted_requested && !cli.encrypted {
        eprintln!("place --encrypted before trailing assignments; encrypted commands never use Connect credentials");
        return std::process::ExitCode::FAILURE;
    }
    let result = if cli.encrypted {
        encrypted::run(cli)
            .await
            .map_err(|error| -> Box<dyn std::error::Error> { error.into() })
    } else {
        run_connect(cli).await
    };
    match result {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("{error}");
            std::process::ExitCode::FAILURE
        }
    }
}

async fn run_connect(cli: Cli) -> Result<(), Box<dyn std::error::Error>> {
    if cli.secret_stdin
        || cli.passshare_host.is_some()
        || cli.password_box.is_some()
        || cli.prepare_only
        || cli.recipient
    {
        return Err("PassShare encrypted options require --encrypted".into());
    }
    let client = ConnectClient::from_env()?;

    match cli.command {
        Commands::Attachment { .. } => {
            return Err("attachment get requires --encrypted --recipient".into())
        }
        Commands::Vault { command } => match command {
            VaultCommands::List => {
                let vaults = client.list_vaults().await?;
                for vault in vaults {
                    println!("{}\t{}", vault.id, vault.name);
                }
            }
        },
        Commands::Item { command } => match command {
            ItemCommands::Retry { .. } => return Err("retry requires --encrypted".into()),
            ItemCommands::List { vault } => {
                let vault_id = resolve_vault_id(&client, &vault).await?;
                let items = client.list_items(&vault_id).await?;
                for item in items {
                    println!("{}\t{}", item.id, item.title);
                }
            }
            ItemCommands::Get {
                item,
                vault,
                fields,
            } => {
                let vault_id = resolve_vault_id(&client, &vault).await?;
                let item_id = resolve_item_id(&client, &vault_id, &item).await?;
                let detail = client.get_item(&vault_id, &item_id).await?;
                if let Some(field_name) = fields {
                    if let Some(value) = extract_field(&detail, &field_name) {
                        println!("{value}");
                    } else {
                        eprintln!("field not found: {field_name}");
                        std::process::exit(1);
                    }
                } else {
                    println!("{}", serde_json::to_string_pretty(&detail)?);
                }
            }
            ItemCommands::Create {
                vault,
                category,
                title,
                assignments,
            } => {
                let vault_id = resolve_vault_id(&client, &vault).await?;
                let fields = parse_assignments(&assignments)?;
                let payload = build_create_payload(
                    category.as_deref().unwrap_or("login"),
                    title.as_deref(),
                    &fields,
                )?;
                let created = client.create_item(&vault_id, &payload).await?;
                println!("{}", created.id);
            }
            ItemCommands::Edit {
                item,
                vault,
                assignments,
            } => {
                let vault_id = resolve_vault_id(&client, &vault).await?;
                let item_id = resolve_item_id(&client, &vault_id, &item).await?;
                let detail = client.get_item(&vault_id, &item_id).await?;
                let fields = parse_assignments(&assignments)?;
                let patch = build_edit_patch(&detail, &fields)?;
                let updated = client.patch_item(&vault_id, &item_id, &patch).await?;
                println!("{}", updated.id);
            }
            ItemCommands::Delete { item, vault } => {
                let vault_id = resolve_vault_id(&client, &vault).await?;
                let item_id = resolve_item_id(&client, &vault_id, &item).await?;
                client.delete_item(&vault_id, &item_id).await?;
            }
        },
        Commands::Read { reference } => {
            let op_ref = parse_op_reference(&reference)
                .ok_or("invalid op:// reference (expected op://vault/item/field)")?;
            let vault_id = resolve_vault_id(&client, &op_ref.vault).await?;
            let item_id = resolve_item_id(&client, &vault_id, &op_ref.item).await?;
            let detail = client.get_item(&vault_id, &item_id).await?;
            let value = extract_field(&detail, &op_ref.field)
                .ok_or(format!("field not found: {}", op_ref.field))?;
            println!("{value}");
        }
    }

    Ok(())
}

async fn resolve_vault_id(
    client: &ConnectClient,
    vault: &str,
) -> Result<String, Box<dyn std::error::Error>> {
    // Only treat the argument as a raw ID when it matches the real ConnectId
    // charset (26 lowercase alphanumerics); otherwise resolve it as a name so a
    // 26-char or mixed-case vault name is not misrouted as an ID.
    if ConnectId::validate(vault).is_ok() {
        return Ok(vault.to_string());
    }
    let vaults = client.list_vaults().await?;
    vaults
        .into_iter()
        .find(|v| v.name == vault)
        .map(|v| v.id.to_string())
        .ok_or_else(|| format!("password box not found: {vault}").into())
}

async fn resolve_item_id(
    client: &ConnectClient,
    vault_id: &str,
    item: &str,
) -> Result<String, Box<dyn std::error::Error>> {
    if ConnectId::validate(item).is_ok() {
        return Ok(item.to_string());
    }
    let items = client.list_items(vault_id).await?;
    items
        .into_iter()
        .find(|i| i.title == item)
        .map(|i| i.id)
        .ok_or_else(|| format!("item not found: {item}").into())
}

fn parse_assignments(
    assignments: &[String],
) -> Result<Vec<(String, String)>, Box<dyn std::error::Error>> {
    let mut fields = Vec::new();
    for assignment in assignments {
        let Some((key, value)) = assignment.split_once('=') else {
            return Err(format!("invalid assignment (expected key=value): {assignment}").into());
        };
        if key.is_empty() {
            return Err(format!("invalid assignment (empty key): {assignment}").into());
        }
        fields.push((key.to_string(), value.to_string()));
    }
    Ok(fields)
}

fn build_create_payload(
    category: &str,
    title: Option<&str>,
    fields: &[(String, String)],
) -> Result<Value, Box<dyn std::error::Error>> {
    let category = category.to_ascii_uppercase();
    let item_title = title
        .map(str::to_string)
        .or_else(|| {
            fields
                .iter()
                .find(|(k, _)| k.eq_ignore_ascii_case("title"))
                .map(|(_, v)| v.clone())
        })
        .ok_or("missing --title or title= assignment")?;

    let json_fields: Vec<Value> = fields
        .iter()
        .filter(|(key, _)| !key.eq_ignore_ascii_case("title"))
        .map(|(key, value)| field_json(key, value))
        .collect();

    if json_fields.is_empty() {
        return Err("at least one field assignment is required".into());
    }

    Ok(json!({
        "title": item_title,
        "category": category,
        "fields": json_fields,
    }))
}

fn build_edit_patch(
    item: &Item,
    fields: &[(String, String)],
) -> Result<Value, Box<dyn std::error::Error>> {
    let mut patch = Vec::new();
    for (key, value) in fields {
        if key.eq_ignore_ascii_case("title") {
            patch.push(json!({ "op": "replace", "path": "/title", "value": value }));
            continue;
        }
        let index = find_field_index(item, key).ok_or_else(|| format!("field not found: {key}"))?;
        patch.push(json!({
            "op": "replace",
            "path": format!("/fields/{index}/value"),
            "value": value,
        }));
    }
    if patch.is_empty() {
        return Err("at least one field assignment is required".into());
    }
    Ok(Value::Array(patch))
}

fn field_json(key: &str, value: &str) -> Value {
    let (field_type, purpose) = if key.eq_ignore_ascii_case("password") {
        ("CONCEALED", "PASSWORD")
    } else if key.eq_ignore_ascii_case("username") {
        ("STRING", "USERNAME")
    } else {
        ("STRING", "NOTES")
    };
    json!({
        "label": key,
        "type": field_type,
        "purpose": purpose,
        "value": value,
    })
}

fn find_field_index(item: &Item, field: &str) -> Option<usize> {
    if field.eq_ignore_ascii_case("password") {
        return item
            .fields
            .iter()
            .position(|f| f.purpose == Some(FieldPurpose::Password));
    }
    if field.eq_ignore_ascii_case("username") {
        return item
            .fields
            .iter()
            .position(|f| f.purpose == Some(FieldPurpose::Username));
    }
    item.fields
        .iter()
        .position(|f| f.label.eq_ignore_ascii_case(field))
}

fn extract_field(item: &Item, field: &str) -> Option<String> {
    if field.eq_ignore_ascii_case("password") {
        return item.field_value_by_purpose(FieldPurpose::Password);
    }
    if field.eq_ignore_ascii_case("username") {
        return item.field_value_by_purpose(FieldPurpose::Username);
    }
    item.field_value_by_label(field).or_else(|| {
        item.fields
            .iter()
            .find(|f| f.label.eq_ignore_ascii_case(field))
            .map(|f| f.value.clone())
    })
}
