/**
 * Test-only: gives the tests a recognisable fake SMTP password, so they can prove it never reaches a log line.
 * Import it BEFORE `./shopify.test-env` (which only fills variables that are still unset). Not a real credential.
 */
export const FAKE_SMTP_PASSWORD = "Sup3r-Secret-Test-Only-Smtp-Pass";
process.env.SMTP_PASS = FAKE_SMTP_PASSWORD;
