import { env, pipeline } from "@huggingface/transformers";

export const INDEX_EMBEDDING_MODEL_ID =
  "sentence-transformers/all-MiniLM-L6-v2";

let pipelinePromise: Promise<any> | null = null;
let runtime: "webgpu" | "wasm" | null = null;

function normalizeVector(values: ArrayLike<number>): Float32Array {
  const out = new Float32Array(values.length);
  let norm = 0;
  for (let i = 0; i < values.length; i++) {
    const v = Number(values[i]) || 0;
    out[i] = v;
    norm += v * v;
  }

  if (norm === 0) return out;

  const inv = 1 / Math.sqrt(norm);
  for (let i = 0; i < out.length; i++) {
    out[i] *= inv;
  }
  return out;
}

function extractVector(result: any): Float32Array {
  if (!result) return new Float32Array(0);

  if (result.data && typeof result.data.length === "number") {
    return normalizeVector(result.data as ArrayLike<number>);
  }

  if (Array.isArray(result)) {
    const flattened: number[] = [];
    const stack: unknown[] = [...result];
    while (stack.length > 0) {
      const value = stack.shift();
      if (Array.isArray(value)) {
        stack.unshift(...value);
      } else if (typeof value === "number") {
        flattened.push(value);
      }
    }
    return normalizeVector(flattened);
  }

  return new Float32Array(0);
}

async function createPipeline(device: "webgpu" | "wasm"): Promise<any> {
  const localEnv = env as any;
  localEnv.allowRemoteModels = true;
  localEnv.allowLocalModels = false;
  localEnv.useBrowserCache = true;

  return pipeline("feature-extraction", INDEX_EMBEDDING_MODEL_ID, {
    device,
  });
}

async function getEmbeddingPipeline(): Promise<any> {
  if (pipelinePromise) return pipelinePromise;

  pipelinePromise = createPipeline("webgpu")
    .then((p) => {
      runtime = "webgpu";
      return p;
    })
    .catch((webgpuErr) => {
      console.warn(
        "[Index] WebGPU embeddings unavailable, falling back to WASM",
        webgpuErr,
      );
      return createPipeline("wasm").then((p) => {
        runtime = "wasm";
        return p;
      });
    });

  return pipelinePromise;
}

export function getEmbeddingRuntime(): "webgpu" | "wasm" | null {
  return runtime;
}

export async function embedTexts(texts: string[]): Promise<Float32Array[]> {
  if (texts.length === 0) return [];

  const extractor = await getEmbeddingPipeline();
  const vectors: Float32Array[] = [];

  for (const text of texts) {
    const result = await extractor(text, {
      pooling: "mean",
      normalize: true,
      truncation: true,
      max_length: 256,
    });
    vectors.push(extractVector(result));
  }

  return vectors;
}
