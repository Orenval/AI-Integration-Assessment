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
      </main>
    </div>
  );
}