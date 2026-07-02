import { eq } from "drizzle-orm";
import { FastifyInstance } from "fastify";
import Stripe from "stripe";
import z from "zod";
import { FastifyPluginAsyncZod } from "fastify-type-provider-zod";

import { env } from "@config/env";
import { BadRequestError, NotFoundError } from "@core/errors/http-errors";
import { billingEvents, stripeCustomers, stripeSubscriptions, users } from "@db/schema";

const stripeCheckoutBodySchema = z.object({
    priceId: z.string().trim().min(1).max(255).optional(),
    successUrl: z.string().url().optional(),
    cancelUrl: z.string().url().optional(),
});

const activeStripeStatuses = new Set(["active", "trialing"]);

const stripePortalBodySchema = z.object({
    returnUrl: z.string().url().optional(),
});

function getStripeClient(): Stripe {
    if (!env.STRIPE_SECRET_KEY) {
        throw new BadRequestError("Stripe is not configured: missing STRIPE_SECRET_KEY");
    }

    return new Stripe(env.STRIPE_SECRET_KEY);
}

function resolveCheckoutUrls(inputSuccessUrl?: string, inputCancelUrl?: string): {
    successUrl: string;
    cancelUrl: string;
} {
    const successUrl = inputSuccessUrl ?? env.STRIPE_SUCCESS_URL;
    const cancelUrl = inputCancelUrl ?? env.STRIPE_CANCEL_URL;

    if (!successUrl || !cancelUrl) {
        throw new BadRequestError(
            "Missing checkout redirect URLs. Provide successUrl/cancelUrl in request body or set STRIPE_SUCCESS_URL and STRIPE_CANCEL_URL"
        );
    }

    return { successUrl, cancelUrl };
}

function resolvePortalReturnUrl(inputReturnUrl?: string): string {
    const returnUrl = inputReturnUrl ?? env.STRIPE_BILLING_PORTAL_RETURN_URL;
    if (!returnUrl) {
        throw new BadRequestError(
            "Missing portal return URL. Provide returnUrl in request body or set STRIPE_BILLING_PORTAL_RETURN_URL"
        );
    }

    return returnUrl;
}

function computeStripeLicenseState(status: string, currentPeriodEnd: Date | null): {
    providerStatus: string;
    autoRenewing: boolean;
    expiresAt: Date | null;
} {
    const isActiveByStatus = activeStripeStatuses.has(status);
    const isNotExpired = !currentPeriodEnd || currentPeriodEnd.getTime() > Date.now();

    return {
        providerStatus: status,
        autoRenewing: status !== "canceled",
        expiresAt: currentPeriodEnd,
    };
}

async function getOrCreateStripeCustomerId(
    app: FastifyInstance,
    stripe: Stripe,
    userId: string
): Promise<string> {
    const [user] = await app.db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!user) {
        throw new NotFoundError("User not found");
    }

    const [existingCustomer] = await app.db
        .select()
        .from(stripeCustomers)
        .where(eq(stripeCustomers.userId, userId))
        .limit(1);

    if (existingCustomer) {
        return existingCustomer.stripeCustomerId;
    }

    const customer = await stripe.customers.create({
        email: user.email,
        name: user.name,
        metadata: {
            userId: user.id,
            provider: "stripe",
        },
    });

    await app.db.insert(stripeCustomers).values({
        userId: user.id,
        stripeCustomerId: customer.id,
    });

    return customer.id;
}

type SubscriptionUpsertInput = {
    userId: string | null;
    stripeCustomerId: string;
    stripeSubscriptionId: string;
    priceId: string | null;
    status: string;
    currentPeriodEnd: Date | null;
    cancelAtPeriodEnd: boolean;
    latestInvoiceId: string | null;
    quantity: number | null;
    payloadJson: Record<string, unknown>;
};

function normalizeStripeSubscription(subscription: Stripe.Subscription): SubscriptionUpsertInput | null {
    const stripeCustomerId = typeof subscription.customer === "string" ? subscription.customer : subscription.customer?.id;
    if (!stripeCustomerId) return null;

    const userId = subscription.metadata?.userId ?? null;

    const firstItem = subscription.items?.data?.[0];
    const priceId = firstItem?.price?.id ?? null;
    const quantity = firstItem?.quantity ?? null;
    const itemPeriodEnds = subscription.items?.data
        ?.map((item) => item.current_period_end)
        .filter((value): value is number => typeof value === "number");
    const maxCurrentPeriodEnd = itemPeriodEnds && itemPeriodEnds.length > 0
        ? Math.max(...itemPeriodEnds)
        : null;

    return {
        userId,
        stripeCustomerId,
        stripeSubscriptionId: subscription.id,
        priceId,
        status: subscription.status,
        currentPeriodEnd: maxCurrentPeriodEnd
            ? new Date(maxCurrentPeriodEnd * 1000)
            : null,
        cancelAtPeriodEnd: Boolean(subscription.cancel_at_period_end),
        latestInvoiceId:
            typeof subscription.latest_invoice === "string"
                ? subscription.latest_invoice
                : subscription.latest_invoice?.id ?? null,
        quantity,
        payloadJson: subscription as unknown as Record<string, unknown>,
    };
}

