import Link from "next/link";
import { redirect } from "next/navigation";
import { validateSession } from "@/lib/session";
import { DashboardHeader } from "./dashboard-header";

// Requirement 10: Protected endpoint — verifies valid, non-expired session server-side before rendering
export default async function DashboardPage() {
  const sessionData = await validateSession();

  if (!sessionData) {
    redirect("/signin");
  }

  if (!sessionData.user.emailVerified) {
    redirect("/verify-email");
  }

  const firstName =
    sessionData.user.fullName.trim().split(/\s+/)[0] ||
    sessionData.user.fullName;

  return (
    <div className="dashboard-page">
      <DashboardHeader user={sessionData.user} />
      <main className="dashboard-main">
        <h1 className="dashboard-heading">Welcome to Auth, {firstName}</h1>
        <div style={{ marginTop: "24px" }}>
          <Link
            href="/upload"
            className="btn-primary"
            style={{
              display: "inline-block",
              padding: "10px 20px",
              backgroundColor: "var(--color-primary, #2563eb)",
              color: "#ffffff",
              borderRadius: "6px",
              fontWeight: 500,
              textDecoration: "none",
            }}
          >
            Upload
          </Link>
        </div>
      </main>
    </div>
  );
}