import { createHash } from "node:crypto";
import {
    and,
    asc,
    desc,
    eq,
    gt,
    inArray,
    isNull,
    lt,
    lte,
    max,
    or,
    sql,
} from "drizzle-orm";

import type { DB } from "@db/index";
import {
    healthReportGroupLinks,
    healthReportGroups,
    healthReportSyncMutations,
    healthReports,
    type SelectHealthReport,
    type SelectHealthReportGroup,
    type SelectHealthReportGroupLink,
} from "@db/schema";
import { BadRequestError, ConflictError, NotFoundError } from "@core/errors/http-errors";
import type { GroupPatch, ReportPatch, SyncMutation } from "./report-sync.schema";

const nextSyncSequence = sql`nextval('health_report_sync_sequence')`;

type MutationResult = {
    mutationId: string;
    type: SyncMutation["type"];
    entityId: string;
    version: number;
    changeSequence: string;
    deleted: boolean;
    replayed: boolean;
};

type PageCursor = { createdAt: string; id: string };

function canonicalize(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === "object") {
        return Object.fromEntries(
            Object.entries(value as Record<string, unknown>)
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([key, item]) => [key, canonicalize(item)])
        );
    }
    return value;
}

function mutationHash(mutation: SyncMutation): string {
    return createHash("sha256").update(JSON.stringify(canonicalize(mutation))).digest("hex");
}

function asBigInt(value: bigint | number | string | null | undefined): bigint {
    if (value === null || value === undefined) return 0n;
    return typeof value === "bigint" ? value : BigInt(value);
}

function reportDto(row: SelectHealthReport) {
    return {
        id: row.id,
        userName: row.userName,
        userEmail: row.userEmail,
        title: row.title,
        answers: row.answers,
        reportData: row.reportData,
        date: row.reportDate,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        deletedAt: row.deletedAt?.toISOString() ?? null,
        version: row.version,
        changeSequence: row.syncSequence.toString(),
    };
}

function groupDto(row: SelectHealthReportGroup) {
    return {
        id: row.id,
        name: row.name,
        description: row.description,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        deletedAt: row.deletedAt?.toISOString() ?? null,
        version: row.version,
        changeSequence: row.syncSequence.toString(),
    };
}

function relationshipDto(row: SelectHealthReportGroupLink) {
    return {
        reportId: row.reportId,
        groupId: row.groupId,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        deletedAt: row.deletedAt?.toISOString() ?? null,
        version: row.version,
        changeSequence: row.syncSequence.toString(),
    };
}

function conflictDetails(row: { version: number; deletedAt: Date | null }) {
    return {
        currentVersion: row.version,
        deletedAt: row.deletedAt?.toISOString() ?? null,
    };
}

function encodePageCursor(row: { createdAt: Date; id: string }): string {
    return Buffer.from(
        JSON.stringify({ createdAt: row.createdAt.toISOString(), id: row.id } satisfies PageCursor)
    ).toString("base64url");
}

function decodePageCursor(value: string | undefined): PageCursor | null {
    if (!value) return null;
    try {
        const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as PageCursor;
        if (
            !parsed ||
            typeof parsed.id !== "string" ||
            parsed.id.length < 1 ||
            parsed.id.length > 128 ||
            !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(parsed.id) ||
            typeof parsed.createdAt !== "string" ||
            Number.isNaN(new Date(parsed.createdAt).getTime())
        ) {
            throw new Error("invalid cursor");
        }
        return parsed;
    } catch {
        throw new BadRequestError("Invalid pagination cursor");
    }
}

async function lockUser(tx: DB, userId: string): Promise<void> {
    // Every writer and cursor snapshot takes this transaction-scoped lock. It
    // closes the sequence-allocation/commit race that can otherwise skip data.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${userId}, 724113))`);
}

function mutationResult(
    mutation: SyncMutation,
    entityId: string,
    version: number,
    sequence: bigint,
    deleted: boolean
): MutationResult {
    return {
        mutationId: mutation.mutationId,
        type: mutation.type,
        entityId,
        version,
        changeSequence: sequence.toString(),
        deleted,
        replayed: false,
    };
}

