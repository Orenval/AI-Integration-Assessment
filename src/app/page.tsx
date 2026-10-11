import { redirect } from "next/navigation";
import { validateSession } from "@/lib/session";

export const runtime = "nodejs";

export default async function HomePage() {
  const sessionData = await validateSession();

  if (!sessionData) {
    redirect("/signin");
  }

  if (!sessionData.user.emailVerified) {
    redirect("/verify-email");
  }

  redirect("/dashboard");
}

