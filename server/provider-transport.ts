import { credentials } from "./provider-environment";

export type OpenAIConnection = { readonly apiKey: string; readonly baseUrl: string };
export function openAIConnection(): OpenAIConnection {
  return { apiKey: credentials.openai, baseUrl: "https://api.openai.com/v1/" };
}
// Typecast TTS. 호출마다 평가하므로 /api/connections 로 바뀐 키가 바로 반영된다.
export type TypecastConnection = { readonly apiKey: string; readonly baseUrl: string };
export function typecastConnection(): TypecastConnection {
  return { apiKey: credentials.typecast, baseUrl: "https://api.typecast.ai/" };
}
