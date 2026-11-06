import type { NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

export async function middleware(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  matcher: [
    // api/capture e api/cron têm autenticação própria por token: não usam sessão.
    "/((?!_next/static|_next/image|favicon.ico|icon.svg|manifest.webmanifest|api/capture|api/cron|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
