//! Profile-scoped Customizations: centralized Skills, MCP servers, and
//! Agent personas syndication across Termic tasks and worktrees.
//!
//! Provides:
//! - Profile customizations layout: `<profile_dir>/customizations/{mcp,skills,agents}/`
//! - Automatic seeding and version tracking of the built-in `termic` orchestration skill
//! - Semantic Model Tier resolution (`Fast`, `Balanced`, `Reasoning`, `Inherit`)
//! - Ancestor-checked, non-clobbering worktree syndication (`reconcile_customizations`)
//! - Safe Config Sync export and import without secret leakage
//! - Machine-local MCP environment variable injection (`mcp.env.local`)

use std::collections::{BTreeSet, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use serde::{Deserialize, Serialize};

/// Mode controlling how a project interacts with profile customizations.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum CustomizationMode {
    /// Follow the current profile's default.
    #[default]
    Default,
    /// Use profile customizations as defaults whenever the project repository lacks them.
    Inherit,
    /// Strictly use files committed in the project repository; suppress profile customizations.
    Override,
    /// Completely isolated; do not link any profile customizations.
    None,
}

impl CustomizationMode {
    pub fn resolve(self, profile_enabled: bool) -> Self {
        match self {
            Self::Default if profile_enabled => Self::Inherit,
            Self::Default => Self::Override,
            explicit => explicit,
        }
    }
}

/// Abstract model capability tier for subagent personas.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum ModelTier {
    /// Inherit the parent agent's active model.
    #[default]
    Inherit,
    /// Fast, low-latency, economical model (e.g. Haiku, GPT-4o-mini, Flash-Lite).
    Fast,
    /// Balanced standard model for general coding (e.g. Sonnet, GPT-5-Codex, Flash).
    Balanced,
    /// High-reasoning deep thinking model (e.g. Opus, o3-mini/o1 xhigh, Pro thinking).
    Reasoning,
}

impl ModelTier {
    pub fn from_str_loose(s: &str) -> Self {
        match s.trim().to_lowercase().as_str() {
            "fast" | "a" | "tier-a" | "tier_a" => ModelTier::Fast,
            "balanced" | "b" | "tier-b" | "tier_b" => ModelTier::Balanced,
            "reasoning" | "c" | "tier-c" | "tier_c" | "deep" | "opus" => ModelTier::Reasoning,
            _ => ModelTier::Inherit,
        }
    }
}

/// Resolves an abstract model tier to provider-specific CLI flags and arguments.
pub fn resolve_model_tier(tier: ModelTier, agent_id: &str) -> (Option<&'static str>, Vec<String>) {
    let base_agent = agent_id.split('-').next().unwrap_or(agent_id);
    match base_agent {
        "claude" => match tier {
            ModelTier::Fast => (Some("haiku"), vec![]),
            ModelTier::Balanced => (Some("sonnet"), vec![]),
            ModelTier::Reasoning => (Some("opus"), vec![]),
            ModelTier::Inherit => (None, vec![]),
        },
        "codex" => match tier {
            ModelTier::Fast => (Some("gpt-4o-mini"), vec![]),
            ModelTier::Balanced => (Some("gpt-5-codex"), vec![]),
            ModelTier::Reasoning => (
                Some("o3-mini"),
                vec!["-c".into(), "model_reasoning_effort=\"xhigh\"".into()],
            ),
            ModelTier::Inherit => (None, vec![]),
        },
        "agy" => match tier {
            ModelTier::Fast => (Some("flash_lite"), vec![]),
            ModelTier::Balanced => (Some("flash"), vec![]),
            ModelTier::Reasoning => (Some("pro"), vec![]),
            ModelTier::Inherit => (None, vec![]),
        },
        _ => (None, vec![]),
    }
}

/// Extracts the declared ModelTier from a markdown persona's frontmatter.
pub fn parse_persona_model_tier(content: &str) -> ModelTier {
    if let Some(rest) = content.strip_prefix("---") {
        if let Some((frontmatter, _)) = rest.split_once("---") {
            for line in frontmatter.lines() {
                let trimmed = line.trim();
                if let Some((k, v)) = trimmed.split_once(':') {
                    let key = k.trim().to_lowercase();
                    if key == "model_tier" || key == "tier" || key == "model" {
                        return ModelTier::from_str_loose(v);
                    }
                }
            }
        }
    }
    ModelTier::Inherit
}

/// Extracts the declared description from a markdown persona's frontmatter.
pub fn parse_persona_description(content: &str) -> Option<String> {
    if let Some(rest) = content.strip_prefix("---") {
        if let Some((frontmatter, _)) = rest.split_once("---") {
            for line in frontmatter.lines() {
                let trimmed = line.trim();
                if let Some((k, v)) = trimmed.split_once(':') {
                    if k.trim().to_ascii_lowercase() == "description" {
                        let desc = v.trim().trim_matches('"').trim_matches('\'').trim();
                        if !desc.is_empty() {
                            return Some(desc.to_string());
                        }
                    }
                }
            }
        }
    }
    None
}

/// Converts a generic Markdown persona into a Claude Markdown agent definition with ModelTier mapping.
pub fn render_claude_agent_md(name: &str, content: &str) -> String {
    render_markdown_agent(name, content, "claude")
}

/// Antigravity discovers workspace personas in `.agents/agents`, not
/// `.agents/subagents`. Its persona model field accepts flash/pro tiers.
pub fn render_antigravity_agent_md(name: &str, content: &str) -> String {
    render_markdown_agent(name, content, "agy")
}

fn render_markdown_agent(name: &str, content: &str, provider: &str) -> String {
    let tier = parse_persona_model_tier(content);
    let (mut model, _) = resolve_model_tier(tier, provider);
    if provider == "agy" && tier == ModelTier::Fast {
        model = Some("flash");
    }
    let desc = parse_persona_description(content).unwrap_or_else(|| format!("{name} persona"));

    let (frontmatter_lines, body) = if let Some(rest) = content.strip_prefix("---") {
        if let Some((fm, b)) = rest.split_once("---") {
            let lines: Vec<&str> = fm
                .lines()
                .filter(|l| {
                    let trimmed = l.trim().to_lowercase();
                    !trimmed.starts_with("model_tier:")
                        && !trimmed.starts_with("tier:")
                        && !trimmed.starts_with("name:")
                        && !trimmed.starts_with("description:")
                        && !trimmed.starts_with("model:")
                })
                .collect();
            (lines, b.trim())
        } else {
            (vec![], content.trim())
        }
    } else {
        (vec![], content.trim())
    };

    let mut out = String::from("---\n");
    out.push_str(&format!("name: {name}\n"));
    out.push_str(&format!("description: {desc}\n"));
    if let Some(m) = model {
        out.push_str(&format!("model: {m}\n"));
    }
    for l in frontmatter_lines {
        out.push_str(l);
        out.push('\n');
    }
    out.push_str("---\n\n");
    out.push_str(body);
    out.push('\n');
    out
}
pub fn render_codex_agent_toml(name: &str, content: &str) -> String {
    let tier = parse_persona_model_tier(content);
    let (model, args) = resolve_model_tier(tier, "codex");
    let mut toml = format!("name = \"{name}\"\n");
    let desc = parse_persona_description(content).unwrap_or_else(|| format!("{name} persona"));
    let escaped_desc = desc.replace('\\', "\\\\").replace('"', "\\\"").replace('\n', " ");
    toml.push_str(&format!("description = \"{escaped_desc}\"\n"));
    if let Some(m) = model {
        toml.push_str(&format!("model = \"{m}\"\n"));
    }
    for arg in args {
        if let Some(rest) = arg.strip_prefix("model_reasoning_effort=") {
            toml.push_str(&format!("model_reasoning_effort = {rest}\n"));
        }
    }
    let body = if let Some(rest) = content.strip_prefix("---") {
        rest.split_once("---").map(|(_, b)| b.trim()).unwrap_or(content.trim())
    } else {
        content.trim()
    };
    let escaped_body = body.replace('\\', "\\\\").replace('"', "\\\"").replace('\n', "\\n");
    toml.push_str(&format!("developer_instructions = \"{escaped_body}\"\n"));
    toml
}

/// Directory holding all customizations for a profile.
pub fn customizations_dir(profile_dir: &Path) -> PathBuf {
    profile_dir.join("customizations")
}

pub fn skills_dir(profile_dir: &Path) -> PathBuf {
    customizations_dir(profile_dir).join("skills")
}

pub fn agents_dir(profile_dir: &Path) -> PathBuf {
    customizations_dir(profile_dir).join("agents")
}

pub fn mcp_dir(profile_dir: &Path) -> PathBuf {
    customizations_dir(profile_dir).join("mcp")
}

pub fn mcp_env_file(profile_dir: &Path) -> PathBuf {
    mcp_dir(profile_dir).join("mcp.env.local")
}

pub fn mcp_json_file(profile_dir: &Path) -> PathBuf {
    mcp_dir(profile_dir).join("mcp.json")
}

/// Canonical bundled `termic` orchestration skill text.
const BUILTIN_TERMIC_SKILL: &str = include_str!("../assets/skills/termic/SKILL.md");
const BUILTIN_TERMIC_REFERENCES: &[(&str, &str)] = &[
    ("customizations.md", include_str!("../assets/skills/termic/references/customizations.md")),
    ("control-surface.md", include_str!("../assets/skills/termic/references/control-surface.md")),
    ("compatibility.md", include_str!("../assets/skills/termic/references/compatibility.md")),
];

/// Seeds the built-in `termic` orchestration skill into the profile's skills directory.
///
/// Uses `.termic-version` for the entrypoint and per-reference version markers
/// to track whether each file has been modified by the user.
/// If unmodified or missing, updates to the bundled version. If the user edited it,
/// preserves their changes across updates.
pub fn ensure_builtin_skills(profile_dir: &Path) -> std::io::Result<()> {
    let termic_skill_dir = skills_dir(profile_dir).join("termic");
    fs::create_dir_all(&termic_skill_dir)?;
    fs::create_dir_all(agents_dir(profile_dir))?;
    fs::create_dir_all(mcp_dir(profile_dir))?;

    seed_builtin_file(
        &termic_skill_dir.join("SKILL.md"),
        &termic_skill_dir.join(".termic-version"),
        BUILTIN_TERMIC_SKILL,
    )?;
    let references = termic_skill_dir.join("references");
    fs::create_dir_all(&references)?;
    for (name, content) in BUILTIN_TERMIC_REFERENCES {
        seed_builtin_file(
            &references.join(name),
            &references.join(format!(".{name}.termic-version")),
            content,
        )?;
    }
    Ok(())
}

