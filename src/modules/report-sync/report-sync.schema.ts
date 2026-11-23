import { z } from "zod";

export const clientRecordIdSchema = z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, "Invalid client record id");

export const mutationIdSchema = z.string().uuid();
export const versionSchema = z.number().int().positive();
export const cursorSchema = z
    .string()
    .max(19)
    .regex(/^\d+$/)
    .refine((value) => BigInt(value) <= 9_223_372_036_854_775_807n, "Cursor is out of range")
    .default("0");
export const pageLimitSchema = z.coerce.number().int().min(1).max(100).default(25);
export const syncLimitSchema = z.coerce.number().int().min(1).max(200).default(100);

export const answerSchema = z.object({
    questionId: z.number().int(),
    text: z.string().max(5_000),
    points: z.number().finite(),
});

export const reportFieldsSchema = z.object({
    id: clientRecordIdSchema,
    userName: z.string().trim().min(1).max(200),
    userEmail: z.string().trim().max(320).nullable().optional(),
    title: z.string().trim().min(1).max(300),
    answers: z.array(answerSchema).max(500),
    // The current client uses HealthMetrics, but keeping this as a JSON object
    // preserves forward-compatible report fields without lossy server mapping.
    reportData: z.record(z.string().max(100), z.unknown()),
    date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .refine((value) => {
            const date = new Date(`${value}T00:00:00.000Z`);
            return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
        }, "Invalid calendar date"),
    createdAt: z.string().datetime({ offset: true }).optional(),
});

export const reportPatchSchema = reportFieldsSchema
    .omit({ id: true, createdAt: true })
    .partial()
    .refine((value) => Object.keys(value).length > 0, "At least one report field is required");

export const groupFieldsSchema = z.object({
    id: clientRecordIdSchema,
    name: z.string().trim().min(1).max(120),
    description: z.string().max(2_000).default(""),
    createdAt: z.string().datetime({ offset: true }).optional(),
});

export const groupPatchSchema = groupFieldsSchema
    .omit({ id: true, createdAt: true })
    .partial()
    .refine((value) => Object.keys(value).length > 0, "At least one group field is required");

export const reportCreateBodySchema = reportFieldsSchema.extend({ mutationId: mutationIdSchema });
export const reportUpdateBodySchema = z.object({
    mutationId: mutationIdSchema,
    expectedVersion: versionSchema,
    changes: reportPatchSchema,
});
export const deleteBodySchema = z.object({
    mutationId: mutationIdSchema,
    expectedVersion: versionSchema,
});

export const groupCreateBodySchema = groupFieldsSchema.extend({ mutationId: mutationIdSchema });
export const groupUpdateBodySchema = z.object({
    mutationId: mutationIdSchema,
    expectedVersion: versionSchema,
    changes: groupPatchSchema,
});

export const relationshipPutBodySchema = z.object({
    mutationId: mutationIdSchema,
    reportId: clientRecordIdSchema,
    expectedVersion: z.number().int().min(0),
});
export const relationshipDeleteBodySchema = z.object({
    mutationId: mutationIdSchema,
    reportId: clientRecordIdSchema,
    expectedVersion: versionSchema,
});

