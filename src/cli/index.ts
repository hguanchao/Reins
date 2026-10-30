#!/usr/bin/env node
import { main } from "#src/cli/bootstrap.ts";

process.exitCode = await main(process.argv.slice(2));
