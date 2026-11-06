import { DemoBanner } from "@/components/demo-banner";
import { MobileNav, Sidebar } from "@/components/nav";
import { ToastProvider } from "@/components/ui/toast";
import { getSessionInfo } from "@/lib/session";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSessionInfo();

  return (
    <div className="min-h-dvh">
      <Sidebar email={session.email} demo={session.demo} />
      <div className="md:pl-64">
        {session.demo && <DemoBanner />}
        <main
          className="mx-auto w-full max-w-6xl px-4 pb-28 md:px-8 md:pb-12 md:pt-10"
          style={{ paddingTop: "max(1.5rem, env(safe-area-inset-top))" }}
        >
          <ToastProvider>{children}</ToastProvider>
        </main>
      </div>
      <MobileNav />
    </div>
  );
}
