import { type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

export async function proxy(request: NextRequest) {
  return await updateSession(request);
}

// /api/llm is excluded on purpose: it is called by agent instances, not by browsers. It carries its
// own auth (a per-agent token), and a session redirect to /login would turn every model turn into a
// 307 the agent can't follow.
export const config = {
  matcher: [
    "/((?!api/llm|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