const reportCreateMutationSchema = reportFieldsSchema.extend({
    type: z.literal("report.create"),
    mutationId: mutationIdSchema,
});
const reportUpdateMutationSchema = z.object({
    type: z.literal("report.update"),
    mutationId: mutationIdSchema,
    id: clientRecordIdSchema,
    expectedVersion: versionSchema,
    changes: reportPatchSchema,
});
const reportDeleteMutationSchema = z.object({
    type: z.literal("report.delete"),
    mutationId: mutationIdSchema,
    id: clientRecordIdSchema,
    expectedVersion: versionSchema,
});
const groupCreateMutationSchema = groupFieldsSchema.extend({
    type: z.literal("group.create"),
    mutationId: mutationIdSchema,
});
const groupUpdateMutationSchema = z.object({
    type: z.literal("group.update"),
    mutationId: mutationIdSchema,
    id: clientRecordIdSchema,
    expectedVersion: versionSchema,
    changes: groupPatchSchema,
});
const groupDeleteMutationSchema = z.object({
    type: z.literal("group.delete"),
    mutationId: mutationIdSchema,
    id: clientRecordIdSchema,
    expectedVersion: versionSchema,
});
const relationshipPutMutationSchema = z.object({
    type: z.literal("relationship.put"),
    mutationId: mutationIdSchema,
    reportId: clientRecordIdSchema,
    groupId: clientRecordIdSchema,
    expectedVersion: z.number().int().min(0),
});
const relationshipDeleteMutationSchema = z.object({
    type: z.literal("relationship.delete"),
    mutationId: mutationIdSchema,
    reportId: clientRecordIdSchema,
    groupId: clientRecordIdSchema,
    expectedVersion: versionSchema,
});

export const syncMutationSchema = z.discriminatedUnion("type", [
    reportCreateMutationSchema,
    reportUpdateMutationSchema,
    reportDeleteMutationSchema,
    groupCreateMutationSchema,
    groupUpdateMutationSchema,
    groupDeleteMutationSchema,
    relationshipPutMutationSchema,
    relationshipDeleteMutationSchema,
]);

export const syncPushBodySchema = z.object({
    mutations: z.array(syncMutationSchema).min(1).max(100),
});

export const recordParamsSchema = z.object({ id: clientRecordIdSchema });
export const relationshipParamsSchema = z.object({
    id: clientRecordIdSchema,
    reportId: clientRecordIdSchema,
});

export const reportListQuerySchema = z.object({
    limit: pageLimitSchema,
    cursor: z.string().max(512).optional(),
});
export const groupListQuerySchema = reportListQuerySchema;
export const syncPullQuerySchema = z.object({ cursor: cursorSchema, limit: syncLimitSchema });

export const reportResponseSchema = z.object({
    id: clientRecordIdSchema,
    userName: z.string(),
    userEmail: z.string().nullable(),
    title: z.string(),
    answers: z.unknown(),
    reportData: z.unknown(),
    date: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
    deletedAt: z.string().nullable(),
    version: versionSchema,
    changeSequence: cursorSchema,
});
export const groupResponseSchema = z.object({
    id: clientRecordIdSchema,
    name: z.string(),
    description: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
    deletedAt: z.string().nullable(),
    version: versionSchema,
    changeSequence: cursorSchema,
});
export const relationshipResponseSchema = z.object({
    reportId: clientRecordIdSchema,
    groupId: clientRecordIdSchema,
    createdAt: z.string(),
    updatedAt: z.string(),
    deletedAt: z.string().nullable(),
    version: versionSchema,
    changeSequence: cursorSchema,
});
export const mutationResultSchema = z.object({
    mutationId: mutationIdSchema,
    type: z.string(),
    entityId: z.string(),
    version: versionSchema,
    changeSequence: cursorSchema,
    deleted: z.boolean(),
    replayed: z.boolean(),
});
export const syncPushResponseSchema = z.object({ results: z.array(mutationResultSchema) });
export const syncPullResponseSchema = z.object({
    changes: z.array(
        z.discriminatedUnion("kind", [
            z.object({ kind: z.literal("report"), data: reportResponseSchema }),
            z.object({ kind: z.literal("group"), data: groupResponseSchema }),
            z.object({ kind: z.literal("relationship"), data: relationshipResponseSchema }),
        ])
    ),
    nextCursor: cursorSchema,
    hasMore: z.boolean(),
});

export type SyncMutation = z.infer<typeof syncMutationSchema>;
export type ReportPatch = z.infer<typeof reportPatchSchema>;
export type GroupPatch = z.infer<typeof groupPatchSchema>;
