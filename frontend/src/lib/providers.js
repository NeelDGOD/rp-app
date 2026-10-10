// Every model source the app can call. `presets` are one-tap model ids for the model list.
export const PROVIDERS = {
  // Hugging Face is disabled: free accounts no longer get Inference Providers credits.
  // huggingface: {
  //   label: "Hugging Face",
  //   tokenKey: "hf_token", modelKey: "hf_model", defaultModel: "deepseek-ai/DeepSeek-V3",
  //   tokenLabel: "Hugging Face Token", tokenPlaceholder: "hf_…",
  //   modelHint: "Full model string", modelExample: "deepseek-ai/DeepSeek-V4-Pro:novita",
  // },
  openrouter: {
    label: "OpenRouter",
    tokenKey: "openrouter_token", modelKey: "openrouter_model", defaultModel: "",
    tokenLabel: "OpenRouter API Key", tokenPlaceholder: "sk-or-…",
    modelHint: "Full model slug", modelExample: "anthropic/claude-sonnet-5",
    presets: [
      { label: "Nemotron Ultra (free)", model: "nvidia/nemotron-3-ultra-550b-a55b:free" },
      { label: "Nemotron Super (free)", model: "nvidia/nemotron-3-super-120b-a12b:free" },
    ],
  },
  nvidia: {
    label: "NVIDIA",
    tokenKey: "nvidia_token", modelKey: "nvidia_model", defaultModel: "deepseek-ai/deepseek-v4.1-flash",
    tokenLabel: "NVIDIA API Key", tokenPlaceholder: "nvapi-…",
    modelHint: "Model id from build.nvidia.com", modelExample: "deepseek-ai/deepseek-v4.1-flash",
    presets: [
      { label: "DeepSeek 4.1 Flash", model: "deepseek-ai/deepseek-v4.1-flash" },
      { label: "Kimi K3", model: "moonshotai/kimi-k3" },
    ],
  },
  gemini: {
    label: "Gemini",
    tokenKey: "gemini_token", modelKey: "gemini_model", defaultModel: "gemini-3.8-flash",
    tokenLabel: "Google AI Studio API Key", tokenPlaceholder: "AIza…",
    modelHint: "Gemini model id", modelExample: "gemini-3.8-flash",
    presets: [{ label: "Gemini 3.8 Flash", model: "gemini-3.8-flash" }],
  },
  mistral: {
    label: "Mistral",
    tokenKey: "mistral_token", modelKey: "mistral_model", defaultModel: "mistral-large-latest",
    tokenLabel: "Mistral API Key", tokenPlaceholder: "Mistral API key",
    modelHint: "Mistral model id", modelExample: "mistral-large-latest",
    presets: [
      { label: "Mistral Large", model: "mistral-large-latest" },
      { label: "Mistral Small", model: "mistral-small-latest" },
    ],
  },
  groq: {
    label: "Groq",
    tokenKey: "groq_token", modelKey: "groq_model", defaultModel: "llama-3.3-70b-versatile",
    tokenLabel: "Groq API Key", tokenPlaceholder: "gsk_…",
    modelHint: "Groq model id", modelExample: "llama-3.3-70b-versatile",
    presets: [
      { label: "Llama 3.3 70B", model: "llama-3.3-70b-versatile" },
      { label: "GPT-OSS 120B", model: "openai/gpt-oss-120b" },
    ],
  },
  navy: {
    label: "NavyAI",
    tokenKey: "navy_token", modelKey: "navy_model", defaultModel: "",
    tokenLabel: "NavyAI API Key", tokenPlaceholder: "sk-navy-…",
    modelHint: "Model id from NavyAI's model list", modelExample: "model-id-from-api.navy",
    presets: [],
  },
  puter: {
    label: "Puter",
    tokenKey: "puter_token", modelKey: "puter_model", defaultModel: "deepseek/deepseek-v4.1-flash:free",
    tokenLabel: "Puter Auth Token", tokenPlaceholder: "Puter auth token",
    modelHint: "Model id; the ones ending in :free cost nothing", modelExample: "deepseek/deepseek-v4.1-flash:free",
    presets: [
      { label: "DeepSeek 4.1 Flash (free)", model: "deepseek/deepseek-v4.1-flash:free" },
      { label: "DeepSeek V4 Flash (free)", model: "deepseek/deepseek-v4-flash:free" },
      { label: "DeepSeek V3.2 (paid)", model: "openrouter:deepseek/deepseek-v3.2" },
      { label: "DeepSeek 4.1 Flash (fast, paid)", model: "deepseek:deepseek/deepseek-flash" },
      { label: "Nemotron Ultra (free)", model: "nvidia/nemotron-3-ultra-550b-a55b:free" },
      { label: "Nemotron Super (free)", model: "nvidia/nemotron-3-super-120b-a12b:free" },
      { label: "Qwen 3.8 Flash (free)", model: "qwen/qwen3.8-flash:free" },
    ],
  },
};

export const DEFAULT_PROVIDER = "gemini";
