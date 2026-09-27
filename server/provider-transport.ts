import { credentials } from "./provider-environment";

export type OpenAIConnection = { readonly apiKey: string; readonly baseUrl: string };
export function openAIConnection(): OpenAIConnection {
  return { apiKey: credentials.openai, baseUrl: "https://api.openai.com/v1/" };
}
