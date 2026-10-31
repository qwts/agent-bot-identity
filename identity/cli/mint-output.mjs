export function formatMintGrant(grant, { json = false } = {}) {
  if (!json) return `${grant.token}\n`;
  return `${JSON.stringify({
    schema_version: 1,
    token: grant.token,
    expires_at: grant.expires_at,
    installation_id: grant.installation_id,
  })}\n`;
}

export function formatMemberReference(grant, { approvalRequired = false, bound = false, soulBound = false, ambient = false } = {}) {
  const ref = grant?.credential_ref ?? grant?.issuance_id ?? null;
  if (approvalRequired || !ref || !(bound || soulBound || ambient)) return null;
  return `${JSON.stringify({
    schema_version: 1,
    credential_ref: ref,
    task_id: grant.task_id ?? null,
    operation_id: grant.operation_id ?? null,
    expires_at: grant.expires_at,
  })}\n`;
}
