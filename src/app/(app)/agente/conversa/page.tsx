import { ChatPanel } from "@/features/agent/components/chat-panel";
import { isSupabaseConfigured } from "@/lib/env";

export const dynamic = "force-dynamic";

export default function ChatPage() {
  if (!isSupabaseConfigured()) return null;
  return <ChatPanel aiEnabled={Boolean(process.env.ANTHROPIC_API_KEY)} />;
}