export const stripeRoutes: FastifyPluginAsyncZod = async (app) => {
    app.post(
        "/checkout",
        {
            preHandler: app.authenticate,
            schema: {
                summary: "Create Stripe Checkout session",
                body: stripeCheckoutBodySchema,
                response: {
                    200: z.object({
                        ok: z.literal(true),
                        url: z.string().url(),
                    }),
                },
            },
        },
        async (req) => {
            const stripe = getStripeClient();

            const userId = req.authUser!.sub;
            const stripeCustomerId = await getOrCreateStripeCustomerId(app, stripe, userId);
            const priceId = req.body.priceId ?? env.STRIPE_PRICE_ID_ANNUAL;
            const { successUrl, cancelUrl } = resolveCheckoutUrls(req.body.successUrl, req.body.cancelUrl);

            if (!priceId) {
                throw new BadRequestError("Missing Stripe price id. Provide priceId or set STRIPE_PRICE_ID_ANNUAL");
            }

            const session = await stripe.checkout.sessions.create({
                mode: "subscription",
                customer: stripeCustomerId,
                line_items: [{ price: priceId, quantity: 1 }],
                success_url: successUrl,
                cancel_url: cancelUrl,
                allow_promotion_codes: true,
                metadata: {
                    userId,
                    source: "web",
                    provider: "stripe",
                },
                subscription_data: {
                    metadata: {
                        userId,
                        source: "web",
                        provider: "stripe",
                    },
                },
            });

            if (!session.url) {
                throw new BadRequestError("Stripe did not return a checkout URL");
            }

            return {
                ok: true as const,
                url: session.url,
            };
        }
    );

    app.post(
        "/portal",
        {
            preHandler: app.authenticate,
            schema: {
                summary: "Create Stripe Billing Portal session",
                body: stripePortalBodySchema,
                response: {
                    200: z.object({
                        ok: z.literal(true),
                        url: z.string().url(),
                    }),
                },
            },
        },
        async (req) => {
            const stripe = getStripeClient();

            const userId = req.authUser!.sub;
            const stripeCustomerId = await getOrCreateStripeCustomerId(app, stripe, userId);
            const returnUrl = resolvePortalReturnUrl(req.body.returnUrl);

            const session = await stripe.billingPortal.sessions.create({
                customer: stripeCustomerId,
                return_url: returnUrl,
            });

            return {
                ok: true as const,
                url: session.url,
            };
        }
    );

    app.post(
        "/webhook",
        {
            config: {
                rawBody: true,
            },
            schema: {
                summary: "Stripe webhook receiver",
                response: {
                    200: z.object({
                        ok: z.literal(true),
                    }),
                },
            },
        },
        async (req) => {
            if (!env.STRIPE_WEBHOOK_SECRET) {
                throw new BadRequestError("Stripe is not configured: missing STRIPE_WEBHOOK_SECRET");
            }

            const stripe = getStripeClient();
            const signature = req.headers["stripe-signature"];
            if (!signature || typeof signature !== "string") {
                throw new BadRequestError("Missing stripe-signature header");
            }

            const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody;
            if (!rawBody) {
                throw new BadRequestError("Missing raw webhook body");
            }

            let event: Stripe.Event;
            try {
                event = stripe.webhooks.constructEvent(rawBody, signature, env.STRIPE_WEBHOOK_SECRET);
            } catch (error) {
                req.log.warn({ err: error }, "Invalid Stripe webhook signature");
                throw new BadRequestError("Invalid Stripe webhook signature");
            }

            const duplicate = await app.db.transaction(async (tx) => {
                const [insertedEvent] = await tx
                    .insert(billingEvents)
                    .values({
                        provider: "stripe",
                        eventId: event.id,
                        eventType: event.type,
                        payloadJson: event as unknown as Record<string, unknown>,
                    })
                    .onConflictDoNothing()
                    .returning({ id: billingEvents.id });

                if (!insertedEvent) {
                    return true;
                }

                const applySubscriptionUpdate = async (subscription: Stripe.Subscription) => {
                    const normalized = normalizeStripeSubscription(subscription);
                    if (!normalized) {
                        req.log.warn({ subscriptionId: subscription.id }, "Skipping Stripe subscription update: missing mapping metadata");
                        return;
                    }

                    let resolvedUserId = normalized.userId;
                    if (!resolvedUserId) {
                        // Some Stripe subscription events arrive without copied metadata; customer mapping is the durable fallback.
                        const [mappedCustomer] = await tx
                            .select({ userId: stripeCustomers.userId })
                            .from(stripeCustomers)
                            .where(eq(stripeCustomers.stripeCustomerId, normalized.stripeCustomerId))
                            .limit(1);
                        resolvedUserId = mappedCustomer?.userId ?? null;
                    }

                    if (!resolvedUserId) {
                        req.log.warn(
                            { subscriptionId: subscription.id, stripeCustomerId: normalized.stripeCustomerId },
                            "Skipping Stripe subscription update: unable to resolve user mapping"
                        );
                        return;
                    }

                    await tx
                        .insert(stripeCustomers)
                        .values({
                            userId: resolvedUserId,
                            stripeCustomerId: normalized.stripeCustomerId,
                        })
                        .onConflictDoUpdate({
                            target: stripeCustomers.userId,
                            set: {
                                stripeCustomerId: normalized.stripeCustomerId,
                                updatedAt: new Date(),
                            },
                        });

                    const state = computeStripeLicenseState(normalized.status, normalized.currentPeriodEnd);
                    const now = new Date();

                    await tx
                        .insert(stripeSubscriptions)
                        .values({
                            userId: resolvedUserId,
                            stripeCustomerId: normalized.stripeCustomerId,
                            stripeSubscriptionId: normalized.stripeSubscriptionId,
                            priceId: normalized.priceId,
                            status: normalized.status,
                            currentPeriodEnd: normalized.currentPeriodEnd,
                            cancelAtPeriodEnd: normalized.cancelAtPeriodEnd,
                            providerStatus: state.providerStatus,
                            autoRenewing: state.autoRenewing,
                            latestInvoiceId: normalized.latestInvoiceId,
                            quantity: normalized.quantity,
                            payloadJson: normalized.payloadJson,
                        })
                        .onConflictDoUpdate({
                            target: stripeSubscriptions.stripeSubscriptionId,
                            set: {
                                userId: resolvedUserId,
                                stripeCustomerId: normalized.stripeCustomerId,
                                priceId: normalized.priceId,
                                status: normalized.status,
                                currentPeriodEnd: normalized.currentPeriodEnd,
                                cancelAtPeriodEnd: normalized.cancelAtPeriodEnd,
                                providerStatus: state.providerStatus,
                                autoRenewing: state.autoRenewing,
                                latestInvoiceId: normalized.latestInvoiceId,
                                quantity: normalized.quantity,
                                payloadJson: normalized.payloadJson,
                                updatedAt: now,
                            },
                        });
                };

                const resolveAndApplySubscription = async (subscriptionId: string) => {
                    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
                    await applySubscriptionUpdate(subscription);
                };

                switch (event.type) {
                    case "checkout.session.completed": {
                        const session = event.data.object as Stripe.Checkout.Session;
                        const userIdFromMetadata = session.metadata?.userId;
                        const customerId = typeof session.customer === "string" ? session.customer : null;
                        if (userIdFromMetadata && customerId) {
                            await tx
                                .insert(stripeCustomers)
                                .values({
                                    userId: userIdFromMetadata,
                                    stripeCustomerId: customerId,
                                })
                                .onConflictDoUpdate({
                                    target: stripeCustomers.userId,
                                    set: {
                                        stripeCustomerId: customerId,
                                        updatedAt: new Date(),
                                    },
                                });
                        }

                        if (typeof session.subscription === "string") {
                            await resolveAndApplySubscription(session.subscription);
                        }
                        break;
                    }

                    case "customer.subscription.created":
                    case "customer.subscription.updated":
                    case "customer.subscription.deleted": {
                        const subscription = event.data.object as Stripe.Subscription;
                        await applySubscriptionUpdate(subscription);
                        break;
                    }

                    case "invoice.paid":
                    case "invoice.payment_failed": {
                        const invoice = event.data.object as Stripe.Invoice;
                        const invoiceSubscription =
                            invoice.parent?.subscription_details?.subscription;
                        if (typeof invoiceSubscription === "string") {
                            await resolveAndApplySubscription(invoiceSubscription);
                        }
                        break;
                    }

                    default:
                        break;
                }

                return false;
            });

            if (duplicate) {
                req.log.info({ eventId: event.id, eventType: event.type }, "Ignoring duplicate Stripe event");
            }

            return {
                ok: true as const,
            };
        }
    );
};
