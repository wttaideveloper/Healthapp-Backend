/**
 * Shopify "Orders export" CSV reading for the legacy customer migration.
 *
 * Two things about this export shape drive the code below:
 *
 * 1. One row per LINE ITEM, not per order. An order with six products is six
 *    rows sharing the same `Name` (order number).
 * 2. Order-level columns (Id, Email, Financial Status, Total, Refunded Amount,
 *    Billing Name, …) are written only on the FIRST row of each order and are
 *    blank on continuation rows. Reading them per-row would report most orders
 *    as having no email and no financial status.
 */

import { readFileSync } from "node:fs";

export type CsvRow = Record<string, string>;

export type ParsedLineItem = {
    readonly name: string;
    readonly quantity: number;
    readonly sku: string;
    readonly price: string;
    readonly fulfillmentStatus: string;
    /** 1-based row number in the source file, header included. Used for ambiguity reports. */
    readonly sourceRow: number;
};

export type ParsedOrder = {
    /** Shopify order name, e.g. "#1438". */
    readonly orderNumber: string;
    /** Shopify numeric order id from the `Id` column. */
    readonly shopifyOrderId: string;
    readonly email: string;
    readonly customerName: string;
    readonly company: string;
    readonly financialStatus: string;
    readonly fulfillmentStatus: string;
    readonly createdAt: string;
    readonly paidAt: string;
    readonly cancelledAt: string;
    readonly refundedAmount: number;
    readonly total: string;
    readonly currency: string;
    readonly lineItems: readonly ParsedLineItem[];
};

export type ParsedCsv = {
    readonly headerColumns: readonly string[];
    readonly totalDataRows: number;
    readonly orders: readonly ParsedOrder[];
};

/** Minimal RFC 4180 parser: quoted fields, escaped quotes, embedded newlines. */
export function parseCsvText(input: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let field = "";
    let inQuotes = false;
    let index = input.charCodeAt(0) === 0xfeff ? 1 : 0;

    for (; index < input.length; index++) {
        const char = input[index];

        if (inQuotes) {
            if (char === '"') {
                if (input[index + 1] === '"') {
                    field += '"';
                    index++;
                } else {
                    inQuotes = false;
                }
            } else {
                field += char;
            }
            continue;
        }

        if (char === '"') {
            inQuotes = true;
        } else if (char === ",") {
            row.push(field);
            field = "";
        } else if (char === "\n") {
            row.push(field);
            rows.push(row);
            row = [];
            field = "";
        } else if (char !== "\r") {
            field += char;
        }
    }

    if (field.length > 0 || row.length > 0) {
        row.push(field);
        rows.push(row);
    }

    return rows;
}

function toNumber(value: string): number {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Reads the export and groups line items into orders.
 *
 * Grouping key is the `Name` column (present on every row); `Id` and the other
 * order-level columns are taken from the first row of the group that carries a
 * value. Rows are never merged across different order numbers.
 */
export function parseOrdersCsvText(input: string, sourceLabel = "csv"): ParsedCsv {
    const rows = parseCsvText(input);
    if (rows.length === 0) {
        throw new Error(`CSV appears to be empty: ${sourceLabel}`);
    }

    const headerColumns = rows[0].map((column) => column.trim());
    const requiredColumns = ["Name", "Email", "Financial Status", "Created at", "Lineitem name", "Lineitem quantity", "Id"];
    const missingColumns = requiredColumns.filter((column) => !headerColumns.includes(column));
    if (missingColumns.length > 0) {
        throw new Error(`CSV is missing required column(s): ${missingColumns.join(", ")}`);
    }

    const columnIndex = new Map(headerColumns.map((column, index) => [column, index]));
    const cell = (row: string[], column: string): string => (row[columnIndex.get(column) ?? -1] ?? "").trim();

    type MutableOrder = Omit<{ -readonly [K in keyof ParsedOrder]: ParsedOrder[K] }, "lineItems"> & {
        lineItems: ParsedLineItem[];
    };

    const orders = new Map<string, MutableOrder>();
    let totalDataRows = 0;
    let currentOrderNumber = "";

    for (let rowIndex = 1; rowIndex < rows.length; rowIndex++) {
        const row = rows[rowIndex];
        if (row.length <= 1 && (row[0] ?? "").trim() === "") continue;

        totalDataRows++;

        // Defensive: if a future export ever omits Name on continuation rows,
        // carry the last seen order number forward rather than dropping the line.
        const rowOrderNumber = cell(row, "Name");
        if (rowOrderNumber) currentOrderNumber = rowOrderNumber;
        if (!currentOrderNumber) continue;

        let order = orders.get(currentOrderNumber);
        if (!order) {
            order = {
                orderNumber: currentOrderNumber,
                shopifyOrderId: "",
                email: "",
                customerName: "",
                company: "",
                financialStatus: "",
                fulfillmentStatus: "",
                createdAt: "",
                paidAt: "",
                cancelledAt: "",
                refundedAmount: 0,
                total: "",
                currency: "",
                lineItems: [],
            };
            orders.set(currentOrderNumber, order);
        }

        // First non-empty value wins: order-level columns only appear on row one.
        const carryForward: Array<[keyof MutableOrder, string]> = [
            ["shopifyOrderId", "Id"],
            ["email", "Email"],
            ["financialStatus", "Financial Status"],
            ["fulfillmentStatus", "Fulfillment Status"],
            ["createdAt", "Created at"],
            ["paidAt", "Paid at"],
            ["cancelledAt", "Cancelled at"],
            ["total", "Total"],
            ["currency", "Currency"],
            ["company", "Billing Company"],
        ];

        for (const [field, column] of carryForward) {
            const value = cell(row, column);
            if (value && !order[field]) {
                (order as Record<string, unknown>)[field] = value;
            }
        }

        if (!order.customerName) {
            order.customerName = cell(row, "Billing Name") || cell(row, "Shipping Name");
        }

        if (!order.company) {
            order.company = cell(row, "Shipping Company");
        }

        const refunded = toNumber(cell(row, "Refunded Amount"));
        if (refunded > order.refundedAmount) {
            order.refundedAmount = refunded;
        }

        const lineItemName = cell(row, "Lineitem name");
        if (lineItemName) {
            order.lineItems.push({
                name: lineItemName,
                quantity: toNumber(cell(row, "Lineitem quantity")),
                sku: cell(row, "Lineitem sku"),
                price: cell(row, "Lineitem price"),
                fulfillmentStatus: cell(row, "Lineitem fulfillment status"),
                sourceRow: rowIndex + 1,
            });
        }
    }

    return {
        headerColumns,
        totalDataRows,
        orders: [...orders.values()],
    };
}

export function readOrdersCsv(filePath: string): ParsedCsv {
    return parseOrdersCsvText(readFileSync(filePath, "utf8"), filePath);
}

/** Serializes a row of values into one CSV line. */
export function toCsvLine(values: readonly (string | number)[]): string {
    return values
        .map((value) => {
            const text = String(value ?? "");
            return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
        })
        .join(",");
}