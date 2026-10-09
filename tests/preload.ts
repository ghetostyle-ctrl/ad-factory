import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// bun test 전체가 작업 폴더의 data/(실제 DB·산출물·CLI 스크래치 data/cli)를 건드리지 않도록 DATA_DIR 을 임시 폴더로 고정한다.
// server/provider-environment.ts 는 import 시점에 DATA_DIR 을 읽으므로 테스트 파일보다 먼저(bunfig.toml preload) 정해야 한다.
// 명시한 DATA_DIR 은 그대로 둔다(entrypoint 테스트처럼 자식 프로세스에 직접 넘기는 경우).
if (!process.env["DATA_DIR"])
  process.env["DATA_DIR"] = mkdtempSync(join(tmpdir(), "studio-test-data-"));
