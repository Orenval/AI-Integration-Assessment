// ============================================================
// In development, Next.js hot-reloads modules on every change, which would
// create a new PrismaClient instance each time and exhaust the database
// connection pool. This singleton pattern caches the client on the Node.js
// global object so only one instance exists across reloads.
// ============================================================

import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL,
});

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma = globalForPrisma.prisma ?? new PrismaClient({ adapter });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

export default prisma;