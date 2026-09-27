type ImageChunk = {
  readonly file: File;
  readonly sourceName: string;
  readonly part: number;
  readonly total: number;
};

export async function* imagePreviewChunks(files: readonly File[]): AsyncGenerator<ImageChunk> {
  let produced = 0;
  for (const file of files) {
    const bitmap = await createImageBitmap(file);
    try {
      const width = Math.min(bitmap.width, 1600);
      const scale = width / bitmap.width;
      const sourceHeight = Math.max(1, Math.floor(2200 / scale));
      const total = Math.ceil(bitmap.height / sourceHeight);
      if (produced + total > 20)
        throw new Error(
          "한 번에 분석할 수 있는 이미지 구간은 20개까지입니다. 이미지를 나누어 등록해 주세요.",
        );
      const canvas = document.createElement("canvas");
      canvas.width = width;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("이미지를 읽을 수 없습니다. 브라우저를 확인해 주세요.");
      for (let part = 0; part < total; part++) {
        const y = part * sourceHeight;
        const height = Math.min(sourceHeight, bitmap.height - y);
        canvas.height = Math.max(1, Math.round(height * scale));
        context.fillStyle = "white";
        context.fillRect(0, 0, width, canvas.height);
        context.drawImage(bitmap, 0, y, bitmap.width, height, 0, 0, width, canvas.height);
        const blob = await new Promise<Blob>((resolve, reject) => {
          canvas.toBlob(
            (value) => (value ? resolve(value) : reject(new Error("이미지 변환에 실패했습니다."))),
            "image/jpeg",
            0.88,
          );
        });
        produced++;
        yield {
          file: new File([blob], `${file.name}-part-${part + 1}.jpg`, { type: "image/jpeg" }),
          sourceName: file.name,
          part: part + 1,
          total,
        };
      }
    } finally {
      bitmap.close();
    }
  }
}
