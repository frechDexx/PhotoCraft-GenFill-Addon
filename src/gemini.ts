const API = "https://generativelanguage.googleapis.com/v1beta";

export interface FillRequest {
  apiKey: string;
  model: string;
  imagePng: Buffer;
  maskPng: Buffer;
  prompt: string;
  aspectRatio: string;
  imageSize?: string;
  variantIndex: number;
  signal?: AbortSignal;
}

function instruction(prompt: string, variantIndex: number): string {
  const task = prompt.trim()
    ? `Fill the white region with: ${prompt.trim()}`
    : "Remove whatever is inside the white region and reconstruct a natural, plausible continuation of the surrounding scene.";
  return [
    "You are doing generative fill (inpainting) for a photo editor.",
    "Image 1 is a crop of the user's picture. Image 2 is a mask of the same framing: the WHITE area is the region to regenerate, everything in the BLACK area must stay as it is.",
    task,
    "Match perspective, lighting, colour grading, noise/grain and sharpness of the surrounding image so the edit blends in seamlessly.",
    "Do not add borders, frames, text or watermarks. Return one image with exactly the same framing as image 1.",
    variantIndex > 0 ? `This is alternative number ${variantIndex + 1}; choose a different but equally fitting interpretation.` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export async function generateFill(req: FillRequest): Promise<Buffer> {
  if (!req.apiKey) throw new Error("No Gemini API key set (settings or GEMINI_API_KEY).");
  const imageConfig: Record<string, string> = { aspectRatio: req.aspectRatio };
  if (req.imageSize) imageConfig.imageSize = req.imageSize;

  const body = {
    contents: [
      {
        role: "user",
        parts: [
          { text: instruction(req.prompt, req.variantIndex) },
          { inlineData: { mimeType: "image/png", data: req.imagePng.toString("base64") } },
          { inlineData: { mimeType: "image/png", data: req.maskPng.toString("base64") } },
        ],
      },
    ],
    generationConfig: {
      responseModalities: ["TEXT", "IMAGE"],
      temperature: 1,
      imageConfig,
    },
  };

  const res = await fetch(`${API}/models/${encodeURIComponent(req.model)}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": req.apiKey },
    body: JSON.stringify(body),
    signal: req.signal,
  });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Gemini answered with HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  if (!res.ok) {
    const msg: string = json?.error?.message ?? text.slice(0, 300);
    if (res.status === 429 && /free_tier|Free Tier/i.test(msg)) {
      throw new Error(
        'Your Gemini API project is on the Free Tier, where image models have no quota. Click "Set up billing" for the project in Google AI Studio; the same key will then work.',
      );
    }
    if (res.status === 429) throw new Error(`Gemini rate limit reached, wait a moment and try again. (${msg.slice(0, 160)})`);
    throw new Error(`Gemini error ${res.status}: ${msg}`);
  }
  const cand = json?.candidates?.[0];
  for (const p of cand?.content?.parts ?? []) {
    const d = p.inlineData ?? p.inline_data;
    if (d?.data) return Buffer.from(d.data, "base64");
  }
  const said = (cand?.content?.parts ?? []).map((p: any) => p.text).filter(Boolean).join(" ");
  const reason = json?.promptFeedback?.blockReason ?? cand?.finishReason ?? "unknown";
  throw new Error(`Gemini returned no image (reason: ${reason})${said ? `: ${said.slice(0, 200)}` : ""}`);
}

/** Models on this key that can generate images. */
export async function listImageModels(apiKey: string): Promise<string[]> {
  if (!apiKey) return [];
  const out: string[] = [];
  let pageToken = "";
  for (let i = 0; i < 5; i++) {
    const url = `${API}/models?pageSize=200${pageToken ? `&pageToken=${pageToken}` : ""}`;
    const res = await fetch(url, { headers: { "x-goog-api-key": apiKey } });
    if (!res.ok) throw new Error(`Could not load the model list (HTTP ${res.status})`);
    const json: any = await res.json();
    for (const m of json.models ?? []) {
      const name = String(m.name ?? "").replace(/^models\//, "");
      const methods: string[] = m.supportedGenerationMethods ?? [];
      if (/image/i.test(name) && methods.includes("generateContent")) out.push(name);
    }
    pageToken = json.nextPageToken ?? "";
    if (!pageToken) break;
  }
  return out.sort();
}
