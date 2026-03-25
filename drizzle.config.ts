import type { Config } from "drizzle-kit";

const DATABASE_URL = process.env.DATABASE_URL

if (!DATABASE_URL) {
    throw new Error("DATABASE_URL is not defined in environment variables");
}
export default {
    schema: "./src/db/schema/index.ts",
    out: "./migrations",
    dialect: "postgresql",
    dbCredentials: {
        url: DATABASE_URL,
    },
    strict: true,
    verbose: true,
} satisfies Config;
