//! Provider configuration — three-layer model and template merge.
//!
//! ## Layers
//! 1. **Factory** — `runtime/<id>/config/<id>-default-config.json` (admin, read-only at runtime)
//! 2. **User disk** — `config/<id>-user-config.json` (hidden, order, defaults, custom params/values)
//! 3. **localStorage** — `BlackOps-catalog-override:<id>` (launch-time chip selections; frontend only)
//!
//! ## Merge (`merge_template_for_provider`)
//! Runs on every load and `save_provider`. Factory structural fields backfill; user cosmetic choices
//! (hidden, userHidden, order, userAddedValues, hidden_values, values) are never overwritten.
//!
//! ## RESET TO DEFAULTS
//! Deletes user config file + frontend clears overrides and group-order localStorage. Full factory wipe.
//!
//! ## Validation
//! `save_provider` and `save_user_providers_meta` block-save on invalid params (orphan defaults,
//! missing flags, duplicate keys).
//!
//! ## Module layout
//! This file is the **re-export hub** for the config subsystem. Implementation lives in the
//! submodules below; `pub use` keeps the historical `crate::config::…` call sites working unchanged.
//!
//! - [`paths`] — path/dir infra, portable-structure setup, shared constants
//! - [`meta`] — `ProviderConfig` / `AppConfig` persistence, per-provider user config files
//! - [`validate`] — provider param validation + block-save
//! - [`discovery`] — disk discovery, full config assembly, template-type resolution
//! - [`model_library`] — model path management + download destination validation
//! - [`hf_download`] — HuggingFace download/quant validation
//! - [`merge`] — factory-template ↔ user-param merge
//! - [`commands`] — app-config load/save + reset/setup Tauri commands
//! - [`export`] — factory template export (admin/dev)

pub mod commands;
pub mod discovery;
pub mod export;
pub mod hf_download;
pub mod merge;
pub mod meta;
pub mod model_library;
pub mod paths;
pub mod validate;

pub use commands::*;
pub use discovery::*;
pub use export::*;
pub use hf_download::*;
pub use merge::*;
pub use meta::*;
pub use model_library::*;
pub use paths::*;
pub use validate::*;

use crate::types::ModelPathEntry;

mod merge_tests {
    use super::*;
    use crate::templates::{ProviderDefaultParam, ProviderTemplate};

    fn make_user_param(key: &str, values: &[&str], default: &str, order: i32) -> crate::types::UserEditedTemplateParam {
        crate::types::UserEditedTemplateParam {
            key: key.to_string(),
            label: format!("Label {}", key),
            values: values.iter().map(|v| serde_json::Value::String(v.to_string())).collect(),
            order,
            hidden: true,
            user_hidden: false,
            hidden_values: vec![serde_json::Value::String("hidden_val".to_string())],
            essentials_hidden_values: Vec::new(),
            flag: Some(format!("--{}", key)),
            flag_pair: Vec::new(),
            ptype: "arg_select".to_string(),
            step: None,
            ui_group: "CORE".to_string(),
            note: String::new(),
            pattern: String::new(),
            default_value: serde_json::Value::String(default.to_string()),
            user_added_values: vec![serde_json::Value::String("user_custom".to_string())],
            factory_default: serde_json::Value::String(default.to_string()),
            sub_params: None,
            dock: String::new(),
            essential: None,
        }
    }

    fn make_template(params: Vec<ProviderDefaultParam>) -> ProviderTemplate {
        ProviderTemplate {
            binary_name: "llama-server.exe".to_string(),
            description: "test".to_string(),
            spawn_profile: Default::default(),
            params,
        }
    }

    #[test]
    fn merge_preserves_user_values_catalog() {
        let template = make_template(vec![ProviderDefaultParam {
            key: "ctx".to_string(),
            label: "CTX".to_string(),
            flag: Some("--ctx-size".to_string()),
            flag_pair: Vec::new(),
            ptype: "arg_select".to_string(),
            values: vec![
                serde_json::Value::String("8192".to_string()),
                serde_json::Value::String("32768".to_string()),
            ],
            step: None,
            default: serde_json::Value::String("32768".to_string()),
            ui_group: "CORE".to_string(),
            note: String::new(),
            pattern: String::new(),
            sub_params: None,
            dock: String::new(),
            hidden_default: false,
            essentials_hidden_values: Vec::new(),
        }]);

        let user = vec![make_user_param("ctx", &["8192", "user_custom"], "8192", 0)];
        let merged = merge_user_params_with_template(&template, &user, &[]);
        let ctx = merged.iter().find(|p| p.key == "ctx").unwrap();

        assert!(!ctx.values.iter().any(|v| v.as_str() == Some("32768")));
        assert!(ctx.values.iter().any(|v| v.as_str() == Some("user_custom")));
        assert!(ctx.hidden);
        assert_eq!(ctx.user_added_values.len(), 1);
    }

