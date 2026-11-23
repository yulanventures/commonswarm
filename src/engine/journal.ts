import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";
import { isJournalRecord, type JournalRecord } from "./core.js";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const NEWLINE_BYTE = 0x0a;

function errnoCode(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = (err as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

function parseLine(raw: string): JournalRecord | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isJournalRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

interface ParsedJournal {
  readonly records: readonly JournalRecord[];
  readonly validByteLength: number;
  readonly needsNewline: boolean;
}

function parseJournalBuffer(buf: Buffer): ParsedJournal {
  const records: JournalRecord[] = [];
  let offset = 0;
  let validByteLength = 0;
  let needsNewline = false;

  while (offset < buf.length) {
    const newlineIdx = buf.indexOf(NEWLINE_BYTE, offset);
    const hasNewline = newlineIdx !== -1;
    const lineEnd = hasNewline ? newlineIdx : buf.length;
    const nextOffset = hasNewline ? newlineIdx + 1 : buf.length;
    const raw = buf.subarray(offset, lineEnd).toString("utf8").replace(/\r$/, "");

    if (raw.trim().length === 0) {
      validByteLength = nextOffset;
      offset = nextOffset;
      continue;
    }

    const record = parseLine(raw);
    if (record !== null) {
      records.push(record);
      validByteLength = nextOffset;
      needsNewline = !hasNewline;
      offset = nextOffset;
      continue;
    }

    const remainingHasContent =
      hasNewline &&
      buf.subarray(nextOffset).toString("utf8").trim().length > 0;
    if (remainingHasContent) {
      throw new Error("Journal contains a corrupt record");
    }
    break;
  }

  return { records, validByteLength, needsNewline };
}

async function ensureJournalDirectory(dirPath: string): Promise<void> {
  let exists = true;
  try {
    const st = await lstat(dirPath);
    if (st.isSymbolicLink()) {
      throw new Error("Journal directory must not be a symlink");
    }
    if (!st.isDirectory()) {
      throw new Error("Journal parent path must be a directory");
    }
  } catch (err) {
    if (errnoCode(err) === "ENOENT") {
      exists = false;
    } else if (err instanceof Error && err.message.startsWith("Journal ")) {
      throw err;
    } else {
      throw new Error("Unable to inspect journal directory");
    }
  }

  if (!exists) {
    try {
      await mkdir(dirPath, { recursive: true, mode: DIR_MODE });
      await chmod(dirPath, DIR_MODE);
    } catch {
      throw new Error("Unable to create journal directory");
    }
  }
}

async function openVerifiedHandle(filePath: string): Promise<FileHandle> {
  try {
    const st = await lstat(filePath);
    if (st.isSymbolicLink()) {
      throw new Error("Journal file must not be a symlink");
    }
    if (!st.isFile()) {
      throw new Error("Journal path must be a regular file");
    }
  } catch (err) {
    if (errnoCode(err) !== "ENOENT") {
      if (err instanceof Error && err.message.startsWith("Journal ")) {
        throw err;
      }
      throw new Error("Unable to inspect journal file");
    }
  }

  const noFollow = constants.O_NOFOLLOW ?? 0;
  const flags = constants.O_RDWR | constants.O_CREAT | constants.O_APPEND | noFollow;

  let handle: FileHandle;
  try {
    handle = await open(filePath, flags, FILE_MODE);
  } catch (err) {
    const code = errnoCode(err);
    if (code === "ELOOP" || code === "EMLINK") {
      throw new Error("Journal file must not be a symlink");
    }
    throw new Error("Unable to open journal file");
  }

  try {
    const st = await handle.stat();
    if (!st.isFile()) {
      throw new Error("Journal path must be a regular file");
    }
    if (typeof process.getuid === "function" && st.uid !== process.getuid()) {
      throw new Error("Journal file must be owned by the current user");
    }
    if ((st.mode & 0o777) !== FILE_MODE) {
      await handle.chmod(FILE_MODE);
    }
    return handle;
  } catch (err) {
    await handle.close().catch(() => {});
    if (err instanceof Error && err.message.startsWith("Journal ")) {
      throw err;
    }
    throw new Error("Unable to verify journal file");
  }
}

async function writeAll(handle: FileHandle, data: Buffer): Promise<void> {
  let written = 0;
  while (written < data.length) {
    const result = await handle.write(data, written, data.length - written);
    if (result.bytesWritten <= 0) {
      throw new Error("Short write to journal");
    }
    written += result.bytesWritten;
  }
}

async function readAll(handle: FileHandle, size: number): Promise<Buffer> {
  if (size <= 0) return Buffer.alloc(0);
  const buf = Buffer.alloc(size);
  let position = 0;
  while (position < size) {
    const result = await handle.read(buf, position, size - position, position);
    if (result.bytesRead <= 0) break;
    position += result.bytesRead;
  }
  return position === size ? buf : buf.subarray(0, position);
}

export class Journal {
  readonly records: readonly JournalRecord[];
  private readonly filePath: string;
  private writeChain: Promise<void> = Promise.resolve();
  private closed = false;

  private constructor(filePath: string, records: readonly JournalRecord[]) {
    this.filePath = filePath;
    this.records = records;
  }

  static async open(filePath: string): Promise<Journal> {
    await ensureJournalDirectory(dirname(filePath));
    const handle = await openVerifiedHandle(filePath);
    try {
      const st = await handle.stat();
      const raw = await readAll(handle, st.size);
      const parsed = parseJournalBuffer(raw);

      if (parsed.validByteLength < raw.length) {
        await handle.truncate(parsed.validByteLength);
        await handle.sync();
      } else if (parsed.needsNewline) {
        await writeAll(handle, Buffer.from("\n", "utf8"));
        await handle.sync();
      }

      return new Journal(filePath, parsed.records);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("Journal ")) {
        throw err;
      }
      throw new Error("Unable to initialize journal file");
    } finally {
      await handle.close().catch(() => {});
    }
  }

  async append(record: JournalRecord): Promise<void> {
    await this.enqueueWrite(async () => {
      if (this.closed) {
        throw new Error("Journal is closed");
      }
      const handle = await openVerifiedHandle(this.filePath);
      try {
        const line = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
        await writeAll(handle, line);
        await handle.sync();
      } finally {
        await handle.close();
      }
    });
  }

  async appendAll(records: readonly JournalRecord[]): Promise<void> {
    for (const record of records) {
      await this.append(record);
    }
  }

  async flush(): Promise<void> {
    await this.writeChain;
  }

  async close(): Promise<void> {
    await this.enqueueWrite(async () => {
      this.closed = true;
    });
  }

  private async enqueueWrite(task: () => Promise<void>): Promise<void> {
    const next = this.writeChain.then(task);
    this.writeChain = next.catch(() => {});
    await next;
  }
}
