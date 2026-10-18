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
      <main
        className="dashboard-main"
        style={{
          minHeight: "calc(100vh - 64px)",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <h1 className="dashboard-heading">Welcome, {firstName}</h1>
        <div
          style={{
            flex: 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Link
            href="/upload"
            className="btn-primary"
            style={{
              display: "block",
              width: "fit-content",
              margin: "0 auto",
              padding: "14px 36px",
              fontSize: "16px",
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