    #[test]
    fn merge_does_not_reappend_deleted_factory_values() {
        let template = make_template(vec![ProviderDefaultParam {
            key: "kv_quant".to_string(),
            label: "KV".to_string(),
            flag: Some("--cache-type-k".to_string()),
            flag_pair: Vec::new(),
            ptype: "arg_select".to_string(),
            values: vec![
                serde_json::Value::String("q4_0".to_string()),
                serde_json::Value::String("q8_0".to_string()),
            ],
            step: None,
            default: serde_json::Value::String("q4_0".to_string()),
            ui_group: "CORE".to_string(),
            note: String::new(),
            pattern: String::new(),
            sub_params: None,
            dock: String::new(),
            hidden_default: false,
            essentials_hidden_values: Vec::new(),
        }]);

        let user = make_user_param("kv_quant", &["q4_0"], "q4_0", 0);
        let merged = merge_user_params_with_template(&template, &[user], &[]);
        let kv = merged.iter().find(|p| p.key == "kv_quant").unwrap();

        assert!(!kv.values.iter().any(|v| v.as_str() == Some("q8_0")));
    }

    #[test]
    fn merge_resets_orphan_default() {
        let template = make_template(vec![ProviderDefaultParam {
            key: "kv_quant".to_string(),
            label: "KV".to_string(),
            flag: Some("--cache-type-k".to_string()),
            flag_pair: Vec::new(),
            ptype: "arg_select".to_string(),
            values: vec![serde_json::Value::String("q4_0".to_string())],
            step: None,
            default: serde_json::Value::String("q4_0".to_string()),
            ui_group: "CORE".to_string(),
            note: String::new(),
            pattern: String::new(),
            sub_params: None,
            dock: String::new(),
            hidden_default: false,
            essentials_hidden_values: Vec::new(),
        }]);

        let mut user = make_user_param("kv_quant", &["q4_0"], "stale_removed", 0);
        user.default_value = serde_json::Value::String("stale_removed".to_string());
        let merged = merge_user_params_with_template(&template, &[user], &[]);
        let kv = merged.iter().find(|p| p.key == "kv_quant").unwrap();

        assert_eq!(kv.default_value.as_str(), Some("q4_0"));
    }