async function findReport(tx: DB, userId: string, id: string) {
    const [row] = await tx
        .select()
        .from(healthReports)
        .where(and(eq(healthReports.userId, userId), eq(healthReports.id, id)))
        .limit(1);
    return row ?? null;
}

async function findGroup(tx: DB, userId: string, id: string) {
    const [row] = await tx
        .select()
        .from(healthReportGroups)
        .where(and(eq(healthReportGroups.userId, userId), eq(healthReportGroups.id, id)))
        .limit(1);
    return row ?? null;
}

async function findRelationship(tx: DB, userId: string, reportId: string, groupId: string) {
    const [row] = await tx
        .select()
        .from(healthReportGroupLinks)
        .where(
            and(
                eq(healthReportGroupLinks.userId, userId),
                eq(healthReportGroupLinks.reportId, reportId),
                eq(healthReportGroupLinks.groupId, groupId)
            )
        )
        .limit(1);
    return row ?? null;
}

async function createReport(tx: DB, userId: string, mutation: Extract<SyncMutation, { type: "report.create" }>) {
    const existing = await findReport(tx, userId, mutation.id);
    if (existing) {
        throw new ConflictError("Report id already exists", conflictDetails(existing));
    }

    const [row] = await tx
        .insert(healthReports)
        .values({
            userId,
            id: mutation.id,
            userName: mutation.userName,
            userEmail: mutation.userEmail ?? null,
            title: mutation.title,
            answers: mutation.answers,
            reportData: mutation.reportData,
            reportDate: mutation.date,
            createdAt: mutation.createdAt ? new Date(mutation.createdAt) : undefined,
        })
        .returning();

    return mutationResult(mutation, row.id, row.version, row.syncSequence, false);
}

async function updateReport(tx: DB, userId: string, mutation: Extract<SyncMutation, { type: "report.update" }>) {
    const current = await findReport(tx, userId, mutation.id);
    if (!current) throw new NotFoundError("Report not found");
    if (current.deletedAt || current.version !== mutation.expectedVersion) {
        throw new ConflictError("Report version conflict", conflictDetails(current));
    }

    const changes: ReportPatch = mutation.changes;
    const [row] = await tx
        .update(healthReports)
        .set({
            ...(changes.userName !== undefined ? { userName: changes.userName } : {}),
            ...(changes.userEmail !== undefined ? { userEmail: changes.userEmail } : {}),
            ...(changes.title !== undefined ? { title: changes.title } : {}),
            ...(changes.answers !== undefined ? { answers: changes.answers } : {}),
            ...(changes.reportData !== undefined ? { reportData: changes.reportData } : {}),
            ...(changes.date !== undefined ? { reportDate: changes.date } : {}),
            updatedAt: new Date(),
            version: sql`${healthReports.version} + 1`,
            syncSequence: nextSyncSequence,
        })
        .where(
            and(
                eq(healthReports.userId, userId),
                eq(healthReports.id, mutation.id),
                eq(healthReports.version, mutation.expectedVersion),
                isNull(healthReports.deletedAt)
            )
        )
        .returning();

    if (!row) throw new ConflictError("Report changed concurrently");
    return mutationResult(mutation, row.id, row.version, row.syncSequence, false);
}

async function deleteReport(tx: DB, userId: string, mutation: Extract<SyncMutation, { type: "report.delete" }>) {
    const current = await findReport(tx, userId, mutation.id);
    if (!current) throw new NotFoundError("Report not found");
    if (current.deletedAt || current.version !== mutation.expectedVersion) {
        throw new ConflictError("Report version conflict", conflictDetails(current));
    }

    const now = new Date();
    await tx
        .update(healthReportGroupLinks)
        .set({
            deletedAt: now,
            updatedAt: now,
            version: sql`${healthReportGroupLinks.version} + 1`,
            syncSequence: nextSyncSequence,
        })
        .where(
            and(
                eq(healthReportGroupLinks.userId, userId),
                eq(healthReportGroupLinks.reportId, mutation.id),
                isNull(healthReportGroupLinks.deletedAt)
            )
        );

    const [row] = await tx
        .update(healthReports)
        .set({
            // Retain the identity tombstone, not the deleted health content.
            userName: "",
            userEmail: null,
            title: "[deleted]",
            answers: [],
            reportData: {},
            reportDate: "1970-01-01",
            deletedAt: now,
            updatedAt: now,
            version: sql`${healthReports.version} + 1`,
            syncSequence: nextSyncSequence,
        })
        .where(
            and(
                eq(healthReports.userId, userId),
                eq(healthReports.id, mutation.id),
                eq(healthReports.version, mutation.expectedVersion),
                isNull(healthReports.deletedAt)
            )
        )
        .returning();

    if (!row) throw new ConflictError("Report changed concurrently");
    return mutationResult(mutation, row.id, row.version, row.syncSequence, true);
}

