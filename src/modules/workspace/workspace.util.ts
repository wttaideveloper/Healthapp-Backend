export const workspaceRoles = ["owner", "admin", "member"] as const;
export const workspaceMemberStatuses = ["invited", "active", "revoked"] as const;
export const workspaceStatuses = ["active", "suspended", "revoked"] as const;
export const workspaceSubscriptionStatuses = ["active", "trialing", "past_due", "expired", "canceled"] as const;

export type WorkspaceRole = (typeof workspaceRoles)[number];
export type WorkspaceMemberStatus = (typeof workspaceMemberStatuses)[number];
export type WorkspaceStatus = (typeof workspaceStatuses)[number];
export type WorkspaceSubscriptionStatus = (typeof workspaceSubscriptionStatuses)[number];

export function normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
}

export function isWorkspaceAccessActive(input: {
    workspaceStatus: string;
    subscriptionStatus: string;
    expiresAt: Date | null;
}): boolean {
    // Past-due/canceled workspaces remain visible to admins, but they should not unlock Pro access.
    const activeSubscriptionStatuses = new Set(["active", "trialing"]);
    if (input.workspaceStatus !== "active") return false;
    if (!activeSubscriptionStatuses.has(input.subscriptionStatus)) return false;
    if (!input.expiresAt) return true;
    return input.expiresAt.getTime() > Date.now();
}
