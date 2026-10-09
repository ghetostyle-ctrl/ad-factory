// RGB 16진("FFD54A") → ASS 색(&HAABBGGRR&)
export function assColor(rgb: string, alpha = 0): string {
  const r = rgb.slice(0, 2);
  const g = rgb.slice(2, 4);
  const b = rgb.slice(4, 6);
  return `&H${alpha.toString(16).padStart(2, "0").toUpperCase()}${b}${g}${r}`;
}
// ms → h:mm:ss.cc
export function assTime(ms: number): string {
  const total = Math.max(0, Math.round(ms / 10));
  const cs = total % 100;
  const seconds = Math.floor(total / 100) % 60;
  const minutes = Math.floor(total / 6000) % 60;
  const hours = Math.floor(total / 360000);
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}
// 중괄호·역슬래시는 태그로 읽히므로 바꾸고, 줄바꿈은 줄 배열로, maxChars 를 넘는 줄은 강제 분할한다.
export function assLines(text: string, maxChars = 16): string[] {
  return text
    .replace(/\\/g, "/")
    .replace(/\{/g, "(")
    .replace(/\}/g, ")")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .flatMap((line) => {
      const characters = [...line];
      if (characters.length <= maxChars) return [line];
      const parts: string[] = [];
      for (let index = 0; index < characters.length; index += maxChars)
        parts.push(characters.slice(index, index + maxChars).join(""));
      return parts;
    });
}
export function assEscape(text: string, maxChars = 16): string {
  return assLines(text, maxChars).join("\\N");
}
export function assDialogue(input: {
  readonly startMs: number;
  readonly endMs: number;
  readonly style: string;
  readonly text: string;
  readonly layer?: number;
}): string {
  return `Dialogue: ${input.layer ?? 0},${assTime(input.startMs)},${assTime(input.endMs)},${input.style},,0,0,0,,${input.text}`;
}