async function createGroup(tx: DB, userId: string, mutation: Extract<SyncMutation, { type: "group.create" }>) {
    const existing = await findGroup(tx, userId, mutation.id);
    if (existing) throw new ConflictError("Group id already exists", conflictDetails(existing));

    const [row] = await tx
        .insert(healthReportGroups)
        .values({
            userId,
            id: mutation.id,
            name: mutation.name,
            description: mutation.description,
            createdAt: mutation.createdAt ? new Date(mutation.createdAt) : undefined,
        })
        .returning();
    return mutationResult(mutation, row.id, row.version, row.syncSequence, false);
}

async function updateGroup(tx: DB, userId: string, mutation: Extract<SyncMutation, { type: "group.update" }>) {
    const current = await findGroup(tx, userId, mutation.id);
    if (!current) throw new NotFoundError("Group not found");
    if (current.deletedAt || current.version !== mutation.expectedVersion) {
        throw new ConflictError("Group version conflict", conflictDetails(current));
    }

    const changes: GroupPatch = mutation.changes;
    const [row] = await tx
        .update(healthReportGroups)
        .set({
            ...(changes.name !== undefined ? { name: changes.name } : {}),
            ...(changes.description !== undefined ? { description: changes.description } : {}),
            updatedAt: new Date(),
            version: sql`${healthReportGroups.version} + 1`,
            syncSequence: nextSyncSequence,
        })
        .where(
            and(
                eq(healthReportGroups.userId, userId),
                eq(healthReportGroups.id, mutation.id),
                eq(healthReportGroups.version, mutation.expectedVersion),
                isNull(healthReportGroups.deletedAt)
            )
        )
        .returning();
    if (!row) throw new ConflictError("Group changed concurrently");
    return mutationResult(mutation, row.id, row.version, row.syncSequence, false);
}

async function deleteGroup(tx: DB, userId: string, mutation: Extract<SyncMutation, { type: "group.delete" }>) {
    const current = await findGroup(tx, userId, mutation.id);
    if (!current) throw new NotFoundError("Group not found");
    if (current.deletedAt || current.version !== mutation.expectedVersion) {
        throw new ConflictError("Group version conflict", conflictDetails(current));
    }

    const now = new Date();
    await tx
        .update(healthReportGroupLinks)
        .set({
            deletedAt: now,
            updatedAt: now,
            version: sql`${healthReportGroupLinks.version} + 1`,
            syncSequence: nextSyncSequence,
        })
        .where(
            and(
                eq(healthReportGroupLinks.userId, userId),
                eq(healthReportGroupLinks.groupId, mutation.id),
                isNull(healthReportGroupLinks.deletedAt)
            )
        );

    const [row] = await tx
        .update(healthReportGroups)
        .set({
            name: "[deleted]",
            description: "",
            deletedAt: now,
            updatedAt: now,
            version: sql`${healthReportGroups.version} + 1`,
            syncSequence: nextSyncSequence,
        })
        .where(
            and(
                eq(healthReportGroups.userId, userId),
                eq(healthReportGroups.id, mutation.id),
                eq(healthReportGroups.version, mutation.expectedVersion),
                isNull(healthReportGroups.deletedAt)
            )
        )
        .returning();
    if (!row) throw new ConflictError("Group changed concurrently");
    return mutationResult(mutation, row.id, row.version, row.syncSequence, true);
}

