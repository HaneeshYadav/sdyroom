import { AiDemoBanner } from "@/components/ai/ai-status";
import { SiteShell } from "@/components/site-shell";
import { AI_DEMO_BANNER, isAiDemoMode } from "@/lib/ai/config";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      {/* Server-side only: the mock-vs-openai decision never runs in the
          browser, so no AI_* environment value can reach the client bundle. */}
      {isAiDemoMode() && <AiDemoBanner text={AI_DEMO_BANNER} />}
      <SiteShell>{children}</SiteShell>
    </>
  );
}
