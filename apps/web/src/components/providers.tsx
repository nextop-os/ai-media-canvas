"use client";

import { RichTextMentionServiceProvider } from "@tutti-os/ui-rich-text/editor";
import { createRichTextMentionService } from "@tutti-os/ui-rich-text/service";
import { TooltipProvider } from "@tutti-os/ui-system/components";
import { createTuttiExternalRichTextMentionService } from "@tutti-os/workspace-external-core/rich-text";
import { ThemeProvider } from "next-themes";
import { type ReactNode, useEffect, useState } from "react";

import { I18nProvider } from "@/i18n";

import { ToastProvider } from "./toast";

export function Providers({ children }: { children: ReactNode }) {
  const [fallbackMentionService] = useState(() =>
    createRichTextMentionService({ providers: [] }),
  );
  const [mentionService, setMentionService] = useState<
    ReturnType<typeof createTuttiExternalRichTextMentionService>
  >(fallbackMentionService);
  useEffect(() => {
    const service = createTuttiExternalRichTextMentionService({
      getBridge: () =>
        (typeof window === "undefined"
          ? undefined
          : (window as unknown as { tuttiExternal?: unknown })
              .tuttiExternal) as never,
      providerIds: ["file"],
    });
    setMentionService(service);
    fallbackMentionService.dispose();
    return () => service.dispose();
  }, [fallbackMentionService]);

  return (
    <ThemeProvider attribute="class" defaultTheme="light" enableSystem>
      <I18nProvider>
        <TooltipProvider>
          <RichTextMentionServiceProvider service={mentionService}>
            <ToastProvider>{children}</ToastProvider>
          </RichTextMentionServiceProvider>
        </TooltipProvider>
      </I18nProvider>
    </ThemeProvider>
  );
}