async function putRelationship(
    tx: DB,
    userId: string,
    mutation: Extract<SyncMutation, { type: "relationship.put" }>
) {
    const report = await findReport(tx, userId, mutation.reportId);
    const group = await findGroup(tx, userId, mutation.groupId);
    if (!report || report.deletedAt) throw new NotFoundError("Report not found");
    if (!group || group.deletedAt) throw new NotFoundError("Group not found");

    const current = await findRelationship(tx, userId, mutation.reportId, mutation.groupId);
    const entityId = `${mutation.reportId}:${mutation.groupId}`;
    if (!current) {
        if (mutation.expectedVersion !== 0) {
            throw new ConflictError("Relationship version conflict", { currentVersion: 0, deletedAt: null });
        }
        const [row] = await tx
            .insert(healthReportGroupLinks)
            .values({ userId, reportId: mutation.reportId, groupId: mutation.groupId })
            .returning();
        return mutationResult(mutation, entityId, row.version, row.syncSequence, false);
    }

    if (current.version !== mutation.expectedVersion) {
        throw new ConflictError("Relationship version conflict", conflictDetails(current));
    }
    if (!current.deletedAt) {
        return mutationResult(mutation, entityId, current.version, current.syncSequence, false);
    }

    const [row] = await tx
        .update(healthReportGroupLinks)
        .set({
            deletedAt: null,
            updatedAt: new Date(),
            version: sql`${healthReportGroupLinks.version} + 1`,
            syncSequence: nextSyncSequence,
        })
        .where(
            and(
                eq(healthReportGroupLinks.userId, userId),
                eq(healthReportGroupLinks.reportId, mutation.reportId),
                eq(healthReportGroupLinks.groupId, mutation.groupId),
                eq(healthReportGroupLinks.version, mutation.expectedVersion)
            )
        )
        .returning();
    if (!row) throw new ConflictError("Relationship changed concurrently");
    return mutationResult(mutation, entityId, row.version, row.syncSequence, false);
}

async function deleteRelationship(
    tx: DB,
    userId: string,
    mutation: Extract<SyncMutation, { type: "relationship.delete" }>
) {
    const report = await findReport(tx, userId, mutation.reportId);
    const group = await findGroup(tx, userId, mutation.groupId);
    if (!report || report.deletedAt) throw new NotFoundError("Report not found");
    if (!group || group.deletedAt) throw new NotFoundError("Group not found");

    const current = await findRelationship(tx, userId, mutation.reportId, mutation.groupId);
    if (!current) throw new NotFoundError("Relationship not found");
    if (current.deletedAt || current.version !== mutation.expectedVersion) {
        throw new ConflictError("Relationship version conflict", conflictDetails(current));
    }

    const [row] = await tx
        .update(healthReportGroupLinks)
        .set({
            deletedAt: new Date(),
            updatedAt: new Date(),
            version: sql`${healthReportGroupLinks.version} + 1`,
            syncSequence: nextSyncSequence,
        })
        .where(
            and(
                eq(healthReportGroupLinks.userId, userId),
                eq(healthReportGroupLinks.reportId, mutation.reportId),
                eq(healthReportGroupLinks.groupId, mutation.groupId),
                eq(healthReportGroupLinks.version, mutation.expectedVersion),
                isNull(healthReportGroupLinks.deletedAt)
            )
        )
        .returning();
    if (!row) throw new ConflictError("Relationship changed concurrently");
    return mutationResult(
        mutation,
        `${mutation.reportId}:${mutation.groupId}`,
        row.version,
        row.syncSequence,
        true
    );
}

async function applyOne(tx: DB, userId: string, mutation: SyncMutation): Promise<MutationResult> {
    switch (mutation.type) {
        case "report.create":
            return createReport(tx, userId, mutation);
        case "report.update":
            return updateReport(tx, userId, mutation);
        case "report.delete":
            return deleteReport(tx, userId, mutation);
        case "group.create":
            return createGroup(tx, userId, mutation);
        case "group.update":
            return updateGroup(tx, userId, mutation);
        case "group.delete":
            return deleteGroup(tx, userId, mutation);
        case "relationship.put":
            return putRelationship(tx, userId, mutation);
        case "relationship.delete":
            return deleteRelationship(tx, userId, mutation);
    }
}

