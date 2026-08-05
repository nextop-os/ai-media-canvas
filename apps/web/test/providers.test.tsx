// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { type ReactNode, StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const createMentionService = vi.hoisted(() => vi.fn());
const providedServices = vi.hoisted(() => [] as unknown[]);

vi.mock("@tutti-os/workspace-external-core/rich-text", () => ({
  createTuttiExternalRichTextMentionService: createMentionService,
}));

vi.mock("@tutti-os/ui-rich-text/editor", () => ({
  RichTextMentionServiceProvider: ({
    children,
    service,
  }: { children: ReactNode; service: unknown }) => {
    providedServices.push(service);
    return <>{children}</>;
  },
}));

vi.mock("@tutti-os/ui-system/components", () => ({
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("next-themes", () => ({
  ThemeProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("../src/i18n", () => ({
  I18nProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("../src/components/toast", () => ({
  ToastProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

import { Providers } from "../src/components/providers";

afterEach(() => {
  cleanup();
  createMentionService.mockReset();
  providedServices.splice(0);
});

describe("Providers mention service", () => {
  it("creates a fresh root service for StrictMode replay and disposes each one", () => {
    const first = { dispose: vi.fn() };
    const second = { dispose: vi.fn() };
    createMentionService.mockReturnValueOnce(first).mockReturnValueOnce(second);

    const view = render(
      <StrictMode>
        <Providers>
          <div>canvas</div>
        </Providers>
      </StrictMode>,
    );

    expect(createMentionService).toHaveBeenCalledTimes(2);
    expect(createMentionService).toHaveBeenLastCalledWith({
      getBridge: expect.any(Function),
      providerIds: ["file"],
    });
    expect(first.dispose).toHaveBeenCalledTimes(1);
    expect(providedServices.at(-1)).toBe(second);

    view.unmount();
    expect(second.dispose).toHaveBeenCalledTimes(1);
  });
});
