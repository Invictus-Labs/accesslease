#!/usr/bin/env node
import { runCommand } from "./commands.js";

const io = { out: (line: string) => process.stdout.write(`${line}\n`), err: (line: string) => process.stderr.write(`${line}\n`) };

const result = await runCommand(process.argv.slice(2), process.env, io);
if (typeof result === "number") {
  process.exitCode = result;
} else {
  // Long-running command (serve, worker): stop cleanly on SIGINT/SIGTERM.
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    result().then(
      () => process.exit(0),
      (error: Error) => {
        io.err(`accesslease: shutdown failed: ${error.message}`);
        process.exit(1);
      },
    );
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}
