"use client";

import ClaudeIcon from "@lobehub/icons/es/Claude/components/Color";
import CodexIcon from "@lobehub/icons/es/Codex/components/Color";
import CursorIcon from "@lobehub/icons/es/Cursor/components/Mono";
import DevinIcon from "@lobehub/icons/es/Devin/components/Color";
import GeminiCliIcon from "@lobehub/icons/es/GeminiCLI/components/Color";
import HermesAgentIcon from "@lobehub/icons/es/HermesAgent/components/Mono";
import KiloCodeIcon from "@lobehub/icons/es/KiloCode/components/Mono";
import KimiIcon from "@lobehub/icons/es/Kimi/components/Color";
import KiroIcon from "@lobehub/icons/es/Kiro/components/Color";
import MistralIcon from "@lobehub/icons/es/Mistral/components/Color";
import OpenCodeIcon from "@lobehub/icons/es/OpenCode/components/Mono";
import QoderIcon from "@lobehub/icons/es/Qoder/components/Color";
import QwenIcon from "@lobehub/icons/es/Qwen/components/Color";
import type { ComponentType } from "react";
import { useState } from "react";

import { getLocalCliProviderFallbackMark } from "@/lib/agent-model-groups";

type LocalCliProviderIconComponent = ComponentType<{
  className?: string;
  size?: number;
}>;

const LOCAL_CLI_PROVIDER_ICONS: Record<string, LocalCliProviderIconComponent> =
  {
    "claude-code": ClaudeIcon,
    codex: CodexIcon,
    cursor: CursorIcon,
    devin: DevinIcon,
    gemini: GeminiCliIcon,
    hermes: HermesAgentIcon,
    kilo: KiloCodeIcon,
    kimi: KimiIcon,
    kiro: KiroIcon,
    opencode: OpenCodeIcon,
    qoder: QoderIcon,
    qwen: QwenIcon,
    vibe: MistralIcon,
  };

interface LocalCliProviderIconProps {
  className?: string;
  iconSize?: number;
  iconUrl?: string | undefined;
  label: string;
  provider: string;
}

export function LocalCliProviderIcon({
  className = "size-9 rounded-lg",
  iconSize = 32,
  iconUrl,
  label,
  provider,
}: LocalCliProviderIconProps) {
  const Icon = LOCAL_CLI_PROVIDER_ICONS[provider];
  const normalizedIconUrl = iconUrl?.trim() ?? "";
  const [failedHostIconUrl, setFailedHostIconUrl] = useState("");

  if (normalizedIconUrl && failedHostIconUrl !== normalizedIconUrl) {
    return (
      <img
        alt=""
        aria-hidden="true"
        className={`object-cover ${className}`}
        src={normalizedIconUrl}
        onError={() => setFailedHostIconUrl(normalizedIconUrl)}
      />
    );
  }

  if (Icon) {
    return (
      <span
        aria-hidden="true"
        className={`flex items-center justify-center overflow-hidden bg-background text-foreground ${className}`}
      >
        <Icon size={iconSize} />
      </span>
    );
  }

  return (
    <span
      aria-hidden="true"
      className={`flex items-center justify-center bg-foreground text-xs font-semibold text-background ${className}`}
      title={label}
    >
      {getLocalCliProviderFallbackMark(provider)}
    </span>
  );
}
