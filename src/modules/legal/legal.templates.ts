type LegalSection = {
    heading: string;
    paragraphs: string[];
};

type LegalPageOptions = {
    title: string;
    sections: LegalSection[];
    disclaimer?: string;
    contactEmail?: string;
    contactLabel?: string;
};

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function renderSections(sections: LegalSection[]): string {
    return sections
        .map(
            (section) => `
        <section>
          <h2>${escapeHtml(section.heading)}</h2>
          ${section.paragraphs.map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`).join("\n          ")}
        </section>`
        )
        .join("\n");
}

export function renderLegalPage(options: LegalPageOptions): string {
    const contactEmail = options.contactEmail ?? "support@healthexporesources.com";
    const contactLabel = options.contactLabel ?? "Health Age Support";

    const disclaimerBlock = options.disclaimer
        ? `
        <aside class="disclaimer" role="note">
          <p>${escapeHtml(options.disclaimer)}</p>
        </aside>`
        : "";

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(options.title)}</title>
  <style>
    :root {
      color-scheme: light;
      --text: #1a1a1a;
      --muted: #5c5c5c;
      --border: #e8e8e8;
      --accent: #0f766e;
      --disclaimer-bg: #f0fdfa;
      --disclaimer-border: #99f6e4;
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      font-family: Georgia, "Times New Roman", serif;
      font-size: 1.05rem;
      line-height: 1.7;
      color: var(--text);
      background: #ffffff;
    }

    .page {
      max-width: 760px;
      margin: 0 auto;
      padding: 2.5rem 1.25rem 3rem;
    }

    header {
      margin-bottom: 2rem;
      padding-bottom: 1.5rem;
      border-bottom: 1px solid var(--border);
    }

    .brand {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      font-size: 0.875rem;
      font-weight: 600;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--accent);
      margin: 0 0 0.75rem;
    }

    h1 {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      font-size: clamp(1.75rem, 4vw, 2.25rem);
      line-height: 1.2;
      margin: 0;
      font-weight: 700;
    }

    .updated {
      margin: 0.75rem 0 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      font-size: 0.95rem;
      color: var(--muted);
    }

    main section {
      margin-bottom: 1.75rem;
    }

    h2 {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      font-size: 1.2rem;
      margin: 0 0 0.75rem;
      font-weight: 600;
    }

    p {
      margin: 0 0 1rem;
    }

    p:last-child {
      margin-bottom: 0;
    }

    .disclaimer {
      margin: 0 0 2rem;
      padding: 1rem 1.1rem;
      background: var(--disclaimer-bg);
      border: 1px solid var(--disclaimer-border);
      border-radius: 10px;
    }

    .disclaimer p {
      margin: 0;
      font-weight: 600;
      color: #134e4a;
    }

    .contact {
      margin-top: 0.5rem;
    }

    .contact strong {
      display: block;
      margin-bottom: 0.35rem;
    }

    a {
      color: var(--accent);
      text-decoration: none;
    }

    a:hover {
      text-decoration: underline;
    }

    footer {
      margin-top: 2.5rem;
      padding-top: 1.25rem;
      border-top: 1px solid var(--border);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      font-size: 0.9rem;
      color: var(--muted);
      text-align: center;
    }

    @media (max-width: 600px) {
      .page {
        padding: 1.75rem 1rem 2.5rem;
      }
    }
  </style>
</head>
<body>
  <div class="page">
    <header>
      <p class="brand">Health Age</p>
      <h1>${escapeHtml(options.title)}</h1>
      <p class="updated">Last updated: July 9, 2026</p>
    </header>
    ${disclaimerBlock}
    <main>
      ${renderSections(options.sections)}
      <section>
        <h2>Contact Us</h2>
        <div class="contact">
          <strong>${escapeHtml(contactLabel)}</strong>
          <p><a href="mailto:${escapeHtml(contactEmail)}">${escapeHtml(contactEmail)}</a></p>
        </div>
      </section>
    </main>
    <footer>© Health Age</footer>
  </div>
</body>
</html>`;
}

const HEALTH_DISCLAIMER =
    "Health Age is intended for informational and educational purposes only. It is not a medical diagnosis and should not be used as a substitute for professional medical advice, diagnosis, or treatment. Always consult a qualified healthcare professional before making medical decisions.";

