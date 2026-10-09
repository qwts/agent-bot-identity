//! The identifiers keyd accepts, checked exactly as agent-bot checks them, so
//! a value that names a Keychain item can never carry a separator or a path.

/// `agent_<uuid v1-8>`, lowercase, as agent-identity.mjs's ID_PATTERN.
pub fn is_agent_id(value: &str) -> bool {
    let Some(uuid) = value.strip_prefix("agent_") else {
        return false;
    };
    let groups: Vec<&str> = uuid.split('-').collect();
    let lengths = [8, 4, 4, 4, 12];
    if groups.len() != 5 {
        return false;
    }
    for (group, length) in groups.iter().zip(lengths) {
        if group.len() != length
            || !group
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return false;
        }
    }
    matches!(groups[2].as_bytes()[0], b'1'..=b'8')
        && matches!(groups[3].as_bytes()[0], b'8' | b'9' | b'a' | b'b')
}

/// A GitHub App slug, as soul-credentials.mjs's APP_SLUG.
pub fn is_app_slug(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.is_empty() || bytes.len() > 64 {
        return false;
    }
    let edge = |b: u8| b.is_ascii_alphanumeric();
    edge(bytes[0])
        && edge(bytes[bytes.len() - 1])
        && bytes
            .iter()
            .all(|&b| b.is_ascii_alphanumeric() || b == b'-')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_ids_match_agent_bot() {
        assert!(is_agent_id("agent_ea588a53-c6ce-430b-9d71-89897d843ab6"));
        assert!(!is_agent_id("agent_ea588a53-c6ce-930b-9d71-89897d843ab6"));
        assert!(!is_agent_id("agent_EA588A53-c6ce-430b-9d71-89897d843ab6"));
        assert!(!is_agent_id("agent_ea588a53-c6ce-430b-9d71-89897d843ab6/x"));
        assert!(!is_agent_id("ea588a53-c6ce-430b-9d71-89897d843ab6"));
    }

    #[test]
    fn app_slugs_match_agent_bot() {
        assert!(is_app_slug("qwts-claude-agent"));
        assert!(is_app_slug("a"));
        assert!(!is_app_slug("-lead"));
        assert!(!is_app_slug("trail-"));
        assert!(!is_app_slug("has space"));
        assert!(!is_app_slug("dot.slug"));
        assert!(!is_app_slug(&"a".repeat(65)));
    }
}
