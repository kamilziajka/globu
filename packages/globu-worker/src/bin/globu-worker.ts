import { processIo } from "../../../globu-cli/src/cli/process-io.js";
import { workerMain } from "../cli.js";

process.exitCode = await workerMain(process.argv.slice(2), processIo, process.env, { signals: process });
