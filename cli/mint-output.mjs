export function formatMintGrant(grant, { json = false } = {}) {
  if (!json) return `${grant.token}\n`;
  return `${JSON.stringify({
    schema_version: 1,
    token: grant.token,
    expires_at: grant.expires_at,
    installation_id: grant.installation_id,
  })}\n`;
}
