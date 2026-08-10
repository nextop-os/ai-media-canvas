import { describe, expect, it } from "vitest";
import { createAgnesClient } from "agnes-ai-cli";

describe("agnes-ai-cli image request contract", () => {
  it.each(["agnes-image-2.1-flash", "agnes-image-2.0-flash"] as const)(
    "keeps a single img2img input in an array for %s",
    async (model) => {
      let requestBody: unknown;
      const client = createAgnesClient({
        apiKey: "test-key",
        baseUrl: "https://apihub.agnes-ai.com/v1",
        fetchImpl: async (_url, init) => {
          requestBody = JSON.parse(String(init?.body));
          return Response.json({
            data: [{ url: "https://cdn.example.com/output.png" }],
          });
        },
      });

      await client.image.generate({
        mode: "img2img",
        model,
        image: "https://cdn.example.com/input.png",
        prompt: "Preserve the composition and change the lighting.",
        size: "1024x1024",
        responseFormat: "url",
      });

      expect(requestBody).toEqual({
        model,
        prompt: "Preserve the composition and change the lighting.",
        size: "1024x1024",
        extra_body: {
          image: ["https://cdn.example.com/input.png"],
          response_format: "url",
        },
      });
    },
  );
});
