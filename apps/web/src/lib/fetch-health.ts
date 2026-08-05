import type { HealthResponse } from "@aimc/shared";

import { getServerBaseUrl } from "@/lib/env";

export async function fetchHealth(): Promise<HealthResponse> {
  const response = await fetch(`${getServerBaseUrl()}/api/health`);
  if (!response.ok) {
    throw new Error(`Health check failed (${response.status})`);
  }
  return (await response.json()) as HealthResponse;
}