fn seed_builtin_file(skill_path: &Path, version_path: &Path, bundled: &str) -> std::io::Result<()> {
    let bundled_hash = sha256_hex(bundled.as_bytes());

    if skill_path.exists() {
        if let Ok(existing) = fs::read_to_string(&skill_path) {
            let existing_hash = sha256_hex(existing.as_bytes());
            if let Ok(stored_hash) = fs::read_to_string(&version_path) {
                let stored_trimmed = stored_hash.trim();
                if !stored_trimmed.is_empty() && existing_hash != stored_trimmed && existing_hash != bundled_hash {
                    return Ok(());
                }
            } else {
                // No .termic-version exists: user placed this file independently. Preserve it!
                if existing_hash != bundled_hash {
                    return Ok(());
                }
            }
        }
    }

    fs::write(skill_path, bundled.as_bytes())?;
    fs::write(version_path, bundled_hash.as_bytes())?;
    Ok(())
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

/// Identifies any destination environment variables in `mcp.json` that are mapped to conflicting source expressions across different servers.
pub fn find_conflicting_dest_keys(mcp_json_path: &Path) -> HashSet<String> {
    let mut declared_sources: HashMap<String, HashSet<String>> = HashMap::new();
    if let Ok(bytes) = fs::read(mcp_json_path) {
        if let Ok(doc) = serde_json::from_slice::<serde_json::Value>(&bytes) {
            if let Some(servers) = doc.get("mcpServers").and_then(|v| v.as_object()) {
                for (_name, server) in servers {
                    if let Some(s_env) = server.get("env").and_then(|v| v.as_object()) {
                        for (dest_key, src_val) in s_env {
                            if let Some(src_str) = src_val.as_str() {
                                let trimmed = src_str.trim();
                                if trimmed.starts_with("${") && trimmed.ends_with('}') {
                                    declared_sources
                                        .entry(dest_key.clone())
                                        .or_default()
                                        .insert(trimmed.to_string());
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    declared_sources
        .into_iter()
        .filter(|(_k, sources)| sources.len() > 1)
        .map(|(k, _)| k)
        .collect()
}

/// Read local secrets from `<profile_dir>/customizations/mcp/mcp.env.local`.
pub fn read_mcp_env(profile_dir: &Path) -> HashMap<String, String> {
    let mut env = HashMap::new();
    let path = mcp_env_file(profile_dir);
    if let Ok(content) = fs::read_to_string(&path) {
        for line in content.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() || trimmed.starts_with('#') {
                continue;
            }
            if let Some((k, v)) = trimmed.split_once('=') {
                let key = k.trim().to_string();
                let mut val = v.trim().to_string();
                if (val.starts_with('"') && val.ends_with('"')) || (val.starts_with('\'') && val.ends_with('\'')) {
                    if val.len() >= 2 {
                        val = val[1..val.len() - 1].to_string();
                    }
                }
                if !key.is_empty() {
                    env.insert(key, val);
                }
            }
        }
    }

    // Resolve non-conflicting renamed bindings defined in mcp.json
    let mcp_path = mcp_json_file(profile_dir);
    let conflicts = find_conflicting_dest_keys(&mcp_path);

    // Fail closed: Remove any conflicting destination key from the emitted environment,
    // even if it was present in mcp.env.local, to prevent accidental cross-server disclosure.
    for k in &conflicts {
        env.remove(k);
    }

    if let Ok(bytes) = fs::read(&mcp_path) {
        if let Ok(doc) = serde_json::from_slice::<serde_json::Value>(&bytes) {
            if let Some(servers) = doc.get("mcpServers").and_then(|v| v.as_object()) {
                for (_name, server) in servers {
                    if let Some(s_env) = server.get("env").and_then(|v| v.as_object()) {
                        for (dest_key, src_val) in s_env {
                            if conflicts.contains(dest_key) {
                                continue;
                            }
                            if let Some(src_str) = src_val.as_str() {
                                let trimmed = src_str.trim();
                                if trimmed.starts_with("${") && trimmed.ends_with('}') {
                                    let src_key = trimmed[2..trimmed.len() - 1].trim();
                                    if let Some(val) = env.get(src_key).cloned() {
                                        env.insert(dest_key.clone(), val);
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    env
}

/// Manifest tracking Termic-owned symlinks and generated files inside a task worktree.
#[derive(Debug, Serialize, Deserialize, Default)]
struct CustomizationManifest {
    #[serde(default)]
    owned_links: Vec<String>,
    #[serde(default)]
    owned_files: HashMap<String, String>,
    #[serde(default)]
    owned_mcp_servers: HashMap<String, String>,
}

const MANIFEST_REL: &str = ".termic/customization-manifest.json";

fn validate_manifest_rel(rel: &str) -> bool {
    let p = Path::new(rel);
    if !p.is_relative() {
        return false;
    }
    for comp in p.components() {
        match comp {
            std::path::Component::Normal(_) => {},
            _ => return false,
        }
    }
    rel.starts_with(".agents/skills/")
        || rel.starts_with(".agents/subagents/")
        || rel.starts_with(".claude/skills/")
        || rel.starts_with(".claude/agents/")
        || rel == ".mcp.json"
}

/// Reconciles profile customizations into a task worktree.
///
/// Principles (Codex Review Compliant):
/// 1. Never traverses an existing unowned symlink (preventing main-checkout mutation).
/// 2. Syndicates into `.agents/skills/` (universal cross-agent standard).
/// 3. Records created links and generated files in `.termic/customization-manifest.json` (ancestor & leaf guarded).
/// 4. When mode is `Override` or `None`, cleans up Termic-owned links and generated adapter files.
/// 5. Excludes individual syndicated links and generated files in `.git/info/exclude`.
pub fn reconcile_customizations(
    profile_dir: &Path,
    wt: &Path,
    mode: CustomizationMode,
    _agent_id: &str,
) -> std::io::Result<()> {
    let mode = mode.resolve(true);
    let manifest_path = wt.join(MANIFEST_REL);
    let manifest_safe = is_path_and_ancestors_safe(wt, &manifest_path);
    let mut manifest: CustomizationManifest = if manifest_safe && manifest_path.is_file() {
        fs::read_to_string(&manifest_path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    } else {
        CustomizationManifest::default()
    };
    manifest.owned_links.retain(|r| validate_manifest_rel(r));

    // If mode is None or Override: clean up any Termic-owned links and generated files, then return.
    if mode == CustomizationMode::None || mode == CustomizationMode::Override {
        cleanup_manifest_links(wt, profile_dir, &manifest.owned_links);
        cleanup_manifest_files(wt, &manifest.owned_files);
        cleanup_codex_mcp(wt, &manifest.owned_mcp_servers);
        if manifest_safe && manifest_path.is_file() {
            let _ = fs::remove_file(&manifest_path);
        }
        return Ok(());
    }

    let mut new_owned = Vec::new();
    let mut new_owned_files = HashMap::new();

    // 1. Ensure .git/info/exclude ignores Termic's links so git status stays clean.
    ensure_task_git_excluded(wt, ".mcp.json");
    ensure_task_git_excluded(wt, ".termic/customization-manifest.json");

    // 2. Syndicate skills into `<wt>/.agents/skills/<name>`
    let prof_skills = skills_dir(profile_dir);
    if prof_skills.is_dir() {
        let wt_agents_skills = wt.join(".agents").join("skills");
        if create_owned_dir_hierarchy(wt, &wt_agents_skills).is_ok() {
            if let Ok(entries) = fs::read_dir(&prof_skills) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if !path.is_dir() {
                        continue;
                    }
                    let name = entry.file_name();
                    let target = path;
                    let link = wt_agents_skills.join(&name);
                    let rel_link = format!(".agents/skills/{}", name.to_string_lossy());

                    if ensure_link(wt, &target, &link) {
                        ensure_task_git_excluded(wt, &rel_link);
                        new_owned.push(rel_link);
                    }
                }
            }
        }
    }

    // 3. Antigravity's native workspace persona location. Generate metadata
    // because portable sources need not declare a native `name` or `model`.
    let prof_agents = agents_dir(profile_dir);
    if prof_agents.is_dir() {
        for entry in fs::read_dir(&prof_agents)? {
            let path = entry?.path();
            if !path.is_file() || path.extension().and_then(|v| v.to_str()) != Some("md") {
                continue;
            }
            let name = path.file_stem().unwrap_or_default().to_string_lossy();
            let rel = format!(".agents/agents/{name}/agent.md");
            let text = render_antigravity_agent_md(&name, &fs::read_to_string(&path)?);
            write_generated_adapter(wt, &rel, &text, &manifest.owned_files, &mut new_owned_files)?;
        }
    }

    // 3.1 Vendor Adapter for Codex: generate .codex/agents/<name>.toml
    if prof_agents.is_dir() {
        let wt_codex_agents = wt.join(".codex").join("agents");
        if create_owned_dir_hierarchy(wt, &wt_codex_agents).is_ok() {
            if let Ok(entries) = fs::read_dir(&prof_agents) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if !path.is_file() {
                        continue;
                    }
                    let stem = path.file_stem().unwrap_or_default().to_string_lossy();
                    let toml_file = wt_codex_agents.join(format!("{stem}.toml"));
                    let rel_file = format!(".codex/agents/{stem}.toml");

                    // Refuse to write through destination symlink
                    if toml_file.symlink_metadata().map(|m| m.file_type().is_symlink()).unwrap_or(false) {
                        continue;
                    }

                    if let Ok(content) = fs::read_to_string(&path) {
                        let toml = render_codex_agent_toml(&stem, &content);
                        let new_hash = sha256_hex(toml.as_bytes());

                        // If file already exists:
                        // Only overwrite if it was tracked by Termic and hasn't been edited by the user
                        if toml_file.exists() {
                            if let Some(prev_hash) = manifest.owned_files.get(&rel_file) {
                                if let Ok(existing_bytes) = fs::read(&toml_file) {
                                    let existing_hash = sha256_hex(&existing_bytes);
                                    if existing_hash != *prev_hash && existing_hash != new_hash {
                                        // User modified it: preserve their edits permanently by relinquishing ownership
                                        continue;
                                    }
                                }
                            } else {
                                // Project-owned file: do not overwrite!
                                continue;
                            }
                        }

                        if is_path_and_ancestors_safe(wt, &toml_file) {
                            if fs::write(&toml_file, toml.as_bytes()).is_ok() {
                                ensure_task_git_excluded(wt, &rel_file);
                                new_owned_files.insert(rel_file, new_hash);
                            }
                        }
                    }
                }
            }
        }
    }

    // 3.2 Vendor Adapter for Claude: syndicate native .claude/skills and .claude/agents
    {
        if prof_skills.is_dir() {
            let wt_claude_skills = wt.join(".claude").join("skills");
            if create_owned_dir_hierarchy(wt, &wt_claude_skills).is_ok() {
                if let Ok(entries) = fs::read_dir(&prof_skills) {
                    for entry in entries.flatten() {
                        let path = entry.path();
                        if !path.is_dir() {
                            continue;
                        }
                        let name = entry.file_name();
                        let target = path;
                        let link = wt_claude_skills.join(&name);
                        let rel_link = format!(".claude/skills/{}", name.to_string_lossy());

                        if ensure_link(wt, &target, &link) {
                            ensure_task_git_excluded(wt, &rel_link);
                            new_owned.push(rel_link);
                        }
                    }
                }
            }
        }
        if prof_agents.is_dir() {
            let wt_claude_agents = wt.join(".claude").join("agents");
            if create_owned_dir_hierarchy(wt, &wt_claude_agents).is_ok() {
                if let Ok(entries) = fs::read_dir(&prof_agents) {
                    for entry in entries.flatten() {
                        let path = entry.path();
                        if !path.is_file() {
                            continue;
                        }
                        let stem = path.file_stem().unwrap_or_default().to_string_lossy();
                        let md_file = wt_claude_agents.join(format!("{stem}.md"));
                        let rel_file = format!(".claude/agents/{stem}.md");

                        if md_file.symlink_metadata().map(|m| m.file_type().is_symlink()).unwrap_or(false) {
                            continue;
                        }

                        if let Ok(content) = fs::read_to_string(&path) {
                            let rendered = render_claude_agent_md(&stem, &content);
                            let new_hash = sha256_hex(rendered.as_bytes());

                            if md_file.exists() {
                                if let Some(prev_hash) = manifest.owned_files.get(&rel_file) {
                                    if let Ok(existing_bytes) = fs::read(&md_file) {
                                        let existing_hash = sha256_hex(&existing_bytes);
                                        if existing_hash != *prev_hash && existing_hash != new_hash {
                                            continue;
                                        }
                                    }
                                } else {
                                    continue;
                                }
                            }

                            if is_path_and_ancestors_safe(wt, &md_file) {
                                if fs::write(&md_file, rendered.as_bytes()).is_ok() {
                                    ensure_task_git_excluded(wt, &rel_file);
                                    new_owned_files.insert(rel_file, new_hash);
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // 4. Syndicate MCP if repo lacks .mcp.json or already points to profile MCP
    let prof_mcp = mcp_json_file(profile_dir);
    let wt_mcp = wt.join(".mcp.json");
    if prof_mcp.is_file() {
        let rel_link = ".mcp.json".to_string();
        if ensure_link(wt, &prof_mcp, &wt_mcp) {
            new_owned.push(rel_link);
        }

        // 4.1 Native MCP adapter for Codex (.codex/config.toml)
        let _ = reconcile_codex_mcp(wt, &prof_mcp, &mut manifest);

        // Antigravity uses its own workspace filename and remote URL key.
        let raw = fs::read(&prof_mcp)?;
        let text = render_antigravity_mcp(&raw)?;
        write_generated_adapter(wt, ".agents/mcp_config.json", &text, &manifest.owned_files, &mut new_owned_files)?;
    } else {
        // Source MCP was removed: clean up previously owned Codex MCP servers
        let _ = cleanup_codex_mcp(wt, &manifest.owned_mcp_servers);
        manifest.owned_mcp_servers.clear();
    }

    // 5. Clean up any previously owned links that are no longer active
    let stale_links: Vec<String> = manifest
        .owned_links
        .into_iter()
        .filter(|old| !new_owned.contains(old))
        .collect();
    cleanup_manifest_links(wt, profile_dir, &stale_links);

    // 6. Clean up any previously generated files that are no longer active
    let stale_files: HashMap<String, String> = manifest
        .owned_files
        .into_iter()
        .filter(|(old, _)| !new_owned_files.contains_key(old))
        .collect();
    cleanup_manifest_files(wt, &stale_files);

    // Save manifest safely without traversing leaf or ancestor symlinks
    if manifest_safe {
        manifest.owned_links = new_owned;
        manifest.owned_files = new_owned_files;
        if let Some(parent) = manifest_path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let _ = fs::write(&manifest_path, serde_json::to_string_pretty(&manifest).unwrap_or_default());
    }

    Ok(())
}

/// Verifies that neither `dest` nor any ancestor component between `base` and `dest` is a symlink.
pub fn is_path_and_ancestors_safe(base: &Path, dest: &Path) -> bool {
    let Ok(rel) = dest.strip_prefix(base) else { return false };
    let mut current = base.to_path_buf();
    for comp in rel.components() {
        match comp {
            std::path::Component::Normal(_) => {},
            _ => return false,
        }
        current.push(comp);
        if let Ok(meta) = current.symlink_metadata() {
            if meta.file_type().is_symlink() {
                return false;
            }
        }
    }
    true
}

/// Verifies that no ancestor segment between `base` and `dest` is an unowned symlink,
/// preventing write-through mutation of project checkouts.
pub fn is_ancestor_safe(base: &Path, dest: &Path) -> bool {
    let Ok(rel) = dest.strip_prefix(base) else { return false };
    let mut current = base.to_path_buf();
    for comp in rel.components() {
        match comp {
            std::path::Component::Normal(_) => {},
            _ => return false,
        }
        current.push(comp);
        if current == dest {
            break;
        }
        if let Ok(meta) = current.symlink_metadata() {
            if meta.file_type().is_symlink() {
                // An ancestor is a symlink! Refuse to write under it.
                return false;
            }
        }
    }
    true
}

/// Creates real directories from `base` to `dir` only if no component or ancestor is a symlink.
fn create_owned_dir_hierarchy(base: &Path, dir: &Path) -> std::io::Result<()> {
    if !is_path_and_ancestors_safe(base, dir) {
        return Err(std::io::Error::other("path or ancestor is a symlink"));
    }
    fs::create_dir_all(dir)
}

/// Ensures `link` points to `target`.
///
/// Idempotent: If `link` already points to `target`, returns true.
/// Non-clobbering: If `link` is a regular file/dir or a user symlink pointing elsewhere, returns false.
/// Ancestor-safe: If any ancestor of `link` is an unowned symlink, returns false.
fn ensure_link(base: &Path, target: &Path, link: &Path) -> bool {
    if let Some(parent) = link.parent() {
        if !is_path_and_ancestors_safe(base, parent) {
            return false;
        }
    }

    let Ok(canon_target) = dunce::canonicalize(target) else {
        return false;
    };

    if let Ok(meta) = link.symlink_metadata() {
        if meta.file_type().is_symlink() {
            if let Ok(existing_target) = dunce::canonicalize(link) {
                if existing_target == canon_target {
                    return true;
                }
            }
            return false;
        } else {
            // User regular file or directory: preserve!
            return false;
        }
    }

    if !is_ancestor_safe(base, link) {
        return false;
    }

    if let Some(parent) = link.parent() {
        let _ = fs::create_dir_all(parent);
    }

    crate::fs_link::symlink_any(&canon_target, link).is_ok()
}

fn expected_target_for_rel(profile_dir: &Path, rel: &str) -> Option<PathBuf> {
    if rel == ".mcp.json" {
        Some(mcp_json_file(profile_dir))
    } else if let Some(skill_name) = rel.strip_prefix(".agents/skills/") {
        Some(skills_dir(profile_dir).join(skill_name))
    } else if let Some(skill_name) = rel.strip_prefix(".claude/skills/") {
        Some(skills_dir(profile_dir).join(skill_name))
    } else if let Some(agent_name) = rel.strip_prefix(".agents/subagents/") {
        Some(agents_dir(profile_dir).join(agent_name))
    } else if let Some(agent_name) = rel.strip_prefix(".claude/agents/") {
        Some(agents_dir(profile_dir).join(agent_name))
    } else {
        None
    }
}

fn symlink_matches_expected_target(link: &Path, expected: &Path, profile_dir: &Path) -> bool {
    let Ok(raw) = fs::read_link(link) else { return false };
    let target = if raw.is_absolute() {
        raw
    } else {
        link.parent().unwrap_or(link).join(raw)
    };

    if let (Ok(c1), Ok(c2)) = (dunce::canonicalize(&target), dunce::canonicalize(expected)) {
        if c1 == c2 {
            return true;
        }
    }

    // Handles dangling links where the expected target in profile was deleted
    let norm_target = dunce::simplified(&target);
    let norm_expected = dunce::simplified(expected);
    if norm_target == norm_expected {
        return true;
    }

    if let Ok(canon_prof) = dunce::canonicalize(profile_dir) {
        if let Ok(rel) = norm_expected.strip_prefix(profile_dir) {
            if norm_target == canon_prof.join(rel) {
                return true;
            }
        }
    }

    false
}

fn cleanup_manifest_links(wt: &Path, profile_dir: &Path, owned: &[String]) {
    for rel in owned {
        if !validate_manifest_rel(rel) {
            continue;
        }
        let p = wt.join(rel);
        if !is_ancestor_safe(wt, &p) {
            continue;
        }
        if let Ok(meta) = p.symlink_metadata() {
            if meta.file_type().is_symlink() {
                if let Some(expected) = expected_target_for_rel(profile_dir, rel) {
                    if symlink_matches_expected_target(&p, &expected, profile_dir) {
                        let _ = crate::fs_link::remove_link(&p);
                    }
                }
            }
        }
    }
}

fn cleanup_manifest_files(wt: &Path, files: &HashMap<String, String>) {
    for (rel, expected_hash) in files {
        if (!rel.starts_with(".codex/agents/") && !rel.starts_with(".claude/agents/")
            && !rel.starts_with(".agents/agents/") && rel != ".agents/mcp_config.json") || rel.contains("..") {
            continue;
        }
        let p = wt.join(rel);
        if !is_path_and_ancestors_safe(wt, &p) {
            continue;
        }
        if p.is_file() {
            if let Ok(bytes) = fs::read(&p) {
                let cur_hash = sha256_hex(&bytes);
                if cur_hash == *expected_hash {
                    let _ = fs::remove_file(&p);
                }
            }
        }
    }
}

/// Preserve project files, edited generated files, and symlink destinations.
/// New adapters share the manifest's existing hash-based ownership contract.
fn write_generated_adapter(
    wt: &Path,
    rel: &str,
    text: &str,
    previous: &HashMap<String, String>,
    active: &mut HashMap<String, String>,
) -> std::io::Result<()> {
    let dest = wt.join(rel);
    if !is_path_and_ancestors_safe(wt, &dest) {
        return Ok(());
    }
    if dest.exists() {
        let existing = fs::read(&dest)?;
        if previous.get(rel) != Some(&sha256_hex(&existing)) {
            return Ok(());
        }
    }
    if let Some(parent) = dest.parent() {
        create_owned_dir_hierarchy(wt, parent)?;
    }
    fs::write(&dest, text)?;
    ensure_task_git_excluded(wt, rel);
    active.insert(rel.to_string(), sha256_hex(text.as_bytes()));
    Ok(())
}

fn render_antigravity_mcp(bytes: &[u8]) -> std::io::Result<String> {
    let mut doc: serde_json::Value = serde_json::from_slice(bytes)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    if let Some(servers) = doc.get_mut("mcpServers").and_then(|v| v.as_object_mut()) {
        for server in servers.values_mut().filter_map(|v| v.as_object_mut()) {
            let url = server.remove("url").or_else(|| server.remove("httpUrl"));
            if let Some(url) = url {
                server.entry("serverUrl").or_insert(url);
            }
        }
    }
    serde_json::to_string_pretty(&doc)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))
}

fn reconcile_codex_mcp(
    wt: &Path,
    prof_mcp: &Path,
    manifest: &mut CustomizationManifest,
) -> std::io::Result<()> {
    let codex_dir = wt.join(".codex");
    if create_owned_dir_hierarchy(wt, &codex_dir).is_err() {
        return Ok(());
    }
    let config_path = codex_dir.join("config.toml");
    let had_config = config_path.exists();
    if config_path.symlink_metadata().map(|m| m.file_type().is_symlink()).unwrap_or(false) {
        return Ok(());
    }

    let Ok(mcp_bytes) = fs::read(prof_mcp) else { return Ok(()) };
    let Ok(doc) = serde_json::from_slice::<serde_json::Value>(&mcp_bytes) else { return Ok(()) };
    let Some(servers) = doc.get("mcpServers").and_then(|v| v.as_object()) else { return Ok(()) };

    let mut toml_doc: toml_edit::DocumentMut = if had_config {
        if !is_path_and_ancestors_safe(wt, &config_path) {
            return Ok(());
        }
        let content = fs::read_to_string(&config_path)?;
        match content.parse::<toml_edit::DocumentMut>() {
            Ok(doc) => doc,
            Err(_) => {
                // Invalid TOML in project: leave it completely untouched!
                return Ok(());
            }
        }
    } else {
        toml_edit::DocumentMut::new()
    };

    if !toml_doc.contains_key("mcp_servers") {
        toml_doc["mcp_servers"] = toml_edit::Item::Table(toml_edit::Table::new());
    }
    let Some(mcp_table) = toml_doc["mcp_servers"].as_table_mut() else { return Ok(()) };

    let conflicts = find_conflicting_dest_keys(prof_mcp);

    let mut new_active_servers = HashMap::new();
    for (s_name, s_val) in servers {
        let mut server_table = toml_edit::Table::new();
        let mut server_has_conflict = false;
        if let Some(env) = s_val.get("env").and_then(|v| v.as_object()) {
            for (k, v) in env {
                if let Some(value) = v.as_str() {
                    let t = value.trim();
                    if t.starts_with("${") && t.ends_with('}') && conflicts.contains(k) {
                        server_has_conflict = true;
                        break;
                    }
                }
            }
        }
        if server_has_conflict {
            server_table["enabled"] = toml_edit::value(false);
        }

        if let Some(cmd) = s_val.get("command").and_then(|v| v.as_str()) {
            server_table["command"] = toml_edit::value(cmd);
        }
        if let Some(args) = s_val.get("args").and_then(|v| v.as_array()) {
            let mut arr = toml_edit::Array::new();
            for a in args {
                if let Some(s) = a.as_str() {
                    arr.push(s);
                }
            }
            server_table["args"] = toml_edit::Item::Value(toml_edit::Value::Array(arr));
        }
        if let Some(env) = s_val.get("env").and_then(|v| v.as_object()) {
            let mut env_table = toml_edit::InlineTable::new();
            let mut env_vars_arr = toml_edit::Array::new();
            for (k, v) in env {
                if let Some(val_str) = v.as_str() {
                    let trimmed = val_str.trim();
                    if trimmed.starts_with("${") && trimmed.ends_with('}') {
                        if !conflicts.contains(k) {
                            env_vars_arr.push(k);
                        }
                    } else {
                        env_table.insert(k, val_str.into());
                    }
                }
            }
            if !env_table.is_empty() {
                server_table["env"] = toml_edit::Item::Value(toml_edit::Value::InlineTable(env_table));
            }
            if !env_vars_arr.is_empty() {
                server_table["env_vars"] = toml_edit::Item::Value(toml_edit::Value::Array(env_vars_arr));
            }
        }
        if let Some(env_vars) = s_val.get("env_vars").or_else(|| s_val.get("envVars")).and_then(|v| v.as_array()) {
            let mut arr = match server_table.get("env_vars").and_then(|i| i.as_array()) {
                Some(a) => a.clone(),
                None => toml_edit::Array::new(),
            };
            for v in env_vars {
                if let Some(s) = v.as_str() {
                    let trimmed = s.trim();
                    let var_name = if trimmed.starts_with("${") && trimmed.ends_with('}') {
                        &trimmed[2..trimmed.len() - 1]
                    } else {
                        trimmed
                    };
                    if !conflicts.contains(var_name) {
                        arr.push(var_name);
                    }
                }
            }
            if !arr.is_empty() {
                server_table["env_vars"] = toml_edit::Item::Value(toml_edit::Value::Array(arr));
            }
        }
        if let Some(url) = s_val.get("url").and_then(|v| v.as_str()) {
            server_table["url"] = toml_edit::value(url);
        }
        if let Some(headers) = s_val.get("headers").or_else(|| s_val.get("http_headers")).and_then(|v| v.as_object()) {
            let mut env_headers_table = toml_edit::InlineTable::new();
            let mut static_headers_table = toml_edit::InlineTable::new();
            for (k, v) in headers {
                if let Some(val_str) = v.as_str() {
                    let trimmed = val_str.trim();
                    if trimmed.starts_with("${") && trimmed.ends_with('}') {
                        let var_name = &trimmed[2..trimmed.len() - 1];
                        env_headers_table.insert(k, var_name.into());
                    } else {
                        static_headers_table.insert(k, val_str.into());
                    }
                }
            }
            if !env_headers_table.is_empty() {
                server_table["env_http_headers"] = toml_edit::Item::Value(toml_edit::Value::InlineTable(env_headers_table));
            }
            if !static_headers_table.is_empty() {
                server_table["http_headers"] = toml_edit::Item::Value(toml_edit::Value::InlineTable(static_headers_table));
            }
        }
        if let Some(env_headers) = s_val.get("env_http_headers").and_then(|v| v.as_object()) {
            let mut env_headers_table = match server_table.get("env_http_headers").and_then(|i| i.as_inline_table()) {
                Some(t) => t.clone(),
                None => toml_edit::InlineTable::new(),
            };
            for (k, v) in env_headers {
                if let Some(val_str) = v.as_str() {
                    let trimmed = val_str.trim();
                    let var_name = if trimmed.starts_with("${") && trimmed.ends_with('}') {
                        &trimmed[2..trimmed.len() - 1]
                    } else {
                        trimmed
                    };
                    env_headers_table.insert(k, var_name.into());
                }
            }
            if !env_headers_table.is_empty() {
                server_table["env_http_headers"] = toml_edit::Item::Value(toml_edit::Value::InlineTable(env_headers_table));
            }
        }
        if let Some(bearer) = s_val.get("bearer_token_env_var").or_else(|| s_val.get("bearerTokenEnvVar")).and_then(|v| v.as_str()) {
            let trimmed = bearer.trim();
            let var_name = if trimmed.starts_with("${") && trimmed.ends_with('}') {
                &trimmed[2..trimmed.len() - 1]
            } else {
                trimmed
            };
            server_table["bearer_token_env_var"] = toml_edit::value(var_name);
        }

        let new_hash = sha256_hex(server_table.to_string().as_bytes());
        if let Some(existing_item) = mcp_table.get(s_name) {
            let existing_hash = sha256_hex(existing_item.to_string().as_bytes());
            if let Some(prev_hash) = manifest.owned_mcp_servers.get(s_name) {
                if existing_hash != *prev_hash && existing_hash != new_hash {
                    // User modified it: relinquish ownership
                    continue;
                }
            } else {
                // Project-owned server: do not overwrite!
                continue;
            }
        }
        mcp_table.insert(s_name, toml_edit::Item::Table(server_table));
        new_active_servers.insert(s_name.clone(), new_hash);
    }

    for (old, expected_hash) in &manifest.owned_mcp_servers {
        if !new_active_servers.contains_key(old) {
            if let Some(existing_item) = mcp_table.get(old) {
                let existing_hash = sha256_hex(existing_item.to_string().as_bytes());
                if existing_hash == *expected_hash {
                    mcp_table.remove(old);
                }
            }
        }
    }

    manifest.owned_mcp_servers = new_active_servers;

    if is_path_and_ancestors_safe(wt, &config_path) {
        if fs::write(&config_path, toml_doc.to_string()).is_ok() && !had_config {
            ensure_task_git_excluded(wt, ".codex/config.toml");
        }
    }
    Ok(())
}

fn cleanup_codex_mcp(wt: &Path, owned_servers: &HashMap<String, String>) {
    let config_path = wt.join(".codex").join("config.toml");
    if !config_path.is_file() || !is_path_and_ancestors_safe(wt, &config_path) {
        return;
    }
    let Ok(content) = fs::read_to_string(&config_path) else { return };
    let Ok(mut doc) = content.parse::<toml_edit::DocumentMut>() else { return };
    if let Some(table) = doc.get_mut("mcp_servers").and_then(|v| v.as_table_mut()) {
        for (s, expected_hash) in owned_servers {
            if let Some(cur_item) = table.get(s) {
                let cur_hash = sha256_hex(cur_item.to_string().as_bytes());
                if cur_hash == *expected_hash {
                    table.remove(s);
                }
            }
        }
    }
    let _ = fs::write(&config_path, doc.to_string());
}

fn resolve_git_exclude_paths(wt: &Path) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    let git_dir = wt.join(".git");
    if git_dir.is_file() {
        if let Ok(content) = fs::read_to_string(&git_dir) {
            if let Some(rest) = content.trim().strip_prefix("gitdir:") {
                let p = PathBuf::from(rest.trim());
                let p_abs = if p.is_absolute() { p } else { wt.join(p) };
                // Check commondir
                if let Ok(commondir) = fs::read_to_string(p_abs.join("commondir")) {
                    let c_path = commondir.trim();
                    let common = if Path::new(c_path).is_absolute() {
                        PathBuf::from(c_path)
                    } else {
                        p_abs.join(c_path)
                    };
                    paths.push(common.join("info").join("exclude"));
                }
                paths.push(p_abs.join("info").join("exclude"));
            }
        }
    } else if git_dir.is_dir() {
        paths.push(git_dir.join("info").join("exclude"));
    }
    paths
}

fn ensure_task_git_excluded(wt: &Path, pattern: &str) {
    for exclude_path in resolve_git_exclude_paths(wt) {
        if let Ok(content) = fs::read_to_string(&exclude_path) {
            if content.lines().any(|l| l.trim() == pattern) {
                continue;
            }
        }

        if let Some(parent) = exclude_path.parent() {
            let _ = fs::create_dir_all(parent);
        }

        let mut body = fs::read_to_string(&exclude_path).unwrap_or_default();
        if !body.is_empty() && !body.ends_with('\n') {
            body.push('\n');
        }
        body.push_str(pattern);
        body.push('\n');
        let _ = fs::write(&exclude_path, body.as_bytes());
    }
}

// ───────────────────────────── Config Sync ──────────────────────────────

/// Mirrors `<profile_dir>/customizations/` into `<clone>/profiles/<sync_id>/customizations/`.
///
/// Adheres strictly to security rules:
/// - Skips any file matching `*.local`, `*secret*`, `*token*`.
/// - Sanitizes `mcp.json` to replace raw strings with `${VAR}` references.
/// - Preserves executable permissions for scripts.
pub fn export_customizations(clone: &Path, profile_dir: &Path, sync_id: &str) -> Result<(), String> {
    let src = customizations_dir(profile_dir);
    let mut exported_rel: BTreeSet<String> = BTreeSet::new();

    let dst = clone.join("profiles").join(sync_id).join("customizations");
    if let Ok(dst_meta) = dst.symlink_metadata() {
        if dst_meta.file_type().is_symlink() {
            crate::fs_link::remove_link(&dst).map_err(|e| format!("Failed to remove destination symlink {}: {e}", dst.display()))?;
        }
    }

    match src.symlink_metadata() {
        Ok(meta) => {
            if meta.file_type().is_symlink() || !is_path_and_ancestors_safe(profile_dir, &src) {
                return Ok(());
            }
            if meta.is_dir() {
                fs::create_dir_all(&dst).map_err(|e| e.to_string())?;
                export_customizations_recursive(&src, &src, &dst, &mut exported_rel)?;
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            // Source does not exist: treat as empty source and prune dst
        }
        Err(e) => {
            return Err(format!("Failed to read metadata for {}: {e}", src.display()));
        }
    }

    if dst.exists() {
        prune_stale_customizations(&dst, &dst, &exported_rel)?;
    }

    Ok(())
}

fn export_customizations_recursive(
    root: &Path,
    current: &Path,
    dst_root: &Path,
    exported: &mut BTreeSet<String>,
) -> Result<(), String> {
    let entries = fs::read_dir(current)
        .map_err(|e| format!("Failed to read directory {}: {e}", current.display()))?;
    for entry_res in entries {
        let entry = entry_res.map_err(|e| format!("Failed to read dir entry: {e}"))?;
        let path = entry.path();
        let meta = path
            .symlink_metadata()
            .map_err(|e| format!("Failed to read metadata for {}: {e}", path.display()))?;

        // NEVER follow symlinks during export!
        if meta.file_type().is_symlink() {
            continue;
        }

        let name = entry.file_name().to_string_lossy().to_string();

        // Security filter: NEVER sync machine-local credentials or tokens
        if name.ends_with(".local") || name.contains("secret") || name.contains("token") {
            continue;
        }

        let Ok(rel) = path.strip_prefix(root) else { continue };
        let rel_str = rel.to_string_lossy().to_string();

        if meta.is_dir() {
            export_customizations_recursive(root, &path, dst_root, exported)?;
        } else if meta.is_file() {
            let target = dst_root.join(rel);
            if let Some(parent) = target.parent() {
                if !is_path_and_ancestors_safe(dst_root, parent) {
                    continue;
                }
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }

            // Destination leaf safety: NEVER write through a destination symlink!
            if let Ok(target_meta) = target.symlink_metadata() {
                if target_meta.file_type().is_symlink() {
                    crate::fs_link::remove_link(&target)
                        .map_err(|e| format!("Failed to remove destination symlink {}: {e}", target.display()))?;
                }
            }

            // If it's mcp.json, sanitize any raw credentials (fails closed on malformed JSON)
            if name == "mcp.json" {
                let raw = fs::read(&path).map_err(|e| e.to_string())?;
                let sanitized = sanitize_mcp_json_bytes(&raw)?;
                write_if_changed(&target, &sanitized)?;
            } else {
                let bytes = fs::read(&path).map_err(|e| e.to_string())?;
                write_if_changed(&target, &bytes)?;
                copy_executable_mode(&path, &target);
            }
            exported.insert(rel_str);
        }
    }
    Ok(())
}

fn prune_stale_customizations(dst_root: &Path, current: &Path, exported: &BTreeSet<String>) -> Result<(), String> {
    let entries = fs::read_dir(current)
        .map_err(|e| format!("Failed to read directory {}: {e}", current.display()))?;
    for entry_res in entries {
        let entry = entry_res.map_err(|e| format!("Failed to read dir entry: {e}"))?;
        let path = entry.path();
        let meta = path
            .symlink_metadata()
            .map_err(|e| format!("Failed to read metadata for {}: {e}", path.display()))?;

        if meta.file_type().is_symlink() {
            crate::fs_link::remove_link(&path)
                .map_err(|e| format!("Failed to remove stale symlink {}: {e}", path.display()))?;
            continue;
        }

        if meta.is_dir() {
            prune_stale_customizations(dst_root, &path, exported)?;
            let _ = fs::remove_dir(&path); // Only succeeds if empty
        } else if meta.is_file() {
            if let Ok(rel) = path.strip_prefix(dst_root) {
                let rel_str = rel.to_string_lossy().to_string();
                if !exported.contains(&rel_str) {
                    fs::remove_file(&path)
                        .map_err(|e| format!("Failed to remove stale file {}: {e}", path.display()))?;
                }
            }
        }
    }
    Ok(())
}

fn write_if_changed(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Ok(meta) = path.symlink_metadata() {
        if meta.file_type().is_symlink() {
            return Err(format!("Cannot write through destination symlink {}", path.display()));
        }
    }
    if let Ok(existing) = fs::read(path) {
        if existing == bytes {
            return Ok(());
        }
    }
    fs::write(path, bytes).map_err(|e| e.to_string())
}

#[cfg(unix)]
fn copy_executable_mode(src: &Path, dst: &Path) {
    use std::os::unix::fs::PermissionsExt;
    if let Ok(meta) = fs::metadata(src) {
        let mode = meta.permissions().mode();
        let _ = fs::set_permissions(dst, fs::Permissions::from_mode(mode));
    }
}

#[cfg(not(unix))]
fn copy_executable_mode(_src: &Path, _dst: &Path) {}

fn is_sensitive_key(k: &str) -> bool {
    let s = k.to_ascii_lowercase();
    s.contains("key")
        || s.contains("token")
        || s.contains("secret")
        || s.contains("auth")
        || s.contains("pass")
        || s.contains("cred")
}

/// Sanitizes an MCP config to replace raw API keys or hardcoded tokens with `${VAR}` references.
/// Fails closed (returns Err) on invalid JSON.
pub fn sanitize_mcp_json_bytes(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let mut doc: serde_json::Value = serde_json::from_slice(bytes)
        .map_err(|e| format!("Invalid JSON in mcp.json: {e}"))?;

    if let Some(servers) = doc.get_mut("mcpServers").and_then(|v| v.as_object_mut()) {
        for (_name, server) in servers.iter_mut() {
            if let Some(env) = server.get_mut("env").and_then(|v| v.as_object_mut()) {
                for (k, v) in env.iter_mut() {
                    if let Some(val_str) = v.as_str() {
                        if !val_str.starts_with("${") || !val_str.ends_with('}') {
                            *v = serde_json::Value::String(format!("${{{k}}}"));
                        }
                    }
                }
            }
            for header_field in ["headers", "http_headers", "httpHeaders"] {
                if let Some(headers) = server.get_mut(header_field).and_then(|v| v.as_object_mut()) {
                    for (k, v) in headers.iter_mut() {
                        if let Some(val_str) = v.as_str() {
                            if !val_str.starts_with("${") || !val_str.ends_with('}') {
                                let placeholder = k.to_ascii_uppercase().replace('-', "_");
                                *v = serde_json::Value::String(format!("${{{placeholder}}}"));
                            }
                        }
                    }
                }
            }
            if let Some(args) = server.get_mut("args").and_then(|v| v.as_array_mut()) {
                let mut prev_flag_sensitive = false;
                for arg_val in args.iter_mut() {
                    if let Some(arg_str) = arg_val.as_str() {
                        if prev_flag_sensitive {
                            if !arg_str.starts_with("${") {
                                *arg_val = serde_json::Value::String("${ARG_CREDENTIAL}".into());
                            }
                            prev_flag_sensitive = false;
                            continue;
                        }
                        if let Some((flag, _val)) = arg_str.split_once('=') {
                            if is_sensitive_key(flag) {
                                let placeholder = flag.trim_start_matches('-').to_ascii_uppercase().replace('-', "_");
                                *arg_val = serde_json::Value::String(format!("{flag}=${{{placeholder}}}"));
                                continue;
                            }
                        }
                        if arg_str.starts_with("--") || arg_str.starts_with('-') {
                            if is_sensitive_key(arg_str) {
                                prev_flag_sensitive = true;
                                continue;
                            }
                        }
                        if is_sensitive_key(arg_str) && !arg_str.starts_with("${") {
                            *arg_val = serde_json::Value::String("${ARG_CREDENTIAL}".into());
                        }
                    }
                }
            }
            if let Some(url_val) = server.get_mut("url") {
                if let Some(url_str) = url_val.as_str() {
                    let mut new_url = url_str.to_string();
                    if let Some((proto, rest)) = new_url.split_once("://") {
                        if let Some((userinfo, host_path)) = rest.split_once('@') {
                            if !userinfo.is_empty() {
                                new_url = format!("{proto}://${{AUTH}}@{host_path}");
                            }
                        }
                    }
                    if let Some((base, query)) = new_url.split_once('?') {
                        let mut sanitized_params = Vec::new();
                        for param in query.split('&') {
                            if let Some((k, _v)) = param.split_once('=') {
                                if is_sensitive_key(k) {
                                    let placeholder = k.trim_start_matches('-').to_ascii_uppercase().replace('-', "_");
                                    sanitized_params.push(format!("{k}=${{{placeholder}}}"));
                                } else {
                                    sanitized_params.push(param.to_string());
                                }
                            } else if is_sensitive_key(param) {
                                sanitized_params.push("${CREDENTIAL}".to_string());
                            } else {
                                sanitized_params.push(param.to_string());
                            }
                        }
                        new_url = format!("{base}?{}", sanitized_params.join("&"));
                    }
                    *url_val = serde_json::Value::String(new_url);
                }
            }
        }
    }

    serde_json::to_vec_pretty(&doc).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn model_tier_resolution() {
        let (m, args) = resolve_model_tier(ModelTier::Reasoning, "codex");
        assert_eq!(m, Some("o3-mini"));
        assert!(args.iter().any(|a| a.contains("xhigh")));

        let (m, _) = resolve_model_tier(ModelTier::Fast, "claude");
        assert_eq!(m, Some("haiku"));

        let (m, _) = resolve_model_tier(ModelTier::Balanced, "agy");
        assert_eq!(m, Some("flash"));
    }

    #[test]
    fn antigravity_native_files_are_rendered_and_removed_with_their_sources() {
        let dir = tempdir().unwrap();
        let profile = dir.path().join("profile");
        let wt = dir.path().join("wt");
        ensure_builtin_skills(&profile).unwrap();
        fs::create_dir_all(wt.join(".git/info")).unwrap();
        for (name, tier, model) in [("fast-review", "fast", "flash"), ("code-review", "balanced", "flash"), ("deep-review", "reasoning", "pro")] {
            fs::write(agents_dir(&profile).join(format!("{name}.md")), format!("---\ndescription: Reviews changes\nmodel_tier: {tier}\n---\nReview code.\n")).unwrap();
            // The native format must not require a name in portable sources.
            let text = render_antigravity_agent_md(name, &fs::read_to_string(agents_dir(&profile).join(format!("{name}.md"))).unwrap());
            assert!(text.contains(&format!("name: {name}\n")));
            assert!(text.contains(&format!("model: {model}\n")));
        }
        fs::write(mcp_json_file(&profile), r#"{"mcpServers":{"termic-native-stdio":{"command":"example-helper","args":["--stdio"]},"termic-native-http":{"url":"https://example.com/mcp","headers":{"Authorization":"${AUTHORIZATION}"}}}}"#).unwrap();
        fs::write(mcp_env_file(&profile), "AUTHORIZATION=synthetic-local-only-secret").unwrap();
        reconcile_customizations(&profile, &wt, CustomizationMode::Inherit, "agy").unwrap();
        let config_path = wt.join(".agents/mcp_config.json");
        let config: serde_json::Value = serde_json::from_slice(&fs::read(&config_path).unwrap()).unwrap();
        assert_eq!(config["mcpServers"]["termic-native-http"]["serverUrl"], "https://example.com/mcp");
        assert!(config["mcpServers"]["termic-native-http"].get("url").is_none());
        assert_eq!(config["mcpServers"]["termic-native-stdio"]["args"][0], "--stdio");
        assert!(!fs::read_to_string(&config_path).unwrap().contains("synthetic-local-only-secret"));
        let excludes = fs::read_to_string(wt.join(".git/info/exclude")).unwrap();
        assert!(excludes.lines().any(|l| l == ".agents/mcp_config.json"));
        assert!(!excludes.lines().any(|l| l == ".agents"));
        reconcile_customizations(&profile, &wt, CustomizationMode::Inherit, "codex").unwrap();
        assert!(wt.join(".agents/agents/deep-review/agent.md").is_file(), "Opening another CLI must retain native files");
        fs::remove_file(agents_dir(&profile).join("deep-review.md")).unwrap();
        fs::remove_file(mcp_json_file(&profile)).unwrap();
        reconcile_customizations(&profile, &wt, CustomizationMode::Inherit, "agy").unwrap();
        assert!(!config_path.exists());
        assert!(!wt.join(".agents/agents/deep-review/agent.md").exists());
        reconcile_customizations(&profile, &wt, CustomizationMode::None, "agy").unwrap();
        assert!(!wt.join(".agents/agents/fast-review/agent.md").exists());
    }

    #[test]
    fn antigravity_adapter_preserves_project_and_user_edited_files() {
        let dir = tempdir().unwrap();
        let profile = dir.path().join("profile");
        let wt = dir.path().join("wt");
        ensure_builtin_skills(&profile).unwrap();
        fs::create_dir_all(wt.join(".agents/agents/reviewer")).unwrap();
        fs::write(agents_dir(&profile).join("reviewer.md"), "Profile persona").unwrap();
        fs::write(mcp_json_file(&profile), r#"{"mcpServers":{}}"#).unwrap();
        let agent_path = wt.join(".agents/agents/reviewer/agent.md");
        let mcp_path = wt.join(".agents/mcp_config.json");
        fs::write(&agent_path, "Project persona").unwrap();
        reconcile_customizations(&profile, &wt, CustomizationMode::Inherit, "agy").unwrap();
        assert_eq!(fs::read_to_string(&agent_path).unwrap(), "Project persona");
        fs::write(&mcp_path, "User-edited MCP").unwrap();
        for mode in [CustomizationMode::Inherit, CustomizationMode::Inherit, CustomizationMode::Override] {
            reconcile_customizations(&profile, &wt, mode, "agy").unwrap();
            assert_eq!(fs::read_to_string(&agent_path).unwrap(), "Project persona");
            assert_eq!(fs::read_to_string(&mcp_path).unwrap(), "User-edited MCP");
        }
    }

    #[test]
    fn antigravity_adapter_does_not_write_through_symlinks() {
        let dir = tempdir().unwrap();
        let profile = dir.path().join("profile");
        let wt = dir.path().join("wt");
        let outside = dir.path().join("outside");
        ensure_builtin_skills(&profile).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::create_dir_all(wt.join(".agents")).unwrap();
        fs::write(agents_dir(&profile).join("reviewer.md"), "Review code.").unwrap();
        fs::write(mcp_json_file(&profile), r#"{"mcpServers":{}}"#).unwrap();
        let external_file = outside.join("mcp.json");
        fs::write(&external_file, "External file").unwrap();
        crate::fs_link::symlink_any(&outside, wt.join(".agents/agents")).unwrap();
        crate::fs_link::symlink_any(&external_file, wt.join(".agents/mcp_config.json")).unwrap();
        reconcile_customizations(&profile, &wt, CustomizationMode::Inherit, "agy").unwrap();
        reconcile_customizations(&profile, &wt, CustomizationMode::None, "agy").unwrap();
        assert_eq!(fs::read_to_string(&external_file).unwrap(), "External file");
        assert!(!outside.join("reviewer").exists());
        assert!(wt.join(".agents/mcp_config.json").symlink_metadata().unwrap().file_type().is_symlink());
    }

    #[test]
    fn ensures_builtin_termic_skill_seeding_and_hash_guard() {
        let dir = tempdir().unwrap();
        ensure_builtin_skills(dir.path()).unwrap();

        let skill_file = skills_dir(dir.path()).join("termic").join("SKILL.md");
        assert!(skill_file.exists());
        let text = fs::read_to_string(&skill_file).unwrap();
        assert!(text.contains("name: termic"));

        // User edits the file
        let customized = format!("{text}\n# User addition");
        fs::write(&skill_file, customized.as_bytes()).unwrap();

        // Re-seeding preserves user edit
        ensure_builtin_skills(dir.path()).unwrap();
        assert!(fs::read_to_string(&skill_file).unwrap().contains("User addition"));
    }

    #[test]
    fn bundled_references_upgrade_independently_and_preserve_user_edits() {
        let dir = tempdir().unwrap();
        let skill = skills_dir(dir.path()).join("termic");
        fs::create_dir_all(&skill).unwrap();
        // A pre-references install with a customized entrypoint still gains
        // the reference files, without replacing its user's instructions.
        fs::write(skill.join("SKILL.md"), "User orchestration instructions").unwrap();
        ensure_builtin_skills(dir.path()).unwrap();
        assert_eq!(fs::read_to_string(skill.join("SKILL.md")).unwrap(), "User orchestration instructions");
        let refs = skill.join("references");
        for (name, text) in BUILTIN_TERMIC_REFERENCES {
            assert_eq!(fs::read_to_string(refs.join(name)).unwrap(), *text);
        }
        let worktree = dir.path().join("worktree");
        fs::create_dir_all(&worktree).unwrap();
        reconcile_customizations(dir.path(), &worktree, CustomizationMode::Inherit, "codex").unwrap();
        assert_eq!(
            fs::read_to_string(worktree.join(".agents/skills/termic/references/customizations.md")).unwrap(),
            BUILTIN_TERMIC_REFERENCES[0].1,
        );

        fs::write(refs.join("customizations.md"), "User customization guide").unwrap();
        let old = "Previous bundled control guide";
        fs::write(refs.join("control-surface.md"), old).unwrap();
        fs::write(refs.join(".control-surface.md.termic-version"), sha256_hex(old.as_bytes())).unwrap();
        ensure_builtin_skills(dir.path()).unwrap();
        assert_eq!(fs::read_to_string(refs.join("customizations.md")).unwrap(), "User customization guide");
        assert_eq!(fs::read_to_string(refs.join("control-surface.md")).unwrap(), BUILTIN_TERMIC_REFERENCES[1].1);

        // Recreate a missing reference even when its version marker remains.
        fs::remove_file(refs.join("control-surface.md")).unwrap();
        ensure_builtin_skills(dir.path()).unwrap();
        assert_eq!(fs::read_to_string(refs.join("control-surface.md")).unwrap(), BUILTIN_TERMIC_REFERENCES[1].1);
    }

    #[test]
    fn bundled_reference_failures_are_reported() {
        let dir = tempdir().unwrap();
        let skill = skills_dir(dir.path()).join("termic");
        fs::create_dir_all(&skill).unwrap();
        fs::write(skill.join("references"), "Occupied").unwrap();
        assert!(ensure_builtin_skills(dir.path()).is_err());
    }

    #[test]
    fn ancestor_symlink_protection_prevents_write_through() {
        let dir = tempdir().unwrap();
        let repo = dir.path().join("repo");
        let wt = dir.path().join("wt");
        fs::create_dir_all(&repo).unwrap();
        fs::create_dir_all(&wt).unwrap();

        // Simulate link_config_dir: wt/.claude -> repo/.claude
        let repo_claude = repo.join(".claude");
        fs::create_dir_all(&repo_claude).unwrap();
        crate::fs_link::symlink_any(&repo_claude, wt.join(".claude")).unwrap();

        // Test ancestor safety on wt/.claude/agents/new.md
        let dest = wt.join(".claude").join("agents").join("new.md");
        assert!(!is_ancestor_safe(&wt, &dest), "must reject write through ancestor symlink");
    }

    #[test]
    fn mcp_secret_sanitization() {
        let raw = serde_json::json!({
            "mcpServers": {
                "github": {
                    "command": "npx",
                    "env": {
                        "GITHUB_TOKEN": "ghp_secret_token_12345"
                    }
                }
            }
        });
        let bytes = serde_json::to_vec(&raw).unwrap();
        let sanitized = sanitize_mcp_json_bytes(&bytes).unwrap();
        let doc: serde_json::Value = serde_json::from_slice(&sanitized).unwrap();
        assert_eq!(
            doc["mcpServers"]["github"]["env"]["GITHUB_TOKEN"],
            "${GITHUB_TOKEN}"
        );
    }

    #[test]
    fn reconcile_customizations_lifecycle_and_cleanup() {
        let dir = tempdir().unwrap();
        let profile = dir.path().join("profile");
        let wt = dir.path().join("wt");
        fs::create_dir_all(&profile).unwrap();
        fs::create_dir_all(&wt).unwrap();

        ensure_builtin_skills(&profile).unwrap();

        // 1. Inherit creates symlinks
        reconcile_customizations(&profile, &wt, CustomizationMode::Inherit, "claude").unwrap();
        let wt_skill = wt.join(".agents/skills/termic");
        assert!(wt_skill.exists());
        assert!(wt.join(".termic/customization-manifest.json").exists());

        // 2. Switching to None cleans up owned links
        reconcile_customizations(&profile, &wt, CustomizationMode::None, "claude").unwrap();
        assert!(!wt_skill.exists());
        assert!(!wt.join(".termic/customization-manifest.json").exists());
    }

    #[test]
    fn reconcile_customizations_preserves_user_files() {
        let dir = tempdir().unwrap();
        let profile = dir.path().join("profile");
        let wt = dir.path().join("wt");
        fs::create_dir_all(&profile).unwrap();
        fs::create_dir_all(wt.join(".agents/skills/termic")).unwrap();

        // User placed an existing real directory at .agents/skills/termic
        let user_file = wt.join(".agents/skills/termic/SKILL.md");
        fs::write(&user_file, b"user version").unwrap();

        ensure_builtin_skills(&profile).unwrap();
        reconcile_customizations(&profile, &wt, CustomizationMode::Inherit, "claude").unwrap();

        // Content remains user version
        assert_eq!(fs::read_to_string(&user_file).unwrap(), "user version");
    }

    #[test]
    fn unchanged_second_reconcile_retains_skills_and_mcp() {
        let dir = tempdir().unwrap();
        let p = dir.path().join("profile");
        let w = dir.path().join("wt");
        fs::create_dir_all(&w).unwrap();
        ensure_builtin_skills(&p).unwrap();
        fs::write(mcp_json_file(&p), b"{}").unwrap();
        reconcile_customizations(&p, &w, CustomizationMode::Inherit, "codex").unwrap();
        assert!(w.join(".agents/skills/termic").exists());
        assert!(w.join(".mcp.json").exists());
        reconcile_customizations(&p, &w, CustomizationMode::Inherit, "codex").unwrap();
        assert!(w.join(".agents/skills/termic").exists(), "second reconciliation deleted unchanged skill link");
        assert!(w.join(".mcp.json").exists(), "second reconciliation deleted unchanged MCP link");
    }

    #[test]
    fn user_replacement_is_preserved() {
        let dir = tempdir().unwrap();
        let p = dir.path().join("profile");
        let w = dir.path().join("wt");
        fs::create_dir_all(&w).unwrap();
        ensure_builtin_skills(&p).unwrap();
        reconcile_customizations(&p, &w, CustomizationMode::Inherit, "codex").unwrap();
        let leaf = w.join(".agents/skills/termic");
        crate::fs_link::remove_link(&leaf).unwrap();
        fs::write(&leaf, b"user replacement").unwrap();
        reconcile_customizations(&p, &w, CustomizationMode::Inherit, "codex").unwrap();
        assert_eq!(fs::read(&leaf).unwrap(), b"user replacement");
    }

    #[test]
    fn manifest_leaf_symlink_cannot_overwrite_external_file() {
        let dir = tempdir().unwrap();
        let p = dir.path().join("profile");
        let w = dir.path().join("wt");
        fs::create_dir_all(&w).unwrap();
        ensure_builtin_skills(&p).unwrap();
        let outside = dir.path().join("external.json");
        fs::write(&outside, b"{\"owned_links\":[]}\n").unwrap();
        fs::create_dir_all(w.join(".termic")).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, w.join(".termic/customization-manifest.json")).unwrap();
        reconcile_customizations(&p, &w, CustomizationMode::Inherit, "codex").unwrap();
        assert_eq!(fs::read(&outside).unwrap(), b"{\"owned_links\":[]}\n", "manifest write followed leaf symlink");
    }

    #[test]
    fn codex_adapter_preserves_existing_project_agent() {
        let dir = tempdir().unwrap();
        let p = dir.path().join("profile");
        let w = dir.path().join("wt");
        fs::create_dir_all(&w).unwrap();
        ensure_builtin_skills(&p).unwrap();
        fs::write(agents_dir(&p).join("reviewer.md"), b"---\nname: reviewer\ndescription: Reviews code\n---\nReview code.").unwrap();
        fs::create_dir_all(w.join(".codex/agents")).unwrap();
        let file = w.join(".codex/agents/reviewer.toml");
        fs::write(&file, b"user-owned agent").unwrap();
        reconcile_customizations(&p, &w, CustomizationMode::Inherit, "codex").unwrap();
        assert_eq!(fs::read(&file).unwrap(), b"user-owned agent", "Codex adapter overwrote project agent");
    }

    #[test]
    fn codex_adapter_cannot_write_through_agents_directory_symlink() {
        let dir = tempdir().unwrap();
        let p = dir.path().join("profile");
        let w = dir.path().join("wt");
        fs::create_dir_all(&w).unwrap();
        ensure_builtin_skills(&p).unwrap();
        fs::write(agents_dir(&p).join("reviewer.md"), b"---\nname: reviewer\ndescription: Reviews code\n---\nReview code.").unwrap();
        let outside = dir.path().join("external-agents");
        fs::create_dir_all(&outside).unwrap();
        fs::create_dir_all(w.join(".codex")).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, w.join(".codex/agents")).unwrap();
        reconcile_customizations(&p, &w, CustomizationMode::Inherit, "codex").unwrap();
        assert!(!outside.join("reviewer.toml").exists(), "Codex adapter wrote through symlinked agents directory");
    }

    #[test]
    fn disabling_customizations_removes_generated_codex_agent() {
        let dir = tempdir().unwrap();
        let p = dir.path().join("profile");
        let w = dir.path().join("wt");
        fs::create_dir_all(&w).unwrap();
        ensure_builtin_skills(&p).unwrap();
        fs::write(agents_dir(&p).join("reviewer.md"), b"---\nname: reviewer\ndescription: Reviews code\n---\nReview code.").unwrap();
        reconcile_customizations(&p, &w, CustomizationMode::Inherit, "codex").unwrap();
        assert!(w.join(".codex/agents/reviewer.toml").exists());
        reconcile_customizations(&p, &w, CustomizationMode::None, "codex").unwrap();
        assert!(!w.join(".codex/agents/reviewer.toml").exists(), "Disabled mode left generated agent active");
    }

    #[test]
    fn mcp_args_credentials_cannot_be_exported() {
        let dir = tempdir().unwrap();
        let p = dir.path().join("profile");
        let clone = dir.path().join("clone");
        fs::create_dir_all(&p).unwrap();
        fs::create_dir_all(mcp_dir(&p)).unwrap();
        fs::write(mcp_json_file(&p), br#"{"mcpServers":{"sample":{"command":"example","args":["--api-key=SYNTHETIC_ARGS_CREDENTIAL"]}}}"#).unwrap();
        export_customizations(&clone, &p, "test").unwrap();
        let text = fs::read_to_string(clone.join("profiles/test/customizations/mcp/mcp.json")).unwrap();
        assert!(!text.contains("SYNTHETIC_ARGS_CREDENTIAL"), "MCP args credential was exported verbatim");
    }

    #[test]
    fn export_cannot_overwrite_destination_leaf_symlink() {
        let dir = tempdir().unwrap();
        let p = dir.path().join("profile");
        let clone = dir.path().join("clone");
        ensure_builtin_skills(&p).unwrap();
        let dst = clone.join("profiles/test/customizations/skills/termic");
        fs::create_dir_all(&dst).unwrap();
        let outside = dir.path().join("outside.txt");
        fs::write(&outside, b"keep").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, dst.join("SKILL.md")).unwrap();
        export_customizations(&clone, &p, "test").unwrap();
        assert_eq!(fs::read(&outside).unwrap(), b"keep", "Export followed destination file symlink");
    }

    #[test]
    fn export_cannot_follow_source_customizations_root_symlink() {
        let dir = tempdir().unwrap();
        let p = dir.path().join("profile");
        let outside = dir.path().join("outside");
        fs::create_dir_all(&p).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("private.txt"), b"synthetic private bytes").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, customizations_dir(&p)).unwrap();
        let clone = dir.path().join("clone");
        export_customizations(&clone, &p, "test").unwrap();
        assert!(!clone.join("profiles/test/customizations/private.txt").exists(), "Export followed root symlink");
    }

    #[test]
    fn deleted_source_removes_owned_dangling_link() {
        let dir = tempdir().unwrap();
        let p = dir.path().join("profile");
        let w = dir.path().join("wt");
        fs::create_dir_all(&w).unwrap();
        ensure_builtin_skills(&p).unwrap();
        reconcile_customizations(&p, &w, CustomizationMode::Inherit, "codex").unwrap();
        fs::remove_dir_all(skills_dir(&p).join("termic")).unwrap();
        reconcile_customizations(&p, &w, CustomizationMode::Inherit, "codex").unwrap();
        assert!(w.join(".agents/skills/termic").symlink_metadata().is_err(), "Owned dangling link survived");
    }

    #[test]
    fn cleanup_preserves_user_retargeted_link_within_profile() {
        let dir = tempdir().unwrap();
        let p = dir.path().join("profile");
        let w = dir.path().join("wt");
        fs::create_dir_all(&w).unwrap();
        ensure_builtin_skills(&p).unwrap();
        reconcile_customizations(&p, &w, CustomizationMode::Inherit, "codex").unwrap();
        let other = skills_dir(&p).join("user-choice");
        fs::create_dir_all(&other).unwrap();
        let leaf = w.join(".agents/skills/termic");
        crate::fs_link::remove_link(&leaf).unwrap();
        crate::fs_link::symlink_any(&other, &leaf).unwrap();
        reconcile_customizations(&p, &w, CustomizationMode::None, "codex").unwrap();
        assert!(leaf.symlink_metadata().is_ok(), "Cleanup deleted user-retargeted profile symlink");
    }

    #[test]
    fn rendered_codex_agent_has_required_description() {
        let text = render_codex_agent_toml("reviewer", "---\nname: reviewer\ndescription: Reviews code\n---\nReview code.");
        assert!(text.lines().any(|l| l.starts_with("description =")), "Generated Codex definition omits required description");
    }

    #[test]
    fn user_edit_to_generated_agent_survives_repeated_reconcile() {
        let dir = tempdir().unwrap();
        let p = dir.path().join("profile");
        let w = dir.path().join("wt");
        fs::create_dir_all(&w).unwrap();
        ensure_builtin_skills(&p).unwrap();
        fs::write(agents_dir(&p).join("reviewer.md"), b"---\nname: reviewer\ndescription: Reviews code\n---\nReview code.").unwrap();
        reconcile_customizations(&p, &w, CustomizationMode::Inherit, "codex").unwrap();
        let f = w.join(".codex/agents/reviewer.toml");
        let edit = b"user-authored replacement\n";
        fs::write(&f, edit).unwrap();
        reconcile_customizations(&p, &w, CustomizationMode::Inherit, "codex").unwrap();
        assert_eq!(fs::read(&f).unwrap(), edit);
        reconcile_customizations(&p, &w, CustomizationMode::Inherit, "codex").unwrap();
        assert_eq!(fs::read(&f).unwrap(), edit, "second post-edit pass clobbered user content");
    }

    #[test]
    fn user_edit_to_generated_agent_is_not_adopted_for_deletion() {
        let dir = tempdir().unwrap();
        let p = dir.path().join("profile");
        let w = dir.path().join("wt");
        fs::create_dir_all(&w).unwrap();
        ensure_builtin_skills(&p).unwrap();
        fs::write(agents_dir(&p).join("reviewer.md"), b"---\nname: reviewer\ndescription: Reviews code\n---\nReview code.").unwrap();
        reconcile_customizations(&p, &w, CustomizationMode::Inherit, "codex").unwrap();
        let f = w.join(".codex/agents/reviewer.toml");
        let edit = b"user-authored replacement\n";
        fs::write(&f, edit).unwrap();
        reconcile_customizations(&p, &w, CustomizationMode::Inherit, "codex").unwrap();
        reconcile_customizations(&p, &w, CustomizationMode::None, "codex").unwrap();
        assert_eq!(fs::read(&f).ok().as_deref(), Some(edit.as_slice()), "cleanup deleted user-modified file after adopting its hash");
    }

    #[test]
    fn mcp_url_query_credential_is_never_exported() {
        let raw = br#"{"mcpServers":{"example":{"url":"https://example.com/mcp?api_key=SYNTHETIC_URL_CREDENTIAL"}}}"#;
        match sanitize_mcp_json_bytes(raw) {
            Ok(bytes) => assert!(!String::from_utf8_lossy(&bytes).contains("SYNTHETIC_URL_CREDENTIAL"), "URL query credential survived sanitization"),
            Err(_) => {},
        }
    }

    #[test]
    fn codex_mcp_preserves_preexisting_project_server() {
        let dir = tempdir().unwrap();
        let p = dir.path().join("profile");
        let w = dir.path().join("wt");
        fs::create_dir_all(&w).unwrap();
        ensure_builtin_skills(&p).unwrap();
        fs::write(mcp_json_file(&p), br#"{"mcpServers":{"shared":{"command":"profile-command"}}}"#).unwrap();
        fs::create_dir_all(w.join(".codex")).unwrap();
        let f = w.join(".codex/config.toml");
        fs::write(&f, "model = \"project-model\"\n[mcp_servers.shared]\ncommand = \"project-command\"\n").unwrap();
        reconcile_customizations(&p, &w, CustomizationMode::Inherit, "codex").unwrap();
        assert!(fs::read_to_string(&f).unwrap().contains("project-command"), "profile adapter overwrote existing project server");
    }

    #[test]
    fn codex_mcp_preserves_invalid_project_config() {
        let dir = tempdir().unwrap();
        let p = dir.path().join("profile");
        let w = dir.path().join("wt");
        fs::create_dir_all(&w).unwrap();
        ensure_builtin_skills(&p).unwrap();
        fs::write(mcp_json_file(&p), br#"{"mcpServers":{"shared":{"command":"profile-command"}}}"#).unwrap();
        fs::create_dir_all(w.join(".codex")).unwrap();
        let f = w.join(".codex/config.toml");
        let original = b"model = [\n";
        fs::write(&f, original).unwrap();
        reconcile_customizations(&p, &w, CustomizationMode::Inherit, "codex").unwrap();
        assert_eq!(fs::read(&f).unwrap(), original, "invalid config replaced with newly generated MCP config");
    }

    #[test]
    fn disabling_mcp_preserves_user_edited_server() {
        let dir = tempdir().unwrap();
        let p = dir.path().join("profile");
        let w = dir.path().join("wt");
        fs::create_dir_all(&w).unwrap();
        ensure_builtin_skills(&p).unwrap();
        fs::write(mcp_json_file(&p), br#"{"mcpServers":{"shared":{"command":"profile-command"}}}"#).unwrap();
        reconcile_customizations(&p, &w, CustomizationMode::Inherit, "codex").unwrap();
        let f = w.join(".codex/config.toml");
        fs::write(&f, "[mcp_servers.shared]\ncommand = \"user-edited-command\"\n").unwrap();
        reconcile_customizations(&p, &w, CustomizationMode::None, "codex").unwrap();
        assert!(fs::read_to_string(&f).unwrap().contains("user-edited-command"), "cleanup deleted user-edited MCP server by name");
    }

    #[test]
    fn switching_agent_tabs_keeps_other_vendor_artifacts() {
        let dir = tempdir().unwrap();
        let p = dir.path().join("profile");
        let w = dir.path().join("wt");
        fs::create_dir_all(&w).unwrap();
        ensure_builtin_skills(&p).unwrap();
        fs::write(mcp_json_file(&p), br#"{"mcpServers":{"shared":{"command":"profile-command"}}}"#).unwrap();
        fs::write(agents_dir(&p).join("reviewer.md"), "---\nname: reviewer\ndescription: Reviews code\n---\nReview code.\n").unwrap();
        reconcile_customizations(&p, &w, CustomizationMode::Inherit, "codex").unwrap();
        assert!(w.join(".codex/agents/reviewer.toml").exists());
        reconcile_customizations(&p, &w, CustomizationMode::Inherit, "claude").unwrap();
        assert!(w.join(".codex/agents/reviewer.toml").exists(), "opening Claude tab deleted Codex agents in shared task");
    }

    #[test]
    fn codex_mcp_retains_required_auth_configuration() {
        let dir = tempdir().unwrap();
        let p = dir.path().join("profile");
        let w = dir.path().join("wt");
        fs::create_dir_all(&w).unwrap();
        ensure_builtin_skills(&p).unwrap();
        fs::write(mcp_json_file(&p), br#"{"mcpServers":{"remote":{"url":"https://example.com/mcp","headers":{"Authorization":"${AUTHORIZATION}"}}}}"#).unwrap();
        reconcile_customizations(&p, &w, CustomizationMode::Inherit, "codex").unwrap();
        let cfg = fs::read_to_string(w.join(".codex/config.toml")).unwrap();
        assert!(cfg.contains("AUTHORIZATION") || cfg.contains("Authorization"), "adapter silently dropped HTTP server authentication");
    }

    #[test]
    fn claude_persona_preserves_explicit_tool_restrictions() {
        let source = "---\nname: reviewer\ndescription: Read-only review\ntools: Read, Grep\n---\nReview code.\n";
        let rendered = render_claude_agent_md("reviewer", source);
        assert!(rendered.contains("tools: Read, Grep"), "Claude adapter removed tool allowlist");
    }

    #[test]
    fn codex_http_header_variable_uses_native_environment_binding() {
        let dir = tempdir().unwrap();
        let p = dir.path().join("profile");
        let w = dir.path().join("wt");
        fs::create_dir_all(&w).unwrap();
        ensure_builtin_skills(&p).unwrap();
        fs::write(
            mcp_json_file(&p),
            br#"{"mcpServers":{"remote":{"url":"https://example.com/mcp","headers":{"Authorization":"${AUTHORIZATION}"}}}}"#,
        )
        .unwrap();
        reconcile_customizations(&p, &w, CustomizationMode::Inherit, "codex").unwrap();
        let content = fs::read_to_string(w.join(".codex/config.toml")).unwrap();
        let cfg: toml_edit::DocumentMut = content.parse().unwrap();
        let server = &cfg["mcp_servers"]["remote"];
        let binding = server
            .get("env_http_headers")
            .and_then(|h| h.get("Authorization"))
            .and_then(|v| v.as_str());
        assert_eq!(
            binding,
            Some("AUTHORIZATION"),
            "JSON header variable became a static literal instead of a native environment binding"
        );
    }

    #[test]
    fn http_headers_are_sanitized_on_export() {
        let t = tempdir().unwrap();
        let p = t.path().join("profile");
        ensure_builtin_skills(&p).unwrap();
        fs::write(
            mcp_json_file(&p),
            br#"{"mcpServers":{"example":{"url":"https://acme.com/mcp","http_headers":{"Authorization":"Bearer SYNTHETIC_CREDENTIAL"}}}}"#,
        )
        .unwrap();
        let clone = t.path().join("clone");
        export_customizations(&clone, &p, "test").unwrap();
        let output = fs::read_to_string(clone.join("profiles/test/customizations/mcp/mcp.json")).unwrap();
        assert!(!output.contains("SYNTHETIC_CREDENTIAL"), "raw credential exported: {output}");
    }

    #[test]
    fn deleted_profile_mcp_cleans_native_server() {
        let t = tempdir().unwrap();
        let p = t.path().join("profile");
        let w = t.path().join("wt");
        fs::create_dir_all(&w).unwrap();
        ensure_builtin_skills(&p).unwrap();
        fs::write(mcp_json_file(&p), br#"{"mcpServers":{"example":{"command":"example-server"}}}"#).unwrap();
        reconcile_customizations(&p, &w, CustomizationMode::Inherit, "codex").unwrap();
        fs::remove_file(mcp_json_file(&p)).unwrap();
        reconcile_customizations(&p, &w, CustomizationMode::Inherit, "codex").unwrap();
        let output = fs::read_to_string(w.join(".codex/config.toml")).unwrap();
        assert!(!output.contains("example-server"), "deleted MCP server retained: {output}");
    }

    #[test]
    fn stdio_env_references_use_native_binding() {
        let t = tempdir().unwrap();
        let p = t.path().join("profile");
        let w = t.path().join("wt");
        fs::create_dir_all(&w).unwrap();
        ensure_builtin_skills(&p).unwrap();
        fs::write(
            mcp_json_file(&p),
            br#"{"mcpServers":{"example":{"command":"example-server","env":{"API_KEY":"${API_KEY}"}}}}"#,
        )
        .unwrap();
        reconcile_customizations(&p, &w, CustomizationMode::Inherit, "codex").unwrap();
        let output = fs::read_to_string(w.join(".codex/config.toml")).unwrap();
        assert!(!output.contains("${API_KEY}"), "literal placeholder emitted: {output}");
    }

    #[test]
    fn removing_customizations_root_prunes_export() {
        let t = tempdir().unwrap();
        let p = t.path().join("profile");
        ensure_builtin_skills(&p).unwrap();
        let clone = t.path().join("clone");
        export_customizations(&clone, &p, "test").unwrap();
        fs::remove_dir_all(customizations_dir(&p)).unwrap();
        export_customizations(&clone, &p, "test").unwrap();
        assert!(
            !clone.join("profiles/test/customizations/skills/termic/SKILL.md").exists(),
            "removed profile customizations still exported"
        );
    }

    #[test]
    fn failed_destination_unlink_cannot_write_external_file() {
        #[cfg(unix)]
        use std::os::unix::fs::PermissionsExt;
        let t = tempdir().unwrap();
        let p = t.path().join("profile");
        fs::create_dir_all(skills_dir(&p)).unwrap();
        fs::write(skills_dir(&p).join("note.md"), b"generated bytes").unwrap();
        let clone = t.path().join("clone");
        let parent = clone.join("profiles/test/customizations/skills");
        fs::create_dir_all(&parent).unwrap();
        let outside = t.path().join("outside.txt");
        fs::write(&outside, b"keep external bytes").unwrap();
        crate::fs_link::symlink_any(&outside, &parent.join("note.md")).unwrap();
        #[cfg(unix)]
        fs::set_permissions(&parent, fs::Permissions::from_mode(0o555)).unwrap();
        let result = export_customizations(&clone, &p, "test");
        #[cfg(unix)]
        fs::set_permissions(&parent, fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(
            fs::read(&outside).unwrap(),
            b"keep external bytes",
            "external file overwritten after unlink failure; result={result:?}"
        );
    }

    #[test]
    fn generated_excludes_do_not_hide_project_skills() {
        let t = tempdir().unwrap();
        let p = t.path().join("profile");
        let w = t.path().join("wt");
        fs::create_dir_all(&w).unwrap();
        ensure_builtin_skills(&p).unwrap();
        assert!(std::process::Command::new("git")
            .args(["init", "-q"])
            .current_dir(&w)
            .status()
            .unwrap()
            .success());
        reconcile_customizations(&p, &w, CustomizationMode::Inherit, "codex").unwrap();
        fs::create_dir_all(w.join(".agents/skills/project-owned")).unwrap();
        fs::write(w.join(".agents/skills/project-owned/SKILL.md"), b"Project skill").unwrap();
        let output = std::process::Command::new("git")
            .args(["-c", "core.excludesFile=/dev/null", "status", "--porcelain", "--untracked-files=all"])
            .current_dir(&w)
            .output()
            .unwrap();
        assert!(
            String::from_utf8_lossy(&output.stdout).contains("project-owned"),
            "project skill hidden by Termic excludes"
        );
    }

    #[test]
    fn renamed_stdio_binding_keeps_destination_variable() {
        let t = tempdir().unwrap();
        let p = t.path().join("profile");
        let w = t.path().join("wt");
        fs::create_dir_all(&w).unwrap();
        ensure_builtin_skills(&p).unwrap();
        fs::write(
            mcp_json_file(&p),
            br#"{"mcpServers":{"example":{"command":"example-server","env":{"API_KEY":"${SERVICE_API_KEY}"}}}}"#,
        )
        .unwrap();
        fs::write(mcp_env_file(&p), b"SERVICE_API_KEY=synthetic-value").unwrap();
        reconcile_customizations(&p, &w, CustomizationMode::Inherit, "codex").unwrap();
        let output = fs::read_to_string(w.join(".codex/config.toml")).unwrap();
        let doc = output.parse::<toml_edit::DocumentMut>().unwrap();
        let server = &doc["mcp_servers"]["example"];
        let literal = server
            .get("env")
            .and_then(|v| v.as_inline_table())
            .and_then(|v| v.get("API_KEY"))
            .is_some();
        let forwarded = server
            .get("env_vars")
            .and_then(|v| v.as_array())
            .map(|v| v.iter().any(|v| v.as_str() == Some("API_KEY")))
            .unwrap_or(false);
        assert!(literal || forwarded, "destination API_KEY lost: {output}");
    }

    #[test]
    fn env_http_headers_preserve_existing_environment_binding() {
        let input = br#"{"mcpServers":{"example":{"url":"https://acme.com/mcp","env_http_headers":{"Authorization":"SERVICE_AUTH_HEADER"}}}}"#;
        let out = sanitize_mcp_json_bytes(input).unwrap();
        let doc: serde_json::Value = serde_json::from_slice(&out).unwrap();
        assert_eq!(
            doc["mcpServers"]["example"]["env_http_headers"]["Authorization"],
            "SERVICE_AUTH_HEADER",
            "environment name was rewritten"
        );
    }

    #[test]
    fn export_removes_directory_links_without_touching_their_targets() {
        let t = tempdir().unwrap();
        let p = t.path().join("profile");
        fs::create_dir_all(skills_dir(&p)).unwrap();
        fs::write(skills_dir(&p).join("note.md"), "Profile skill").unwrap();
        let clone = t.path().join("clone");
        let dst = clone.join("profiles/test/customizations");
        fs::create_dir_all(dst.parent().unwrap()).unwrap();
        let outside = t.path().join("outside");
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("keep.md"), "External file").unwrap();
        crate::fs_link::symlink_any(&outside, &dst).unwrap();
        export_customizations(&clone, &p, "test").unwrap();
        assert!(!dst.symlink_metadata().unwrap().file_type().is_symlink());
        let leaf = dst.join("skills/note.md");
        fs::remove_file(&leaf).unwrap();
        crate::fs_link::symlink_any(&outside, &leaf).unwrap();
        let stale = dst.join("stale-link");
        crate::fs_link::symlink_any(&outside, &stale).unwrap();
        let missing = t.path().join("deleted-target");
        fs::create_dir(&missing).unwrap();
        let dangling = dst.join("dangling-link");
        crate::fs_link::symlink_any(&missing, &dangling).unwrap();
        fs::remove_dir(&missing).unwrap();
        export_customizations(&clone, &p, "test").unwrap();
        assert_eq!(fs::read_to_string(&leaf).unwrap(), "Profile skill");
        assert!(stale.symlink_metadata().is_err());
        assert!(dangling.symlink_metadata().is_err());
        assert_eq!(fs::read_to_string(outside.join("keep.md")).unwrap(), "External file");
        assert_eq!(fs::read_dir(&outside).unwrap().count(), 1);
    }

    #[test]
    fn pruning_error_must_not_report_success() {
        #[cfg(unix)]
        use std::os::unix::fs::PermissionsExt;
        let t = tempdir().unwrap();
        let p = t.path().join("profile");
        let clone = t.path().join("clone");
        let stale_dir = clone.join("profiles/test/customizations/skills");
        fs::create_dir_all(&stale_dir).unwrap();
        fs::write(stale_dir.join("old.md"), b"stale skill").unwrap();
        #[cfg(unix)]
        fs::set_permissions(&stale_dir, fs::Permissions::from_mode(0o555)).unwrap();
        // Windows deletion permissions belong to ACLs, not Unix mode bits.
        // An open handle without FILE_SHARE_DELETE makes removal fail there.
        #[cfg(windows)]
        let locked = {
            use std::os::windows::fs::OpenOptionsExt;
            fs::OpenOptions::new().read(true).share_mode(0)
                .open(stale_dir.join("old.md")).unwrap()
        };
        let outcome = export_customizations(&clone, &p, "test");
        #[cfg(unix)]
        fs::set_permissions(&stale_dir, fs::Permissions::from_mode(0o755)).unwrap();
        #[cfg(windows)]
        drop(locked);
        assert!(
            outcome.is_err(),
            "export returned success despite failed removal; stale file exists: {}",
            stale_dir.join("old.md").exists()
        );
        assert!(stale_dir.join("old.md").exists(), "failed removal lost the stale file");
        export_customizations(&clone, &p, "test").unwrap();
        assert!(!stale_dir.join("old.md").exists(), "retry did not remove the stale file");
    }

    #[test]
    fn conflicting_credential_aliases_fail_closed_to_prevent_disclosure() {
        let t = tempdir().unwrap();
        let p = t.path().join("profile");
        ensure_builtin_skills(&p).unwrap();
        fs::write(
            mcp_env_file(&p),
            b"SERVICE_A_KEY=synthetic-service-a\nSERVICE_B_KEY=synthetic-service-b\n",
        )
        .unwrap();
        fs::write(
            mcp_json_file(&p),
            br#"{"mcpServers":{"service_a":{"command":"service-a","env":{"API_KEY":"${SERVICE_A_KEY}"}},"service_b":{"command":"service-b","env":{"API_KEY":"${SERVICE_B_KEY}"}}}}"#,
        )
        .unwrap();
        let env = read_mcp_env(&p);
        assert_eq!(env.get("SERVICE_A_KEY").map(String::as_str), Some("synthetic-service-a"));
        assert_eq!(env.get("SERVICE_B_KEY").map(String::as_str), Some("synthetic-service-b"));
        assert_eq!(env.get("API_KEY"), None, "conflicting destination key leaked to shared environment");
    }

    #[test]
    fn existing_destination_does_not_bypass_conflict_rejection() {
        let t = tempdir().unwrap();
        let p = t.path().join("profile");
        ensure_builtin_skills(&p).unwrap();
        fs::write(
            mcp_env_file(&p),
            b"SERVICE_A_KEY=synthetic-a\nSERVICE_B_KEY=synthetic-b\nAPI_KEY=synthetic-a\n",
        )
        .unwrap();
        fs::write(
            mcp_json_file(&p),
            br#"{"mcpServers":{"service_a":{"command":"service-a","env":{"API_KEY":"${SERVICE_A_KEY}"}},"service_b":{"command":"service-b","env":{"API_KEY":"${SERVICE_B_KEY}"}}}}"#,
        )
        .unwrap();
        assert!(!read_mcp_env(&p).contains_key("API_KEY"));
    }

    #[test]
    fn unresolved_source_does_not_receive_another_servers_secret() {
        let t = tempdir().unwrap();
        let p = t.path().join("profile");
        ensure_builtin_skills(&p).unwrap();
        fs::write(mcp_env_file(&p), b"SERVICE_A_KEY=synthetic-a\n").unwrap();
        fs::write(
            mcp_json_file(&p),
            br#"{"mcpServers":{"service_a":{"command":"service-a","env":{"API_KEY":"${SERVICE_A_KEY}"}},"service_b":{"command":"service-b","env":{"API_KEY":"${SERVICE_B_KEY}"}}}}"#,
        )
        .unwrap();
        assert!(!read_mcp_env(&p).contains_key("API_KEY"));
    }

    #[test]
    fn inherited_destination_is_not_forwarded_after_conflict_detection() {
        let t = tempdir().unwrap();
        let p = t.path().join("profile");
        ensure_builtin_skills(&p).unwrap();
        fs::write(
            mcp_env_file(&p),
            b"SERVICE_A_KEY=synthetic-a\nSERVICE_B_KEY=synthetic-b\n",
        )
        .unwrap();
        fs::write(
            mcp_json_file(&p),
            br#"{"mcpServers":{"service_a":{"command":"service-a","env":{"API_KEY":"${SERVICE_A_KEY}"}},"service_b":{"command":"service-b","env":{"API_KEY":"${SERVICE_B_KEY}"}}}}"#,
        )
        .unwrap();
        let w = t.path().join("wt");
        fs::create_dir_all(&w).unwrap();
        reconcile_customizations(&p, &w, CustomizationMode::Inherit, "codex").unwrap();
        let doc = fs::read_to_string(w.join(".codex/config.toml"))
            .unwrap()
            .parse::<toml_edit::DocumentMut>()
            .unwrap();
        let server = &doc["mcp_servers"]["service_b"];
        let enabled = server.get("enabled").and_then(|i| i.as_bool()).unwrap_or(true);
        let forwards = server
            .get("env_vars")
            .and_then(|v| v.as_array())
            .map(|v| v.iter().any(|v| v.as_str() == Some("API_KEY")))
            .unwrap_or(false);
        assert!(!enabled, "conflicting server should be disabled");
        assert!(!forwards, "conflicting server should not forward API_KEY");
    }

    #[test]
    fn distinct_literal_environment_values_remain_server_scoped() {
        let t = tempdir().unwrap();
        let p = t.path().join("profile");
        let w = t.path().join("wt");
        fs::create_dir_all(&w).unwrap();
        ensure_builtin_skills(&p).unwrap();
        fs::write(
            mcp_json_file(&p),
            br#"{"mcpServers":{"service_a":{"command":"service-a","env":{"LOG_LEVEL":"info"}},"service_b":{"command":"service-b","env":{"LOG_LEVEL":"debug"}}}}"#,
        )
        .unwrap();
        reconcile_customizations(&p, &w, CustomizationMode::Inherit, "codex").unwrap();
        let output = fs::read_to_string(w.join(".codex/config.toml")).unwrap();
        let doc = output.parse::<toml_edit::DocumentMut>().unwrap();
        for (name, expected) in [("service_a", "info"), ("service_b", "debug")] {
            let server = &doc["mcp_servers"][name];
            assert!(
                server.get("enabled").and_then(|v| v.as_bool()).unwrap_or(true),
                "valid literal environment disables {name}: {output}"
            );
            assert_eq!(
                server["env"]
                    .as_inline_table()
                    .unwrap()
                    .get("LOG_LEVEL")
                    .and_then(|v| v.as_str()),
                Some(expected)
            );
        }
    }

    #[test]
    fn conflicting_aliases_do_not_disable_literal_only_server() {
        let t = tempdir().unwrap();
        let p = t.path().join("profile");
        let w = t.path().join("wt");
        fs::create_dir_all(&w).unwrap();
        ensure_builtin_skills(&p).unwrap();
        fs::write(
            mcp_json_file(&p),
            serde_json::to_vec(&serde_json::json!({
                "mcpServers": {
                    "service_a": {
                        "command": "service-a",
                        "env": { "API_KEY": "${SERVICE_A_KEY}" }
                    },
                    "service_b": {
                        "command": "service-b",
                        "env": { "API_KEY": "${SERVICE_B_KEY}" }
                    },
                    "service_c": {
                        "command": "service-c",
                        "env": { "API_KEY": "synthetic-literal-c" }
                    }
                }
            }))
            .unwrap(),
        )
        .unwrap();

        for _ in 0..2 {
            reconcile_customizations(&p, &w, CustomizationMode::Inherit, "codex").unwrap();
            let doc = fs::read_to_string(w.join(".codex/config.toml"))
                .unwrap()
                .parse::<toml_edit::DocumentMut>()
                .unwrap();
            for name in ["service_a", "service_b"] {
                let server = &doc["mcp_servers"][name];
                assert_eq!(server["enabled"].as_bool(), Some(false));
                assert!(server.get("env_vars").is_none());
            }
            let literal = &doc["mcp_servers"]["service_c"];
            assert!(literal.get("enabled").and_then(|v| v.as_bool()).unwrap_or(true));
            assert_eq!(
                literal["env"]
                    .as_inline_table()
                    .unwrap()
                    .get("API_KEY")
                    .and_then(|v| v.as_str()),
                Some("synthetic-literal-c")
            );
        }
    }
}