export async function applySyncMutations(db: DB, userId: string, mutations: SyncMutation[]) {
    const uniqueMutationIds = new Set(mutations.map((mutation) => mutation.mutationId));
    if (uniqueMutationIds.size !== mutations.length) {
        throw new BadRequestError("mutationId values must be unique within a batch");
    }

    return db.transaction(async (rawTx) => {
        const tx = rawTx as DB;
        await lockUser(tx, userId);
        const results: MutationResult[] = [];

        for (const mutation of mutations) {
            const hash = mutationHash(mutation);
            const [receipt] = await tx
                .select()
                .from(healthReportSyncMutations)
                .where(
                    and(
                        eq(healthReportSyncMutations.userId, userId),
                        eq(healthReportSyncMutations.mutationId, mutation.mutationId)
                    )
                )
                .limit(1);

            if (receipt) {
                if (receipt.requestHash !== hash || receipt.operation !== mutation.type) {
                    throw new ConflictError("mutationId was already used for a different request");
                }
                results.push({ ...(receipt.result as MutationResult), replayed: true });
                continue;
            }

            const result = await applyOne(tx, userId, mutation);
            await tx.insert(healthReportSyncMutations).values({
                userId,
                mutationId: mutation.mutationId,
                operation: mutation.type,
                requestHash: hash,
                result,
            });
            results.push(result);
        }

        return { results };
    });
}

export async function getReport(db: DB, userId: string, id: string) {
    const row = await findReport(db, userId, id);
    if (!row || row.deletedAt) throw new NotFoundError("Report not found");
    const links = await db
        .select({ groupId: healthReportGroupLinks.groupId })
        .from(healthReportGroupLinks)
        .where(
            and(
                eq(healthReportGroupLinks.userId, userId),
                eq(healthReportGroupLinks.reportId, id),
                isNull(healthReportGroupLinks.deletedAt)
            )
        );
    return { ...reportDto(row), groupIds: links.map((link) => link.groupId) };
}

export async function listReports(db: DB, userId: string, limit: number, cursorValue?: string) {
    const cursor = decodePageCursor(cursorValue);
    const cursorDate = cursor ? new Date(cursor.createdAt) : null;
    const rows = await db
        .select()
        .from(healthReports)
        .where(
            and(
                eq(healthReports.userId, userId),
                isNull(healthReports.deletedAt),
                cursor && cursorDate
                    ? or(
                          lt(healthReports.createdAt, cursorDate),
                          and(eq(healthReports.createdAt, cursorDate), lt(healthReports.id, cursor.id))
                      )
                    : undefined
            )
        )
        .orderBy(desc(healthReports.createdAt), desc(healthReports.id))
        .limit(limit + 1);

    const page = rows.slice(0, limit);
    const ids = page.map((row) => row.id);
    const links = ids.length
        ? await db
              .select({ reportId: healthReportGroupLinks.reportId, groupId: healthReportGroupLinks.groupId })
              .from(healthReportGroupLinks)
              .where(
                  and(
                      eq(healthReportGroupLinks.userId, userId),
                      inArray(healthReportGroupLinks.reportId, ids),
                      isNull(healthReportGroupLinks.deletedAt)
                  )
              )
        : [];
    const groupsByReport = new Map<string, string[]>();
    for (const link of links) {
        const groupIds = groupsByReport.get(link.reportId) ?? [];
        groupIds.push(link.groupId);
        groupsByReport.set(link.reportId, groupIds);
    }

    return {
        items: page.map((row) => ({ ...reportDto(row), groupIds: groupsByReport.get(row.id) ?? [] })),
        nextCursor: rows.length > limit && page.length ? encodePageCursor(page[page.length - 1]) : null,
    };
}

export async function getGroup(db: DB, userId: string, id: string) {
    const row = await findGroup(db, userId, id);
    if (!row || row.deletedAt) throw new NotFoundError("Group not found");
    const links = await db
        .select({ reportId: healthReportGroupLinks.reportId })
        .from(healthReportGroupLinks)
        .where(
            and(
                eq(healthReportGroupLinks.userId, userId),
                eq(healthReportGroupLinks.groupId, id),
                isNull(healthReportGroupLinks.deletedAt)
            )
        );
    return { ...groupDto(row), reportIds: links.map((link) => link.reportId) };
}

