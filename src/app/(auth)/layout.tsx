"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/context/auth-context";

const AUTHENTICATED_REDIRECT_ROUTES = ["/signin", "/signup", "/forgot-password"];
const PROTECTED_ROUTES = ["/verify-email"];

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { isAuthenticated, isLoading } = useAuth();

  useEffect(() => {
    if (isLoading) return;

    const path = window.location.pathname;

    if (
      AUTHENTICATED_REDIRECT_ROUTES.some((r) => path.startsWith(r)) &&
      isAuthenticated
    ) {
      router.replace("/dashboard");
      return;
    }

    if (PROTECTED_ROUTES.some((r) => path.startsWith(r)) && !isAuthenticated) {
      router.replace("/signin");
    }
  }, [isAuthenticated, isLoading, router]);

  if (isLoading) return null;

  return <>{children}</>;
}