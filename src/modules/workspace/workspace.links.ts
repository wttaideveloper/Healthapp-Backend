/**
 * Customer-facing link to the HealthAge Admin / Workspace Admin portal.
 *
 * Every workspace invitation, organization welcome and Shopify owner-welcome
 * email tells the recipient to visit this address. It is defined once, here, so
 * the several copies of the invite template cannot drift apart again.
 *
 * Pure on purpose: no env, no SMTP, nothing to set up before importing it.
 *
 * (Replaces the retired Vercel address for the old workspace-admin page.)
 */
export const WORKSPACE_ADMIN_URL = "https://healthage.healthexporesources.com/";