export async function listGroups(db: DB, userId: string, limit: number, cursorValue?: string) {
    const cursor = decodePageCursor(cursorValue);
    const cursorDate = cursor ? new Date(cursor.createdAt) : null;
    const rows = await db
        .select()
        .from(healthReportGroups)
        .where(
            and(
                eq(healthReportGroups.userId, userId),
                isNull(healthReportGroups.deletedAt),
                cursor && cursorDate
                    ? or(
                          lt(healthReportGroups.createdAt, cursorDate),
                          and(
                              eq(healthReportGroups.createdAt, cursorDate),
                              lt(healthReportGroups.id, cursor.id)
                          )
                      )
                    : undefined
            )
        )
        .orderBy(desc(healthReportGroups.createdAt), desc(healthReportGroups.id))
        .limit(limit + 1);
    const page = rows.slice(0, limit);
    return {
        items: page.map(groupDto),
        nextCursor: rows.length > limit && page.length ? encodePageCursor(page[page.length - 1]) : null,
    };
}

type SyncChange =
    | { kind: "report"; sequence: bigint; data: ReturnType<typeof reportDto> }
    | { kind: "group"; sequence: bigint; data: ReturnType<typeof groupDto> }
    | { kind: "relationship"; sequence: bigint; data: ReturnType<typeof relationshipDto> };

export async function pullSyncChanges(db: DB, userId: string, cursorValue: string, limit: number) {
    const cursor = BigInt(cursorValue);
    return db.transaction(async (rawTx) => {
        const tx = rawTx as DB;
        await lockUser(tx, userId);

        const [[reportMax], [groupMax], [linkMax]] = await Promise.all([
            tx.select({ value: max(healthReports.syncSequence) }).from(healthReports).where(eq(healthReports.userId, userId)),
            tx
                .select({ value: max(healthReportGroups.syncSequence) })
                .from(healthReportGroups)
                .where(eq(healthReportGroups.userId, userId)),
            tx
                .select({ value: max(healthReportGroupLinks.syncSequence) })
                .from(healthReportGroupLinks)
                .where(eq(healthReportGroupLinks.userId, userId)),
        ]);
        const snapshot = [reportMax.value, groupMax.value, linkMax.value]
            .map(asBigInt)
            .reduce((highest, value) => (value > highest ? value : highest), 0n);

        if (cursor > snapshot) {
            throw new BadRequestError("Synchronization cursor is ahead of this account");
        }
        if (cursor === snapshot) {
            return { changes: [], nextCursor: cursor.toString(), hasMore: false };
        }

        const [reports, groups, relationships] = await Promise.all([
            tx
                .select()
                .from(healthReports)
                .where(
                    and(
                        eq(healthReports.userId, userId),
                        gt(healthReports.syncSequence, cursor),
                        lte(healthReports.syncSequence, snapshot)
                    )
                )
                .orderBy(asc(healthReports.syncSequence))
                .limit(limit + 1),
            tx
                .select()
                .from(healthReportGroups)
                .where(
                    and(
                        eq(healthReportGroups.userId, userId),
                        gt(healthReportGroups.syncSequence, cursor),
                        lte(healthReportGroups.syncSequence, snapshot)
                    )
                )
                .orderBy(asc(healthReportGroups.syncSequence))
                .limit(limit + 1),
            tx
                .select()
                .from(healthReportGroupLinks)
                .where(
                    and(
                        eq(healthReportGroupLinks.userId, userId),
                        gt(healthReportGroupLinks.syncSequence, cursor),
                        lte(healthReportGroupLinks.syncSequence, snapshot)
                    )
                )
                .orderBy(asc(healthReportGroupLinks.syncSequence))
                .limit(limit + 1),
        ]);

        const merged: SyncChange[] = [
            ...reports.map((row) => ({ kind: "report" as const, sequence: row.syncSequence, data: reportDto(row) })),
            ...groups.map((row) => ({ kind: "group" as const, sequence: row.syncSequence, data: groupDto(row) })),
            ...relationships.map((row) => ({
                kind: "relationship" as const,
                sequence: row.syncSequence,
                data: relationshipDto(row),
            })),
        ].sort((left, right) => (left.sequence < right.sequence ? -1 : left.sequence > right.sequence ? 1 : 0));

        const page = merged.slice(0, limit);
        const hasMore = merged.length > limit;
        const nextCursor = hasMore && page.length ? page[page.length - 1].sequence : snapshot;
        return {
            changes: page.map(({ kind, data }) => ({ kind, data })),
            nextCursor: nextCursor.toString(),
            hasMore,
        };
    });
}