export const privacyPageHtml = renderLegalPage({
    title: "Health Age Privacy Policy",
    sections: [
        {
            heading: "Introduction",
            paragraphs: [
                "Health Age (\"we,\" \"our,\" or \"us\") respects your privacy. This Privacy Policy explains how we collect, use, disclose, and safeguard information when you use the Health Age mobile application, website, and related services.",
                "By using Health Age, you agree to the collection and use of information in accordance with this policy.",
            ],
        },
        {
            heading: "Information We Collect",
            paragraphs: [
                "We may collect information you provide directly, such as your name, email address, account credentials, and workspace membership details.",
                "We may also collect usage information, device identifiers, app version, operating system, and diagnostic logs needed to operate and improve the service.",
                "If you contact support, we collect the information you choose to provide in your message.",
            ],
        },
        {
            heading: "How We Use Information",
            paragraphs: [
                "We use collected information to create and manage your account, authenticate users, provide app features, process subscriptions, send service-related communications, and respond to support requests.",
                "We may use aggregated or de-identified data to analyze performance, improve reliability, and enhance the user experience.",
            ],
        },
        {
            heading: "Subscription Information",
            paragraphs: [
                "Subscription and billing information may be processed by third-party providers such as Apple, Google, Stripe, or RevenueCat, depending on how you purchase access.",
                "We receive subscription status, product identifiers, renewal information, and related metadata needed to determine whether your account has active access. We do not store full payment card numbers on our servers.",
            ],
        },
        {
            heading: "Data Security",
            paragraphs: [
                "We implement reasonable administrative, technical, and organizational safeguards designed to protect your information against unauthorized access, alteration, disclosure, or destruction.",
                "No method of transmission or storage is completely secure, and we cannot guarantee absolute security.",
            ],
        },
        {
            heading: "Third Party Services",
            paragraphs: [
                "Health Age may rely on third-party services for authentication, hosting, analytics, email delivery, payment processing, and subscription management.",
                "These providers process information according to their own privacy policies and only to the extent necessary to provide their services to us.",
            ],
        },
        {
            heading: "Children's Privacy",
            paragraphs: [
                "Health Age is not directed to children under 13, and we do not knowingly collect personal information from children under 13.",
                "If you believe a child has provided us with personal information, please contact us so we can take appropriate action.",
            ],
        },
        {
            heading: "Changes to this Policy",
            paragraphs: [
                "We may update this Privacy Policy from time to time. When we do, we will revise the \"Last updated\" date at the top of this page.",
                "Your continued use of Health Age after changes become effective constitutes acceptance of the updated policy.",
            ],
        },
    ],
});

export const termsPageHtml = renderLegalPage({
    title: "Health Age Terms of Use",
    disclaimer: HEALTH_DISCLAIMER,
    contactLabel: "Health Age Support",
    sections: [
        {
            heading: "Acceptance of Terms",
            paragraphs: [
                "These Terms of Use govern your access to and use of Health Age. By creating an account, downloading, or using the service, you agree to these terms.",
                "If you do not agree, do not use Health Age.",
            ],
        },
        {
            heading: "Health Disclaimer",
            paragraphs: [
                "Health Age provides general health-related information and educational content. It does not provide medical advice, diagnosis, or treatment.",
                "You are solely responsible for how you use information presented in the app. Never disregard professional medical advice or delay seeking it because of something you read or view in Health Age.",
            ],
        },
        {
            heading: "Subscription Terms",
            paragraphs: [
                "Some features require a paid subscription. Subscriptions may be purchased through Apple App Store, Google Play, Stripe, or organization workspace access, depending on your platform and account type.",
                "Billing, renewal, cancellation, and refund rules are governed by the platform or payment provider through which you subscribed, in addition to these Terms.",
                "We may change subscription pricing or features with notice where required by applicable law or platform policies.",
            ],
        },
        {
            heading: "User Responsibilities",
            paragraphs: [
                "You agree to provide accurate account information, keep your credentials secure, and use Health Age only for lawful purposes.",
                "You may not attempt to interfere with the service, reverse engineer the app except where permitted by law, or misuse workspace or subscription access.",
            ],
        },
        {
            heading: "Intellectual Property",
            paragraphs: [
                "Health Age, including its software, branding, content, and design, is owned by us or our licensors and is protected by applicable intellectual property laws.",
                "These Terms do not grant you any right to copy, modify, distribute, or create derivative works from Health Age except as expressly permitted.",
            ],
        },
        {
            heading: "Limitation of Liability",
            paragraphs: [
                "To the fullest extent permitted by law, Health Age and its affiliates are not liable for any indirect, incidental, special, consequential, or punitive damages arising from your use of the service.",
                "Our total liability for any claim relating to Health Age will not exceed the amount you paid us for the service in the twelve months before the claim arose, if any.",
            ],
        },
        {
            heading: "Termination",
            paragraphs: [
                "We may suspend or terminate access to Health Age if you violate these Terms or if required for security, legal, or operational reasons.",
                "You may stop using the service at any time. Provisions that by their nature should survive termination will remain in effect.",
            ],
        },
        {
            heading: "Governing Law",
            paragraphs: [
                "These Terms are governed by applicable laws in the jurisdiction where Health Age operates, without regard to conflict-of-law principles.",
                "Any dispute arising from these Terms or your use of Health Age will be handled in accordance with applicable legal process.",
            ],
        },
    ],
});
