// Human-approver gate for the review queue (#45). The name requirement
// is deliberate (audit trail records a named approver; the API enforces
// the same 3+ rule) — this module exists so the page can always say
// *why* Approve is locked and *who* an approval will be recorded as.

export function approverNameValid(name: string): boolean {
  return name.trim().length >= 3;
}

export function approveHint(name: string): string {
  return approverNameValid(name)
    ? `Approving as ${name.trim()}.`
    : "Type your name above (at least 3 characters) to enable the Approve buttons — approvals are recorded under that name.";
}

export function approveDisabled(name: string, busyId: string | null, proposalId: string): boolean {
  return busyId === proposalId || !approverNameValid(name);
}
