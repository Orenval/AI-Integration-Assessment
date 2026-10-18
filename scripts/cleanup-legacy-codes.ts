// =============================================================================
// One-off Cleanup Script: Delete all legacy VerificationCode & PasswordResetToken rows
// =============================================================================
// Existing rows hold SHA-256 hashes and can never match a bcrypt compare.
// This script purges all VerificationCode and PasswordResetToken rows.
// Does NOT touch User or Session tables.

import { prisma } from "../src/lib/prisma";

async function main() {
  console.log("Starting one-off cleanup of legacy verification codes and reset tokens...");

  const [deletedVerificationCodes, deletedResetTokens] = await prisma.$transaction([
    prisma.verificationCode.deleteMany({}),
    prisma.passwordResetToken.deleteMany({}),
  ]);

  console.log(`Deleted VerificationCode rows: ${deletedVerificationCodes.count}`);
  console.log(`Deleted PasswordResetToken rows: ${deletedResetTokens.count}`);
  console.log(`Total rows deleted: ${deletedVerificationCodes.count + deletedResetTokens.count}`);
}

main()
  .catch((err) => {
    console.error("Cleanup failed:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
