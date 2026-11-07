import type { NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

export async function middleware(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  matcher: [
    // api/capture, api/cron e api/webhooks têm autenticação própria por token: não usam sessão.
    "/((?!_next/static|_next/image|favicon.ico|icon.svg|manifest.webmanifest|api/capture|api/cron|api/webhooks|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