    #[test]
    fn merge_keeps_orphaned_user_param() {
        let template = make_template(vec![]);
        let user = vec![make_user_param("orphan_key", &["on"], "on", 0)];
        let merged = merge_user_params_with_template(&template, &user, &[]);

        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].key, "orphan_key");
    }

    #[test]
    fn merge_appends_new_template_param() {
        let template = make_template(vec![ProviderDefaultParam {
            key: "new_param".to_string(),
            label: "New".to_string(),
            flag: Some("--new".to_string()),
            flag_pair: Vec::new(),
            ptype: "arg_select".to_string(),
            values: vec![serde_json::Value::String("1".to_string())],
            step: None,
            default: serde_json::Value::String("1".to_string()),
            ui_group: "CORE".to_string(),
            note: String::new(),
            pattern: String::new(),
            sub_params: None,
            dock: String::new(),
            hidden_default: false,
            essentials_hidden_values: Vec::new(),
        }]);

        let user = vec![make_user_param("existing", &["a"], "a", 0)];
        let merged = merge_user_params_with_template(&template, &user, &[]);

        assert_eq!(merged.len(), 2);
        assert!(merged.iter().any(|p| p.key == "new_param"));
        assert!(merged.iter().any(|p| p.key == "existing"));
    }

    #[test]
    fn merge_sub_params_per_key() {
        let template = make_template(vec![ProviderDefaultParam {
            key: "feat".to_string(),
            label: "Feat".to_string(),
            flag: Some("--feat".to_string()),
            flag_pair: Vec::new(),
            ptype: "arg_select".to_string(),
            values: vec![serde_json::Value::String("ON".to_string())],
            step: None,
            default: serde_json::Value::String("ON".to_string()),
            ui_group: "CORE".to_string(),
            note: String::new(),
            pattern: String::new(),
            sub_params: Some(serde_json::json!({
                "ON": ["--extra-on"],
                "NEW": ["--extra-new"]
            })),
            dock: String::new(),
            hidden_default: false,
            essentials_hidden_values: Vec::new(),
        }]);

        let mut user = make_user_param("feat", &["ON"], "ON", 0);
        let mut user_sp = std::collections::HashMap::new();
        user_sp.insert("ON".to_string(), vec!["--user-on".to_string()]);
        user.sub_params = Some(user_sp);

        let merged = merge_user_params_with_template(&template, &[user], &[]);
        let feat = merged.iter().find(|p| p.key == "feat").unwrap();
        let sp = feat.sub_params.as_ref().unwrap();

        assert_eq!(sp.get("ON").map(|v| v.as_slice()), Some(&["--user-on".to_string()][..]));
        assert_eq!(sp.get("NEW").map(|v| v.as_slice()), Some(&["--extra-new".to_string()][..]));
    }

    #[test]
    fn validate_rejects_orphan_default() {
        let bad = make_user_param("ctx", &["8192"], "missing", 0);
        let errors = validate_provider_params("test", &[bad]);
        assert!(!errors.is_empty());
        assert!(errors.iter().any(|e| e.contains("defaultValue")));
    }

    #[test]
    fn dedupe_keeps_lowest_order_per_key() {
        let mut a = make_user_param("logit_bias", &["a"], "a", 5);
        a.label = "first".to_string();
        let mut b = make_user_param("logit_bias", &["b"], "b", 2);
        b.label = "second".to_string();
        let out = dedupe_user_params_by_key(vec![a, b]);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].label, "second");
    }

    #[test]
    fn strip_windows_extended_prefix_removes_verbatim_marker() {
        assert_eq!(
            super::strip_windows_extended_prefix(r"\\?\C:\AI-MASTER\models"),
            r"C:\AI-MASTER\models"
        );
        assert_eq!(
            super::strip_windows_extended_prefix(r"\\?\UNC\server\share\models"),
            r"\\server\share\models"
        );
        assert_eq!(
            super::strip_windows_extended_prefix(r"C:\already\normal"),
            r"C:\already\normal"
        );
    }

    #[test]
    fn factory_placeholder_models_path_is_ignored_for_setup() {
        let fresh = AppConfig::default();
        assert!(!super::model_library_configured(&fresh));

        let base = std::env::temp_dir().join(format!("bwops-setup-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).expect("library root");
        std::fs::write(base.join("empty-library"), b"").expect("marker");

        let empty_library = AppConfig {
            model_paths: vec![ModelPathEntry {
                path: base.to_string_lossy().to_string(),
                label: "Empty".to_string(),
                is_default: true,
            }],
            hf_token: String::new(),
            providers: Vec::new(),
            setup_completed: false,
            default_download_path: Some(base.to_string_lossy().to_string()),
        };
        assert!(!super::model_library_configured(&empty_library));

        std::fs::write(base.join("demo.Q4_K_M.gguf"), b"gguf").expect("gguf");
        let with_models = AppConfig {
            model_paths: vec![ModelPathEntry {
                path: base.to_string_lossy().to_string(),
                label: "My Models".to_string(),
                is_default: true,
            }],
            hf_token: String::new(),
            providers: Vec::new(),
            setup_completed: false,
            default_download_path: Some(base.to_string_lossy().to_string()),
        };
        assert!(super::model_library_configured(&with_models));

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn catalog_source_path_label_uses_parent_and_leaf() {
        assert_eq!(
            super::format_catalog_source_path_label(r"C:\Users\alice\.lmstudio\models"),
            ".lmstudio/models"
        );
        assert_eq!(
            super::format_catalog_source_path_label(r"D:\AI-MASTER\models"),
            "AI-MASTER/models"
        );
        assert_eq!(
            super::format_catalog_source_path_label(r"D:\models"),
            "D/models"
        );
    }

    #[test]
    fn model_path_dedupe_collapses_case_and_trailing_slash() {
        let mut paths = vec![
            ModelPathEntry {
                path: "D:\\AI-MASTER\\models".to_string(),
                label: "models".to_string(),
                is_default: false,
            },
            ModelPathEntry {
                path: "d:\\AI-MASTER\\models\\".to_string(),
                label: "models-dup".to_string(),
                is_default: true,
            },
        ];
        assert!(super::dedupe_model_paths(&mut paths));
        assert_eq!(paths.len(), 1);
        assert!(paths[0].is_default);
    }

    #[test]
    fn set_default_model_path_accepts_resolved_absolute_for_relative_models_entry() {
        let models_dir = default_models_dir();
        std::fs::create_dir_all(&models_dir).expect("models dir");

        let mut config = AppConfig {
            model_paths: vec![
                ModelPathEntry {
                    path: DEFAULT_MODEL_PATH_REL.to_string(),
                    label: DEFAULT_MODEL_PATH_LABEL.to_string(),
                    is_default: false,
                },
                ModelPathEntry {
                    path: "C:\\other\\models".to_string(),
                    label: "Other".to_string(),
                    is_default: true,
                },
            ],
            hf_token: String::new(),
            providers: Vec::new(),
            setup_completed: false,
            default_download_path: Some("C:\\other\\models".to_string()),
        };

        let resolved_models = resolve_stored_model_path(DEFAULT_MODEL_PATH_REL);
        set_default_model_path(&mut config, &resolved_models).expect("switch to bundled models");
        sanitize_model_paths(&mut config);

        let models_entry = config
            .model_paths
            .iter()
            .find(|p| model_path_key(&p.path) == model_path_key(DEFAULT_MODEL_PATH_REL))
            .expect("models entry");
        assert!(models_entry.is_default);
        assert_eq!(
            config.default_download_path.as_deref(),
            Some(DEFAULT_MODEL_PATH_REL)
        );
    }

    #[test]
    fn sanitize_keeps_single_default_and_syncs_memo() {
        let mut config = AppConfig {
            model_paths: vec![
                ModelPathEntry {
                    path: "C:\\path-a".to_string(),
                    label: "A".to_string(),
                    is_default: true,
                },
                ModelPathEntry {
                    path: "C:\\path-b".to_string(),
                    label: "B".to_string(),
                    is_default: true,
                },
            ],
            hf_token: String::new(),
            providers: Vec::new(),
            setup_completed: false,
            default_download_path: Some("C:\\path-b".to_string()),
        };
        assert!(super::sanitize_model_paths(&mut config));
        assert_eq!(config.model_paths.iter().filter(|p| p.is_default).count(), 1);
        // Explicit is_default wins over stale memo when both were flagged
        assert_eq!(config.default_download_path.as_deref(), Some("C:\\path-a"));
        assert!(config.model_paths.iter().find(|p| p.path == "C:\\path-a").unwrap().is_default);
    }

    #[test]
    fn sanitize_recovers_default_from_memo_when_unflagged() {
        let mut config = AppConfig {
            model_paths: vec![
                ModelPathEntry {
                    path: "C:\\path-a".to_string(),
                    label: "A".to_string(),
                    is_default: false,
                },
                ModelPathEntry {
                    path: "C:\\path-b".to_string(),
                    label: "B".to_string(),
                    is_default: false,
                },
            ],
            hf_token: String::new(),
            providers: Vec::new(),
            setup_completed: false,
            default_download_path: Some("C:\\path-b".to_string()),
        };
        assert!(super::sanitize_model_paths(&mut config));
        assert_eq!(config.model_paths.iter().filter(|p| p.is_default).count(), 1);
        assert_eq!(config.default_download_path.as_deref(), Some("C:\\path-b"));
        assert!(config.model_paths.iter().find(|p| p.path == "C:\\path-b").unwrap().is_default);
    }

    #[test]
    fn validate_download_dest_allows_nested_subfolders_under_existing_models_root() {
        let base = std::env::temp_dir().join(format!("bwops-dl-{}", std::process::id()));
        let models = base.join("models");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&models).expect("models root");

        let dest = models
            .join("JackRong")
            .join("Some-Model")
            .join("model-Q4_K_M.gguf");
        let config = AppConfig {
            model_paths: vec![ModelPathEntry {
                path: models.to_string_lossy().to_string(),
                label: "Models".to_string(),
                is_default: true,
            }],
            hf_token: String::new(),
            providers: Vec::new(),
            setup_completed: false,
            default_download_path: Some(models.to_string_lossy().to_string()),
        };

        super::validate_download_dest(&dest.to_string_lossy(), &config)
            .expect("nested dest under existing models root should validate");

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn validate_download_dest_allows_forward_slash_dest_under_relative_models_root() {
        let base = std::env::temp_dir().join(format!("bwops-dl-mix-{}", std::process::id()));
        let models = base.join("models");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&models).expect("models root");

        // Simulate Model Hub: absolute default path + forward-slash segments
        let default_path = models.to_string_lossy();
        let dest = format!(
            "{}/JackRong/Some-Model/model-Q4_K_M.gguf",
            default_path.replace('\\', "/")
        );
        let config = AppConfig {
            model_paths: vec![ModelPathEntry {
                path: models.to_string_lossy().to_string(),
                label: "Models".to_string(),
                is_default: true,
            }],
            hf_token: String::new(),
            providers: Vec::new(),
            setup_completed: false,
            default_download_path: Some(models.to_string_lossy().to_string()),
        };

        super::validate_download_dest(&dest, &config)
            .expect("forward-slash dest under models root should validate");

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn expand_path_placeholders_resolves_userprofile_segment() {
        std::env::set_var("BLACKOPS_TEST_HOME", r"C:\Users\ghost");
        let input = r"%BLACKOPS_TEST_HOME%\.lmstudio\models";
        let expanded = super::expand_path_placeholders(input);
        assert_eq!(expanded, r"C:\Users\ghost\.lmstudio\models");
        std::env::remove_var("BLACKOPS_TEST_HOME");
    }

    #[test]
    fn validate_hf_model_id_rejects_traversal_and_bad_format() {
        assert!(super::validate_hf_model_id("bartowski/Llama-3.1-8B-GGUF").is_ok());
        assert!(super::validate_hf_model_id("../evil/repo").is_err());
        assert!(super::validate_hf_model_id("author-only").is_err());
        assert!(super::validate_hf_model_id("bad\\segment/repo").is_err());
    }

    #[test]
    fn validate_download_file_name_rejects_path_segments() {
        assert!(super::validate_download_file_name("model-Q4_K_M.gguf").is_ok());
        assert!(super::validate_download_file_name("../escape.gguf").is_err());
        assert!(super::validate_download_file_name("sub/model.gguf").is_err());
        assert!(super::validate_download_file_name("readme.txt").is_err());
    }

    #[test]
    fn validate_download_url_matches_model_requires_hf_resolve_path() {
        let url = "https://huggingface.co/bartowski/Llama-3.1-8B-GGUF/resolve/main/model-Q4_K_M.gguf";
        assert!(super::validate_download_url_matches_model(
            url,
            "bartowski/Llama-3.1-8B-GGUF",
            "model-Q4_K_M.gguf"
        )
        .is_ok());
        assert!(super::validate_download_url_matches_model(
            url,
            "other/Repo",
            "model-Q4_K_M.gguf"
        )
        .is_err());
    }

    #[test]
    fn build_quant_dest_path_preserves_repo_subfolders() {
        let dest = super::build_quant_dest_path(
            r"C:\models",
            "bartowski/Llama-GGUF",
            "Q4_K_M/model-00001-of-00004.gguf",
        )
        .expect("valid dest");
        assert!(dest.replace('\\', "/").ends_with("Q4_K_M/model-00001-of-00004.gguf"));
    }

    #[test]
    fn normalize_hf_search_inputs_caps_limit_and_validates_sort() {
        let filters = super::normalize_hf_search_inputs(
            "llama".to_string(),
            Some(24),
            Some("likes".to_string()),
            Some(500),
        )
        .expect("valid search");
        assert_eq!(filters.limit, 100);
        assert_eq!(filters.sort, "likes");
        assert_eq!(filters.vram_limit_gb, 24);

        assert!(super::normalize_hf_search_inputs(
            "".to_string(),
            None,
            None,
            None
        )
        .is_err());
        assert!(super::normalize_hf_search_inputs(
            "llama".to_string(),
            None,
            Some("bogus".to_string()),
            None
        )
        .is_err());
    }

    fn make_grouped_param(key: &str, ui_group: &str, order: i32) -> crate::types::UserEditedTemplateParam {
        let mut p = make_user_param(key, &["a"], "a", order);
        p.ui_group = ui_group.to_string();
        p
    }

    #[test]
    fn factory_provider_rank_puts_master_first() {
        assert!(factory_provider_rank(DEFAULT_PROVIDER_ID) < factory_provider_rank("ggml-tom"));
    }

    #[test]
    fn finalize_factory_group_order_pins_system_last() {
        let order = finalize_factory_group_order(
            vec![
                "SYSTEM".into(),
                "PERFORMANCE".into(),
                "FEATURE-FLAGS".into(),
            ],
            &["SYSTEM".into()],
        );
        assert_eq!(order, vec!["PERFORMANCE", "FEATURE-FLAGS", "SYSTEM"]);
    }

    #[test]
    fn sort_params_for_factory_export_orders_by_group_then_order() {
        let group_order = vec![
            "ABOVE-CONFIG-LEFT".into(),
            "PERFORMANCE".into(),
            "SYSTEM".into(),
        ];
        let mut params = vec![
            make_grouped_param("base_port", "SYSTEM", 0),
            make_grouped_param("batch", "PERFORMANCE", 2),
            make_grouped_param("ctx", "ABOVE-CONFIG-LEFT", 1),
            make_grouped_param("split", "SYSTEM", 1),
        ];
        sort_params_for_factory_export(&mut params, &group_order);
        assert_eq!(
            params.iter().map(|p| p.key.as_str()).collect::<Vec<_>>(),
            vec!["ctx", "batch", "base_port", "split"]
        );
    }
}
